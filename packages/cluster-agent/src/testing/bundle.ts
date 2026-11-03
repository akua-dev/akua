import { Effect, Layer, Option, Ref, Schema, SubscriptionRef } from 'effect';
import type { AgentRelease } from '@platform/api-contract/services/cluster-agent';
import { Deployment } from '@platform/kubernetes-schemas/generated/kubernetes/1.34.1/apps/v1/Deployment';
import { releaseAnnotation } from '../bundle-apply';
import { agentBundleSecret as bundleSecret, updaterBundleSecret } from '../bundle-state';
import { agentUpdaterLayer, UpdaterInstructions } from '../updater';
import { agentHarness, desiredPlacement, file } from './agent-harness';
import {
	agentDeploymentObject,
	FakeAgentDeployment,
	fakeAgentDeploymentLayer,
	withImage
} from './fake-agent-deployment';
import { answerEverything, FakeEngine } from './fake-engine';
import { defaultDiscovery, type FakeKubernetesState, fakeKubernetesState } from './fake-kubernetes';
import {
	emptyDesiredState,
	FakePlatform,
	type FakePlatformState,
	fakePlatformState,
	placementId
} from './fake-platform';
import { testEnrollmentCode, testImage } from './settings';

type Release = typeof AgentRelease.Type;

export const v1: Release = { version: '1.0.0', image: testImage('1'), protocol: 1 };
export const v2: Release = { version: '1.1.0', image: testImage('2'), protocol: 1 };
export const v3: Release = { version: '1.2.0', image: testImage('3'), protocol: 1 };

export const bundlePlacementId = placementId('bundle1');
export const revisionV1 = '1'.repeat(40);
export const revisionV2 = '2'.repeat(40);
export const revisionV3 = '3'.repeat(40);

/** `length` characters gzip cannot shrink below 6 bits each: a fixed xorshift32 walk over base64. */
export const incompressible = (length: number) => {
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
	let state = 2463534242;
	const characters: Array<string> = [];
	for (let index = 0; index < length; index++) {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		characters.push(alphabet[(state >>> 0) % 64] ?? 'A');
	}
	return characters.join('');
};

/**
 * The rendered agent chart of one release, as the platform commits it: the
 * agent Deployment carrying its release, the agent's ClusterRole (whose
 * rules `nodeVerbs` changes), a ConfigMap only this release has, and the
 * updater's own Deployment and ConfigMap, which only the agent applies.
 */
export const bundleFiles = (
	release: Release,
	options: {
		readonly nodeVerbs?: ReadonlyArray<string>;
		readonly configMap: string;
		/** Extra ConfigMap data, to make the bundle as large as a test needs. */
		readonly padding?: string;
	}
) => [
	file(
		'manifests/bundle.yaml',
		[
			`apiVersion: apps/v1
kind: Deployment
metadata:
  name: akua-agent
  namespace: akua-system
  labels:
    app.kubernetes.io/component: agent
    app.kubernetes.io/version: "${release.version}"
  annotations:
    ${releaseAnnotation}: '${JSON.stringify(release)}'
spec:
  replicas: 1
  selector:
    matchLabels:
      app.kubernetes.io/component: agent
  template:
    metadata:
      labels:
        app.kubernetes.io/component: agent
    spec:
      containers:
        - name: agent
          image: ${release.image}
`,
			`apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: akua-agent
  labels:
    app.kubernetes.io/component: agent
    app.kubernetes.io/version: "${release.version}"
rules:
  - apiGroups: [""]
    resources: ["nodes"]
    verbs: [${(options.nodeVerbs ?? ['get', 'list', 'watch']).map((verb) => `"${verb}"`).join(', ')}]
`,
			`apiVersion: v1
kind: ConfigMap
metadata:
  name: ${options.configMap}
  namespace: akua-system
  labels:
    app.kubernetes.io/component: agent
data:
  release: "${release.version}"
${options.padding === undefined ? '' : `  padding: "${options.padding}"\n`}`,
			`apiVersion: apps/v1
kind: Deployment
metadata:
  name: akua-agent-updater
  namespace: akua-system
  labels:
    app.kubernetes.io/component: updater
spec:
  selector:
    matchLabels:
      app.kubernetes.io/component: updater
  template:
    metadata:
      labels:
        app.kubernetes.io/component: updater
    spec:
      containers:
        - name: updater
          image: ${release.image}
          env:
            - name: AKUA_AGENT_VERSION
              value: "${release.version}"
`,
			`apiVersion: v1
kind: ConfigMap
metadata:
  name: ${options.configMap}-updater
  namespace: akua-system
  labels:
    app.kubernetes.io/component: updater
data:
  release: "${release.version}"
`
		].join('---\n')
	)
];

