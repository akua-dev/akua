import { Context, Effect, FileSystem, Layer, Redacted, Ref } from 'effect';
import type { DesiredPlacement } from '@platform/api-contract/services/cluster-agent';
import { AgentConfig, type AgentSettings, PlatformOrigin } from '../config';
import { engineLayer } from '../engine';
import { GitSource, type SourceFile } from '../git-source';
import { agentCredentialsLive, agentIdentityLive } from '../identity';
import { LiveStatus } from '../live-status';
import {
	DesiredRevision,
	DesiredSignal,
	placementReconcilerLayer,
	ReservedNames,
	WatchSet
} from '../reconciler';
import { fakeEngineLayer } from './fake-engine';
import {
	fakeKubernetesLayer,
	type FakeKubernetesState,
	fakeKubernetesState
} from './fake-kubernetes';
import {
	fakeAgentApi,
	fakePlatformCore,
	type FakePlatformState,
	fakePlatformState,
	placementId
} from './fake-platform';
import { testEnrollmentCode, testSettings } from './settings';

/** The repository content each revision serves. */
export class FakeGit extends Context.Service<
	FakeGit,
	{ readonly revisions: Ref.Ref<ReadonlyMap<string, ReadonlyArray<SourceFile>>> }
>()('akua/cluster-agent/testing/FakeGit') {}

const textEncoder = new TextEncoder();
export const file = (path: string, content: string): SourceFile => ({
	path,
	content: textEncoder.encode(content)
});

export const revisionA = 'a'.repeat(40);
export const revisionB = 'b'.repeat(40);

const fakeGitLayer = (revisions: ReadonlyMap<string, ReadonlyArray<SourceFile>>) =>
	Layer.effectContext(
		Effect.gen(function* () {
			const ref = yield* Ref.make(revisions);
			const git = GitSource.of({
				fetchManifests: (args) =>
					Ref.get(ref).pipe(Effect.map((all) => all.get(args.revision) ?? []))
			});
			return Context.make(GitSource, git).pipe(
				Context.add(FakeGit, FakeGit.of({ revisions: ref }))
			);
		})
	);

/** The whole agent against in-memory platform, kube-apiserver, git and engine. */
export const agentHarness = (
	options: {
		readonly settings?: AgentSettings;
		readonly platform?: FakePlatformState;
		readonly kubernetes?: FakeKubernetesState;
		readonly revisions?: ReadonlyMap<string, ReadonlyArray<SourceFile>>;
	} = {}
) => {
	const settings = options.settings ?? testSettings();
	const base = Layer.mergeAll(
		Layer.succeed(AgentConfig, AgentConfig.of(settings)),
		Layer.succeed(PlatformOrigin, settings.platformOrigin),
		fakeKubernetesLayer(options.kubernetes ?? fakeKubernetesState()),
		FileSystem.layerNoop({}),
		fakePlatformCore(options.platform ?? fakePlatformState({ enrollmentCode: testEnrollmentCode })),
		fakeGitLayer(options.revisions ?? new Map()),
		DesiredRevision.layer,
		DesiredSignal.layer,
		ReservedNames.layer
	);
	const engine = engineLayer({
		path: settings.enginePath,
		userAgent: 'akua-cluster-agent/test'
	}).pipe(Layer.provideMerge(fakeEngineLayer({ version: settings.release.version })));
	return placementReconcilerLayer.pipe(
		Layer.provideMerge(WatchSet.layer),
		Layer.provideMerge(LiveStatus.layer),
		Layer.provideMerge(fakeAgentApi),
		Layer.provideMerge(agentCredentialsLive),
		Layer.provideMerge(agentIdentityLive),
		Layer.provideMerge(engine),
		Layer.provideMerge(base)
	);
};

export const desiredPlacement = (
	overrides: Partial<typeof DesiredPlacement.Type> = {}
): typeof DesiredPlacement.Type => ({
	placement_id: placementId('app1'),
	namespace: 'app',
	generation: 1,
	presence: 'present',
	privileged: false,
	source: {
		url: new URL('https://git.akua.test/acme/r_app.git'),
		revision: revisionA,
		credential: Redacted.make('read-token'),
		credential_expires_at: 0
	},
	generated_secrets: [],
	secret_mounts: [],
	health_timeout_seconds: 300,
	reconcile_interval_seconds: 300,
	...overrides
});

export const configMap = (name: string, namespace?: string) =>
	`apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: ${name}\n${namespace === undefined ? '' : `  namespace: ${namespace}\n`}data:\n  key: value\n`;
