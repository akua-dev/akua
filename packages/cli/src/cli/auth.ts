import { Clock, Duration, Effect, Option, Redacted, Schema } from 'effect';
import { Command, Flag } from 'effect/cli';
import { HttpClient, HttpClientRequest } from 'effect/http';

import {
	authenticationBaseUrl,
	type CredentialSource,
	optionalEnv,
	requiredConfigPath,
	resolveCredential
} from '../runtime/credentials';
import {
	DeviceAuthorizationFailure,
	DeviceCancelledFailure,
	DeviceRequestFailure,
	type CliFailure
} from '../runtime/effect-runtime';
import { AkuaCliError, UsageFailure } from '../runtime/errors';
import type { RenderEnvelope } from '../runtime/render';
import { Browser, Console, Http, Process, SecureConfig } from '../runtime/services';
import { respond } from './invocation';

const DEVICE_CLIENT_ID = 'akua-cli';
const DEVICE_SCOPE = 'platform';
const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

interface AuthStatus {
	authenticated: boolean;
	source: CredentialSource;
	config_path?: string;
	account?: typeof Account.Type;
}

// Better Auth's existing get-session response, not claims decoded from an opaque token.
const Account = Schema.Struct({
	id: Schema.NonEmptyString,
	name: Schema.optionalKey(Schema.String)
});
const SessionIdentity = Schema.Struct({ user: Account });

interface DeviceLoginDetails {
	verification_uri_complete: string;
	user_code: string;
}

const PositiveFinite = Schema.Finite.check(Schema.isGreaterThan(0));
const DeviceCodeResponse = Schema.Struct({
	device_code: Schema.NonEmptyString,
	user_code: Schema.NonEmptyString,
	verification_uri: Schema.NonEmptyString,
	verification_uri_complete: Schema.optionalKey(Schema.NonEmptyString),
	expires_in: PositiveFinite,
	interval: Schema.optionalKey(PositiveFinite)
});
type DeviceCodeResponse = typeof DeviceCodeResponse.Type;
const decodeDeviceCode = Schema.decodeUnknownOption(DeviceCodeResponse);
const DeviceTokenResponse = Schema.Struct({ access_token: Schema.NonEmptyString });
const decodeDeviceToken = Schema.decodeUnknownOption(DeviceTokenResponse);
const DeviceErrorResponse = Schema.Struct({ error: Schema.String });
const decodeDeviceError = Schema.decodeUnknownOption(DeviceErrorResponse);

interface DeviceResponse {
	status: number;
	body: unknown;
}

export interface LoginOptions {
	readonly token: Option.Option<string>;
	readonly noBrowser: boolean;
}

interface DeviceLoginResult {
	token: string;
	details?: DeviceLoginDetails;
	observations: string[];
}

export const authCommands = [
	Command.make(
		'login',
		{
			noBrowser: Flag.Boolean('no-browser').pipe(
				Flag.withDefault(false),
				Flag.withDescription('Print the verification URL instead of opening a browser')
			),
			token: Flag.String('token').pipe(
				Flag.optional,
				Flag.withDescription('Save an existing API token instead (for automation)')
			)
		},
		(options) => respond(login(options))
	).pipe(
		Command.withDescription('Sign in with your browser and save the access token'),
		Command.withExamples([
			{ command: 'akua auth login', description: 'Open the browser to approve this device' },
			{
				command: 'akua auth login --no-browser',
				description: 'On a remote machine: open the printed URL elsewhere'
			}
		])
	),
	Command.make('status', {}, () => respond(status)).pipe(
		Command.withDescription('Show which credential the CLI uses')
	),
	Command.make('logout', {}, () => respond(logout)).pipe(
		Command.withDescription('Remove the saved credential')
	)
];

export const authCommand = Command.make('auth').pipe(
	Command.withDescription('Sign in, check, or remove the credential the CLI uses'),
	Command.withSubcommands(authCommands)
);

type AuthServices = Http | Browser | Process | Console | SecureConfig;