/** Desired state whose one `applier: updater` Placement is the bundle at `revision`. */
export const bundleDesiredState = (revision: number, source: string, generation: number) =>
	emptyDesiredState(revision, [
		desiredPlacement({
			placement_id: bundlePlacementId,
			namespace: 'akua-system',
			privileged: true,
			applier: 'updater',
			generation,
			source: { ...desiredPlacement().source, revision: source }
		})
	]);

const decodeDeployment = Schema.decodeUnknownOption(Deployment);

/** An engine whose apply of the agent Deployment changes the fake Deployment's image, as a real apply would. */
export const rollingEngine = Effect.gen(function* () {
	const engine = yield* FakeEngine;
	const agent = yield* FakeAgentDeployment;
	yield* engine.setBehavior((request, process) =>
		Effect.gen(function* () {
			if (request._tag === 'apply')
				for (const manifest of request.manifests) {
					const deployment = decodeDeployment(manifest);
					if (Option.isNone(deployment) || deployment.value.metadata?.name !== 'akua-agent')
						continue;
					const image = deployment.value.spec?.template.spec?.containers[0]?.image;
					const annotations = deployment.value.metadata?.annotations;
					if (image !== undefined)
						yield* Ref.update(agent.deployment, (current) => {
							const next = withImage(current, image);
							return { ...next, metadata: { ...next.metadata, annotations } };
						});
				}
			yield* answerEverything(request, process);
		})
	);
});

export const kubernetesWithBundleSecret = (overrides: Partial<FakeKubernetesState> = {}) => {
	const base = fakeKubernetesState();
	return fakeKubernetesState({
		discovery: new Map([
			...defaultDiscovery,
			[
				'rbac.authorization.k8s.io/v1',
				new Map([['ClusterRole', { resource: 'clusterroles', namespaced: false }]])
			]
		]),
		// Both state Secrets, created empty by the chart.
		secrets: new Map([
			...base.secrets,
			...[bundleSecret, updaterBundleSecret].map(
				(name) =>
					[
						`akua-system/${name}`,
						{
							apiVersion: 'v1' as const,
							kind: 'Secret' as const,
							metadata: { name, namespace: 'akua-system' }
						}
					] as const
			)
		]),
		...overrides
	});
};

/** The updater with its own state Secret over the agent harness's fakes, running `v1`. */
export const updaterHarness = (
	options: {
		readonly kubernetes?: FakeKubernetesState;
		readonly platform?: Partial<FakePlatformState>;
		/** The node verbs v2's ClusterRole grants; v1 grants get, list, watch. */
		readonly v2NodeVerbs?: ReadonlyArray<string>;
		/** v3's bundle (at `revisionV3`) with this much incompressible ConfigMap data. */
		readonly v3Padding?: number;
		/** The release whose bundle `revisionV2` holds; v2 when absent. */
		readonly v2Release?: Release;
	} = {}
) =>
	agentUpdaterLayer.pipe(
		Layer.provideMerge(UpdaterInstructions.layer),
		Layer.provideMerge(
			fakeAgentDeploymentLayer(
				agentDeploymentObject(v1.image, { [releaseAnnotation]: JSON.stringify(v1) })
			)
		),
		Layer.provideMerge(
			agentHarness({
				kubernetes: options.kubernetes ?? kubernetesWithBundleSecret(),
				platform: {
					...fakePlatformState({ enrollmentCode: testEnrollmentCode }),
					...options.platform
				},
				revisions: new Map([
					[revisionV1, bundleFiles(v1, { configMap: 'agent-v1' })],
					[
						revisionV2,
						bundleFiles(options.v2Release ?? v2, {
							configMap: 'agent-v2',
							...(options.v2NodeVerbs === undefined ? {} : { nodeVerbs: options.v2NodeVerbs })
						})
					],
					...(options.v3Padding === undefined
						? []
						: [
								[
									revisionV3,
									bundleFiles(v3, {
										configMap: 'agent-v3',
										padding: incompressible(options.v3Padding)
									})
								] as const
							])
				])
			})
		)
	);

/** Publishes desired state with the bundle at `source`. */
export const placeBundle = (revision: number, source: string, generation: number) =>
	Effect.gen(function* () {
		const platform = yield* FakePlatform;
		yield* SubscriptionRef.set(platform.desired, bundleDesiredState(revision, source, generation));
	});
