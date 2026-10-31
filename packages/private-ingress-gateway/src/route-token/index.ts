import { Effect, Schema } from 'effect';
import {
	ORIGIN_ROUTE_WIRE_ID_MESSAGE,
	ORIGIN_ROUTE_WIRE_ID_PATTERN,
	toDispatcherKvKey
} from '../protocol';
import { RouteTokenCrypto, RouteTokenCryptoError } from './web-crypto';

export { RouteTokenCrypto, RouteTokenCryptoError } from './web-crypto';

export const DEFAULT_ROUTE_TOKEN_ISSUER = 'platform-hostname-dispatcher';
export const DEFAULT_ROUTE_TOKEN_AUDIENCE = 'platform-private-ingress-gateway';
export const DEFAULT_ROUTE_TOKEN_TTL_SECONDS = 30;
export const DEFAULT_DISPATCHER_PROBE_AUDIENCE = 'platform-install-reachability-probe';

const OriginRouteWireIdSchema = Schema.String.pipe(
	Schema.check(
		Schema.isPattern(ORIGIN_ROUTE_WIRE_ID_PATTERN, {
			message: ORIGIN_ROUTE_WIRE_ID_MESSAGE
		})
	)
);

const RouteTokenHeaderSchema = Schema.Struct({
	alg: Schema.Literal('ES256'),
	typ: Schema.Literal('JWT'),
	kid: Schema.optional(Schema.NonEmptyString)
});

export const RouteTokenClaimsSchema = Schema.Struct({
	iss: Schema.Literal(DEFAULT_ROUTE_TOKEN_ISSUER),
	aud: Schema.NonEmptyString,
	workspace_id: Schema.NonEmptyString,
	install_id: Schema.NonEmptyString,
	origin_route_id: OriginRouteWireIdSchema,
	public_host: Schema.NonEmptyString,
	method: Schema.NonEmptyString,
	path: Schema.String.pipe(Schema.check(Schema.isStartingWith('/'))),
	exp: Schema.Number.pipe(
		Schema.check(Schema.isInt()),
		Schema.check(Schema.isGreaterThanOrEqualTo(0))
	),
	jti: Schema.NonEmptyString
});

export type RouteTokenClaims = typeof RouteTokenClaimsSchema.Type;

export class RouteTokenValidationError extends Schema.TaggedError<
	RouteTokenValidationError,
	{ readonly brand: unique symbol }
>()('RouteTokenValidationError', {
	code: Schema.Literals([
		'missing_private_key',
		'missing_public_key',
		'malformed_compact',
		'invalid_header',
		'invalid_claims',
		'signature_mismatch',
		'expired',
		'audience_mismatch',
		'host_mismatch',
		'origin_route_mismatch',
		'method_mismatch',
		'path_mismatch'
	]),
	message: Schema.String,
	cause: Schema.optional(Schema.Defect())
}) {}

export type RouteTokenSignInput = {
	privateKeyPem: string;
	keyId?: string;
	now: number;
	ttlSeconds?: number;
	jti?: string;
	audience?: string;
	claims: Omit<RouteTokenClaims, 'iss' | 'aud' | 'exp' | 'jti'>;
};

export type RouteTokenVerifyInput = {
	publicKeyPem: string;
	now: number;
	expectedAudience?: string;
	expectedHost?: string;
	expectedOriginRouteId?: string;
	expectedMethod?: string;
	expectedPath?: string;
};

const DispatcherProbeClassificationSchema = Schema.Literals([
	'upstream',
	'not_ready',
	'not_found',
	'timeout',
	'origin_fetch_failed'
]);

export const DispatcherProbeClaimsSchema = Schema.Struct({
	iss: Schema.Literal(DEFAULT_ROUTE_TOKEN_ISSUER),
	aud: Schema.Literal(DEFAULT_DISPATCHER_PROBE_AUDIENCE),
	nonce: Schema.NonEmptyString,
	public_host: Schema.NonEmptyString,
	classification: DispatcherProbeClassificationSchema,
	status: Schema.Number.pipe(
		Schema.check(Schema.isInt()),
		Schema.check(Schema.isGreaterThanOrEqualTo(100)),
		Schema.check(Schema.isLessThanOrEqualTo(599))
	),
	exp: Schema.Number.pipe(
		Schema.check(Schema.isInt()),
		Schema.check(Schema.isGreaterThanOrEqualTo(0))
	),
	jti: Schema.NonEmptyString
});

export type DispatcherProbeClaims = typeof DispatcherProbeClaimsSchema.Type;

export class DispatcherProbeValidationError extends Schema.TaggedError<
	DispatcherProbeValidationError,
	{ readonly brand: unique symbol }
