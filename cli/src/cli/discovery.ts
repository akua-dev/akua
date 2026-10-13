import { Effect, Option, Schema } from 'effect';
import { Command, Flag } from 'effect/cli';

import type { ApiContract } from '../api/contract';
import { commandPath, type InputFlag, operationParameters } from '../api/inputs';
import { UsageFailure } from '../runtime/effect-runtime';
import type { RenderEnvelope } from '../runtime/render';
import { commandExamples, operationContext } from './operation-context';
import { respond } from './invocation';

/**
 * `akua commands`: the machine-readable catalog of every API operation with
 * its human usage line and its JSON request shape.
 */
export function discoveryCommand(contract: ApiContract) {
	return Command.make(
		'commands',
		{
			operationId: Flag.String('operation-id').pipe(
				Flag.optional,
				Flag.withDescription('Show one operation by its OpenAPI operation ID')
			),
			resource: Flag.String('resource').pipe(
				Flag.optional,
				Flag.withDescription('Show the operations of one resource, for example clusters')
			),
			limit: Flag.Int('limit').pipe(
				Flag.optional,
				Flag.withDescription('Show at most this many operations (default: 20)')
			)
		},
		(filters) => respond(listCommands(contract, filters))
	).pipe(
		Command.withDescription('List API operations, their flags, and their JSON request shape'),
		Command.withExamples([
			{ command: 'akua commands --resource clusters', description: 'Operations on clusters' },
			{
				command: 'akua commands --operation-id clusters.create --json',
				description: 'One operation as JSON'
			}
		])
	);
}

interface Filters {
	readonly operationId: Option.Option<string>;
	readonly resource: Option.Option<string>;
	readonly limit: Option.Option<number>;
}

const listCommands = Effect.fnUntraced(function* (
	contract: ApiContract,
	filters: Filters
): Effect.fn.Return<RenderEnvelope, UsageFailure> {
	for (const [flag, value] of [
		['--operation-id', filters.operationId],
		['--resource', filters.resource]
	] satisfies ReadonlyArray<readonly [string, Option.Option<string>]>) {
		if (Option.isSome(value) && value.value === '') {
			return yield* new UsageFailure({
				message: `Missing value for ${flag}.`,
				help: 'akua commands --help'
			});
		}
	}
	const limit = Option.getOrElse(filters.limit, () => 20);
	if (limit < 1) {
		return yield* new UsageFailure({
			message: `Invalid value for --limit: ${limit}. Expected a positive integer.`,
			help: 'akua commands --help'
		});
	}
	const selected = contract.operations
		.filter((operation) =>
			Option.match(filters.operationId, { onNone: () => true, onSome: (id) => operation.id === id })
		)
		.filter((operation) =>
			Option.match(filters.resource, {
				onNone: () => true,
				onSome: (resource) => commandPath(operation).resource === resource
			})
		)
		.slice(0, limit);

	const data = selected.map((operation) => {
		const context = operationContext(contract, operation);
		const [usage] = commandExamples(context);
		const bodyExample = Object.fromEntries(
			context.inputs.flags
				.filter((flag) => flag.target === 'body' && flag.required)
				.map((flag) => [flag.key, placeholder(flag)])
		);
		const parameters = operationParameters(contract, operation);
		const parameterExample = (location: 'path' | 'query' | 'header') =>
			Object.fromEntries(
				parameters
					.filter((parameter) => parameter.in === location && parameter.required)
					.map((parameter) => [parameter.name, `<${parameter.name}>`])
			);
		const pathExample = parameterExample('path');
		const queryExample = parameterExample('query');
		const headerExample = parameterExample('header');
		return {
			operation_id: operation.id,
			command: `${context.resource} ${context.action}`,
			method: operation.method,
			path: operation.path,
			summary: operation.summary,
			usage: usage?.command ?? context.command,
			input: {
				parameters: parameters.map((parameter) => ({
					name: parameter.name,
					in: parameter.in,
					required: parameter.required
				})),
				...(operation.body === undefined
					? {}
					: { body: { required: operation.body.required, example: bodyExample } }),
				example: {
					...(Object.keys(pathExample).length === 0 ? {} : { path: pathExample }),
					...(Object.keys(queryExample).length === 0 ? {} : { query: queryExample }),
					...(Object.keys(headerExample).length === 0 ? {} : { headers: headerExample }),
					...(operation.body === undefined ? {} : { body: bodyExample })
				}
			}
		};
	});

	const single = Option.isSome(filters.operationId) ? data[0] : undefined;
	return {
		command: 'akua commands',
		observations: [`${data.length} of ${contract.operations.length} public operations shown.`],
		data,
		next_steps: [
			...(single === undefined ? [] : [{ command: single.usage }]),
			{ command: 'akua commands --resource workspaces' },
			{ command: 'akua commands --operation-id <operation_id>' }
		]
	};
});

function placeholder(flag: InputFlag): Schema.Json {
	switch (flag.kind._tag) {
		case 'Integer':
		case 'Number':
			return 0;
		case 'Boolean':
			return false;
		case 'Choice':
			return flag.kind.choices[0] ?? `<${flag.key}>`;
		case 'Json':
			return {};
		case 'String':
			return `<${flag.key}>`;
	}
}
