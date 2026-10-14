import { Config, Effect, Option, Redacted } from 'effect';

import { UsageFailure } from './effect-runtime';
import { SecureConfig, type SecureConfigFailure } from './services';

/** Reads an environment variable through the active `ConfigProvider`; empty counts as unset. */
export function optionalEnv(name: string): Effect.Effect<Option.Option<string>> {
	return Config.String(name).pipe(
		Config.option,
		Config.map(Option.filter((value) => value !== '')),
		Effect.orDie
	);
}

/** One config for both credentials and workspace context; never fall back across profiles. */
export const configPath: Effect.Effect<Option.Option<string>> = Effect.gen(function* () {
	const explicit = yield* optionalEnv('AKUA_CONFIG_DIR');
	if (Option.isSome(explicit)) return Option.some(`${explicit.value}/config.json`);
	const xdg = yield* optionalEnv('XDG_CONFIG_HOME');
	if (Option.isSome(xdg)) return Option.some(`${xdg.value}/akua/config.json`);
	return Option.map(yield* optionalEnv('HOME'), (home) => `${home}/.config/akua/config.json`);
});

/** Commands that write config require a directory override or `HOME`. */
export const requiredConfigPath: Effect.Effect<string, UsageFailure> = configPath.pipe(
	Effect.flatMap(
		Option.match({
			onNone: () =>
				Effect.fail(
					new UsageFailure({
						message: 'Set AKUA_CONFIG_DIR, XDG_CONFIG_HOME, or HOME to locate the config file.'
					})
				),
			onSome: Effect.succeed
		})
	)
);

export type CredentialSource = 'env' | 'config' | 'none';

export interface Credential {
	readonly source: CredentialSource;
	readonly token: Option.Option<Redacted.Redacted<string>>;
	readonly configPath: Option.Option<string>;
}

/** `AKUA_API_TOKEN` wins over the token saved by `akua auth login`. */
export const resolveCredential: Effect.Effect<Credential, SecureConfigFailure, SecureConfig> =
	Effect.gen(function* () {
		const path = yield* configPath;
		const environmentToken = yield* optionalEnv('AKUA_API_TOKEN');
		if (Option.isSome(environmentToken)) {
			return {
				source: 'env',
				token: Option.some(Redacted.make(environmentToken.value)),
				configPath: path
			};
		}
		if (Option.isNone(path)) return { source: 'none', token: Option.none(), configPath: path };
		const stored = yield* (yield* SecureConfig).readToken(path.value);
		return stored === undefined
			? { source: 'none', token: Option.none(), configPath: path }
			: { source: 'config', token: Option.some(Redacted.make(stored)), configPath: path };
	});