>()('DispatcherProbeValidationError', {
	code: Schema.Literals([
		'missing_private_key',
		'missing_public_key',
		'malformed_compact',
		'invalid_claims',
		'signature_mismatch',
		'expired',
		'nonce_mismatch',
		'host_mismatch',
		'status_mismatch'
	]),
	message: Schema.String,
	cause: Schema.optional(Schema.Defect())
}) {}

export type DispatcherProbeSignInput = {
	privateKeyPem: string;
	now: number;
	nonce: string;
	hostname: string;
	classification: typeof DispatcherProbeClassificationSchema.Type;
	status: number;
	ttlSeconds?: number;
	jti?: string;
};

export type DispatcherProbeVerifyInput = {
	publicKeyPem: string;
	now: number;
	expectedNonce: string;
	expectedHost: string;
	expectedStatus: number;
};

const textEncoder = new TextEncoder();
const strictParseOptions = { onExcessProperty: 'error' } as const;
const RouteTokenHeaderSegmentSchema = Schema.StringFromBase64Url.pipe(
	Schema.decodeTo(Schema.fromJsonString(RouteTokenHeaderSchema))
);
const RouteTokenClaimsSegmentSchema = Schema.StringFromBase64Url.pipe(
	Schema.decodeTo(Schema.fromJsonString(RouteTokenClaimsSchema))
);
const DispatcherProbeClaimsSegmentSchema = Schema.StringFromBase64Url.pipe(
	Schema.decodeTo(Schema.fromJsonString(DispatcherProbeClaimsSchema))
);

const validationError = (
	code: RouteTokenValidationError['code'],
	message: string,
	cause?: unknown
) => new RouteTokenValidationError({ code, message, ...(cause === undefined ? {} : { cause }) });

const invalidMessage = (code: 'invalid_header' | 'invalid_claims') =>
	`Route token ${code === 'invalid_header' ? 'header' : 'claims'} is invalid`;

const dispatcherProbeValidationError = (
	code: DispatcherProbeValidationError['code'],
	message: string,
	cause?: unknown
) =>
	new DispatcherProbeValidationError({
		code,
		message,
		...(cause === undefined ? {} : { cause })
	});

const decodeHeader = (input: unknown) =>
	Schema.decodeUnknownEffect(
		RouteTokenHeaderSchema,
		strictParseOptions
	)(input).pipe(
		Effect.mapError((cause) =>
			validationError('invalid_header', invalidMessage('invalid_header'), cause)
		)
	);

const decodeClaims = (input: unknown) =>
	Schema.decodeUnknownEffect(
		RouteTokenClaimsSchema,
		strictParseOptions
	)(input).pipe(
		Effect.mapError((cause) =>
			validationError('invalid_claims', invalidMessage('invalid_claims'), cause)
		)
	);

const encodeHeaderSegment = (input: typeof RouteTokenHeaderSchema.Type) =>
	Schema.encodeEffect(RouteTokenHeaderSegmentSchema)(input).pipe(
		Effect.mapError((cause) =>
			validationError('invalid_header', invalidMessage('invalid_header'), cause)
		)
	);

const encodeClaimsSegment = (input: RouteTokenClaims) =>
	Schema.encodeEffect(RouteTokenClaimsSegmentSchema)(input).pipe(
		Effect.mapError((cause) =>
			validationError('invalid_claims', invalidMessage('invalid_claims'), cause)
		)
	);

const decodeHeaderSegment = (input: string) =>
	Schema.decodeEffect(
		RouteTokenHeaderSegmentSchema,
		strictParseOptions
	)(input).pipe(
		Effect.mapError((cause) =>
			validationError('invalid_header', invalidMessage('invalid_header'), cause)
		)
	);

const decodeClaimsSegment = (input: string) =>
	Schema.decodeEffect(
		RouteTokenClaimsSegmentSchema,
		strictParseOptions
	)(input).pipe(
		Effect.mapError((cause) =>
			validationError('invalid_claims', invalidMessage('invalid_claims'), cause)
		)
	);

const encodeDispatcherProbeClaimsSegment = (input: DispatcherProbeClaims) =>
	Schema.encodeEffect(DispatcherProbeClaimsSegmentSchema)(input).pipe(
		Effect.mapError((cause) =>
			dispatcherProbeValidationError('invalid_claims', 'Dispatcher probe claims are invalid', cause)
		)
	);

const decodeDispatcherProbeClaimsSegment = (input: string) =>
	Schema.decodeEffect(
		DispatcherProbeClaimsSegmentSchema,
		strictParseOptions
	)(input).pipe(
		Effect.mapError((cause) =>
			dispatcherProbeValidationError('invalid_claims', 'Dispatcher probe claims are invalid', cause)
		)
	);

