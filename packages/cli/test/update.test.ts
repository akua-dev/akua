import { BunCrypto, BunServices } from '@effect/platform-bun';
import { describe, expect, it } from '@effect/vitest';
import { Effect, FileSystem, Layer, Path } from 'effect';
import { Digest } from 'effect/crypto';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';

import { bytesToHex } from '../scripts/runtime/release-services';
import { InstallationLive } from '../src/runtime/installation-live';
import { type FakeApi, type FakeResponse, runAkua, temporaryHome } from './fake-api';

const INSTALLED = '0.13.9';
const LATEST = '0.13.15';
const ASSET = `akua-v${LATEST}-linux-x64.tar.gz`;
const LATEST_RELEASE = 'https://api.github.com/repos/akua-dev/akua/releases/latest';
const DOWNLOAD = `https://github.com/akua-dev/akua/releases/download/v${LATEST}`;
/** An ELF header, so the release executable check accepts the fixture as a Linux binary. */
const ELF = [0x7f, 0x45, 0x4c, 0x46];
const host = Layer.mergeAll(BunServices.layer, BunCrypto.layer);

const executableBytes = (marker: string) =>
	new Uint8Array([...ELF, ...new TextEncoder().encode(marker)]);

/** A release archive holding one `akua` executable, and its `.sha256` sidecar as GitHub serves it. */
const releaseArchive = Effect.fn('releaseArchive')(function* (
	marker: string,
	executable = executableBytes(marker)
) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'akua-release-' });
	const contents = path.join(directory, 'contents');
	yield* fs.makeDirectory(contents);
	yield* fs.writeFile(path.join(contents, 'akua'), executable, { mode: 0o755 });
	const archivePath = path.join(directory, ASSET);
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	expect(
		Number(
			yield* spawner.exitCode(
				ChildProcess.make('tar', ['-czf', archivePath, '-C', contents, 'akua'], {
					stdout: 'ignore',
					stderr: 'ignore'
				})
			)
		)
	).toBe(0);
	const archive = new Uint8Array(yield* fs.readFile(archivePath));
	const digest = bytesToHex(yield* (yield* Digest.Digest).digest(Digest.sha256, archive));
	return { archive, sidecar: `${digest}  ${ASSET}\n` };
});

/** GitHub as `akua update` reads it: the latest release and its assets. */
const github =
	(release: { readonly archive: Uint8Array<ArrayBuffer>; readonly sidecar: string }): FakeApi =>
	(request): FakeResponse => {
		if (request.url.href === LATEST_RELEASE) return { body: { tag_name: `v${LATEST}` } };
		if (request.url.href === `${DOWNLOAD}/${ASSET}.sha256`) {
			return { text: release.sidecar, contentType: 'text/plain' };
		}
		if (request.url.href === `${DOWNLOAD}/${ASSET}`) {
			return { bytes: release.archive, contentType: 'application/octet-stream' };
		}
		return { status: 404, body: { message: 'Not Found' } };
	};

/** A standalone `akua` in a temporary bin directory. */
const standaloneInstall = Effect.fn('standaloneInstall')(function* () {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const directory = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: 'akua-bin-' }));
	const executable = path.join(directory, 'akua');
	yield* fs.writeFile(executable, executableBytes('installed'), { mode: 0o755 });
	return { directory, executable };
});

const installation = (execPath: string) =>
	InstallationLive({ execPath, platform: 'linux', arch: 'x64' }).pipe(Layer.provide(host));

const readText = (file: string) =>
	Effect.gen(function* () {
		return new TextDecoder().decode(yield* (yield* FileSystem.FileSystem).readFile(file));
	});

