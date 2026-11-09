import { Clock, DateTime, Duration, Effect, Option, Ref, Schema, Stream } from 'effect';
import type { HttpClientError } from 'effect/http';
import {
	ClusterConnectorChannelFailure,
	ClusterConnectorChannelRpcs,
	describeLimits,
	logTailLimits,
	type DescribedObject,
	type DrainResult,
	type LogChunk
} from '@platform/api-contract/services/ClusterConnectorChannel';
import type { PodList } from '@platform/kubernetes-schemas/generated/kubernetes/1.34.1/core/v1/PodList';
import { parseObjectKey } from './ApplySet';
import { listNodePage, reviewGrantedAccess, trimNode } from './ClusterReads';
import { KubernetesApi, type KubernetesFailure } from '../ClusterConnector';
import { KubernetesExtras } from './Kubernetes';
import { LiveStatus } from './LiveStatus';
import { DesiredSignal } from './PlacementReconciler';

/**
 * The agent's side of `ClusterConnectorChannelRpcs`: what the platform asks of the
 * cluster over the channel. Reads and node actions run while impersonating
 * `akua-apply`, except node reads, which the agent's own read-only grant
 * covers. Workload reads only reach objects of a Placement's tree.
 */

const failure = (reason: ClusterConnectorChannelFailure['reason'], message: string) =>
	new ClusterConnectorChannelFailure({ reason, message: message.slice(0, 1024) });

/** Kubernetes answers as the platform sees them; never the response body beyond its message. */
const fromKubernetes = (error: KubernetesFailure | HttpClientError.HttpClientError) =>
	error._tag === 'KubernetesFailure'
		? failure(
				error.reason === 'forbidden'
					? 'forbidden'
					: error.reason === 'not-found'
						? 'not-found'
						: error.reason === 'timeout'
							? 'timeout'
							: 'unavailable',
				error.message
			)
		: failure('unavailable', 'kube-apiserver unreachable');

const encoder = new TextEncoder();

/** Text pieces of at most `maxChunkBytes` UTF-8 bytes, cut after a newline where one is near. */
export const chunkLogText = (text: string): ReadonlyArray<string> => {
	const pieces: Array<string> = [];
	let rest = text;
	while (encoder.encode(rest).byteLength > logTailLimits.maxChunkBytes) {
		// UTF-8 needs at most 4 bytes per code point, so this many characters always fit.
		let cut = Math.floor(logTailLimits.maxChunkBytes / 4);
		const newline = rest.lastIndexOf('\n', cut);
		if (newline > 0) cut = newline + 1;
		pieces.push(rest.slice(0, cut));
		rest = rest.slice(cut);
	}
	if (rest.length > 0) pieces.push(rest);
	return pieces;
};

/**
 * The object without what the engine's informer cache never keeps
 * (`informerCache.stripped`): managedFields, the last-applied annotation,
 * Secret and ConfigMap payloads. Values never leave the cluster.
 */
export const stripObject = (
	object: typeof Schema.JsonObject.Type
): typeof Schema.JsonObject.Type => {
	const { data: _data, stringData: _stringData, binaryData: _binaryData, ...rest } = object;
	const kind = object.kind;
	const withoutData = kind === 'Secret' || kind === 'ConfigMap' ? rest : object;
	const metadata = withoutData.metadata;
	if (!isJsonObject(metadata)) return withoutData;
	const kept: Record<string, typeof Schema.Json.Type> = {};
	for (const [key, value] of Object.entries(metadata)) {
		if (key === 'managedFields') continue;
		kept[key] =
			key === 'annotations' && isJsonObject(value)
				? Object.fromEntries(
						Object.entries(value).filter(
							([name]) => name !== 'kubectl.kubernetes.io/last-applied-configuration'
						)
					)
				: value;
	}
	return { ...withoutData, metadata: kept };
};

const isJsonObject = Schema.is(Schema.JsonObject);

const byteLength = (value: unknown) => encoder.encode(JSON.stringify(value)).byteLength;

