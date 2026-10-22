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
				'files.upload: request body must be application/json or application/octet-stream only, found multipart/form-data'
			);
		})
	);

	it.effect('represents raw byte bodies, byte responses, and NDJSON streams', () =>
		Effect.gen(function* () {
			const bytes = (media: string) => ({
				[media]: { schema: { type: 'string', format: 'binary' } }
			});
			const contract = yield* contractOf({
				...document,
				paths: {
					'/files:write': {
						post: {
							'x-platform-visibility': 'PUBLIC',
							operationId: 'files.write',
							requestBody: { required: true, content: bytes('application/octet-stream') },
							responses: { '200': { description: 'OK' } }
						}
					},
					'/files:read': {
						post: {
							'x-platform-visibility': 'PUBLIC',
							operationId: 'files.read',
							requestBody: {
								content: { 'application/json': { schema: { type: 'object' } } }
							},
							responses: {
								'200': {
									description: 'OK',
									content: {
										'application/octet-stream': {
											...bytes('application/octet-stream')['application/octet-stream'],
											'x-effect-stream': { encoding: 'uint8array' }
										}
									}
								},
								'404': error
							}
						}
					},
					'/files/logs': {
						get: {
							'x-platform-visibility': 'PUBLIC',
							operationId: 'files.logs',
							responses: {
								'200': {
									description: 'OK',
									content: {
										'application/x-ndjson': {
											...bytes('application/x-ndjson')['application/x-ndjson'],
											'x-effect-stream': { encoding: 'uint8array' }
										}
									}
								}
							}
						}
					}
				}
			});
			const byId = (id: string) => contract.operations.find((operation) => operation.id === id);

			expect(byId('files.write')).toMatchObject({ upload: { required: true } });
			expect(byId('files.write')?.body).toBeUndefined();
			expect(byId('files.read')).toMatchObject({ download: true });
			expect(byId('files.read')?.upload).toBeUndefined();
			expect(byId('files.read')?.body).toBeDefined();
			expect(byId('files.logs')).toMatchObject({ lines: true });
			expect(byId('files.logs')?.stream).toBeUndefined();
		})
	);

	it.effect('fails on a success response that is neither JSON, SSE, bytes, nor NDJSON', () =>
		Effect.gen(function* () {
			const failure = yield* contractOf({
				...document,
				paths: {
					'/page': {
						get: {
							'x-platform-visibility': 'PUBLIC',
							operationId: 'pages.get',
							responses: { '200': { description: 'OK', content: { 'text/html': { schema: {} } } } }
						}
					}
				}
			}).pipe(Effect.flip);
			expect(failure.message).toBe(
				'pages.get: 200 text/html success response is not representable'
			);
		})
	);

	it.effect(
		'the public OpenAPI snapshot keeps preview cleanup but does not advertise unfinished creation',
		() =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const document = yield* fs
					.readFileString('src/generated/openapi-public.json')
					.pipe(Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(OpenApiDocument))));
				const ids = Object.values(document.paths).flatMap((path) =>
					Object.values(path).flatMap((operation) => operation?.operationId ?? [])
				);
				expect(ids).not.toContain('sandboxes.exposePort');
				expect(ids).not.toContain('sandboxes.rotatePreviewToken');
				expect(ids).toContain('sandboxes.listPreviews');
				expect(ids).toContain('sandboxes.unexposePort');
			}).pipe(Effect.provide(BunServices.layer))
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
