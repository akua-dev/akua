import { BunServices } from '@effect/platform-bun';
import { describe, expect, it } from '@effect/vitest';
import { Effect, FileSystem, Layer, PlatformError } from 'effect';
import type { InstanceOptions, Outcome } from '../../../crates/wasm-sandbox/index';
import { WasmHost } from '../../akuapkg/src/host';
import { NativeWasmHost } from '../../akuapkg/src/host-native.effect';
import { NativeSandbox } from '../../akuapkg/src/native';

// Windows refuses directory removal while WASI still owns a preopen handle.
// Model that OS boundary while exercising the real mount and command adapter.
describe('native command lifetime', () => {
	for (const outcome of [{ _tag: 'Exited', code: 0 }, { _tag: 'OutOfFuel' }] satisfies Outcome[]) {
		it.effect(`releases preopens before directory cleanup after ${outcome._tag}`, () =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const held = new Set<string>();
				const directories: string[] = [];
				class TestInstance {
					constructor(readonly options: InstanceOptions) {
						for (const preopen of options.preopens) held.add(preopen.hostPath);
					}
					call(): Outcome {
						return outcome;
					}
					setFuel(): void {}
					fuel(): number {
						return 0;
					}
					read(): Buffer {
						return Buffer.alloc(0);
					}
					write(): void {}
					stdout(): Buffer {
						return Buffer.from('result');
					}
					stderr(): Buffer {
						return Buffer.alloc(0);
					}
					dispose(): void {
						for (const preopen of this.options.preopens) held.delete(preopen.hostPath);
					}
				}
				class TestSandbox {
					load() {
						return { instantiate: (options: InstanceOptions) => new TestInstance(options) };
					}
				}
				const windowsFs = FileSystem.make({
					...fs,
					makeTempDirectoryScoped: (options) =>
						Effect.acquireRelease(
							fs
								.makeTempDirectory(options)
								.pipe(Effect.tap((directory) => Effect.sync(() => directories.push(directory)))),
							(directory) =>
								held.has(directory)
									? Effect.die(
											PlatformError.systemError({
												_tag: 'Busy',
												module: 'FileSystem',
												method: 'remove',
												pathOrDescriptor: directory
											})
										)
									: fs.remove(directory, { recursive: true }).pipe(Effect.orDie)
						)
				});
				const hostLayer = NativeWasmHost().pipe(
					Layer.provide(Layer.succeed(FileSystem.FileSystem, windowsFs)),
					Layer.provide(NativeSandbox.layer(() => ({ Sandbox: TestSandbox })))
				);
				const result = yield* Effect.scoped(
					Effect.gen(function* () {
						const host = yield* WasmHost;
						const tree = yield* host.mount(new Map([['Package.k', Buffer.from('resources = []')]]));
						const command = yield* host.command('worker', Bun.zstdCompressSync(Buffer.alloc(0)));
						return yield* Effect.exit(
							command.run({
								stdin: Buffer.alloc(0),
								preopens: [{ guestPath: '/package', tree }],
								kclPlugin: () => ''
							})
						);
					}).pipe(Effect.provide(hostLayer))
				);
				expect(result._tag).toBe(outcome._tag === 'Exited' ? 'Success' : 'Failure');
				for (const directory of directories) expect(yield* fs.exists(directory)).toBe(false);
			}).pipe(Effect.provide(BunServices.layer))
		);
	}
});
