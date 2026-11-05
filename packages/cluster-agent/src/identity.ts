import {
	Clock,
	Context,
	Effect,
	FileSystem,
	Layer,
	Option,
	Redacted,
	Ref,
	Result,
	Schedule,
	Schema,
	Semaphore
} from 'effect';
import { Base64 } from 'effect/encoding';
import ids from '@platform/ids';
import type { EnrollRequest } from '@platform/api-contract/services/ClusterConnector';
import { importAgentKey, generateAgentKey, signAssertion, type AgentKey } from './agent-key';
import { AgentConfig, PlatformOrigin } from './config';
import { KubernetesApi } from './contract';
import { KubernetesExtras } from './kubernetes';
import { AgentCredentials, IdentityApi } from './platform';

export const identitySecretName = 'akua-agent-identity';

type AgentId = typeof ids.clusterAgent.prefixedEffect.Type;

/** The agent's enrolled identity, resolved once per process. */
export class AgentIdentity extends Context.Service<
	AgentIdentity,
	{
		readonly agentId: AgentId;
		readonly key: AgentKey;
	}
>()('akua/cluster-agent/AgentIdentity') {}

export class IdentityUnavailable extends Schema.TaggedError<IdentityUnavailable>()(
	'IdentityUnavailable',
	{ message: Schema.String }
) {}

/**
 * Audience of every client assertion: the token endpoint, as RFC 7523
 * section 3 recommends. Identity must accept exactly this value.
 */
export const identityAudience = (platformOrigin: URL): string =>
	new URL('/v1/cluster_connectors/token', platformOrigin).href;

const decodeText = (value: string | undefined): string | null => {
	if (value === undefined) return null;
	const decoded = Base64.decodeString(value);
	return Result.isSuccess(decoded) && decoded.success.length > 0 ? decoded.success : null;
};

const encodeText = (value: string): string => Base64.encode(value);

const decodeAgentId = Schema.decodeUnknownOption(ids.clusterAgent.prefixedEffect);

interface StoredIdentity {
	readonly agentId: Option.Option<AgentId>;
	readonly key: Option.Option<AgentKey>;
}

const readStored = Effect.fnUntraced(function* () {
	const kubernetes = yield* KubernetesExtras;
	const secret = yield* kubernetes.readOwnSecret(identitySecretName);
	if (secret === null) {
		return yield* new IdentityUnavailable({
			message: `Secret ${identitySecretName} is missing; re-run the install command to recreate it`
		});
	}
	const data = secret.data ?? {};
	const agentId = Option.flatMap(Option.fromNullishOr(decodeText(data.agentId)), decodeAgentId);
	const rawKey = decodeText(data.privateKey);
	const key =
		rawKey === null
			? Option.none<AgentKey>()
			: yield* importAgentKey(Redacted.make(rawKey)).pipe(
					Effect.map(Option.some),
					Effect.catchTag('AgentKeyError', () => Effect.succeed(Option.none<AgentKey>()))
				);
	return { agentId, key } satisfies StoredIdentity;
});

/** Exponential from 2 s, capped at 5 minutes. */
export const retryForever = Schedule.min([
	Schedule.exponential('2 seconds'),
	Schedule.spaced('5 minutes')
]).pipe(Schedule.jittered);

/**
 * Loads the identity from its Secret, or enrolls. An intact Secret always
 * wins over a mounted code. The fresh key is written before the enroll
 * call, so a crash between enroll and the second write retries with the
 * same key rather than a new one.
 */
const enrollOrLoad = Effect.gen(function* () {
	const config = yield* AgentConfig;
	const kubernetes = yield* KubernetesApi;
	const extras = yield* KubernetesExtras;
	const identityApi = yield* IdentityApi;
	const stored = yield* readStored();
	if (Option.isSome(stored.agentId) && Option.isSome(stored.key)) {
		return { agentId: stored.agentId.value, key: stored.key.value };
	}
	const key = Option.isSome(stored.key) ? stored.key.value : yield* generateAgentKey();
	if (Option.isNone(stored.key)) {
		yield* extras.patchOwnSecretData(identitySecretName, {
			privateKey: encodeText(Redacted.value(key.serialized))
		});
	}
	const clusterUid = yield* kubernetes.readClusterUid();
	const now = yield* Clock.currentTimeMillis;
	const audience = identityAudience(config.platformOrigin);
	const enrollment = config.enrollment;
	let request: typeof EnrollRequest.Type;
	if (enrollment._tag === 'code') {
		if (enrollment.code === null) {
			return yield* new IdentityUnavailable({
				message: 'not enrolled and no enrollment code is mounted; re-run the install command'
			});
		}
		// No agent ID exists before a first code enrollment; the key's thumbprint names the signer.
		const signer = Option.getOrElse(stored.agentId, () => key.publicKey.kid);
		request = {
			_tag: 'code',
			code: enrollment.code,
			cluster_uid: clusterUid,
			public_key: key.publicKey,
			proof: yield* signAssertion({ key, agentId: signer, audience, nowMillis: now })
		};
	} else {
		const fs = yield* FileSystem.FileSystem;
		const token = yield* fs
			.readFileString(enrollment.tokenPath)
			.pipe(
				Effect.mapError(
					(cause) =>
						new IdentityUnavailable({ message: `projected token unreadable: ${cause.message}` })
				)
			);
		request = {
			_tag: 'federated',
			agent_id: enrollment.agentId,
			service_account_token: Redacted.make(token.trim()),
			cluster_uid: clusterUid,
			public_key: key.publicKey,
			proof: yield* signAssertion({
				key,
				agentId: enrollment.agentId,
				audience,
				nowMillis: now
			})
		};
	}
	const enrolled = yield* identityApi.enroll({ payload: request });
	yield* extras.patchOwnSecretData(identitySecretName, {
		agentId: encodeText(enrolled.agent_id),
		privateKey: encodeText(Redacted.value(key.serialized))
	});
	yield* Effect.logInfo('enrolled').pipe(Effect.annotateLogs({ agentId: enrolled.agent_id }));
	return { agentId: enrolled.agent_id, key };
});

