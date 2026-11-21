import { expect, it } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import { Base64Url } from 'effect/encoding';
import { TestClock } from 'effect/testing';
import { provideCredential } from './CredentialProvider';

const token = (exp: number) => `e30.${Base64Url.encode(JSON.stringify({ exp }))}.fixture`;
const request = (
	serviceAccountToken: string,
	image = 'pkg.akua.dev/ws_builder/images/rup_1/builder/app:v1'
) =>
	JSON.stringify({
		apiVersion: 'credentialprovider.kubelet.k8s.io/v1',
		kind: 'CredentialProviderRequest',
		image,
		serviceAccountToken
	});
const Response = Schema.Struct({
	apiVersion: Schema.Literal('credentialprovider.kubelet.k8s.io/v1'),
	kind: Schema.Literal('CredentialProviderResponse'),
	cacheKeyType: Schema.Literal('Registry'),
	cacheDuration: Schema.String,
	auth: Schema.Record(
		Schema.String,
		Schema.Struct({ username: Schema.String, password: Schema.String })
	)
});
const registry = 'pkg.akua.dev';
const decoded = (input: string) =>
	provideCredential(input, registry).pipe(
		Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Response)))
	);

it.effect('rejects a misspelled kubelet request field rather than silently discarding it', () =>
	Effect.gen(function* () {
		const result = yield* provideCredential(
			JSON.stringify({
				apiVersion: 'credentialprovider.kubelet.k8s.io/v1',
				kind: 'CredentialProviderRequest',
				image: `${registry}/builder/app:v1`,
				serviceAccountToken: token(60),
				serviceAccountAnnotatons: {}
			}),
			registry
		).pipe(Effect.result);
		expect(result._tag).toBe('Failure');
	})
);

it.effect(
	'passes the Pod token through as the registry password, cached only for its remaining lifetime',
	() =>
		Effect.gen(function* () {
			yield* TestClock.adjust(12_345);
			const password = token(60);
			const response = yield* decoded(request(password));
			expect(response.cacheDuration).toBe('47s');
			expect(response.auth).toEqual({ 'pkg.akua.dev': { username: 'akua-workload', password } });
		})
);

it.effect('answers for the configured stage registry, keyed by its host', () =>
	Effect.gen(function* () {
		const password = token(60);
		const response = yield* provideCredential(
			request(password, 'pkg-preview.akua.dev/ws_builder/images/rup_1/app:v1'),
			'pkg-preview.akua.dev'
		).pipe(Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Response))));
		expect(response.auth).toEqual({
			'pkg-preview.akua.dev': { username: 'akua-workload', password }
		});
	})
);

it.effect('never returns credentials for another registry or a lookalike hostname', () =>
	Effect.gen(function* () {
		for (const image of [
			'ghcr.io/builder/app:v1',
			'pkg.akua.dev.evil.test/builder/app:v1',
			'pkg.akua.dev:443/builder/app:v1',
			'pkg.akua.dev'
		]) {
			const response = yield* decoded(request(token(60), image));
			expect(response.auth).toEqual({});
			expect(response.cacheDuration).toBe('0s');
		}
	})
);

it.effect(
	'fails closed for missing, malformed or expired tokens with a secret-free public message',
	() =>
		Effect.gen(function* () {
			yield* TestClock.adjust(60_000);
			for (const password of ['', 'sensitive-malformed-token', token(59), token(60)]) {
				const error = yield* provideCredential(request(password), registry).pipe(Effect.flip);
				expect(error._tag).toBe('CredentialProviderFailure');
				if (password !== '') expect(error.message).not.toContain(password);
			}
			const error = yield* provideCredential('not JSON: sensitive-input', registry).pipe(
				Effect.flip
			);
			expect(error.message).not.toContain('sensitive-input');
			expect(error.cause).toBeDefined();
		})
);
