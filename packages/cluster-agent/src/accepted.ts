import { Clock, Context, Effect, Layer, Ref } from 'effect';
import type { Heartbeat } from '@platform/api-contract/services/cluster-agent';

type LastAccepted = (typeof Heartbeat.Type)['last_accepted'];

/**
 * The latest Placement report or StatusBatch the platform answered with 2xx
 * since this process started; the Heartbeat carries it for the update gate.
 */
export class AcceptedTracker extends Context.Service<
	AcceptedTracker,
	{
		readonly markAccepted: (kind: 'report' | 'status-batch') => Effect.Effect<void>;
		readonly lastAccepted: Effect.Effect<LastAccepted>;
	}
>()('akua/cluster-agent/AcceptedTracker') {
	static readonly layer = Layer.effect(
		AcceptedTracker,
		Effect.gen(function* () {
			const last = yield* Ref.make<LastAccepted>(null);
			return AcceptedTracker.of({
				markAccepted: (kind) =>
					Clock.currentTimeMillis.pipe(Effect.flatMap((at) => Ref.set(last, { kind, at }))),
				lastAccepted: Ref.get(last)
			});
		})
	);
}
