import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';

import {
	type FakeApi,
	readConfigFile,
	type RecordedRequest,
	runAkua,
	temporaryHome,
	writeConfigFile
} from './fake-api';

const TOKEN = 'test-token';

const workspaces = {
	data: [
		{ id: 'ws_team', name: 'My Team', slug: 'my-team', created_at: 1790000000 },
		{ id: 'ws_other', name: 'Other', slug: 'other', created_at: 1790000100 }
	],
	has_more: false,
	next_cursor: null
};

const clusterList = { data: [], has_more: false, next_cursor: null };

/** Lists workspaces and clusters; everything else is 404. */
const api: FakeApi = (request) => {
	if (request.method === 'GET' && request.url.pathname === '/v1/workspaces') {
		return { body: workspaces };
	}
	if (request.method === 'GET' && request.url.pathname === '/v1/clusters') {
		return { body: clusterList };
	}
	if (request.method === 'POST' && request.url.pathname === '/v1/clusters') {
		return {
			status: 202,
			body: { id: 'op_123', state: 'RUNNING', done: false, metadata: { type: 'cluster.create' } }
		};
	}
	return {
		status: 404,
		body: { success: false, errors: [{ code: 7003, message: 'Resource not found' }], result: {} }
	};
};

const contextHeader = (requests: readonly RecordedRequest[], path: string) =>
	requests.find((request) => request.url.pathname === path)?.headers['akua-context'];

describe('workspace context', () => {
	it.effect('the --workspace flag wins over AKUA_WORKSPACE and the saved workspace', () =>
		Effect.gen(function* () {
			const home = yield* temporaryHome;
			yield* writeConfigFile(home, { token: TOKEN, workspace: { id: 'ws_saved', name: 'Saved' } });

			const result = yield* runAkua(['clusters', 'list', '--workspace', 'ws_flag', '--json'], {
				env: { HOME: home, AKUA_WORKSPACE: 'ws_env' },
				api
			});

			expect(result.exitCode).toBe(0);
			expect(contextHeader(result.requests, '/v1/clusters')).toBe('ws_flag');
		}).pipe(Effect.scoped)
	);

	it.effect('AKUA_WORKSPACE wins over the saved workspace', () =>
		Effect.gen(function* () {
			const home = yield* temporaryHome;
			yield* writeConfigFile(home, { token: TOKEN, workspace: { id: 'ws_saved', name: 'Saved' } });

			const result = yield* runAkua(['clusters', 'list', '--json'], {
				env: { HOME: home, AKUA_WORKSPACE: 'ws_env' },
				api
			});

			expect(contextHeader(result.requests, '/v1/clusters')).toBe('ws_env');
		}).pipe(Effect.scoped)
	);

	it.effect('the saved workspace applies when neither flag nor environment names one', () =>
		Effect.gen(function* () {
			const home = yield* temporaryHome;
			yield* writeConfigFile(home, { token: TOKEN, workspace: { id: 'ws_saved', name: 'Saved' } });

			const result = yield* runAkua(['clusters', 'list', '--json'], { env: { HOME: home }, api });

			expect(contextHeader(result.requests, '/v1/clusters')).toBe('ws_saved');
		}).pipe(Effect.scoped)
	);

	it.effect('an akua-context header in --input beats the environment, but not --workspace', () =>
		Effect.gen(function* () {
			const home = yield* temporaryHome;
			yield* writeConfigFile(home, { token: TOKEN, workspace: { id: 'ws_saved' } });

			const result = yield* runAkua(['clusters', 'list', '--input', '-', '--json'], {
				env: { HOME: home },
				inputs: { '-': '{"headers":{"akua-context":"ws_input"}}' },
				api
			});

			expect(contextHeader(result.requests, '/v1/clusters')).toBe('ws_input');

			const flagged = yield* runAkua(
				['clusters', 'list', '--input', '-', '-w', 'ws_flag', '--json'],
				{
					env: { HOME: home },
					inputs: { '-': '{"headers":{"akua-context":"ws_input"}}' },
					api
				}
			);
			expect(contextHeader(flagged.requests, '/v1/clusters')).toBe('ws_flag');
		}).pipe(Effect.scoped)
	);

	it.effect('a workspace slug or name resolves to its ID before the request', () =>
		Effect.gen(function* () {
			const home = yield* temporaryHome;
			yield* writeConfigFile(home, { token: TOKEN });

			const bySlug = yield* runAkua(['clusters', 'list', '-w', 'my-team', '--json'], {
				env: { HOME: home },
				api
			});
			const byName = yield* runAkua(['clusters', 'list', '--json'], {
				env: { HOME: home, AKUA_WORKSPACE: 'my team' },
				api
			});

			expect(contextHeader(bySlug.requests, '/v1/clusters')).toBe('ws_team');
			expect(contextHeader(byName.requests, '/v1/clusters')).toBe('ws_team');
		}).pipe(Effect.scoped)
	);

	it.effect(
		'without any workspace no context header is sent and the error says how to pick one',
		() =>
			Effect.gen(function* () {
				const home = yield* temporaryHome;
				yield* writeConfigFile(home, { token: TOKEN });

				const result = yield* runAkua(['clusters', 'list', '--json'], {
					env: { HOME: home },
					api: () => ({
						status: 403,
						body: {
							success: false,
							errors: [{ code: 7004, message: 'Akua-Context header is required' }],
							result: {}
						}
					})
				});

				expect(contextHeader(result.requests, '/v1/clusters')).toBeUndefined();
				expect(result.exitCode).toBe(1);
				const output = JSON.parse(result.stdout);
				expect(output.error.code).toBe('AKUA_API_7004');
				expect(output.error.next_steps.map((step: { command: string }) => step.command)).toEqual([
					'akua workspaces list',
					'akua workspaces use <name>',
					'akua clusters list --workspace <name>'
				]);
			}).pipe(Effect.scoped)
	);
});

