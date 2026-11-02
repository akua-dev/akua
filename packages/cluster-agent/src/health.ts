import * as BunHttpServer from '@effect/platform-bun/BunHttpServer';
import { Effect, Layer } from 'effect';
import { HttpRouter, HttpServerResponse } from 'effect/http';

/**
 * `/healthz` answers while the process runs; `/readyz` only while `ready`
 * holds. The Deployment's readiness probe uses `/readyz`, which is what the
 * updater's rollout gate observes.
 */
export const healthServer = <R>(port: number, ready: Effect.Effect<boolean, never, R>) =>
	HttpRouter.serve(
		Layer.mergeAll(
			HttpRouter.add('GET', '/healthz', HttpServerResponse.text('ok')),
			HttpRouter.add(
				'GET',
				'/readyz',
				Effect.map(ready, (ok) =>
					ok
						? HttpServerResponse.text('ready')
						: HttpServerResponse.text('not ready', { status: 503 })
				)
			)
		),
		{ disableLogger: true }
	).pipe(Layer.provide(BunHttpServer.layer({ port })));
