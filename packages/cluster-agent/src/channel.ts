import {
	Clock,
	Context,
	Deferred,
	Duration,
	Effect,
	Exit,
	Layer,
	Random,
	Redacted,
	Schema,
	Scope,
	SubscriptionRef
} from 'effect';
import type { Rpc, RpcGroup } from 'effect/rpc';
import { RpcClient, RpcServer } from 'effect/rpc';
import { Socket } from 'effect/socket';
import {
	channelLimits,
	ChannelCloseCode,
	channelReconnect,
	ChannelRole,
	ConnectionId,
	type Hello,
	makeChannelProtocols,
	PlatformChannelRpcs,
	type Welcome
} from '@platform/api-contract/services/cluster-agent-channel';
import { PlatformOrigin } from './config';
import { AgentCredentials } from './platform';

/**
 * The in-cluster side of the control channel (CEP-0051). The agent and the
 * updater each keep one WebSocket to `wss://<platform>/v1/cluster_connectors/connect`
 * open with their own role:
 *
 * 1. Take a fresh assertion from AgentCredentials and dial with it as the
 *    bearer, a new socket per attempt.
 * 2. Build server and client protocols on the socket
 *    (`makeChannelProtocols`, pinging every `pingIntervalSeconds`), serve
 *    the role's RpcGroup and call `Hello.v1`.
 * 3. Before `authenticated_until` passes, dial a second connection with a
 *    fresh assertion; once it is welcomed, the platform has closed the old
 *    one (4409) and this side drops it.
 * 4. On close: 4403 stops for good (the agent needs repair), 4426 stops
 *    until the updater moves the release, a 4409 this process did not cause
 *    waits `maxReconnectSeconds`, anything else redials with full-jitter
 *    exponential backoff. A Worker deploy may drop the socket; that is a
 *    normal redial.
 *
 * Nothing the agent sends goes through here: reports, StatusBatches and
 * desired-state fetches stay HTTP.
 */

/** The channel URL on the platform origin the agent enrolled with. */
export const channelUrl = (platformOrigin: URL, role: ChannelRole): URL => {
	const url = new URL('/v1/cluster_connectors/connect', platformOrigin);
	url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
	url.searchParams.set('role', role);
	return url;
};

export const ChannelState = Schema.Union([
	Schema.TaggedStruct('connecting', { attempt: Schema.Int, since: Schema.Finite }),
	Schema.TaggedStruct('open', {
		connectionId: ConnectionId,
		protocol: Schema.Int,
		since: Schema.Finite
	}),
	/** 4403 revoked or 4426 protocol unsupported: no more attempts by this process. */
	Schema.TaggedStruct('stopped', {
		reason: Schema.Literals(['revoked', 'protocol-unsupported']),
		since: Schema.Finite
	})
]);
export type ChannelState = typeof ChannelState.Type;

/** Opens the socket for one attempt; tests replace it with an in-memory pair. */
export class ChannelDialer extends Context.Service<
	ChannelDialer,
	{
		dial(args: {
			readonly role: ChannelRole;
			readonly bearer: Redacted.Redacted<string>;
		}): Effect.Effect<Socket.Socket>;
	}
>()('akua/cluster-agent/ChannelDialer') {
	/** Bun's WebSocket client sends the bearer in the upgrade request and honours the proxy settings. */
	static readonly layer = Layer.effect(
		ChannelDialer,
		Effect.gen(function* () {
			const origin = yield* PlatformOrigin;
			const constructor = yield* Socket.WebSocketConstructor;
			return ChannelDialer.of({
				dial: ({ role, bearer }) =>
					Socket.makeWebSocket(channelUrl(origin, role).href, {
						headers: { authorization: `Bearer ${Redacted.value(bearer)}` },
						openTimeout: Duration.seconds(10)
					}).pipe(Effect.provideService(Socket.WebSocketConstructor, constructor))
			});
		})
	);
}

interface Connection {
	readonly scope: Scope.Closeable;
	readonly welcome: Welcome;
	/** The close code, as far as this side can tell. */
	readonly closed: Deferred.Deferred<number>;
}

/** Full jitter: uniform in [0, min(max, initial * 2^attempt)]. */
export const redialDelayMillis = (attempt: number, random: number): number =>
	random *
	Math.min(
		channelReconnect.maxReconnectSeconds * 1000,
		channelReconnect.initialSeconds * 1000 * 2 ** attempt
	);

const textDecoder = new TextDecoder();

/** Code of a socket failure: the close frame's code, or 1006 for anything without one. */
const closeCodeOf = (error: Socket.SocketError): number =>
	error.reason._tag === 'SocketCloseError' ? error.reason.code : 1006;

/**
 * Keeps the role's connection open for the life of the process. `serve`
 * holds the role's RpcGroup handlers; `hello` is built fresh for every
 * connection; `onWelcome` runs after each accepted handshake.
 */
