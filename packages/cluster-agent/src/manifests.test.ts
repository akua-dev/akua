import { assert, describe, it } from '@effect/vitest';
import { Effect, Result } from 'effect';
import { Base64 } from 'effect/encoding';
import { ApplySetId } from './contract';
import {
	applySetParentName,
	buildParent,
	computeApplySetId,
	groupKinds,
	inventoryOf,
	staleEntries
} from './applyset';
import { generateSecretValue, parseManifests, planObjects, reservedViolation } from './manifests';
import { detectDistribution, trimNode } from './cluster-reads';
import { defaultDiscovery } from './testing/fake-kubernetes';
import { file } from './testing/agent-harness';
import { placementId } from './testing/fake-platform';

const applySetId = ApplySetId.make('applyset-brQkXe5Pe9UmfaeYPyxQ7LIYrYXGiW2_cKu6tsvX3FI-v1');

const plan = (yaml: string) => {
	const parsed = parseManifests([file('m.yaml', yaml)]);
	if (Result.isFailure(parsed)) throw parsed.failure;
	return planObjects({
		manifests: parsed.success,
		namespace: 'app',
		applySetId,
		discovery: defaultDiscovery
	});
};

describe('ApplySet', () => {
	it.effect('computes the kubectl ID for the parent Secret', () =>
		Effect.gen(function* () {
			assert.strictEqual(applySetParentName(placementId('abc')), 'akua-applyset-plc-abc');
			const id = yield* computeApplySetId({ name: 'akua-applyset-plc-abc', namespace: 'app' });
			assert.strictEqual(id, applySetId);
		})
	);

	it('round-trips the inventory and writes kubectl annotations', () => {
		const inventory = [
			{ key: 'app_web_apps_Deployment', version: 'v1' },
			{ key: 'other_cfg__ConfigMap', version: 'v1' },
			{ key: '_viewer_rbac.authorization.k8s.io_ClusterRole', version: 'v1' }
		];
		const parent = buildParent({
			placementId: placementId('abc'),
			namespace: 'app',
			applySetId,
			agentVersion: '1.0.0',
			inventory
		});
		assert.deepStrictEqual(inventoryOf(parent), inventory);
		assert.strictEqual(
			parent.metadata?.annotations?.['applyset.kubernetes.io/tooling'],
			'akua-agent/1.0.0'
		);
		assert.strictEqual(
			parent.metadata?.annotations?.['applyset.kubernetes.io/contains-group-kinds'],
			'ClusterRole.rbac.authorization.k8s.io,ConfigMap,Deployment.apps'
		);
		assert.strictEqual(
			parent.metadata?.annotations?.['applyset.kubernetes.io/additional-namespaces'],
			'other'
		);
		assert.strictEqual(groupKinds([]), '');
	});

	it('treats a corrupt inventory as unreadable, not empty', () => {
		assert.isNull(
			inventoryOf({ apiVersion: 'v1', kind: 'Secret', data: { inventory: Base64.encode('{nope') } })
		);
	});

	it('computes stale members as previous minus current', () => {
		const a = { key: 'app_a__ConfigMap', version: 'v1' };
		const b = { key: 'app_b__ConfigMap', version: 'v1' };
		assert.deepStrictEqual(staleEntries([a, b], [b]), [a]);
	});
});