export const login = Effect.fnUntraced(function* (
	options: LoginOptions
): Effect.fn.Return<RenderEnvelope, CliFailure, AuthServices> {
	if (Option.isSome(options.token) && options.token.value === '') {
		return yield* new UsageFailure({ message: 'Missing value for --token.' });
	}
	const path = yield* requiredConfigPath;
	const result: DeviceLoginResult = Option.isSome(options.token)
		? { token: options.token.value, observations: [] }
		: yield* runDeviceLogin(options.noBrowser);
	const config = yield* SecureConfig;
	const workspaceCleared = yield* config.saveToken(path, result.token);
	return {
		command: 'akua auth login',
		observations: [
			...result.observations,
			'Authentication token saved.',
			...(workspaceCleared
				? [
						'Saved Workspace cleared because the credential changed. Run akua workspaces use <name>.'
					]
				: [])
		],
		data: {
			authenticated: true,
			source: 'config',
			config_path: path,
			...result.details
		} satisfies AuthStatus,
		next_steps: [
			{ command: 'akua workspaces list', description: 'See your workspaces.' },
			{ command: 'akua workspaces use <name>', description: 'Choose one for later commands.' }
		]
	} satisfies RenderEnvelope;
});

export const status: Effect.Effect<
	RenderEnvelope,
	CliFailure,
	SecureConfig | HttpClient.HttpClient
> = Effect.gen(function* () {
	const credential = yield* resolveCredential;
	const account = Option.isSome(credential.token)
		? yield* verifiedAccount(credential.token.value)
		: undefined;
	const authenticated = account !== undefined;
	const observation =
		account === undefined
			? statusObservation(credential.source)
			: `${statusObservation(credential.source)} Account: ${account.name ? `${account.name} (${account.id})` : account.id}.`;
	return {
		command: 'akua auth status',
		observations: [observation],
		human: [observation, ...Option.toArray(credential.configPath).map((path) => `Config: ${path}`)],
		data: {
			authenticated,
			source: credential.source,
			config_path: Option.getOrUndefined(credential.configPath),
			...(account === undefined ? {} : { account })
		} satisfies AuthStatus,
		...(authenticated ? {} : { next_steps: [{ command: 'akua auth login' }] })
	};
});

const verifiedAccount = Effect.fnUntraced(function* (token: Redacted.Redacted<string>) {
	const unavailable = (cause?: unknown) =>
		Object.defineProperty(
			new AkuaCliError({
				type: 'authentication_error',
				code: 'AKUA_IDENTITY_UNAVAILABLE',
				message:
					'Could not verify the signed-in account. Check connectivity and AKUA_AUTH_URL, or run akua auth login.',
				exitCode: 3,
				nextSteps: [{ command: 'akua auth login' }]
			}),
			'cause',
			{ value: cause }
		);
	const client = yield* HttpClient.HttpClient;
	const baseUrl = yield* authenticationBaseUrl;
	const response = yield* client
		.execute(
			HttpClientRequest.get(`${baseUrl}/get-session`).pipe(
				HttpClientRequest.bearerToken(Redacted.value(token))
			)
		)
		.pipe(Effect.mapError(unavailable));
	if (response.status !== 200) return yield* unavailable();
	const identity = yield* response.json.pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(SessionIdentity)),
		Effect.mapError(unavailable)
	);
	return identity.user;
});

export const logout: Effect.Effect<RenderEnvelope, CliFailure, SecureConfig> = Effect.gen(
	function* () {
		const path = yield* requiredConfigPath;
		const config = yield* SecureConfig;
		const hadStoredToken = yield* config.removeToken(path);
		const envStillAuthenticated = Option.isSome(yield* optionalEnv('AKUA_API_TOKEN'));
		return {
			command: 'akua auth logout',
			observations: [logoutObservation(hadStoredToken, envStillAuthenticated)],
			human: [logoutObservation(hadStoredToken, envStillAuthenticated)],
			data: {
				authenticated: envStillAuthenticated,
				source: envStillAuthenticated ? 'env' : 'none',
				config_path: path
			} satisfies AuthStatus,
			next_steps: envStillAuthenticated
				? [{ command: 'unset AKUA_API_TOKEN' }]
				: [{ command: 'akua auth login' }]
		} satisfies RenderEnvelope;
	}
);

const runDeviceLogin = Effect.fnUntraced(function* (noBrowser: boolean) {
	const process = yield* Process;
	return yield* completeDeviceLogin(noBrowser).pipe(
		Effect.raceFirst(
			process.awaitSignal.pipe(Effect.andThen(Effect.fail(new DeviceCancelledFailure({}))))
		)
	);
});

