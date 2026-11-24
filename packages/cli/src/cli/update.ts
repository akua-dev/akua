import { Clock, Config, Effect, Fiber, Option, Schema, Stream } from 'effect';
import { Command, Flag } from 'effect/cli';
import { constant as discardError } from 'effect/Function';
import { FetchHttpClient, HttpClient, HttpClientRequest } from 'effect/http';

import {
	artifactName,
	RELEASE_TARGETS,
	type ReleaseTarget
} from '../../scripts/runtime/release-services';
import { configPath, optionalEnv } from '../runtime/credentials';
import { AkuaCliError } from '../runtime/errors';
import { ExitCodes } from '../runtime/exit-codes';
import type { OutputMode } from '../runtime/mode';
import type { RenderEnvelope } from '../runtime/render';
import { Console, Installation, type RunningExecutable } from '../runtime/services';
import { Invocation, respond } from './invocation';

/** The version of a source build; Bazel stamps release builds with their release version. */
export const DEVELOPMENT_VERSION = '0.0.0-dev';

const RELEASE_REPOSITORY = 'akua-dev/akua';
const LATEST_RELEASE_URL = `https://api.github.com/repos/${RELEASE_REPOSITORY}/releases/latest`;
const RELEASES_URL = `https://github.com/${RELEASE_REPOSITORY}/releases/latest`;
const INSTALL_DOCS_URL = 'https://docs.akua.dev/cli#install';
const HOMEBREW_FORMULA = 'akua-dev/tap/akua';
const HOMEBREW_UPGRADE = `brew upgrade ${HOMEBREW_FORMULA}`;
/** How long a saved release check stays current, as in Codex (`updates.rs`). */
const CHECK_INTERVAL_MS = 20 * 60 * 60 * 1000;
/** The most a command waits, after its own work, for a due release check. */
const NOTICE_CHECK_BUDGET = '1 second';
const MAX_METADATA_BYTES = 65_536;

/**
 * Directories whose files belong to the system's package manager. A binary
 * there is updated with that package manager, never replaced in place.
 */
const MANAGED_DIRECTORIES = [
	'/bin/',
	'/sbin/',
	'/usr/bin/',
	'/usr/sbin/',
	'/usr/lib/',
	'/usr/libexec/',
	'/usr/share/',
	'/nix/store/',
	'/snap/',
	'/opt/local/'
];

export type InstallMethod = 'homebrew' | 'standalone' | 'unknown';

/** How this executable was installed, from where it lives. */
export function installMethod(executable: RunningExecutable): InstallMethod {
	const location = executable.path.replaceAll('\\', '/');
	if (location.includes('/Cellar/akua/')) return 'homebrew';
	return MANAGED_DIRECTORIES.some((directory) => location.startsWith(directory))
		? 'unknown'
		: 'standalone';
}

function releaseTargetMatches(target: ReleaseTarget, executable: RunningExecutable): boolean {
	const os = executable.platform === 'win32' ? 'windows' : executable.platform;
	return target.os === os && target.arch === executable.arch;
}

/** Homebrew's own `brew`, from the prefix that owns this executable's Cellar. */
function homebrewCommand(executable: RunningExecutable): readonly [string, ...string[]] {
	const location = executable.path.replaceAll('\\', '/');
	const prefix = location.slice(0, location.indexOf('/Cellar/akua/'));
	return [`${prefix}/bin/brew`, 'upgrade', HOMEBREW_FORMULA];
}

interface Version {
	readonly core: readonly [number, number, number];
	readonly prerelease: boolean;
}

function parseVersion(value: string): Option.Option<Version> {
	const match = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?$/.exec(value);
	if (match === null) return Option.none();
	return Option.some({
		core: [Number(match[1]), Number(match[2]), Number(match[3])],
		prerelease: match[4] !== undefined
	});
}

/** Whether `latest` is a newer release than `current`; a prerelease precedes its release. */
export function isNewer(latest: string, current: string): boolean {
	const next = parseVersion(latest);
	const installed = parseVersion(current);
	if (Option.isNone(next) || Option.isNone(installed)) return false;
	for (let index = 0; index < 3; index += 1) {
		const difference = (next.value.core[index] ?? 0) - (installed.value.core[index] ?? 0);
		if (difference !== 0) return difference > 0;
	}
	return installed.value.prerelease && !next.value.prerelease;
}

