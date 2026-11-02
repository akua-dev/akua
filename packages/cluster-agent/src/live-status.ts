import {
	Clock,
	Context,
	Duration,
	Effect,
	Layer,
	Queue,
	Ref,
	Schedule,
	Stream,
	SubscriptionRef
} from 'effect';
import type ids from '@platform/ids';
import {
	KStatus,
	LiveReason,
	type LiveEntry,
	type LiveHealth,
	type ResourceNode,
	type WarningEvent
} from '@platform/api-contract/services/cluster-agent';
import { Engine, EngineEvent, engineSupervision } from './contract';
import { EngineStatus } from './engine';
import { AgentApi } from './platform';

type PlacementId = typeof ids.placement.prefixedEffect.Type;
type Node = typeof ResourceNode.Type;
type Warning = typeof WarningEvent.Type;
type Entry = typeof LiveEntry.Type;
type Status = typeof KStatus.Type;

export const liveStatusPolicy = {
	debounceMillis: 2_000,
	maxEntriesPerBatch: 100,
	snapshotIntervalMillis: 5 * 60_000,
	maxTreeNodes: 500,
	maxEvents: 50,
	maxDeltaItems: 500,
	retryAfterFailureMillis: 5_000
} as const;

const reasonRank = new Map(LiveReason.literals.map((reason, index) => [reason, index]));

/**
 * Flux `AggregateStatus` over the members: any Failed is Failed, then
 * Unknown, then anything not Current is InProgress; no members is Current.
 */
export const aggregateStatus = (statuses: ReadonlyArray<Status>): Status => {
	if (statuses.includes('Failed')) return 'Failed';
	if (statuses.includes('Unknown')) return 'Unknown';
	if (statuses.some((status) => status !== 'Current')) return 'InProgress';
	return 'Current';
};

const isPod = (node: Node) => node.key.endsWith('__Pod');

export const healthOf = (nodes: Iterable<Node>): typeof LiveHealth.Type => {
	const all = [...nodes];
	const members = all.filter((node) => node.member);
	const reasons = new Set<typeof LiveReason.Type>();
	let restarts = 0;
	let pods = 0;
	let readyPods = 0;
	for (const node of all) {
		for (const reason of node.reasons) reasons.add(reason);
		if (!isPod(node)) continue;
		pods += 1;
		const running = node.containers.filter((container) => !container.init);
		if (running.length > 0 && running.every((container) => container.ready)) readyPods += 1;
		for (const container of node.containers) restarts += container.restartCount;
	}
	return {
		status: aggregateStatus(members.map((node) => node.status)),
		reasons: [...reasons].sort((a, b) => (reasonRank.get(a) ?? 99) - (reasonRank.get(b) ?? 99)),
		restarts,
		readyPods,
		pods
	};
};

/** Members first, then the newest children; at most `maxTreeNodes`. */
export const treeOf = (
	nodes: Iterable<Node>
): { readonly tree: ReadonlyArray<Node>; readonly truncated: boolean } => {
	const all = [...nodes];
	const ordered = [
		...all.filter((node) => node.member),
		...all.filter((node) => !node.member).sort((a, b) => b.observedAt - a.observedAt)
	];
	return {
		tree: ordered.slice(0, liveStatusPolicy.maxTreeNodes),
		truncated: ordered.length > liveStatusPolicy.maxTreeNodes
	};
};

const warningKey = (event: Warning) => `${event.involved}\u0000${event.reason}`;

const newestEvents = (events: Iterable<Warning>) =>
	[...events].sort((a, b) => b.lastSeen - a.lastSeen).slice(0, liveStatusPolicy.maxEvents);

interface PlacementLive {
	generation: number;
	sequence: number;
	synced: boolean;
	needsSnapshot: boolean;
	baseline: boolean;
	readonly nodes: Map<string, Node>;
	readonly events: Map<string, Warning>;
	readonly upserted: Set<string>;
	readonly removed: Set<string>;
	readonly newEvents: Set<string>;
	stale: {
		readonly reason: 'engine-crash-looping' | 'engine-no-snapshot';
		readonly since: number;
	} | null;
}