describe('akua update --check', () => {
	it.effect('reports the installed and latest versions and changes nothing', () =>
		Effect.gen(function* () {
			const release = yield* releaseArchive('latest');
			const { executable } = yield* standaloneInstall();

			const result = yield* runAkua(['update', '--check', '--json'], {
				version: INSTALLED,
				api: github(release),
				installation: installation(executable)
			});

			expect(result.exitCode).toBe(0);
			expect(JSON.parse(result.stdout).data).toEqual({
				current_version: INSTALLED,
				latest_version: LATEST,
				update_available: true,
				install_method: 'standalone',
				executable,
				update_command: 'akua update'
			});
			expect(result.requests.map((request) => request.url.href)).toEqual([LATEST_RELEASE]);
			expect(yield* readText(executable)).toContain('installed');
		}).pipe(Effect.scoped, Effect.provide(host))
	);

	it.effect('reports the versions in human and agent output', () =>
		Effect.gen(function* () {
			const release = yield* releaseArchive('latest');
			const { executable } = yield* standaloneInstall();
			const run = (tty: boolean) =>
				runAkua(['update', '--check'], {
					version: INSTALLED,
					tty,
					api: github(release),
					installation: installation(executable)
				});

			const human = yield* run(true);
			const agent = yield* run(false);

			expect(human.exitCode).toBe(0);
			expect(human.stdout).toContain(`akua ${LATEST} is available (installed: ${INSTALLED}).`);
			expect(agent.exitCode).toBe(0);
			expect(agent.stdout).toContain(`latest_version: ${LATEST}`);
			expect(agent.stdout).toContain('update_available: true');
		}).pipe(Effect.scoped, Effect.provide(host))
	);

	it.effect('names the Homebrew command for a Homebrew install', () =>
		Effect.gen(function* () {
			const release = yield* releaseArchive('latest');
			const { executable } = yield* homebrewInstall();

			const result = yield* runAkua(['update', '--check', '--json'], {
				version: INSTALLED,
				api: github(release),
				installation: installation(executable)
			});

			expect(JSON.parse(result.stdout).data).toMatchObject({
				install_method: 'homebrew',
				update_command: 'brew upgrade akua-dev/tap/akua'
			});
		}).pipe(Effect.scoped, Effect.provide(host))
	);
});

describe('akua update on a standalone binary', () => {
	it.effect('replaces the executable with the verified latest release', () =>
		Effect.gen(function* () {
			const release = yield* releaseArchive('latest');
			const { directory, executable } = yield* standaloneInstall();

			const result = yield* runAkua(['update', '--json'], {
				version: INSTALLED,
				api: github(release),
				installation: installation(executable)
			});

			expect(result.exitCode).toBe(0);
			expect(JSON.parse(result.stdout).data).toMatchObject({
				latest_version: LATEST,
				install_method: 'standalone',
				updated: true
			});
			expect(yield* readText(executable)).toContain('latest');
			const fs = yield* FileSystem.FileSystem;
			expect((yield* fs.stat(executable)).mode & 0o777).toBe(0o755);
			// The staging directory beside the executable is gone.
			expect(yield* fs.readDirectory(directory)).toEqual(['akua']);
		}).pipe(Effect.scoped, Effect.provide(host))
	);

	it.effect('leaves the executable unchanged when the archive does not match its SHA-256', () =>
		Effect.gen(function* () {
			const release = yield* releaseArchive('latest');
			const { directory, executable } = yield* standaloneInstall();
			const tampered = new Uint8Array(release.archive);
			tampered[tampered.length - 1] = (tampered.at(-1) ?? 0) ^ 0xff;

			const result = yield* runAkua(['update', '--json'], {
				version: INSTALLED,
				api: github({ archive: tampered, sidecar: release.sidecar }),
				installation: installation(executable)
			});

			expect(result.exitCode).toBe(1);
			const error = JSON.parse(result.stdout).error;
			expect(error.code).toBe('AKUA_UPDATE_FAILED');
			expect(error.message).toContain('SHA-256');
			expect(yield* readText(executable)).toContain('installed');
			expect(yield* (yield* FileSystem.FileSystem).readDirectory(directory)).toEqual(['akua']);
		}).pipe(Effect.scoped, Effect.provide(host))
	);

	it.effect('leaves the executable unchanged when the archive holds no Linux executable', () =>
		Effect.gen(function* () {
			const release = yield* releaseArchive('script', new TextEncoder().encode('#!/bin/sh\n'));
			const { directory, executable } = yield* standaloneInstall();

			const result = yield* runAkua(['update', '--json'], {
				version: INSTALLED,
				api: github(release),
				installation: installation(executable)
			});

			expect(result.exitCode).toBe(1);
			const error = JSON.parse(result.stdout).error;
			expect(error.code).toBe('AKUA_UPDATE_FAILED');
			expect(error.message).toContain('invalid linux header');
			expect(yield* readText(executable)).toContain('installed');
			// The staged archive and extraction are removed after the failed check.
			expect(yield* (yield* FileSystem.FileSystem).readDirectory(directory)).toEqual(['akua']);
		}).pipe(Effect.scoped, Effect.provide(host))
	);

	it.effect('does nothing when the installed version is the latest', () =>
		Effect.gen(function* () {
			const release = yield* releaseArchive('latest');
			const { executable } = yield* standaloneInstall();

			const result = yield* runAkua(['update', '--json'], {
				version: LATEST,
				api: github(release),
				installation: installation(executable)
			});

			expect(result.exitCode).toBe(0);
			expect(JSON.parse(result.stdout).data).toMatchObject({
				update_available: false,
				updated: false
			});
			expect(result.requests.map((request) => request.url.href)).toEqual([LATEST_RELEASE]);
			expect(yield* readText(executable)).toContain('installed');
		}).pipe(Effect.scoped, Effect.provide(host))
	);
});

