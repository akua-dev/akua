import { Cache, Context, Effect, Exit, Layer, Schema } from 'effect';
import { Base64 } from 'effect/encoding';

export class RouteTokenCryptoError extends Schema.TaggedError<
	RouteTokenCryptoError,
	{ readonly brand: unique symbol }
>()('RouteTokenCryptoError', {
	operation: Schema.Literals([
		'private_key_import',
		'public_key_import',
		'sign',
		'verify',
		'random_uuid'
	]),
	cause: Schema.Defect()
}) {}

const fromWebCrypto = <Value>(
	operation: RouteTokenCryptoError['operation'],
	start: () => Promise<Value>
): Effect.Effect<Value, RouteTokenCryptoError> =>
	Effect.tryPromise({
		try: start,
		catch: (cause) => new RouteTokenCryptoError({ operation, cause })
	});

function pemToBytes(
	pem: string,
	operation: 'private_key_import' | 'public_key_import'
): Effect.Effect<Uint8Array<ArrayBuffer>, RouteTokenCryptoError> {
	const base64 = pem
		.split('\n')
		.filter((line) => !line.startsWith('-----'))
		.join('')
		.replace(/\s/g, '');
	return Effect.fromResult(Base64.decode(base64)).pipe(
		Effect.map((bytes) => Uint8Array.from(bytes)),
		Effect.mapError((cause) => new RouteTokenCryptoError({ operation, cause }))
	);
}

const cacheTimeToLive = (exit: Exit.Exit<CryptoKey, RouteTokenCryptoError>) =>
	Exit.isSuccess(exit) ? '1 hour' : 0;

export class RouteTokenCrypto extends Context.Service<
	RouteTokenCrypto,
	{
		readonly signEs256: (
			privateKeyPem: string,
			signingInput: Uint8Array
		) => Effect.Effect<Uint8Array, RouteTokenCryptoError>;
		readonly verifyEs256: (
			publicKeyPem: string,
			signingInput: Uint8Array,
			signature: Uint8Array
		) => Effect.Effect<boolean, RouteTokenCryptoError>;
		readonly randomUuid: Effect.Effect<string, RouteTokenCryptoError>;
	}
>()('platform/hostname-route-token/RouteTokenCrypto') {
	static readonly layer = Layer.effect(
		RouteTokenCrypto,
		Effect.gen(function* () {
			const privateKeys = yield* Cache.makeWith(
				Effect.fn('RouteTokenCrypto.importPrivateKey')(function* (pem: string) {
					const bytes = yield* pemToBytes(pem, 'private_key_import');
					return yield* fromWebCrypto('private_key_import', () =>
						crypto.subtle.importKey(
							'pkcs8',
							bytes.buffer,
							{ name: 'ECDSA', namedCurve: 'P-256' },
							false,
							['sign']
						)
					);
				}),
				{ capacity: 4, timeToLive: cacheTimeToLive }
			);
			const publicKeys = yield* Cache.makeWith(
				Effect.fn('RouteTokenCrypto.importPublicKey')(function* (pem: string) {
					const bytes = yield* pemToBytes(pem, 'public_key_import');
					return yield* fromWebCrypto('public_key_import', () =>
						crypto.subtle.importKey(
							'spki',
							bytes.buffer,
							{ name: 'ECDSA', namedCurve: 'P-256' },
							false,
							['verify']
						)
					);
				}),
				{ capacity: 4, timeToLive: cacheTimeToLive }
			);

			return RouteTokenCrypto.of({
				signEs256: Effect.fn('RouteTokenCrypto.signEs256')(function* (privateKeyPem, signingInput) {
					const key = yield* Cache.get(privateKeys, privateKeyPem);
					const signature = yield* fromWebCrypto('sign', () =>
						crypto.subtle.sign(
							{ name: 'ECDSA', hash: 'SHA-256' },
							key,
							Uint8Array.from(signingInput).buffer
						)
					);
					return new Uint8Array(signature);
				}),
				verifyEs256: Effect.fn('RouteTokenCrypto.verifyEs256')(
					function* (publicKeyPem, signingInput, signature) {
						const key = yield* Cache.get(publicKeys, publicKeyPem);
						return yield* fromWebCrypto('verify', () =>
							crypto.subtle.verify(
								{ name: 'ECDSA', hash: 'SHA-256' },
								key,
								Uint8Array.from(signature).buffer,
								Uint8Array.from(signingInput).buffer
							)
						);
					}
				),
				randomUuid: Effect.try({
					try: () => crypto.randomUUID(),
					catch: (cause) => new RouteTokenCryptoError({ operation: 'random_uuid', cause })
				})
			});
		})
	);
}
