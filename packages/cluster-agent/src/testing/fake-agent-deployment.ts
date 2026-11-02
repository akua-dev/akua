import { Context, Effect, Layer, Predicate, Ref } from 'effect';
import type { Deployment } from '@platform/kubernetes-schemas/generated/kubernetes/1.34.1/apps/v1/Deployment';
import type { PodList } from '@platform/kubernetes-schemas/generated/kubernetes/1.34.1/core/v1/PodList';
import { UpdaterKubernetes } from '../updater';

type AgentDeployment = typeof Deployment.Type;

/**
 * The agent Deployment as the updater sees it. Patches apply the strategic
 * merge semantics the updater relies on (annotations with null removal,
 * containers and env merged by name) and bump `metadata.generation`; tests
 * move the rollout forward with `settle`.
 */
export class FakeAgentDeployment extends Context.Service<
	FakeAgentDeployment,
	{
		readonly deployment: Ref.Ref<AgentDeployment>;
		readonly pods: Ref.Ref<typeof PodList.Type>;
		readonly patches: Ref.Ref<ReadonlyArray<unknown>>;
		/** Marks the current generation fully rolled out and ready. */
		readonly settle: Effect.Effect<void>;
	}
>()('akua/cluster-agent/testing/FakeAgentDeployment') {}

export const agentDeploymentObject = (
	image: string,
	annotations: Record<string, string> = {}
): AgentDeployment => ({
	apiVersion: 'apps/v1',
	kind: 'Deployment',
	metadata: { name: 'akua-agent', namespace: 'akua-system', generation: 1, annotations },
	spec: {
		replicas: 1,
		selector: {
			matchLabels: {
				'app.kubernetes.io/name': 'akua-cluster-agent',
				'app.kubernetes.io/component': 'agent'
			}
		},
		template: {
			spec: {
				containers: [{ name: 'agent', image, env: [{ name: 'AKUA_AGENT_IMAGE', value: image }] }]
			}
		}
	},
	status: {
		observedGeneration: 1,
		replicas: 1,
		updatedReplicas: 1,
		readyReplicas: 1,
		availableReplicas: 1
	}
});

const record = (value: unknown): Record<string, unknown> =>
	Predicate.isObject(value) ? Object.fromEntries(Object.entries(value)) : {};

const applyPatch = (deployment: AgentDeployment, patch: unknown): AgentDeployment => {
	const metadata = record(record(patch).metadata);
	const annotations: Record<string, string> = { ...deployment.metadata?.annotations };
	for (const [key, value] of Object.entries(record(metadata.annotations))) {
		if (value === null) delete annotations[key];
		else if (typeof value === 'string') annotations[key] = value;
	}
	const patchedContainers = record(record(record(record(patch).spec).template).spec).containers;
	const template = deployment.spec?.template;
	const containers = (template?.spec?.containers ?? []).map((container) => {
		const update = Array.isArray(patchedContainers)
			? patchedContainers.map(record).find((entry) => entry.name === container.name)
			: undefined;
		if (update === undefined) return container;
		const env = [...(container.env ?? [])];
		for (const entry of Array.isArray(update.env) ? update.env.map(record) : []) {
			const index = env.findIndex((existing) => existing.name === entry.name);
			const next = { name: String(entry.name), value: String(entry.value) };
			if (index >= 0) env[index] = next;
			else env.push(next);
		}
		return {
			...container,
			image: typeof update.image === 'string' ? update.image : container.image,
			env
		};
	});
	const imageChanged = containers.some(
		(container, index) => container.image !== template?.spec?.containers[index]?.image
	);
	const generation = (deployment.metadata?.generation ?? 1) + (imageChanged ? 1 : 0);
	return {
		...deployment,
		metadata: { ...deployment.metadata, annotations, generation },
		spec:
			deployment.spec === undefined
				? undefined
				: {
						...deployment.spec,
						template: {
							...deployment.spec.template,
							spec: { ...deployment.spec.template.spec, containers }
						}
					},
		status: imageChanged
			? { ...deployment.status, updatedReplicas: 0, readyReplicas: 0, availableReplicas: 0 }
			: deployment.status
	};
};

export const fakeAgentDeploymentLayer = (initial: AgentDeployment) =>
	Layer.effectContext(
		Effect.gen(function* () {
			const deployment = yield* Ref.make(initial);
			const pods = yield* Ref.make<typeof PodList.Type>({
				apiVersion: 'v1',
				kind: 'PodList',
				items: []
			});
			const patches = yield* Ref.make<ReadonlyArray<unknown>>([]);
			const kubernetes = UpdaterKubernetes.of({
				getAgentDeployment: Ref.get(deployment),
				patchAgentDeployment: (patch) =>
					Ref.update(patches, (all) => [...all, patch]).pipe(
						Effect.andThen(Ref.update(deployment, (current) => applyPatch(current, patch)))
					),
				listPods: () => Ref.get(pods)
			});
			const control = FakeAgentDeployment.of({
				deployment,
				pods,
				patches,
				settle: Ref.update(deployment, (current) => ({
					...current,
					status: {
						observedGeneration: current.metadata?.generation ?? 1,
						replicas: 1,
						updatedReplicas: 1,
						readyReplicas: 1,
						availableReplicas: 1
					}
				}))
			});
			return Context.make(UpdaterKubernetes, kubernetes).pipe(
				Context.add(FakeAgentDeployment, control)
			);
		})
	);
