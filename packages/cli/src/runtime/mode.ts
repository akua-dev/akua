import { Config, Effect, Option } from 'effect';

import { UsageFailure } from './effect-runtime';

export type OutputMode = 'human' | 'agent' | 'json' | 'quiet';

export interface OutputModeInput {
	readonly argv: readonly string[];
	readonly stdoutIsTTY?: boolean | undefined;
}

const AGENT_ENV_VARS = [
	'AGENT',
	'CODEX_SANDBOX',
	'CODEX_CLI',
	'OPENAI_CODEX',
	'CLAUDECODE',
	'CLAUDE_CODE',
	'CURSOR_AGENT',
	'AIDER',
	'DEVIN',
	'OPENCODE',
	'AMP',
	'CODY_AGENT',
	'REPLIT_AGENT',
	'WINDSURF_AGENT'
];

const AUTOMATION_ENV_VARS = [
	'CI',
	'GITHUB_ACTIONS',
	'GITLAB_CI',
	'BUILDKITE',
	'CIRCLECI',
	'JENKINS_URL',
	'TEAMCITY_VERSION',
	'TF_BUILD'
];

const EXPLICIT_OUTPUT_MODES: readonly OutputMode[] = ['human', 'agent', 'json', 'quiet'];

/** Flags first, then `AKUA_OUTPUT`, then agent and CI environments, then the terminal. */
export const detectOutputMode = Effect.fn('detectOutputMode')(function* (input: OutputModeInput) {
	const explicit = yield* readExplicitMode(input.argv);
	if (explicit !== undefined) return explicit;
	if ((yield* hasAnyEnv(AGENT_ENV_VARS)) || (yield* hasAnyEnv(AUTOMATION_ENV_VARS))) {
		return 'agent';
	}
	// Anything short of a confirmed terminal selects structured output.
	return input.stdoutIsTTY === true ? 'human' : 'agent';
});

/** An environment variable through the active `ConfigProvider`. */
const env = (name: string): Effect.Effect<Option.Option<string>> =>
	Config.String(name).pipe(Config.option, Effect.orDie);

export function isAutomationMode(mode: OutputMode): boolean {
	return mode === 'agent' || mode === 'json' || mode === 'quiet';
}

function readExplicitMode(
	argv: readonly string[]
): Effect.Effect<OutputMode | undefined, UsageFailure> {
	return readOutputFlag(argv).pipe(
		Effect.flatMap((outputFlag) =>
			readEnvOutputMode.pipe(
				Effect.map((envMode) => {
					if (argv.includes('--json')) {
						return 'json';
					}
					if (argv.includes('--quiet') || argv.includes('-q')) {
						return 'quiet';
					}

					return outputFlag ?? envMode;
				})
			)
		)
	);
}

function readOutputFlag(
	argv: readonly string[]
): Effect.Effect<OutputMode | undefined, UsageFailure> {
	return Effect.gen(function* () {
		let mode: OutputMode | undefined;
		for (let index = 0; index < argv.length; index += 1) {
			const value = argv[index];
			if (value === '--output' || value === '-o') {
				const raw = argv[index + 1];
				if (raw === undefined || raw === '' || raw.startsWith('-')) {
					return yield* invalidMode(
						`Missing value for ${value}. Expected one of: ${EXPLICIT_OUTPUT_MODES.join(', ')}.`
					);
				}
				mode = yield* parseOutputMode(raw);
				index += 1;
				continue;
			}
			if (value.startsWith('--output=') || value.startsWith('-o=')) {
				const [flag, raw] = splitFlagAssignment(value);
				if (raw === '') {
					return yield* invalidMode(
						`Missing value for ${flag}. Expected one of: ${EXPLICIT_OUTPUT_MODES.join(', ')}.`
					);
				}
				mode = yield* parseOutputMode(raw);
			}
		}
		return mode;
	});
}

const readEnvOutputMode: Effect.Effect<OutputMode | undefined, UsageFailure> = env(
	'AKUA_OUTPUT'
).pipe(
	Effect.flatMap(
		Option.match({
			onNone: () => Effect.succeed(undefined),
			onSome: (value) =>
				value === ''
					? invalidMode(
							`Invalid AKUA_OUTPUT value: . Expected one of: ${EXPLICIT_OUTPUT_MODES.join(', ')}.`
						)
					: parseOutputMode(value, 'AKUA_OUTPUT')
		})
	)
);

function parseOutputMode(
	value: string,
	source = '--output'
): Effect.Effect<OutputMode, UsageFailure> {
	if (isOutputMode(value)) {
		return Effect.succeed(value);
	}
	return invalidMode(
		`Invalid ${source} value: ${value}. Expected one of: ${EXPLICIT_OUTPUT_MODES.join(', ')}.`
	);
}

function isOutputMode(value: string): value is OutputMode {
	return EXPLICIT_OUTPUT_MODES.some((mode) => mode === value);
}

function splitFlagAssignment(value: string): [string, string] {
	const separator = value.indexOf('=');
	return [value.slice(0, separator), value.slice(separator + 1)];
}

/** Whether any of `names` is set to something other than empty, `0`, or `false`. */
const hasAnyEnv = (names: readonly string[]): Effect.Effect<boolean> =>
	Effect.forEach(names, env).pipe(
		Effect.map((values) =>
			values.some(
				Option.exists((value) => value !== '' && value !== '0' && value.toLowerCase() !== 'false')
			)
		)
	);

function invalidMode(message: string): Effect.Effect<never, UsageFailure> {
	return Effect.fail(new UsageFailure({ message }));
}
