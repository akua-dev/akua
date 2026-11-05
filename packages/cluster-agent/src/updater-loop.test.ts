import { assert, describe, it } from '@effect/vitest';
import { Clock, Duration, Effect, Fiber, Ref, Schema, SubscriptionRef } from 'effect';
import { TestClock } from 'effect/testing';
import { bundleStateSecret, readReported, updaterBundleSecret } from './bundle-state';
import { KubernetesExtras } from './kubernetes';
import { UpdaterInstructions, updaterLoop } from './updater';
import { ConnectionId } from '@platform/api-contract/services/ClusterConnectorChannel';
import type { UpdaterInstruction } from '@platform/api-contract/services/ClusterConnector';
import { FakeAgentDeployment } from './testing/fake-agent-deployment';
import { FakePlatform } from './testing/fake-platform';
import { AgentUpdater } from './contract';
import { advanceUntil } from './testing/advance-until';
import {
	placeBundle,
	revisionV1,
	revisionV2,
	rollingEngine,
	updaterHarness,
	v1,
	v2
} from './testing/bundle';

const layer = updaterHarness({
	platform: { instruction: { desired: v2, verify_seconds: 120, observed: null } }
});

/** v1's bundle adopted, v2's placed: what the loop finds when Cluster offers v2. */
const offered = Effect.gen(function* () {
	yield* rollingEngine;
	yield* placeBundle(1, revisionV1, 1);
	const updater = yield* AgentUpdater;
	yield* updater.step({
		instruction: { desired: null, verify_seconds: 120, observed: null },
		running: v1,
		version: v1.version,
		observations: 'known'
	});
	yield* placeBundle(2, revisionV2, 2);
});

const image = Effect.gen(function* () {
	const deployment = yield* Ref.get((yield* FakeAgentDeployment).deployment);
	return deployment.spec?.template.spec?.containers[0]?.image;
});

/** The updater's own channel connection as open or down. */
const channel = (open: boolean) =>
	Effect.gen(function* () {
		const { channel } = yield* UpdaterInstructions;
		yield* SubscriptionRef.set(
			channel,
			open
				? { _tag: 'open', connectionId: Schema.decodeSync(ConnectionId)(1), protocol: 1, since: 0 }
				: { _tag: 'connecting', attempt: 1, since: 0 }
		);
	});

/** What Cluster pushes on the channel (`Instruct.v1`). */
const push = (instruction: typeof UpdaterInstruction.Type) =>
	UpdaterInstructions.use(({ latest }) => SubscriptionRef.set(latest, instruction));

const phases = Effect.gen(function* () {
	return (yield* Ref.get((yield* FakePlatform).state)).updaterPhases.map((report) => report.phase);
});

