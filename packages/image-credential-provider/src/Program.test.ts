import { expect, it } from '@effect/vitest';
import { Cause, ConfigProvider, Effect, Result, Sink, Stream } from 'effect';
import * as Stdio from 'effect/Stdio';
import { Base64Url } from 'effect/encoding';
import { credentialProviderProgram } from './Program';

const execute = Effect.fnUntraced(function* (
	input: string,
	env: Record<string, string> = { AKUA_IMAGE_REGISTRY: 'pkg.akua.dev' },
	stdin = Stream.make(new TextEncoder().encode(input)),
	overrides: Partial<Stdio.Stdio> = {}
) {
	const stdout: Array<string> = [];
	const stderr: Array<string> = [];
	const text = (value: string | Uint8Array) =>
		typeof value === 'string' ? value : new TextDecoder().decode(value);
	const result = yield* credentialProviderProgram.pipe(
		Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(env))),
		Effect.provide(
			Stdio.layerTest({
				stdin,
				stdout: () =>
					Sink.forEach((value) =>
						Effect.sync(() => {
							stdout.push(text(value));
						})
					),
				stderr: () =>
					Sink.forEach((value) =>
						Effect.sync(() => {
							stderr.push(text(value));
						})
					),
				...overrides
			})
		),
		Effect.exit
	);
	return { result, stdout: stdout.join(''), stderr: stderr.join('') };
});
const password = `e30.${Base64Url.encode(JSON.stringify({ exp: 60 }))}.fixture`;

it.effect('writes exactly one kubelet response to stdout and never logs the token', () =>
	Effect.gen(function* () {
		const result = yield* execute(
			JSON.stringify({
				kind: 'CredentialProviderRequest',
				apiVersion: 'credentialprovider.kubelet.k8s.io/v1',
				image: 'pkg.akua.dev/ws_builder/images/rup_1/builder/app:v1',
				serviceAccountToken: password
			})
		);
		expect(result.result._tag).toBe('Success');
		expect(result.stdout.trim().split('\n')).toHaveLength(1);
		expect(result.stdout).toContain('"kind":"CredentialProviderResponse"');
		expect(result.stdout).toContain(password);
		expect(result.stderr).toBe('');
	})
);

it.effect('emits classified diagnostics without exposing invalid or oversized input', () =>
	Effect.gen(function* () {
		for (const [input, message] of [
			[`invalid:${password}`, 'Invalid kubelet credential request'],
			['x'.repeat(65537), 'Credential request is too large']
		] as const) {
			const result = yield* execute(input);
			expect(result.result._tag).toBe('Failure');
			expect(result.stdout).toBe('');
			expect(result.stderr).not.toContain(password);
			expect(result.stderr).not.toContain(input);
			expect(JSON.parse(result.stderr)).toEqual({ error: message });
		}
	})
);

it.effect('answers nothing without a valid configured registry', () =>
	Effect.gen(function* () {
		for (const env of [{}, { AKUA_IMAGE_REGISTRY: 'pkg.akua.dev/path' }]) {
			const result = yield* execute(
				JSON.stringify({
					kind: 'CredentialProviderRequest',
					apiVersion: 'credentialprovider.kubelet.k8s.io/v1',
					image: 'pkg.akua.dev/ws_builder/images/rup_1/builder/app:v1',
					serviceAccountToken: password
				}),
				env
			);
			expect(result.result._tag).toBe('Failure');
			expect(result.stdout).toBe('');
			expect(result.stderr).not.toContain(password);
			expect(JSON.parse(result.stderr)).toEqual({
				error: 'Invalid image credential registry configuration'
			});
		}
	})
);

it.effect('preserves unexpected defects internally but never prints their request or token', () =>
	Effect.gen(function* () {
		const defect = new Error(`request-body:${password}`);
		const result = yield* execute('', undefined, Stream.die(defect));
		expect(result.stderr).toBe('{"error":"Unexpected image credential provider failure"}\n');
		expect(result.stdout).toBe('');
		if (result.result._tag !== 'Failure') return yield* Effect.die('Expected failure');
		const error = Cause.findError(result.result.cause);
		expect(Result.isSuccess(error)).toBe(true);
		if (!Result.isSuccess(error)) return yield* Effect.die('Expected typed failure');
		expect(Cause.isCause(error.success.cause)).toBe(true);
		if (!Cause.isCause(error.success.cause)) return yield* Effect.die('Expected original Cause');
		expect(Cause.findDefect(error.success.cause)).toEqual(Result.succeed(defect));
	})
);

it.effect('retains the request failure even when writing its public diagnostic fails', () =>
	Effect.gen(function* () {
		const defect = new Error('stderr unavailable');
		const result = yield* execute('invalid request', undefined, undefined, {
			stderr: () => Sink.die(defect)
		});
		if (result.result._tag !== 'Failure') return yield* Effect.die('Expected failure');
		expect(Cause.findDefect(result.result.cause)).toEqual(Result.succeed(defect));
		const failure = Cause.findError(result.result.cause);
		if (!Result.isSuccess(failure)) return yield* Effect.die('Expected request failure');
		expect(failure.success.message).toBe('Invalid kubelet credential request');
		expect(failure.success.cause).toBeDefined();
		expect(result.stdout).toBe('');
	})
);