/** A Homebrew prefix holding akua in its Cellar and a `brew` that records its arguments. */
const homebrewInstall = Effect.fn('homebrewInstall')(function* () {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const prefix = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: 'akua-brew-' }));
	const libexec = path.join(prefix, 'Cellar', 'akua', INSTALLED, 'libexec');
	yield* fs.makeDirectory(libexec, { recursive: true });
	yield* fs.makeDirectory(path.join(prefix, 'bin'));
	const executable = path.join(libexec, 'akua');
	yield* fs.writeFile(executable, executableBytes('installed'), { mode: 0o755 });
	const calls = path.join(prefix, 'brew-calls');
	yield* fs.writeFileString(
		path.join(prefix, 'bin', 'brew'),
		`#!/bin/sh\necho "$@" >> '${calls}'\necho "==> Upgrading akua"\n`,
		{ mode: 0o755 }
	);
	return { executable, calls };
});

describe('akua update on a Homebrew install', () => {
	it.effect('runs brew upgrade from the owning prefix and keeps stdout one JSON document', () =>
		Effect.gen(function* () {
			const release = yield* releaseArchive('latest');
			const { executable, calls } = yield* homebrewInstall();

			const result = yield* runAkua(['update', '--json'], {
				version: INSTALLED,
				api: github(release),
				installation: installation(executable)
			});

			expect(result.exitCode).toBe(0);
			expect(JSON.parse(result.stdout).data).toMatchObject({
				install_method: 'homebrew',
				ran: 'brew upgrade akua-dev/tap/akua'
			});
			expect(yield* readText(calls)).toBe('upgrade akua-dev/tap/akua\n');
			expect(result.stderr).toContain('==> Upgrading akua');
			expect(yield* readText(executable)).toContain('installed');
		}).pipe(Effect.scoped, Effect.provide(host))
	);
});

describe('akua update without a replaceable install', () => {
	it.effect('prints the commands to run for a binary a system package manager owns', () =>
		Effect.gen(function* () {
			const release = yield* releaseArchive('latest');

			const result = yield* runAkua(['update', '--json'], {
				version: INSTALLED,
				api: github(release),
				// Any file under /usr/bin stands for an executable a system package owns.
				installation: installation('/usr/bin/env')
			});

			expect(result.exitCode).toBe(1);
			const error = JSON.parse(result.stdout).error;
			expect(error.code).toBe('AKUA_UPDATE_MANUAL');
			expect(error.next_steps.map((step: { command: string }) => step.command)).toContain(
				'brew install akua-dev/tap/akua'
			);
			// Refused before asking GitHub, so it also works offline.
			expect(result.requests).toEqual([]);
		}).pipe(Effect.scoped, Effect.provide(host))
	);

	it.effect('refuses to replace a development build', () =>
		Effect.gen(function* () {
			const { executable } = yield* standaloneInstall();

			const result = yield* runAkua(['update', '--json'], {
				installation: installation(executable)
			});

			expect(result.exitCode).toBe(1);
			expect(JSON.parse(result.stdout).error.code).toBe('AKUA_UPDATE_UNAVAILABLE');
			expect(result.requests).toEqual([]);
		}).pipe(Effect.scoped, Effect.provide(host))
	);
});

