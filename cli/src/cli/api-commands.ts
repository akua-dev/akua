import { Effect, Option, Predicate, Redacted, Schema, Stream } from 'effect';
import { Argument, Command, Flag } from 'effect/cli';

import { ApiClient, type ApiResult } from '../api/client';
import type { ApiContract, ApiOperation } from '../api/contract';
import { OperationFailure } from '../api/failure';
import {
	commandPath,
	CONTEXT_HEADER,
	SECRET_FILE_SUFFIX,
	type InputFlag,
	type OperationInputs,
	partitionOf
} from '../api/inputs';
import { asJsonRecord, decodeJsonText, type JsonRecord, JsonText } from '../api/json';
import { decodeRequest } from '../api/request';
import type { CliFailure } from '../runtime/effect-runtime';
import type { NextStep } from '../runtime/errors';
import type { RenderEnvelope } from '../runtime/render';
import { Console, PublicInput, type SecureConfig } from '../runtime/services';
import { respond } from './invocation';
import {
	commandExamples,
	operationContext,
	type OperationCommandContext
} from './operation-context';
import { failWorkspaceLookup, toCliFailure } from './operation-errors';
import { akua } from './root';
import { resolveWorkspaceId, selectWorkspace } from './workspace-context';

/** Hand-written commands added to a generated resource group, and its extra name. */
export interface ResourceExtension<Extension extends Command.Command.Any> {
	readonly commands: ReadonlyArray<Extension>;
	readonly alias?: string;
}

/**
 * One command group per API resource (`akua clusters ...`), one command per
 * public operation (`akua clusters create`). Path parameters are positional
 * arguments; query, header, and top-level body fields are typed flags;
 * `--input` still takes the whole JSON request for scripts and agents.
 */
export function resourceCommands<Extension extends Command.Command.Any>(
	contract: ApiContract,
	extensions: Readonly<Record<string, ResourceExtension<Extension>>>
) {
	const byResource = new Map<string, ApiOperation[]>();
	for (const operation of contract.operations) {
		const { resource } = commandPath(operation);
		byResource.set(resource, [...(byResource.get(resource) ?? []), operation]);
	}
	return contract.resources.map((resource) => {
		const extension = extensions[resource.name];
		const group = Command.make(resource.name).pipe(
			Command.withDescription(resource.description ?? resource.title),
			Command.withSubcommands([
				...(byResource.get(resource.name) ?? []).map((operation) =>
					operationCommand(contract, operation)
				),
				...(extension?.commands ?? [])
			])
		);
		return extension?.alias === undefined ? group : group.pipe(Command.withAlias(extension.alias));
	});
}

function operationCommand(contract: ApiContract, operation: ApiOperation) {
	const context = operationContext(contract, operation);
	const config = {
		args: context.inputs.arguments.map((argument) =>
			Argument.String(argument.name).pipe(
				Argument.withDescription(firstSentence(argument.description) ?? argument.name),
				Argument.optional
			)
		),
		flags: context.inputs.flags.map(flagParameter),
		secretFiles: context.inputs.flags
			.filter((flag) => flag.secret)
			.map((flag) =>
				Flag.String(`${flag.name}${SECRET_FILE_SUFFIX}`).pipe(
					Flag.optional,
					Flag.withDescription(
						`Read --${flag.name} from a file, or - for stdin, so it stays out of shell history`
					)
				)
			),
		input: Flag.String('input').pipe(
			Flag.optional,
			Flag.withDescription(
				'Read the JSON request {"path","query","headers","body"} from a file, or - for stdin; arguments and flags override it'
			)
		)
	};
	return Command.make(
		context.action,
		config,
		Effect.fn(function* ({ args, flags, secretFiles, input }) {
			const global = yield* akua;
			yield* respond(runOperation(context, { args, flags, secretFiles, input }, global.workspace));
		})
	).pipe(
		Command.withDescription(operation.summary),
		Command.withExamples(commandExamples(context))
	);
}

type ParsedFlag = Schema.Json | Redacted.Redacted<string>;

function flagParameter(flag: InputFlag): Flag.Flag<Option.Option<ParsedFlag>> {
	const description = [
		firstSentence(flag.description) ?? fieldLabel(flag.key),
		flag.required
			? flag.secret
				? `(required, or --${flag.name}${SECRET_FILE_SUFFIX})`
				: '(required)'
			: '',
		flag.kind._tag === 'Json' ? '(JSON)' : ''
	]
		.filter((part) => part !== '')
		.join(' ');
	if (flag.secret) {
		return Flag.Redacted(flag.name).pipe(Flag.optional, Flag.withDescription(description));
	}
	const base = (): Flag.Flag<Schema.Json> => {
		switch (flag.kind._tag) {
			case 'String':
				return Flag.String(flag.name);
			case 'Integer':
				return Flag.Int(flag.name);
			case 'Number':
				return Flag.Finite(flag.name);
			case 'Boolean':
				return Flag.Boolean(flag.name);
			case 'Choice':
				return Flag.Literals(flag.name, flag.kind.choices);
			case 'Json':
				return Flag.String(flag.name).pipe(Flag.withSchema(JsonText));
		}
	};
	return base().pipe(Flag.optional, Flag.withDescription(description));
}

