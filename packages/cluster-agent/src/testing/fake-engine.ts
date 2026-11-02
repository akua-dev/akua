import { Cause, Context, Deferred, Effect, Layer, Queue, Ref, Schema, Sink, Stream } from 'effect';
import { ChildProcessSpawner } from 'effect/process';
import type { ChildProcess } from 'effect/process';
import { EngineMessage, EngineRequest } from '../contract';

/**
 * An in-memory `akua-apply serve`: a ChildProcessSpawner whose processes
 * read NDJSON requests from stdin and answer through a scripted handler,
 * so the agent's supervision, framing and correlation run unchanged.
 */
export type FakeRequest = typeof EngineRequest.Type;
export type FakeMessage = typeof EngineMessage.Encoded;

export interface FakeProcess {
	readonly number: number;
	readonly command: ChildProcess.Command;
	/** Write one stdout line (any JSON, valid or not). */
	readonly emit: (line: unknown) => Effect.Effect<void>;
	/** Write raw text to stdout, for framing tests. */
	readonly emitRaw: (text: string) => Effect.Effect<void>;
	/** Exit with this code, as a crash would. */
	readonly exit: (code: number) => Effect.Effect<void>;
}

export type FakeBehavior = (request: FakeRequest, process: FakeProcess) => Effect.Effect<void>;

export class FakeEngine extends Context.Service<
	FakeEngine,
	{
		readonly spawns: Effect.Effect<number>;
		readonly requests: Effect.Effect<ReadonlyArray<FakeRequest>>;
		readonly current: Effect.Effect<FakeProcess | null>;
		/** Replaces the behavior for every later request. */
		readonly setBehavior: (behavior: FakeBehavior) => Effect.Effect<void>;
		/** When false, spawned processes do not announce `ready` on their own. */
		readonly setAutoReady: (enabled: boolean) => Effect.Effect<void>;
		readonly setSpawnFailure: (failing: boolean) => Effect.Effect<void>;
	}
>()('akua/cluster-agent/testing/FakeEngine') {}

export const readyLine = (version: string): FakeMessage => ({
	_tag: 'ready',
	protocol: 1,
	version,
	ssa: 'v0.83.0',
	cliUtils: 'v1.4.0'
});

/** Answers every request successfully and empty, like an engine with nothing to do. */
export const answerEverything: FakeBehavior = (request, process) => {
	switch (request._tag) {
		case 'apply':
			return process.emit({
				_tag: 'applied',
				id: request.id,
				changes: request.manifests.map((manifest) => ({
					key: keyOfManifest(manifest),
					version: versionOfManifest(manifest),
					action: 'created'
				})),
				driftCorrected: [],
				failure: null
			});
		case 'prune':
			return process.emit({
				_tag: 'pruned',
				id: request.id,
				deleted: request.stale,
				survivors: []
			});
		case 'wait':
			return process.emit({
				_tag: 'waited',
				id: request.id,
				health: request.members.map((member) => ({
					key: member.key,
					status: request.until === 'current' ? 'Current' : 'NotFound',
					message: ''
				})),
				failure: null
			});
		case 'subscribe':
			return process.emit({
				_tag: 'subscribed',
				id: request.id,
				watchedObjects: request.placements.reduce((sum, p) => sum + p.inventory.length, 0)
			});
		case 'shutdown':
			return process
				.emit({ _tag: 'stopping', id: request.id })
				.pipe(Effect.andThen(process.exit(0)));
	}
};

const field = (value: unknown, key: string): unknown =>
	typeof value === 'object' && value !== null && key in value
		? Object.getOwnPropertyDescriptor(value, key)?.value
		: undefined;
const text = (value: unknown): string => (typeof value === 'string' ? value : '');

export const versionOfManifest = (manifest: unknown): string => {
	const apiVersion = text(field(manifest, 'apiVersion'));
	return apiVersion.includes('/') ? apiVersion.slice(apiVersion.indexOf('/') + 1) : apiVersion;
};

