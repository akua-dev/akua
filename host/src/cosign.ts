import { Effect, Option, Schema } from "effect"
import { sha256 } from "./downloads.effect"

/**
 * Keyed cosign verification (`[signing].cosign_public_key`): the simple-signing
 * payload must name the manifest digest that was fetched, and its ECDSA
 * P-256 / SHA-256 signature must verify against the configured PEM public
 * key. Offline; no Fulcio or Rekor.
 */

export class CosignInvalid extends Schema.TaggedError<CosignInvalid>()("CosignInvalid", {
  message: Schema.String
}) {}

const SimpleSigningPayload = Schema.Struct({
  critical: Schema.Struct({
    image: Schema.Struct({ "docker-manifest-digest": Schema.String })
  })
})
const decodePayload = Schema.decodeUnknownEffect(Schema.fromJsonString(SimpleSigningPayload))

const pemBody = (pem: string) =>
  pem.replace(/-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----|\s+/g, "")

/** A DER `SEQUENCE { INTEGER r, INTEGER s }` as the 64-byte `r || s` WebCrypto verifies. */
const derToRaw = (der: Uint8Array): Uint8Array | undefined => {
  if (der[0] !== 0x30) return undefined
  let offset = 2
  const integer = () => {
    if (der[offset] !== 0x02) return undefined
    const length = der[offset + 1] ?? 0
    const value = der.subarray(offset + 2, offset + 2 + length)
    offset += 2 + length
    // Strip the sign byte and left-pad to 32 bytes.
    const trimmed = value[0] === 0 ? value.subarray(1) : value
    if (trimmed.length > 32) return undefined
    const out = new Uint8Array(32)
    out.set(trimmed, 32 - trimmed.length)
    return out
  }
  const r = integer()
  const s = integer()
  if (r === undefined || s === undefined) return undefined
  const raw = new Uint8Array(64)
  raw.set(r)
  raw.set(s, 32)
  return raw
}

export const verifyKeyed = Effect.fn("verifyKeyed")(function*(request: {
  readonly publicKeyPem: string
  readonly payload: Uint8Array
  readonly signatureBase64: string
  readonly manifestDigest: string
}) {
  const invalid = (message: string) => new CosignInvalid({ message })
  const signature = yield* Effect.try({
    try: () => Uint8Array.fromBase64(request.signatureBase64.trim()),
    catch: (cause) => invalid(`signature is not valid DER/raw base64: ${String(cause)}`)
  })
  // cosign signs DER by default; older tools wrote the raw form.
  const raw = signature.length === 64 ? signature : derToRaw(signature)
  if (raw === undefined) return yield* invalid("signature is not valid DER/raw base64: unrecognised encoding")
  const payload = yield* decodePayload(new TextDecoder().decode(request.payload)).pipe(
    Effect.mapError((error) => invalid(`payload isn't the cosign simple-signing shape: ${error.message}`))
  )
  const claimed = payload.critical.image["docker-manifest-digest"]
  if (claimed !== request.manifestDigest) {
    return yield* invalid(
      `payload claims digest \`${claimed}\`, but we fetched \`${request.manifestDigest}\` - signature is for a ` +
        "different artifact"
    )
  }
  const key = yield* Effect.tryPromise({
    try: () =>
      crypto.subtle.importKey(
        "spki",
        Uint8Array.fromBase64(pemBody(request.publicKeyPem)),
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["verify"]
      ),
    catch: (cause) => invalid(`public key is not a valid PEM-encoded P-256 ECDSA key: ${String(cause)}`)
  })
  const verified = yield* Effect.tryPromise({
    try: () => crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, new Uint8Array(raw), new Uint8Array(request.payload)),
    catch: (cause) => invalid(`signature does not verify against the supplied public key: ${String(cause)}`)
  })
  if (!verified) return yield* invalid("signature does not verify against the supplied public key")
})

