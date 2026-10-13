import { Effect, Layer, Predicate } from "effect"
import { ConsoleStdout, Directory, File, type Inode, OpenFile, PreopenDirectory, WASI } from "@bjorn3/browser_wasi_shim"
import { EngineError, RenderError, WasmLoadError } from "./errors"
import { type CommandRun, type MountedTree, type ReactorSpec, WasmHost } from "./host"
import type { Snapshot } from "./snapshot.effect"

type Tree = Map<string, Tree | Uint8Array>

/**
 * WASI shim preopen contents for a snapshot. Directories are built
 * bottom-up because the shim wires `..` parent links only for children
 * present at construction time.
 */
export const toWasiDirectory = (snapshot: Snapshot): Map<string, Inode> => {
  const root: Tree = new Map()
  for (const [key, bytes] of snapshot) {
    const segments = key.split("/")
    let dir = root
    for (const segment of segments.slice(0, -1)) {
      const child = dir.get(segment)
      const next: Tree = child instanceof Map ? child : new Map()
      dir.set(segment, next)
      dir = next
    }
    dir.set(segments.at(-1) ?? key, bytes)
  }
  const build = (tree: Tree): Map<string, Inode> =>
    new Map(
      Array.from(tree, ([name, node]) => [
        name,
        node instanceof Map ? new Directory(build(node)) : new File(node, { readonly: true })
      ])
    )
  return build(root)
}

const isMemory = (u: unknown): u is WebAssembly.Memory => u instanceof WebAssembly.Memory
const isExport = (u: unknown): u is (...args: Array<number>) => number => Predicate.isFunction(u)

const exportOf = Effect.fnUntraced(function*<T>(
  owner: string,
  instance: WebAssembly.Instance,
  name: string,
  guard: (u: unknown) => u is T
) {
  const value: unknown = instance.exports[name]
  if (!guard(value)) return yield* new EngineError({ engine: owner, message: `missing export \`${name}\`` })
  return value
})

const concat = (chunks: ReadonlyArray<Uint8Array>) => new Uint8Array(Bun.concatArrayBuffers([...chunks]))

const readCString = (memory: WebAssembly.Memory, address: number): string | undefined => {
  if (address <= 0) return undefined
  const view = new Uint8Array(memory.buffer, address)
  const end = view.indexOf(0)
  return end < 0 ? undefined : new TextDecoder().decode(view.subarray(0, end))
}

/** Synchronous instantiation of a Go reactor; runs lazily inside the KCL bridge. */
const instantiateReactor = Effect.fn("JsWasmHost.instantiateReactor")(function*(
  spec: ReactorSpec,
  module: WebAssembly.Module
) {
  const stderr: Array<string> = []
  const wasi = new WASI([spec.name], [], [
    new OpenFile(new File([])),
    ConsoleStdout.lineBuffered((line) => stderr.push(line)),
    ConsoleStdout.lineBuffered((line) => stderr.push(line))
  ], { debug: false })
  const instance = yield* Effect.try({
    try: () => new WebAssembly.Instance(module, { wasi_snapshot_preview1: wasi.wasiImport }),
    catch: (cause) => new WasmLoadError({ module: spec.name, cause })
  })
  const memory = yield* exportOf(spec.name, instance, "memory", isMemory)
  const initialize = yield* exportOf(spec.name, instance, "_initialize", isExport)
  yield* Effect.try({
    try: () => wasi.initialize({ exports: { memory, _initialize: initialize } }),
    catch: (cause) => new WasmLoadError({ module: spec.name, cause })
  })
  const malloc = yield* exportOf(spec.name, instance, `${spec.prefix}_malloc`, isExport)
  const free = yield* exportOf(spec.name, instance, `${spec.prefix}_free`, isExport)
  const resultLen = yield* exportOf(spec.name, instance, `${spec.prefix}_result_len`, isExport)
  const entry = yield* exportOf(spec.name, instance, spec.entry, isExport)

  return Effect.fn("JsWasmHost.reactorCall")(function*(input: Uint8Array) {
    return yield* Effect.try({
      try: () => {
        const inPtr = malloc(input.length)
        new Uint8Array(memory.buffer, inPtr, input.length).set(input)
        const outPtr = entry(inPtr, input.length)
        // `.slice()` copies out before a later guest call can grow memory.
        const out = new Uint8Array(memory.buffer, outPtr, resultLen(outPtr)).slice()
        free(inPtr)
        free(outPtr)
        return out
      },
      catch: (cause) => new EngineError({ engine: spec.name, message: [String(cause), ...stderr].join("\n") })
    })
  })
})

