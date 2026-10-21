import { Effect, FileSystem, Option, Redacted, Schema } from "effect"
import * as TOML from "smol-toml"
import { NOT_FOUND } from "./cli/files"

/**
 * Credentials for private git remotes, passed explicitly (`--auth`,
 * `--auth-file`); ambient credential files are never read. Keyed by URL
 * prefix without scheme (`git.example.com`, `git.example.com/org`) and
 * matched longest first, on a path boundary, as git's credential helper does.
 */

export class BasicAuth extends Schema.Class<BasicAuth>("akuapkg/host/BasicAuth")({
  username: Schema.String,
  password: Schema.Redacted(Schema.String)
}) {}

export type HostAuthMap = ReadonlyMap<string, BasicAuth>

export class AuthParseError extends Schema.TaggedError<AuthParseError>()("AuthParseError", {
  message: Schema.String
}) {}

/** One `--auth <prefix>=<user>:<password>`: split at the first `=`, then the first `:`. */
export const parseAuthPair = (value: string): Effect.Effect<readonly [string, BasicAuth], AuthParseError> => {
  const invalid = new AuthParseError({
    message: `--auth value \`${value}\` is not in the form \`<host-or-prefix>=<user>:<password>\``
  })
  const equals = value.indexOf("=")
  if (equals === -1) return Effect.fail(invalid)
  const prefix = value.slice(0, equals)
  if (prefix === "") {
    return Effect.fail(
      new AuthParseError({ message: `--auth value \`${value}\` has an empty url-prefix on the left of \`=\`` })
    )
  }
  const rest = value.slice(equals + 1)
  const colon = rest.indexOf(":")
  if (colon === -1) return Effect.fail(invalid)
  const username = rest.slice(0, colon)
  if (username === "") {
    return Effect.fail(
      new AuthParseError({ message: `--auth value \`${value}\` has an empty username on the left of \`:\` after \`=\`` })
    )
  }
  return Effect.succeed([prefix, BasicAuth.make({ username, password: Redacted.make(rest.slice(colon + 1)) })])
}

const AuthFile = Schema.Struct({
  auth: Schema.optionalKey(Schema.Record(Schema.String, Schema.Struct({ username: Schema.String, password: Schema.String })))
})

/** An `--auth-file`: an `[auth]` table of `{ username, password }` keyed by URL prefix. */
export const loadAuthFile = Effect.fnUntraced(function*(path: string) {
  const fs = yield* FileSystem.FileSystem
  const text = yield* fs.readFileString(path).pipe(
    Effect.mapError((error) =>
      new AuthParseError({
        message: `could not read --auth-file \`${path}\`: ${error.reason._tag === "NotFound" ? NOT_FOUND : error.message}`
      })
    )
  )
  const parsed = yield* Effect.try({
    try: (): unknown => TOML.parse(text),
    catch: (cause) =>
      new AuthParseError({
        message: `could not parse --auth-file \`${path}\` as TOML: ${cause instanceof Error ? cause.message : String(cause)}`
      })
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(AuthFile)),
    Effect.mapError((error) =>
      error._tag === "AuthParseError"
        ? error
        : new AuthParseError({ message: `could not parse --auth-file \`${path}\` as TOML: ${error.message}` })
    )
  )
  const auth = new Map<string, BasicAuth>()
  for (const [prefix, { password, username }] of Object.entries(parsed.auth ?? {})) {
    auth.set(prefix, BasicAuth.make({ username, password: Redacted.make(password) }))
  }
  return auth
})

/** `--auth-file` entries, overridden by `--auth` flags. */
export const resolveAuth = Effect.fnUntraced(function*(pairs: ReadonlyArray<string>, file: Option.Option<string>) {
  const auth = new Map<string, BasicAuth>(Option.isSome(file) ? yield* loadAuthFile(file.value) : [])
  for (const pair of pairs) {
    const [prefix, credential] = yield* parseAuthPair(pair)
    auth.set(prefix, credential)
  }
  return auth satisfies HostAuthMap
})

/** `host[:port]/path` of a URL: no scheme, no credentials, no trailing `/`. */
const matchKey = (url: string) => {
  const afterScheme = url.includes("://") ? url.slice(url.indexOf("://") + 3) : url
  const pathStart = afterScheme.includes("/") ? afterScheme.indexOf("/") : afterScheme.length
  return afterScheme.slice(afterScheme.slice(0, pathStart).lastIndexOf("@") + 1).replace(/\/+$/, "")
}

/** The credential whose prefix is the longest match for `url`, on a `/` or `:` boundary. */
export const lookupAuth = (auth: HostAuthMap, url: string): Option.Option<BasicAuth> => {
  const key = matchKey(url)
  if (key === "") return Option.none()
  const prefix = Array.from(auth.keys())
    .toSorted((a, b) => b.length - a.length)
    .find((candidate) =>
      key.startsWith(candidate) && (key.length === candidate.length || "/:".includes(key[candidate.length] ?? ""))
    )
  return Option.fromUndefinedOr(prefix === undefined ? undefined : auth.get(prefix))
}
