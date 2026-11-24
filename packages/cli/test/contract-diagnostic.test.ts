import { expect, it } from '@effect/vitest';
import { ConfigProvider, Effect, Fiber, Schema } from 'effect';
import { HttpClient, HttpClientResponse } from 'effect/http';
import { TestClock } from 'effect/testing';

import { buildContract, OpenApiDocument } from '../scripts/generate-contract';
import { OperationFailure } from '../src/api/failure';
import { diagnoseContractFailure } from '../src/cli/contract-diagnostic';
import { operationContext } from '../src/cli/operation-context';
import { operationError, toCliFailure } from '../src/cli/operation-errors';
import { runAkua, temporaryHome, writeConfigFile } from './fake-api';

const upgrade = 'Your akua CLI is older than the API. Update it with `akua update`.';

const document = (maxLength: number, includeKind = false) => ({
	openapi: '3.1.0',
	info: { title: 'Fixture API', version: '1.0.0' },
	paths: {
		'/things': {
			post: {
				operationId: 'things.create',
				'x-platform-visibility': 'PUBLIC',
				security: [{ bearer: [] }],
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								properties: {
									name: { type: 'string', maxLength },
									...(includeKind ? { kind: { type: 'string', enum: ['hosted'] } } : {})
								},
								required: ['name'],
								additionalProperties: false
							}
						}
					}
				},
				responses: { '200': { content: { 'application/json': { schema: { type: 'object' } } } } }
			}
		}
	},
	components: { schemas: {} }
});

const contractOf = (maxLength: number) =>
	Schema.decodeUnknownEffect(OpenApiDocument)(document(maxLength)).pipe(
		Effect.flatMap(buildContract)
	);

const rejection = {
	_tag: 'Validation',
	success: false,
	errors: [{ code: 7001, message: 'Original shape error', path: ['body', 'name'] }],
	result: {}
};

it.effect.each(['business', 'discovery-unavailable', 'upgrade'] as const)(
	'retains the original operation through %s diagnosis without exposing its cause',
	(mode) =>
		Effect.gen(function* () {
			const contract = yield* contractOf(3);
			const operation = yield* Effect.fromNullishOr(contract.operations[0]);
			const context = operationContext(contract, operation);
			const original = new OperationFailure({
				operationId: operation.id,
				reason: mode === 'business' ? 'api' : 'input',
				...(mode === 'business' ? { status: 500 } : { issues: [] }),
				cause: new Error('private-operation-canary')
			});
			const error = yield* diagnoseContractFailure(
				context,
				{ body: { name: 'long-name' } },
				original
			).pipe(
				Effect.provideService(
					HttpClient.HttpClient,
					HttpClient.make((request) =>
						Effect.succeed(
							HttpClientResponse.fromWeb(
								request,
								mode === 'discovery-unavailable'
									? Response.json({}, { status: 503 })
									: Response.json(document(100))
							)
						)
					)
				),
				Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({})))
			);
			expect(error.code).toBe(mode === 'business' ? 'AKUA_API_ERROR' : 'AKUA_INPUT_INVALID');
			expect(error.nextSteps.some(({ command }) => command === 'akua update')).toBe(
				mode === 'upgrade'
			);
			expect(error.cause).toBe(original);
			expect(operationError(original, context).cause).toBe(original);
			expect(toCliFailure(context)(original).cause).toBe(original);
			expect(JSON.stringify(error.toPayload())).not.toContain('private-operation-canary');
			expect(JSON.stringify(error)).not.toContain('"cause"');
			expect(Object.getOwnPropertyDescriptor(error, 'cause')?.enumerable).toBe(false);
		})
);

it.effect('keeps a server shape error and adds the upgrade hint when contracts differ', () =>
	Effect.gen(function* () {
		const home = yield* temporaryHome;
		yield* writeConfigFile(home, { token: 'fixture-secret' });
		const result = yield* runAkua(['things', 'create', '--name', 'long-name', '--json'], {
			contract: yield* contractOf(100),
			env: { HOME: home, AKUA_API_URL: 'https://selected.example.test/v1' },
			api: (request) =>
				request.url.pathname === '/openapi.json'
					? { body: document(3) }
					: { status: 400, body: rejection }
		});
		expect(result.exitCode).toBe(1);
		const error = JSON.parse(result.stdout).error;
		expect(error).toMatchObject({
			code: 'AKUA_API_7001',
			message: 'Original shape error',
			response: rejection
		});
		expect(result.stdout).toContain(upgrade);
		expect(error.next_steps).toContainEqual({ command: 'akua update', description: upgrade });
		expect(result.requests.map((request) => request.url.href)).toEqual([
			'https://selected.example.test/v1/things',
			'https://selected.example.test/openapi.json'
		]);
		expect(result.requests[1]?.headers.authorization).toBeUndefined();
		expect(result.stdout + result.stderr).not.toContain('fixture-secret');
	}).pipe(Effect.scoped)
);

it.effect(
	'diagnoses stale local validation without dispatching input accepted by the live contract',
	() =>
		Effect.gen(function* () {
			const result = yield* runAkua(
				['things', 'create', '--name', 'long-name', '--output', 'human'],
				{
					contract: yield* contractOf(3),
					api: () => ({ body: document(100) })
				}
			);
			expect(result.exitCode).toBe(2);
			expect(result.stdout).toContain('Invalid input for akua things create');
			expect(result.stdout).toContain(upgrade);
			expect(result.requests.map((request) => [request.method, request.url.pathname])).toEqual([
				['GET', '/openapi.json']
			]);
			expect(result.requests[0]?.body).toBeUndefined();
		}).pipe(Effect.scoped)
);