describe('planObjects', () => {
	it('defaults namespaces from discovery, drops them from cluster-scoped kinds and labels members', () => {
		const planned = plan(
			[
				'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: a',
				'apiVersion: rbac.authorization.k8s.io/v1\nkind: ClusterRole\nmetadata:\n  name: viewer\n  namespace: wrong',
				'apiVersion: v1\nkind: List\nitems:\n  - apiVersion: v1\n    kind: Service\n    metadata:\n      name: web\n      namespace: other'
			].join('\n---\n')
		);
		assert.isTrue(Result.isSuccess(planned));
		if (Result.isFailure(planned)) return;
		assert.deepStrictEqual(
			planned.success.map((object) => object.key),
			['app_a__ConfigMap', '_viewer_rbac.authorization.k8s.io_ClusterRole', 'other_web__Service']
		);
		assert.deepStrictEqual(planned.success[1]?.manifest.metadata, {
			name: 'viewer',
			labels: { 'applyset.kubernetes.io/part-of': applySetId }
		});
	});

	it('takes the scope of a custom kind from a CRD in the same batch', () => {
		const planned = plan(
			[
				'apiVersion: apiextensions.k8s.io/v1\nkind: CustomResourceDefinition\nmetadata:\n  name: issuers.example.com\nspec:\n  group: example.com\n  scope: Cluster\n  names:\n    kind: ClusterIssuer\n    plural: clusterissuers',
				'apiVersion: example.com/v1\nkind: ClusterIssuer\nmetadata:\n  name: letsencrypt'
			].join('\n---\n')
		);
		if (Result.isFailure(planned)) throw planned.failure;
		assert.strictEqual(planned.success[1]?.key, '_letsencrypt_example.com_ClusterIssuer');
		assert.strictEqual(planned.success[1]?.resource, 'clusterissuers');
	});

	it('rejects duplicates and objects without a name', () => {
		assert.isTrue(
			Result.isFailure(
				plan(
					'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: a\n---\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: a'
				)
			)
		);
		assert.isTrue(Result.isFailure(plan('apiVersion: v1\nkind: ConfigMap\nmetadata: {}')));
	});

	it('finds the first reserved object', () => {
		const planned = plan(
			'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: a\n---\napiVersion: rbac.authorization.k8s.io/v1\nkind: ClusterRole\nmetadata:\n  name: akua'
		);
		if (Result.isFailure(planned)) throw planned.failure;
		const reserved = {
			namespaces: ['akua-system'],
			names: [{ group: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: 'akua' }]
		};
		assert.strictEqual(
			reservedViolation(planned.success, reserved)?.key,
			'_akua_rbac.authorization.k8s.io_ClusterRole'
		);
		assert.isNull(reservedViolation(planned.success.slice(0, 1), reserved));
	});
});

describe('generated values', () => {
	it('produces values of the requested length and alphabet', () => {
		assert.match(generateSecretValue(40, 'alphanumeric'), /^[A-Za-z0-9]{40}$/);
		assert.match(generateSecretValue(24, 'hex'), /^[0-9a-f]{24}$/);
		assert.match(generateSecretValue(32, 'base64url'), /^[A-Za-z0-9_-]{32}$/);
	});
});

describe('cluster read helpers', () => {
	it('detects the distribution from the server version and node labels', () => {
		assert.strictEqual(detectDistribution('v1.34.1+k0s', []), 'k0s');
		assert.strictEqual(detectDistribution('v1.33.2+k3s1', []), 'k3s');
		assert.strictEqual(detectDistribution('v1.32.3-eks-4096722', []), 'eks');
		assert.strictEqual(detectDistribution('v1.32.4-gke.1415000', []), 'gke');
		assert.strictEqual(
			detectDistribution('v1.32.0', [
				{
					apiVersion: 'v1',
					kind: 'Node',
					metadata: { labels: { 'kubernetes.azure.com/cluster': 'x' } }
				}
			]),
			'aks'
		);
		assert.strictEqual(detectDistribution('v1.32.0', []), 'other');
	});

	it('trims nodes to name, labels, conditions and nodeInfo', () => {
		const trimmed = trimNode({
			apiVersion: 'v1',
			kind: 'Node',
			metadata: { name: 'n1', labels: { a: 'b' }, annotations: { secret: 'x' }, uid: 'u' },
			spec: { podCIDR: '10.0.0.0/24' },
			status: {
				conditions: [{ type: 'Ready', status: 'True' }],
				addresses: [{ type: 'InternalIP', address: '10.0.0.1' }]
			}
		});
		assert.deepStrictEqual(trimmed, {
			apiVersion: 'v1',
			kind: 'Node',
			metadata: { name: 'n1', labels: { a: 'b' } },
			status: { conditions: [{ type: 'Ready', status: 'True' }] }
		});
	});
});