const encodeSignature = Schema.encodeEffect(Schema.Uint8ArrayFromBase64Url);
const decodeSignature = Schema.decodeUnknownEffect(Schema.Uint8ArrayFromBase64Url);

export const signDispatcherProbeResponse = Effect.fn('signDispatcherProbeResponse')(function* (
	input: DispatcherProbeSignInput
): Effect.fn.Return<
	string,
	RouteTokenValidationError | DispatcherProbeValidationError | RouteTokenCryptoError,
	RouteTokenCrypto
> {
	if (input.privateKeyPem.trim() === '') {
		return yield* dispatcherProbeValidationError(
			'missing_private_key',
			'Dispatcher probe private key is required'
		);
	}
	const cryptoService = yield* RouteTokenCrypto;
	const header = yield* decodeHeader({ alg: 'ES256', typ: 'JWT' });
	const jti = input.jti ?? (yield* cryptoService.randomUuid);
	const claims = yield* Schema.decodeEffect(
		DispatcherProbeClaimsSchema,
		strictParseOptions
	)({
		iss: DEFAULT_ROUTE_TOKEN_ISSUER,
		aud: DEFAULT_DISPATCHER_PROBE_AUDIENCE,
		nonce: input.nonce,
		public_host: toDispatcherKvKey(input.hostname),
		classification: input.classification,
		status: input.status,
		exp: Math.floor(input.now / 1000) + (input.ttlSeconds ?? DEFAULT_ROUTE_TOKEN_TTL_SECONDS),
		jti
	}).pipe(
		Effect.mapError((cause) =>
			dispatcherProbeValidationError('invalid_claims', 'Dispatcher probe claims are invalid', cause)
		)
	);
	const headerSegment = yield* encodeHeaderSegment(header);
	const payloadSegment = yield* encodeDispatcherProbeClaimsSegment(claims);
	const signingInput = `${headerSegment}.${payloadSegment}`;
	const signature = yield* cryptoService.signEs256(
		input.privateKeyPem,
		textEncoder.encode(signingInput)
	);
	const signatureSegment = yield* encodeSignature(signature).pipe(
		Effect.mapError((cause) =>
			dispatcherProbeValidationError(
				'signature_mismatch',
				'Dispatcher probe signature mismatch',
				cause
			)
		)
	);
	return `${signingInput}.${signatureSegment}`;
});

export const verifyDispatcherProbeResponse = Effect.fn('verifyDispatcherProbeResponse')(function* (
	token: string,
	input: DispatcherProbeVerifyInput
): Effect.fn.Return<
	DispatcherProbeClaims,
	RouteTokenValidationError | DispatcherProbeValidationError | RouteTokenCryptoError,
	RouteTokenCrypto
> {
	if (input.publicKeyPem.trim() === '') {
		return yield* dispatcherProbeValidationError(
			'missing_public_key',
			'Dispatcher probe public key is required'
		);
	}
	const [headerSegment, payloadSegment, signatureSegment, ...extraSegments] = token.split('.');
	if (
		headerSegment === undefined ||
		headerSegment === '' ||
		payloadSegment === undefined ||
		payloadSegment === '' ||
		signatureSegment === undefined ||
		signatureSegment === '' ||
		extraSegments.length > 0
	) {
		return yield* dispatcherProbeValidationError(
			'malformed_compact',
			'Dispatcher probe token must be a compact JWT'
		);
	}
	yield* decodeHeaderSegment(headerSegment);
	const cryptoService = yield* RouteTokenCrypto;
	const signature = yield* decodeSignature(signatureSegment).pipe(
		Effect.mapError((cause) =>
			dispatcherProbeValidationError(
				'signature_mismatch',
				'Dispatcher probe signature mismatch',
				cause
			)
		)
	);
	const verified = yield* cryptoService.verifyEs256(
		input.publicKeyPem,
		textEncoder.encode(`${headerSegment}.${payloadSegment}`),
		signature
	);
	if (!verified) {
		return yield* dispatcherProbeValidationError(
			'signature_mismatch',
			'Dispatcher probe signature mismatch'
		);
	}
	const claims = yield* decodeDispatcherProbeClaimsSegment(payloadSegment);
	if (claims.exp <= Math.floor(input.now / 1000)) {
		return yield* dispatcherProbeValidationError('expired', 'Dispatcher probe token expired');
	}
	if (claims.nonce !== input.expectedNonce) {
		return yield* dispatcherProbeValidationError(
			'nonce_mismatch',
			'Dispatcher probe nonce mismatch'
		);
	}
	if (claims.public_host !== toDispatcherKvKey(input.expectedHost)) {
		return yield* dispatcherProbeValidationError('host_mismatch', 'Dispatcher probe host mismatch');
	}
	if (claims.status !== input.expectedStatus) {
		return yield* dispatcherProbeValidationError(
			'status_mismatch',
			'Dispatcher probe status mismatch'
		);
	}
	return claims;
});

