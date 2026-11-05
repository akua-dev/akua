import { Context, Deferred, Effect, Layer, Queue, Redacted, Ref, Schema } from 'effect';
import { RpcClient, RpcServer } from 'effect/rpc';
import type { RpcClientError, RpcGroup } from 'effect/rpc';
import { Socket } from 'effect/socket';
import {
	ClusterConnectorChannelRpcs,
	type ChannelRole,
	ConnectionId,
	type Hello,
	makeChannelProtocols,
	PlatformChannelRpcs,
	type Welcome
} from '@platform/api-contract/services/ClusterConnectorChannel';
import { ChannelDialer } from '../internal/ClusterConnectorChannel';
import { ClusterConnectorCredentials } from '../internal/ClusterConnectorClient';

type ClusterConnectorChannelClient = RpcClient.RpcClient<
	RpcGroup.Rpcs<typeof ClusterConnectorChannelRpcs>,
	RpcClientError.RpcClientError
>;

/** One accepted socket as the fake platform sees it. */
export interface FakeConnection {
	readonly id: number;
	readonly role: ChannelRole;
	readonly bearer: string;
	readonly hello: Deferred.Deferred<Hello>;
	/** The platform's client of the agent's RpcGroup on this socket. */
	readonly agent: ClusterConnectorChannelClient;
	/** Closes the socket from the platform side with this code. */
	readonly close: (code: number) => Effect.Effect<void>;
	/** Completes when the agent closed or dropped the socket. */
	readonly closedByAgent: Deferred.Deferred<number>;
}

/**
 * The platform end of the control channel in memory: every dial gets a
 * socket whose other side runs `makeChannelProtocols`, answers `Hello.v1`
 * with `welcome` and exposes an ClusterConnectorChannelRpcs client, as the channel
 * object does.
 */
export class FakeChannel extends Context.Service<
	FakeChannel,
	{
		readonly connections: Ref.Ref<ReadonlyArray<FakeConnection>>;
		readonly welcome: Ref.Ref<(hello: Hello, connectionId: number) => Welcome>;
		/** Upcoming dials that fail to open, as a proxy refusing the upgrade would. */
		readonly refuse: Ref.Ref<number>;
		readonly dials: Ref.Ref<number>;
	}
>()('akua/cluster-connector/testing/FakeChannel') {}

const decodeConnectionId = Schema.decodeSync(ConnectionId);

export const defaultWelcome =
	(overrides: Partial<Welcome> = {}) =>
	(hello: Hello, connectionId: number): Welcome => ({
		connection_id: decodeConnectionId(connectionId),
		protocol: hello.protocol,
		serves: ['Hello.v1'],
		authenticated_until: 600_000,
		desired_revision: hello._tag === 'agent' ? 0 : null,
		subscriptions: hello._tag === 'agent' ? { status: [], nodes: false } : null,
		...overrides
	});

type Inbound =
	| { readonly _tag: 'frame'; readonly frame: string }
	| { readonly _tag: 'close'; readonly code: number };

export const fakeChannelLayer = Layer.effectContext(
	Effect.gen(function* () {
		const connections = yield* Ref.make<ReadonlyArray<FakeConnection>>([]);
		const welcome = yield* Ref.make(defaultWelcome());
		const refuse = yield* Ref.make(0);
		const dials = yield* Ref.make(0);

		const dial = ({
			role,
			bearer
		}: {
			readonly role: ChannelRole;
			readonly bearer: Redacted.Redacted<string>;
		}) =>
			Effect.gen(function* () {
				const toAgent = yield* Queue.unbounded<Inbound>();
				const toPlatform = yield* Queue.unbounded<string>();
				const closedByAgent = yield* Deferred.make<number>();
				const reader = Effect.gen(function* () {
					yield* Ref.update(dials, (count) => count + 1);
					const refused = yield* Ref.modify(refuse, (count) => [count > 0, Math.max(0, count - 1)]);
					if (refused)
						return yield* new Socket.SocketError({
							reason: new Socket.SocketOpenError({ kind: 'Unknown', cause: 'refused' })
						});
					const id = (yield* Ref.get(connections)).length + 1;
					const hello = yield* Deferred.make<Hello>();
					const protocols = yield* makeChannelProtocols({
						send: (frame) => Queue.offer(toAgent, { _tag: 'frame', frame }).pipe(Effect.asVoid),
						close: (code) => Queue.offer(toAgent, { _tag: 'close', code }).pipe(Effect.asVoid)
					});
					yield* Queue.take(toPlatform).pipe(
						Effect.flatMap(protocols.deliver),
						Effect.forever,
						Effect.forkScoped
					);
					const answer = yield* Ref.get(welcome);
					yield* RpcServer.make(PlatformChannelRpcs).pipe(
						Effect.provideService(RpcServer.Protocol, protocols.server),
						Effect.provide(
							PlatformChannelRpcs.toLayer({
								'Hello.v1': (payload) =>
									Deferred.succeed(hello, payload).pipe(Effect.as(answer(payload, id)))
							})
						),
						Effect.forkScoped
					);
					const agent = yield* RpcClient.make(ClusterConnectorChannelRpcs).pipe(
						Effect.provideService(RpcClient.Protocol, protocols.client)
					);
					yield* Ref.update(connections, (all) => [
						...all,
						{
							id,
							role,
							bearer: Redacted.value(bearer),
							hello,
							agent,
							close: (code) => Queue.offer(toAgent, { _tag: 'close', code }).pipe(Effect.asVoid),
							closedByAgent
						}
					]);
					yield* Effect.addFinalizer(() => Deferred.succeed(closedByAgent, 1000));
					return {
						pull: Queue.take(toAgent).pipe(
							Effect.flatMap((item) =>
								item._tag === 'frame'
									? Effect.succeed([item.frame] as const)
									: Effect.fail(
											new Socket.SocketError({
												reason: new Socket.SocketCloseError({ code: item.code })
											})
										)
							)
						),
						upgrade: () => Effect.void
					} satisfies Socket.Reader;
				});
				const writer = Effect.succeed<Socket.Writer>({
					write: (chunk) =>
						Socket.isCloseEvent(chunk)
							? Deferred.succeed(closedByAgent, chunk.code).pipe(Effect.asVoid)
							: Queue.offer(
									toPlatform,
									typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk)
								).pipe(Effect.asVoid),
					writeAll: (chunks) =>
						Effect.forEach(
							chunks,
							(chunk) =>
								Queue.offer(
									toPlatform,
									typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk)
								),
							{ discard: true }
						)
				});
				return Socket.make({ reader, writer });
			});

		return Context.make(FakeChannel, FakeChannel.of({ connections, welcome, refuse, dials })).pipe(
			Context.add(ChannelDialer, ChannelDialer.of({ dial }))
		);
	})
);

/** Credentials that hand out a new numbered bearer per call, so tests can tell connections apart. */
export const countingCredentials = Layer.effect(
	ClusterConnectorCredentials,
	Effect.gen(function* () {
		const issued = yield* Ref.make(0);
		return ClusterConnectorCredentials.of({
			accessToken: Ref.updateAndGet(issued, (count) => count + 1).pipe(
				Effect.map((count) => Redacted.make(`bearer-${count}`))
			),
			invalidate: Effect.void
		});
	})
);
