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

/** `~/.config/akua/config.json`, or none when `HOME` is unset. */
export const configPath: Effect.Effect<Option.Option<string>> = optionalEnv('HOME').pipe(
	Effect.map(Option.map((home) => `${home}/.config/akua/config.json`))
);

/** The config file path for commands that write it; fails with a usage error without `HOME`. */
export const requiredConfigPath: Effect.Effect<string, UsageFailure> = configPath.pipe(
	Effect.flatMap(
		Option.match({
			onNone: () =>
				Effect.fail(
					new UsageFailure({ message: 'HOME is required to locate ~/.config/akua/config.json.' })
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
