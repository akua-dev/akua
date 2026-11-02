import { Context, Schema } from 'effect';
import type { Effect, Option } from 'effect';
import type { RpcClient, RpcClientError, RpcGroup } from 'effect/rpc';
import { ConnectionId } from '@platform/api-contract/services/cluster-agent-channel';
import type { PlatformChannelRpcs } from '@platform/api-contract/services/cluster-agent-channel';

/**
 * Proposal (CEP-0051): the agent's side of the control channel. One fiber
 * keeps one WebSocket to `wss://<platform>/v1/agent/connect` open:
 *
 * 1. Take a fresh assertion from AgentCredentials and dial with
 *    `Socket.makeWebSocket(url, { headers: { authorization } })`, a new
 *    Socket per attempt so the bearer is never stale (the RpcClient socket
 *    protocol's own retry would reuse the first headers). Bun's WebSocket
 *    honours `headers` and the HTTPS proxy settings the HTTP client uses.
 * 2. Build server and client Protocols on the socket (`MakeChannelProtocols`),
 *    serve AgentChannelRpcs, call `Hello.v1`, then `Authenticate.v1`
 *    `reauthenticateBeforeSeconds` before each `authenticated_until`.
 * 3. Welcome `desired_revision` above the agent's: fetch desired state over
 *    HTTP now. `DesiredChanged.v1` does the same later.
 * 4. Heartbeat and StatusBatch go through `Heartbeat.v1` and
 *    `ReportStatus.v1` while open, over HTTP otherwise; the `desiredState`
 *    long poll runs only while the channel is not open.
 * 5. On close: reconnect per `channelReconnect` and `ChannelCloseCode`;
 *    after `failuresBeforeHttpFallback` failed upgrades, HTTP only for
 *    `httpFallbackSeconds`. A Worker deploy may drop the socket; that is a
 *    normal reconnect.
 */

/** The channel URL on the platform origin the agent enrolled with. */
export const channelUrl = (platformOrigin: URL): URL => {
	const url = new URL('/v1/agent/connect', platformOrigin);
	url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
	return url;
};

export const ChannelState = Schema.Union([
	Schema.TaggedStruct('connecting', { attempt: Schema.Int, since: Schema.Finite }),
	Schema.TaggedStruct('open', {
		connectionId: ConnectionId,
		protocol: Schema.Int,
		since: Schema.Finite
	}),
	/** Upgrades kept failing (proxy, firewall); HTTP only until `until`. */
	Schema.TaggedStruct('http-fallback', { until: Schema.Finite }),
	/** 4403 revoked or 4426 protocol unsupported: no more attempts by this process. */
	Schema.TaggedStruct('stopped', {
		reason: Schema.Literals(['revoked', 'protocol-unsupported']),
		since: Schema.Finite
	})
]);

export type PlatformChannelClient = RpcClient.RpcClient<
	RpcGroup.Rpcs<typeof PlatformChannelRpcs>,
	RpcClientError.RpcClientError
>;

/**
 * Owned by the agent's main layer. Heartbeat and live-status loops ask
 * `client` per send and fall back to AgentApi when it is none.
 */
export class PlatformChannel extends Context.Service<
	PlatformChannel,
	{
		/** The connect loop above; runs for the agent's lifetime. */
		readonly run: Effect.Effect<never>;
		readonly state: Effect.Effect<typeof ChannelState.Type>;
		/** The PlatformChannelRpcs client of the open connection, none otherwise. */
		readonly client: Effect.Effect<Option.Option<PlatformChannelClient>>;
	}
>()('akua/cluster-agent/PlatformChannel') {}
