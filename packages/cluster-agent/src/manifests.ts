import { Result, Schema } from 'effect';
import { Base64, Base64Url } from 'effect/encoding';
import { parseAllDocuments } from 'yaml';
import type { GeneratedSecretPlan } from '@platform/api-contract/internal/generated-secrets';
import type { DesiredState } from '@platform/api-contract/services/cluster-agent';
import { applySetLabels, type ApplySetId, type InventoryEntry, Manifest } from './contract';
import { objectKey, splitApiVersion } from './applyset';
import type { DiscoveredResource } from './kubernetes';
import type { SourceFile } from './git-source';

type Json = typeof Manifest.Type;

/** A manifest the agent will apply, with what it derived about it. */
export interface PlannedObject {
	readonly manifest: Json;
	readonly key: string;
	readonly entry: typeof InventoryEntry.Type;
	readonly group: string;
	readonly kind: string;
	readonly name: string;
	/** '' for cluster-scoped objects. */
	readonly namespace: string;
	/** Plural resource for access reviews; null when discovery and the batch's CRDs do not know the kind. */
	readonly resource: string | null;
}

export class ManifestError extends Schema.TaggedError<ManifestError>()('ManifestError', {
	message: Schema.String,
	object: Schema.NullOr(Schema.String)
}) {}

const Header = Schema.Struct({
	apiVersion: Schema.NonEmptyString,
	kind: Schema.NonEmptyString,
	metadata: Schema.Struct({
		name: Schema.NonEmptyString,
		namespace: Schema.optionalKey(Schema.String)
	})
});
const decodeHeader = Schema.decodeUnknownResult(Header);
const decodeManifest = Schema.decodeUnknownResult(Manifest);

const CrdNames = Schema.Struct({
	apiVersion: Schema.Literal('apiextensions.k8s.io/v1'),
	kind: Schema.Literal('CustomResourceDefinition'),
	spec: Schema.Struct({
		group: Schema.String,
		scope: Schema.Literals(['Namespaced', 'Cluster']),
		names: Schema.Struct({ kind: Schema.String, plural: Schema.String })
	})
});
const decodeCrd = Schema.decodeUnknownResult(CrdNames);

const textDecoder = new TextDecoder();

/** Every YAML or JSON document under `manifests/`, `List` kinds flattened. */
export const parseManifests = (
	files: ReadonlyArray<SourceFile>
): Result.Result<ReadonlyArray<Json>, ManifestError> => {
	const out: Array<Json> = [];
	for (const file of files) {
		if (!/\.(ya?ml|json)$/.test(file.path)) continue;
		const documents = parseAllDocuments(textDecoder.decode(file.content));
		for (const document of Array.isArray(documents) ? documents : [documents]) {
			if (document.errors.length > 0) {
				return Result.fail(
					new ManifestError({
						message: `${file.path}: ${document.errors[0]?.message ?? 'invalid YAML'}`,
						object: null
					})
				);
			}
			const value: unknown = document.toJS();
			if (value === null || value === undefined) continue;
			const decoded = decodeManifest(value);
			if (Result.isFailure(decoded)) {
				return Result.fail(
					new ManifestError({ message: `${file.path}: not an object`, object: null })
				);
			}
			const items = decoded.success.items;
			if (decoded.success.kind === 'List' && Array.isArray(items)) {
				for (const item of items) {
					const entry = decodeManifest(item);
					if (Result.isFailure(entry)) {
						return Result.fail(
							new ManifestError({
								message: `${file.path}: List item is not an object`,
								object: null
							})
						);
					}
					out.push(entry.success);
				}
				continue;
			}
			out.push(decoded.success);
		}
	}
	return Result.succeed(out);
};

type JsonRecord = { [key: string]: Json[string] };

const isJsonObject = Schema.is(Manifest);
const asRecord = (value: unknown): JsonRecord => (isJsonObject(value) ? { ...value } : {});

const withMetadata = (manifest: Json, update: (metadata: JsonRecord) => JsonRecord): Json => ({
	...manifest,
	metadata: update(asRecord(manifest.metadata))
});

/**
 * Fills each object's namespace from discovery (or a CRD in the same batch),
 * labels it as a member of the ApplySet, and derives its inventory entry.
 * Unknown kinds are treated as namespaced, as kubectl does for its default.
 */
