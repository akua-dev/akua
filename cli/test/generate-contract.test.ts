import { BunServices } from '@effect/platform-bun';
import { describe, expect, it } from '@effect/vitest';
import { Effect, FileSystem, Layer, Schema } from 'effect';

import {
	CONTRACT_OUTPUT_PATH,
	buildContract,
	generateContract,
	OpenApiDocument
} from '../scripts/generate-contract';
import { ScriptLive } from '../scripts/runtime/services-live';

/** Decodes like the generator does, then builds the contract. */
const contractOf = (spec: unknown) =>
	Schema.decodeUnknownEffect(OpenApiDocument)(spec).pipe(
		Effect.orDie,
		Effect.flatMap(buildContract)
	);

const error = {
	description: 'Error',
	content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiErrorResponse' } } }
};

const document = {
	security: [{ bearer: [] }],
	tags: [{ name: 'Clusters', description: 'Kubernetes clusters.' }],
	paths: {
		'/clusters/{id}:resume': {
			post: {
				'x-platform-visibility': 'PUBLIC',
				operationId: 'clusters.resume',
				tags: ['Clusters'],
				summary: 'Resume cluster',
				parameters: [
					{ name: 'if-match', in: 'header', required: true, schema: { type: 'string' } },
					{ name: 'id', in: 'path', required: true, schema: { type: 'string', example: 'clu_1' } }
				],
				responses: { '202': { description: 'Accepted' }, '404': error }
			}
		},
		'/clusters': {
			post: {
				'x-platform-visibility': 'PUBLIC',
				operationId: 'clusters.create',
				tags: ['Clusters'],
				summary: 'Create cluster',
				requestBody: {
					required: true,
					content: {
						'application/json': { schema: { $ref: '#/components/schemas/CreateCluster' } }
					}
				},
				responses: { '201': { description: 'Created' }, '422': error }
			},
			get: {
				'x-platform-visibility': 'INTERNAL',
				operationId: 'clusters.internalList',
				responses: { '200': { description: 'OK' } }
			}
		},
		'/offers:resolve': {
			get: {
				'x-platform-visibility': 'PUBLIC',
				operationId: 'offers.resolve',
				security: [{}],
				summary: 'Resolve offer',
				responses: { '200': { description: 'OK' } }
			}
		}
	},
	components: {
		schemas: {
			CreateCluster: {
				type: 'object',
				properties: {
					name: { type: 'string', 'x-platform-hint': 'drop me' },
					region: { $ref: '#/components/schemas/RegionId' }
				},
				required: ['name'],
				additionalProperties: false
			},
			RegionId: { type: 'string', examples: ['reg_1'] },
			ApiErrorResponse: { type: 'object' },
			Unreferenced: { type: 'string' }
		}
	}
};

describe('generated API contract', () => {
	it.effect('keeps public operations, sorted, with path parameters first in template order', () =>
		Effect.gen(function* () {
			const contract = yield* contractOf(document);

			expect(contract.operations.map((operation) => operation.id)).toEqual([
				'clusters.create',
				'clusters.resume',
				'offers.resolve'
			]);
			expect(contract.operations[1]).toMatchObject({
				method: 'POST',
				path: '/clusters/{id}:resume',
				auth: true,
				parameters: ['path:id', 'header:if-match']
			});
			expect(contract.resources).toEqual([
				{ name: 'clusters', title: 'Clusters', description: 'Kubernetes clusters.' },
				{ name: 'offers', title: 'offers' }
			]);
		})
	);

	it.effect('an empty security alternative makes an operation anonymous', () =>
		Effect.gen(function* () {
			const contract = yield* contractOf(document);
			expect(contract.operations.find((operation) => operation.id === 'offers.resolve')?.auth).toBe(
				false
			);
		})
	);

	it.effect(
		'carries only reachable definitions, rewritten to $defs, without examples or extensions',
		() =>
			Effect.gen(function* () {
				const contract = yield* contractOf(document);

				expect(contract.definitions).toEqual({
					CreateCluster: {
						type: 'object',
						properties: { name: { type: 'string' }, region: { $ref: '#/$defs/RegionId' } },
						required: ['name'],
						additionalProperties: false
					},
					RegionId: { type: 'string' }
				});
				expect(contract.parameters['path:id']).toEqual({
					name: 'id',
					in: 'path',
					required: true,
					schema: { type: 'string' }
				});
			})
	);

	it.effect('fails on a public operation without an operationId', () =>
		Effect.gen(function* () {
			const failure = yield* contractOf({
				...document,
				paths: { '/x': { get: { 'x-platform-visibility': 'PUBLIC', responses: {} } } }
			}).pipe(Effect.flip);
			expect(failure.message).toBe('Public operation GET /x has no operationId');
		})
	);

	it.effect('fails on request bodies the CLI cannot send', () =>
		Effect.gen(function* () {
			const failure = yield* contractOf({
				...document,
				paths: {
					'/upload': {
						post: {
							'x-platform-visibility': 'PUBLIC',
							operationId: 'files.upload',
							requestBody: { content: { 'multipart/form-data': { schema: {} } } },
							responses: {}
						}
					}
				}
			}).pipe(Effect.flip);
			expect(failure.message).toBe(
				'files.upload: request body must be application/json only, found multipart/form-data'
			);
		})
	);

	it.effect('the committed contract is what the public OpenAPI document generates', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const generated = yield* generateContract();
			expect(generated).toBe(yield* fs.readFileString(CONTRACT_OUTPUT_PATH));
		}).pipe(
			Effect.provide(
				Layer.mergeAll(ScriptLive, BunServices.layer).pipe(Layer.provide(BunServices.layer))
			)
		)
	);
});
