import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';

import { type FakeApi, runAkua, temporaryHome, writeConfigFile } from './fake-api';

const TOKEN = 'test-token';

const receipt = {
	message: 'clusters list is slow',
	user_id: 'user_fixture',
	email: 'person@example.test',
	client: 'akua-cli/0.0.0-dev (darwin; arm64) bun/1.4.4'
};

/** The API's feedback endpoint: a receipt for the message it was sent. */
const feedbackApi: FakeApi = (request) =>
	request.method === 'POST' && request.url.pathname === '/v1/feedback'
		? { status: 201, body: receipt }
		: { status: 404, body: { success: false, errors: [{ code: 7002, message: 'Not found' }] } };

describe('akua feedback create', () => {
	it.effect('sends the message as the signed-in person and shows what was sent with it', () =>
		Effect.gen(function* () {
			const home = yield* temporaryHome;
			yield* writeConfigFile(home, { token: TOKEN, workspace: { id: 'ws_saved' } });
			const result = yield* runAkua(
				['feedback', 'create', '--message', 'clusters list is slow', '--output', 'human'],
				{ env: { HOME: home }, api: feedbackApi }
			);
			expect(result.exitCode).toBe(0);
			expect(result.requests).toHaveLength(1);
			const [request] = result.requests;
			expect(request?.method).toBe('POST');
			expect(request?.url.pathname).toBe('/v1/feedback');
			expect(request?.headers.authorization).toBe(`Bearer ${TOKEN}`);
			// The body names no user, and the saved workspace is no part of feedback.
			expect(request?.body).toEqual({ message: 'clusters list is slow' });
			expect(request?.headers['akua-context']).toBeUndefined();
			// The receipt is what the team got: the message, the user, the email, the client.
			for (const shown of Object.values(receipt)) expect(result.stdout).toContain(shown);
			expect(result.stdout).not.toContain(TOKEN);
		}).pipe(Effect.scoped)
	);

	it.effect('reads the JSON request from stdin and prints the receipt as JSON', () =>
		Effect.gen(function* () {
			const home = yield* temporaryHome;
			yield* writeConfigFile(home, { token: TOKEN });
			const result = yield* runAkua(['feedback', 'create', '--input', '-', '--json'], {
				env: { HOME: home },
				api: feedbackApi,
				inputs: { '-': JSON.stringify({ body: { message: 'from a script' } }) }
			});
			expect(result.exitCode).toBe(0);
			expect(result.requests[0]?.body).toEqual({ message: 'from a script' });
			expect(JSON.parse(result.stdout).data).toEqual(receipt);
		}).pipe(Effect.scoped)
	);

	it.effect('rejects a missing, empty, too long, or user-naming message before sending', () =>
		Effect.gen(function* () {
			const home = yield* temporaryHome;
			yield* writeConfigFile(home, { token: TOKEN });
			for (const argv of [
				['feedback', 'create', '--json'],
				['feedback', 'create', '--message', '', '--json'],
				['feedback', 'create', '--message', 'x'.repeat(1501), '--json'],
				['feedback', 'create', '--message', 'hello', '--user-id', 'user_other', '--json']
			]) {
				const result = yield* runAkua(argv, { env: { HOME: home }, api: feedbackApi });
				expect(result.exitCode).not.toBe(0);
				// A rejected request may fetch the live contract to explain itself; it never posts.
				expect(result.requests.filter(({ method }) => method === 'POST')).toEqual([]);
			}
		}).pipe(Effect.scoped)
	);

	it.effect('passes the API refusals through unchanged', () =>
		Effect.gen(function* () {
			const home = yield* temporaryHome;
			yield* writeConfigFile(home, { token: TOKEN });
			for (const status of [401, 429, 503]) {
				const body = {
					success: false,
					errors: [{ code: 7000 + status, message: `status ${status}` }]
				};
				const result = yield* runAkua(['feedback', 'create', '--message', 'hello', '--json'], {
					env: { HOME: home },
					api: () => ({ status, body })
				});
				expect(result.exitCode).not.toBe(0);
				expect(JSON.parse(result.stdout).error.response).toEqual(body);
			}
		}).pipe(Effect.scoped)
	);
});
