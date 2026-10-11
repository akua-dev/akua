import { Effect, FileSystem, Option, Schema } from "effect"
import { osMessage } from "../errors"
import { Command, Flag } from "effect/cli"
import { ExitCode, ExitWith, fail } from "../contract"
import { verifyDsse, verifyKeyed } from "../cosign"
import { pathDependencyTree } from "../dependencies.effect"
import { type LockedPackage, parseLock } from "../lockfile"
import { OciRegistry, publishDigests } from "../oci.effect"
import type { VerbContext } from "./context"
import { joinPath, readOptional } from "./files"
import { verb } from "./report"
import { emit, universal } from "./universal"
import { readSidecar } from "./signing"
import { loadManifest, loadManifestForLock, lockPath, manifestFailure } from "./workspace"

type Violation =
  | { readonly kind: "unlocked_dep"; readonly name: string }
  | { readonly kind: "orphan_locked"; readonly name: string; readonly version: string }
  | { readonly kind: "missing_signature"; readonly name: string; readonly version: string }
  | { readonly kind: "path_digest_drift"; readonly name: string; readonly expected: string; readonly actual: string }
  | { readonly kind: "path_missing"; readonly name: string; readonly path: string }
  | { readonly kind: "attestation_missing"; readonly name: string; readonly oci_ref: string }
  | { readonly kind: "attestation_invalid"; readonly name: string; readonly oci_ref: string; readonly detail: string }
  | {
    readonly kind: "attestation_subject_mismatch"
    readonly name: string
    readonly expected: string
    readonly claimed: string
  }

const violationText = (v: Violation) => {
  switch (v.kind) {
    case "unlocked_dep":
      return `  - unlocked-dep: ${v.name}`
    case "orphan_locked":
      return `  - orphan-locked: ${v.name}@${v.version}`
    case "missing_signature":
      return `  - missing-signature: ${v.name}@${v.version}`
    case "path_digest_drift":
      return `  - path-digest-drift: ${v.name}\n      expected ${v.expected}\n      actual   ${v.actual}\n` +
        `      run \`akuapkg add --force ${v.name} --path <current_path>\` to refresh`
    case "path_missing":
      return `  - path-missing: ${v.name} at \`${v.path}\``
    case "attestation_missing":
      return `  - attestation-missing: ${v.name} (${v.oci_ref}) has no \`.att\` sidecar`
    case "attestation_invalid":
      return `  - attestation-invalid: ${v.name} (${v.oci_ref})\n      ${v.detail}`
    case "attestation_subject_mismatch":
      return `  - attestation-subject-mismatch: ${v.name}\n      expected ${v.expected}\n      claimed  ${v.claimed}`
  }
}

const Statement = Schema.Struct({
  subject: Schema.Array(Schema.Struct({ digest: Schema.Record(Schema.String, Schema.String) }))
})

/**
 * The provenance attestation of one OCI dependency: the artifact its locked
 * tag names must still carry the pinned layer, and its `.att` must verify
 * against the workspace key and describe that artifact's manifest.
 */
const attestationViolation = Effect.fnUntraced(function*(entry: LockedPackage, publicKey: string) {
  const registry = yield* OciRegistry
  const found = yield* registry.pullAttestation({ reference: entry.source, tag: entry.version }).pipe(Effect.result)
  if (found._tag === "Failure") {
    return Option.some<Violation>({
      kind: "attestation_invalid",
      name: entry.name,
      oci_ref: entry.source,
      detail: `pull failed: ${found.failure.message}`
    })
  }
  const { envelope, layerDigests, manifestDigest } = found.success
  if (!layerDigests.includes(entry.digest)) {
    return Option.some<Violation>({
      kind: "attestation_subject_mismatch",
      name: entry.name,
      expected: entry.digest,
      claimed: layerDigests[0] ?? "<absent>"
    })
  }
  if (Option.isNone(envelope)) {
    return Option.some<Violation>({ kind: "attestation_missing", name: entry.name, oci_ref: entry.source })
  }
  const payload = yield* verifyDsse(publicKey, envelope.value).pipe(Effect.result)
  if (payload._tag === "Failure") {
    return Option.some<Violation>({
      kind: "attestation_invalid",
      name: entry.name,
      oci_ref: entry.source,
      detail: payload.failure.message
    })
  }
  const statement = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Statement))(
    new TextDecoder().decode(payload.success)
  ).pipe(Effect.result)
  if (statement._tag === "Failure") {
    return Option.some<Violation>({
      kind: "attestation_invalid",
      name: entry.name,
      oci_ref: entry.source,
      detail: `in-toto statement parse: ${statement.failure.message}`
    })
  }
  const hex = manifestDigest.replace(/^sha256:/, "")
  if (statement.success.subject.some((subject) => subject.digest["sha256"] === hex)) return Option.none<Violation>()
  return Option.some<Violation>({
    kind: "attestation_subject_mismatch",
    name: entry.name,
    expected: manifestDigest,
    claimed: `sha256:${statement.success.subject[0]?.digest["sha256"] ?? "<absent>"}`
  })
})

