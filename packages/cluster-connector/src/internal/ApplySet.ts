import { Effect, Result, Schema } from 'effect';
import { Base64, Base64Url } from 'effect/encoding';
import type ids from '@platform/ids';
import type { Secret } from '@platform/kubernetes-schemas/generated/kubernetes/1.34.1/core/v1/Secret';
import {
	ApplySetId,
	applySetAnnotations,
	applySetLabels,
	Inventory,
	type InventoryEntry
} from '../ClusterConnector';

type PlacementId = typeof ids.placement.prefixedEffect.Type;
type Entry = typeof InventoryEntry.Type;

/**
 * Kubernetes names allow no `_`; placement IDs are `plc_` plus lowercase
 * alphanumerics, so replacing the one underscore keeps the name unique.
 */
export const applySetParentName = (placementId: PlacementId): string =>
	`akua-applyset-${placementId.replace('_', '-')}`;

/** kubectl `ID()`: `applyset-` + base64url(sha256(`<name>.<namespace>.Secret.`)) + `-v1`. */
export const computeApplySetId = Effect.fn('ApplySet.computeId')(function* (args: {
	readonly name: string;
	readonly namespace: string;
}) {
	const digest = yield* Effect.promise(() =>
		crypto.subtle.digest(
			'SHA-256',
			new TextEncoder().encode(`${args.name}.${args.namespace}.Secret.`)
		)
	);
	return ApplySetId.make(`applyset-${Base64Url.encode(new Uint8Array(digest))}-v1`);
});

/** `<namespace>_<name>_<group>_<kind>`, the Flux inventory key. */
export const objectKey = (args: {
	readonly namespace: string;
	readonly name: string;
	readonly group: string;
	readonly kind: string;
}): string => `${args.namespace}_${args.name}_${args.group}_${args.kind}`;

export const parseObjectKey = (key: string) => {
	const [namespace = '', name = '', group = '', kind = ''] = key.split('_');
	return { namespace, name, group, kind };
};

export const splitApiVersion = (apiVersion: string) =>
	apiVersion.includes('/')
		? {
				group: apiVersion.slice(0, apiVersion.indexOf('/')),
				version: apiVersion.slice(apiVersion.indexOf('/') + 1)
			}
		: { group: '', version: apiVersion };

const InventoryJson = Schema.fromJsonString(Inventory);
const decodeInventory = Schema.decodeUnknownResult(InventoryJson);

/** The member list the parent holds, or null when its `inventory` key is missing or corrupt. */
export const inventoryOf = (parent: typeof Secret.Type): ReadonlyArray<Entry> | null => {
	const raw = parent.data?.inventory;
	if (raw === undefined) return [];
	const text = Base64.decodeString(raw);
	if (Result.isFailure(text)) return null;
	const decoded = decodeInventory(text.success);
	return Result.isSuccess(decoded) ? decoded.success : null;
};

export const applySetIdOf = (parent: typeof Secret.Type): string | undefined =>
	parent.metadata?.labels?.[applySetLabels.id];

/** Union by key; later entries win so API versions follow the newest render. */
export const unionInventory = (
	...lists: ReadonlyArray<ReadonlyArray<Entry>>
): ReadonlyArray<Entry> => {
	const byKey = new Map<string, Entry>();
	for (const list of lists) for (const entry of list) byKey.set(entry.key, entry);
	return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
};

/** cli-utils `ObjMetadataSet.Diff`: members of `previous` not in `current`. */
export const staleEntries = (
	previous: ReadonlyArray<Entry>,
	current: ReadonlyArray<Entry>
): ReadonlyArray<Entry> => {
	const keep = new Set(current.map((entry) => entry.key));
	return previous.filter((entry) => !keep.has(entry.key));
};

/** kubectl's annotation format: `Kind.group` (core kinds bare), sorted. */
export const groupKinds = (entries: ReadonlyArray<Entry>): string =>
	[
		...new Set(
			entries.map((entry) => {
				const { group, kind } = parseObjectKey(entry.key);
				return group === '' ? kind : `${kind}.${group}`;
			})
		)
	]
		.sort()
		.join(',');

export const buildParent = (args: {
	/** `applySetParentName` of the Placement, or a bundle's own parent. */
	readonly name: string;
	readonly namespace: string;
	readonly applySetId: typeof ApplySetId.Type;
	readonly agentVersion: string;
	readonly inventory: ReadonlyArray<Entry>;
}): typeof Secret.Type => {
	const additional = [
		...new Set(
			args.inventory
				.map((entry) => parseObjectKey(entry.key).namespace)
				.filter((namespace) => namespace !== '' && namespace !== args.namespace)
		)
	].sort();
	return {
		apiVersion: 'v1',
		kind: 'Secret',
		type: 'Opaque',
		metadata: {
			name: args.name,
			namespace: args.namespace,
			labels: { [applySetLabels.id]: args.applySetId },
			annotations: {
				[applySetAnnotations.tooling]: `akua-agent/${args.agentVersion}`,
				[applySetAnnotations.containsGroupKinds]: groupKinds(args.inventory),
				[applySetAnnotations.additionalNamespaces]: additional.join(',')
			}
		},
		data: { inventory: Base64.encode(JSON.stringify(args.inventory)) }
	};
};
