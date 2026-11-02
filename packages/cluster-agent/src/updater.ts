import {
	Clock,
	Context,
	Duration,
	Effect,
	Layer,
	Option,
	Result,
	Schema,
	Stream,
	SubscriptionRef
} from 'effect';
import { HttpClient, HttpClientRequest, type HttpClientError } from 'effect/http';
import {
	AgentRelease,
	UpdateRollbackReason,
	type UpdaterInstruction,
	type UpdaterPhase
} from '@platform/api-contract/services/cluster-agent';
import { Deployment } from '@platform/kubernetes-schemas/generated/kubernetes/1.34.1/apps/v1/Deployment';
import { PodList } from '@platform/kubernetes-schemas/generated/kubernetes/1.34.1/core/v1/PodList';
import { UpdaterChannelRpcs } from '@platform/api-contract/services/cluster-agent-channel';
import type { ChannelState } from './channel';
import { agentDeployment, agentNamespace, AgentUpdater, type KubernetesFailure } from './contract';
import { decodeAs, failureFor, KubernetesConnection } from './kubernetes';
import { AgentApi } from './platform';

type Release = typeof AgentRelease.Type;
type Phase = typeof UpdaterPhase.Type;
type Instruction = typeof UpdaterInstruction.Type;
type Reason = typeof UpdateRollbackReason.Type;
type AgentDeploymentObject = typeof Deployment.Type;
type Pods = typeof PodList.Type;

/** The agent container; the only one whose image the updater changes. */
export const agentContainer = 'agent';

/**
 * Updater state kept on the agent Deployment's own metadata, so an updater
 * restart mid-update can still finish or roll back. The pod template is
 * never touched except for the agent image and its mirror env var.
 */
export const updaterAnnotations = {
	release: 'akua.dev/release',
	update: 'akua.dev/update',
	rolledBack: 'akua.dev/rolled-back'
} as const;

const UpdateRecord = Schema.fromJsonString(
	Schema.Struct({
		from: AgentRelease,
		to: AgentRelease,
		startedAt: Schema.Finite,
		deadline: Schema.Finite
	})
);
const RolledBackRecord = Schema.fromJsonString(
	Schema.Struct({ rejected: AgentRelease, reason: UpdateRollbackReason, at: Schema.Finite })
);
const ReleaseRecord = Schema.fromJsonString(AgentRelease);

const decodeUpdate = Schema.decodeUnknownOption(UpdateRecord);
const decodeRolledBack = Schema.decodeUnknownOption(RolledBackRecord);
const decodeRelease = Schema.decodeUnknownOption(ReleaseRecord);
const readUpdate = (value: string | undefined) =>
	value === undefined ? Option.none() : decodeUpdate(value);
const readRolledBack = (value: string | undefined) =>
	value === undefined ? Option.none() : decodeRolledBack(value);
const readRelease = (value: string | undefined) =>
	value === undefined ? Option.none() : decodeRelease(value);

/** The updater's reads and its one write: a strategic merge patch of the agent Deployment. */
export class UpdaterKubernetes extends Context.Service<
	UpdaterKubernetes,
	{
		readonly getAgentDeployment: Effect.Effect<
			AgentDeploymentObject,
			KubernetesFailure | HttpClientError.HttpClientError
		>;
		readonly patchAgentDeployment: (
			patch: unknown
		) => Effect.Effect<void, KubernetesFailure | HttpClientError.HttpClientError>;
		readonly listPods: (
			selector: string
		) => Effect.Effect<Pods, KubernetesFailure | HttpClientError.HttpClientError>;
	}
