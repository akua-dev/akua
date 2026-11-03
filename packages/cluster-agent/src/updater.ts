import {
	Clock,
	Context,
	Deferred,
	Duration,
	Effect,
	Layer,
	Option,
	Result,
	Schedule,
	Schema,
	Stream,
	SubscriptionRef
} from 'effect';
import { HttpClient, HttpClientRequest, type HttpClientError } from 'effect/http';
import type ids from '@platform/ids';
import {
	AgentRelease,
	type PlacementReport,
	type UpdateRollbackReason,
	type UpdaterInstruction,
	type UpdaterPhase
} from '@platform/api-contract/services/cluster-agent';
import { Deployment } from '@platform/kubernetes-schemas/generated/kubernetes/1.34.1/apps/v1/Deployment';
import { PodList } from '@platform/kubernetes-schemas/generated/kubernetes/1.34.1/core/v1/PodList';
import type { SelfSubjectAccessReview } from '@platform/kubernetes-schemas/generated/kubernetes/1.34.1/authorization.k8s.io/v1/SelfSubjectAccessReview';
import { UpdaterChannelRpcs } from '@platform/api-contract/services/cluster-agent-channel';
import { applySetParentName, unionInventory } from './applyset';
import {
	agentContainer,
	agentObjectsOf,
	attributesKey,
	type Bundle,
	bundleApplier,
	decodeReleaseJson,
	progressDeadlineExceeded,
	readBundle,
	releaseAnnotation,
	rolloutCurrent,
	sameContent
} from './bundle-apply';
import {
	agentBundleSecret,
	type BundleState,
	bundleStateSecret,
	type BundleStateTooLarge,
	type BundleUpdate,
	readReported,
	updaterBundleSecret,
	writeReported
} from './bundle-state';
import type { ChannelState } from './channel';
import { agentDeployment, agentNamespace, AgentUpdater, type KubernetesFailure } from './contract';
import { GitSource } from './git-source';
import { decodeAs, failureFor, KubernetesConnection, KubernetesExtras } from './kubernetes';
import { AgentApi } from './platform';

type Release = typeof AgentRelease.Type;
type Phase = typeof UpdaterPhase.Type;
type Instruction = typeof UpdaterInstruction.Type;
type Reason = typeof UpdateRollbackReason.Type;
type AgentDeploymentObject = typeof Deployment.Type;
type Pods = typeof PodList.Type;
type Review = typeof SelfSubjectAccessReview.Type;
type Outcome = (typeof PlacementReport.Type)['outcome'];
type PlacementId = typeof ids.placement.prefixedEffect.Type;