/** `region_id` reads as "Region ID" when the schema has no description. */
function fieldLabel(key: string): string {
	const words = key.split('_').map((word) => (word === 'id' ? 'ID' : word));
	const [first = '', ...rest] = words;
	return [first.charAt(0).toUpperCase() + first.slice(1), ...rest].join(' ');
}

/** Help lines stay short; the API reference keeps the full field documentation. */
function firstSentence(text: string | undefined): string | undefined {
	if (text === undefined) return undefined;
	const end = text.search(/\.(\s|$)/);
	return end < 0 ? text : text.slice(0, end + 1);
}

interface ParsedInputs {
	readonly args: ReadonlyArray<Option.Option<string>>;
	readonly flags: ReadonlyArray<Option.Option<ParsedFlag>>;
	/** `--<secret>-file` values, in the order of the secret flags. */
	readonly secretFiles: ReadonlyArray<Option.Option<string>>;
	readonly input: Option.Option<string>;
}

type ResolvedInputs = Omit<ParsedInputs, 'flags'> & {
	readonly flags: ReadonlyArray<Option.Option<Schema.Json>>;
};

const runOperation = Effect.fnUntraced(function* (
	context: OperationCommandContext,
	parsed: ParsedInputs,
	workspaceFlag: Option.Option<string>
): Effect.fn.Return<
	RenderEnvelope<CliFailure>,
	CliFailure,
	ApiClient | Console | PublicInput | SecureConfig
> {
	const { envelope, workspaceMissing } = yield* prepareRequest(context, parsed, workspaceFlag);
	const failureContext = { ...context, workspaceMissing };
	const result = yield* Effect.gen(function* () {
		const request = yield* decodeRequest(context.contract, context.operation, envelope);
		return yield* (yield* ApiClient).execute(context.operation, request);
	}).pipe(Effect.mapError(toCliFailure(failureContext)));
	return successEnvelope(context, result);
});

/**
 * The request envelope from `--input`, arguments, and flags, with the
 * workspace context header filled in from `--workspace`, `AKUA_WORKSPACE`,
 * or the saved workspace unless the envelope already names one.
 */
const prepareRequest = Effect.fnUntraced(function* (
	context: OperationCommandContext,
	parsed: ParsedInputs,
	workspaceFlag: Option.Option<string>
): Effect.fn.Return<
	{ readonly envelope: JsonRecord; readonly workspaceMissing: boolean },
	CliFailure,
	ApiClient | Console | PublicInput | SecureConfig
> {
	const { contract, operation, inputs } = context;
	const envelope = yield* Effect.gen(function* () {
		const flags = yield* resolveSecretFlags(context, parsed);
		const base = Option.isSome(parsed.input) ? yield* readInput(operation, parsed.input.value) : {};
		return yield* applyInputs(operation, inputs, base, { ...parsed, flags });
	}).pipe(Effect.mapError(toCliFailure(context)));
	const headers = Option.getOrElse(asJsonRecord(envelope.headers), (): JsonRecord => ({}));
	// Like every other flag, --workspace overrides --input; the environment and config do not.
	const inputNamesContext = headers[CONTEXT_HEADER] !== undefined && Option.isNone(workspaceFlag);
	if (!inputs.context || inputNamesContext) return { envelope, workspaceMissing: false };
	const selection = yield* selectWorkspace(workspaceFlag);
	if (Option.isNone(selection)) return { envelope, workspaceMissing: true };
	const id = yield* resolveWorkspaceId(contract, selection.value).pipe(
		Effect.catch(failWorkspaceLookup(contract))
	);
	return {
		envelope: { ...envelope, headers: { ...headers, [CONTEXT_HEADER]: id } },
		workspaceMissing: false
	};
});

/**
 * Secret flags take their value from `--<name>-file` (a path, or `-` for
 * stdin) when given; a secret typed on the command line still works but
 * warns, because shell history and the process list keep it.
 */
