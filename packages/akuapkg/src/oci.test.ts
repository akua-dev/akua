import { BunCrypto, BunServices } from '@effect/platform-bun';
import { expect, it } from '@effect/vitest';
import { Cause, ConfigProvider, Console, Effect, FileSystem, Layer, Option, Path } from 'effect';
import { HttpClient, HttpClientError, HttpClientResponse } from 'effect/http';
import { Command } from 'effect/cli';
import { ArchiveInvalid } from './archive';
import { reportable, reportedAs } from './cli/report';
import { CliFailure } from './contract';
import { vendor } from './cli/vendor';
import { verify } from './cli/verify';
import { resolvePackage } from './dependencies';
import { sha256 } from './downloads';
import { DependencyUnresolved, HostError } from './errors';
import { GitRemote } from './git';
import { HelmRepository } from './helm-repository';
import { OciPullFailed, type OciPushFailed, OciRegistry } from './oci';
import { UrlSource } from './url-source';

const diagnosticCases = [
	'pull-network',
	'push-network',
	'pull-token-network',
	'push-token-network',
	'pull-token-decode',
	'push-token-decode',
	'pull-manifest',
	'package-manifest',
	'attestation-manifest',
	'attestation-sidecar',
	'signature-manifest-http',
	'signature-manifest-decode',
	'signature-payload-http',
	'signature-verify',
	'signature-payload-decode',
	'signature-key-import',
	'pull-status-stream',
	'push-status-stream',
	'pull-stream'
] as const;

it.live.each(diagnosticCases)('real OCI HTTP boundary preserves %s diagnostics', (scenario) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const directory = yield* fs.makeTempDirectoryScoped();
		const sentinel = new Error('private-http-diagnostic');
		const manifest = JSON.stringify({ layers: [] });
		const signature = JSON.stringify({
			layers: [
				{
					mediaType: 'application/vnd.dev.cosign.simplesigning.v1+json',
					digest: 'sha256:signature',
					annotations: {
						'dev.cosignproject.cosign/signature':
							scenario === 'signature-verify' ? '!' : new Uint8Array(64).toBase64()
					}
				}
			]
		});
		const transport = Layer.succeed(
			HttpClient.HttpClient,
			HttpClient.make((request) => {
				const token = request.url.startsWith('https://auth.example.test/');
				if (scenario.endsWith('-network') && scenario.includes('-token-') === token) {
					return Effect.fail(
						new HttpClientError.HttpClientError({
							reason: new HttpClientError.TransportError({ request, cause: sentinel })
						})
					);
				}
				let response: Response;
				if (scenario.includes('-token-')) {
					response = token
						? new Response('invalid-token-json')
						: new Response('', {
								status: 401,
								headers: { 'www-authenticate': 'Bearer realm="https://auth.example.test/token"' }
							});
				} else if (scenario.endsWith('status-stream') && request.method === 'POST') {
					response = new Response(null, { status: 202, headers: { location: '/upload/1' } });
				} else if (scenario === 'pull-stream' || scenario.endsWith('status-stream')) {
					response = new Response(
						new ReadableStream({
							start(controller) {
								controller.error(sentinel);
							}
						}),
						{ status: scenario === 'pull-stream' ? 200 : 503 }
					);
				} else if (request.url.endsWith('.sig')) {
					response =
						scenario === 'signature-manifest-http'
							? new Response('refused', { status: 403 })
							: new Response(scenario === 'signature-manifest-decode' ? 'invalid-json' : signature);
				} else if (request.url.endsWith('/blobs/sha256:signature')) {
					response =
						scenario === 'signature-payload-http'
							? new Response('refused', { status: 403 })
							: new Response(
									scenario === 'signature-key-import'
										? JSON.stringify({
												critical: {
													image: {
														'docker-manifest-digest': sha256(new TextEncoder().encode(manifest))
													}
												}
											})
										: 'invalid-signature-payload'
								);
				} else if (request.url.endsWith('.att')) {
					response = new Response('invalid-sidecar-json');
				} else {
					response = new Response(
						scenario.startsWith('signature-') || scenario === 'attestation-sidecar'
							? manifest
							: 'invalid-manifest-json'
					);
				}
				return Effect.succeed(HttpClientResponse.fromWeb(request, response));
			})
		);
		const failure = yield* isolated(
			directory,
			Effect.gen(function* () {
				const registry = yield* OciRegistry;
				const action: Effect.Effect<void, OciPullFailed | OciPushFailed> = scenario.startsWith(
					'push-'
				)
					? registry
							.pushPackage({
								reference,
								tag: '1.0.0',
								tarball: new Uint8Array(),
								akuaVersion: '1.0.0'
							})
							.pipe(Effect.asVoid)
					: scenario.startsWith('attestation-')
						? registry.pullAttestation({ reference, tag: '1.0.0' }).pipe(Effect.asVoid)
						: scenario === 'package-manifest'
							? registry.pullPackage({ reference, tag: '1.0.0' }).pipe(Effect.asVoid)
							: registry
									.pull({
										reference,
										version: '1.0.0',
										offline: false,
										pin: Option.none(),
										lockedSignature: Option.none(),
										cosignPublicKey: scenario.startsWith('signature-')
											? Option.some('AA==')
											: Option.none()
									})
									.pipe(Effect.asVoid);
				return yield* action.pipe(Effect.flip);
			}).pipe(Effect.provide(OciRegistry.layer.pipe(Layer.provide(transport))))
		);
		expect('cause' in failure ? failure.cause : undefined).toBeDefined();
		const diagnostic = Cause.pretty(Cause.fail(failure));
		if (
			scenario.endsWith('-network') ||
			scenario === 'pull-stream' ||
			scenario.endsWith('status-stream')
		)
			expect(diagnostic).toContain(sentinel.message);
		else if (scenario === 'signature-verify' || scenario === 'signature-key-import') {
			expect(diagnostic).toContain('CosignInvalid');
			expect(diagnostic).toContain(scenario === 'signature-verify' ? 'SyntaxError' : 'DataError');
		} else if (scenario.endsWith('-http')) expect(diagnostic).toContain('OciPullFailed');
		else expect(diagnostic).toContain('SchemaError');
		const publicFailure = reportable(
			new DependencyUnresolved({
				dependency: 'review',
				code: 'E_DEP_RESOLVE',
				message: failure.message,
				cause: failure
			})
		);
		expect(JSON.stringify(publicFailure.error)).not.toContain('"cause"');
	}).pipe(Effect.scoped, Effect.provide(BunServices.layer))
);