/** The updater's reads of the agent Deployment and its Pods, for the health gate. */
export class UpdaterKubernetes extends Context.Service<
	UpdaterKubernetes,
	{
		readonly getAgentDeployment: Effect.Effect<
			AgentDeploymentObject,
			KubernetesFailure | HttpClientError.HttpClientError
		>;
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

/** What the agent Deployment says is running; the image wins over a stale annotation. */
export const runningRelease = (
	deployment: AgentDeploymentObject,
	fallbackVersion: string
): Option.Option<Release> => {
	const raw = deployment.metadata?.annotations?.[releaseAnnotation];
	const annotated = raw === undefined ? Option.none<Release>() : decodeReleaseJson(raw);
	const image = imageOf(deployment);
	if (Option.isSome(annotated) && annotated.value.image === image) return annotated;
	return Schema.decodeUnknownOption(AgentRelease)({
		version: Option.isSome(annotated) ? annotated.value.version : fallbackVersion,
		image,
		protocol: Option.isSome(annotated) ? annotated.value.protocol : 1
	});
};

/**
 * One step of the updater against the live agent Deployment and its own
 * state Secret (`agentBundleSecret`). The bundle is the Placement the platform
 * marks `applier: updater`: the whole rendered agent chart, which the
 * updater applies with the agent's building blocks (git source, ApplySet
 * parent, engine, kstatus), impersonating `akua-apply` like every apply.
 *
 * - Offered a new release whose bundle is in desired state: every object
 *   the customer's grant does not cover must be unchanged from the last
 *   good bundle, else `needs-customer-upgrade` with the denied checks and
 *   nothing applied. Otherwise it records the update, applies the bundle
 *   and follows the rollout.
 * - Gate within `verify_seconds`: the agent Deployment kstatus Current,
 *   then a channel connection and an accepted report or StatusBatch from
 *   the new release as the platform observed them.
 * - Verified: prunes what the old bundle had and the new one dropped and
 *   keeps the new bundle as the last good one. Failed: re-applies the last
 *   good bundle, prunes what the new one created, rejects the release here.
 * - No last good bundle yet (installed by Helm): a bundle of the running
 *   release is adopted as is; before the first new release the live copy
 *   of what it replaces is kept as the last good bundle.
 */
export const agentUpdaterLayer = Layer.effect(
	AgentUpdater,
	Effect.gen(function* () {
		const kubernetes = yield* UpdaterKubernetes;
		const extras = yield* KubernetesExtras;
		const git = yield* GitSource;
		const platform = yield* AgentApi;

		const stateSecret = bundleStateSecret(extras, agentBundleSecret);
		const readState = stateSecret.read;
		/** After an update's first write fit: its later writes are no larger. */
		const writeState = (patch: Partial<BundleState>) => stateSecret.write(patch).pipe(Effect.orDie);

		/** Best effort: Placement's own wait covers a lost report. */
		const report = Effect.fnUntraced(function* (
			placementId: PlacementId,
			generation: number,
			outcome: Outcome
		) {
			const now = yield* Clock.currentTimeMillis;
			yield* platform
				.report({
					params: { placement_id: placementId },
					payload: { generation, observed_at: now, outcome }
				})
				.pipe(
					Effect.catch((error) =>
						Effect.logWarning('bundle report not accepted').pipe(
							Effect.annotateLogs({ placementId, reason: error._tag })
						)
					)
				);
		});

		const readAgentBundle = readBundle.pipe(
			Effect.provideService(AgentApi, platform),
			Effect.provideService(GitSource, git),
			Effect.map((bundle) =>
				bundle === null ? null : { ...bundle, objects: agentObjectsOf(bundle.objects) }
			)
		);

		const applier = yield* bundleApplier;
		const parentOf = (update: { readonly placementId: PlacementId }) =>
			applySetParentName(update.placementId);

		const applyUpdate = Effect.fnUntraced(function* (
			state: BundleState,
			update: typeof BundleUpdate.Type
		) {
			const { recorded, failure } = yield* applier.applyRecorded(parentOf(update), update);
			yield* writeState({ update: recorded });
			if (failure !== null) return yield* restore(state, recorded, 'apply-failed', failure.message);
			return {
				_tag: 'updating',
				from: update.from,
				to: update.to,
				startedAt: update.startedAt
			} satisfies Phase;
		});

		const restore = Effect.fnUntraced(function* (
			state: BundleState,
			update: typeof BundleUpdate.Type,
			reason: Reason,
			detail: string | null = null
		): Effect.fn.Return<Phase> {
			const now = yield* Clock.currentTimeMillis;
			yield* applier.rollBack(parentOf(update), state.current?.objects ?? [], update);
			yield* report(update.placementId, update.generation, {
				_tag: 'failed',
				reason: reason === 'apply-failed' ? 'manifests-rejected' : 'unhealthy',
				object: null,
				message:
					`Agent release ${update.to.version} failed its health gate (${reason}${detail === null ? '' : `: ${detail}`}); ${update.from.version} was restored.`.slice(
						0,
						2048
					)
			});
			yield* writeState({ update: null, 'rolled-back': { rejected: update.to, reason, at: now } });
			yield* Effect.logWarning('agent update rolled back').pipe(
				Effect.annotateLogs({ from: update.from.version, to: update.to.version, reason })
			);
			return {
				_tag: 'rolled-back',
				running: update.from,
				rejected: update.to,
				reason,
				at: now
			} satisfies Phase;
		});

		const complete = Effect.fnUntraced(function* (update: typeof BundleUpdate.Type) {
			yield* applier.settle(parentOf(update), update);
			yield* report(update.placementId, update.generation, {
				_tag: 'ready',
				revision: update.revision,
				health: 'healthy',
				objects: [],
				corrected: []
			});
			yield* writeState({
				current: { release: update.to, objects: update.objects },
				update: null,
				'rolled-back': null
			});
			yield* Effect.logInfo('agent update verified').pipe(
				Effect.annotateLogs({ version: update.to.version })
			);
			return { _tag: 'steady', running: update.to } satisfies Phase;
		});

		/** Follows an update in flight: rollout, then the platform's observations, until its deadline. */
		const follow = Effect.fnUntraced(function* (
			state: BundleState,
			update: typeof BundleUpdate.Type,
			instruction: Instruction,
			observations: 'known' | 'unknown'
		) {
			if (update.appliedAt === null) return yield* applyUpdate(state, update);
			const { from, to, startedAt, deadline } = update;
			const deployment = yield* kubernetes.getAgentDeployment.pipe(Effect.orDie);
			const now = yield* Clock.currentTimeMillis;
			const pods = yield* kubernetes.listPods(selectorOf(deployment)).pipe(Effect.orDie);
			const trouble = podTrouble(pods, to.image);
			if (trouble === 'image-unavailable')
				return yield* restore(state, update, 'image-unavailable');
			if (imageOf(deployment) !== to.image || !rolloutCurrent(deployment)) {
				if (now < deadline && !progressDeadlineExceeded(deployment))
					return { _tag: 'updating', from, to, startedAt } satisfies Phase;
				return yield* restore(
					state,
					update,
					trouble === 'unhealthy' ? 'unhealthy' : 'rollout-failed'
				);
			}
			const observed = instruction.observed;
			const fromNewRelease = observed !== null && observed.version === to.version;
			if (fromNewRelease && observed.online_at !== null && observed.accepted_at !== null)
				return yield* complete(update);
			if (now >= deadline && observations === 'known')
				return yield* restore(
					state,
					update,
					!fromNewRelease || observed.online_at === null ? 'no-presence' : 'no-reconcile'
				);
			return { _tag: 'verifying', from, to, deadline } satisfies Phase;
		});

		/**
		 * Applies `bundle` over the running release. `adopt`: the bundle is the
		 * running release (installed by Helm), applied without a gate.
		 */
		const start = Effect.fnUntraced(function* (args: {
			readonly state: BundleState;
			readonly bundle: Bundle;
			readonly running: Release;
			readonly adopt: boolean;
			readonly verifySeconds: number;
		}) {
			const { state, bundle, running } = args;
			const placementId = bundle.placement.placement_id;
			const now = yield* Clock.currentTimeMillis;
			const name = applySetParentName(placementId);
			const { applySetId, inventory } = yield* applier.applySet(name);
			const [objects = [], previous = []] = yield* applier.plan(
				[bundle.objects, state.current?.objects ?? []],
				applySetId
			);
			const previousByKey = new Map(previous.map((object) => [object.key, object]));
			const reviewed = yield* applier.deniedOf(objects);
			const missing = new Map<string, Review>();
			for (const { object, denied } of reviewed) {
				if (denied.length === 0 || args.adopt) continue;
				const before = previousByKey.get(object.key);
				// The customer's rights: an unchanged object stays as the customer's install left it.
				if (before !== undefined && sameContent(before.manifest, object.manifest)) continue;
				for (const review of denied) missing.set(attributesKey(review), review);
			}
			const [first, ...rest] = [...missing.values()].slice(0, 64);
			if (first !== undefined) {
				yield* report(placementId, bundle.placement.generation, {
					_tag: 'access-denied',
					missing: [first, ...rest],
					message: `Agent release ${bundle.release.version} needs ${missing.size} permission(s) the cluster's grant to akua-system/akua-apply does not include.`
				});
				return {
					_tag: 'needs-customer-upgrade',
					running,
					to: bundle.release,
					missing: [first, ...rest],
					at: now
				} satisfies Phase;
			}
			const allowed = reviewed
				.filter((entry) => entry.denied.length === 0)
				.map((entry) => entry.object);
			const entries = allowed.map((object) => object.entry);

			const tooLarge = (error: BundleStateTooLarge) =>
				report(placementId, bundle.placement.generation, {
					_tag: 'failed',
					reason: 'manifests-rejected',
					object: null,
					message: `Agent release ${bundle.release.version} needs ${error.bytes} bytes of rollback state, more than the ${error.limit} its Secret may hold; nothing was applied.`
				});

			if (args.adopt) {
				const fits = yield* stateSecret
					.fits({ current: { release: running, objects: bundle.objects } })
					.pipe(Effect.result);
				if (Result.isFailure(fits)) {
					yield* tooLarge(fits.failure);
					yield* Effect.logError('bundle of the running release too large to keep');
					return { _tag: 'steady', running } satisfies Phase;
				}
				yield* applier.writeParent(name, applySetId, running, unionInventory(inventory, entries));
				const applied = yield* applier.apply(applySetId, allowed);
				if (applied.failure !== null) {
					yield* Effect.logWarning('bundle of the running release not adopted').pipe(
						Effect.annotateLogs({ message: applied.failure.message })
					);
					return { _tag: 'steady', running } satisfies Phase;
				}
				yield* applier.writeParent(name, applySetId, running, entries);
				yield* report(placementId, bundle.placement.generation, {
					_tag: 'ready',
					revision: bundle.placement.source.revision,
					health: 'healthy',
					objects: [],
					corrected: []
				});
				yield* writeState({ current: { release: running, objects: bundle.objects } });
				return { _tag: 'steady', running } satisfies Phase;
			}

			const { current, update } = yield* applier.prepare({
				applySetId,
				objects: bundle.objects,
				planned: objects,
				previous,
				allowed,
				current: state.current,
				from: running,
				bundle,
				verifySeconds: args.verifySeconds
			});
			const recorded = yield* stateSecret
				.write(state.current === null ? { current, update } : { update })
				.pipe(Effect.result);
			if (Result.isFailure(recorded)) {
				// Refused before anything changed: the cluster could not keep its rollback copy.
				yield* tooLarge(recorded.failure);
				yield* writeState({
					'rolled-back': { rejected: bundle.release, reason: 'bundle-too-large', at: now }
				});
				yield* Effect.logError('agent update refused: bundle state too large').pipe(
					Effect.annotateLogs({ to: bundle.release.version, bytes: recorded.failure.bytes })
				);
				return {
					_tag: 'rolled-back',
					running,
					rejected: bundle.release,
					reason: 'bundle-too-large',
					at: now
				} satisfies Phase;
			}
			yield* Effect.logInfo('agent update started').pipe(
				Effect.annotateLogs({ from: running.version, to: bundle.release.version })
			);
			return yield* applyUpdate({ ...state, current }, update);
		});

		const agentApply = bundleStateSecret(extras, updaterBundleSecret).peek.pipe(
			Effect.map((state) => ({
				inFlight: state.updating,
				rejected: state.rejected?.rejected.version ?? null
			})),
			// Unreadable: hold, as if the agent were applying the updater's part.
			Effect.catchDefect((defect) =>
				Effect.logError('agent state unreadable; holding').pipe(
					Effect.annotateLogs({ defect: String(defect) }),
					Effect.as({ inFlight: true, rejected: null })
				)
			)
		);

		const step = Effect.fn('AgentUpdater.step')(function* (args: {
			readonly instruction: Instruction;
			readonly running: Release;
			readonly version: string;
			readonly observations: 'known' | 'unknown';
		}) {
			const state = yield* readState;
			if (state.update !== null)
				return yield* follow(state, state.update, args.instruction, args.observations);
			// Never both at once: not while the agent applies or gates the updater's part,
			// and never as an updater release the agent rejected (it is being replaced).
			const agent = yield* agentApply;
			const held = agent.inFlight || agent.rejected === args.version;

			const rejection = state['rolled-back'];
			const desired = args.instruction.desired;
			const offered =
				desired !== null &&
				desired.image !== args.running.image &&
				rejection?.rejected.image !== desired.image
					? desired
					: null;
			if (!held && (offered !== null || state.current === null)) {
				const bundle = yield* readAgentBundle;
				const adopt =
					bundle !== null && state.current === null && bundle.release.image === args.running.image;
				if (bundle !== null && (adopt || bundle.release.image === offered?.image))
					return yield* start({
						state,
						bundle,
						running: args.running,
						adopt,
						verifySeconds: args.instruction.verify_seconds
					});
			}
			if (rejection !== null)
				return {
					_tag: 'rolled-back',
					running: args.running,
					rejected: rejection.rejected,
					reason: rejection.reason,
					at: rejection.at
				} satisfies Phase;
			return { _tag: 'steady', running: args.running } satisfies Phase;
		});

		const inFlight = readState.pipe(
			Effect.map((state): Phase | null => {
				const update = state.update;
				if (update === null) return null;
				return update.appliedAt === null
					? { _tag: 'updating', from: update.from, to: update.to, startedAt: update.startedAt }
					: { _tag: 'verifying', from: update.from, to: update.to, deadline: update.deadline };
			})
		);

		return AgentUpdater.of({ step, inFlight, agentApply });
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
		/** `/readyz`: the loop read the agent Deployment and its state once. */
		readonly ready: SubscriptionRef.SubscriptionRef<boolean>;
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
				}),
				ready: yield* SubscriptionRef.make(false)
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
 * While an update is in flight it steps every 10 s, while the agent applies
 * the updater's part every 30 s; otherwise it waits for the next push.
 * While its channel is down the platform's observations are unknown, not
 * absent: an outage never rolls back a release it could not see. Once its
 * channel is open and the platform answered a phase it reported, it writes
 * `reported` with its version: the agent's gate for a new updater.
 */
export const updaterLoop = (updaterVersion: string) =>
	Effect.gen(function* () {
		const api = yield* AgentApi;
		const updater = yield* AgentUpdater;
		const kubernetes = yield* UpdaterKubernetes;
		const extras = yield* KubernetesExtras;
		const { latest, channel, ready } = yield* UpdaterInstructions;
		const accepted = yield* Deferred.make<void>();
		yield* Effect.forkChild(
			Effect.gen(function* () {
				yield* SubscriptionRef.changes(channel).pipe(
					Stream.filter((state) => state._tag === 'open'),
					Stream.runHead
				);
				yield* Deferred.await(accepted);
				if ((yield* readReported(extras))?.version !== updaterVersion)
					yield* writeReported(extras, {
						version: updaterVersion,
						at: yield* Clock.currentTimeMillis
					}).pipe(
						Effect.tapError((error) =>
							Effect.logWarning('attestation not written; retrying').pipe(
								Effect.annotateLogs({ reason: error._tag })
							)
						),
						Effect.retry(Schedule.spaced(Duration.seconds(10)))
					);
			})
		);
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
			const current: Phase = phase ??
				(yield* updater.inFlight) ?? { _tag: 'steady', running: running.value };
			const agent = yield* updater.agentApply;
			if (!(yield* SubscriptionRef.get(ready))) yield* SubscriptionRef.set(ready, true);
			const key: string = JSON.stringify([current, agent.rejected]);
			let unreported: boolean = key !== reported;
			if (unreported) {
				const answered = yield* api
					.updaterPhase({
						payload: {
							updater_version: updaterVersion,
							phase: current,
							...(agent.rejected === null ? {} : { updater_rejected: agent.rejected })
						}
					})
					.pipe(Effect.result);
				if (Result.isSuccess(answered)) {
					yield* SubscriptionRef.set(latest, answered.success);
					yield* Deferred.succeed(accepted, undefined);
					reported = key;
					unreported = false;
				} else {
					yield* Effect.logWarning('updater phase not reported').pipe(
						Effect.annotateLogs({ reason: answered.failure._tag })
					);
				}
			}
			const open = (yield* SubscriptionRef.get(channel))._tag === 'open';
			const instruction = (yield* SubscriptionRef.get(latest)) ?? initialInstruction;
			phase = yield* updater
				.step({
					instruction,
					running: running.value,
					version: updaterVersion,
					observations: open && !unreported ? 'known' : 'unknown'
				})
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
			if (JSON.stringify([phase, agent.rejected]) !== reported) {
				// The platform did not take the last report: try again shortly, not at once.
				if (unreported) yield* Effect.sleep(Duration.seconds(10));
				continue;
			}
			if ((yield* updater.agentApply).inFlight) {
				// The agent applies the updater's part; look again once it is done.
				yield* Effect.sleep(Duration.seconds(30));
				continue;
			}
			// Settled: wait for the platform's next instruction.
			yield* SubscriptionRef.changes(latest).pipe(
				Stream.drop(1),
				Stream.runHead,
				Effect.timeoutOption(idleRecheck)
			);
		}
	});