describe('akua workspaces use', () => {
	it.effect('saves the resolved workspace and keeps the token and unknown keys', () =>
		Effect.gen(function* () {
			const home = yield* temporaryHome;
			yield* writeConfigFile(home, { token: TOKEN, future_key: true });

			const result = yield* runAkua(['workspaces', 'use', 'my-team', '--json'], {
				env: { HOME: home },
				api
			});

			expect(result.exitCode).toBe(0);
			expect(yield* readConfigFile(home)).toEqual({
				token: TOKEN,
				future_key: true,
				workspace: { id: 'ws_team', name: 'My Team' }
			});
			const later = yield* runAkua(['clusters', 'list', '--json'], { env: { HOME: home }, api });
			expect(contextHeader(later.requests, '/v1/clusters')).toBe('ws_team');
		}).pipe(Effect.scoped)
	);

	it.effect('answers to `akua workspace switch` and `--clear` forgets the workspace', () =>
		Effect.gen(function* () {
			const home = yield* temporaryHome;
			yield* writeConfigFile(home, { token: TOKEN });

			yield* runAkua(['workspace', 'switch', 'ws_other', '--json'], { env: { HOME: home }, api });
			expect((yield* readConfigFile(home)).workspace).toEqual({ id: 'ws_other', name: 'Other' });

			const cleared = yield* runAkua(['workspaces', 'use', '--clear', '--json'], {
				env: { HOME: home },
				api
			});
			expect(cleared.exitCode).toBe(0);
			expect(yield* readConfigFile(home)).toEqual({ token: TOKEN });
		}).pipe(Effect.scoped)
	);

	it.effect('rejects a name that matches no workspace without saving anything', () =>
		Effect.gen(function* () {
			const home = yield* temporaryHome;
			yield* writeConfigFile(home, { token: TOKEN });

			const result = yield* runAkua(['workspaces', 'use', 'missing', '--json'], {
				env: { HOME: home },
				api
			});

			expect(result.exitCode).toBe(2);
			expect(JSON.parse(result.stdout).error.code).toBe('AKUA_WORKSPACE_NOT_FOUND');
			expect(yield* readConfigFile(home)).toEqual({ token: TOKEN });
		}).pipe(Effect.scoped)
	);

	it.effect('`akua workspaces current` reports the workspace and where it comes from', () =>
		Effect.gen(function* () {
			const home = yield* temporaryHome;
			yield* writeConfigFile(home, { token: TOKEN, workspace: { id: 'ws_team', name: 'My Team' } });

			const saved = yield* runAkua(['workspaces', 'current', '--json'], { env: { HOME: home } });
			const overridden = yield* runAkua(['workspaces', 'current', '-w', 'ws_flag', '--json'], {
				env: { HOME: home }
			});

			expect(JSON.parse(saved.stdout).data).toEqual({
				id: 'ws_team',
				name: 'My Team',
				source: 'config'
			});
			expect(JSON.parse(overridden.stdout).data).toEqual({ id: 'ws_flag', source: 'flag' });
			expect(saved.requests).toEqual([]);
		}).pipe(Effect.scoped)
	);
});

