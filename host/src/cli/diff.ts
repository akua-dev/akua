import { Effect, FileSystem, Path } from "effect"
import { Argument, Command } from "effect/cli"
import { type CliFailure, ExitCode, ExitWith, fail } from "../contract"
import { sha256 } from "../downloads.effect"
import { osMessage } from "../errors"
import { comparePaths } from "../walk.effect"
import { verb } from "./report"
import { emit, universal } from "./universal"

type PlatformFailure = { readonly message: string; readonly reason?: { readonly _tag: string } }

/** A missing directory is the caller's mistake; any other i/o failure is the system's. */
const ioFailure = (path: string) => (error: PlatformFailure) =>
  error.reason?._tag === "NotFound"
    ? fail("E_PACKAGE_MISSING", osMessage(error), ExitCode.userError, path)
    : fail("E_IO", osMessage(error), ExitCode.systemError, path)

/**
 * The regular files under `root` by relative path, and every other entry
 * (symlinks, sockets, fifos) as skipped. Symlinks are never followed.
 */
const collect = Effect.fnUntraced(function*(root: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const isSymlink = (file: string) => fs.readLink(file).pipe(Effect.as(true), Effect.orElseSucceed(() => false))
  const notDirectory = (yield* isSymlink(root)) ||
    (yield* fs.stat(root).pipe(Effect.mapError(ioFailure(root)))).type !== "Directory"
  if (notDirectory) {
    return yield* fail("E_DIFF_NOT_DIR", `\`${root}\` is not a directory`, ExitCode.userError, root)
  }
  const files: Array<string> = []
  const skipped: Array<string> = []
  const walk = (relative: string): Effect.Effect<void, CliFailure> =>
    Effect.gen(function*() {
      const directory = relative === "" ? root : path.join(root, relative)
      for (const name of yield* fs.readDirectory(directory).pipe(Effect.mapError(ioFailure(directory)))) {
        const entry = relative === "" ? name : `${relative}/${name}`
        const full = path.join(root, entry)
        if (yield* isSymlink(full)) {
          skipped.push(entry)
          continue
        }
        const info = yield* fs.stat(full).pipe(Effect.mapError(ioFailure(full)))
        if (info.type === "Directory") yield* walk(entry)
        else if (info.type === "File") files.push(entry)
        else skipped.push(entry)
      }
    })
  yield* walk("")
  return { files: new Set(files), skipped }
})

const hashFile = Effect.fnUntraced(function*(file: string) {
  const fs = yield* FileSystem.FileSystem
  return yield* fs.readFile(file).pipe(Effect.map(sha256), Effect.mapError(ioFailure(file)))
})

/** `sha256:abc...` as its first 12 hex digits, for the text view. */
const shortHash = (digest: string) => (digest.startsWith("sha256:") ? digest.slice(7, 19) : digest)

/** Compare two rendered-output directories file by file, by content hash. */
export const diff = () =>
  Command.make(
    "diff",
    {
      ...universal,
      before: Argument.String("before").pipe(Argument.withDescription("Baseline directory")),
      after: Argument.String("after").pipe(Argument.withDescription("Candidate directory"))
    },
    verb(
      "akuapkg.diff",
      Effect.fnUntraced(function*(flags, mode) {
        const path = yield* Path.Path
        const before = yield* collect(flags.before)
        const after = yield* collect(flags.after)
        const added: Array<string> = []
        const removed: Array<string> = []
        const changed: Array<{ path: string; before: string; after: string }> = []
        const unchanged: Array<string> = []
        for (const file of [...new Set([...before.files, ...after.files])].toSorted(comparePaths)) {
          if (!after.files.has(file)) removed.push(file)
          else if (!before.files.has(file)) added.push(file)
          else {
            const beforeHash = yield* hashFile(path.join(flags.before, file))
            const afterHash = yield* hashFile(path.join(flags.after, file))
            if (beforeHash === afterHash) unchanged.push(file)
            else changed.push({ path: file, before: beforeHash, after: afterHash })
          }
        }
        const skipped = [...new Set([...before.skipped, ...after.skipped])].toSorted(comparePaths)
        const clean = added.length === 0 && removed.length === 0 && changed.length === 0
        const skippedNote = skipped.length === 0 ? [] : [`  (${skipped.length} non-file entries skipped)`]
        yield* emit(
          mode,
          {
            added,
            removed,
            changed,
            ...(unchanged.length === 0 ? {} : { unchanged }),
            ...(skipped.length === 0 ? {} : { skipped })
          },
          () =>
            (clean
              ? ["no differences", ...skippedNote]
              : [
                ...added.map((file) => `+ ${file}`),
                ...removed.map((file) => `- ${file}`),
                ...changed.map((change) =>
                  `~ ${change.path}  (${shortHash(change.before)} → ${shortHash(change.after)})`
                ),
                ...skippedNote
              ]).join("\n")
        )
        // diff(1): exit 1 when the trees differ, so CI can branch on the code alone.
        if (!clean) return yield* new ExitWith({ exitCode: ExitCode.userError })
      })
    )
  ).pipe(Command.withDescription("Structural diff between two rendered-output directories"))
