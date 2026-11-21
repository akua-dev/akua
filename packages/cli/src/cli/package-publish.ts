import { Effect, Layer, Option, Predicate, Schedule, Schema } from 'effect';
import { Digest } from 'effect/crypto';
import { Hex } from 'effect/encoding';
import { PublishHost } from '@akua-dev/sdk/publish-host';
import { ExitCode, fail } from '@akua-dev/sdk/contract';
import { ApiClient } from '../api/client';
import { findOperation } from '../api/inputs';
import { asJsonRecord } from '../api/json';
import { decodeRequest, type ApiRequest } from '../api/request';
import { contract } from '../generated/contract.gen';
import { optionalEnv, resolveCredential } from '../runtime/credentials';
import { SecureConfig } from '../runtime/services';
import { resolveWorkspaceId, selectWorkspace } from './workspace-context';

const failed = (message: string, cause?: unknown) =>
	fail('E_PUBLISH_FAILED', message, ExitCode.userError, undefined, undefined, cause);

/** The failed publication Operation's error; `violations` name each unresolvable image. */
const PublicationError = Schema.Struct({
	message: Schema.String,
	reason: Schema.optionalKey(Schema.String),
	violations: Schema.optionalKey(
		Schema.Array(
			Schema.Struct({ type: Schema.String, subject: Schema.String, description: Schema.String })
		)
	)
});
/** `<registry>/<workspace>/images/<upstream>/<repository>` with a tag or digest. */
const AKUA_IMAGE =
	/^[^/]+\/ws_[a-z0-9]+\/images\/([^/]+)\/(.+?)(:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}|@sha256:[a-f0-9]{64})$/u;
/** The Upstream fields that turn an Akua image path back into the image as the Upstream serves it. */
const UpstreamOrigin = Schema.Struct({ host: Schema.String, path: Schema.String });
type UpstreamOrigin = typeof UpstreamOrigin.Type;
/** The Upstream an Akua image path names, or none for any other image. */
export const imageUpstream = (image: string) => Option.fromNullishOr(AKUA_IMAGE.exec(image)?.[1]);
/**
 * The command that shows why one Akua image path does not resolve: `resolve-image` with the
 * image as its Upstream serves it, or `list-upstreams` when the Upstream is unknown.
 */
export const resolveImageCommand = (
	image: string,
	upstreams: ReadonlyMap<string, UpstreamOrigin>
) => {
	const [, upstreamId, repository, reference] = AKUA_IMAGE.exec(image) ?? [];
	const upstream = upstreamId === undefined ? undefined : upstreams.get(upstreamId);
	return upstream === undefined || repository === undefined || reference === undefined
		? 'akua registry list-upstreams'
		: `akua registry resolve-image ${upstreamId} --image ${upstream.host}/${upstream.path}/${repository}${reference}`;
};
const publicationFailure = Effect.fnUntraced(function* (
	error: unknown,
	lookup: (upstream: string) => Effect.Effect<Option.Option<UpstreamOrigin>>
) {
	const decoded = Schema.decodeUnknownOption(PublicationError)(error);
	if (Option.isNone(decoded)) return yield* failed('Package publication failed', error);
	const { message, reason, violations = [] } = decoded.value;
	if (reason !== 'image-unresolvable' || violations.length === 0)
		return yield* failed(message, error);
	const upstreams = new Map<string, UpstreamOrigin>();
	for (const upstream of new Set(
		violations.flatMap((violation) => Option.toArray(imageUpstream(violation.subject)))
	))
		Option.map(yield* lookup(upstream), (origin) => upstreams.set(upstream, origin));
	return yield* fail(
		'E_PUBLISH_FAILED',
		violations.map((violation) => `${violation.subject}: ${violation.description}`).join('\n'),
		ExitCode.userError,
		undefined,
		[
			'Fix each image path or its Upstream, then run akua pkg publish again. Check an image with:',
			...new Set(
				violations.map((violation) => `  ${resolveImageCommand(violation.subject, upstreams)}`)
			)
		].join('\n'),
		error
	);
});

