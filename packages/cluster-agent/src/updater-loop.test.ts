import { assert, describe, it } from '@effect/vitest';
import { Effect, Fiber, Ref, Schema, SubscriptionRef } from 'effect';
import { TestClock } from 'effect/testing';
import { bundleStateSecret, readReported, updaterBundleSecret } from './bundle-state';
import { KubernetesExtras } from './kubernetes';
import { UpdaterInstructions, updaterLoop } from './updater';
import { ConnectionId } from '@platform/api-contract/services/cluster-agent-channel';
import type { UpdaterInstruction } from '@platform/api-contract/services/cluster-agent';
import { FakeAgentDeployment } from './testing/fake-agent-deployment';
import { FakePlatform } from './testing/fake-platform';
import { AgentUpdater } from './contract';
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
		version: v1.version
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
				while ((yield* image) !== v2.image) yield* TestClock.adjust('1 second');
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
				let phase = '';
				for (let tick = 0; tick < 20 && phase !== 'steady'; tick += 1) {
					// The fake platform answers on the real event loop; give it a turn.
					yield* TestClock.withLive(Effect.sleep('5 millis'));
					yield* TestClock.adjust('10 seconds');
					phase = (yield* phases).at(-1)?._tag ?? '';
				}
				assert.strictEqual(phase, 'steady');
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

	it.effect('rolls back with no-presence when no push ever shows the new release', () =>
		Effect.gen(function* () {
			yield* offered;
			yield* channel(true);
			const fake = yield* FakeAgentDeployment;
			const loop = yield* Effect.forkChild(updaterLoop('1.0.0'));
			while ((yield* image) !== v2.image) yield* TestClock.adjust('1 second');
			yield* fake.settle;
			yield* push({
				desired: null,
				verify_seconds: 120,
				observed: null
			});
			for (let tick = 0; tick < 20 && (yield* image) !== v1.image; tick += 1)
				yield* TestClock.adjust('10 seconds');
			assert.strictEqual(yield* image, v1.image);
			for (let tick = 0; tick < 5; tick += 1) yield* TestClock.adjust('10 seconds');
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
				for (let tick = 0; tick < 20 && (yield* reports).length === 0; tick += 1) {
					yield* TestClock.withLive(Effect.sleep('5 millis'));
					yield* TestClock.adjust('1 second');
				}
				assert.strictEqual((yield* reports).at(-1)?.updater_rejected, '1.1.0');
				assert.isTrue(yield* SubscriptionRef.get((yield* UpdaterInstructions).ready));
				// Answered, but its own channel is not open yet: no attestation.
				assert.strictEqual(yield* readReported(extras), null);
				yield* channel(true);
				for (let tick = 0; tick < 20 && (yield* readReported(extras)) === null; tick += 1)
					yield* TestClock.withLive(Effect.sleep('5 millis'));
				assert.strictEqual((yield* readReported(extras))?.version, '1.0.0');
				yield* Fiber.interrupt(loop);
			}).pipe(Effect.provide(updaterHarness()))
	);
});
