import { Context, Effect, FileSystem, Layer, Option, Path, Redacted, Schema } from "effect"
import git from "isomorphic-git"
import http from "isomorphic-git/http/web"
import { cacheRoot, unpackInto } from "./downloads.effect"
import type { BasicAuth } from "./host-auth"
import { MemoryFs } from "./memory-fs"

/**
 * Git-hosted dependencies (`git = "https://..."` with `tag` or `rev`): one
 * commit fetched shallowly over smart HTTP into memory (isomorphic-git, no
 * `git` binary), its tree written into the previous release's cache
 * (`<cache>/git/checkouts/<commit>/`), and pinned in `akua.lock` as
 * `git:<commit>`.
 */

export class GitFetchFailed extends Schema.TaggedError<GitFetchFailed>()("GitFetchFailed", {
  message: Schema.String,
  /** Refused because `--offline` forbids the network, not because a fetch failed. */
  offline: Schema.Boolean
}) {}

export interface GitRequest {
  readonly url: string
  /** A tag, or a commit (`rev`, a full 40-character SHA). */
  readonly ref: { readonly _tag: "Tag"; readonly tag: string } | { readonly _tag: "Rev"; readonly rev: string }
  /** The `akua.lock` commit (without the `git:` prefix) the fetch must land on. */
  readonly pin: Option.Option<string>
  readonly offline: boolean
  /** HTTP basic credentials for a private remote (`--auth`). */
  readonly auth?: BasicAuth
}

export interface FetchedCommit {
  readonly directory: string
  readonly commit: string
}

const FULL_SHA = /^[0-9a-f]{40}$/

/** A tree entry name that is safe to write: no separators, no `.`/`..`, and never `.git`. */
const safeName = (name: string) =>
  name !== "" && name !== "." && name !== ".." && name !== ".git" && !/[/\\\0]/.test(name)

export class GitRemote extends Context.Service<GitRemote, {
  fetch(request: GitRequest): Effect.Effect<FetchedCommit, GitFetchFailed>
}>()("akuapkg/host/GitRemote") {
  static readonly layer = Layer.effect(
    GitRemote,
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* cacheRoot("git")
      const failed = (message: string) => new GitFetchFailed({ message, offline: false })
      const checkout = (commit: string) => path.join(root, "checkouts", commit)
      const attempt = <A>(what: string, run: () => Promise<A>) =>
        Effect.tryPromise({ try: run, catch: (cause) => failed(`${what}: ${cause instanceof Error ? cause.message : String(cause)}`) })

      /** Every blob under `tree`, as paths relative to the checkout. */
      const files = Effect.fnUntraced(function*(memory: MemoryFs, oid: string, prefix: string): Effect.fn.Return<
        Array<{ path: string; data: Uint8Array }>,
        GitFetchFailed
      > {
        const { tree } = yield* attempt("reading tree", () => git.readTree({ fs: memory, gitdir: "/.git", oid }))
        const out: Array<{ path: string; data: Uint8Array }> = []
        for (const entry of tree) {
          if (!safeName(entry.path)) return yield* failed(`tree entry \`${entry.path}\` is not a safe file name`)
          const relative = prefix === "" ? entry.path : `${prefix}/${entry.path}`
          if (entry.type === "tree") out.push(...(yield* files(memory, entry.oid, relative)))
          // Symlinks (120000) and submodules (commits) are skipped, as before.
          else if (entry.type === "blob" && entry.mode !== "120000") {
            const { blob } = yield* attempt("reading blob", () => git.readBlob({ fs: memory, gitdir: "/.git", oid: entry.oid }))
            out.push({ path: relative, data: blob })
          }
        }
        return out
      })

      const fetch = Effect.fn("GitRemote.fetch")(function*(request: GitRequest) {
        if (Option.isSome(request.pin) && (yield* fs.exists(checkout(request.pin.value)).pipe(Effect.orElseSucceed(() => false)))) {
          return { directory: checkout(request.pin.value), commit: request.pin.value } satisfies FetchedCommit
        }
        if (request.offline) {
          return yield* new GitFetchFailed({
            offline: true,
            message: Option.isSome(request.pin)
              ? "offline mode and the git cache doesn't have this commit - run `akua add` online first"
              : "offline mode needs a lockfile-pinned commit - run `akua add` first"
          })
        }
        if (request.ref._tag === "Rev" && !FULL_SHA.test(request.ref.rev)) {
          return yield* failed(`rev \`${request.ref.rev}\` must be a full 40-character commit SHA`)
        }
        if (!/^https?:\/\//.test(request.url)) {
          return yield* failed(`\`${request.url}\`: only http(s) git remotes are supported`)
        }
        const memory = new MemoryFs()
        yield* attempt("init", () => git.init({ fs: memory, dir: "/" }))
        yield* attempt("adding the remote", () => git.addRemote({ fs: memory, dir: "/", remote: "origin", url: request.url }))
        const auth = request.auth
        const wanted = request.ref._tag === "Tag" ? `refs/tags/${request.ref.tag}` : request.ref.rev
        const fetched = yield* attempt(`fetching \`${request.url}\` at \`${wanted}\``, () =>
          git.fetch({
            fs: memory,
            http,
            dir: "/",
            remote: "origin",
            ref: wanted,
            singleBranch: true,
            depth: 1,
            tags: false,
            ...(auth === undefined ? {} : {
              onAuth: () => ({ username: auth.username, password: Redacted.value(auth.password) })
            })
          }))
        // An annotated tag points at a tag object: peel it to the commit.
        let commit = fetched.fetchHead ?? ""
        for (let hops = 0; hops < 8; hops++) {
          const object = yield* attempt("reading object", () => git.readObject({ fs: memory, gitdir: "/.git", oid: commit }))
          if (object.type === "commit") break
          if (object.type !== "tag") return yield* failed(`\`${wanted}\` does not point at a commit`)
          const { tag } = yield* attempt("reading tag", () => git.readTag({ fs: memory, gitdir: "/.git", oid: commit }))
          commit = tag.object
        }
        if (Option.isSome(request.pin) && request.pin.value !== commit) {
          return yield* failed(
            `\`${request.url}\` at \`${wanted}\` is commit ${commit}, but akua.lock pins ${request.pin.value}`
          )
        }
        const { commit: object } = yield* attempt("reading commit", () => git.readCommit({ fs: memory, gitdir: "/.git", oid: commit }))
        const entries = yield* files(memory, object.tree, "")
        yield* unpackInto(checkout(commit), entries).pipe(
          Effect.mapError((error) => failed(`io error at ${root}: ${error.message}`))
        )
        return { directory: checkout(commit), commit } satisfies FetchedCommit
      }, Effect.provideService(FileSystem.FileSystem, fs), Effect.provideService(Path.Path, path))

      return GitRemote.of({ fetch })
    })
  )
}
