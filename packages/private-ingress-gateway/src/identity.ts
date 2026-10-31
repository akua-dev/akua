import { Clock, Context, Effect, Layer, Redacted, Schema } from 'effect';
import { createRemoteJWKSet, jwtVerify } from 'jose';

/** Cluster wire identifier. The gateway needs no catalog or database dependency. */
export const ClusterId = Schema.String.check(
	Schema.isMinLength(5),
	Schema.isMaxLength(54),
	Schema.isPattern(/^clu_/)
);

const Issuer = Schema.URLFromString.check(
	Schema.makeFilter(
		(url) =>
			['https:', 'http:'].includes(url.protocol) &&
			url.username === '' &&
			url.password === '' &&
			url.pathname === '/' &&
			url.search === '' &&
			url.hash === ''
	)
);

const Claims = Schema.Struct({
	iss: Schema.NonEmptyString,
	sub: Schema.Literal('service:domain-dispatcher'),
	aud: Schema.NonEmptyString,
	iat: Schema.Int,
	exp: Schema.Int,
	scope: Schema.String
});

export class GatewayIdentityError extends Schema.TaggedError<
	GatewayIdentityError,
	{ readonly brand: unique symbol }
>()('GatewayIdentityError', {}) {}

/** Only the dispatcher, for this Cluster, may route through this boundary. */
export class GatewayIdentityVerifier extends Context.Service<
	GatewayIdentityVerifier,
	{
		verify(
			token: Redacted.Redacted<string>
		): Effect.Effect<typeof Claims.Type, GatewayIdentityError>;
	}
>()('platform/private-ingress-gateway/GatewayIdentityVerifier') {
	static readonly layer = (config: {
		readonly issuer: string;
		readonly audience: string;
		readonly jwksUrl?: URL;
	}) =>
		Layer.effect(
			this,
			Effect.gen(function* () {
				const issuer = (yield* Schema.decodeEffect(Issuer)(config.issuer)).origin;
				const audience = config.audience;
				// Cached public keys survive a brief issuer outage. Unknown kids refresh
				// through JOSE; retiring keys must overlap the ten-minute cache window.
				const keys = createRemoteJWKSet(
					config.jwksUrl ?? new URL('/.well-known/jwks.json', issuer),
					{ cacheMaxAge: 10 * 60_000, timeoutDuration: 1000 }
				);
				return GatewayIdentityVerifier.of({
					verify: Effect.fn('GatewayIdentityVerifier.verify')(function* (token) {
						const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
						const { payload, protectedHeader } = yield* Effect.tryPromise({
							try: () =>
								jwtVerify(Redacted.value(token), keys, {
									issuer,
									audience,
									algorithms: ['ES256'],
									requiredClaims: ['iss', 'sub', 'aud', 'iat', 'exp', 'scope'],
									currentDate: new Date(now * 1000)
								}),
							catch: () => new GatewayIdentityError()
						});
						yield* Schema.decodeUnknownEffect(Schema.Struct({ kid: Schema.NonEmptyString }))(
							protectedHeader
						).pipe(Effect.mapError(() => new GatewayIdentityError()));
						const claims = yield* Schema.decodeUnknownEffect(Claims)(payload).pipe(
							Effect.mapError(() => new GatewayIdentityError())
						);
						const scopes = claims.scope.split(' ');
						if (
							claims.iss !== issuer ||
							claims.aud !== audience ||
							claims.exp <= now ||
							claims.iat > now ||
							claims.exp - claims.iat > 60 ||
							!scopes.includes('gateway:route') ||
							scopes.some((scope) => scope !== 'gateway:route')
						)
							return yield* new GatewayIdentityError();
						return claims;
					})
				});
			})
		);
}