describe('update notice', () => {
	it.effect('checks once, saves the result, and shows it on interactive runs', () =>
		Effect.gen(function* () {
			const release = yield* releaseArchive('latest');
			const { executable } = yield* standaloneInstall();
			const home = yield* temporaryHome;
			const run = (api: FakeApi) =>
				runAkua(['commands', '--limit', '1'], {
					version: INSTALLED,
					tty: true,
					env: { HOME: home },
					api,
					installation: installation(executable)
				});

			const first = yield* run(github(release));
			const offline: FakeApi = () => ({ status: 503, body: {} });
			const second = yield* run(offline);

			const notice = `Update available: akua ${INSTALLED} -> ${LATEST}. Run \`akua update\``;
			expect(first.exitCode).toBe(0);
			expect(first.stderr).toContain(notice);
			expect(first.requests.map((request) => request.url.href)).toEqual([LATEST_RELEASE]);
			// The saved check is current, so the next run asks GitHub nothing.
			expect(second.stderr).toContain(notice);
			expect(second.requests).toEqual([]);
			expect(JSON.parse(yield* readText(`${home}/.config/akua/update-check.json`))).toMatchObject({
				latest_version: LATEST
			});
		}).pipe(Effect.scoped, Effect.provide(host))
	);

	it.effect('waits for the next due check after a failed one', () =>
		Effect.gen(function* () {
			const release = yield* releaseArchive('latest');
			const { executable } = yield* standaloneInstall();
			const home = yield* temporaryHome;
			const run = (api: FakeApi) =>
				runAkua(['commands', '--limit', '1'], {
					version: INSTALLED,
					tty: true,
					env: { HOME: home },
					api,
					installation: installation(executable)
				});

			const offline = yield* run(() => ({ status: 503, body: {} }));
			const online = yield* run(github(release));

			expect(offline.exitCode).toBe(0);
			expect(offline.requests.map((request) => request.url.href)).toEqual([LATEST_RELEASE]);
			expect(offline.stderr).not.toContain('Update available');
			// The failed check counts, so the next run does not ask GitHub again.
			expect(online.requests).toEqual([]);
			expect(online.stderr).not.toContain('Update available');
		}).pipe(Effect.scoped, Effect.provide(host))
	);

	const quiet: ReadonlyArray<{
		readonly name: string;
		readonly env: Readonly<Record<string, string>>;
		readonly tty: boolean;
	}> = [
		{ name: 'AKUA_NO_UPDATE_CHECK=1', env: { AKUA_NO_UPDATE_CHECK: '1' }, tty: true },
		{ name: 'CI', env: { CI: 'true' }, tty: true },
		{ name: 'agent output', env: {}, tty: false }
	];
	it.effect.each(quiet)('never checks with $name', ({ env, tty }) =>
		Effect.gen(function* () {
			const release = yield* releaseArchive('latest');
			const { executable } = yield* standaloneInstall();
			const home = yield* temporaryHome;

			const result = yield* runAkua(['commands', '--limit', '1'], {
				version: INSTALLED,
				tty,
				env: { HOME: home, ...env },
				api: github(release),
				installation: installation(executable)
			});

			expect(result.exitCode).toBe(0);
			expect(result.stderr).not.toContain('Update available');
			expect(result.requests).toEqual([]);
		}).pipe(Effect.scoped, Effect.provide(host))
	);
});