export const signRouteToken = Effect.fn('signRouteToken')(function* (
	input: RouteTokenSignInput
): Effect.fn.Return<string, RouteTokenValidationError | RouteTokenCryptoError, RouteTokenCrypto> {
	if (input.privateKeyPem.trim() === '') {
		return yield* validationError('missing_private_key', 'Route token private key is required');
	}
	const cryptoService = yield* RouteTokenCrypto;
	const header = yield* decodeHeader({
		alg: 'ES256',
		typ: 'JWT',
		...(input.keyId !== undefined ? { kid: input.keyId } : {})
	});
	const jti = input.jti ?? (yield* cryptoService.randomUuid);
	const claims = yield* decodeClaims({
		iss: DEFAULT_ROUTE_TOKEN_ISSUER,
		aud: input.audience ?? DEFAULT_ROUTE_TOKEN_AUDIENCE,
		...input.claims,
		public_host: toDispatcherKvKey(input.claims.public_host),
		method: input.claims.method.toUpperCase(),
		exp: Math.floor(input.now / 1000) + (input.ttlSeconds ?? DEFAULT_ROUTE_TOKEN_TTL_SECONDS),
		jti
	});
	const headerSegment = yield* encodeHeaderSegment(header);
	const payloadSegment = yield* encodeClaimsSegment(claims);
	const signingInput = `${headerSegment}.${payloadSegment}`;
	const signature = yield* cryptoService.signEs256(
		input.privateKeyPem,
		textEncoder.encode(signingInput)
	);
	const signatureSegment = yield* encodeSignature(signature).pipe(
		Effect.mapError((cause) =>
			validationError('signature_mismatch', 'Route token signature mismatch', cause)
		)
	);
	return `${signingInput}.${signatureSegment}`;
});

export const verifyRouteToken = Effect.fn('verifyRouteToken')(function* (
	token: string,
	input: RouteTokenVerifyInput
): Effect.fn.Return<
	RouteTokenClaims,
	RouteTokenValidationError | RouteTokenCryptoError,
	RouteTokenCrypto
> {
	if (input.publicKeyPem.trim() === '') {
		return yield* validationError('missing_public_key', 'Route token public key is required');
	}
	const [headerSegment, payloadSegment, signatureSegment, ...extraSegments] = token.split('.');
	if (
		headerSegment === undefined ||
		headerSegment === '' ||
		payloadSegment === undefined ||
		payloadSegment === '' ||
		signatureSegment === undefined ||
		signatureSegment === '' ||
		extraSegments.length > 0
	) {
		return yield* validationError('malformed_compact', 'Route token must be a compact JWT');
	}
	yield* decodeHeaderSegment(headerSegment);
	const cryptoService = yield* RouteTokenCrypto;
	const signature = yield* decodeSignature(signatureSegment).pipe(
		Effect.mapError((cause) =>
			validationError('signature_mismatch', 'Route token signature mismatch', cause)
		)
	);
	const verified = yield* cryptoService.verifyEs256(
		input.publicKeyPem,
		textEncoder.encode(`${headerSegment}.${payloadSegment}`),
		signature
	);
	if (!verified) {
		return yield* validationError('signature_mismatch', 'Route token signature mismatch');
	}
	const claims = yield* decodeClaimsSegment(payloadSegment);
	if (claims.exp <= Math.floor(input.now / 1000)) {
		return yield* validationError('expired', 'Route token expired');
	}
	if (input.expectedAudience !== undefined && claims.aud !== input.expectedAudience) {
		return yield* validationError('audience_mismatch', 'Route token audience mismatch');
	}
	if (
		input.expectedHost !== undefined &&
		claims.public_host !== toDispatcherKvKey(input.expectedHost)
	) {
		return yield* validationError('host_mismatch', 'Route token host mismatch');
	}
	if (
		input.expectedOriginRouteId !== undefined &&
		claims.origin_route_id !== input.expectedOriginRouteId
	) {
		return yield* validationError('origin_route_mismatch', 'Route token origin route mismatch');
	}
	if (input.expectedMethod !== undefined && claims.method !== input.expectedMethod.toUpperCase()) {
		return yield* validationError('method_mismatch', 'Route token method mismatch');
	}
	if (input.expectedPath !== undefined && claims.path !== input.expectedPath) {
		return yield* validationError('path_mismatch', 'Route token path mismatch');
	}
	return claims;
});