/** Hosted-platform policy stays in the embedding CLI, not the cloud-independent toolchain. */
export const PackagePublishHost = Layer.effect(
	PublishHost,
	Effect.gen(function* () {
		const api = yield* ApiClient;
		const config = yield* SecureConfig;
		const crypto = yield* Digest.Digest;
		const execute = Effect.fnUntraced(
			function* (id: string, input: ApiRequest) {
				const operation = yield* findOperation(contract, id);
				const request = yield* decodeRequest(contract, operation, input);
				const response = yield* api.execute(operation, request);
				if (response._tag !== 'Value') return yield* failed('Expected a JSON API response');
				return yield* Effect.fromOption(asJsonRecord(response.value)).pipe(
					Effect.mapError((cause) => failed('The API returned an invalid JSON object', cause))
				);
			},
			Effect.mapError((error) =>
				error._tag === 'CliFailure'
					? error
					: failed(
							'Hosted publication failed. Check Workspace access and retry; use akua packages create --help for the API contract.',
							error
						)
			)
		);
		return PublishHost.of({
			prepare: Effect.fn('PackagePublish.prepare')(
				function* ({ name, version, archiveSize }) {
					if (archiveSize > 4 * 1024 * 1024)
						return yield* failed(
							'Package archive exceeds 4 MiB. Remove vendored build output before publishing.'
						);
					const credential = yield* resolveCredential.pipe(
						Effect.provideService(SecureConfig, config)
					);
					if (Option.isNone(credential.token))
						return yield* failed('Run akua auth login or set AKUA_API_TOKEN before publishing.');
					const selected = yield* selectWorkspace(Option.none()).pipe(
						Effect.provideService(SecureConfig, config)
					);
					if (Option.isNone(selected))
						return yield* failed(
							'Choose a Workspace with akua workspaces use <workspace> before publishing.'
						);
					const workspaceId = yield* resolveWorkspaceId(contract, selected.value).pipe(
						Effect.provideService(ApiClient, api)
					);
					const override = yield* optionalEnv('AKUA_REGISTRY_URL');
					const apiOverride = yield* optionalEnv('AKUA_API_URL');
					if (Option.isSome(apiOverride) && Option.isNone(override))
						return yield* failed(
							'Set AKUA_REGISTRY_URL to the registry of the selected API environment.'
						);
					const registry = URL.parse(Option.getOrElse(override, () => 'https://pkg.akua.dev'));
					if (
						registry === null ||
						registry.username !== '' ||
						registry.password !== '' ||
						registry.search !== '' ||
						registry.hash !== '' ||
						registry.pathname !== '/' ||
						(registry.protocol !== 'https:' &&
							!['localhost', '127.0.0.1'].includes(registry.hostname))
					)
						return yield* failed('AKUA_REGISTRY_URL must be an HTTPS registry origin.');
					const hash = Hex.encode(
						yield* crypto.digest(
							Digest.sha256,
							new TextEncoder().encode(JSON.stringify(['hosted-package', workspaceId, name]))
						)
					);
					const headers = { 'akua-context': workspaceId };
					const resource = yield* execute('packages.create', {
						headers: { ...headers, 'idempotency-key': `idk_${hash.slice(0, 24)}` },
						body: { name, source: { kind: 'hosted', chart: name } }
					});
					if (!Predicate.isString(resource.id))
						return yield* failed('The API returned no Package ID');
					const packageId = resource.id;
					const complete = Effect.gen(function* () {
						const accepted = yield* execute('packages.createVersion', {
							path: { id: packageId },
							headers,
							body: { version }
						});
						if (!Predicate.isString(accepted.id))
							return yield* failed('The API returned no publication Operation');
						const operationId = accepted.id;
						const settled = yield* execute('operations.wait', {
							path: { id: operationId },
							headers,
							query: { timeout: 60 }
						}).pipe(
							Effect.repeat({
								while: (operation) => operation.done !== true,
								schedule: Schedule.spaced('1 second')
							})
						);
						if (settled.state !== 'SUCCEEDED')
							return yield* publicationFailure(settled.error, (upstream) =>
								execute('registry.getUpstream', { path: { upstream }, headers }).pipe(
									Effect.map(Schema.decodeUnknownOption(UpstreamOrigin)),
									Effect.orElseSucceed(() => Option.none())
								)
							);
					});
					return {
						reference: `oci://${registry.host}/${workspaceId}/packages/${packageId}/${name}`,
						// The tag the API publishes the version from: SemVer build metadata (`+`) is not valid
						// in an OCI tag, so it becomes `_`, as Helm pushes it and Package publication reads it.
						tag: version.replaceAll('+', '_'),
						password: credential.token.value,
						complete
					};
				},
				Effect.mapError((error) =>
					error._tag === 'CliFailure'
						? error
						: failed(
								'Could not prepare hosted publication. Check the selected Workspace and credential.'
							)
				)
			)
		});
	})
);
