import { Command, Flag } from 'effect/cli';

/**
 * Flags every `akua` command accepts. Output flags are also read before
 * parsing (see `detectOutputMode`) so parse errors render in the right mode.
 */
export const globalFlags = {
	workspace: Flag.String('workspace').pipe(
		Flag.withAlias('w'),
		Flag.optional,
		Flag.withDescription(
			'Workspace name, slug, or ID for this command (overrides AKUA_WORKSPACE and the saved workspace)'
		)
	),
	output: Flag.Literals('output', ['human', 'agent', 'json', 'quiet']).pipe(
		Flag.withAlias('o'),
		Flag.optional,
		Flag.withDescription('Output format (default: human on a terminal, agent otherwise)')
	),
	json: Flag.Boolean('json').pipe(
		Flag.withDefault(false),
		Flag.withDescription('Write the result as JSON (same as --output json)')
	),
	quiet: Flag.Boolean('quiet').pipe(
		Flag.withAlias('q'),
		Flag.withDefault(false),
		Flag.withDescription('Write nothing on success')
	)
};

/** The root command; subcommand handlers read the global flags by yielding it. */
export const akua = Command.make('akua').pipe(
	Command.withSharedFlags(globalFlags),
	Command.withDescription(
		'Create clusters, add machines, install apps, and package software on Akua.'
	),
	Command.withExamples([
		{ command: 'akua auth login', description: 'Sign in with your browser' },
		{
			command: 'akua workspaces use my-team',
			description: 'Choose the workspace for later commands'
		},
		{ command: 'akua clusters list', description: 'List clusters in the active workspace' },
		{ command: 'akua clusters create --help', description: 'See the flags a command takes' },
		{
			command: 'akua commands --json',
			description: 'Discover every API operation (for scripts and agents)'
		}
	])
);