const reference = 'oci://registry.example.test/review/chart';
const privateBytes = 'archive-private-sentinel';

it.live.each([
	'pull-auth-read',
	'push-auth-read',
	'pull-auth-parse',
	'push-auth-parse',
	'key',
	'cache'
] as const)('real OCI producer boundary retains %s failures', (scenario) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const directory = yield* fs.makeTempDirectoryScoped();
		yield* fs.makeDirectory(`${directory}/akua`);
		if (scenario.endsWith('auth-read')) yield* fs.makeDirectory(`${directory}/akua/auth.toml`);
		if (scenario.endsWith('auth-parse'))
			yield* fs.writeFileString(
				`${directory}/akua/auth.toml`,
				'token = "private-auth-canary"\nbroken = unquoted'
			);
		if (scenario === 'cache') yield* fs.writeFileString(`${directory}/akua/oci`, 'not-a-directory');
		const blob = new Uint8Array(1024);
		const digest = sha256(blob);
		const transport = Layer.succeed(
			HttpClient.HttpClient,
			HttpClient.make((request) =>
				Effect.succeed(
					HttpClientResponse.fromWeb(
						request,
						request.url.includes('/manifests/')
							? Response.json({
									annotations: { 'dev.akua.package.name': 'review' },
									layers: [
										{
											mediaType: 'application/vnd.oci.image.layer.v1.tar',
											digest,
											size: blob.length
										}
									]
								})
							: new Response(new Uint8Array(blob))
					)
				)
			)
		);
		const failure = yield* isolated(
			directory,
			Effect.gen(function* () {
				const registry = yield* OciRegistry;
				const action: Effect.Effect<void, OciPullFailed | OciPushFailed> = scenario.startsWith(
					'push-'
				)
					? registry
							.pushPackage({ reference, tag: '1.0.0', tarball: blob, akuaVersion: '1.0.0' })
							.pipe(Effect.asVoid)
					: registry
							.pull({
								reference,
								version: '1.0.0',
								pin: Option.none(),
								lockedSignature: Option.none(),
								cosignPublicKey: scenario === 'key' ? Option.some('!') : Option.none(),
								offline: false
							})
							.pipe(Effect.asVoid);
				return yield* action.pipe(Effect.flip);
			}).pipe(Effect.provide(OciRegistry.layer.pipe(Layer.provide(transport))))
		);
		const diagnostic = Cause.pretty(Cause.fail(failure));
		if (scenario.endsWith('auth-parse')) {
			expect(diagnostic).not.toContain('private-auth-canary');
			if (scenario.startsWith('push-')) expect(failure.cause).toBeInstanceOf(OciPullFailed);
			else expect(failure.cause).toBeUndefined();
			return;
		}
		expect(failure.cause).toBeInstanceOf(Error);
		expect(diagnostic).toContain(scenario === 'key' ? 'CosignInvalid' : 'PlatformError');
	}).pipe(Effect.scoped, Effect.provide(BunServices.layer))
);