describe('updaterLoop', () => {
	it.effect(
		'reports its phase on change, keeps a verifying release while its channel is down, then verifies it from a push',
		() =>
			Effect.gen(function* () {
				yield* offered;
				yield* channel(true);
				const fake = yield* FakeAgentDeployment;
				const loop = yield* Effect.forkChild(updaterLoop('1.0.0'));
				yield* advanceUntil(
					Effect.map(image, (current) => current === v2.image),
					'1 second'
				);
				yield* fake.settle;
				yield* channel(false);
				for (let tick = 0; tick < 40; tick += 1) yield* TestClock.adjust('10 seconds');
				assert.strictEqual(yield* image, v2.image, 'kept while observations are unknown');
				yield* channel(true);
				yield* push({
					desired: null,
					verify_seconds: 120,
					observed: { version: v2.version, online_at: 1, accepted_at: 2 }
				});
				yield* advanceUntil(
					Effect.map(phases, (reported) => reported.at(-1)?._tag === 'steady'),
					'10 seconds'
				);
				assert.strictEqual(yield* image, v2.image);
				// One report per phase change, not one per tick.
				const tags = (yield* phases).map((reported) => reported._tag);
				assert.deepStrictEqual(
					tags.filter((tag, index) => tag !== tags[index - 1]),
					tags
				);
				yield* Fiber.interrupt(loop);
			}).pipe(Effect.provide(layer))
	);

	it.effect(
		'keeps a release whose rollout becomes Current only at its deadline while its channel is down',
		() =>
			Effect.gen(function* () {
				yield* offered;
				yield* channel(true);
				const fake = yield* FakeAgentDeployment;
				const loop = yield* Effect.forkChild(updaterLoop('1.0.0'));
				yield* advanceUntil(
					Effect.map(image, (current) => current === v2.image),
					'1 second'
				);
				yield* channel(false);
				// Still `updating` (the rollout is not Current) until just before the 120 s deadline.
				yield* advanceUntil(
					Effect.map(Clock.currentTimeMillis, (now) => now >= 115_000),
					'1 second'
				);
				yield* fake.settle;
				for (let tick = 0; tick < 20; tick += 1) {
					yield* TestClock.withLive(Effect.sleep('2 millis'));
					yield* TestClock.adjust('10 seconds');
				}
				assert.strictEqual(yield* image, v2.image, 'kept while observations are unknown');
				assert.notInclude(
					(yield* phases).map((reported) => reported._tag),
					'rolled-back'
				);
				yield* Fiber.interrupt(loop);
			}).pipe(Effect.provide(layer))
	);

	it.effect('rolls back with no-presence when no push ever shows the new release', () =>
		Effect.gen(function* () {
			yield* offered;
			yield* channel(true);
			const fake = yield* FakeAgentDeployment;
			const loop = yield* Effect.forkChild(updaterLoop('1.0.0'));
			yield* advanceUntil(
				Effect.map(image, (current) => current === v2.image),
				'1 second'
			);
			yield* fake.settle;
			yield* push({
				desired: null,
				verify_seconds: 120,
				observed: null
			});
			yield* advanceUntil(
				Effect.map(image, (current) => current === v1.image),
				'10 seconds'
			);
			yield* advanceUntil(
				Effect.map(phases, (reported) => reported.at(-1)?._tag === 'rolled-back'),
				'10 seconds'
			);
			const reported = (yield* phases).at(-1);
			assert.strictEqual(reported?._tag === 'rolled-back' ? reported.reason : '', 'no-presence');
			yield* Fiber.interrupt(loop);
		}).pipe(Effect.provide(layer))
	);

	it.effect(
		'attests its version once its channel is open and a phase was answered, and reports the updater release the agent rejected',
		() =>
			Effect.gen(function* () {
				const extras = yield* KubernetesExtras;
				yield* rollingEngine;
				yield* placeBundle(1, revisionV1, 1);
				yield* bundleStateSecret(extras, updaterBundleSecret)
					.write({ 'rolled-back': { rejected: v2, reason: 'no-presence', at: 1 } })
					.pipe(Effect.orDie);
				yield* channel(false);
				const loop = yield* Effect.forkChild(updaterLoop('1.0.0'));
				const reports = Effect.map(
					Effect.flatMap(FakePlatform, (platform) => Ref.get(platform.state)),
					(state) => state.updaterPhases
				);
				yield* advanceUntil(
					Effect.map(reports, (all) => all.length > 0),
					'1 second'
				);
				assert.strictEqual((yield* reports).at(-1)?.updater_rejected, '1.1.0');
				assert.isTrue(yield* SubscriptionRef.get((yield* UpdaterInstructions).ready));
				// Answered, but its own channel is not open yet: no attestation.
				assert.strictEqual(yield* readReported(extras), null);
				yield* channel(true);
				yield* advanceUntil(
					Effect.map(readReported(extras), (reported) => reported !== null),
					Duration.zero
				);
				assert.strictEqual((yield* readReported(extras))?.version, '1.0.0');
				yield* Fiber.interrupt(loop);
			}).pipe(Effect.provide(updaterHarness()))
	);
});
