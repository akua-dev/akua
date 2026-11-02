import {
	Context,
	Duration,
	Effect,
	Layer,
	Option,
	Redacted,
	Ref,
	Stream,
	SubscriptionRef
} from 'effect';
import { HttpServer } from 'effect/http';
import { HttpApiBuilder, HttpApiMiddleware, HttpApiTest } from 'effect/http-api';
import ids from '@platform/ids';
import { forbidden, gone, notFound, unauthorized } from '@platform/api-contract/errors';
import {
	AgentAuthorization,
	ClusterAgentApi,
	type DesiredState,
	type EnrollRequest,
	type Heartbeat,
	type PlacementReport,
	type PlacementSecrets,
	type StatusBatch,
	type UpdaterHeartbeat,
	type UpdaterInstruction,
	AuthenticatedAgent,
	clusterAgentPrincipal,
	ClusterUid
} from '@platform/api-contract/services/cluster-agent';
import { WorkloadAssertion } from '@platform/api-contract/caller';
import { agentAuthorizationClient, AgentApi, IdentityApi } from '../platform';

type PlacementId = typeof ids.placement.prefixedEffect.Type;

/**
 * An in-memory platform behind the real ClusterAgentApi contract, served
 * through HttpApiTest: the agent's typed clients encode, route and decode
 * exactly as against the real service.
 */
export interface FakePlatformState {
	readonly enrollmentCode: string | null;
	readonly enrollments: ReadonlyArray<typeof EnrollRequest.Type>;
	readonly enrolledAgentId: typeof ids.clusterAgent.prefixedEffect.Type;
	readonly tokensIssued: number;
	readonly heartbeats: ReadonlyArray<typeof Heartbeat.Type>;
	readonly reports: ReadonlyArray<{
		readonly placementId: PlacementId;
		readonly report: typeof PlacementReport.Type;
	}>;
	readonly statusBatches: ReadonlyArray<typeof StatusBatch.Type>;
	readonly snapshotRequired: ReadonlyArray<PlacementId>;
	readonly secrets: ReadonlyMap<PlacementId, typeof PlacementSecrets.Type>;
	readonly updaterHeartbeats: ReadonlyArray<typeof UpdaterHeartbeat.Type>;
	readonly instruction: typeof UpdaterInstruction.Type;
	/** Fail the next N calls of these endpoints with 503-like errors. */
	readonly failing: ReadonlySet<'status' | 'report' | 'heartbeat'>;
	/** While true every updater heartbeat fails, as during a platform outage. */
	readonly updaterDown: boolean;
}

export class FakePlatform extends Context.Service<
	FakePlatform,
	{
		readonly state: Ref.Ref<FakePlatformState>;
		readonly desired: SubscriptionRef.SubscriptionRef<typeof DesiredState.Type>;
	}
>()('akua/cluster-agent/testing/FakePlatform') {}

export const fakeAgentId = ids.clusterAgent.prefixedEffect.make('cag_test');

const initialInstruction: typeof UpdaterInstruction.Type = {
	desired: null,
	verify_seconds: 300,
	observed: null,
	next_heartbeat_seconds: 60
};

export const fakePlatformState = (
	overrides: Partial<FakePlatformState> = {}
): FakePlatformState => ({
	enrollmentCode: null,
	enrollments: [],
	enrolledAgentId: fakeAgentId,
	tokensIssued: 0,
	heartbeats: [],
	reports: [],
	statusBatches: [],
	snapshotRequired: [],
	secrets: new Map(),
	updaterHeartbeats: [],
	instruction: initialInstruction,
	failing: new Set(),
	updaterDown: false,
	...overrides
});

const tokenPrefix = 'fake-workload-assertion-';

const AuthorizationServer = Layer.effect(
	AgentAuthorization,
	Effect.gen(function* () {
		const platform = yield* FakePlatform;
		return AgentAuthorization.of({
			bearer: Effect.fn(function* (httpEffect, { credential }) {
				const state = yield* Ref.get(platform.state);
				const token = Redacted.value(credential);
				const number = Number(token.slice(tokenPrefix.length));
				if (!token.startsWith(tokenPrefix) || !(number >= 1 && number <= state.tokensIssued)) {
					return yield* unauthorized('invalid workload assertion');
				}
				return yield* Effect.provideService(httpEffect, AuthenticatedAgent, {
					agentId: state.enrolledAgentId,
					clusterUid: ClusterUid.make('00000000-0000-4000-8000-000000000001'),
					caller: { principal: clusterAgentPrincipal(state.enrolledAgentId) }
				});
			})
		});
	})
);

const takeFailure = (
	platform: FakePlatform['Service'],
	endpoint: 'status' | 'report' | 'heartbeat'
) =>
	Ref.modify(platform.state, (state) =>
		state.failing.has(endpoint)
			? [
					true,
					{ ...state, failing: new Set([...state.failing].filter((entry) => entry !== endpoint)) }
				]
			: [false, state]
	);

