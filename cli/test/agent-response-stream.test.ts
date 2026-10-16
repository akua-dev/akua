import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';

import { runAkua, temporaryHome, writeConfigFile } from './fake-api';

const command = ['agent-events', 'stream-response-parts', '--session', 'ags_test'];
const signedIn = Effect.gen(function* () {
	const home = yield* temporaryHome;
	yield* writeConfigFile(home, { token: 'fixture-token', workspace: { id: 'ws_test' } });
	return { HOME: home };
});

// Canonical UI Message Stream chunks, including distinct responses on one session.
const responseChunks = [
	{ type: 'start', messageId: 'response-z' },
	{ type: 'start-step' },
	{ type: 'text-start', id: 'text-z' },
	{ type: 'text-delta', id: 'text-z', delta: 'Hel' },
	{ type: 'text-delta', id: 'text-z', delta: 'lo, ' },
	{ type: 'text-delta', id: 'text-z', delta: '世界!\n' },
	{ type: 'text-end', id: 'text-z' },
	{ type: 'finish-step' },
	{ type: 'finish', finishReason: 'stop' },
	{ type: 'start', messageId: 'response-a' },
	{ type: 'text-start', id: 'text-a' },
	{ type: 'text-delta', id: 'text-a', delta: 'Second answer.' },
	{ type: 'text-end', id: 'text-a' },
	{ type: 'finish', finishReason: 'stop' }
];

const events = (chunks: readonly unknown[]) =>
	chunks
		.map((chunk, index) => `id: ${index + 1}\nevent: message\ndata: ${JSON.stringify(chunk)}\n\n`)
		.join('');
const api = (chunks: readonly unknown[]) => () => ({
	text: events(chunks),
	contentType: 'text/event-stream'
});

describe('agent response stream through the CLI', () => {
	it.effect('joins split text deltas in arrival order and displays each response finish', () =>
		Effect.gen(function* () {
			const result = yield* runAkua(command, {
				env: yield* signedIn,
				tty: true,
				api: api(responseChunks)
			});
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toBe(
				'Hello, 世界!\n\nResponse finished (stop).\nSecond answer.\nResponse finished (stop).\n'
			);
			expect(result.stderr).toBe('');
			expect(result.requests).toHaveLength(1);
			expect(result.requests[0]?.url.pathname).toBe('/v1/agent_response_parts:stream');
		}).pipe(Effect.scoped)
	);

	it.effect('keeps every structured event and ordering unchanged in JSON mode', () =>
		Effect.gen(function* () {
			const result = yield* runAkua([...command, '--json'], {
				env: yield* signedIn,
				api: api(responseChunks)
			});
			expect(result.exitCode).toBe(0);
			expect(
				result.stdout
					.trim()
					.split('\n')
					.map((line) => JSON.parse(line))
			).toEqual(
				responseChunks.map((chunk) => ({
					status: 'ok',
					command: 'akua agent-events stream-response-parts',
					data: { event: 'message', data: JSON.stringify(chunk) }
				}))
			);
		}).pipe(Effect.scoped)
	);

	it.effect('retains structured agent output instead of human text for automation', () =>
		Effect.gen(function* () {
			const result = yield* runAkua([...command, '--output', 'agent'], {
				env: yield* signedIn,
				api: api([{ type: 'text-delta', id: 'answer', delta: 'Hello' }])
			});
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toBe(
				'status: ok\ncommand: akua agent-events stream-response-parts\ndata:\n  event: message\n  data: {"type":"text-delta","id":"answer","delta":"Hello"}\n'
			);
		}).pipe(Effect.scoped)
	);

	it.effect('renders beyond a list page without inserting a newline between deltas', () =>
		Effect.gen(function* () {
			const chunks = [
				{ type: 'text-start', id: 'answer' },
				...Array.from({ length: 105 }, () => ({ type: 'text-delta', id: 'answer', delta: 'x' })),
				{ type: 'text-end', id: 'answer' },
				{ type: 'finish' }
			];
			const result = yield* runAkua(command, { env: yield* signedIn, tty: true, api: api(chunks) });
			expect(result.stdout).toBe(`${'x'.repeat(105)}\nResponse finished.\n`);
			expect(result.exitCode).toBe(0);
		}).pipe(Effect.scoped)
	);

	it.effect('keeps denied tool output and unknown events visible without approving anything', () =>
		Effect.gen(function* () {
			const chunks = [
				{ type: 'tool-output-denied', toolCallId: 'tool-1' },
				{ type: 'future-approval-notice', approvalId: 'approval-1' }
			];
			const result = yield* runAkua(command, { env: yield* signedIn, tty: true, api: api(chunks) });
			expect(result.stdout).toBe(chunks.map((chunk) => `${JSON.stringify(chunk)}\n`).join(''));
			expect(result.requests).toHaveLength(1);
			expect(result.requests[0]?.method).toBe('GET');
		}).pipe(Effect.scoped)
	);

	it.effect('preserves stream failure exit status and does not claim completion', () =>
		Effect.gen(function* () {
			const failure = JSON.stringify([
				{ _tag: 'Fail', error: { message: 'Response delivery interrupted' } }
			]);
			const result = yield* runAkua(command, {
				env: yield* signedIn,
				tty: true,
				api: () => ({
					text: `event: effect/http-api/stream/failure\ndata: ${failure}\n\n`,
					contentType: 'text/event-stream'
				})
			});
			expect(result.exitCode).toBe(1);
			expect(result.stdout).toContain('Response delivery interrupted');
			expect(result.stdout).not.toContain('Response finished');
		}).pipe(Effect.scoped)
	);

	it.effect(
		'leaves an interrupted response visibly unfinished rather than inventing completion',
		() =>
			Effect.gen(function* () {
				const result = yield* runAkua(command, {
					env: yield* signedIn,
					tty: true,
					api: api([
						{ type: 'text-delta', id: 'answer', delta: 'Partial answer' },
						{ type: 'abort', reason: 'Cancelled by user' }
					])
				});
				expect(result.stdout).toBe('Partial answer\nResponse aborted: Cancelled by user\n');
				expect(result.stdout).not.toContain('Response finished');
			}).pipe(Effect.scoped)
	);
});
