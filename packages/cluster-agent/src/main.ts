import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import * as BunServices from '@effect/platform-bun/BunServices';
import * as BunSocket from '@effect/platform-bun/BunSocket';
import { Config, Effect, Layer, Option, Schedule, SubscriptionRef } from 'effect';
import { Command } from 'effect/cli';
import {
	AgentChannelRpcs,
	channelProtocol,
	UpdaterChannelRpcs
} from '@platform/api-contract/services/cluster-agent-channel';
import { agentRpcHandlers } from './agent-rpcs';
import { ChannelDialer, type ChannelState, runChannel } from './channel';
import { detectDistribution } from './cluster-reads';
import { AgentConfig, PlatformOrigin } from './config';
import { agentUserAgent, enginePath, updaterUserAgent } from './contract';
import { engineLayer, EngineStatus } from './engine';
import { GitSource } from './git-source';
import { healthServer } from './health';
import { AgentHttpClientLive } from './http';
import {
	agentCredentialsLive,
	agentIdentityLive,
	retryForever,
	updaterIdentityLive
} from './identity';
import { KubernetesConnection, KubernetesExtras, kubernetesLayer } from './kubernetes';
import { LiveStatus } from './live-status';
import { agentApiLive, identityApiLive } from './platform';
import {
	DesiredRevision,
	DesiredSignal,
	desiredStateLoop,
	placementReconcilerLayer,
	ReservedNames,
	WatchSet
} from './reconciler';
import {
	agentUpdaterLayer,
	UpdaterInstructions,
	UpdaterKubernetes,
	updaterLoop,
	updaterRpcHandlers
} from './updater';
import { KubernetesApi } from './contract';
import { UpdaterRollout, updaterRolloutLoop } from './updater-rollout';

const arch = process.arch === 'x64' ? 'amd64' : process.arch;

/**
 * The User-Agent needs the server version and distribution, so one
 * bootstrap read runs on a provisional client before the real layers.
 */
const agentUserAgentLayer = Layer.unwrap(
	Effect.gen(function* () {
		const config = yield* AgentConfig;
		const provisional = `akua-cluster-agent/${config.release.version} (other; k8s unknown; ${arch})`;
		const probe = Effect.gen(function* () {
			const extras = yield* KubernetesExtras;
			const kubernetes = yield* KubernetesApi;
			const gitVersion = yield* extras.readVersion();
			const { nodes } = yield* kubernetes.listNodes({ limit: 500, continue: null });
			return {
				gitVersion,
				distribution: Option.getOrElse(config.distribution, () =>
					detectDistribution(gitVersion, nodes)
				)
			};
		}).pipe(
			Effect.provide(kubernetesLayer.pipe(Layer.provide(AgentHttpClientLive(provisional)))),
			Effect.retry(retryForever),
			Effect.orDie
		);
		const { gitVersion, distribution } = yield* probe;
		return AgentHttpClientLive(
			agentUserAgent({
				version: config.release.version,
				distribution,
				kubernetesVersion: gitVersion,
				arch
			})
		);
	})
);

const agentLayer = Layer.unwrap(
	Effect.gen(function* () {
		const config = yield* AgentConfig;
		const userAgent = `akua-cluster-agent/${config.release.version} (${Option.getOrElse(config.distribution, () => 'other')}; ${arch})`;
		const http = agentUserAgentLayer;
		const kubernetes = kubernetesLayer.pipe(Layer.provide(http));
		const engine = engineLayer({ path: config.enginePath, userAgent });
		const health = Layer.unwrap(
			Effect.gen(function* () {
				const status = yield* EngineStatus;
				const ready = SubscriptionRef.get(status.state).pipe(
					Effect.map((state) => state.phase === 'ready' && state.version === config.release.version)
				);
				return healthServer(config.healthPort, ready);
			})
		).pipe(Layer.provide(engine));
		const identityApi = identityApiLive.pipe(Layer.provide(http));
		const identity = agentIdentityLive.pipe(Layer.provide(Layer.mergeAll(kubernetes, identityApi)));
		const credentials = agentCredentialsLive.pipe(
			Layer.provide(Layer.mergeAll(identity, identityApi))
		);
		const agentApi = agentApiLive.pipe(Layer.provide(Layer.mergeAll(http, credentials)));
		const state = Layer.mergeAll(DesiredRevision.layer, DesiredSignal.layer, ReservedNames.layer);
		const live = LiveStatus.layer.pipe(Layer.provide(Layer.mergeAll(engine, agentApi, state)));
		const watchSet = WatchSet.layer.pipe(Layer.provide(Layer.mergeAll(engine, live)));
		const git = GitSource.layer.pipe(Layer.provide(http));
		const reconciler = placementReconcilerLayer.pipe(
			Layer.provide(Layer.mergeAll(kubernetes, engine, git, agentApi, state, watchSet, live))
		);
		const rpcs = agentRpcHandlers.pipe(Layer.provide(Layer.mergeAll(kubernetes, live, state)));
		// The updater's own objects; the updater applies everything else (never both at once).
		const rollout = UpdaterRollout.layer.pipe(
			Layer.provide(Layer.mergeAll(kubernetes, engine, agentApi, git))
		);
		const dialer = ChannelDialer.layer.pipe(Layer.provide(BunSocket.layerWebSocketConstructor));
		const loops = Layer.effectDiscard(
			Effect.gen(function* () {
				const kubernetesApi = yield* KubernetesApi;
				const revision = yield* DesiredRevision;
				const signal = yield* DesiredSignal;
				const status = yield* LiveStatus;
				const channelState = yield* SubscriptionRef.make<ChannelState>({
					_tag: 'connecting',
					attempt: 0,
					since: 0
				});
				const hello = Effect.gen(function* () {
					const clusterUid = yield* kubernetesApi
						.readClusterUid()
						.pipe(Effect.retry(retryForever), Effect.orDie);
					return {
						_tag: 'agent' as const,
						protocol: channelProtocol,
						release: config.release,
						cluster_uid: clusterUid,
						serves: [...AgentChannelRpcs.requests.keys()],
						desired_revision: yield* revision.get
					};
				});
				yield* Effect.forkScoped(desiredStateLoop);
				yield* Effect.forkScoped(updaterRolloutLoop(config.release));
				yield* Effect.forkScoped(
					runChannel({
						role: 'agent',
						group: AgentChannelRpcs,
						handlers: rpcs,
						hello,
						state: channelState,
						onWelcome: (welcome) =>
							Effect.gen(function* () {
								if (welcome.desired_revision !== null)
									yield* signal.announce(welcome.desired_revision);
								if (welcome.subscriptions !== null)
									yield* status.subscribe(welcome.subscriptions.status);
							})
					})
				);
				yield* Effect.logInfo('agent running').pipe(
					Effect.annotateLogs({ version: config.release.version })
				);
			})
		).pipe(
			Layer.provide(
				Layer.mergeAll(reconciler, agentApi, kubernetes, state, live, credentials, dialer, rollout)
			)
		);
		return Layer.mergeAll(health, loops);
	})
).pipe(
	Layer.provide(Layer.mergeAll(KubernetesConnection.inCluster, PlatformOrigin.fromConfig)),
	Layer.provideMerge(AgentConfig.layer)
);

