import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';

import { runAkua, temporaryHome, writeConfigFile } from './fake-api';

const profile = {
	name: 'Support',
	instructions: 'Help with the requested work.',
	model: 'deepseek-flash',
	billing_mode: 'PLATFORM_SUBSCRIPTION',
	mode: 'CODING'
};

const signedIn = Effect.gen(function* () {
	const home = yield* temporaryHome;
	yield* writeConfigFile(home, { token: 'fixture-token', workspace: { id: 'ws_fixture' } });
	return { HOME: home };
});

const acknowledgement = () => ({
	status: 201,
	body: { status: 'created', session_id: 'ags_fixture', agent_id: 'agt_fixture' }
});

describe('agent session union inputs', () => {
	for (const branch of [
		{
			name: 'existing agent',
			flags: ['--agent-id', 'agt_fixture'],
			body: { agent_id: 'agt_fixture' }
		},
		{ name: 'new profile', flags: ['--agent', JSON.stringify(profile)], body: { agent: profile } }
	]) {
		it.effect(`opens with only the ${branch.name} flags`, () =>
			Effect.gen(function* () {
				const result = yield* runAkua(
					[
						'agent-commands',
						'open-session',
						'--idempotency-key',
						'fixture-open',
						...branch.flags,
						'--json'
					],
					{ env: yield* signedIn, api: acknowledgement }
				);
				expect(result.exitCode, result.stdout + result.stderr).toBe(0);
				expect(result.requests).toHaveLength(1);
				expect(result.requests[0]?.body).toEqual(branch.body);
				expect(result.requests[0]?.headers['idempotency-key']).toBe('fixture-open');
			}).pipe(Effect.scoped)
		);

		it.effect(`preserves --input JSON for the ${branch.name} branch`, () =>
			Effect.gen(function* () {
				const result = yield* runAkua(
					['agent-commands', 'open-session', '--input', '-', '--json'],
					{
						env: yield* signedIn,
						inputs: {
							'-': JSON.stringify({
								headers: { 'idempotency-key': 'fixture-open' },
								body: branch.body
							})
						},
						api: acknowledgement
					}
				);
				expect(result.exitCode, result.stdout + result.stderr).toBe(0);
				expect(result.requests[0]?.body).toEqual(branch.body);
			}).pipe(Effect.scoped)
		);
	}

	for (const flags of [[], ['--agent-id', 'agt_fixture', '--agent', JSON.stringify(profile)]]) {
		it.effect(`rejects ${flags.length === 0 ? 'neither' : 'both'} union branches before HTTP`, () =>
			Effect.gen(function* () {
				const result = yield* runAkua(
					[
						'agent-commands',
						'open-session',
						'--idempotency-key',
						'fixture-open',
						...flags,
						'--json'
					],
					{ env: yield* signedIn, api: acknowledgement }
				);
				expect(result.exitCode).toBe(2);
				expect(result.requests).toEqual([]);
			}).pipe(Effect.scoped)
		);
	}

	for (const body of [
		{},
		{ agent_id: 'agt_fixture', agent: profile },
		{ agent: { name: 'Incomplete' } }
	]) {
		it.effect(`validates the union for --input ${JSON.stringify(body)}`, () =>
			Effect.gen(function* () {
				const result = yield* runAkua(
					['agent-commands', 'open-session', '--input', '-', '--json'],
					{
						env: yield* signedIn,
						inputs: {
							'-': JSON.stringify({ headers: { 'idempotency-key': 'fixture-open' }, body })
						},
						api: acknowledgement
					}
				);
				expect(result.exitCode).toBe(2);
				expect(result.requests).toEqual([]);
			}).pipe(Effect.scoped)
		);
	}

	it.effect('discovers an executable coding profile example', () =>
		Effect.gen(function* () {
			const env = yield* signedIn;
			const discovery = yield* runAkua([
				'commands',
				'--operation-id',
				'agentCommands.openSession',
				'--json'
			]);
			expect(discovery.exitCode).toBe(0);
			const command = JSON.parse(discovery.stdout).data[0];
			const example = command.input.example;
			expect(example.body).toMatchObject({ agent: { model: 'deepseek-flash', mode: 'CODING' } });
			expect(command.usage).toContain(`--agent '${JSON.stringify(example.body.agent)}'`);
			expect(command.usage).not.toContain('--agent-id');
			const execution = yield* runAkua(
				['agent-commands', 'open-session', '--input', '-', '--json'],
				{
					env,
					inputs: { '-': JSON.stringify(example) },
					api: acknowledgement
				}
			);
			expect(execution.exitCode, execution.stdout + execution.stderr).toBe(0);
			expect(execution.requests).toHaveLength(1);
		}).pipe(Effect.scoped)
	);
});
