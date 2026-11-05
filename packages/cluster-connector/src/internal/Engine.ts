import {
	Clock,
	Context,
	Deferred,
	Duration,
	Effect,
	Exit,
	Layer,
	Option,
	Queue,
	Ref,
	Schema,
	Stream,
	SubscriptionRef
} from 'effect';
import { Ndjson } from 'effect/encoding';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import {
	Engine,
	EngineEvent,
	EngineFailed,
	EngineMessage,
	EngineRejected,
	EngineRequest,
	EngineResponse,
	engineImpersonation,
	engineSupervision,
	fieldManager,
	RequestId
} from '../ClusterConnector';

/**
 * What the agent knows about its engine process, for `/readyz`, live-status
 * staleness and logs. `crashLooping`: the engine exited again within
 * `crashLoopWindowSeconds` of its previous restart.
 */
export interface EngineState {
	readonly phase: 'starting' | 'ready' | 'backoff';
	readonly version: string | null;
	readonly readyAt: number | null;
	readonly crashLooping: boolean;
	readonly restarts: number;
}

export class EngineStatus extends Context.Service<
	EngineStatus,
	{ readonly state: SubscriptionRef.SubscriptionRef<EngineState> }
>()('akua/cluster-connector/EngineStatus') {}

export interface EngineSettings {
	readonly path: string;
	readonly userAgent: string;
}

type Request = typeof EngineRequest.Type;
type Response = typeof EngineResponse.Type;

interface Running {
	readonly queue: Queue.Queue<Request>;
	readonly kill: Effect.Effect<void>;
}

const stderrLimit = 4096;
const hungGraceMillis = 30_000;
const subscribeTimeoutMillis = 60_000;
const shutdownGraceMillis = 60_000;

const decodeMessage = Schema.decodeUnknownExit(EngineMessage);
const isResponseTag = Schema.is(EngineResponse);
const isEvent = Schema.is(EngineEvent);
const encodeRequest = Schema.encodeSync(EngineRequest);
const textEncoder = new TextEncoder();

const hasTag =
	<Tag extends Response['_tag']>(tag: Tag) =>
	(response: Response): response is Extract<Response, { readonly _tag: Tag }> =>
		response._tag === tag;

/**
 * Delay before the next start: the first exit waits `firstRestartSeconds`;
 * an exit within `crashLoopWindowSeconds` of the previous restart doubles
 * the delay up to `maxRestartSeconds` and is a crash loop.
 */
export const nextRestart = (args: {
	readonly previousDelaySeconds: number;
	readonly lastRestartAt: number | null;
	readonly exitedAt: number;
}): { readonly delaySeconds: number; readonly crashLooping: boolean } => {
	const withinWindow =
		args.lastRestartAt !== null &&
		args.exitedAt - args.lastRestartAt < engineSupervision.crashLoopWindowSeconds * 1000;
	if (!withinWindow) {
		return { delaySeconds: engineSupervision.firstRestartSeconds, crashLooping: false };
	}
	return {
		delaySeconds: Math.min(args.previousDelaySeconds * 2, engineSupervision.maxRestartSeconds),
		crashLooping: true
	};
};

/**
 * Supervises one `akua-apply serve` process: requests go out as NDJSON on
 * stdin, responses come back on stdout matched by `id`, and every exit fails
 * the pending requests with `restarted` before the next start. After `ready`
 * the last `subscribe` is sent again.
 */