const IdentityHandlers = HttpApiBuilder.group(
	ClusterAgentApi,
	'agentIdentity',
	Effect.fn(function* (handlers) {
		const platform = yield* FakePlatform;
		return handlers
			.handle('enroll', ({ payload }) =>
				Effect.gen(function* () {
					const state = yield* Ref.get(platform.state);
					if (payload._tag === 'code') {
						if (
							state.enrollmentCode === null ||
							Redacted.value(payload.code) !== state.enrollmentCode
						) {
							return yield* gone('enrollment code used or unknown');
						}
					}
					yield* Ref.update(platform.state, (current) => ({
						...current,
						enrollmentCode: payload._tag === 'code' ? null : current.enrollmentCode,
						enrollments: [...current.enrollments, payload]
					}));
					return {
						agent_id: payload._tag === 'federated' ? payload.agent_id : state.enrolledAgentId,
						platform_origin: new URL('https://api.akua.test'),
						git_origin: new URL('https://git.akua.test')
					};
				})
			)
			.handle('token', () =>
				Effect.gen(function* () {
					const state = yield* Ref.updateAndGet(platform.state, (current) => ({
						...current,
						tokensIssued: current.tokensIssued + 1
					}));
					return {
						assertion: WorkloadAssertion.make(Redacted.make(`${tokenPrefix}${state.tokensIssued}`)),
						expires_at: 600
					};
				})
			)
			.handle('rotateKey', () => Effect.void);
	})
);

const AgentHandlers = HttpApiBuilder.group(
	ClusterAgentApi,
	'agent',
	Effect.fn(function* (handlers) {
		const platform = yield* FakePlatform;
		return handlers
			.handle('heartbeat', ({ payload }) =>
				Effect.gen(function* () {
					if (yield* takeFailure(platform, 'heartbeat'))
						return yield* forbidden('heartbeat refused');
					yield* Ref.update(platform.state, (state) => ({
						...state,
						heartbeats: [...state.heartbeats, payload]
					}));
					return { next_heartbeat_seconds: 30 };
				})
			)
			.handle('desiredState', ({ query }) =>
				Effect.gen(function* () {
					const after = query.after ?? -1;
					const next = yield* SubscriptionRef.changes(platform.desired).pipe(
						Stream.filter((state) => state.revision > after),
						Stream.runHead,
						Effect.timeoutOption(Duration.seconds(55))
					);
					return Option.isSome(next) && Option.isSome(next.value)
						? next.value.value
						: yield* SubscriptionRef.get(platform.desired);
				})
			)
			.handle('report', ({ params, payload }) =>
				Effect.gen(function* () {
					if (yield* takeFailure(platform, 'report')) return yield* notFound('placement unknown');
					yield* Ref.update(platform.state, (state) => ({
						...state,
						reports: [...state.reports, { placementId: params.placement_id, report: payload }]
					}));
				})
			)
			.handle('placementSecrets', ({ params }) =>
				Effect.gen(function* () {
					const state = yield* Ref.get(platform.state);
					const secrets = state.secrets.get(params.placement_id);
					if (secrets === undefined) return yield* notFound('no secrets');
					return secrets;
				})
			)
			.handle('originCredential', () => notFound('no origin'))
			.handle('status', ({ payload }) =>
				Effect.gen(function* () {
					if (yield* takeFailure(platform, 'status')) return yield* forbidden('status refused');
					const required = yield* Ref.modify(platform.state, (state) => [
						state.snapshotRequired,
						{
							...state,
							statusBatches: [...state.statusBatches, payload],
							snapshotRequired: []
						}
					]);
					return { snapshot_required: required };
				})
			)
			.handle('updaterHeartbeat', ({ payload }) =>
				Effect.gen(function* () {
					if ((yield* Ref.get(platform.state)).updaterDown)
						return yield* forbidden('platform unavailable');
					const state = yield* Ref.updateAndGet(platform.state, (current) => ({
						...current,
						updaterHeartbeats: [...current.updaterHeartbeats, payload]
					}));
					return state.instruction;
				})
			);
	})
);

export const emptyDesiredState = (
	revision: number,
	placements: (typeof DesiredState.Type)['placements'] = []
): typeof DesiredState.Type => ({
	target_id: ids.placementTarget.prefixedEffect.make('ptg_test'),
	revision,
	reserved: { namespaces: ['akua-system', 'kube-system'], names: [] },
	placements
});

/** No client middleware for the identity group, which carries no bearer. */
const anonymousClient = HttpApiMiddleware.layerClient(AgentAuthorization, ({ next, request }) =>
	next(request)
);

/**
 * The fake platform, its handlers and the IdentityApi client. AgentApi is
 * separate (`fakeAgentApi`) because, like the live client, it needs
 * AgentCredentials, which in turn need IdentityApi.
 */
export const fakePlatformCore = (initial: FakePlatformState = fakePlatformState()) => {
	const platform = Layer.effect(
		FakePlatform,
		Effect.gen(function* () {
			return FakePlatform.of({
				state: yield* Ref.make(initial),
				desired: yield* SubscriptionRef.make(emptyDesiredState(0))
			});
		})
	);
	const handlers = Layer.mergeAll(IdentityHandlers, AgentHandlers).pipe(
		Layer.provideMerge(AuthorizationServer),
		Layer.provideMerge(HttpServer.layerServices)
	);
	const identity = Layer.effect(
		IdentityApi,
		HttpApiTest.groups(ClusterAgentApi, ['agentIdentity']).pipe(
			Effect.map((client) => client.agentIdentity),
			Effect.provide(anonymousClient)
		)
	);
	return identity.pipe(Layer.provideMerge(handlers), Layer.provideMerge(platform));
};

export const fakeAgentApi = Layer.effect(
	AgentApi,
	HttpApiTest.groups(ClusterAgentApi, ['agent']).pipe(Effect.map((client) => client.agent))
).pipe(Layer.provide(agentAuthorizationClient));

export const placementId = (suffix: string): PlacementId =>
	ids.placement.prefixedEffect.make(`plc_${suffix}`);