/**
 * Live status between reconciles: folds engine events for every watched
 * Placement and posts StatusBatches only for the Placements the platform
 * subscribed (`Subscribe.v1`), debounced 2 s after the first change, one in
 * flight, at most 100 entries. A subscribed Placement gets a snapshot when
 * its subscription starts, once its informers synced after each engine
 * start, after every reconcile, every 5 minutes and when the platform asks;
 * a lost batch turns its Placements into snapshots. Unsubscribed Placements
 * keep their tree in memory (for `Describe.v1` and `TailLogs.v1`) and send
 * nothing.
 */
export class LiveStatus extends Context.Service<
	LiveStatus,
	{
		/** The Placements the engine watches now, with their generations. */
		readonly watch: (
			placements: ReadonlyArray<{ readonly placementId: PlacementId; readonly generation: number }>
		) => Effect.Effect<void>;
		readonly requestSnapshot: (placementId: PlacementId) => Effect.Effect<void>;
		/** The Placements whose live status the platform wants now; replaces the previous set. */
		readonly subscribe: (placements: ReadonlyArray<PlacementId>) => Effect.Effect<void>;
		/** The object as a node of the Placement's tree (an ApplySet member or a child of one); null otherwise. */
		readonly treeNode: (placementId: PlacementId, key: string) => Effect.Effect<Node | null>;
	}
