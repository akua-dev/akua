import { Context, Effect, Option, Schema, type Stream } from 'effect';
import type { HttpClient } from 'effect/http';

import type { ReleaseTarget } from '../../scripts/runtime/release-services';

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
	{ cause: Schema.optionalKey(Schema.Defect()) }
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
		/** Saves the token atomically, clearing a previous credential's Workspace. Returns whether it cleared one. */
		readonly saveToken: (
			path: string,
			token: string
		) => Effect.Effect<boolean, SecureConfigFailure>;
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

export class InstallationFailure extends Schema.TaggedError<InstallationFailure>()(
	'InstallationFailure',
	{
		reason: Schema.Literals(['locate', 'checksum', 'archive', 'permission', 'write', 'run']),
		message: Schema.String,
		cause: Schema.optionalKey(Schema.Defect())
	}
) {}

/** The executable this process runs from, with symlinks resolved. */
export interface RunningExecutable {
	readonly path: string;
	readonly platform: string;
	readonly arch: string;
}

/** The last release check, saved next to the config file. */
export const UpdateCheck = Schema.Struct({
	latest_version: Schema.String,
	/** Milliseconds since the epoch. */
	checked_at: Schema.Finite
});
export type UpdateCheck = typeof UpdateCheck.Type;

/** This installation of `akua`: where it runs from and how to replace it. */
export class Installation extends Context.Service<
	Installation,
	{
		readonly executable: Effect.Effect<RunningExecutable, InstallationFailure>;
		/**
		 * Verifies the release archive's SHA-256, then atomically replaces the
		 * executable at `path` with the one the archive contains.
		 */
		readonly replaceExecutable: (input: {
			readonly path: string;
			readonly target: ReleaseTarget;
			readonly archive: Uint8Array;
			readonly sha256: string;
		}) => Effect.Effect<void, InstallationFailure>;
		/**
		 * Runs a package manager and returns its exit code. Without `onOutput`
		 * it shares this terminal; with it, its output goes to `onOutput`.
		 */
		readonly run: (
			command: readonly [string, ...string[]],
			onOutput?: (text: string) => Effect.Effect<void>
		) => Effect.Effect<number, InstallationFailure>;
		/** The saved release check; a missing or unreadable file is none. */
		readonly readUpdateCheck: (path: string) => Effect.Effect<Option.Option<UpdateCheck>>;
		readonly saveUpdateCheck: (
			path: string,
			check: UpdateCheck
		) => Effect.Effect<void, InstallationFailure>;
	}
>()('platform/cli/Installation') {}

export type CliServices =
	| Installation
	| Http
	| HttpClient.HttpClient
	| Browser
	| Process
	| Console
	| SecureConfig
	| PublicInput
	| PublicOutput
	| PackageCli;