it.effect('recognizes a newly supported body field in --input without sending its values', () =>
	Effect.gen(function* () {
		const result = yield* runAkua(['things', 'create', '--input', '-', '--json'], {
			contract: yield* contractOf(100),
			inputs: { '-': '{"body":{"name":"fixture-private-name","kind":"hosted"}}' },
			api: () => ({ body: document(100, true) })
		});
		expect(result.exitCode).toBe(2);
		expect(JSON.parse(result.stdout).error.code).toBe('AKUA_INPUT_INVALID');
		expect(result.stdout).toContain(upgrade);
		expect(result.stdout + result.stderr).not.toContain('fixture-private-name');
		expect(result.stdout + result.stderr).not.toContain('hosted');
		expect(result.requests.map(({ method, url, body }) => [method, url.href, body])).toEqual([
			['GET', 'https://api.akua.dev/openapi.json', undefined]
		]);
	})
);

it.effect('does not suggest an upgrade for identical contracts with reordered JSON keys', () =>
	Effect.gen(function* () {
		const home = yield* temporaryHome;
		yield* writeConfigFile(home, { token: 'fixture-secret' });
		const live = document(100);
		live.paths['/things'].post.requestBody.content['application/json'].schema.properties.name = {
			maxLength: 100,
			type: 'string'
		};
		const result = yield* runAkua(['things', 'create', '--name', 'long-name', '--json'], {
			contract: yield* contractOf(100),
			env: { HOME: home },
			api: (request) =>
				request.url.pathname === '/openapi.json' ? { body: live } : { status: 400, body: rejection }
		});
		expect(result.exitCode).toBe(1);
		expect(JSON.parse(result.stdout).error.response).toEqual(rejection);
		expect(result.stdout).not.toContain(upgrade);
		expect(result.requests).toHaveLength(2);
	}).pipe(Effect.scoped)
);

it.effect('does not blame the version when the live contract also rejects the local input', () =>
	Effect.gen(function* () {
		const result = yield* runAkua(['things', 'create', '--name', 'long-name', '--json'], {
			contract: yield* contractOf(3),
			api: () => ({ body: document(4) })
		});
		expect(result.exitCode).toBe(2);
		expect(JSON.parse(result.stdout).error.code).toBe('AKUA_INPUT_INVALID');
		expect(result.stdout).not.toContain(upgrade);
		expect(result.requests.map(({ method, url }) => [method, url.pathname])).toEqual([
			['GET', '/openapi.json']
		]);
	})
);

it.effect('preserves the original error when discovery is unavailable or invalid', () =>
	Effect.gen(function* () {
		const contract = yield* contractOf(3);
		for (const response of [
			{ status: 503, body: { message: 'fixture-secret' } },
			{ text: 'not json fixture-secret' },
			{ body: null },
			{ body: { openapi: 'unknown', fixture: 'fixture-secret' } },
			{ body: { paths: {}, components: { schemas: {} } } }
		]) {
			const result = yield* runAkua(['things', 'create', '--name', 'long-name', '--json'], {
				contract,
				api: () => response
			});
			expect(result.exitCode).toBe(2);
			expect(JSON.parse(result.stdout).error.code).toBe('AKUA_INPUT_INVALID');
			expect(result.stdout).not.toContain(upgrade);
			expect(result.stdout + result.stderr).not.toContain('fixture-secret');
			expect(result.requests).toHaveLength(1);
		}
	})
);

it.effect(
	'never fetches discovery for success, auth, business errors, or other HTTP failures',
	() =>
		Effect.gen(function* () {
			const home = yield* temporaryHome;
			yield* writeConfigFile(home, { token: 'fixture-secret' });
			const contract = yield* contractOf(100);
			for (const response of [
				{ status: 200, body: { id: 'thing_fixture' } },
				...[401, 403, 404, 409, 422, 500].map((status) => ({ status, body: rejection })),
				{ status: 400, body: { errors: [{ code: 7001, message: 'Business rule' }] } },
				{ status: 400, body: { errors: [{ code: 7004, path: ['body', 'name'] }] } }
			]) {
				const result = yield* runAkua(['things', 'create', '--name', 'long-name', '--json'], {
					contract,
					env: { HOME: home },
					api: () => response
				});
				expect(result.exitCode === 0).toBe(response.status === 200);
				expect(result.stdout).not.toContain(upgrade);
				expect(result.requests.map(({ method, url }) => [method, url.pathname])).toEqual([
					['POST', '/v1/things']
				]);
			}
			const help = yield* runAkua(['things', 'create', '--help'], { contract });
			expect(help.exitCode).toBe(0);
			expect(help.requests).toEqual([]);
		}).pipe(Effect.scoped)
);

it.effect('bounds a stalled discovery request and still returns the original error', () =>
	Effect.gen(function* () {
		const contract = yield* contractOf(3);
		const operation = yield* Effect.fromNullishOr(contract.operations[0]);
		const program = diagnoseContractFailure(
			operationContext(contract, operation),
			{ body: { name: 'long-name' } },
			new OperationFailure({ operationId: operation.id, reason: 'input', issues: [] })
		).pipe(
			Effect.provideService(
				HttpClient.HttpClient,
				HttpClient.make(() => Effect.never)
			),
			Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({})))
		);
		const fiber = yield* program.pipe(Effect.forkChild);
		yield* TestClock.adjust('2 seconds');
		const error = yield* Fiber.join(fiber);
		expect(error._tag).toBe('AkuaCliError');
		expect(error).toMatchObject({ code: 'AKUA_INPUT_INVALID', exitCode: 2 });
		expect(JSON.stringify(error)).not.toContain(upgrade);
	})
);
