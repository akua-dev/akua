import { Context, Effect, Schema } from 'effect';

export class ScriptHostFailure extends Schema.TaggedError<ScriptHostFailure>()(
	'ScriptHostFailure',
	{
		cause: Schema.Defect()
	}
) {}

export class ScriptValidationFailure extends Schema.TaggedError<ScriptValidationFailure>()(
	'ScriptValidationFailure',
	{ message: Schema.String }
) {}

export class ScriptHttp extends Context.Service<
	ScriptHttp,
	{
		readonly getJson: (url: URL) => Effect.Effect<unknown, ScriptHostFailure>;
	}
>()('platform/scripts/Http') {}

export class ScriptFiles extends Context.Service<
	ScriptFiles,
	{
		readonly readText: (path: string) => Effect.Effect<string, ScriptHostFailure>;
		readonly writeText: (path: string, contents: string) => Effect.Effect<void, ScriptHostFailure>;
	}
>()('platform/scripts/Files') {}

export class ScriptEnvironment extends Context.Service<
	ScriptEnvironment,
	{
		readonly openApiUrl: Effect.Effect<string | undefined>;
	}
>()('platform/scripts/Environment') {}