export const keyOfManifest = (manifest: unknown): string => {
	const apiVersion = text(field(manifest, 'apiVersion'));
	const group = apiVersion.includes('/') ? apiVersion.slice(0, apiVersion.indexOf('/')) : '';
	const metadata = field(manifest, 'metadata');
	return `${text(field(metadata, 'namespace'))}_${text(field(metadata, 'name'))}_${group}_${text(field(manifest, 'kind'))}`;
};

const decodeRequest = Schema.decodeUnknownEffect(Schema.fromJsonString(EngineRequest));
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export const fakeEngineLayer = (options: { readonly version: string }) =>
	Layer.effectContext(
		Effect.gen(function* () {
			const spawns = yield* Ref.make(0);
			const requests = yield* Ref.make<ReadonlyArray<FakeRequest>>([]);
			const current = yield* Ref.make<FakeProcess | null>(null);
			const behavior = yield* Ref.make<FakeBehavior>(answerEverything);
			const autoReady = yield* Ref.make(true);
			const spawnFailure = yield* Ref.make(false);

			const spawner = ChildProcessSpawner.make((command) =>
				Effect.gen(function* () {
					if (yield* Ref.get(spawnFailure)) {
						return yield* Effect.die(new Error('spawn failed: engine binary missing'));
					}
					const number = yield* Ref.updateAndGet(spawns, (n) => n + 1);
					const stdout = yield* Queue.unbounded<Uint8Array, Cause.Done>();
					const exited = yield* Deferred.make<number>();
					const exit = (code: number) =>
						Deferred.succeed(exited, code).pipe(Effect.andThen(Queue.end(stdout)), Effect.asVoid);
					const process: FakeProcess = {
						number,
						command,
						emit: (line) =>
							Queue.offer(stdout, textEncoder.encode(`${JSON.stringify(line)}\n`)).pipe(
								Effect.asVoid
							),
						emitRaw: (raw) => Queue.offer(stdout, textEncoder.encode(raw)).pipe(Effect.asVoid),
						exit
					};
					yield* Ref.set(current, process);
					let buffer = '';
					const stdin = Sink.forEach((chunk: Uint8Array) =>
						Effect.gen(function* () {
							buffer += textDecoder.decode(chunk);
							let newline = buffer.indexOf('\n');
							while (newline >= 0) {
								const line = buffer.slice(0, newline);
								buffer = buffer.slice(newline + 1);
								newline = buffer.indexOf('\n');
								const request = yield* decodeRequest(line).pipe(Effect.orDie);
								yield* Ref.update(requests, (all) => [...all, request]);
								const handle = yield* Ref.get(behavior);
								yield* handle(request, process);
							}
						})
					);
					if (yield* Ref.get(autoReady)) yield* process.emit(readyLine(options.version));
					yield* Effect.addFinalizer(() => exit(137));
					return ChildProcessSpawner.makeHandle({
						pid: ChildProcessSpawner.ProcessId(number),
						exitCode: Deferred.await(exited).pipe(Effect.map(ChildProcessSpawner.ExitCode)),
						isRunning: Deferred.isDone(exited).pipe(Effect.map((done) => !done)),
						kill: () => exit(143),
						stdin,
						stdout: Stream.fromQueue(stdout),
						stderr: Stream.empty,
						all: Stream.fromQueue(stdout),
						getInputFd: () => Sink.drain,
						getOutputFd: () => Stream.empty,
						unref: Effect.succeed(Effect.void)
					});
				})
			);

			const control = FakeEngine.of({
				spawns: Ref.get(spawns),
				requests: Ref.get(requests),
				current: Ref.get(current),
				setBehavior: (next) => Ref.set(behavior, next),
				setAutoReady: (enabled) => Ref.set(autoReady, enabled),
				setSpawnFailure: (failing) => Ref.set(spawnFailure, failing)
			});
			return Context.make(ChildProcessSpawner.ChildProcessSpawner, spawner).pipe(
				Context.add(FakeEngine, control)
			);
		})
	);
