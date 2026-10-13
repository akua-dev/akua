import { Effect, Option, Predicate, String } from 'effect';

import type { ApiContract } from '../api/contract';
import { decodeApiErrorBody, type InputIssue, type OperationFailure } from '../api/failure';
import { commandPath, CONTEXT_HEADER, findOperation, partitionOf } from '../api/inputs';
import type { CliFailure } from '../runtime/effect-runtime';
import { AkuaCliError, type NextStep } from '../runtime/errors';
import { ExitCodes } from '../runtime/exit-codes';
import type { SecureConfigFailure } from '../runtime/services';
import {
	commandExamples,
	operationContext,
	type OperationCommandContext
} from './operation-context';

/** The one mapping from an operation's failures to what the command prints. */
export const toCliFailure =
	(context: OperationCommandContext) =>
	(failure: OperationFailure | SecureConfigFailure): CliFailure =>
		failure._tag === 'OperationFailure' ? operationError(failure, context) : failure;

/** Workspace lookups explain their failures as `akua workspaces list` would. */
export const failWorkspaceLookup =
	(contract: ApiContract) =>
	(failure: OperationFailure | SecureConfigFailure): Effect.Effect<never, CliFailure> =>
		findOperation(contract, 'workspaces.list').pipe(
			Effect.flatMap((list) => Effect.fail(toCliFailure(operationContext(contract, list))(failure)))
		);

export function operationError(
	failure: OperationFailure,
	context: OperationCommandContext
): AkuaCliError {
	const help = {
		command: `${context.command} --help`,
		description: 'See the arguments and flags.'
	};
	switch (failure.reason) {
		case 'input': {
			const detail = (failure.issues ?? [])
				.map((issue) => describeIssue(issue, context))
				.join('; ');
			return new AkuaCliError({
				type: 'input_error',
				code: 'AKUA_INPUT_INVALID',
				message:
					detail === ''
						? `Invalid input for ${context.command}.`
						: `Invalid input for ${context.command}: ${detail}.`,
				exitCode: ExitCodes.Usage,
				nextSteps: [help, ...commandExamples(context)]
			});
		}
		case 'source':
			return new AkuaCliError({
				type: 'input_error',
				code: 'AKUA_INPUT_UNREADABLE',
				message: `Could not read the ${failure.detail ?? '--input'} file for ${context.command}.`,
				exitCode: ExitCodes.Usage,
				nextSteps: [help]
			});
		case 'auth':
			return new AkuaCliError({
				type: 'authentication_error',
				code: 'AKUA_AUTH_REQUIRED',
				message: 'Not signed in. Run akua auth login, or set AKUA_API_TOKEN.',
				exitCode: ExitCodes.AuthRequired,
				nextSteps: [{ command: 'akua auth login' }]
			});
		case 'workspace':
			return new AkuaCliError({
				type: 'input_error',
				code: 'AKUA_WORKSPACE_NOT_FOUND',
				message: failure.detail ?? 'The workspace could not be found.',
				exitCode: ExitCodes.Usage,
				nextSteps: [
					{ command: 'akua workspaces list', description: 'See the workspaces you can use.' }
				]
			});
		case 'api': {
			const fields = rejectedFields(failure, context);
			return new AkuaCliError({
				type: 'api_error',
				code: failure.code === undefined ? 'AKUA_API_ERROR' : `AKUA_API_${failure.code}`,
				message: needsWorkspace(failure, context)
					? `No workspace selected; ${context.command} runs in a workspace (API: ${failure.detail ?? `HTTP ${failure.status}`}).`
					: fields.length > 0
						? `The Akua API rejected the input for ${context.command}: ${fields.join('; ')}.`
						: (failure.detail ?? 'The Akua API rejected the request.'),
				...(failure.status === undefined ? {} : { status: failure.status }),
				...(failure.response === undefined ? {} : { response: failure.response }),
				nextSteps:
					fields.length > 0 ? [help, ...commandExamples(context)] : apiNextSteps(failure, context)
			});
		}
		case 'response':
			return new AkuaCliError({
				type: 'response_error',
				code: 'AKUA_API_CONTRACT_ERROR',
				message: 'The Akua API answered with a body that is not JSON.',
				...(failure.status === undefined ? {} : { status: failure.status }),
				exitCode: ExitCodes.Retryable
			});
		case 'transport':
			return new AkuaCliError({
				type: 'transport_error',
				code: 'AKUA_API_UNAVAILABLE',
				message: 'The Akua API could not be reached. Check your connection and try again.',
				exitCode: ExitCodes.Retryable
			});
	}
}