/**
 * How `akua.lock` records a signature verified against `publicKeyPem`:
 * `cosign:key:<identity>`, the identity being `sha256:<hex>` of the key's DER
 * SubjectPublicKeyInfo (its key id). It names the key, not one signature, so
 * a re-signed artifact keeps its lock entry, and `verify` can check it.
 */
export const keyedSignatureRef = Effect.fn("keyedSignatureRef")(function*(publicKeyPem: string) {
  const der = yield* Effect.try({
    try: () => Uint8Array.fromBase64(pemBody(publicKeyPem)),
    catch: (cause) => new CosignInvalid({ message: `public key is not valid PEM: ${String(cause)}` })
  })
  return `cosign:key:${sha256(der)}`
})

const encoder = new TextEncoder()

/**
 * The simple-signing payload cosign signs for `docker_reference` at
 * `manifest_digest`, byte for byte as the previous release serialized it.
 */
export const simpleSigningPayload = (dockerReference: string, manifestDigest: string) =>
  encoder.encode(JSON.stringify({
    critical: {
      identity: { "docker-reference": dockerReference },
      image: { "docker-manifest-digest": manifestDigest },
      type: "cosign container image signature"
    },
    optional: null
  }))

/** WebCrypto's 64-byte `r || s` as the DER `SEQUENCE { INTEGER r, INTEGER s }` cosign writes. */
const rawToDer = (raw: Uint8Array) => {
  const integer = (bytes: Uint8Array) => {
    let start = 0
    while (start < bytes.length - 1 && bytes[start] === 0) start++
    const trimmed = bytes.subarray(start)
    const value = (trimmed[0] ?? 0) & 0x80 ? new Uint8Array([0, ...trimmed]) : trimmed
    return new Uint8Array([0x02, value.length, ...value])
  }
  const r = integer(raw.subarray(0, 32))
  const s = integer(raw.subarray(32))
  return new Uint8Array([0x30, r.length + s.length, ...r, ...s])
}

/** One DER TLV: its tag, its contents, and where the next one starts. */
const tlv = (der: Uint8Array, offset: number) => {
  const tag = der[offset] ?? 0
  let length = der[offset + 1] ?? 0
  let start = offset + 2
  if (length & 0x80) {
    const bytes = length & 0x7f
    length = 0
    for (let index = 0; index < bytes; index++) length = length * 256 + (der[start + index] ?? 0)
    start += bytes
  }
  return { tag, contents: der.subarray(start, start + length), next: start + length }
}

/** The TLVs inside a constructed value. */
const children = (contents: Uint8Array) => {
  const out: Array<ReturnType<typeof tlv>> = []
  for (let offset = 0; offset < contents.length;) {
    const child = tlv(contents, offset)
    out.push(child)
    offset = child.next
  }
  return out
}

const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")

const OID = {
  pbes2: "2a864886f70d01050d",
  pbkdf2: "2a864886f70d01050c",
  hmacSha1: "2a864886f70d0207",
  hmacSha256: "2a864886f70d0209",
  hmacSha384: "2a864886f70d020a",
  hmacSha512: "2a864886f70d020b",
  aes128Cbc: "608648016503040102",
  aes192Cbc: "608648016503040116",
  aes256Cbc: "60864801650304012a"
}

const PRF_HASH: Record<string, string> = {
  [OID.hmacSha1]: "SHA-1",
  [OID.hmacSha256]: "SHA-256",
  [OID.hmacSha384]: "SHA-384",
  [OID.hmacSha512]: "SHA-512"
}
const AES_BITS: Record<string, number> = { [OID.aes128Cbc]: 128, [OID.aes192Cbc]: 192, [OID.aes256Cbc]: 256 }

/**
 * Decrypt a PKCS#8 `EncryptedPrivateKeyInfo` (RFC 5958) protected with
 * PBES2: PBKDF2 (HMAC-SHA-1/256/384/512) and AES-CBC, what OpenSSL writes.
 */