>()('akua/cluster-agent/UpdaterKubernetes') {
	static readonly layer = Layer.effect(
		UpdaterKubernetes,
		Effect.gen(function* () {
			const connection = yield* KubernetesConnection;
			const client = yield* HttpClient.HttpClient;
			const deploymentPath = `/apis/apps/v1/namespaces/${agentNamespace}/deployments/${agentDeployment}`;
			const send = Effect.fnUntraced(function* (request: HttpClientRequest.HttpClientRequest) {
				const token = yield* connection.token;
				const response = yield* client.execute(
					request.pipe(
						HttpClientRequest.prependUrl(connection.baseUrl),
						HttpClientRequest.bearerToken(token),
						HttpClientRequest.acceptJson
					)
				);
				const body = yield* response.json.pipe(Effect.orElseSucceed(() => null));
				if (response.status < 200 || response.status >= 300)
					return yield* failureFor(response.status, body);
				return { status: response.status, body };
			});
			return UpdaterKubernetes.of({
				getAgentDeployment: send(HttpClientRequest.get(deploymentPath)).pipe(
					Effect.flatMap((result) => decodeAs(Deployment)(result.status)(result.body))
				),
				patchAgentDeployment: (patch) =>
					send(
						HttpClientRequest.patch(deploymentPath).pipe(
							HttpClientRequest.bodyText(
								JSON.stringify(patch),
								'application/strategic-merge-patch+json'
							)
						)
					).pipe(Effect.asVoid),
				listPods: (selector) =>
					send(
						HttpClientRequest.get(`/api/v1/namespaces/${agentNamespace}/pods`).pipe(
							HttpClientRequest.setUrlParams({ labelSelector: selector })
						)
					).pipe(Effect.flatMap((result) => decodeAs(PodList)(result.status)(result.body)))
			});
		})
	);
}

const imageOf = (deployment: AgentDeploymentObject): string | undefined =>
	deployment.spec?.template.spec?.containers.find((container) => container.name === agentContainer)
		?.image;

/** kstatus Current for a Deployment: observed, fully updated, ready and available, no old replicas left. */
export const rolloutCurrent = (deployment: AgentDeploymentObject): boolean => {
	const replicas = deployment.spec?.replicas ?? 1;
	const status = deployment.status;
	return (
		(status?.observedGeneration ?? 0) >= (deployment.metadata?.generation ?? 0) &&
		(status?.updatedReplicas ?? 0) === replicas &&
		(status?.readyReplicas ?? 0) === replicas &&
		(status?.availableReplicas ?? 0) === replicas &&
		(status?.replicas ?? 0) === replicas
	);
};

const progressDeadlineExceeded = (deployment: AgentDeploymentObject): boolean =>
	(deployment.status?.conditions ?? []).some(
		(condition) =>
			condition.type === 'Progressing' && condition.reason === 'ProgressDeadlineExceeded'
	);

/** Why pods running `image` cannot become ready, read from their container states. */
export const podTrouble = (pods: Pods, image: string): 'image-unavailable' | 'unhealthy' | null => {
	let trouble: 'image-unavailable' | 'unhealthy' | null = null;
	for (const pod of pods.items) {
		// The spec holds the reference as written; status.image may be normalized by the runtime.
		const runsImage = pod.spec?.containers.some(
			(container) => container.name === agentContainer && container.image === image
		);
		if (runsImage !== true) continue;
		for (const status of pod.status?.containerStatuses ?? []) {
			if (status.name !== agentContainer) continue;
			const reason = status.state?.waiting?.reason;
			if (
				reason === 'ImagePullBackOff' ||
				reason === 'ErrImagePull' ||
				reason === 'InvalidImageName'
			) {
				return 'image-unavailable';
			}
			if (reason === 'CrashLoopBackOff' || (status.restartCount ?? 0) > 0) trouble = 'unhealthy';
		}
	}
	return trouble;
};

const selectorOf = (deployment: AgentDeploymentObject): string =>
	Object.entries(deployment.spec?.selector.matchLabels ?? {})
		.map(([key, value]) => `${key}=${value}`)
		.join(',');

/** The image and its env mirror in one strategic merge patch, plus the updater's records. */
export const releasePatch = (args: {
	readonly release: Release;
	readonly update: string | null;
	readonly rolledBack: string | null;
}) => ({
	metadata: {
		annotations: {
			[updaterAnnotations.release]: JSON.stringify(args.release),
			[updaterAnnotations.update]: args.update,
			[updaterAnnotations.rolledBack]: args.rolledBack
		}
	},
	spec: {
		template: {
			spec: {
				containers: [
					{
						name: agentContainer,
						image: args.release.image,
						env: [{ name: 'AKUA_AGENT_IMAGE', value: args.release.image }]
					}
				]
			}
		}
	}
});

/** What the agent Deployment says is running; the image wins over a stale annotation. */
export const runningRelease = (
	deployment: AgentDeploymentObject,
	fallbackVersion: string
): Option.Option<Release> => {
	const annotated = readRelease(deployment.metadata?.annotations?.[updaterAnnotations.release]);
	const image = imageOf(deployment);
	if (Option.isSome(annotated) && annotated.value.image === image) return annotated;
	const decoded = Schema.decodeUnknownOption(AgentRelease)({
		version: Option.isSome(annotated) ? annotated.value.version : fallbackVersion,
		image,
		protocol: Option.isSome(annotated) ? annotated.value.protocol : 1
	});
	return decoded;
};