/** Names the flag or argument a person typed, falling back to the request field for `--input`. */
function describeIssue(issue: InputIssue, context: OperationCommandContext): string {
	const [partition, key] = issue.path;
	const message = issue.message === 'Missing key' ? 'is required' : issue.message;
	if (issue.path.length === 1 && partition === 'body' && issue.message === 'Missing key') {
		const required = context.inputs.flags.filter((flag) => flag.target === 'body' && flag.required);
		return required.length === 0
			? 'pass the request body as flags (see --help) or with --input'
			: required.map((flag) => `--${flag.name} is required`).join('; ');
	}
	if (issue.path.length === 2 && partition === 'path' && key !== undefined) {
		return `<${key}> ${message}`;
	}
	if (issue.path.length === 2 && partition === 'headers' && key === CONTEXT_HEADER) {
		return `--workspace ${message}`;
	}
	const flag = context.inputs.flags.find(
		(candidate) =>
			issue.path.length === 2 &&
			key === candidate.key &&
			partition === partitionOf(candidate.target)
	);
	if (flag !== undefined) return `--${flag.name} ${message}`;
	return issue.path.length === 0 ? message : `${issue.path.join('.')}: ${message}`;
}

/**
 * A 422 names the rejected fields as server-side paths such as
 * `["args", "regionId"]`; point at the flag that sets each one.
 */
function rejectedFields(failure: OperationFailure, context: OperationCommandContext): string[] {
	if (failure.status !== 422) return [];
	return Option.match(decodeApiErrorBody(failure.response), {
		onNone: () => [],
		onSome: (body) =>
			body.errors.flatMap((error) => {
				const field = (error.path ?? []).filter(Predicate.isString).at(-1);
				if (field === undefined || error.message === undefined) return [];
				const key = String.camelToSnake(field);
				const flag = context.inputs.flags.find((candidate) => candidate.key === key);
				const message = error.message.endsWith('received undefined')
					? 'is required'
					: error.message;
				return [`${flag === undefined ? field : `--${flag.name}`} ${message}`];
			})
	});
}

/** The API refuses a workspace-scoped call without context with 400 or 403. */
function needsWorkspace(failure: OperationFailure, context: OperationCommandContext): boolean {
	return context.workspaceMissing === true && (failure.status === 400 || failure.status === 403);
}

function apiNextSteps(failure: OperationFailure, context: OperationCommandContext): NextStep[] {
	if (failure.status === 401) {
		return [{ command: 'akua auth login', description: 'Sign in again.' }];
	}
	if (needsWorkspace(failure, context)) {
		return [
			{ command: 'akua workspaces list', description: 'See the workspaces you can use.' },
			{
				command: 'akua workspaces use <name>',
				description: 'Save the workspace for later commands.'
			},
			{
				command: `${context.command} --workspace <name>`,
				description: 'Or pick the workspace for this command only.'
			}
		];
	}
	if (failure.status === 404) {
		const hasList = context.contract.operations.some((operation) => {
			const path = commandPath(operation);
			return path.resource === context.resource && path.action === 'list';
		});
		return hasList
			? [{ command: `akua ${context.resource} list`, description: 'See the IDs that exist.' }]
			: [];
	}
	return [];
}