const decryptPkcs8 = (der: Uint8Array, passphrase: string): Promise<Uint8Array> => {
  const [algorithm, encrypted] = children(tlv(der, 0).contents)
  const [scheme, params] = children(algorithm?.contents ?? new Uint8Array())
  if (scheme === undefined || hex(scheme.contents) !== OID.pbes2 || params === undefined) {
    return Promise.reject(new Error("only PBES2 (PBKDF2 + AES-CBC) encrypted keys are supported"))
  }
  const [kdf, cipher] = children(params.contents)
  const [kdfOid, kdfParams] = children(kdf?.contents ?? new Uint8Array())
  if (kdfOid === undefined || hex(kdfOid.contents) !== OID.pbkdf2 || kdfParams === undefined) {
    return Promise.reject(new Error("only PBKDF2 key derivation is supported"))
  }
  const [salt, iterations, ...optional] = children(kdfParams.contents)
  const prf = optional.find((child) => child.tag === 0x30)
  const prfOid = prf === undefined ? OID.hmacSha1 : hex(children(prf.contents)[0]?.contents ?? new Uint8Array())
  const hash = PRF_HASH[prfOid]
  const [cipherOid, iv] = children(cipher?.contents ?? new Uint8Array())
  const bits = AES_BITS[hex(cipherOid?.contents ?? new Uint8Array())]
  if (salt === undefined || iterations === undefined || hash === undefined || bits === undefined || iv === undefined) {
    return Promise.reject(new Error("unsupported PBES2 parameters"))
  }
  const rounds = Array.from(iterations.contents).reduce((total, byte) => total * 256 + byte, 0)
  return crypto.subtle.importKey("raw", encoder.encode(passphrase), "PBKDF2", false, ["deriveKey"])
    .then((base) =>
      crypto.subtle.deriveKey(
        { name: "PBKDF2", salt: new Uint8Array(salt.contents), iterations: rounds, hash },
        base,
        { name: "AES-CBC", length: bits },
        false,
        ["decrypt"]
      )
    )
    .then((key) =>
      crypto.subtle.decrypt({ name: "AES-CBC", iv: new Uint8Array(iv.contents) }, key, new Uint8Array(encrypted?.contents ?? []))
    )
    .then((plain) => new Uint8Array(plain))
}

const pemBlock = (pem: string, label: string) => {
  const match = new RegExp(`-----BEGIN ${label}-----([\\s\\S]*?)-----END ${label}-----`).exec(pem)
  return match === null ? undefined : Uint8Array.fromBase64(match[1]?.replace(/\s+/g, "") ?? "")
}

/** A PKCS#8 P-256 private key (plain, or encrypted with `passphrase`) as a WebCrypto signing key. */
const signingKey = Effect.fnUntraced(function*(privateKeyPem: string, passphrase: Option.Option<string>) {
  const bad = (detail: string) =>
    new CosignInvalid({ message: `private key is not a valid PEM-encoded P-256 ECDSA key: ${detail}` })
  const encrypted = pemBlock(privateKeyPem, "ENCRYPTED PRIVATE KEY")
  let pkcs8: Uint8Array
  if (encrypted !== undefined) {
    if (Option.isNone(passphrase)) {
      return yield* bad("private key is encrypted; set `$AKUA_COSIGN_PASSPHRASE` or an equivalent and re-run")
    }
    pkcs8 = yield* Effect.tryPromise({
      try: () => decryptPkcs8(encrypted, passphrase.value),
      catch: (cause) => bad(`decrypt: ${cause instanceof Error ? cause.message : String(cause)}`)
    })
  } else {
    const plain = pemBlock(privateKeyPem, "PRIVATE KEY")
    if (plain === undefined) return yield* bad("no PKCS#8 `PRIVATE KEY` PEM block")
    pkcs8 = plain
  }
  return yield* Effect.tryPromise({
    try: () =>
      crypto.subtle.importKey("pkcs8", new Uint8Array(pkcs8), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]),
    catch: (cause) => bad(cause instanceof Error ? cause.message : String(cause))
  })
})

