import { Clock, type Duration, Effect } from 'effect';
import { TestClock } from 'effect/testing';

/**
 * Advances the TestClock by `step` until `done` holds. The fake platform
 * answers through HttpApiTest on the real event loop, so each step first
 * gives it a turn. Bounded by real time, not by a step count: a slow host
 * (remote execution under load) takes more turns, never a different verdict.
 */
export const advanceUntil = <E, R>(done: Effect.Effect<boolean, E, R>, step: Duration.Input) =>
	Effect.gen(function* () {
		const deadline = (yield* TestClock.withLive(Clock.currentTimeMillis)) + 20_000;
		while (!(yield* done)) {
			if ((yield* TestClock.withLive(Clock.currentTimeMillis)) > deadline)
				return yield* Effect.die('advanceUntil: condition not reached within 20 s of real time');
			yield* TestClock.withLive(Effect.sleep('2 millis'));
			yield* TestClock.adjust(step);
		}
	});