export const planObjects = (args: {
	readonly manifests: ReadonlyArray<Json>;
	readonly namespace: string;
	readonly applySetId: typeof ApplySetId.Type;
	readonly discovery: ReadonlyMap<string, ReadonlyMap<string, DiscoveredResource> | null>;
}): Result.Result<ReadonlyArray<PlannedObject>, ManifestError> => {
	const crdScopes = new Map<string, DiscoveredResource>();
	for (const manifest of args.manifests) {
		const crd = decodeCrd(manifest);
		if (Result.isSuccess(crd)) {
			crdScopes.set(`${crd.success.spec.group}/${crd.success.spec.names.kind}`, {
				resource: crd.success.spec.names.plural,
				namespaced: crd.success.spec.scope === 'Namespaced'
			});
		}
	}
	const planned: Array<PlannedObject> = [];
	const seen = new Set<string>();
	for (const manifest of args.manifests) {
		const header = decodeHeader(manifest);
		if (Result.isFailure(header)) {
			return Result.fail(
				new ManifestError({
					message: 'every manifest needs apiVersion, kind and metadata.name',
					object: null
				})
			);
		}
		const { apiVersion, kind, metadata } = header.success;
		const { group, version } = splitApiVersion(apiVersion);
		const discovered =
			args.discovery.get(apiVersion)?.get(kind) ?? crdScopes.get(`${group}/${kind}`) ?? null;
		const namespaced = discovered?.namespaced ?? true;
		const namespace = namespaced ? metadata.namespace || args.namespace : '';
		const key = objectKey({ namespace, name: metadata.name, group, kind });
		if (seen.has(key)) {
			return Result.fail(new ManifestError({ message: `duplicate object ${key}`, object: key }));
		}
		seen.add(key);
		const labelled = withMetadata(manifest, (current) => {
			const next: JsonRecord = {
				...current,
				labels: { ...asRecord(current.labels), [applySetLabels.partOf]: args.applySetId }
			};
			if (namespaced) next.namespace = namespace;
			else delete next.namespace;
			return next;
		});
		planned.push({
			manifest: labelled,
			key,
			entry: { key, version },
			group,
			kind,
			name: metadata.name,
			namespace,
			resource: discovered?.resource ?? null
		});
	}
	return Result.succeed(planned);
};

/** The first object a non-privileged Placement may not touch, or null. */
export const reservedViolation = (
	objects: ReadonlyArray<PlannedObject>,
	reserved: (typeof DesiredState.Type)['reserved']
): PlannedObject | null => {
	const namespaces = new Set<string>(reserved.namespaces);
	for (const object of objects) {
		if (object.namespace !== '' && namespaces.has(object.namespace)) return object;
		if (object.group === '' && object.kind === 'Namespace' && namespaces.has(object.name))
			return object;
		if (
			reserved.names.some(
				(name) =>
					name.group === object.group && name.kind === object.kind && name.name === object.name
			)
		) {
			return object;
		}
	}
	return null;
};

const alphanumeric = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** A fresh random value of `length` characters in `encoding`; never leaves the cluster. */
export const generateSecretValue = (
	length: number,
	encoding: 'hex' | 'base64url' | 'alphanumeric'
): string => {
	if (encoding === 'alphanumeric') {
		let out = '';
		while (out.length < length) {
			for (const byte of crypto.getRandomValues(new Uint8Array(length * 2))) {
				// 248 = 4 * 62: rejecting the rest keeps every character equally likely.
				if (byte < 248 && out.length < length) out += alphanumeric[byte % 62];
			}
		}
		return out;
	}
	const bytes = crypto.getRandomValues(new Uint8Array(length));
	const text =
		encoding === 'hex'
			? Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
			: Base64Url.encode(bytes);
	return text.slice(0, length);
};

/** The Secret a GeneratedSecretPlan describes, keeping every value that already exists. */
export const generatedSecretManifest = (
	plan: GeneratedSecretPlan,
	existingData: Readonly<Record<string, string>>
): Json => {
	const base = plan.manifest;
	const baseData =
		typeof base.data === 'object' && base.data !== null && !Array.isArray(base.data)
			? base.data
			: {};
	const data: Record<string, string> = {};
	for (const [key, value] of Object.entries(baseData))
		if (typeof value === 'string') data[key] = value;
	for (const [key, value] of Object.entries(existingData)) data[key] = value;
	for (const entry of plan.keys) {
		if (data[entry.key] !== undefined) continue;
		data[entry.key] = Base64.encode(
			generateSecretValue(entry.length ?? 32, entry.encoding ?? 'alphanumeric')
		);
	}
	const metadata =
		typeof base.metadata === 'object' && base.metadata !== null && !Array.isArray(base.metadata)
			? base.metadata
			: {};
	return {
		...base,
		apiVersion: 'v1',
		kind: 'Secret',
		metadata: { ...metadata, name: plan.name, namespace: plan.namespace },
		data
	};
};

/** One Secret per mount name, values from the placement secrets endpoint. */
export const mountedSecretManifests = (
	namespace: string,
	values: ReadonlyArray<{ readonly name: string; readonly key: string; readonly value: string }>
): ReadonlyArray<Json> => {
	const byName = new Map<string, Record<string, string>>();
	for (const value of values) {
		const data = byName.get(value.name) ?? {};
		data[value.key] = Base64.encode(value.value);
		byName.set(value.name, data);
	}
	return [...byName].map(([name, data]) => ({
		apiVersion: 'v1',
		kind: 'Secret',
		type: 'Opaque',
		metadata: { name, namespace },
		data
	}));
};