export const runChannel = <Rpcs extends Rpc.Any, E, R>(options: {
	readonly role: ChannelRole;
	readonly group: RpcGroup.RpcGroup<Rpcs>;
	readonly handlers: Layer.Layer<Rpc.ToHandler<Rpcs>, E, R>;
	readonly hello: Effect.Effect<Hello>;
	readonly onWelcome: (welcome: Welcome) => Effect.Effect<void>;
	readonly state: SubscriptionRef.SubscriptionRef<ChannelState>;
}) =>
	Effect.gen(function* () {
		const dialer = yield* ChannelDialer;
		const credentials = yield* AgentCredentials;
		const handlers = yield* Layer.build(options.handlers);

		/** One attempt: dial, serve, Hello. Fails when the socket or the handshake fails. */
		const connect = Effect.fnUntraced(function* (scope: Scope.Scope) {
			const bearer = yield* credentials.accessToken;
			const socket = yield* dialer.dial({ role: options.role, bearer });
			const closed = yield* Deferred.make<number>();
			const reader = yield* socket.reader.pipe(Scope.provide(scope));
			const writer = yield* socket.writer.pipe(Scope.provide(scope));
			const protocols = yield* makeChannelProtocols(
				{
					send: (frame) =>
						writer
							.write(frame)
							.pipe(Effect.catch(() => Deferred.succeed(closed, 1006).pipe(Effect.asVoid))),
					close: (code, reason) =>
						writer
							.write(new Socket.CloseEvent(code, reason))
							.pipe(Effect.ignore, Effect.andThen(Deferred.succeed(closed, code)), Effect.asVoid)
				},
				{
					ping: {
						interval: Duration.seconds(channelLimits.pingIntervalSeconds),
						timeout: Duration.seconds(channelLimits.agentPingTimeoutSeconds)
					}
				}
			).pipe(Scope.provide(scope));
			yield* reader.pull.pipe(
				Effect.flatMap((frames) =>
					Effect.forEach(
						frames,
						(frame) =>
							protocols.deliver(typeof frame === 'string' ? frame : textDecoder.decode(frame)),
						{ discard: true }
					)
				),
				Effect.forever,
				Effect.catch((error) => Deferred.succeed(closed, closeCodeOf(error))),
				Effect.forkIn(scope)
			);
			yield* RpcServer.make(options.group, {
				concurrency: channelLimits.maxPlatformCallsInFlight
			}).pipe(
				Effect.provideService(RpcServer.Protocol, protocols.server),
				Effect.provideContext(handlers),
				Effect.forkIn(scope)
			);
			const client = yield* RpcClient.make(PlatformChannelRpcs).pipe(
				Effect.provideService(RpcClient.Protocol, protocols.client),
				Scope.provide(scope)
			);
			const welcome = yield* client['Hello.v1'](yield* options.hello).pipe(
				Effect.timeout(Duration.seconds(channelLimits.helloTimeoutSeconds))
			);
			return { welcome, closed };
		});

		const open = Effect.fnUntraced(function* () {
			const scope = yield* Scope.make();
			const result = yield* connect(scope).pipe(Effect.result);
			if (result._tag === 'Failure') {
				yield* Scope.close(scope, Exit.void);
				yield* Effect.logWarning('channel connect failed').pipe(
					Effect.annotateLogs({ role: options.role, reason: String(result.failure) })
				);
				return null;
			}
			const connection: Connection = { ...result.success, scope };
			yield* SubscriptionRef.set(options.state, {
				_tag: 'open',
				connectionId: connection.welcome.connection_id,
				protocol: connection.welcome.protocol,
				since: yield* Clock.currentTimeMillis
			});
			yield* options.onWelcome(connection.welcome);
			return connection;
		});

		const stop = (reason: 'revoked' | 'protocol-unsupported') =>
			Effect.gen(function* () {
				yield* SubscriptionRef.set(options.state, {
					_tag: 'stopped',
					reason,
					since: yield* Clock.currentTimeMillis
				});
				yield* Effect.logError('channel stopped').pipe(
					Effect.annotateLogs({ role: options.role, reason })
				);
				return yield* Effect.never;
			});

		let attempt = 0;
		let current: Connection | null = null;
		while (true) {
			if (current === null) {
				yield* SubscriptionRef.set(options.state, {
					_tag: 'connecting',
					attempt,
					since: yield* Clock.currentTimeMillis
				});
				current = yield* open();
				if (current === null) {
					yield* Effect.sleep(Duration.millis(redialDelayMillis(attempt, yield* Random.next)));
					attempt += 1;
					continue;
				}
				attempt = 0;
			}
			const connection: Connection = current;
			const now = yield* Clock.currentTimeMillis;
			const redialIn = Math.max(
				0,
				connection.welcome.authenticated_until - channelLimits.redialBeforeSeconds * 1000 - now
			);
			const outcome = yield* Effect.raceFirst(
				Deferred.await(connection.closed).pipe(
					Effect.map((code) => ({ _tag: 'closed' as const, code }))
				),
				Effect.sleep(Duration.millis(redialIn)).pipe(Effect.as({ _tag: 'redial' as const }))
			);
			if (outcome._tag === 'redial') {
				// Make before break: the platform replaces the old connection (4409) once the new one is accepted.
				const next = yield* open();
				if (next !== null) {
					yield* Scope.close(connection.scope, Exit.void);
					current = next;
				} else {
					// Keep the old one until its credential expires; try again soon.
					yield* Effect.sleep(Duration.seconds(channelReconnect.initialSeconds * 5));
				}
				continue;
			}
			yield* Scope.close(connection.scope, Exit.void);
			current = null;
			yield* Effect.logWarning('channel closed').pipe(
				Effect.annotateLogs({ role: options.role, code: outcome.code })
			);
			if (outcome.code === ChannelCloseCode.revoked) return yield* stop('revoked');
			if (outcome.code === ChannelCloseCode.protocolUnsupported)
				return yield* stop('protocol-unsupported');
			if (outcome.code === ChannelCloseCode.unauthenticated) yield* credentials.invalidate;
			const delay =
				outcome.code === ChannelCloseCode.replaced
					? channelReconnect.maxReconnectSeconds * 1000
					: redialDelayMillis(attempt, yield* Random.next);
			yield* Effect.sleep(Duration.millis(delay));
			attempt += 1;
		}
	}).pipe(Effect.scoped);