const LatestRelease = Schema.Struct({
	tag_name: Schema.String.check(Schema.isPattern(/^v\d+\.\d+\.\d+$/))
});
const decodeLatestRelease = Schema.decodeUnknownEffect(Schema.fromJsonString(LatestRelease));

/** A GitHub request that did not return the expected release file. */
class ReleaseDownloadFailure extends Schema.TaggedError<ReleaseDownloadFailure>()(
	'ReleaseDownloadFailure',
	{ message: Schema.String }
) {}

const updateError = (
	code: string,
	message: string,
	nextSteps: AkuaCliError['nextSteps'] = [],
	cause?: unknown
) =>
	Object.defineProperty(
		new AkuaCliError({
			type: 'runtime_error',
			code,
			message,
			exitCode: ExitCodes.Runtime,
			nextSteps
		}),
		'cause',
		{ value: cause }
	);

const releaseUnavailable = (cause: unknown) =>
	updateError(
		'AKUA_UPDATE_CHECK_FAILED',
		'Could not read the latest akua release from GitHub. Check your connection and try again.',
		[{ command: RELEASES_URL, description: 'See the latest release.' }],
		cause
	);

/** One GitHub request as bytes; release downloads follow GitHub's redirect to its asset storage. */
const download = Effect.fnUntraced(
	function* (url: string, limit?: number) {
		const client = yield* HttpClient.HttpClient;
		const response = yield* client.execute(
			HttpClientRequest.get(url).pipe(
				HttpClientRequest.setHeader('Accept', 'application/vnd.github+json, */*')
			)
		);
		if (response.status !== 200) {
			return yield* new ReleaseDownloadFailure({
				message: `GET ${url} returned HTTP ${response.status}.`
			});
		}
		let size = 0;
		return yield* response.stream.pipe(
			Stream.mapEffect((chunk) => {
				size += chunk.byteLength;
				return limit !== undefined && size > limit
					? Effect.fail(
							new ReleaseDownloadFailure({
								message: `GET ${url} returned more than ${limit} bytes.`
							})
						)
					: Effect.succeed(chunk);
			}),
			Stream.mkUint8Array
		);
	},
	Effect.provideService(FetchHttpClient.RequestInit, { credentials: 'omit' })
);

/** The version GitHub marks as the latest akua-dev/akua release. */
const latestVersion = download(LATEST_RELEASE_URL, MAX_METADATA_BYTES).pipe(
	Effect.flatMap((bytes) => decodeLatestRelease(new TextDecoder().decode(bytes))),
	Effect.map((release) => release.tag_name.slice(1)),
	Effect.timeout('30 seconds')
);

interface UpdateStatus {
	readonly current_version: string;
	readonly latest_version: string;
	readonly update_available: boolean;
	readonly install_method: InstallMethod;
	readonly executable: string;
	/** What `akua update` runs or does; absent when it cannot update this install. */
	readonly update_command?: string;
}

/** The running release executable; a development build is never replaced. */
const locate = Effect.fnUntraced(function* (version: string) {
	if (version === DEVELOPMENT_VERSION) {
		return yield* updateError(
			'AKUA_UPDATE_UNAVAILABLE',
			'This akua is a development build, which akua update does not replace. Rebuild it from source, or install a release.',
			[{ command: `brew install ${HOMEBREW_FORMULA}`, description: 'Install the latest release.' }]
		);
	}
	return yield* (yield* Installation).executable.pipe(
		Effect.mapError((cause) => updateError('AKUA_UPDATE_FAILED', cause.message, [], cause))
	);
});

const updateStatus = Effect.fnUntraced(function* (version: string, executable: RunningExecutable) {
	const latest = yield* latestVersion.pipe(Effect.mapError(releaseUnavailable));
	const method = installMethod(executable);
	const status: UpdateStatus = {
		current_version: version,
		latest_version: latest,
		update_available: isNewer(latest, version),
		install_method: method,
		executable: executable.path,
		...(method === 'homebrew'
			? { update_command: HOMEBREW_UPGRADE }
			: method === 'standalone'
				? { update_command: 'akua update' }
				: {})
	};
	return status;
});