const completeDeviceLogin = Effect.fnUntraced(function* (noBrowser: boolean) {
	const baseUrl = yield* authenticationBaseUrl;
	const deviceCode = yield* requestDevice(`${baseUrl}/device/code`, {
		client_id: DEVICE_CLIENT_ID,
		scope: DEVICE_SCOPE
	}).pipe(Effect.flatMap(parseDeviceCode));
	const verificationUriComplete =
		deviceCode.verification_uri_complete ?? deviceCode.verification_uri;
	const console = yield* Console;
	yield* console.writeStderr(
		`Open ${verificationUriComplete}\nEnter code: ${deviceCode.user_code}\n`
	);
	const observations = noBrowser ? [] : yield* tryLaunchBrowser(verificationUriComplete);
	const startedAt = yield* Clock.currentTimeMillis;
	const token = yield* pollForDeviceToken(
		deviceCode,
		startedAt + deviceCode.expires_in * 1_000,
		(deviceCode.interval ?? 5) * 1_000
	);
	return {
		token,
		details: {
			verification_uri_complete: verificationUriComplete,
			user_code: deviceCode.user_code
		},
		observations
	};
});

const pollForDeviceToken = Effect.fnUntraced(function* (
	deviceCode: DeviceCodeResponse,
	deadline: number,
	interval: number
): Effect.fn.Return<string, DeviceAuthorizationFailure | DeviceRequestFailure, Http> {
	const now = yield* Clock.currentTimeMillis;
	if (now >= deadline) return yield* new DeviceAuthorizationFailure({ reason: 'expired_token' });
	const baseUrl = yield* authenticationBaseUrl;
	const response = yield* requestDevice(`${baseUrl}/device/token`, {
		grant_type: DEVICE_GRANT_TYPE,
		device_code: deviceCode.device_code,
		client_id: DEVICE_CLIENT_ID
	});
	const token = yield* parseDeviceToken(response);
	if (token !== undefined) return token;
	const error = deviceError(response);
	if (error === 'access_denied' || error === 'expired_token') {
		return yield* new DeviceAuthorizationFailure({ reason: error });
	}
	if (error !== 'authorization_pending' && error !== 'slow_down') {
		return yield* new DeviceRequestFailure({});
	}
	const nextInterval = error === 'slow_down' ? interval + 5_000 : interval;
	if (now + nextInterval >= deadline) {
		return yield* new DeviceAuthorizationFailure({ reason: 'expired_token' });
	}
	yield* Effect.sleep(Duration.millis(nextInterval));
	return yield* pollForDeviceToken(deviceCode, deadline, nextInterval);
});

const requestDevice = Effect.fnUntraced(function* (url: string, body: Record<string, string>) {
	const http = yield* Http;
	return yield* http
		.postJson({ url, body })
		.pipe(Effect.mapError((cause) => new DeviceRequestFailure({ cause })));
});

function parseDeviceCode(response: DeviceResponse) {
	const body = decodeDeviceCode(response.body);
	return response.status < 200 || response.status >= 300 || Option.isNone(body)
		? Effect.fail(new DeviceRequestFailure({}))
		: Effect.succeed(body.value);
}

function parseDeviceToken(response: DeviceResponse) {
	if (response.status < 200 || response.status >= 300) {
		return Effect.void;
	}
	return Option.match(decodeDeviceToken(response.body), {
		onNone: () => Effect.fail(new DeviceRequestFailure({})),
		onSome: (body) => Effect.succeed(body.access_token)
	});
}

const tryLaunchBrowser = Effect.fnUntraced(function* (url: string) {
	const browser = yield* Browser;
	return yield* browser.launch(url).pipe(
		Effect.match({
			onFailure: () => ['Could not open a browser. Open the verification URL manually.'],
			onSuccess: () => []
		})
	);
});

function deviceError(response: DeviceResponse): string | undefined {
	return Option.getOrUndefined(decodeDeviceError(response.body))?.error;
}

function statusObservation(source: CredentialSource): string {
	if (source === 'env') return 'Authenticated with AKUA_API_TOKEN.';
	if (source === 'config') return 'Authenticated with stored token.';
	return 'No Akua authentication token found.';
}

function logoutObservation(hadStoredToken: boolean, envStillAuthenticated: boolean): string {
	if (envStillAuthenticated) {
		return hadStoredToken
			? 'Stored authentication token removed. AKUA_API_TOKEN is still active.'
			: 'No stored authentication token found. AKUA_API_TOKEN is still active.';
	}
	return hadStoredToken
		? 'Stored authentication token removed.'
		: 'No stored authentication token found.';
}
