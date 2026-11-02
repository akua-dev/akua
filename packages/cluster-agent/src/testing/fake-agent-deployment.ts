import { Context, Effect, Layer, Ref } from 'effect';
import type { Deployment } from '@platform/kubernetes-schemas/generated/kubernetes/1.34.1/apps/v1/Deployment';
import type { PodList } from '@platform/kubernetes-schemas/generated/kubernetes/1.34.1/core/v1/PodList';
import { UpdaterKubernetes } from '../updater';

type AgentDeployment = typeof Deployment.Type;

/**
 * The agent Deployment as the updater sees it. Tests change it as an apply
 * would (`withImage`) and move the rollout forward with `settle`.
 */
export class FakeAgentDeployment extends Context.Service<
	FakeAgentDeployment,
	{
		readonly deployment: Ref.Ref<AgentDeployment>;
		readonly pods: Ref.Ref<typeof PodList.Type>;
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

/** The agent Deployment after an apply changed its image: a new generation, not yet rolled out. */
export const withImage = (deployment: AgentDeployment, image: string): AgentDeployment => {
	const template = deployment.spec?.template;
	const containers = (template?.spec?.containers ?? []).map((container) =>
		container.name === 'agent' ? { ...container, image } : container
	);
	const changed = containers.some(
		(container, index) => container.image !== template?.spec?.containers[index]?.image
	);
	if (!changed) return deployment;
	return {
		...deployment,
		metadata: { ...deployment.metadata, generation: (deployment.metadata?.generation ?? 1) + 1 },
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
		status: { ...deployment.status, updatedReplicas: 0, readyReplicas: 0, availableReplicas: 0 }
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
			const kubernetes = UpdaterKubernetes.of({
				getAgentDeployment: Ref.get(deployment),
				listPods: () => Ref.get(pods)
			});
			const control = FakeAgentDeployment.of({
				deployment,
				pods,
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
