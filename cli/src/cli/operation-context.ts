import { Result, type Schema } from 'effect';

import type { ApiContract, ApiOperation } from '../api/contract';
import { commandPath, type InputFlag, type OperationInputs, operationInputs } from '../api/inputs';
import type { NextStep } from '../runtime/errors';

/** Everything a generated command needs to explain itself in help and errors. */
export interface OperationCommandContext {
	readonly contract: ApiContract;
	readonly operation: ApiOperation;
	readonly inputs: OperationInputs;
	readonly resource: string;
	readonly action: string;
	/** `akua <resource> <action>` */
	readonly command: string;
	/** Set when the operation runs in a workspace and none was selected. */
	readonly workspaceMissing?: boolean;
}

const NO_INPUTS: OperationInputs = { arguments: [], flags: [], context: false };

export function operationContext(
	contract: ApiContract,
	operation: ApiOperation
): OperationCommandContext {
	const { resource, action } = commandPath(operation);
	return {
		contract,
		operation,
		// The generator proves every operation maps to inputs; see verifyContract.
		inputs: Result.getOrElse(operationInputs(contract, operation), () => NO_INPUTS),
		resource,
		action,
		command: `akua ${resource} ${action}`
	};
}

/** The human form first (arguments and required flags), then the JSON form for scripts. */
export function commandExamples(context: OperationCommandContext): NextStep[] {
	const body = operationBodyExample(context);
	const usage = [
		context.command,
		...context.inputs.arguments.map((argument) => `<${argument.name}>`),
		...context.inputs.flags
			.filter((flag) => flag.required || (flag.target === 'body' && flag.key in body))
			.map(
				(flag) =>
					`--${flag.name} ${
						!flag.required && flag.kind._tag === 'Json' && flag.target === 'body'
							? `'${JSON.stringify(body[flag.key])}'`
							: placeholder(flag)
					}`
			)
	].join(' ');
	return [
		{ command: usage, description: context.operation.summary },
		...(context.operation.body === undefined && context.inputs.arguments.length === 0
			? []
			: [
					{
						command: `${context.command} --input request.json`,
						description:
							'Send a JSON request {"path","query","headers","body"} (scripts and agents)'
					}
				])
	];
}

export function operationBodyExample(
	context: OperationCommandContext
): Readonly<Record<string, Schema.Json>> {
	return Object.fromEntries(
		context.inputs.flags
			.filter((flag) => flag.target === 'body' && flag.required)
			.map((flag) => [flag.key, exampleValue(flag)])
	);
}

function exampleValue(flag: InputFlag): Schema.Json {
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

function placeholder(flag: InputFlag): string {
	if (flag.kind._tag === 'Choice') return flag.kind.choices.join('|');
	if (flag.kind._tag === 'Json') return `'<${flag.name} JSON>'`;
	return `<${flag.name}>`;
}
