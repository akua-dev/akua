import { Clock, Effect, Redacted, Schema } from 'effect';
import { Base64Url } from 'effect/encoding';
import { imageCredentialUsername } from './KubeletInstall';
import { AuthConfig } from './generated/kubelet/1.35.8/AuthConfig';
import { CredentialProviderRequest as KubeletRequest } from './generated/kubelet/1.35.8/CredentialProviderRequest';
import { CredentialProviderResponse as KubeletResponse } from './generated/kubelet/1.35.8/CredentialProviderResponse';

const FailureMessage = Schema.Literals([
	'Credential request is too large',
	'Invalid kubelet credential request',
	'A valid unexpired Pod ServiceAccount token is required',
	'Unable to encode credential response',
	'Invalid image credential registry configuration',
	'Unable to read credential request',
	'Unable to write credential response',
	'Unexpected image credential provider failure'
]);

/** Only this allowlisted diagnostic is exposed on stderr, never the internal cause. */
export const CredentialProviderDiagnostic = Schema.fromJsonString(
	Schema.Struct({ error: FailureMessage })
);

export class CredentialProviderFailure extends Schema.TaggedError<
	CredentialProviderFailure,
	{ readonly brand: unique symbol }
>()('CredentialProviderFailure', {
	message: FailureMessage,
	cause: Schema.optional(Schema.Defect())
}) {}

const apiVersion = Schema.Literal('credentialprovider.kubelet.k8s.io/v1');

/** What the kubelet writes to stdin (credentialprovider.kubelet.k8s.io/v1, KEP-4412 token fields). */
export const CredentialProviderRequest = Schema.Struct({
	...KubeletRequest.fields,
	apiVersion,
	kind: Schema.Literal('CredentialProviderRequest'),
	image: Schema.NonEmptyString.check(Schema.isMaxLength(1024)),
	serviceAccountToken: Schema.optionalKey(
		Schema.RedactedFromValue(Schema.String.check(Schema.isMaxLength(32768)))
	)
} satisfies Record<keyof typeof KubeletRequest.fields, Schema.Top>);

export const CredentialProviderResponse = Schema.Struct({
	...KubeletResponse.fields,
	apiVersion,
	kind: Schema.Literal('CredentialProviderResponse'),
	cacheKeyType: Schema.Literal('Registry'),
	cacheDuration: Schema.String.check(Schema.isPattern(/^[0-9]+s$/)),
	auth: Schema.Record(
		Schema.String,
		Schema.Struct({
			...AuthConfig.fields,
			username: Schema.Literal(imageCredentialUsername),
			password: Schema.RedactedFromValue(Schema.String)
		} satisfies Record<keyof typeof AuthConfig.fields, Schema.Top>)
	)
} satisfies Record<keyof typeof KubeletResponse.fields, Schema.Top>);

const RequestJson = Schema.fromJsonString(Schema.toCodecJson(CredentialProviderRequest));
const ResponseJson = Schema.fromJsonString(Schema.toCodecJson(CredentialProviderResponse));

const CompactJwt = Schema.String.check(
	Schema.isPattern(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
);
const Expiry = Schema.fromJsonString(
	Schema.Struct({ exp: Schema.Int.check(Schema.isGreaterThan(0)) })
);
const invalidToken = (cause?: unknown) =>
	new CredentialProviderFailure({
		message: 'A valid unexpired Pod ServiceAccount token is required',
		cause
	});

/**
 * Answers one kubelet request: for an image on `registry`, the Pod's own
 * ServiceAccount token as the password, cached no longer than the token
 * lives; for any other image, no credential, as the kubelet's own match is
 * not trusted alone. It reads `exp` only to bound that cache; the registry
 * verifies signature, issuer, audience and grant.
 */
export const provideCredential = Effect.fnUntraced(function* (input: string, registry: string) {
	if (input.length > 65536)
		return yield* new CredentialProviderFailure({ message: 'Credential request is too large' });
	const request = yield* Schema.decodeEffect(RequestJson)(input, {
		onExcessProperty: 'error'
	}).pipe(
		Effect.mapError(
			(cause) =>
				new CredentialProviderFailure({ message: 'Invalid kubelet credential request', cause })
		)
	);
	let response: typeof CredentialProviderResponse.Type = {
		apiVersion: request.apiVersion,
		kind: 'CredentialProviderResponse',
		cacheKeyType: 'Registry',
		cacheDuration: '0s',
		auth: {}
	};
	const [host, ...path] = request.image.split('/');
	if (host === registry && path.length > 0) {
		if (request.serviceAccountToken === undefined) return yield* invalidToken();
		const token = yield* Schema.decodeEffect(CompactJwt)(
			Redacted.value(request.serviceAccountToken)
		).pipe(Effect.mapError(invalidToken));
		const claims = yield* Effect.fromResult(Base64Url.decodeString(token.split('.')[1] ?? '')).pipe(
			Effect.mapError(invalidToken)
		);
		const { exp } = yield* Schema.decodeEffect(Expiry)(claims).pipe(Effect.mapError(invalidToken));
		const seconds = Math.floor(exp - (yield* Clock.currentTimeMillis) / 1000);
		if (seconds <= 0) return yield* invalidToken();
		response = {
			...response,
			cacheDuration: `${seconds}s`,
			auth: {
				[registry]: {
					username: imageCredentialUsername,
					password: request.serviceAccountToken
				}
			}
		};
	}
	return yield* Schema.encodeEffect(ResponseJson)(response, { onExcessProperty: 'error' }).pipe(
		Effect.mapError(
			(cause) =>
				new CredentialProviderFailure({ message: 'Unable to encode credential response', cause })
		)
	);
});