/**
 * The JS engine's own `WebAssembly` plus an in-memory WASI. Portable to
 * browsers and every JS runtime; isolation beyond the wasm sandbox comes
 * from the environment (a browser's renderer process), and there are no
 * memory caps or fuel.
 */
export const JsWasmHost = Layer.succeed(
  WasmHost,
  WasmHost.of({
    name: "js",
    mount: (files) => Effect.succeed({ _tag: "InMemory", files } satisfies MountedTree),
    reactor: Effect.fn("JsWasmHost.reactor")(function*(spec: ReactorSpec, wasm: Uint8Array) {
      const module = yield* Effect.tryPromise({
        try: () => WebAssembly.compile(wasm),
        catch: (cause) => new WasmLoadError({ module: spec.name, cause })
      })
      // A failed call can leave the guest's runtime mid-operation: the next
      // call gets a fresh instance. There is no fuel here, so the render's
      // engine budget is not charged.
      let live: ((input: Uint8Array) => Effect.Effect<Uint8Array, EngineError>) | undefined
      const session = Effect.suspend(() =>
        live !== undefined ? Effect.succeed(live) : instantiateReactor(spec, module).pipe(
          Effect.tap((call) =>
            Effect.sync(() => {
              live = call
            })
          )
        )
      )
      return {
        call: Effect.fn("JsWasmHost.call")(
          function*(input: Uint8Array) {
            const call = yield* session
            return yield* call(input)
          },
          Effect.tapError(() =>
            Effect.sync(() => {
              live = undefined
            })
          ),
          Effect.catchTag("WasmLoadError", (error) =>
            Effect.fail(new EngineError({ engine: spec.name, message: `loading engine: ${String(error.cause)}` })))
        )
      }
    }),

    command: Effect.fn("JsWasmHost.command")(function*(name: string, wasm: Uint8Array) {
      const module = yield* Effect.tryPromise({
        try: () => WebAssembly.compile(wasm),
        catch: (cause) => new WasmLoadError({ module: name, cause })
      })

      const run = Effect.fn("JsWasmHost.run")(function*({ kclPlugin, preopens, stdin }: CommandRun) {
        const stdout: Array<Uint8Array> = []
        const stderr: Array<Uint8Array> = []
        const wasi = new WASI([name], [], [
          new OpenFile(new File(stdin, { readonly: true })),
          new ConsoleStdout((chunk) => stdout.push(chunk.slice())),
          new ConsoleStdout((chunk) => stderr.push(chunk.slice())),
          ...preopens.flatMap(({ guestPath, tree }) =>
            tree._tag === "InMemory" ? [new PreopenDirectory(guestPath, toWasiDirectory(tree.files))] : []
          )
        ], { debug: false })

        let guest: { readonly memory: WebAssembly.Memory; readonly alloc: (size: number) => number } | undefined
        const kclPluginInvokeJsonWasm = (methodPtr: number, argsPtr: number, _kwargsPtr: number): number => {
          if (guest === undefined) return 0
          const { alloc, memory } = guest
          const response = new TextEncoder().encode(
            kclPlugin(readCString(memory, methodPtr) ?? "", readCString(memory, argsPtr) || "[]")
          )
          const dest = alloc(response.length + 1)
          const view = new Uint8Array(memory.buffer, dest, response.length + 1)
          view.set(response)
          view[response.length] = 0
          return dest
        }

        const instance = yield* Effect.tryPromise({
          try: () =>
            WebAssembly.instantiate(module, {
              wasi_snapshot_preview1: wasi.wasiImport,
              env: { kcl_plugin_invoke_json_wasm: kclPluginInvokeJsonWasm }
            }),
          catch: (cause) => new RenderError({ message: `${name}: ${String(cause)}` })
        })
        const { _start: start, akua_bridge_alloc: alloc, memory } = instance.exports
        if (!isMemory(memory) || !isExport(start) || !isExport(alloc)) {
          return yield* new RenderError({ message: `${name}: missing memory/_start/akua_bridge_alloc exports` })
        }
        guest = { memory, alloc: (size) => alloc(size) }

        const exitCode = yield* Effect.try({
          try: () => wasi.start({ exports: { memory, _start: () => start() } }),
          catch: (cause) => new RenderError({ message: `${name} trapped: ${String(cause)}` })
        })
        return { exitCode, stdout: concat(stdout), stderr: concat(stderr) }
      })

      return { run }
    })
  })
)