>()('akua/cluster-agent/LiveStatus') {
	static readonly layer = Layer.effect(
		LiveStatus,
		Effect.gen(function* () {
			const engine = yield* Engine;
			const engineStatus = yield* EngineStatus;
			const api = yield* AgentApi;
			const placements = new Map<PlacementId, PlacementLive>();
			let subscribed = new Set<PlacementId>();
			const changed = yield* Queue.sliding<void>(1);
			// Starting at the clock keeps sequences increasing across agent restarts.
			const sequenceBase = yield* Clock.currentTimeMillis;
			const engineStart = yield* Ref.make(0);
			const signal = Queue.offer(changed, undefined).pipe(Effect.asVoid);

			const fresh = (generation: number): PlacementLive => ({
				generation,
				sequence: sequenceBase - 1,
				synced: false,
				needsSnapshot: true,
				baseline: false,
				nodes: new Map(),
				events: new Map(),
				upserted: new Set(),
				removed: new Set(),
				newEvents: new Set(),
				stale: null
			});

			const clearDelta = (live: PlacementLive) => {
				live.upserted.clear();
				live.removed.clear();
				live.newEvents.clear();
			};

			const fold = Effect.fnUntraced(function* (event: typeof EngineEvent.Type) {
				switch (event._tag) {
					case 'ready': {
						const start = yield* Ref.updateAndGet(engineStart, (n) => n + 1);
						const readyAt = yield* Clock.currentTimeMillis;
						for (const live of placements.values()) {
							live.synced = false;
							live.needsSnapshot = true;
							live.nodes.clear();
							live.events.clear();
							clearDelta(live);
						}
						yield* Effect.sleep(Duration.seconds(engineSupervision.snapshotGraceSeconds)).pipe(
							Effect.andThen(
								Effect.gen(function* () {
									if ((yield* Ref.get(engineStart)) !== start) return;
									let marked = false;
									for (const live of placements.values()) {
										if (live.synced || live.stale !== null) continue;
										live.stale = {
											reason: 'engine-no-snapshot',
											since: readyAt + engineSupervision.snapshotGraceSeconds * 1000
										};
										marked = true;
									}
									if (marked) yield* signal;
								})
							),
							Effect.forkDetach
						);
						return;
					}
					case 'node': {
						const live = placements.get(event.placementId);
						if (live === undefined) return;
						live.nodes.set(event.node.key, event.node);
						live.removed.delete(event.node.key);
						live.upserted.add(event.node.key);
						break;
					}
					case 'removed': {
						const live = placements.get(event.placementId);
						if (live === undefined) return;
						live.nodes.delete(event.key);
						live.upserted.delete(event.key);
						live.removed.add(event.key);
						break;
					}
					case 'warning': {
						const live = placements.get(event.placementId);
						if (live === undefined) return;
						const key = warningKey(event.event);
						live.events.set(key, event.event);
						live.newEvents.add(key);
						if (live.events.size > liveStatusPolicy.maxEvents * 4) {
							// Only the newest are ever sent; drop the rest so the map stays bounded.
							const keep = new Set(newestEvents(live.events.values()).map(warningKey));
							for (const existing of [...live.events.keys()]) {
								if (!keep.has(existing)) live.events.delete(existing);
							}
						}
						break;
					}
					case 'synced': {
						const live = placements.get(event.placementId);
						if (live === undefined) return;
						if (!live.synced) live.needsSnapshot = true;
						live.synced = true;
						break;
					}
					case 'overloaded':
						yield* Effect.logWarning('engine overloaded; live status falls back to snapshots').pipe(
							Effect.annotateLogs({ watchedObjects: event.watchedObjects })
						);
						return;
					case 'error':
						yield* Effect.logWarning('engine live-status error').pipe(
							Effect.annotateLogs({
								placementId: event.placementId ?? 'none',
								reason: event.reason,
								message: event.message
							})
						);
						return;
				}
				yield* signal;
			});

			/** Takes up to `max` entries out of the current state; the rest wait for the next batch. */
			const collect = Effect.fnUntraced(function* (max: number) {
				const now = yield* Clock.currentTimeMillis;
				const entries: Array<Entry> = [];
				const included: Array<PlacementId> = [];
				const staleSent: Array<readonly [PlacementLive, NonNullable<PlacementLive['stale']>]> = [];
				let deferred = false;
				for (const [placementId, live] of placements) {
					if (entries.length >= max) break;
					if (!subscribed.has(placementId)) {
						// Nobody looks: drop the delta; a later subscription starts with a snapshot.
						clearDelta(live);
						continue;
					}
					let added = false;
					if (live.stale !== null) {
						entries.push({
							_tag: 'stale',
							stale: { placement_id: placementId, generation: live.generation, ...live.stale }
						});
						staleSent.push([live, live.stale]);
						live.stale = null;
						added = true;
					}
					if (entries.length >= max) {
						included.push(placementId);
						break;
					}
					if (live.needsSnapshot && live.synced) {
						live.sequence += 1;
						const { tree, truncated } = treeOf(live.nodes.values());
						entries.push({
							_tag: 'snapshot',
							snapshot: {
								placement_id: placementId,
								generation: live.generation,
								sequence: live.sequence,
								health: healthOf(live.nodes.values()),
								tree,
								events: newestEvents(live.events.values()),
								truncated: truncated || live.events.size > liveStatusPolicy.maxEvents,
								observed_at: now
							}
						});
						live.needsSnapshot = false;
						live.baseline = true;
						clearDelta(live);
						added = true;
					} else if (
						!live.needsSnapshot &&
						live.baseline &&
						(live.upserted.size > 0 || live.removed.size > 0 || live.newEvents.size > 0)
					) {
						const upserted = [...live.upserted].flatMap((key) => {
							const node = live.nodes.get(key);
							return node === undefined ? [] : [node];
						});
						const removed = [...live.removed];
						if (
							upserted.length > liveStatusPolicy.maxDeltaItems ||
							removed.length > liveStatusPolicy.maxDeltaItems
						) {
							live.needsSnapshot = true;
							deferred = true;
						} else {
							live.sequence += 1;
							entries.push({
								_tag: 'delta',
								delta: {
									placement_id: placementId,
									generation: live.generation,
									sequence: live.sequence,
									health: healthOf(live.nodes.values()),
									upserted,
									removed,
									events: newestEvents(
										[...live.newEvents].flatMap((key) => {
											const event = live.events.get(key);
											return event === undefined ? [] : [event];
										})
									),
									observed_at: now
								}
							});
							added = true;
						}
						clearDelta(live);
					}
					if (added) included.push(placementId);
				}
				return { entries, included, staleSent, deferred };
			});

			const flushOnce = Effect.gen(function* () {
				const { entries, included, staleSent, deferred } = yield* collect(
					liveStatusPolicy.maxEntriesPerBatch
				);
				const [first, ...rest] = entries;
				if (first === undefined) return deferred;
				const outcome = yield* api
					.status({ payload: { entries: [first, ...rest] } })
					.pipe(Effect.result);
				if (outcome._tag === 'Failure') {
					// Deltas of a lost batch would leave a gap; send snapshots instead.
					for (const placementId of included) {
						const live = placements.get(placementId);
						if (live !== undefined) live.needsSnapshot = true;
					}
					for (const [live, stale] of staleSent) if (live.stale === null) live.stale = stale;
					yield* Effect.logWarning('status batch not accepted').pipe(
						Effect.annotateLogs({ reason: outcome.failure._tag })
					);
					yield* Effect.sleep(Duration.millis(liveStatusPolicy.retryAfterFailureMillis));
					return true;
				}
				for (const placementId of outcome.success.snapshot_required) {
					const live = placements.get(placementId);
					if (live !== undefined) live.needsSnapshot = true;
				}
				return (
					deferred ||
					outcome.success.snapshot_required.length > 0 ||
					entries.length >= liveStatusPolicy.maxEntriesPerBatch
				);
			});

			const flusher = Effect.gen(function* () {
				while (true) {
					yield* Queue.take(changed);
					yield* Effect.sleep(Duration.millis(liveStatusPolicy.debounceMillis));
					let more = true;
					while (more) more = yield* flushOnce;
				}
			});

			const crashLoops = SubscriptionRef.changes(engineStatus.state).pipe(
				Stream.map((state) => state.crashLooping),
				Stream.changes,
				Stream.filter((looping) => looping),
				Stream.runForEach(() =>
					Effect.gen(function* () {
						const since = yield* Clock.currentTimeMillis;
						for (const live of placements.values()) {
							live.stale = { reason: 'engine-crash-looping', since };
						}
						yield* signal;
					})
				)
			);

			const periodicSnapshots = Effect.gen(function* () {
				for (const [placementId, live] of placements)
					if (subscribed.has(placementId)) live.needsSnapshot = true;
				yield* signal;
			}).pipe(
				Effect.repeat(Schedule.spaced(Duration.millis(liveStatusPolicy.snapshotIntervalMillis)))
			);

			yield* Effect.forkScoped(Stream.runForEach(engine.events, fold));
			yield* Effect.forkScoped(flusher);
			yield* Effect.forkScoped(crashLoops);
			yield* Effect.forkScoped(
				Effect.delay(periodicSnapshots, Duration.millis(liveStatusPolicy.snapshotIntervalMillis))
			);

			return LiveStatus.of({
				watch: (watched) =>
					Effect.gen(function* () {
						const keep = new Set(watched.map((entry) => entry.placementId));
						for (const placementId of placements.keys()) {
							if (!keep.has(placementId)) placements.delete(placementId);
						}
						for (const entry of watched) {
							const live = placements.get(entry.placementId);
							if (live === undefined) placements.set(entry.placementId, fresh(entry.generation));
							else if (live.generation !== entry.generation) {
								live.generation = entry.generation;
								live.needsSnapshot = true;
							}
						}
						yield* signal;
					}),
				subscribe: (next) =>
					Effect.gen(function* () {
						const added = next.filter((placementId) => !subscribed.has(placementId));
						subscribed = new Set(next);
						for (const placementId of added) {
							const live = placements.get(placementId);
							if (live !== undefined) live.needsSnapshot = true;
						}
						if (added.length > 0) yield* signal;
					}),
				treeNode: (placementId, key) =>
					Effect.sync(() => placements.get(placementId)?.nodes.get(key) ?? null),
				requestSnapshot: (placementId) =>
					Effect.gen(function* () {
						const live = placements.get(placementId);
						if (live === undefined) return;
						live.needsSnapshot = true;
						yield* signal;
					})
			});
		})
	);
}
