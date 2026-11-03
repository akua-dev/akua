import { describe, expect, test } from '@effect/vitest';

import { AkuaCliError } from '../src/runtime/errors';
import { renderError, renderSuccess } from '../src/runtime/render';

describe('renderSuccess', () => {
	test('renders compact table-shaped agent output', () => {
		const output = renderSuccess(
			{
				command: 'akua commands',
				observations: ['2 operations shown.'],
				data: [
					{ operation_id: 'workspaces.list', command: 'workspaces list' },
					{ operation_id: 'workspaces.get', command: 'workspaces get' }
				],
				next_steps: [{ command: 'akua commands --json' }]
			},
			'agent'
		);

		expect(output).toContain('status: ok');
		expect(output).toContain('data[2]{operation_id,command}:');
		expect(output).toContain('next_steps[1]{command}:');
	});

	test('keeps nested arrays and objects of table rows in agent output', () => {
		const output = renderSuccess(
			{
				command: 'akua organizations get-iam-policy',
				data: {
					bindings: [
						{ role: 'roles/owner', members: ['user:a', 'user:b'], condition: { title: 'office' } }
					]
				}
			},
			'agent'
		);

		expect(output).toContain(
			[
				'  bindings[1]:',
				'    - role: roles/owner',
				'      members[2]:',
				'        user:a',
				'        user:b',
				'      condition:',
				'        title: office'
			].join('\n')
		);
	});

	test('spells nested arrays out in human key-value output', () => {
		const output = renderSuccess(
			{
				command: 'akua organizations get-iam-policy',
				data: { bindings: [{ role: 'roles/owner', members: ['user:a'] }] }
			},
			'human'
		);

		expect(output).toContain('[{"role":"roles/owner","members":["user:a"]}]');
	});

	test('renders deterministic json', () => {
		const output = renderSuccess({ command: 'akua', data: { version: '0.0.0' } }, 'json');
		expect(JSON.parse(output)).toEqual({
			status: 'ok',
			command: 'akua',
			data: { version: '0.0.0' }
		});
	});
});

describe('renderError', () => {
	test('preserves structured API error fields', () => {
		const output = renderError(
			new AkuaCliError({
				type: 'validation_error',
				code: 'INVALID_ARGUMENT',
				status: 400,
				message: 'workspace_id is required',
				path: ['body', 'workspace_id'],
				requestId: 'req_123',
				nextSteps: [{ command: 'akua workspaces list' }]
			}),
			'json'
		);

		expect(JSON.parse(output)).toEqual({
			error: {
				type: 'validation_error',
				code: 'INVALID_ARGUMENT',
				status: 400,
				message: 'workspace_id is required',
				path: ['body', 'workspace_id'],
				request_id: 'req_123',
				next_steps: [{ command: 'akua workspaces list' }]
			}
		});
	});
});
