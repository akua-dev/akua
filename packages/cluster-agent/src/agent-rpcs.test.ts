import { assert, describe, it } from '@effect/vitest';
import { Effect, Fiber, Ref, Stream, SubscriptionRef } from 'effect';
import { TestClock } from 'effect/testing';
import { RpcTest } from 'effect/rpc';
import type { ResourceNode } from '@platform/api-contract/services/ClusterConnector';
import {
	ClusterConnectorChannelRpcs,
	logTailLimits
} from '@platform/api-contract/services/ClusterConnectorChannel';
import type { PodList } from '@platform/kubernetes-schemas/generated/kubernetes/1.34.1/core/v1/PodList';
import { agentRpcHandlers, chunkLogText, stripObject } from './agent-rpcs';
import { EngineStatus } from './engine';
import { LiveStatus } from './live-status';
import { DesiredSignal } from './reconciler';
import { agentHarness } from './testing/agent-harness';
import { FakeEngine } from './testing/fake-engine';
import { FakeKubernetes, fakeKubernetesState, objectKey } from './testing/fake-kubernetes';
import { placementId } from './testing/fake-platform';

const placement = placementId('reads1');

type PodItem = (typeof PodList.Type)['items'][number];

const pod = (name: string, overrides: Partial<PodItem> = {}): PodItem => ({
	metadata: { name, namespace: 'app', uid: `uid-${name}` },
	spec: { nodeName: 'n1', containers: [{ name: 'main' }] },
	status: { phase: 'Running' },
	...overrides
});

const treeNode = (key: string, uid: string): typeof ResourceNode.Type => ({
	key,
	uid,
	version: 'v1',
	member: true,
	parents: [],
	status: 'Current',
	message: '',
	reasons: [],
	containers: [],
	scheduling: null,
	observedAt: 1
});

/** The agent's handlers behind an in-memory RPC client, over the whole agent harness. */
const client = RpcTest.makeClient(ClusterConnectorChannelRpcs);
const withHandlers = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	effect.pipe(Effect.provide(agentRpcHandlers), Effect.scoped);

/** Puts objects into the Placement's tree the way the engine reports them. */
const inTree = (nodes: ReadonlyArray<typeof ResourceNode.Type>) =>
	Effect.gen(function* () {
		const status = yield* EngineStatus;
		yield* SubscriptionRef.changes(status.state).pipe(
			Stream.filter((state) => state.phase === 'ready'),
			Stream.runHead
		);
		yield* (yield* LiveStatus).watch([{ placementId: placement, generation: 1 }]);
		const process = yield* (yield* FakeEngine).current;
		for (const node of nodes)
			yield* process?.emit({ _tag: 'node', placementId: placement, node }) ?? Effect.void;
		const live = yield* LiveStatus;
		while ((yield* live.treeNode(placement, nodes.at(-1)?.key ?? '')) === null)
			yield* TestClock.adjust('10 millis');
	});