it.live.each([
	['resolve-key-read', 'PlatformError'],
	['resolve-key-decode', 'CosignInvalid'],
	['resolve-crds', 'CrdsInvalid'],
	['resolve-path-escape', 'PathEscape'],
	['vendor-key-read', 'DependencyUnresolved'],
	['vendor-auth', 'AuthParseError'],
	['verify-lock', 'LockInvalid'],
	['verify-key-read', 'PlatformError'],
	['verify-key-decode', 'CosignInvalid'],
	['verify-tarball', 'PlatformError'],
	['verify-tarball-key', 'PlatformError']
] as const)('native package boundary preserves %s diagnostics', ([scenario, tag]) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const directory = yield* fs.makeTempDirectoryScoped();
		const signing =
			scenario.includes('key-') && !scenario.includes('tarball')
				? '[signing]\ncosign_public_key = "public.pem"\n'
				: '';
		const dependency =
			scenario === 'resolve-path-escape'
				? 'path = "dep"'
				: scenario === 'resolve-crds'
					? 'url = "https://registry.example.test/crds.yaml", crds = true'
					: `oci = "${reference}", version = "1.0.0"`;
		yield* fs.writeFileString(
			`${directory}/akua.toml`,
			[
				'[package]',
				'name = "review"',
				'version = "0.1.0"',
				'edition = "akua.dev/v1"',
				signing,
				'[dependencies]',
				`chart = { ${dependency} }`
			].join('\n')
		);
		yield* fs.writeFileString(
			`${directory}/akua.lock`,
			scenario === 'verify-lock' ? '[' : 'version = 1'
		);
		if (scenario.endsWith('key-decode')) yield* fs.writeFileString(`${directory}/public.pem`, '!');
		if (scenario === 'resolve-crds') {
			yield* fs.makeDirectory(`${directory}/.akua/crds/chart`, { recursive: true });
			yield* fs.writeFileString(`${directory}/.akua/crds/chart/source.toml`, '[');
		}
		if (scenario === 'resolve-path-escape') {
			const outside = yield* fs.makeTempDirectoryScoped();
			yield* fs.writeFileString(`${outside}/outside.k`, 'private');
			yield* fs.makeDirectory(`${directory}/dep`);
			yield* fs.symlink(`${outside}/outside.k`, `${directory}/dep/escaped.k`);
		}
		if (scenario === 'verify-tarball-key')
			yield* fs.writeFile(`${directory}/chart.tgz`, new Uint8Array());
		const transport = Layer.succeed(
			HttpClient.HttpClient,
			HttpClient.make((request) =>
				Effect.succeed(
					HttpClientResponse.fromWeb(request, new Response('refused', { status: 403 }))
				)
			)
		);
		const fetchers = Layer.mergeAll(
			OciRegistry.layer,
			GitRemote.layer,
			HelmRepository.layer,
			UrlSource.layer
		).pipe(Layer.provide(transport));
		const action = scenario.startsWith('resolve-')
			? resolvePackage(directory, { offline: false }).pipe(
					Effect.provide(fetchers),
					Effect.asVoid,
					Effect.flip
				)
			: scenario.startsWith('vendor-')
				? Command.runWith(vendor({ name: 'akuapkg', fetchers }), { version: '1.0.0' })([
						'add',
						'chart',
						'--workspace',
						directory,
						'--json',
						...(scenario === 'vendor-auth' ? ['--auth', 'invalid'] : [])
					]).pipe(Effect.flip)
				: Command.runWith(verify({ version: '1.0.0', fetchers }), { version: '1.0.0' })([
						'--workspace',
						directory,
						'--json',
						...(scenario.startsWith('verify-tarball')
							? ['--tarball', `${directory}/chart.tgz`]
							: []),
						...(scenario === 'verify-tarball-key'
							? ['--public-key', `${directory}/public.pem`]
							: [])
					]).pipe(Effect.flip);
		const failure = yield* isolated(
			directory,
			Effect.gen(function* () {
				return yield* action;
			})
		);
		expect('cause' in failure ? failure.cause : undefined).toMatchObject({ _tag: tag });
	}).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(BunServices.layer, BunCrypto.layer)))
);