describe('typed flags', () => {
	it.effect('body flags become the JSON body and path arguments fill the URL', () =>
		Effect.gen(function* () {
			const home = yield* temporaryHome;
			yield* writeConfigFile(home, { token: TOKEN, workspace: { id: 'ws_team' } });

			const created = yield* runAkua(
				[
					'clusters',
					'create',
					'--name',
					'demo',
					'--region-id',
					'reg_1',
					'--network-profile',
					'linux_cilium',
					'--json'
				],
				{ env: { HOME: home }, api }
			);
			const resumed = yield* runAkua(
				['clusters', 'resume', 'clu_1', '--if-match', 'etag_1', '--json'],
				{
					env: { HOME: home },
					api: () => ({ status: 202, body: { id: 'op_2', done: false } })
				}
			);

			const create = created.requests[0];
			expect(create?.method).toBe('POST');
			expect(create?.url.pathname).toBe('/v1/clusters');
			expect(create?.body).toEqual({
				name: 'demo',
				region_id: 'reg_1',
				network_profile: 'linux_cilium'
			});
			expect(create?.headers.authorization).toBe(`Bearer ${TOKEN}`);
			expect(resumed.requests[0]?.url.pathname).toBe('/v1/clusters/clu_1:resume');
			expect(resumed.requests[0]?.headers['if-match']).toBe('etag_1');
		}).pipe(Effect.scoped)
	);

	it.effect('query flags are typed and JSON flags take a JSON value', () =>
		Effect.gen(function* () {
			const home = yield* temporaryHome;
			yield* writeConfigFile(home, { token: TOKEN, workspace: { id: 'ws_team' } });

			const listed = yield* runAkua(['clusters', 'list', '--limit', '5', '--json'], {
				env: { HOME: home },
				api
			});
			const installed = yield* runAkua(
				[
					'installs',
					'create',
					'--product-id',
					'prod_1',
					'--region-id',
					'reg_1',
					'--initial-values',
					'{"replicas":2}',
					'--json'
				],
				{ env: { HOME: home }, api: () => ({ status: 202, body: { id: 'op_3', done: false } }) }
			);

			expect(listed.requests[0]?.url.searchParams.get('limit')).toBe('5');
			expect(installed.requests[0]?.body).toEqual({
				product_id: 'prod_1',
				region_id: 'reg_1',
				initial_values: { replicas: 2 }
			});
		}).pipe(Effect.scoped)
	);

	it.effect('flags override the same fields from --input and merge with the rest', () =>
		Effect.gen(function* () {
			const home = yield* temporaryHome;
			yield* writeConfigFile(home, { token: TOKEN, workspace: { id: 'ws_team' } });

			const result = yield* runAkua(
				['clusters', 'create', '--input', 'cluster.json', '--name', 'from-flag', '--json'],
				{
					env: { HOME: home },
					inputs: { 'cluster.json': '{"body":{"name":"from-file","region_id":"reg_1"}}' },
					api
				}
			);

			expect(result.requests[0]?.body).toEqual({ name: 'from-flag', region_id: 'reg_1' });
		}).pipe(Effect.scoped)
	);

	it.effect('a missing required flag is named before any request is sent', () =>
		Effect.gen(function* () {
			const home = yield* temporaryHome;
			yield* writeConfigFile(home, { token: TOKEN, workspace: { id: 'ws_team' } });

			const result = yield* runAkua(['machines', 'create', '--cluster-id', 'clu_1', '--json'], {
				env: { HOME: home },
				api
			});

			expect(result.exitCode).toBe(2);
			expect(result.requests).toEqual([]);
			expect(JSON.parse(result.stdout).error).toMatchObject({
				code: 'AKUA_INPUT_INVALID',
				message: 'Invalid input for akua machines create: --instance-type is required.'
			});
		}).pipe(Effect.scoped)
	);

	it.effect('unknown fields in --input are rejected without echoing their values', () =>
		Effect.gen(function* () {
			const home = yield* temporaryHome;
			yield* writeConfigFile(home, { token: TOKEN, workspace: { id: 'ws_team' } });
			const sentinel = 'request-value-must-not-be-rendered';

			const result = yield* runAkua(['machines', 'create', '--input', '-', '--json'], {
				env: { HOME: home },
				inputs: {
					'-': JSON.stringify({
						body: { cluster_id: 'clu_1', instance_type: 'cx23', undeclared: sentinel }
					})
				},
				api
			});

			expect(result.exitCode).toBe(2);
			expect(result.requests).toEqual([]);
			expect(JSON.parse(result.stdout).error.message).toBe(
				'Invalid input for akua machines create: body.undeclared: Expected no excess property.'
			);
			expect(result.stdout).not.toContain(sentinel);
		}).pipe(Effect.scoped)
	);
});