const millisOf = (timestamp: string | undefined): number =>
	timestamp === undefined
		? 0
		: Option.match(DateTime.make(timestamp), {
				onNone: () => 0,
				onSome: (instant) => instant.epochMilliseconds
			});

/** DaemonSet and mirror Pods stay, as `kubectl drain --ignore-daemonsets` leaves them. */
const evictable = (pod: (typeof PodList.Type)['items'][number]) =>
	pod.metadata?.annotations?.['kubernetes.io/config.mirror'] === undefined &&
	!(pod.metadata?.ownerReferences ?? []).some((owner) => owner.kind === 'DaemonSet') &&
	pod.status?.phase !== 'Succeeded' &&
	pod.status?.phase !== 'Failed';

const drainRoundMillis = 2_000;

export const clusterConnectorRpcHandlers = ClusterConnectorChannelRpcs.toLayer(
	Effect.gen(function* () {
		const extras = yield* KubernetesExtras;
		const live = yield* LiveStatus;
		const signal = yield* DesiredSignal;
		const kubernetes = yield* KubernetesApi;

		const placementPod = Effect.fnUntraced(function* (
			placementId: Parameters<typeof live.treeNode>[0],
			key: string
		) {
			const node = yield* live.treeNode(placementId, key);
			if (node === null) return yield* failure('not-managed', 'not an object of this Placement');
			return { node, ...parseObjectKey(key) };
		});

		return ClusterConnectorChannelRpcs.of({
			// The answer is the acknowledgement: it comes once that revision is fetched and applied to the workers.
			'DesiredChanged.v1': ({ revision }) =>
				signal.announce(revision).pipe(Effect.andThen(signal.reached(revision))),
			'Subscribe.v1': ({ status }) => live.subscribe(status),
			'ListNodes.v1': (request) =>
				listNodePage(request).pipe(
					Effect.provideService(KubernetesApi, kubernetes),
					Effect.mapError(fromKubernetes)
				),
			'GetNode.v1': ({ name }) =>
				extras.getNode(name).pipe(
					Effect.mapError(fromKubernetes),
					Effect.flatMap((node) =>
						node === null
							? Effect.fail(failure('not-found', `node ${name} not found`))
							: Effect.succeed(trimNode(node))
					)
				),
			'DrainNode.v1': ({ name, timeout_seconds }) =>
				Effect.gen(function* () {
					const deadline = (yield* Clock.currentTimeMillis) + timeout_seconds * 1000;
					yield* extras.cordonNode(name);
					let evicted = 0;
					while (true) {
						const pods = (yield* extras.listPodsOnNode(name)).items.filter(evictable);
						if (pods.length === 0)
							return {
								outcome: 'drained',
								evicted,
								remaining: 0
							} satisfies typeof DrainResult.Type;
						if ((yield* Clock.currentTimeMillis) >= deadline)
							return {
								outcome: 'timeout',
								evicted,
								remaining: pods.length
							} satisfies typeof DrainResult.Type;
						for (const pod of pods) {
							if (pod.metadata?.deletionTimestamp !== undefined) continue;
							const answer = yield* extras.evictPod({
								namespace: pod.metadata?.namespace ?? '',
								name: pod.metadata?.name ?? ''
							});
							if (answer === 'evicted') evicted += 1;
						}
						yield* Effect.sleep(Duration.millis(drainRoundMillis));
					}
				}).pipe(Effect.mapError(fromKubernetes)),
			'DeleteNode.v1': ({ name }) => extras.deleteNode(name).pipe(Effect.mapError(fromKubernetes)),
			'GetAccess.v1': ({ namespaces }) =>
				reviewGrantedAccess(namespaces).pipe(Effect.provideService(KubernetesApi, kubernetes)),
			'TailLogs.v1': (request) =>
				Stream.unwrap(
					Effect.gen(function* () {
						const target = yield* placementPod(request.placement_id, request.pod);
						if (target.kind !== 'Pod' || target.group !== '')
							return yield* failure('not-managed', 'logs are read from Pods only');
						const started = yield* Clock.currentTimeMillis;
						const sent = yield* Ref.make(0);
						const body = extras
							.podLogsAsApply({
								namespace: target.namespace,
								pod: target.name,
								container: request.container,
								previous: request.previous,
								tailLines: request.tail_lines,
								sinceSeconds: request.since_seconds,
								follow: request.follow,
								timestamps: request.timestamps,
								limitBytes: logTailLimits.maxBytes
							})
							.pipe(
								Stream.decodeText(),
								Stream.flatMap((text) => Stream.fromIterable(chunkLogText(text))),
								Stream.mapEffect((text) =>
									Ref.update(sent, (bytes) => bytes + encoder.encode(text).byteLength).pipe(
										Effect.as<typeof LogChunk.Type>({ text })
									)
								),
								Stream.mapError(fromKubernetes),
								request.follow
									? Stream.interruptWhen(
											Effect.sleep(Duration.seconds(logTailLimits.maxFollowSeconds))
										)
									: (stream) => stream
							);
						const ending = Stream.fromEffect(
							Effect.gen(function* () {
								const bytes = yield* Ref.get(sent);
								const elapsed = (yield* Clock.currentTimeMillis) - started;
								const last: ReadonlyArray<typeof LogChunk.Type> =
									bytes >= logTailLimits.maxBytes
										? [{ text: '', truncated: 'bytes' }]
										: request.follow && elapsed >= logTailLimits.maxFollowSeconds * 1000
											? [{ text: '', truncated: 'duration' }]
											: [];
								return last;
							})
						).pipe(Stream.flatMap(Stream.fromIterable));
						return Stream.concat(body, ending);
					})
				),
			'Describe.v1': (request) =>
				Effect.gen(function* () {
					const target = yield* placementPod(request.placement_id, request.object);
					const apiVersion =
						target.group === '' ? target.node.version : `${target.group}/${target.node.version}`;
					const resources = yield* extras.discover(apiVersion);
					const resource = resources?.get(target.kind);
					if (resource === undefined)
						return yield* failure('not-found', `no resource for ${apiVersion} ${target.kind}`);
					const namespace = resource.namespaced ? target.namespace : null;
					const object = yield* extras.getObjectAsApply({
						apiVersion,
						resource: resource.resource,
						namespace,
						name: target.name
					});
					if (object === null) return yield* failure('not-found', 'the object is gone');
					const stripped = stripObject(object);
					const truncated = byteLength(stripped) > describeLimits.maxObjectBytes;
					const shown: typeof Schema.JsonObject.Type = truncated
						? {
								...(stripped.apiVersion === undefined ? {} : { apiVersion: stripped.apiVersion }),
								...(stripped.kind === undefined ? {} : { kind: stripped.kind }),
								...(stripped.metadata === undefined ? {} : { metadata: stripped.metadata }),
								...(stripped.status === undefined ? {} : { status: stripped.status })
							}
						: stripped;
					const events = yield* extras.listEventsAsApply({
						namespace: namespace ?? 'default',
						uid: target.node.uid
					});
					const described: typeof DescribedObject.Type = {
						object: shown,
						truncated,
						events: events.items
							.map((event) => ({
								type: event.type === 'Warning' ? ('Warning' as const) : ('Normal' as const),
								involved: request.object,
								reason: (event.reason ?? 'Unknown').slice(0, 128) || 'Unknown',
								message: (event.message ?? '').slice(0, 1024),
								count: Math.max(1, event.count ?? 1),
								firstSeen: millisOf(event.firstTimestamp ?? event.eventTime),
								lastSeen: millisOf(event.lastTimestamp ?? event.eventTime)
							}))
							.sort((a, b) => b.lastSeen - a.lastSeen)
							.slice(0, describeLimits.maxEvents)
					};
					return described;
				}).pipe(
					Effect.catchTags({
						KubernetesFailure: (error) => Effect.fail(fromKubernetes(error)),
						HttpClientError: (error) => Effect.fail(fromKubernetes(error))
					})
				)
		});
	})
);
