import { expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { WasmHost } from '../../akuapkg/src/host';
import { JsWasmCompiler, JsWasmHost } from '../../akuapkg/src/host-js.effect';

// (module (memory (export "memory") 1) (func (export "_start"))
//   (func (export "akua_bridge_alloc") (param i32) (result i32) i32.const 0))
const commandWasm = new Uint8Array([
	0, 97, 115, 109, 1, 0, 0, 0, 1, 9, 2, 96, 0, 0, 96, 1, 127, 1, 127, 3, 3, 2, 0, 1, 5, 3, 1, 0, 1,
	7, 39, 3, 6, 109, 101, 109, 111, 114, 121, 2, 0, 6, 95, 115, 116, 97, 114, 116, 0, 0, 17, 97, 107,
	117, 97, 95, 98, 114, 105, 100, 103, 101, 95, 97, 108, 108, 111, 99, 0, 1, 10, 9, 2, 2, 0, 11, 4,
	0, 65, 0, 11
]);

it.effect('runs a prepared JS Wasm command inside a synchronous Package plugin callback', () =>
	Effect.gen(function* () {
		const host = yield* WasmHost;
		const command = yield* host.command('plugin-child', commandWasm);
		const invokePlugin = () =>
			Effect.runSync(
				command.run({
					stdin: new Uint8Array(),
					preopens: [],
					kclPlugin: () => '{}'
				})
			);
		const result = yield* Effect.sync(invokePlugin);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toEqual(new Uint8Array());
	}).pipe(Effect.provide(JsWasmHost))
);

it.effect('uses an injected precompiled module in a runtime without byte compilation', () =>
	Effect.gen(function* () {
		const module = yield* Effect.promise(() => WebAssembly.compile(commandWasm));
		return yield* Effect.gen(function* () {
			const host = yield* WasmHost;
			const command = yield* host.command('precompiled-child', new Uint8Array([0]));
			const result = Effect.runSync(
				command.run({ stdin: new Uint8Array(), preopens: [], kclPlugin: () => '{}' })
			);
			expect(result.exitCode).toBe(0);
		}).pipe(
			Effect.provide(JsWasmHost),
			Effect.provideService(JsWasmCompiler, (name) =>
				Effect.sync(() => {
					expect(name).toBe('precompiled-child');
					return module;
				})
			)
		);
	})
);