it.live.each([
	['oci', 'resolve'],
	['helm', 'resolve'],
	['git', 'resolve'],
	['url', 'resolve'],
	['oci', 'vendor'],
	['git', 'vendor'],
	['url', 'vendor']
] as const)('real %s HTTP refusal survives the %s wrapper', ([kind, boundary]) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const directory = yield* fs.makeTempDirectoryScoped();
		const server = yield* Effect.acquireRelease(
			Effect.sync(() =>
				Bun.serve({
					port: 0,
					hostname: '127.0.0.1',
					fetch: () => new Response('refused', { status: 403 })
				})
			),
			(server) => Effect.sync(() => server.stop(true))
		);
		const source =
			kind === 'oci'
				? `oci = "${reference}", version = "1.0.0"`
				: kind === 'helm'
					? 'repo = "https://registry.example.test", chart = "review", version = "1.0.0"'
					: kind === 'git'
						? `git = "${server.url.href}review.git", tag = "v1"`
						: 'url = "https://registry.example.test/crds.yaml", crds = true';
		yield* fs.writeFileString(
			`${directory}/akua.toml`,
			[
				'[package]',
				'name = "review"',
				'version = "0.1.0"',
				'edition = "akua.dev/v1"',
				'[dependencies]',
				`chart = { ${source} }`
			].join('\n')
		);
		const transport = Layer.succeed(
			HttpClient.HttpClient,
			HttpClient.make((request) =>
				Effect.succeed(
					HttpClientResponse.fromWeb(request, new Response('refused', { status: 403 }))
				)
			)
		);
		const fetchers = Layer.mergeAll(
			OciRegistry.layer,
			GitRemote.layer,
			HelmRepository.layer,
			UrlSource.layer
		).pipe(Layer.provide(transport));
		const action =
			boundary === 'resolve'
				? resolvePackage(directory, { offline: false }).pipe(
						Effect.provide(fetchers),
						Effect.asVoid,
						Effect.flip
					)
				: Command.runWith(vendor({ name: 'akuapkg', fetchers }), { version: '1.0.0' })([
						'add',
						'chart',
						'--workspace',
						directory,
						'--json'
					]).pipe(Effect.flip);
		const failure = yield* isolated(
			directory,
			Effect.gen(function* () {
				return yield* action;
			})
		);
		expect(failure).toBeInstanceOf(boundary === 'resolve' ? DependencyUnresolved : CliFailure);
		const expectedTag = {
			oci: 'OciPullFailed',
			helm: 'HelmRepositoryFailed',
			git: 'GitFetchFailed',
			url: 'UrlFetchFailed'
		}[kind];
		expect('cause' in failure ? failure.cause : undefined).toMatchObject({ _tag: expectedTag });
		expect(yield* fs.exists(`${directory}/akua.lock`)).toBe(false);
		expect(yield* fs.exists(`${directory}/.akua/vendor/chart`)).toBe(false);
	}).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(BunServices.layer, BunCrypto.layer)))
);

const invalidBlob = (kind: 'gzip' | 'utf8') => {
	if (kind === 'gzip') return new TextEncoder().encode(privateBytes);
	const tar = new Uint8Array(1024);
	tar.set(new TextEncoder().encode(privateBytes));
	tar[privateBytes.length] = 0xff;
	tar[156] = 48;
	return tar;
};

// Only the external registry HTTP transport is substituted. Digests, archive
// decoding, dependency resolution, filesystem and reporting are real.
const registryTransport = (kind: 'gzip' | 'utf8') => {
	const blob = invalidBlob(kind);
	const digest = sha256(blob);
	const manifest = JSON.stringify({
		schemaVersion: 2,
		annotations: { 'dev.akua.package.name': 'review' },
		layers: [
			{
				mediaType:
					kind === 'gzip'
						? 'application/vnd.cncf.helm.chart.content.v1.tar+gzip'
						: 'application/vnd.oci.image.layer.v1.tar',
				digest,
				size: blob.length
			}
		]
	});
	return Layer.succeed(
		HttpClient.HttpClient,
		HttpClient.make((request) =>
			Effect.succeed(
				HttpClientResponse.fromWeb(
					request,
					request.url.endsWith('/manifests/1.0.0')
						? new Response(manifest)
						: request.url.endsWith(`/blobs/${digest}`)
							? new Response(new Uint8Array(blob))
							: new Response('unexpected registry request', { status: 404 })
				)
			)
		)
	);
};

const isolated = <A, E, R>(directory: string, effect: Effect.Effect<A, E, R>) =>
	effect.pipe(
		Effect.provideService(
			ConfigProvider.ConfigProvider,
			ConfigProvider.fromUnknown({
				XDG_CACHE_HOME: directory,
				XDG_CONFIG_HOME: directory,
				DOCKER_CONFIG: directory,
				HOME: directory
			})
		)
	);