/**
 * One step of the updater state machine against the live agent Deployment:
 * start an offered update, follow its rollout, verify it within
 * `verify_seconds` (rollout Current with ready pods, then a channel connection and an
 * accepted report or StatusBatch from the new release as the platform
 * observed them), or restore the previous release with a reason.
 */
export const agentUpdaterLayer = Layer.effect(
	AgentUpdater,
	Effect.gen(function* () {
		const kubernetes = yield* UpdaterKubernetes;

		const rollback = Effect.fnUntraced(function* (from: Release, to: Release, reason: Reason) {
			const at = yield* Clock.currentTimeMillis;
			yield* kubernetes
				.patchAgentDeployment(
					releasePatch({
						release: from,
						update: null,
						rolledBack: JSON.stringify({ rejected: to, reason, at })
					})
				)
				.pipe(Effect.orDie);
			yield* Effect.logWarning('agent update rolled back').pipe(
				Effect.annotateLogs({ from: from.version, to: to.version, reason })
			);
			return { _tag: 'rolled-back', running: from, rejected: to, reason, at } satisfies Phase;
		});

		const step = Effect.fn('AgentUpdater.step')(function* (args: {
			readonly instruction: Instruction;
			readonly running: Release;
		}) {
			const deployment = yield* kubernetes.getAgentDeployment.pipe(Effect.orDie);
			const now = yield* Clock.currentTimeMillis;
			const update = readUpdate(deployment.metadata?.annotations?.[updaterAnnotations.update]);

			if (Option.isSome(update)) {
				const { from, to, startedAt, deadline } = update.value;
				const pods = yield* kubernetes.listPods(selectorOf(deployment)).pipe(Effect.orDie);
				const trouble = podTrouble(pods, to.image);
				if (trouble === 'image-unavailable') return yield* rollback(from, to, 'image-unavailable');
				if (!rolloutCurrent(deployment)) {
					if (now < deadline && !progressDeadlineExceeded(deployment)) {
						return { _tag: 'updating', from, to, startedAt } satisfies Phase;
					}
					return yield* rollback(
						from,
						to,
						trouble === 'unhealthy' ? 'unhealthy' : 'rollout-failed'
					);
				}
				const observed = args.instruction.observed;
				const fromNewRelease = observed !== null && observed.version === to.version;
				if (fromNewRelease && observed.online_at !== null && observed.accepted_at !== null) {
					yield* kubernetes
						.patchAgentDeployment({
							metadata: { annotations: { [updaterAnnotations.update]: null } }
						})
						.pipe(Effect.orDie);
					yield* Effect.logInfo('agent update verified').pipe(
						Effect.annotateLogs({ version: to.version })
					);
					return { _tag: 'steady', running: to } satisfies Phase;
				}
				if (now >= deadline) {
					return yield* rollback(
						from,
						to,
						!fromNewRelease || observed.online_at === null ? 'no-presence' : 'no-reconcile'
					);
				}
				return { _tag: 'verifying', from, to, deadline } satisfies Phase;
			}

			const rolledBack = readRolledBack(
				deployment.metadata?.annotations?.[updaterAnnotations.rolledBack]
			);
			const desired = args.instruction.desired;
			const rejectedHere =
				Option.isSome(rolledBack) &&
				desired !== null &&
				rolledBack.value.rejected.image === desired.image;
			if (desired !== null && desired.image !== args.running.image && !rejectedHere) {
				const deadline = now + args.instruction.verify_seconds * 1000;
				yield* kubernetes
					.patchAgentDeployment(
						releasePatch({
							release: desired,
							update: JSON.stringify({ from: args.running, to: desired, startedAt: now, deadline }),
							rolledBack: null
						})
					)
					.pipe(Effect.orDie);
				yield* Effect.logInfo('agent update started').pipe(
					Effect.annotateLogs({ from: args.running.version, to: desired.version })
				);
				return {
					_tag: 'updating',
					from: args.running,
					to: desired,
					startedAt: now
				} satisfies Phase;
			}
			if (Option.isSome(rolledBack)) {
				return {
					_tag: 'rolled-back',
					running: args.running,
					rejected: rolledBack.value.rejected,
					reason: rolledBack.value.reason,
					at: rolledBack.value.at
				} satisfies Phase;
			}
			return { _tag: 'steady', running: args.running } satisfies Phase;
		});

		return AgentUpdater.of({ step });
	})
);