const workspaceVerify = (context: VerbContext, workspace: string, mode: "json" | "text") =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const manifest = yield* loadManifest(workspace).pipe(
      Effect.catchTags({
        ManifestMissing: (missing) =>
          Effect.fail(manifestFailure(missing, "run `akuapkg init` or check the working directory")),
        ManifestInvalid: (invalid) => Effect.fail(manifestFailure(invalid))
      })
    )
    const lockFile = lockPath(workspace)
    const lockText = yield* readOptional(lockFile)
    if (Option.isNone(lockText)) {
      return yield* fail(
        "E_LOCK_MISSING",
        "akua.lock not found",
        ExitCode.userError,
        lockFile,
        "run `akuapkg add` to resolve deps and generate the lockfile"
      )
    }
    const lock = yield* parseLock(lockText.value, lockFile).pipe(
      Effect.mapError((error) => fail("E_LOCK_PARSE", error.message, ExitCode.userError, lockFile))
    )
    const declared = manifest.dependencies ?? {}
    const packages = lock.package ?? []
    const strictSigning = manifest.package.strict_signing ?? true
    const violations: Array<Violation> = []
    for (const name of Object.keys(declared).toSorted()) {
      if (!packages.some((entry) => entry.name === name)) violations.push({ kind: "unlocked_dep", name })
    }
    for (const entry of packages) {
      if (declared[entry.name] === undefined) {
        violations.push({ kind: "orphan_locked", name: entry.name, version: entry.version })
      }
    }
    const isPath = (entry: LockedPackage) => entry.source.startsWith("path+file://")
    if (strictSigning) {
      for (const entry of packages) {
        if (!isPath(entry) && entry.signature === undefined) {
          violations.push({ kind: "missing_signature", name: entry.name, version: entry.version })
        }
      }
    }
    for (const entry of packages.filter(isPath)) {
      const requested = declared[entry.name]?.path
      if (requested === undefined) continue
      const tree = yield* pathDependencyTree(workspace, entry.name, requested).pipe(Effect.option)
      if (Option.isNone(tree)) {
        violations.push({ kind: "path_missing", name: entry.name, path: joinPath(workspace, requested) })
      } else if (tree.value.digest !== entry.digest) {
        violations.push({ kind: "path_digest_drift", name: entry.name, expected: entry.digest, actual: tree.value.digest })
      }
    }
    const keyPath = manifest.signing?.cosign_public_key
    if (keyPath !== undefined) {
      const file = joinPath(workspace, keyPath)
      const publicKey = yield* fs.readFileString(file).pipe(
        Effect.mapError((error) =>
          fail(
            "E_IO",
            osMessage(error),
            ExitCode.userError,
            file,
            "akua.toml [signing].cosign_public_key must resolve to a PEM-encoded public key file."
          )
        )
      )
      for (const entry of packages.filter((p) => p.source.startsWith("oci://"))) {
        const violation = yield* attestationViolation(entry, publicKey).pipe(Effect.provide(context.fetchers))
        if (Option.isSome(violation)) violations.push(violation.value)
      }
    }
    const output = {
      status: violations.length === 0 ? "ok" : "fail",
      summary: {
        declared_deps: Object.keys(declared).length,
        locked_packages: packages.length,
        strict_signing: strictSigning
      },
      violations
    }
    yield* emit(mode, output, () =>
      [
        `verify: ${output.summary.declared_deps} declared, ${output.summary.locked_packages} locked, ` +
        `strict_signing=${strictSigning}`,
        ...(violations.length === 0 ? ["ok"] : [`fail: ${violations.length} violation(s)`, ...violations.map(violationText)])
      ].join("\n"))
    if (violations.length > 0) return yield* new ExitWith({ exitCode: ExitCode.userError })
  })

type Check =
  | { readonly kind: "sidecar_readable"; readonly status: string; readonly detail?: string }
  | { readonly kind: "digest_match"; readonly status: string; readonly expected?: string; readonly actual?: string }
  | { readonly kind: "signature_verify"; readonly status: string; readonly detail?: string }

const checkText = (check: Check) => {
  switch (check.kind) {
    case "sidecar_readable":
      return [`  [${check.status}] sidecar readable`, ...(check.detail === undefined ? [] : [`        ${check.detail}`])]
    case "digest_match":
      return [
        `  [${check.status}] manifest digest match`,
        ...(check.expected === undefined || check.actual === undefined
          ? []
          : [`        expected ${check.expected}`, `        sidecar  ${check.actual}`])
      ]
    case "signature_verify":
      return [`  [${check.status}] signature verify`, ...(check.detail === undefined ? [] : [`        ${check.detail}`])]
  }
}