/** The agent: enroll when needed, retrying until it succeeds; it is not ready before. */
export const agentIdentityLive = Layer.effect(
	AgentIdentity,
	enrollOrLoad.pipe(
		Effect.tapError((error) =>
			Effect.logWarning('enrollment pending').pipe(
				Effect.annotateLogs({
					reason: error._tag,
					message: 'message' in error ? error.message : ''
				})
			)
		),
		Effect.retry(retryForever),
		Effect.map((identity) => AgentIdentity.of(identity))
	)
);

/** The updater: the same identity, read only; it never enrolls. */
export const updaterIdentityLive = Layer.effect(
	AgentIdentity,
	Effect.gen(function* () {
		const stored = yield* readStored();
		if (Option.isNone(stored.agentId) || Option.isNone(stored.key)) {
			return yield* new IdentityUnavailable({ message: 'the agent has not enrolled yet' });
		}
		return AgentIdentity.of({ agentId: stored.agentId.value, key: stored.key.value });
	}).pipe(
		Effect.tapError((error) =>
			Effect.logWarning('agent identity not readable yet').pipe(
				Effect.annotateLogs({ reason: error._tag })
			)
		),
		Effect.retry(retryForever)
	)
);

/** Converts `expires_at` (seconds or milliseconds since the epoch) to milliseconds. */
const expiresAtMillis = (expiresAt: number): number =>
	expiresAt > 100_000_000_000 ? expiresAt : expiresAt * 1000;

/**
 * Exchanges a fresh client assertion for a WorkloadAssertion and caches it
 * until half its lifetime has passed. Failed exchanges are retried with
 * backoff; callers wait instead of sending an unauthenticated request.
 */
export const agentCredentialsLive = Layer.effect(
	AgentCredentials,
	Effect.gen(function* () {
		const platformOrigin = yield* PlatformOrigin;
		const identity = yield* AgentIdentity;
		const identityApi = yield* IdentityApi;
		const cache = yield* Ref.make(
			Option.none<{ readonly token: Redacted.Redacted<string>; readonly refreshAt: number }>()
		);
		const lock = yield* Semaphore.make(1);
		const audience = identityAudience(platformOrigin);

		const exchange = Effect.gen(function* () {
			const now = yield* Clock.currentTimeMillis;
			const assertion = yield* signAssertion({
				key: identity.key,
				agentId: identity.agentId,
				audience,
				nowMillis: now
			});
			const issued = yield* identityApi.token({ payload: { assertion } });
			const expiresAt = expiresAtMillis(issued.expires_at);
			const refreshAt = now + Math.max(5_000, (expiresAt - now) / 2);
			const token = Redacted.make(Redacted.value(issued.assertion));
			yield* Ref.set(cache, Option.some({ token, refreshAt }));
			return token;
		}).pipe(
			Effect.tapError((error) =>
				Effect.logWarning('token exchange failed').pipe(Effect.annotateLogs({ reason: error._tag }))
			),
			Effect.retry(
				Schedule.min([Schedule.exponential('500 millis'), Schedule.spaced('1 minute')]).pipe(
					Schedule.jittered
				)
			),
			// The schedule never ends; only a defect can escape.
			Effect.orDie
		);

		const accessToken = lock.withPermits(1)(
			Effect.gen(function* () {
				const cached = yield* Ref.get(cache);
				const now = yield* Clock.currentTimeMillis;
				if (Option.isSome(cached) && now < cached.value.refreshAt) return cached.value.token;
				return yield* exchange;
			})
		);

		return AgentCredentials.of({ accessToken, invalidate: Ref.set(cache, Option.none()) });
	})
);
