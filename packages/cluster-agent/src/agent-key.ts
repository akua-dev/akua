import { Effect, Redacted, Schema } from 'effect';
import { Base64Url } from 'effect/encoding';
import {
	ClusterConnectorPublicKey,
	ClientAssertion
} from '@platform/api-contract/services/ClusterConnector';

/**
 * The agent's own Ed25519 key: generated in the cluster, stored only in
 * `akua-system/akua-agent-identity` as a private JWK, and used to sign
 * RFC 7523 client assertions. Identity only ever sees the public JWK.
 */
export class AgentKeyError extends Schema.TaggedError<AgentKeyError>()('AgentKeyError', {
	operation: Schema.Literals(['generate', 'import', 'sign']),
	cause: Schema.Defect()
}) {}

const PrivateJwk = Schema.Struct({
	kty: Schema.Literal('OKP'),
	crv: Schema.Literal('Ed25519'),
	x: Schema.NonEmptyString,
	d: Schema.NonEmptyString
});
const PrivateJwkJson = Schema.fromJsonString(PrivateJwk);

export interface AgentKey {
	readonly privateKey: CryptoKey;
	readonly publicKey: typeof ClusterConnectorPublicKey.Type;
	/** The private JWK as stored in the identity Secret. */
	readonly serialized: Redacted.Redacted<string>;
}

const textEncoder = new TextEncoder();

/** RFC 7638 thumbprint over the required members in lexicographic order. */
const thumbprint = Effect.fnUntraced(function* (x: string) {
	const canonical = JSON.stringify({ crv: 'Ed25519', kty: 'OKP', x });
	const digest = yield* Effect.tryPromise({
		try: () => crypto.subtle.digest('SHA-256', textEncoder.encode(canonical)),
		catch: (cause) => new AgentKeyError({ operation: 'import', cause })
	});
	return Base64Url.encode(new Uint8Array(digest));
});

const fromJwk = Effect.fnUntraced(function* (jwk: typeof PrivateJwk.Type) {
	const privateKey = yield* Effect.tryPromise({
		try: () => crypto.subtle.importKey('jwk', { ...jwk }, { name: 'Ed25519' }, false, ['sign']),
		catch: (cause) => new AgentKeyError({ operation: 'import', cause })
	});
	const kid = yield* thumbprint(jwk.x);
	const publicKey: typeof ClusterConnectorPublicKey.Type = {
		kty: 'OKP',
		crv: 'Ed25519',
		x: jwk.x,
		kid
	};
	return {
		privateKey,
		publicKey,
		serialized: Redacted.make(JSON.stringify(jwk))
	} satisfies AgentKey;
});

export const generateAgentKey = Effect.fn('AgentKey.generate')(function* () {
	const pair = yield* Effect.tryPromise({
		try: () => crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']),
		catch: (cause) => new AgentKeyError({ operation: 'generate', cause })
	});
	const exported = yield* Effect.tryPromise({
		try: () => crypto.subtle.exportKey('jwk', pair.privateKey),
		catch: (cause) => new AgentKeyError({ operation: 'generate', cause })
	});
	const jwk = yield* Schema.decodeUnknownEffect(PrivateJwk)(exported).pipe(
		Effect.mapError((cause) => new AgentKeyError({ operation: 'generate', cause }))
	);
	return yield* fromJwk(jwk);
});

export const importAgentKey = Effect.fn('AgentKey.import')(function* (
	serialized: Redacted.Redacted<string>
) {
	const jwk = yield* Schema.decodeUnknownEffect(PrivateJwkJson)(Redacted.value(serialized)).pipe(
		Effect.mapError((cause) => new AgentKeyError({ operation: 'import', cause }))
	);
	return yield* fromJwk(jwk);
});

/** At most 60 s, per the ClientAssertion contract. */
export const assertionLifetimeSeconds = 60;

/** A compact EdDSA JWT: iss = sub = agent ID, unique jti, exp = iat + 60 s. */
export const signAssertion = Effect.fn('AgentKey.signAssertion')(function* (args: {
	readonly key: AgentKey;
	readonly agentId: string;
	readonly audience: string;
	readonly nowMillis: number;
}) {
	const iat = Math.floor(args.nowMillis / 1000);
	const header = Base64Url.encode(
		JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid: args.key.publicKey.kid })
	);
	const claims = Base64Url.encode(
		JSON.stringify({
			iss: args.agentId,
			sub: args.agentId,
			aud: args.audience,
			iat,
			exp: iat + assertionLifetimeSeconds,
			jti: crypto.randomUUID()
		})
	);
	const signingInput = `${header}.${claims}`;
	const signature = yield* Effect.tryPromise({
		try: () =>
			crypto.subtle.sign(
				{ name: 'Ed25519' },
				args.key.privateKey,
				textEncoder.encode(signingInput)
			),
		catch: (cause) => new AgentKeyError({ operation: 'sign', cause })
	});
	return ClientAssertion.make(
		Redacted.make(`${signingInput}.${Base64Url.encode(new Uint8Array(signature))}`)
	);
});
