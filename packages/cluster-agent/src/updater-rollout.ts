import { Clock, Context, Duration, Effect, Layer, Option, Result, Schema } from 'effect';
import type {
	AgentRelease,
	UpdateRollbackReason
} from '@platform/api-contract/services/cluster-agent';
import { Deployment } from '@platform/kubernetes-schemas/generated/kubernetes/1.34.1/apps/v1/Deployment';
import {
	type Bundle,
	bundleApplier,
	progressDeadlineExceeded,
	readBundle,
	rolloutCurrent,
	updaterObjectsOf
} from './bundle-apply';
import {
	agentBundleSecret,
	type BundleState,
	bundleStateSecret,
	type BundleUpdate,
	readReported,
	updaterBundleSecret
} from './bundle-state';
import { agentNamespace, updaterDeployment } from './contract';
import { GitSource } from './git-source';
import { KubernetesExtras } from './kubernetes';
import { AgentApi } from './platform';

type Release = typeof AgentRelease.Type;
type Reason = typeof UpdateRollbackReason.Type;
type DeploymentObject = typeof Deployment.Type;

/** The ApplySet parent in akua-system whose members are the updater's own objects. */
export const updaterParentName = 'akua-applyset-updater';

/** The updater's gate: rolled out, its channel open and a phase reported, within this. */
export const updaterVerifySeconds = 300;

const updaterContainer = 'updater';

/** Where the agent's apply of the updater's own objects stands; only the agent's loop reads it. */
export type RolloutPhase =
	| { readonly _tag: 'idle' }
	| { readonly _tag: 'updating'; readonly to: Release }
	| { readonly _tag: 'verifying'; readonly to: Release; readonly deadline: number }
	| { readonly _tag: 'verified'; readonly running: Release }
	| { readonly _tag: 'rolled-back'; readonly rejected: Release; readonly reason: Reason };

const idle: RolloutPhase = { _tag: 'idle' };

const decodeDeployment = Schema.decodeUnknownOption(Deployment);

/** The version the updater Deployment runs, as its process reports it (`AKUA_AGENT_VERSION`). */
const versionOf = (deployment: DeploymentObject): string | null =>
	deployment.spec?.template.spec?.containers
		.find((container) => container.name === updaterContainer)
		?.env?.find((variable) => variable.name === 'AKUA_AGENT_VERSION')?.value ?? null;

/**
 * The agent's half of "never both at once" (CEP-0051 decision 14): the
 * updater applies the agent's part of the bundle, the agent applies the
 * updater's own objects (labelled component `updater`), with the same
 * building blocks, gate and rollback, keeping its state in
 * `updaterBundleSecret`.
 *
 * It starts only when the updater is idle (no update in its state) and has
 * verified the agent's part of the bundle of the release this agent runs,
 * when the updater Deployment runs another version, and when the agent has
 * not rejected that release here. While its update is recorded the updater
 * starts nothing (it reads this state), and the platform offers no new
 * release while the updater runs behind the agent: the two never change
 * at the same time, by state and not by timing.
 *
 * Gate within `updaterVerifySeconds`: the updater Deployment runs the new
 * version and is kstatus Current (its readiness probe is the updater's
 * `/readyz`), then the new updater's `reported` attestation: its own
 * channel was open and the platform answered a phase it reported with that
 * version. Failed: the last good updater objects kept in this cluster are
 * applied again, what the new ones created is pruned and the release is
 * rejected here, which the updater reports (`updater_rejected`). Objects the
 * customer's grant to `akua-apply` does not cover are left as the
 * customer's install made them; a new updater that needs them fails its
 * gate and is rolled back.
 */
export class UpdaterRollout extends Context.Service<
	UpdaterRollout,
	{ step(running: Release): Effect.Effect<RolloutPhase> }
