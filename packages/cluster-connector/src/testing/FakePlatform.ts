import { Context, Effect, Layer, Redacted, Ref, SubscriptionRef } from 'effect';
import { HttpServer } from 'effect/http';
import { HttpApiBuilder, HttpApiMiddleware, HttpApiTest } from 'effect/http-api';
import ids from '@platform/ids';
import { forbidden, gone, notFound, unauthorized } from '@platform/api-contract/errors';
import {
	ClusterConnectorAuthorization,
	ClusterConnectorApi,
	type DesiredState,
	type EnrollRequest,
	type PlacementReport,
	type PlacementSecrets,
	type StatusBatch,
	type UpdaterPhaseReport,
	type UpdaterInstruction,
	AuthenticatedClusterConnector,
	clusterConnectorPrincipal,
	ClusterUid
} from '@platform/api-contract/services/ClusterConnector';
import { WorkloadAssertion } from '@platform/api-contract/caller';
import {
	clusterConnectorAuthorizationClient,
	ClusterConnectorClient,
	ClusterConnectorIdentityClient
} from '../internal/ClusterConnectorClient';

type PlacementId = typeof ids.placement.prefixedEffect.Type;

/**
 * An in-memory platform behind the real ClusterConnectorApi contract, served
 * through HttpApiTest: the agent's typed clients encode, route and decode
 * exactly as against the real service.
 */
export interface FakePlatformState {
	readonly enrollmentCode: string | null;
	readonly enrollments: ReadonlyArray<typeof EnrollRequest.Type>;
	readonly enrolledClusterConnectorId: typeof ids.clusterAgent.prefixedEffect.Type;
	readonly tokensIssued: number;
	readonly reports: ReadonlyArray<{
		readonly placementId: PlacementId;
		readonly report: typeof PlacementReport.Type;
	}>;
	readonly statusBatches: ReadonlyArray<typeof StatusBatch.Type>;
	readonly snapshotRequired: ReadonlyArray<PlacementId>;
	readonly secrets: ReadonlyMap<PlacementId, typeof PlacementSecrets.Type>;
	readonly updaterPhases: ReadonlyArray<typeof UpdaterPhaseReport.Type>;
	readonly instruction: typeof UpdaterInstruction.Type;
	/** Fail the next N calls of these endpoints with 503-like errors. */
	readonly failing: ReadonlySet<'status' | 'report'>;
	/** While true every updater phase report fails, as during a platform outage. */
	readonly updaterDown: boolean;
	/** `desiredState` calls, each of which acknowledges the revision on the real platform. */
	readonly desiredFetches: number;
}

export class FakePlatform extends Context.Service<
	FakePlatform,
	{
		readonly state: Ref.Ref<FakePlatformState>;
		readonly desired: SubscriptionRef.SubscriptionRef<typeof DesiredState.Type>;
	}
>()('akua/cluster-connector/testing/FakePlatform') {}

export const fakeClusterConnectorId = ids.clusterAgent.prefixedEffect.make('cag_test');

const initialInstruction: typeof UpdaterInstruction.Type = {
	desired: null,
	verify_seconds: 300,
	observed: null
};

export const fakePlatformState = (
	overrides: Partial<FakePlatformState> = {}
): FakePlatformState => ({
	enrollmentCode: null,
	enrollments: [],
	enrolledClusterConnectorId: fakeClusterConnectorId,
	tokensIssued: 0,
	reports: [],
	statusBatches: [],
	snapshotRequired: [],
	secrets: new Map(),
	updaterPhases: [],
	instruction: initialInstruction,
	failing: new Set(),
	updaterDown: false,
	desiredFetches: 0,
	...overrides
});

const tokenPrefix = 'fake-workload-assertion-';

