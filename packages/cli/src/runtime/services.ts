import { Context, Effect, Schema, type Stream } from 'effect';
import type { HttpClient } from 'effect/http';

export interface HttpResponse {
	readonly status: number;
	readonly body: unknown;
}

export interface JsonHttpRequest {
	readonly url: string;
	readonly body: Readonly<Record<string, string>>;
}

export class HttpFailure extends Schema.TaggedError<HttpFailure>()('HttpFailure', {
	cause: Schema.Defect()
}) {}

export class BrowserFailure extends Schema.TaggedError<BrowserFailure>()('BrowserFailure', {
	cause: Schema.Defect()
}) {}

export class SecureConfigFailure extends Schema.TaggedError<SecureConfigFailure>()(
	'SecureConfigFailure',
	{
		operation: Schema.Literals(['read', 'write', 'remove']),
		path: Schema.String,
		cause: Schema.Defect()
	}
) {}

export class PublicInputFailure extends Schema.TaggedError<PublicInputFailure>()(
	'PublicInputFailure',
	{}
) {}

export class PackageCliFailure extends Schema.TaggedError<PackageCliFailure>()(
	'PackageCliFailure',
	{ cause: Schema.Defect() }
) {}

export class Http extends Context.Service<
	Http,
	{
		readonly postJson: (request: JsonHttpRequest) => Effect.Effect<HttpResponse, HttpFailure>;
	}
>()('platform/cli/Http') {}

export class Browser extends Context.Service<
	Browser,
	{
		readonly launch: (url: string) => Effect.Effect<void, BrowserFailure>;
	}
>()('platform/cli/Browser') {}

export class Process extends Context.Service<
	Process,
	{
		readonly awaitSignal: Effect.Effect<void>;
	}
>()('platform/cli/Process') {}

export class Console extends Context.Service<
	Console,
	{
		readonly stdoutIsTTY: boolean;
		/** Whether a person can answer a prompt: stdin is a terminal. */
		readonly stdinIsTTY: boolean;
		readonly writeStderr: (value: string) => Effect.Effect<void>;
		readonly writeStdout: (value: string) => Effect.Effect<void>;
		/** Raw bytes, for operations whose response is a file. */
		readonly writeStdoutBytes: (value: Uint8Array) => Effect.Effect<void>;
	}
>()('platform/cli/Console') {}

/** The workspace `akua workspaces use` saved, under `workspace` in the config file. */
export const StoredWorkspace = Schema.Struct({
	id: Schema.String,
	name: Schema.optionalKey(Schema.String)
});
export type StoredWorkspace = typeof StoredWorkspace.Type;

/**
 * The selected user-only config file. Writes are atomic and keep
 * keys this CLI version does not know.
 */
export class SecureConfig extends Context.Service<
	SecureConfig,
	{
		readonly readToken: (path: string) => Effect.Effect<string | undefined, SecureConfigFailure>;
		readonly saveToken: (path: string, token: string) => Effect.Effect<void, SecureConfigFailure>;
		readonly removeToken: (path: string) => Effect.Effect<boolean, SecureConfigFailure>;
		readonly readWorkspace: (
			path: string
		) => Effect.Effect<StoredWorkspace | undefined, SecureConfigFailure>;
		readonly saveWorkspace: (
			path: string,
			workspace: StoredWorkspace
		) => Effect.Effect<void, SecureConfigFailure>;
		readonly removeWorkspace: (path: string) => Effect.Effect<boolean, SecureConfigFailure>;
	}
>()('platform/cli/SecureConfig') {}

export class PublicInput extends Context.Service<
	PublicInput,
	{
		readonly read: (source: '-' | string) => Effect.Effect<string, PublicInputFailure>;
		/** The raw bytes of a file, or of stdin for `-`. */
		readonly readBytes: (source: '-' | string) => Effect.Effect<Uint8Array, PublicInputFailure>;
	}
>()('platform/cli/PublicInput') {}

export class PublicOutputFailure extends Schema.TaggedError<PublicOutputFailure>()(
	'PublicOutputFailure',
	{}
) {}

export class PublicOutput extends Context.Service<
	PublicOutput,
	{
		/** Writes the stream to a file, replacing it, and returns the number of bytes written. */
		readonly writeFile: <E>(
			path: string,
			bytes: Stream.Stream<Uint8Array, E>
		) => Effect.Effect<number, E | PublicOutputFailure>;
	}
>()('platform/cli/PublicOutput') {}

export class PackageCli extends Context.Service<
	PackageCli,
	{
		readonly execute: (args: readonly string[]) => Effect.Effect<number, PackageCliFailure>;
	}
>()('platform/cli/PackageCli') {}

export type CliServices =
	| Http
	| HttpClient.HttpClient
	| Browser
	| Process
	| Console
	| SecureConfig
	| PublicInput
	| PublicOutput
	| PackageCli;