const checkUpdate = Effect.fnUntraced(function* () {
	const { version } = yield* Invocation;
	const status = yield* updateStatus(version, yield* locate(version));
	const summary = status.update_available
		? `akua ${status.latest_version} is available (installed: ${status.current_version}).`
		: `akua ${status.current_version} is the latest release.`;
	return {
		command: 'akua update --check',
		observations: [summary],
		human: [summary, `Installed with: ${status.install_method} (${status.executable})`],
		data: status,
		next_steps: !status.update_available
			? []
			: status.install_method === 'homebrew'
				? [{ command: 'akua update', description: `Runs ${HOMEBREW_UPGRADE}.` }]
				: status.install_method === 'standalone'
					? [
							{
								command: 'akua update',
								description: `Downloads akua ${status.latest_version} and replaces this executable.`
							}
						]
					: []
	} satisfies RenderEnvelope;
});

const manualSteps = (executable: RunningExecutable) => [
	{
		command: `brew install ${HOMEBREW_FORMULA}`,
		description: 'Install with Homebrew, which akua update can then upgrade.'
	},
	{
		command: INSTALL_DOCS_URL,
		description: `Or update ${executable.path} with the tool that installed it.`
	}
];

const runUpdate = Effect.fnUntraced(function* () {
	const { version, mode } = yield* Invocation;
	const executable = yield* locate(version);
	// Refused before any network request, so an offline machine still gets the commands to run.
	if (installMethod(executable) === 'unknown') {
		return yield* updateError(
			'AKUA_UPDATE_MANUAL',
			`akua update cannot replace ${executable.path}: it is neither a Homebrew install nor a standalone akua release binary.`,
			manualSteps(executable)
		);
	}
	const status = yield* updateStatus(version, executable);
	const installation = yield* Installation;
	if (!status.update_available) {
		const summary = `akua ${version} is the latest release.`;
		return {
			command: 'akua update',
			observations: [summary],
			data: { ...status, updated: false }
		} satisfies RenderEnvelope;
	}

	if (status.install_method === 'homebrew') {
		const command = homebrewCommand(executable);
		const console = yield* Console;
		yield* console.writeStderr(`Updating akua with ${HOMEBREW_UPGRADE}\n`);
		const code = yield* installation
			.run(command, mode === 'human' ? undefined : console.writeStderr)
			.pipe(
				Effect.mapError((cause) =>
					updateError('AKUA_UPDATE_FAILED', cause.message, [{ command: HOMEBREW_UPGRADE }], cause)
				)
			);
		if (code !== 0) {
			return yield* updateError(
				'AKUA_UPDATE_FAILED',
				`${HOMEBREW_UPGRADE} exited with status ${code}.`,
				[{ command: HOMEBREW_UPGRADE, description: 'Run it yourself to see why.' }]
			);
		}
		// brew also exits 0 when its tap does not carry the release yet, so this claims no new version.
		const summary = `${HOMEBREW_UPGRADE} finished. Run akua --version to see the installed version.`;
		return {
			command: 'akua update',
			observations: [summary],
			data: { ...status, ran: HOMEBREW_UPGRADE }
		} satisfies RenderEnvelope;
	}

	const target = RELEASE_TARGETS.find((candidate) => releaseTargetMatches(candidate, executable));
	if (target === undefined) {
		return yield* updateError(
			'AKUA_UPDATE_MANUAL',
			`No akua release is published for ${executable.platform}-${executable.arch}.`,
			manualSteps(executable)
		);
	}
	const asset = artifactName(status.latest_version, target);
	const base = `https://github.com/${RELEASE_REPOSITORY}/releases/download/v${status.latest_version}`;
	const failed = (message: string) => (cause?: unknown) =>
		updateError(
			'AKUA_UPDATE_FAILED',
			message,
			[{ command: `${base}/${asset}`, description: 'The release archive.' }],
			cause
		);
	const sidecar = yield* download(`${base}/${asset}.sha256`, MAX_METADATA_BYTES).pipe(
		Effect.mapError(failed(`Could not download ${asset}.sha256.`))
	);
	// `<sha256>  <asset>`, as scripts/release.ts writes it.
	const checksum = /^([0-9a-f]{64}) {2}(\S+)\n?$/.exec(new TextDecoder().decode(sidecar));
	if (checksum === null || checksum[2] !== asset || checksum[1] === undefined) {
		return yield* failed(`${asset}.sha256 does not name ${asset}.`)();
	}
	const console = yield* Console;
	yield* console.writeStderr(`Downloading ${asset}\n`);
	const archive = yield* download(`${base}/${asset}`).pipe(
		Effect.timeout('10 minutes'),
		Effect.mapError(failed(`Could not download ${asset}.`))
	);
	yield* installation
		.replaceExecutable({ path: executable.path, target, archive, sha256: checksum[1] })
		.pipe(
			Effect.mapError((cause) =>
				updateError(
					'AKUA_UPDATE_FAILED',
					`${cause.message} ${executable.path} is unchanged.`,
					cause.reason === 'permission' && executable.platform !== 'win32'
						? [
								{
									command: `sudo ${executable.path} update`,
									description: `${executable.path} is not writable for this user.`
								}
							]
						: [],
					cause
				)
			)
		);
	const summary = `Updated akua ${version} to ${status.latest_version}.`;
	return {
		command: 'akua update',
		observations: [summary],
		human: [summary, `Replaced ${executable.path}.`],
		data: { ...status, updated: true }
	} satisfies RenderEnvelope;
});

