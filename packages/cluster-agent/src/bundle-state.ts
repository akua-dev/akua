import { Bytes, Effect, Option, Result, Schema, Stream } from 'effect';
import { Base64 } from 'effect/encoding';
import ids from '@platform/ids';
import { AgentRelease, UpdateRollbackReason } from '@platform/api-contract/services/cluster-agent';
import { GitCommit } from '@platform/api-contract/services/repositories';
import { Inventory, Manifest } from './contract';
import type { KubernetesExtras } from './kubernetes';

/**
 * A bundle's state Secret in akua-system: the last good objects a rollback
 * re-applies (never fetched from the platform), the update in flight and
 * the release rejected here. The updater keeps the agent's bundle in
 * `akua-agent-bundle`; the agent keeps the updater's own objects in
 * `akua-updater-bundle`. Each key is gzip-compressed JSON.
 */

/**
 * The updater's state: the agent's part of the bundle. Only the updater
 * writes it; the agent reads it (its Role: get) to apply the updater's
 * part only once the updater verified the agent's at the same release.
 */
export const agentBundleSecret = 'akua-agent-bundle';

/**
 * The agent's state: the updater's own objects. Only the agent writes it;
 * the updater reads it (its Role: get) and starts no agent update while
 * the agent applies or gates the updater's part.
 */
export const updaterBundleSecret = 'akua-updater-bundle';

const BundleObjects = Schema.Array(Manifest).check(Schema.isMaxLength(200));

export const CurrentBundle = Schema.Struct({ release: AgentRelease, objects: BundleObjects });

export const BundleUpdate = Schema.Struct({
	from: AgentRelease,
	to: AgentRelease,
	startedAt: Schema.Finite,
	deadline: Schema.Finite,
	placementId: ids.placement.prefixedEffect,
	generation: Schema.Int,
	revision: GitCommit,
	/** The new bundle as rendered, stored as `current` once verified. */
	objects: BundleObjects,
	/** Every object of the new bundle; members not in it are pruned once verified. */
	planned: Inventory,
	/** What is applied: `planned` without what the customer's grant leaves to the customer. */
	applied: Inventory,
	/**
	 * What a rollback prunes. Before the apply finished: every applied object
	 * the last good bundle lacks; after it: those the apply reported created.
	 */
	created: Inventory,
	/** null until the engine answered the apply; a restart before that applies again. */
	appliedAt: Schema.NullOr(Schema.Finite)
});

export const BundleRejection = Schema.Struct({
	rejected: AgentRelease,
	reason: UpdateRollbackReason,
	at: Schema.Finite
});

const fields = {
	current: Schema.fromJsonString(CurrentBundle),
	update: Schema.fromJsonString(BundleUpdate),
	'rolled-back': Schema.fromJsonString(BundleRejection)
} as const;
type Field = keyof typeof fields;

export interface BundleState {
	readonly current: typeof CurrentBundle.Type | null;
	readonly update: typeof BundleUpdate.Type | null;
	readonly 'rolled-back': typeof BundleRejection.Type | null;
}

/**
 * Under key `reported` of the updater's state: the updater process of
 * `version` had its own channel open and the platform answered a phase it
 * reported with that version, at `at`. Part of the gate of the agent's
 * apply of a new updater.
 */
export const UpdaterReported = Schema.Struct({
	version: Schema.NonEmptyString.check(Schema.isMaxLength(64)),
	at: Schema.Finite
});
const reportedJson = Schema.fromJsonString(UpdaterReported);
const decodeReported = Schema.decodeUnknownOption(reportedJson);

/** The updater's last attestation; none when absent or unreadable. */
export const readReported = (extras: (typeof KubernetesExtras)['Service']) =>
	extras.readOwnSecret(agentBundleSecret).pipe(
		Effect.orDie,
		Effect.map((secret) => {
			const raw = secret?.data?.reported;
			if (raw === undefined) return null;
			const text = Base64.decodeString(raw);
			return Result.isFailure(text) ? null : Option.getOrNull(decodeReported(text.success));
		})
	);

/** Written by the updater only. */
export const writeReported = (
	extras: (typeof KubernetesExtras)['Service'],
	reported: typeof UpdaterReported.Type
) =>
	extras.patchOwnSecretData(agentBundleSecret, {
		reported: Base64.encode(Schema.encodeSync(reportedJson)(reported))
	});

/** Kubernetes refuses a Secret whose data values add up to more than 1 MiB (`MaxSecretSize`). */
export const secretDataLimitBytes = 1024 * 1024;

/** What a state Secret may hold: the Secret limit less a margin for its keys and metadata. */
export const stateBudgetBytes = secretDataLimitBytes - 64 * 1024;

/** A key never inflates beyond this; a larger one is corrupt, not state. */
const inflateLimitBytes = 8 * 1024 * 1024;

/**
 * The state after a write would exceed `stateBudgetBytes`. Nothing was
 * written; the caller refuses the bundle instead of leaving an update the
 * cluster cannot keep a rollback copy of.
 */