export const engineLayer = (settings: EngineSettings) =>
	Layer.effectContext(
		Effect.gen(function* () {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			// A queue, not a PubSub: the one consumer (live status) may start after
			// the engine's first `ready` and `synced`, and must still see them.
			const events = yield* Queue.unbounded<typeof EngineEvent.Type>();
			const state = yield* SubscriptionRef.make<EngineState>({
				phase: 'starting',
				version: null,
				readyAt: null,
				crashLooping: false,
				restarts: 0
			});
			const ready = yield* SubscriptionRef.make(Option.none<Running>());
			const pending = new Map<number, Deferred.Deferred<Response, EngineFailed>>();
			const nextId = yield* Ref.make(1);
			const stderrTail = yield* Ref.make('');
			const lastSubscribe = yield* Ref.make(
				Option.none<Omit<Extract<Request, { readonly _tag: 'subscribe' }>, 'id'>>()
			);

			const failPending = Effect.fnUntraced(function* (failure: EngineFailed) {
				const waiting = [...pending.values()];
				pending.clear();
				yield* Effect.forEach(waiting, (deferred) => Deferred.fail(deferred, failure), {
					discard: true
				});
			});

			const send = (
				build: (id: typeof RequestId.Type) => Request,
				timeoutMillis: number
			): Effect.Effect<Response, EngineFailed | EngineRejected> =>
				Effect.gen(function* () {
					const id = RequestId.make(yield* Ref.getAndUpdate(nextId, (n) => n + 1));
					const deferred = yield* Deferred.make<Response, EngineFailed>();
					const sentTo = yield* Ref.make(Option.none<Running>());
					const exchange = Effect.gen(function* () {
						const running = yield* SubscriptionRef.changes(ready).pipe(
							Stream.filter(Option.isSome),
							Stream.map((value) => value.value),
							Stream.runHead
						);
						if (Option.isNone(running)) return yield* Deferred.await(deferred);
						pending.set(id, deferred);
						yield* Ref.set(sentTo, running);
						yield* Queue.offer(running.value.queue, build(id));
						return yield* Deferred.await(deferred);
					});
					const response = yield* exchange.pipe(
						Effect.timeoutOrElse({
							duration: Duration.millis(timeoutMillis),
							orElse: () =>
								Effect.gen(function* () {
									pending.delete(id);
									const target = yield* Ref.get(sentTo);
									// A sent request without an answer means the engine hangs: restart it.
									if (Option.isSome(target)) yield* target.value.kill;
									return yield* new EngineFailed({
										reason: 'timeout',
										exitCode: null,
										stderr: yield* Ref.get(stderrTail)
									});
								})
						}),
						Effect.onInterrupt(() => Effect.sync(() => pending.delete(id)))
					);
					if (response._tag === 'rejected') {
						return yield* new EngineRejected({ failure: response.failure });
					}
					return response;
				});

			const expect = <Tag extends Response['_tag']>(tag: Tag) =>
				Effect.flatMap((response: Response) =>
					hasTag(tag)(response)
						? Effect.succeed(response)
						: Effect.fail(
								new EngineFailed({
									reason: 'decode',
									exitCode: null,
									stderr: `expected ${tag}, engine answered ${response._tag}`
								})
							)
				);

			const onLine = Effect.fnUntraced(function* (line: unknown) {
				const decoded = decodeMessage(line);
				if (Exit.isFailure(decoded)) {
					const id =
						typeof line === 'object' && line !== null && 'id' in line && typeof line.id === 'number'
							? line.id
							: null;
					const deferred = id === null ? undefined : pending.get(id);
					if (deferred !== undefined && id !== null) {
						pending.delete(id);
						yield* Deferred.fail(
							deferred,
							new EngineFailed({ reason: 'decode', exitCode: null, stderr: 'undecodable response' })
						);
					}
					yield* Effect.logWarning('undecodable engine line');
					return;
				}
				const message = decoded.value;
				if (isResponseTag(message) && 'id' in message) {
					const deferred = pending.get(message.id);
					if (deferred === undefined) return;
					pending.delete(message.id);
					yield* Deferred.succeed(deferred, message);
					return;
				}
				if (!isEvent(message)) return;
				if (message._tag === 'ready') {
					const now = yield* Clock.currentTimeMillis;
					yield* SubscriptionRef.update(state, (current) => ({
						...current,
						phase: 'ready' as const,
						version: message.version,
						readyAt: now
					}));
				}
				yield* Queue.offer(events, message);
			});

			/** One process from spawn to exit. Resolves to its exit code, null when it never spawned. */
			const runOnce = Effect.gen(function* () {
				const handle = yield* spawner.spawn(
					ChildProcess.make(settings.path, ['serve', '--user-agent', settings.userAgent], {
						killSignal: 'SIGTERM',
						forceKillAfter: '10 seconds'
					})
				);
				const queue = yield* Queue.unbounded<Request>();
				const killed = yield* Deferred.make<void>();
				const running: Running = {
					queue,
					kill: Deferred.succeed(killed, undefined).pipe(Effect.asVoid)
				};
				yield* Ref.set(stderrTail, '');

				yield* Stream.fromQueue(queue).pipe(
					Stream.map((request) =>
						textEncoder.encode(`${JSON.stringify(encodeRequest(request))}\n`)
					),
					Stream.run(handle.stdin),
					Effect.ignore,
					Effect.forkScoped
				);
				yield* handle.stderr.pipe(
					Stream.decodeText(),
					Stream.splitLines,
					Stream.runForEach((line) =>
						Ref.update(stderrTail, (tail) => `${tail}${line}\n`.slice(-stderrLimit)).pipe(
							Effect.andThen(Effect.logDebug(line).pipe(Effect.annotateLogs({ source: 'engine' })))
						)
					),
					Effect.ignore,
					Effect.forkScoped
				);
				yield* handle.stdout.pipe(
					Stream.pipeThroughChannel(Ndjson.decode({ ignoreEmptyLines: true })),
					Stream.runForEach(onLine),
					Effect.catch((cause) =>
						Effect.logWarning('engine stdout ended with an error').pipe(
							Effect.annotateLogs({ cause: String(cause) })
						)
					),
					// Without stdout no request can be answered: restart rather than wait out timeouts.
					Effect.ensuring(Deferred.succeed(killed, undefined)),
					Effect.forkScoped
				);
				// Publish the process for requests once it announced `ready`.
				yield* SubscriptionRef.changes(state).pipe(
					Stream.filter((value) => value.phase === 'ready'),
					Stream.take(1),
					Stream.runForEach(() =>
						Effect.gen(function* () {
							yield* SubscriptionRef.set(ready, Option.some(running));
							const subscription = yield* Ref.get(lastSubscribe);
							if (Option.isSome(subscription)) {
								yield* send((id) => ({ ...subscription.value, id }), subscribeTimeoutMillis).pipe(
									Effect.ignore,
									Effect.forkScoped
								);
							}
						})
					),
					Effect.forkScoped
				);
				const exit = yield* Effect.raceFirst(
					handle.exitCode.pipe(Effect.map(Option.some)),
					Deferred.await(killed).pipe(
						Effect.andThen(handle.kill({ killSignal: 'SIGTERM', forceKillAfter: '10 seconds' })),
						Effect.ignore,
						Effect.andThen(handle.exitCode.pipe(Effect.option))
					)
				);
				return Option.getOrNull(Option.map(exit, Number));
			}).pipe(Effect.scoped);

			const supervise = Effect.gen(function* () {
				let delaySeconds: number = engineSupervision.firstRestartSeconds;
				let lastRestartAt: number | null = null;
				while (true) {
					yield* SubscriptionRef.update(state, (current) => ({
						...current,
						phase: 'starting' as const,
						version: null,
						readyAt: null
					}));
					const result = yield* runOnce.pipe(Effect.exit);
					yield* SubscriptionRef.set(ready, Option.none());
					const exitCode = Exit.isSuccess(result) ? result.value : null;
					yield* failPending(
						new EngineFailed({
							reason: Exit.isSuccess(result) ? 'restarted' : 'spawn',
							exitCode,
							stderr: yield* Ref.get(stderrTail)
						})
					);
					const exitedAt = yield* Clock.currentTimeMillis;
					const next = nextRestart({ previousDelaySeconds: delaySeconds, lastRestartAt, exitedAt });
					delaySeconds = next.delaySeconds;
					yield* SubscriptionRef.update(state, (current) => ({
						...current,
						phase: 'backoff' as const,
						version: null,
						readyAt: null,
						crashLooping: next.crashLooping,
						restarts: current.restarts + 1
					}));
					yield* Effect.logWarning('engine exited').pipe(
						Effect.annotateLogs({ exitCode: String(exitCode), restartInSeconds: delaySeconds })
					);
					yield* Effect.sleep(Duration.seconds(delaySeconds));
					lastRestartAt = yield* Clock.currentTimeMillis;
				}
			});

			// Running a full window without an exit ends a crash loop.
			const clearCrashLoop = SubscriptionRef.changes(state).pipe(
				Stream.filter((value) => value.phase === 'ready' && value.crashLooping),
				Stream.runForEach(() =>
					Effect.sleep(Duration.seconds(engineSupervision.crashLoopWindowSeconds)).pipe(
						Effect.andThen(
							SubscriptionRef.update(state, (current) =>
								current.phase === 'ready' ? { ...current, crashLooping: false } : current
							)
						)
					)
				)
			);

			yield* Effect.forkScoped(supervise);
			yield* Effect.forkScoped(clearCrashLoop);
			yield* Effect.addFinalizer(() =>
				Effect.gen(function* () {
					const running = yield* SubscriptionRef.get(ready);
					if (Option.isNone(running)) return;
					yield* send((id) => ({ _tag: 'shutdown', id }), shutdownGraceMillis).pipe(Effect.ignore);
				})
			);

			const engine = Engine.of({
				apply: Effect.fn('Engine.apply')(function* (request) {
					return yield* send(
						(id) => ({
							...request,
							_tag: 'apply',
							id,
							fieldManager,
							impersonate: engineImpersonation
						}),
						request.timeoutSeconds * 1000 + hungGraceMillis
					).pipe(expect('applied'));
				}),
				prune: Effect.fn('Engine.prune')(function* (request) {
					return yield* send(
						(id) => ({ ...request, _tag: 'prune', id, impersonate: engineImpersonation }),
						request.timeoutSeconds * 1000 + hungGraceMillis
					).pipe(expect('pruned'));
				}),
				wait: Effect.fn('Engine.wait')(function* (request) {
					return yield* send(
						(id) => ({ ...request, _tag: 'wait', id }),
						request.timeoutSeconds * 1000 + hungGraceMillis
					).pipe(expect('waited'));
				}),
				subscribe: Effect.fn('Engine.subscribe')(function* (request) {
					const body = { ...request, _tag: 'subscribe' as const, impersonate: engineImpersonation };
					yield* Ref.set(lastSubscribe, Option.some(body));
					return yield* send((id) => ({ ...body, id }), subscribeTimeoutMillis).pipe(
						expect('subscribed')
					);
				}),
				events: Stream.fromQueue(events)
			});

			return Context.make(Engine, engine).pipe(
				Context.add(EngineStatus, EngineStatus.of({ state }))
			);
		})
	);