export const updateCommand = Command.make(
	'update',
	{
		check: Flag.Boolean('check').pipe(
			Flag.withDefault(false),
			Flag.withDescription('Only report the installed and the latest version')
		)
	},
	({ check }) => respond(check ? checkUpdate() : runUpdate())
).pipe(
	Command.withDescription('Update akua to the latest release'),
	Command.withExamples([
		{ command: 'akua update', description: 'Install the latest release' },
		{ command: 'akua update --check', description: 'Compare the installed and latest versions' }
	])
);

/** The saved release check lives next to the selected config file. */
const updateCheckPath = configPath.pipe(
	Effect.map(Option.map((file) => file.replace(/config\.json$/, 'update-check.json')))
);

const noticeEnabled = Effect.fnUntraced(function* (mode: OutputMode, version: string) {
	if (mode !== 'human' || version === DEVELOPMENT_VERSION) return false;
	if (Option.isSome(yield* optionalEnv('CI'))) return false;
	return !(yield* Config.Boolean('AKUA_NO_UPDATE_CHECK').pipe(
		Config.withDefault(false),
		Effect.orElseSucceed(discardError(true))
	));
});

/**
 * Runs `program` and then, on an interactive terminal, prints one line on
 * stderr when a newer release is out, as Codex does on interactive starts.
 * A release check is due 20 hours after the last one. It runs next to the
 * command and gets at most one second after it; a check that fails or runs
 * out of time is not retried until the next one is due.
 * `AKUA_NO_UPDATE_CHECK=1` turns it off.
 */
export const withUpdateNotice = Effect.fnUntraced(function* <A, R>(
	program: Effect.Effect<A, never, R>,
	options: { readonly mode: OutputMode; readonly version: string; readonly command?: string }
): Effect.fn.Return<A, never, R | Installation | Console | HttpClient.HttpClient> {
	if (options.command === 'update' || !(yield* noticeEnabled(options.mode, options.version))) {
		return yield* program;
	}
	const file = yield* updateCheckPath;
	const installation = yield* Installation;
	const executable = yield* installation.executable.pipe(Effect.option);
	if (
		Option.isNone(file) ||
		Option.isNone(executable) ||
		installMethod(executable.value) === 'unknown'
	) {
		return yield* program;
	}
	const now = yield* Clock.currentTimeMillis;
	const saved = yield* installation.readUpdateCheck(file.value);
	const refresh = Effect.gen(function* () {
		if (Option.isSome(saved) && now - saved.value.checked_at < CHECK_INTERVAL_MS) return saved;
		const previous = Option.match(saved, {
			onNone: () => options.version,
			onSome: (check) => check.latest_version
		});
		// Recorded first, so an offline or slow check is retried only after the interval.
		yield* installation.saveUpdateCheck(file.value, { latest_version: previous, checked_at: now });
		const latest = yield* latestVersion;
		const check = { latest_version: latest, checked_at: now };
		yield* installation.saveUpdateCheck(file.value, check);
		return Option.some(check);
	}).pipe(Effect.orElseSucceed(() => saved));
	const running = yield* Effect.forkChild(refresh);
	const result = yield* program;
	const check = yield* Fiber.join(running).pipe(
		Effect.timeoutOption(NOTICE_CHECK_BUDGET),
		Effect.map(Option.getOrElse(() => saved))
	);
	yield* Fiber.interrupt(running);
	if (Option.isSome(check) && isNewer(check.value.latest_version, options.version)) {
		const console = yield* Console;
		yield* console.writeStderr(
			`Update available: akua ${options.version} -> ${check.value.latest_version}. Run \`akua update\` to install it (AKUA_NO_UPDATE_CHECK=1 turns off this check).\n`
		);
	}
	return result;
});