>()('akua/cluster-agent/UpdaterRollout') {
	static readonly layer = Layer.effect(
		UpdaterRollout,
		Effect.gen(function* () {
			const extras = yield* KubernetesExtras;
			const platform = yield* AgentApi;
			const git = yield* GitSource;
			const applier = yield* bundleApplier;
			const own = bundleStateSecret(extras, updaterBundleSecret);
			const updaterState = bundleStateSecret(extras, agentBundleSecret);
			/** Every write after an update's first one is no larger than it. */
			const writeOwn = (patch: Partial<BundleState>) => own.write(patch).pipe(Effect.orDie);
			const fetchBundle = readBundle.pipe(
				Effect.provideService(AgentApi, platform),
				Effect.provideService(GitSource, git)
			);

			const readUpdater = extras
				.getObjectAsApply({
					apiVersion: 'apps/v1',
					resource: 'deployments',
					namespace: agentNamespace,
					name: updaterDeployment
				})
				.pipe(
					Effect.orDie,
					Effect.map((object) =>
						object === null ? null : Option.getOrNull(decodeDeployment(object))
					)
				);

			const restore = Effect.fnUntraced(function* (
				state: BundleState,
				update: typeof BundleUpdate.Type,
				reason: Reason
			) {
				const now = yield* Clock.currentTimeMillis;
				yield* applier.rollBack(updaterParentName, state.current?.objects ?? [], update);
				yield* writeOwn({ update: null, 'rolled-back': { rejected: update.to, reason, at: now } });
				yield* Effect.logWarning('updater update rolled back').pipe(
					Effect.annotateLogs({ from: update.from.version, to: update.to.version, reason })
				);
				return { _tag: 'rolled-back', rejected: update.to, reason } satisfies RolloutPhase;
			});

			const complete = Effect.fnUntraced(function* (update: typeof BundleUpdate.Type) {
				yield* applier.settle(updaterParentName, update);
				yield* writeOwn({
					current: { release: update.to, objects: update.objects },
					update: null,
					'rolled-back': null
				});
				yield* Effect.logInfo('updater update verified').pipe(
					Effect.annotateLogs({ version: update.to.version })
				);
				return { _tag: 'verified', running: update.to } satisfies RolloutPhase;
			});

			const applyUpdate = Effect.fnUntraced(function* (
				state: BundleState,
				update: typeof BundleUpdate.Type
			) {
				const { recorded, failure } = yield* applier.applyRecorded(updaterParentName, update);
				yield* writeOwn({ update: recorded });
				if (failure !== null) return yield* restore(state, recorded, 'apply-failed');
				return { _tag: 'updating', to: update.to } satisfies RolloutPhase;
			});

			/**
			 * Rolled out, then the new updater's attestation. Its version alone
			 * identifies it: a release rolled back here is never applied again,
			 * and the two pods' clocks need not agree.
			 */
			const follow = Effect.fnUntraced(function* (
				state: BundleState,
				update: typeof BundleUpdate.Type
			) {
				if (update.appliedAt === null) return yield* applyUpdate(state, update);
				const live = yield* readUpdater;
				const now = yield* Clock.currentTimeMillis;
				if (live === null || versionOf(live) !== update.to.version || !rolloutCurrent(live)) {
					if (now < update.deadline && !(live !== null && progressDeadlineExceeded(live)))
						return { _tag: 'updating', to: update.to } satisfies RolloutPhase;
					return yield* restore(state, update, 'rollout-failed');
				}
				if ((yield* readReported(extras))?.version === update.to.version)
					return yield* complete(update);
				if (now >= update.deadline) return yield* restore(state, update, 'no-presence');
				return {
					_tag: 'verifying',
					to: update.to,
					deadline: update.deadline
				} satisfies RolloutPhase;
			});

			/** The updater idle and done with the agent's part of `running`: the agent's turn. */
			const updaterSettledOn = (running: Release) =>
				Effect.map(
					updaterState.read,
					(updater) =>
						updater.update === null && updater.current?.release.version === running.version
				);

			const start = Effect.fnUntraced(function* (
				state: BundleState,
				bundle: Bundle,
				from: Release
			) {
				const objects = updaterObjectsOf(bundle.objects);
				const { applySetId } = yield* applier.applySet(updaterParentName);
				const [planned = [], previous = []] = yield* applier.plan(
					[objects, state.current?.objects ?? []],
					applySetId
				);
				const { current, update } = yield* applier.prepare({
					applySetId,
					objects,
					planned,
					previous,
					// What the grant does not cover stays as the customer's install made it.
					allowed: yield* applier.allowedOf(planned),
					current: state.current,
					from,
					bundle,
					verifySeconds: updaterVerifySeconds
				});
				// Read again right before the record: the bundle fetch took time.
				if (!(yield* updaterSettledOn(bundle.release))) return idle;
				const recorded = yield* own
					.write(state.current === null ? { current, update } : { update })
					.pipe(Effect.result);
				if (Result.isFailure(recorded)) {
					yield* writeOwn({
						'rolled-back': {
							rejected: bundle.release,
							reason: 'bundle-too-large',
							at: update.startedAt
						}
					});
					yield* Effect.logError('updater update refused: bundle state too large').pipe(
						Effect.annotateLogs({ to: bundle.release.version, bytes: recorded.failure.bytes })
					);
					return {
						_tag: 'rolled-back',
						rejected: bundle.release,
						reason: 'bundle-too-large'
					} satisfies RolloutPhase;
				}
				yield* Effect.logInfo('updater update started').pipe(
					Effect.annotateLogs({ from: from.version, to: bundle.release.version })
				);
				return yield* applyUpdate({ ...state, current }, update);
			});

			const step = Effect.fn('UpdaterRollout.step')(function* (running: Release) {
				const state = yield* own.read;
				if (state.update !== null) return yield* follow(state, state.update);
				if (state['rolled-back']?.rejected.version === running.version) return idle;
				if (!(yield* updaterSettledOn(running))) return idle;
				const live = yield* readUpdater;
				if (live === null) return idle;
				// No version on the Deployment counts as behind: the chart always sets one.
				const liveVersion = versionOf(live);
				if (liveVersion === running.version) return idle;
				const bundle = yield* fetchBundle;
				if (bundle === null || bundle.release.version !== running.version) return idle;
				// Only names the rollback target in logs and the ApplySet tooling annotation.
				const from = state.current?.release ?? {
					...running,
					version: liveVersion ?? 'unknown'
				};
				return yield* start(state, bundle, from);
			});

			return UpdaterRollout.of({ step });
		})
	);
}

/**
 * The agent process's loop over `UpdaterRollout`: every 10 s while its
 * update is in flight, otherwise every 30 s. Each idle look reads only the
 * two state Secrets and the updater Deployment in the cluster; the bundle
 * is fetched only when the updater is behind and idle.
 */
export const updaterRolloutLoop = (running: Release) =>
	Effect.gen(function* () {
		const rollout = yield* UpdaterRollout;
		while (true) {
			const phase = yield* rollout
				.step(running)
				.pipe(
					Effect.catchDefect((defect) =>
						Effect.logWarning('updater rollout step failed').pipe(
							Effect.annotateLogs({ defect: String(defect) }),
							Effect.as(idle)
						)
					)
				);
			yield* Effect.sleep(
				phase._tag === 'updating' || phase._tag === 'verifying'
					? Duration.seconds(10)
					: Duration.seconds(30)
			);
		}
	});