export class BundleStateTooLarge extends Schema.TaggedError<BundleStateTooLarge>()(
	'BundleStateTooLarge',
	{ secret: Schema.String, bytes: Schema.Int, limit: Schema.Int }
) {}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

const through = (bytes: Uint8Array, transform: CompressionStream | DecompressionStream) =>
	Stream.fromReadableStream({
		// A copy, so the Blob holds an ArrayBuffer-backed view whatever backs `bytes`.
		evaluate: () => new Blob([new Uint8Array(bytes)]).stream().pipeThrough(transform),
		onError: (cause) => cause
	}).pipe(
		Stream.mapAccum(
			() => 0,
			(total, chunk: Uint8Array) => [total + chunk.length, [{ total, chunk }]]
		),
		Stream.mapEffect(({ total, chunk }) =>
			total + chunk.length > inflateLimitBytes
				? Effect.fail(`more than ${inflateLimitBytes} bytes`)
				: Effect.succeed(chunk)
		),
		Stream.runCollect,
		Effect.map((chunks) => Bytes.concat(Array.from(chunks)))
	);

/** gzip-compressed JSON, as stored under one key. */
export const encodeField = <K extends Field>(key: K, value: (typeof fields)[K]['Type']) =>
	through(
		encoder.encode(Schema.encodeSync(fields[key])(value)),
		new CompressionStream('gzip')
	).pipe(Effect.orDie);

/**
 * One key of a state Secret's data; a missing key is absent. An
 * undecodable one is a defect, never absent: treating a corrupt update as
 * none would abandon it without a rollback.
 */
const readField = <K extends Field>(
	secret: string,
	data: Readonly<Record<string, string>> | undefined,
	key: K
): Effect.Effect<(typeof fields)[K]['Type'] | null> => {
	const raw = data?.[key];
	if (raw === undefined) return Effect.succeed(null);
	const bytes = Base64.decode(raw);
	if (Result.isFailure(bytes)) return Effect.die(`${secret} key ${key} is not base64`);
	return through(bytes.success, new DecompressionStream('gzip')).pipe(
		Effect.flatMap((json) => Schema.decodeUnknownEffect(fields[key])(decoder.decode(json))),
		Effect.mapError((cause) => `${secret} key ${key} is unreadable: ${String(cause)}`),
		Effect.orDie
	);
};

/** Bytes Kubernetes counts for one data value (its decoded length). */
const valueBytes = (base64: string) => {
	const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
	return Math.floor((base64.length * 3) / 4) - padding;
};

/**
 * Reads and writes one state Secret, which the chart creates empty and
 * only its owner writes. Every write checks the whole data, as it will be
 * after the merge patch, against `stateBudgetBytes` before anything is sent.
 */
export const bundleStateSecret = (extras: (typeof KubernetesExtras)['Service'], secret: string) => {
	const readData = extras.readOwnSecret(secret).pipe(
		Effect.orDie,
		Effect.map((found) => found?.data ?? {})
	);
	const read = Effect.gen(function* () {
		const data = yield* readData;
		return {
			current: yield* readField(secret, data, 'current'),
			update: yield* readField(secret, data, 'update'),
			'rolled-back': yield* readField(secret, data, 'rolled-back')
		} satisfies BundleState;
	});
	/** Without inflating the bundles: whether an update is recorded, and the rejection. */
	const peek = Effect.gen(function* () {
		const data = yield* readData;
		return {
			updating: data.update !== undefined,
			rejected: yield* readField(secret, data, 'rolled-back')
		};
	});
	/** The merge patch for `patch` (null removes a key), checked against the budget. */
	const encode = Effect.fnUntraced(function* (patch: Partial<BundleState>) {
		const encoded: Record<string, string | null> = {};
		const { current, update } = patch;
		const rejection = patch['rolled-back'];
		if (current !== undefined)
			encoded.current =
				current === null ? null : Base64.encode(yield* encodeField('current', current));
		if (update !== undefined)
			encoded.update = update === null ? null : Base64.encode(yield* encodeField('update', update));
		if (rejection !== undefined)
			encoded['rolled-back'] =
				rejection === null ? null : Base64.encode(yield* encodeField('rolled-back', rejection));
		const merged = { ...(yield* readData), ...encoded };
		const bytes = Object.values(merged).reduce<number>(
			(total, value) => (value === null ? total : total + valueBytes(value)),
			0
		);
		if (bytes > stateBudgetBytes)
			return yield* new BundleStateTooLarge({ secret, bytes, limit: stateBudgetBytes });
		return encoded;
	});
	const write = (patch: Partial<BundleState>) =>
		encode(patch).pipe(
			Effect.flatMap((data) => extras.patchOwnSecretData(secret, data).pipe(Effect.orDie))
		);
	/** Whether `patch` would fit, without writing. */
	const fits = (patch: Partial<BundleState>) => Effect.asVoid(encode(patch));
	return { read, peek, write, fits };
};