const AuthorizationServer = Layer.effect(
	ClusterConnectorAuthorization,
	Effect.gen(function* () {
		const platform = yield* FakePlatform;
		return ClusterConnectorAuthorization.of({
			bearer: Effect.fn(function* (httpEffect, { credential }) {
				const state = yield* Ref.get(platform.state);
				const token = Redacted.value(credential);
				const number = Number(token.slice(tokenPrefix.length));
				if (!token.startsWith(tokenPrefix) || !(number >= 1 && number <= state.tokensIssued)) {
					return yield* unauthorized('invalid workload assertion');
				}
				return yield* Effect.provideService(httpEffect, AuthenticatedClusterConnector, {
					agentId: state.enrolledClusterConnectorId,
					clusterUid: ClusterUid.make('00000000-0000-4000-8000-000000000001'),
					caller: { principal: clusterConnectorPrincipal(state.enrolledClusterConnectorId) }
				});
			})
		});
	})
);

const takeFailure = (platform: FakePlatform['Service'], endpoint: 'status' | 'report') =>
	Ref.modify(platform.state, (state) =>
		state.failing.has(endpoint)
			? [
					true,
					{ ...state, failing: new Set([...state.failing].filter((entry) => entry !== endpoint)) }
				]
			: [false, state]
	);

const IdentityHandlers = HttpApiBuilder.group(
	ClusterConnectorApi,
	'clusterConnectorIdentity',
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
						agent_id:
							payload._tag === 'federated' ? payload.agent_id : state.enrolledClusterConnectorId,
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

const ClusterConnectorHandlers = HttpApiBuilder.group(
	ClusterConnectorApi,
	'clusterConnector',
	Effect.fn(function* (handlers) {
		const platform = yield* FakePlatform;
		return handlers
			.handle('desiredState', () =>
				Ref.update(platform.state, (state) => ({
					...state,
					desiredFetches: state.desiredFetches + 1
				})).pipe(Effect.andThen(SubscriptionRef.get(platform.desired)))
			)
			.handle('updaterBundle', () =>
				Effect.map(SubscriptionRef.get(platform.desired), (desired) => ({
					placement:
						desired.placements.find(
							(placement) => placement.applier === 'updater' && placement.presence === 'present'
						) ?? null
				}))
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
			.handle('updaterPhase', ({ payload }) =>
				Effect.gen(function* () {
					if ((yield* Ref.get(platform.state)).updaterDown)
						return yield* forbidden('platform unavailable');
					const state = yield* Ref.updateAndGet(platform.state, (current) => ({
						...current,
						updaterPhases: [...current.updaterPhases, payload]
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
const anonymousClient = HttpApiMiddleware.layerClient(
	ClusterConnectorAuthorization,
	({ next, request }) => next(request)
);

/**
 * The fake platform, its handlers and the ClusterConnectorIdentityClient client. ClusterConnectorClient is
 * separate (`fakeClusterConnectorClient`) because, like the live client, it needs
 * ClusterConnectorCredentials, which in turn need ClusterConnectorIdentityClient.
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
	const handlers = Layer.mergeAll(IdentityHandlers, ClusterConnectorHandlers).pipe(
		Layer.provideMerge(AuthorizationServer),
		Layer.provideMerge(HttpServer.layerServices)
	);
	const identity = Layer.effect(
		ClusterConnectorIdentityClient,
		HttpApiTest.groups(ClusterConnectorApi, ['clusterConnectorIdentity']).pipe(
			Effect.map((client) => client.clusterConnectorIdentity),
			Effect.provide(anonymousClient)
		)
	);
	return identity.pipe(Layer.provideMerge(handlers), Layer.provideMerge(platform));
};

export const fakeClusterConnectorClient = Layer.effect(
	ClusterConnectorClient,
	HttpApiTest.groups(ClusterConnectorApi, ['clusterConnector']).pipe(
		Effect.map((client) => client.clusterConnector)
	)
).pipe(Layer.provide(clusterConnectorAuthorizationClient));

export const placementId = (suffix: string): PlacementId =>
	ids.placement.prefixedEffect.make(`plc_${suffix}`);