/** ECDSA P-256 / SHA-256 over `payload`, as base64 DER. */
export const signKeyed = Effect.fn("signKeyed")(function*(
  privateKeyPem: string,
  payload: Uint8Array,
  passphrase: Option.Option<string>
) {
  const key = yield* signingKey(privateKeyPem, passphrase)
  const raw = yield* Effect.tryPromise({
    try: () => crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new Uint8Array(payload)),
    catch: (cause) => new CosignInvalid({ message: `signing failed: ${String(cause)}` })
  })
  return rawToDer(new Uint8Array(raw)).toBase64()
})

/** DSSE pre-authentication encoding: `DSSEv1 <len> <type> <len> <payload>`. */
const dssePae = (payloadType: string, payload: Uint8Array) =>
  new Uint8Array(Bun.concatArrayBuffers([
    encoder.encode(`DSSEv1 ${encoder.encode(payloadType).length} ${payloadType} ${payload.length} `),
    payload
  ]))

export const DSSE_ENVELOPE_MEDIA_TYPE = "application/vnd.dsse.envelope.v1+json"

/** A signed DSSE envelope over `payload`, as the JSON bytes cosign's `.att` sidecar carries. */
export const signDsse = Effect.fn("signDsse")(function*(
  privateKeyPem: string,
  payloadType: string,
  payload: Uint8Array,
  passphrase: Option.Option<string>
) {
  const sig = yield* signKeyed(privateKeyPem, dssePae(payloadType, payload), passphrase)
  return encoder.encode(JSON.stringify({ payloadType, payload: payload.toBase64(), signatures: [{ sig }] }))
})

const DsseEnvelope = Schema.Struct({
  payloadType: Schema.String,
  payload: Schema.String,
  signatures: Schema.Array(Schema.Struct({ sig: Schema.String, keyid: Schema.optionalKey(Schema.String) }))
})

/** The payload of a DSSE envelope any of whose signatures verifies against `publicKeyPem`. */
export const verifyDsse = Effect.fn("verifyDsse")(function*(publicKeyPem: string, envelopeBytes: Uint8Array) {
  const invalid = (message: string) => new CosignInvalid({ message })
  const envelope = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(DsseEnvelope))(
    new TextDecoder().decode(envelopeBytes)
  ).pipe(Effect.mapError((error) => invalid(`payload isn't the cosign simple-signing shape: ${error.message}`)))
  const payload = yield* Effect.try({
    try: () => Uint8Array.fromBase64(envelope.payload),
    catch: (cause) => invalid(`signature is not valid DER/raw base64: ${String(cause)}`)
  })
  const key = yield* Effect.tryPromise({
    try: () =>
      crypto.subtle.importKey("spki", Uint8Array.fromBase64(pemBody(publicKeyPem)), { name: "ECDSA", namedCurve: "P-256" }, false, [
        "verify"
      ]),
    catch: (cause) => invalid(`public key is not a valid PEM-encoded P-256 ECDSA key: ${String(cause)}`)
  })
  const pae = dssePae(envelope.payloadType, payload)
  for (const { sig } of envelope.signatures) {
    const bytes = Option.liftThrowable(() => Uint8Array.fromBase64(sig))()
    if (Option.isNone(bytes)) continue
    const raw = bytes.value.length === 64 ? bytes.value : derToRaw(bytes.value)
    if (raw === undefined) continue
    const verified = yield* Effect.tryPromise(() =>
      crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, new Uint8Array(raw), pae)
    ).pipe(Effect.orElseSucceed(() => false))
    if (verified) return payload
  }
  return yield* invalid("signature does not verify against the supplied public key: no DSSE signature verified against the supplied public key")
})