describe('agent RPCs', () => {
	it('cuts log text into chunks below the limit, after a newline where it can', () => {
		const line = `${'x'.repeat(99)}\n`;
		const pieces = chunkLogText(line.repeat(2000));
		assert.isAbove(pieces.length, 1);
		for (const piece of pieces) {
			assert.isAtMost(new TextEncoder().encode(piece).byteLength, logTailLimits.maxChunkBytes);
			assert.isTrue(piece.endsWith('\n'));
		}
		assert.strictEqual(pieces.join(''), line.repeat(2000));
	});

	it('strips Secret payloads, managedFields and the last-applied annotation', () => {
		const stripped = stripObject({
			apiVersion: 'v1',
			kind: 'Secret',
			data: { password: 'c2VjcmV0' },
			stringData: { token: 'secret' },
			metadata: {
				name: 's',
				managedFields: [{ manager: 'x' }],
				annotations: {
					'kubectl.kubernetes.io/last-applied-configuration': '{}',
					keep: 'yes'
				}
			}
		});
		assert.deepStrictEqual(stripped, {
			apiVersion: 'v1',
			kind: 'Secret',
			metadata: { name: 's', annotations: { keep: 'yes' } }
		});
	});

	it.effect('announces a desired revision and replaces the status subscriptions', () =>
		withHandlers(
			Effect.gen(function* () {
				const agent = yield* client;
				yield* agent['DesiredChanged.v1']({ revision: 12 });
				assert.strictEqual(yield* (yield* DesiredSignal).above(11), 12);
				yield* agent['Subscribe.v1']({ status: [placement], nodes: false });
			})
		).pipe(Effect.provide(agentHarness()))
	);

	it.effect('reads the grant as Kubernetes evaluates it for akua-apply', () =>
		withHandlers(
			Effect.gen(function* () {
				const access = yield* (yield* client)['GetAccess.v1']({ namespaces: ['app', 'other'] });
				assert.deepStrictEqual(access.scope, { _tag: 'namespaces', namespaces: ['app'] });
				assert.isTrue(access.createNamespaces);
				assert.deepStrictEqual(
					access.reviews.map((review) => review.namespace),
					[null, 'app', 'other']
				);
			})
		).pipe(
			Effect.provide(
				agentHarness({
					kubernetes: fakeKubernetesState({
						allow: (attributes) => attributes.verb !== '*',
						rulesNamespaces: new Set(['app'])
					})
				})
			)
		)
	);

	it.effect('pages nodes and reads one by name', () =>
		withHandlers(
			Effect.gen(function* () {
				const agent = yield* client;
				const first = yield* agent['ListNodes.v1']({ limit: 2, continue: null });
				assert.deepStrictEqual(
					first.nodes.map((node) => node.metadata?.name),
					['n1', 'n2']
				);
				assert.isNotNull(first.continue);
				const rest = yield* agent['ListNodes.v1']({ limit: 2, continue: first.continue });
				assert.deepStrictEqual(
					rest.nodes.map((node) => node.metadata?.name),
					['n3']
				);
				assert.isNull(rest.continue);
				const node = yield* agent['GetNode.v1']({ name: 'n2' });
				assert.deepStrictEqual(node.metadata?.labels, { zone: 'b' });
				const missing = yield* agent['GetNode.v1']({ name: 'n9' }).pipe(Effect.flip);
				assert.strictEqual(
					missing._tag === 'AgentChannelFailure' ? missing.reason : '',
					'not-found'
				);
			})
		).pipe(
			Effect.provide(
				agentHarness({
					kubernetes: fakeKubernetesState({
						nodes: ['n1', 'n2', 'n3'].map((name, index) => ({
							apiVersion: 'v1',
							kind: 'Node',
							metadata: { name, labels: { zone: ['a', 'b', 'c'][index] ?? 'x' } }
						}))
					})
				})
			)
		)
	);

	it.effect('drains a node around DaemonSet Pods, then deletes it', () =>
		withHandlers(
			Effect.gen(function* () {
				const agent = yield* client;
				const drain = yield* agent['DrainNode.v1']({ name: 'n1', timeout_seconds: 60 }).pipe(
					Effect.forkChild
				);
				yield* TestClock.adjust('5 seconds');
				const drained = yield* Fiber.join(drain);
				assert.deepStrictEqual(drained, { outcome: 'drained', evicted: 2, remaining: 0 });
				const kubernetes = yield* FakeKubernetes;
				const state = yield* Ref.get(kubernetes.state);
				assert.isTrue(state.nodes[0]?.spec?.unschedulable);
				assert.deepStrictEqual(
					state.pods.map((entry) => entry.metadata?.name),
					['ds-1']
				);
				yield* agent['DeleteNode.v1']({ name: 'n1' });
				assert.strictEqual((yield* Ref.get(kubernetes.state)).nodes.length, 0);
			})
		).pipe(
			Effect.provide(
				agentHarness({
					kubernetes: fakeKubernetesState({
						nodes: [{ apiVersion: 'v1', kind: 'Node', metadata: { name: 'n1' } }],
						pods: [
							pod('web-1'),
							pod('web-2'),
							pod('ds-1', {
								metadata: {
									name: 'ds-1',
									namespace: 'kube-system',
									ownerReferences: [
										{ apiVersion: 'apps/v1', kind: 'DaemonSet', name: 'cni', uid: 'u' }
									]
								}
							})
						]
					})
				})
			)
		)
	);

	it.effect('stops a drain at its timeout when a disruption budget keeps a Pod', () =>
		withHandlers(
			Effect.gen(function* () {
				const drain = yield* (yield* client)
					['DrainNode.v1']({ name: 'n1', timeout_seconds: 10 })
					.pipe(Effect.forkChild);
				yield* TestClock.adjust('15 seconds');
				const result = yield* Fiber.join(drain);
				assert.deepStrictEqual(result, { outcome: 'timeout', evicted: 1, remaining: 1 });
			})
		).pipe(
			Effect.provide(
				agentHarness({
					kubernetes: fakeKubernetesState({
						nodes: [{ apiVersion: 'v1', kind: 'Node', metadata: { name: 'n1' } }],
						pods: [pod('web-1'), pod('db-1')],
						evictionBlocked: new Set(['app/db-1'])
					})
				})
			)
		)
	);

	it.effect('tails logs only for Pods of the Placement tree', () =>
		withHandlers(
			Effect.gen(function* () {
				const agent = yield* client;
				const request = {
					placement_id: placement,
					pod: 'app_web-1__Pod',
					container: 'main',
					previous: false,
					tail_lines: 10,
					since_seconds: null,
					follow: false,
					timestamps: false
				};
				const refused = yield* agent['TailLogs.v1'](request).pipe(Stream.runCollect, Effect.flip);
				assert.strictEqual(
					refused._tag === 'AgentChannelFailure' ? refused.reason : '',
					'not-managed'
				);
				yield* inTree([treeNode('app_web-1__Pod', 'uid-web-1')]);
				const chunks = yield* agent['TailLogs.v1'](request).pipe(Stream.runCollect);
				assert.deepStrictEqual(chunks.map((chunk) => chunk.text).join(''), 'started\nlistening\n');
			})
		).pipe(
			Effect.provide(
				agentHarness({
					kubernetes: fakeKubernetesState({
						logs: new Map([['app/web-1/main', 'started\nlistening\n']])
					})
				})
			)
		)
	);

	it.effect('describes a tree object without its Secret data, with its events', () =>
		withHandlers(
			Effect.gen(function* () {
				yield* inTree([treeNode('app_creds__Secret', 'uid-creds')]);
				const described = yield* (yield* client)['Describe.v1']({
					placement_id: placement,
					object: 'app_creds__Secret'
				});
				assert.deepStrictEqual(described.object, {
					apiVersion: 'v1',
					kind: 'Secret',
					metadata: { name: 'creds', namespace: 'app', uid: 'uid-creds' }
				});
				assert.isFalse(described.truncated);
				assert.deepStrictEqual(
					described.events.map((event) => [event.type, event.reason]),
					[['Warning', 'FailedMount']]
				);
			})
		).pipe(
			Effect.provide(
				agentHarness({
					kubernetes: fakeKubernetesState({
						objects: new Map([
							[
								objectKey({
									apiVersion: 'v1',
									resource: 'secrets',
									namespace: 'app',
									name: 'creds'
								}),
								{
									apiVersion: 'v1',
									kind: 'Secret',
									metadata: { name: 'creds', namespace: 'app', uid: 'uid-creds' },
									data: { password: 'c2VjcmV0' }
								}
							]
						]),
						events: [
							{
								metadata: { name: 'e1', namespace: 'app' },
								involvedObject: { uid: 'uid-creds', kind: 'Secret', name: 'creds' },
								type: 'Warning',
								reason: 'FailedMount',
								message: 'not found',
								count: 2,
								lastTimestamp: '2026-11-02T12:00:00Z'
							}
						]
					})
				})
			)
		)
	);
});