const resolveSecretFlags = Effect.fnUntraced(function* (
	context: OperationCommandContext,
	parsed: ParsedInputs
) {
	const { operation, inputs } = context;
	const console = yield* Console;
	const flags = parsed.flags.map((flag) =>
		Option.map(flag, (value) => (Redacted.isRedacted(value) ? Redacted.value(value) : value))
	);
	const secretFlags = inputs.flags.filter((flag) => flag.secret);
	const stdinSources =
		parsed.secretFiles.filter((file) => Option.isSome(file) && file.value === '-').length +
		(Option.isSome(parsed.input) && parsed.input.value === '-' ? 1 : 0);
	if (stdinSources > 1) {
		return yield* new OperationFailure({
			operationId: operation.id,
			reason: 'input',
			issues: [{ path: [], message: 'stdin (-) can be used by only one input source' }]
		});
	}
	for (const [position, flag] of secretFlags.entries()) {
		const index = inputs.flags.indexOf(flag);
		const direct = flags[index] ?? Option.none();
		const file = parsed.secretFiles[position] ?? Option.none();
		const fileFlag = `--${flag.name}${SECRET_FILE_SUFFIX}`;
		const issue = (message: string) =>
			new OperationFailure({
				operationId: operation.id,
				reason: 'input',
				issues: [{ path: [partitionOf(flag.target), flag.key], message }]
			});
		if (Option.isNone(file)) {
			if (Option.isSome(direct)) {
				if (flag.kind._tag === 'Json' && Predicate.isString(direct.value)) {
					flags[index] = Option.some(
						yield* decodeJsonText(direct.value).pipe(
							Effect.mapError(() => issue('Expected a JSON value'))
						)
					);
				}
				yield* console.writeStderr(
					`Warning: --${flag.name} keeps the secret in your shell history and the process list. Pass it with ${fileFlag} <path>, or ${fileFlag} - to read stdin.\n`
				);
			}
			continue;
		}
		if (Option.isSome(direct)) {
			return yield* issue(`Use --${flag.name} or ${fileFlag}, not both`);
		}
		const text = yield* (yield* PublicInput).read(file.value).pipe(
			Effect.mapError(
				() =>
					new OperationFailure({
						operationId: operation.id,
						reason: 'source',
						detail: fileFlag
					})
			)
		);
		const value = text.replace(/\r?\n$/, '');
		flags[index] = Option.some(
			flag.kind._tag === 'Json'
				? yield* decodeJsonText(value).pipe(Effect.mapError(() => issue('Expected a JSON value')))
				: value
		);
	}
	return flags;
});

const readInput = Effect.fnUntraced(function* (operation: ApiOperation, source: string) {
	const inputFailure = (message: string) =>
		new OperationFailure({
			operationId: operation.id,
			reason: 'input',
			issues: [{ path: [], message }]
		});
	const text = yield* (yield* PublicInput)
		.read(source)
		.pipe(
			Effect.mapError(() => new OperationFailure({ operationId: operation.id, reason: 'source' }))
		);
	const json = yield* decodeJsonText(text).pipe(
		Effect.mapError(() => inputFailure('Input is not valid JSON'))
	);
	return yield* Effect.fromOption(asJsonRecord(json)).pipe(
		Effect.mapError(() => inputFailure('Input must be a JSON object'))
	);
});

interface Assignment {
	readonly partition: string;
	readonly key: string;
	readonly value: Schema.Json;
}

/** Arguments and flags are written into the request envelope over anything `--input` supplied. */
function applyInputs(
	operation: ApiOperation,
	inputs: OperationInputs,
	base: JsonRecord,
	parsed: ResolvedInputs
): Effect.Effect<JsonRecord, OperationFailure> {
	const assignments: Assignment[] = [
		...inputs.arguments.flatMap((argument, index) =>
			Option.toArray(parsed.args[index] ?? Option.none()).map((value) => ({
				partition: partitionOf('path'),
				key: argument.name,
				value
			}))
		),
		...inputs.flags.flatMap((flag, index) =>
			Option.toArray(parsed.flags[index] ?? Option.none()).map((value) => ({
				partition: partitionOf(flag.target),
				key: flag.key,
				value
			}))
		)
	];
	const envelope: Record<string, Schema.Json> = { ...base };
	const conflicts = new Set<string>();
	for (const { partition, key, value } of assignments) {
		const current = envelope[partition];
		const record = current === undefined ? Option.some({}) : asJsonRecord(current);
		if (Option.isNone(record)) {
			conflicts.add(partition);
			continue;
		}
		envelope[partition] = { ...record.value, [key]: value };
	}
	return conflicts.size === 0
		? Effect.succeed(envelope)
		: Effect.fail(
				new OperationFailure({
					operationId: operation.id,
					reason: 'input',
					issues: [...conflicts].map((partition) => ({
						path: [partition],
						message: 'Expected a JSON object to merge flags into'
					}))
				})
			);
}

function successEnvelope(
	context: OperationCommandContext,
	result: ApiResult
): RenderEnvelope<CliFailure> {
	if (result._tag === 'Stream') {
		return {
			command: context.command,
			stream: result.stream.pipe(Stream.mapError(toCliFailure(context)))
		};
	}
	const nextSteps = successNextSteps(context, result.value);
	return {
		command: context.command,
		data: result.value,
		...(nextSteps.length === 0 ? {} : { next_steps: nextSteps })
	};
}

/** Follow-ups a person would type next: poll a returned Operation, fetch the next page. */
function successNextSteps(context: OperationCommandContext, value: Schema.Json): NextStep[] {
	if (!Predicate.isObject(value)) return [];
	const steps: NextStep[] = [];
	if (Predicate.isString(value.id) && value.id.startsWith('op_') && value.done === false) {
		steps.push({
			command: `akua operations wait ${value.id}`,
			description: 'Wait for it to finish; repeat while done is false.'
		});
	}
	if (
		value.has_more === true &&
		Predicate.isString(value.next_cursor) &&
		context.inputs.flags.some((flag) => flag.name === 'cursor')
	) {
		steps.push({
			command: `${context.command} --cursor ${value.next_cursor}`,
			description: 'Show the next page.'
		});
	}
	return steps;
}