const updaterLayer = Layer.unwrap(
	Effect.gen(function* () {
		const version = yield* Config.NonEmptyString('AKUA_AGENT_VERSION');
		const port = yield* Config.Port('AKUA_HEALTH_PORT').pipe(Config.withDefault(8081));
		const http = AgentHttpClientLive(updaterUserAgent(version));
		const kubernetes = kubernetesLayer.pipe(Layer.provide(http));
		const identityApi = identityApiLive.pipe(Layer.provide(http));
		const identity = updaterIdentityLive.pipe(Layer.provide(kubernetes));
		const credentials = agentCredentialsLive.pipe(
			Layer.provide(Layer.mergeAll(identity, identityApi))
		);
		const agentApi = agentApiLive.pipe(Layer.provide(Layer.mergeAll(http, credentials)));
		const deployment = UpdaterKubernetes.layer.pipe(Layer.provide(http));
		// Its own engine process: the agent may be the broken part.
		const engine = engineLayer({ path: enginePath, userAgent: updaterUserAgent(version) });
		const git = GitSource.layer.pipe(Layer.provide(http));
		const updater = agentUpdaterLayer.pipe(
			Layer.provide(Layer.mergeAll(deployment, kubernetes, engine, git, agentApi))
		);
		const instructions = UpdaterInstructions.layer;
		const rpcs = updaterRpcHandlers.pipe(Layer.provide(instructions));
		const dialer = ChannelDialer.layer.pipe(Layer.provide(BunSocket.layerWebSocketConstructor));
		const loop = Layer.effectDiscard(
			Effect.gen(function* () {
				const kubernetesApi = yield* KubernetesApi;
				const { channel } = yield* UpdaterInstructions;
				// Its own connection, so the updater stays reachable when the agent is broken.
				yield* Effect.forkScoped(
					runChannel({
						role: 'updater',
						group: UpdaterChannelRpcs,
						handlers: rpcs,
						state: channel,
						hello: kubernetesApi.readClusterUid().pipe(
							Effect.retry(retryForever),
							Effect.orDie,
							Effect.map((clusterUid) => ({
								_tag: 'updater' as const,
								protocol: channelProtocol,
								updater_version: version,
								cluster_uid: clusterUid,
								serves: [...UpdaterChannelRpcs.requests.keys()]
							}))
						),
						onWelcome: () => Effect.void
					})
				);
				yield* Effect.forkScoped(
					updaterLoop(version).pipe(Effect.retry(Schedule.spaced('15 seconds')))
				);
			})
		).pipe(
			Layer.provide(
				Layer.mergeAll(agentApi, updater, deployment, instructions, kubernetes, credentials, dialer)
			)
		);
		// `/readyz` is the updater Deployment's readiness probe, part of the agent's gate for it.
		const health = healthServer(
			port,
			UpdaterInstructions.use(({ ready }) => SubscriptionRef.get(ready))
		).pipe(Layer.provide(instructions));
		return Layer.mergeAll(health, loop);
	})
).pipe(Layer.provide(Layer.mergeAll(KubernetesConnection.inCluster, PlatformOrigin.fromEnv)));

const agentCommand = Command.make('agent', {}, () => Layer.launch(agentLayer)).pipe(
	Command.withDescription('Run the Akua cluster agent')
);

const updaterCommand = Command.make('updater', {}, () => Layer.launch(updaterLayer)).pipe(
	Command.withDescription('Run the Akua agent updater')
);

Command.make('akua-cluster-agent').pipe(
	Command.withSubcommands([agentCommand, updaterCommand]),
	Command.run({ version: '0.0.1' }),
	Effect.provide(BunServices.layer),
	BunRuntime.runMain
);