/** A packed tarball against its `sign` sidecar and a public key, offline. */
const tarballVerify = (context: VerbContext, flags: {
  readonly tarball: string
  readonly sig: Option.Option<string>
  readonly publicKey: Option.Option<string>
  readonly workspace: string
}, mode: "json" | "text") =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const tarball = yield* fs.readFile(flags.tarball).pipe(
      Effect.mapError((error) => fail("E_IO", `reading tarball \`${flags.tarball}\`: ${osMessage(error)}`, ExitCode.userError))
    )
    const sidecarPath = Option.getOrElse(flags.sig, () => `${flags.tarball}.akuasig`)
    const checks: Array<Check> = []
    const sidecar = yield* readSidecar(sidecarPath).pipe(Effect.result)
    if (sidecar._tag === "Success") checks.push({ kind: "sidecar_readable", status: "pass" })
    else checks.push({ kind: "sidecar_readable", status: "fail", detail: sidecar.failure.error.message })
    if (sidecar._tag === "Success") {
      const expected = publishDigests(tarball, context.version).manifestDigest
      checks.push(
        sidecar.success.manifest_digest === expected
          ? { kind: "digest_match", status: "pass" }
          : { kind: "digest_match", status: "fail", expected, actual: sidecar.success.manifest_digest }
      )
    } else {
      checks.push({ kind: "digest_match", status: "skip" })
    }
    const readKey = (path: string) =>
      fs.readFileString(path).pipe(
        Effect.mapError((error) => fail("E_IO", `reading public key \`${path}\`: ${osMessage(error)}`, ExitCode.userError))
      )
    const publicKey = Option.isSome(flags.publicKey)
      ? Option.some(yield* readKey(flags.publicKey.value))
      : yield* loadManifestForLock(flags.workspace).pipe(
        Effect.map((manifest) => Option.fromUndefinedOr(manifest.signing?.cosign_public_key)),
        Effect.catchIf(
          (error) => error.error.message.startsWith("akua.toml not found"),
          () => Effect.succeedNone
        ),
        Effect.flatMap((relative) =>
          Option.isSome(relative)
            ? readKey(joinPath(flags.workspace, relative.value)).pipe(Effect.map(Option.some))
            : Effect.succeedNone
        )
      )
    if (sidecar._tag === "Success" && Option.isSome(publicKey)) {
      const verified = yield* verifyKeyed({
        publicKeyPem: publicKey.value,
        payload: new TextEncoder().encode(sidecar.success.simple_signing_payload),
        signatureBase64: sidecar.success.signature_b64,
        manifestDigest: sidecar.success.manifest_digest
      }).pipe(Effect.result)
      checks.push(
        verified._tag === "Success"
          ? { kind: "signature_verify", status: "pass" }
          : {
            kind: "signature_verify",
            status: "fail",
            detail: verified.failure.message.startsWith("signature does not verify against the supplied public key")
              ? `signature does not verify: ${verified.failure.message}`
              : verified.failure.message
          }
      )
    } else {
      checks.push({
        kind: "signature_verify",
        status: "skip",
        detail: "no public key configured (pass --public-key or set akua.toml [signing].cosign_public_key)"
      })
    }
    const status = checks.some((check) => check.status === "fail") ? "fail" : "ok"
    const target = sidecar._tag === "Success" ? sidecar.success : undefined
    const output = {
      status,
      tarball: flags.tarball,
      sidecar: sidecarPath,
      oci_ref: target?.oci_ref ?? null,
      tag: target?.tag ?? null,
      checks
    }
    yield* emit(mode, output, () =>
      [
        `verify: ${flags.tarball}`,
        `  sidecar ${sidecarPath}`,
        ...(target === undefined ? [] : [`  target  ${target.oci_ref}:${target.tag}`]),
        ...checks.flatMap(checkText),
        `status: ${status}`
      ].join("\n"))
    if (status === "fail") return yield* new ExitWith({ exitCode: ExitCode.userError })
  })

/** `akua.toml` against `akua.lock` (and attestations), or a packed tarball against its signature. */
export const verify = (context: VerbContext) =>
  Command.make(
    "verify",
    {
      ...universal,
      workspace: Flag.String("workspace").pipe(Flag.withDefault("."), Flag.withDescription("Workspace root")),
      tarball: Flag.String("tarball").pipe(Flag.optional, Flag.withDescription("Verify a packed .tar.gz instead")),
      sig: Flag.String("sig").pipe(Flag.optional, Flag.withDescription("The .akuasig sidecar (default <tarball>.akuasig)")),
      publicKey: Flag.String("public-key").pipe(
        Flag.optional,
        Flag.withDescription("PEM cosign public key (default akua.toml [signing].cosign_public_key)")
      )
    },
    verb(
      "akuapkg.verify",
      Effect.fnUntraced(function*(flags, mode) {
        if (Option.isSome(flags.tarball)) {
          return yield* tarballVerify(context, { ...flags, tarball: flags.tarball.value }, mode)
        }
        return yield* workspaceVerify(context, flags.workspace, mode)
      })
    )
  ).pipe(Command.withDescription("Check akua.lock against akua.toml, or a tarball against its signature"))