/**
 * What the platform pushed on the updater's own channel connection
 * (`Instruct.v1`), and whether that connection is open. The HTTP answer to
 * a phase report lands here too, so the loop always reads the newest.
 */
export class UpdaterInstructions extends Context.Service<
	UpdaterInstructions,
	{
		readonly latest: SubscriptionRef.SubscriptionRef<Instruction | null>;
		readonly channel: SubscriptionRef.SubscriptionRef<ChannelState>;
	}
>()('akua/cluster-agent/UpdaterInstructions') {
	static readonly layer = Layer.effect(
		UpdaterInstructions,
		Effect.gen(function* () {
			return UpdaterInstructions.of({
				latest: yield* SubscriptionRef.make<Instruction | null>(null),
				channel: yield* SubscriptionRef.make<ChannelState>({
					_tag: 'connecting',
					attempt: 0,
					since: 0
				})
			});
		})
	);
}

/** The updater's side of `UpdaterChannelRpcs`. */
export const updaterRpcHandlers = UpdaterChannelRpcs.toLayer(
	Effect.gen(function* () {
		const { latest } = yield* UpdaterInstructions;
		return UpdaterChannelRpcs.of({
			'Instruct.v1': (instruction) => SubscriptionRef.set(latest, instruction)
		});
	})
);

const initialInstruction: Instruction = {
	desired: null,
	verify_seconds: 300,
	observed: null
};

/** Without any push the updater looks again this often; the push is the normal path. */
const idleRecheck = Duration.minutes(15);

/**
 * The updater process: report its phase over HTTP whenever it changes,
 * take the newest instruction (the report's answer or a later push), step.
 * While an update is in flight it steps every 10 s; otherwise it waits for
 * the next push. While its channel is down the platform's observations are
 * unknown, not absent: an outage never rolls back a release it could not
 * see.
 */
export const updaterLoop = (updaterVersion: string) =>
	Effect.gen(function* () {
		const api = yield* AgentApi;
		const updater = yield* AgentUpdater;
		const kubernetes = yield* UpdaterKubernetes;
		const { latest, channel } = yield* UpdaterInstructions;
		let reported: string | null = null;
		let phase: Phase | null = null;
		while (true) {
			const deployment = yield* kubernetes.getAgentDeployment.pipe(Effect.result);
			const running = Result.isSuccess(deployment)
				? runningRelease(deployment.success, 'unknown')
				: Option.none<Release>();
			if (Option.isNone(running)) {
				yield* Effect.logWarning('agent Deployment not readable; retrying');
				yield* Effect.sleep(Duration.seconds(15));
				continue;
			}
			const current: Phase = phase ?? { _tag: 'steady', running: running.value };
			const key = JSON.stringify(current);
			let unreported = key !== reported;
			if (unreported) {
				const answered = yield* api
					.updaterPhase({ payload: { updater_version: updaterVersion, phase: current } })
					.pipe(Effect.result);
				if (Result.isSuccess(answered)) {
					yield* SubscriptionRef.set(latest, answered.success);
					reported = key;
					unreported = false;
				} else {
					yield* Effect.logWarning('updater phase not reported').pipe(
						Effect.annotateLogs({ reason: answered.failure._tag })
					);
				}
			}
			const open = (yield* SubscriptionRef.get(channel))._tag === 'open';
			if (current._tag === 'verifying' && (unreported || !open)) {
				yield* Effect.sleep(Duration.seconds(10));
				continue;
			}
			const instruction = (yield* SubscriptionRef.get(latest)) ?? initialInstruction;
			phase = yield* updater
				.step({ instruction, running: running.value })
				.pipe(
					Effect.catchDefect((defect) =>
						Effect.logWarning('updater step failed').pipe(
							Effect.annotateLogs({ defect: String(defect) }),
							Effect.as(current)
						)
					)
				);
			if (phase._tag === 'updating' || phase._tag === 'verifying') {
				yield* Effect.sleep(Duration.seconds(10));
				continue;
			}
			if (JSON.stringify(phase) !== reported) continue;
			// Settled: wait for the platform's next instruction.
			yield* SubscriptionRef.changes(latest).pipe(
				Stream.drop(1),
				Stream.runHead,
				Effect.timeoutOption(idleRecheck)
			);
		}
	});
