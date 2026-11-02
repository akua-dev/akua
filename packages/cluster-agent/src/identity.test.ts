import { assert, describe, it } from '@effect/vitest';
import { Effect, FileSystem, Layer, Redacted, Ref } from 'effect';
import { Base64, Base64Url } from 'effect/encoding';
import { AgentConfig, type AgentSettings, PlatformOrigin } from './config';
import {
	agentCredentialsLive,
	agentIdentityLive,
	AgentIdentity,
	identityAudience
} from './identity';
import { AgentApi, AgentCredentials } from './platform';
import { FakeKubernetes, fakeKubernetesLayer } from './testing/fake-kubernetes';
import {
	FakePlatform,
	fakeAgentApi,
	fakeAgentId,
	fakePlatformCore,
	fakePlatformState
} from './testing/fake-platform';
import { testEnrollmentCode, testSettings } from './testing/settings';

const layerFor = (settings: AgentSettings, kubernetes = fakeKubernetesLayer()) => {
	const base = Layer.mergeAll(
		Layer.succeed(AgentConfig, AgentConfig.of(settings)),
		Layer.succeed(PlatformOrigin, settings.platformOrigin),
		kubernetes,
		FileSystem.layerNoop({}),
		fakePlatformCore(fakePlatformState({ enrollmentCode: testEnrollmentCode }))
	);
	return fakeAgentApi.pipe(
		Layer.provideMerge(agentCredentialsLive),
		Layer.provideMerge(agentIdentityLive),
		Layer.provideMerge(base)
	);
};

const decodeJwt = (token: string) => {
	const [header, claims] = token.split('.');
	const decode = (part: string | undefined) => {
		const result = Base64Url.decodeString(part ?? '');
		return result._tag === 'Success' ? JSON.parse(result.success) : null;
	};
	return { header: decode(header), claims: decode(claims) };
};

describe('AgentIdentity', () => {
	it.effect(
		'enrolls with the mounted code and stores agent ID and key in the identity Secret',
		() =>
			Effect.gen(function* () {
				const identity = yield* AgentIdentity;
				assert.strictEqual(identity.agentId, fakeAgentId);
				const platform = yield* FakePlatform;
				const state = yield* Ref.get(platform.state);
				assert.strictEqual(state.enrollments.length, 1);
				const request = state.enrollments[0];
				assert.strictEqual(request?._tag, 'code');
				if (request?._tag !== 'code') return;
				assert.strictEqual(request.public_key.kty, 'OKP');
				assert.isFalse('d' in request.public_key);
				assert.strictEqual(request.cluster_uid, '6f1c1b0e-2f4b-4b7a-9d0e-0c6b1f2a3d4e');
				const proof = decodeJwt(Redacted.value(request.proof));
				assert.strictEqual(proof.header.alg, 'EdDSA');
				assert.strictEqual(proof.header.kid, request.public_key.kid);
				assert.strictEqual(proof.claims.aud, identityAudience(new URL('https://api.akua.test')));
				assert.isAtMost(proof.claims.exp - proof.claims.iat, 60);

				const kubernetes = yield* FakeKubernetes;
				const secret = (yield* Ref.get(kubernetes.state)).secrets.get(
					'akua-system/akua-agent-identity'
				);
				const agentId = Base64.decodeString(secret?.data?.agentId ?? '');
				assert.strictEqual(agentId._tag === 'Success' ? agentId.success : '', fakeAgentId);
				assert.isDefined(secret?.data?.privateKey);
			}).pipe(Effect.provide(layerFor(testSettings())))
	);

	it.effect('keeps an intact identity Secret and never uses the code again', () =>
		Effect.gen(function* () {
			// First process enrolls and writes the Secret.
			const kubernetes = yield* FakeKubernetes;
			const stored = yield* Ref.get(kubernetes.state);
			const second = yield* Effect.gen(function* () {
				const identity = yield* AgentIdentity;
				const platform = yield* FakePlatform;
				return { identity, enrollments: (yield* Ref.get(platform.state)).enrollments.length };
			}).pipe(Effect.provide(layerFor(testSettings(), fakeKubernetesLayer(stored))));
			assert.strictEqual(second.identity.agentId, fakeAgentId);
			assert.strictEqual(second.enrollments, 0);
		}).pipe(Effect.provide(layerFor(testSettings())))
	);

	it.effect('exchanges a client assertion once and caches the access token', () =>
		Effect.gen(function* () {
			const credentials = yield* AgentCredentials;
			const first = yield* credentials.accessToken;
			const second = yield* credentials.accessToken;
			assert.strictEqual(Redacted.value(first), Redacted.value(second));
			const platform = yield* FakePlatform;
			assert.strictEqual((yield* Ref.get(platform.state)).tokensIssued, 1);
			const api = yield* AgentApi;
			const desired = yield* api.desiredState();
			assert.strictEqual(desired.revision, 0);
		}).pipe(Effect.provide(layerFor(testSettings())))
	);
});
