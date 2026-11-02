import { Config, Context, Effect, Layer, Option, Schema } from 'effect';
import ids from '@platform/ids';
import {
	AgentImage,
	AgentRelease,
	EnrollmentCode
} from '@platform/api-contract/services/cluster-agent';
import { agentNamespace, Distribution, enginePath } from './contract';

/**
 * Everything the agent reads from its environment. The chart sets the
 * Deployment values; the release version and protocol come from the image
 * itself (its OCI config env), so an image patch alone changes them.
 */
export const EnrollmentSettings = Schema.Union([
	Schema.TaggedStruct('code', { code: Schema.NullOr(EnrollmentCode) }),
	Schema.TaggedStruct('federated', {
		agentId: ids.clusterAgent.prefixedEffect,
		tokenPath: Schema.NonEmptyString
	})
]);

export interface AgentSettings {
	readonly platformOrigin: URL;
	readonly release: typeof AgentRelease.Type;
	readonly enrollment: typeof EnrollmentSettings.Type;
	readonly distribution: Option.Option<typeof Distribution.Type>;
	readonly healthPort: number;
	readonly enginePath: string;
	readonly namespace: string;
}

export class AgentConfig extends Context.Service<AgentConfig, AgentSettings>()(
	'akua/cluster-agent/AgentConfig'
) {
	static readonly fromEnv = Effect.gen(function* () {
		const platformOrigin = yield* Config.URL('AKUA_PLATFORM_ORIGIN');
		const version = yield* Config.NonEmptyString('AKUA_AGENT_VERSION');
		const protocol = yield* Config.Int('AKUA_AGENT_PROTOCOL').pipe(Config.withDefault(1));
		const image = yield* Config.schema(AgentImage, 'AKUA_AGENT_IMAGE');
		const method = yield* Config.Literals(['code', 'federated'], 'AKUA_ENROLLMENT_METHOD').pipe(
			Config.withDefault('code' as const)
		);
		const enrollment: typeof EnrollmentSettings.Type =
			method === 'code'
				? {
						_tag: 'code',
						code: yield* Config.schema(EnrollmentCode, 'AKUA_ENROLLMENT_CODE').pipe(
							Config.option,
							Config.map(Option.getOrNull)
						)
					}
				: {
						_tag: 'federated',
						agentId: yield* Config.schema(ids.clusterAgent.prefixedEffect, 'AKUA_AGENT_ID'),
						tokenPath: yield* Config.NonEmptyString('AKUA_FEDERATED_TOKEN_PATH').pipe(
							Config.withDefault('/var/run/secrets/akua.dev/serviceaccount/token')
						)
					};
		const distribution = yield* Config.schema(Distribution, 'AKUA_DISTRIBUTION').pipe(
			Config.option
		);
		return AgentConfig.of({
			platformOrigin,
			release: { version, image, protocol },
			enrollment,
			distribution,
			healthPort: yield* Config.Port('AKUA_HEALTH_PORT').pipe(Config.withDefault(8080)),
			enginePath: yield* Config.NonEmptyString('AKUA_ENGINE_PATH').pipe(
				Config.withDefault(enginePath)
			),
			namespace: yield* Config.NonEmptyString('POD_NAMESPACE').pipe(
				Config.withDefault(agentNamespace)
			)
		});
	});

	static readonly layer = Layer.effect(AgentConfig, AgentConfig.fromEnv);
}

/** The platform's base URL; all the updater needs from the agent's settings. */
export class PlatformOrigin extends Context.Service<PlatformOrigin, URL>()(
	'akua/cluster-agent/PlatformOrigin'
) {
	static readonly fromEnv = Layer.effect(PlatformOrigin, Config.URL('AKUA_PLATFORM_ORIGIN'));
	static readonly fromConfig = Layer.effect(
		PlatformOrigin,
		Effect.gen(function* () {
			const config = yield* AgentConfig;
			return config.platformOrigin;
		})
	);
}