describe('output', () => {
	it.effect('--json keeps the status, command, data envelope with the API body untouched', () =>
		Effect.gen(function* () {
			const home = yield* temporaryHome;
			yield* writeConfigFile(home, { token: TOKEN });

			const result = yield* runAkua(['workspaces', 'list', '--json'], {
				env: { HOME: home },
				tty: true,
				api
			});

			expect(result.exitCode).toBe(0);
			expect(JSON.parse(result.stdout)).toEqual({
				status: 'ok',
				command: 'akua workspaces list',
				data: workspaces
			});
		}).pipe(Effect.scoped)
	);

	it.effect('an Operation response suggests how to follow it', () =>
		Effect.gen(function* () {
			const home = yield* temporaryHome;
			yield* writeConfigFile(home, { token: TOKEN, workspace: { id: 'ws_team' } });

			const result = yield* runAkua(
				['clusters', 'create', '--name', 'demo', '--region-id', 'reg_1', '--json'],
				{
					env: { HOME: home },
					api
				}
			);

			expect(JSON.parse(result.stdout).next_steps).toEqual([
				{
					command: 'akua operations wait op_123',
					description: 'Wait for it to finish; repeat while done is false.'
				}
			]);
		}).pipe(Effect.scoped)
	);

	it.effect('a terminal gets a table instead of JSON', () =>
		Effect.gen(function* () {
			const home = yield* temporaryHome;
			yield* writeConfigFile(home, { token: TOKEN });

			const result = yield* runAkua(['workspaces', 'list'], {
				env: { HOME: home },
				tty: true,
				api
			});

			expect(result.stdout).toBe(
				[
					'ID        NAME     SLUG     CREATED AT',
					'ws_team   My Team  my-team  2026-09-21 14:13 UTC',
					'ws_other  Other    other    2026-09-21 14:15 UTC',
					''
				].join('\n')
			);
		}).pipe(Effect.scoped)
	);

	it.effect('usage errors in JSON mode are one parseable error document', () =>
		Effect.gen(function* () {
			const home = yield* temporaryHome;

			const result = yield* runAkua(['clusters', 'create', '--nmae', 'demo', '--json'], {
				env: { HOME: home },
				api
			});

			expect(result.exitCode).toBe(2);
			expect(JSON.parse(result.stdout).error).toMatchObject({
				code: 'AKUA_USAGE_ERROR',
				next_steps: [{ command: 'akua clusters create --help' }]
			});
			expect(result.requests).toEqual([]);
		}).pipe(Effect.scoped)
	);

	it.effect('a missing credential points at akua auth login', () =>
		Effect.gen(function* () {
			const home = yield* temporaryHome;

			const result = yield* runAkua(['clusters', 'list', '-w', 'ws_team', '--json'], {
				env: { HOME: home },
				api
			});

			expect(result.exitCode).toBe(3);
			expect(JSON.parse(result.stdout).error).toMatchObject({
				code: 'AKUA_AUTH_REQUIRED',
				next_steps: [{ command: 'akua auth login' }]
			});
		}).pipe(Effect.scoped)
	);
});