it.live.each(['gzip', 'utf8'] as const)(
	'real OCI pull retains the native %s archive failure',
	(kind) =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const directory = yield* fs.makeTempDirectoryScoped();
			const failure = yield* isolated(
				directory,
				Effect.gen(function* () {
					const registry = yield* OciRegistry;
					return yield* registry
						.pull({
							reference,
							version: '1.0.0',
							pin: Option.none(),
							lockedSignature: Option.none(),
							cosignPublicKey: Option.none(),
							offline: false
						})
						.pipe(Effect.flip);
				}).pipe(Effect.provide(OciRegistry.layer.pipe(Layer.provide(registryTransport(kind)))))
			);
			expect(failure).toBeInstanceOf(OciPullFailed);
			expect(failure.code).toBe('E_DEP_RESOLVE');
			expect(failure.offline).toBe(false);
			expect(failure.message).toContain(
				kind === 'gzip' ? 'decompressing:' : 'tar entry name is not UTF-8'
			);
			expect(failure.cause).toBeInstanceOf(ArchiveInvalid);
			if (!(failure.cause instanceof ArchiveInvalid)) return;
			expect(failure.cause.cause).toBeInstanceOf(Error);
			if (kind === 'utf8') expect(failure.cause.cause).toBeInstanceOf(TypeError);
			expect(yield* fs.exists(`${directory}/akua/oci/sha256`)).toBe(false);
		}).pipe(Effect.scoped, Effect.provide(BunServices.layer))
);

it.live.each(['gzip', 'utf8'] as const)(
	'real %s dependency failure keeps its chain private in CLI output',
	(kind) =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;
			const directory = yield* fs.makeTempDirectoryScoped();
			yield* fs.writeFileString(
				path.join(directory, 'akua.toml'),
				[
					'[package]',
					'name = "review"',
					'version = "0.1.0"',
					'edition = "akua.dev/v1"',
					'[dependencies]',
					`chart = { oci = "${reference}", version = "1.0.0" }`
				].join('\n')
			);
			const fetchers = Layer.mergeAll(
				OciRegistry.layer,
				GitRemote.layer,
				HelmRepository.layer,
				UrlSource.layer
			).pipe(Layer.provide(registryTransport(kind)));
			const failure = yield* isolated(
				directory,
				resolvePackage(directory, { offline: false }).pipe(Effect.provide(fetchers), Effect.flip)
			);
			expect(failure).toBeInstanceOf(DependencyUnresolved);
			if (!(failure instanceof DependencyUnresolved)) return;
			expect(failure.code).toBe('E_DEP_RESOLVE');
			expect(failure.cause).toBeInstanceOf(OciPullFailed);
			if (!(failure.cause instanceof OciPullFailed)) return;
			expect(failure.cause.cause).toBeInstanceOf(ArchiveInvalid);
			if (!(failure.cause.cause instanceof ArchiveInvalid)) return;
			expect(failure.cause.cause.cause).toBeInstanceOf(Error);
			const cli = reportable(failure);
			expect(cli).toBeInstanceOf(CliFailure);
			expect(cli.exitCode).toBe(1);
			expect(cli.cause).toBeInstanceOf(HostError);
			if (cli.cause instanceof HostError) expect(cli.cause.reason).toBe(failure);
			const currentConsole = yield* Console.Console;
			for (const mode of ['json', 'text'] as const) {
				const stderr: string[] = [];
				const reported = yield* Effect.fail(cli).pipe(
					reportedAs(mode),
					Effect.provideService(Console.Console, {
						...currentConsole,
						error: (...values) => {
							stderr.push(values.join(' '));
						}
					}),
					Effect.flip
				);
				expect(reported).toBe(cli);
				expect(stderr).toHaveLength(1);
				const output = stderr.join('');
				expect(output).toContain('E_DEP_RESOLVE');
				for (const privateValue of [
					privateBytes,
					'cause',
					'ArchiveInvalid',
					'HostError',
					'oci.test.ts'
				]) {
					expect(output).not.toContain(privateValue);
				}
				if (mode === 'json') expect(JSON.parse(output)).toEqual(cli.error);
			}
			expect(yield* fs.exists(path.join(directory, 'akua.lock'))).toBe(false);
			expect(yield* fs.exists(path.join(directory, 'akua', 'oci', 'sha256'))).toBe(false);
		}).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(BunServices.layer, BunCrypto.layer)))
);
