import { Context, Effect, Layer, Redacted, Result, Schema, Stream } from 'effect';
import { Hex } from 'effect/encoding';
import { HttpClient, HttpClientRequest } from 'effect/http';

/**
 * Fetches the `manifests/` tree of one git commit over git smart-HTTP protocol v2,
 * without a git binary: one stateless `POST <repo>/git-upload-pack` (`command=fetch`,
 * `want <sha>`, `done`), then a pure-TypeScript packfile reader (zlib inflate with
 * consumed-byte tracking, ofs/ref delta resolution, SHA-1 object ids).
 *
 * Authentication: HTTP Basic with username = the owner (first path segment of the
 * repository URL) and password = the short-lived read token. This is what
 * apps/git-hosting accepts for the `read` scope (git-authorization.ts: Basic username
 * must equal the repository owner, the password is verified by the auth authority).
 * The admin `Bearer` path is deliberately not used. The Placement service must mint a
 * read token that verifies for `(owner, token, repository)`.
 *
 * Server notes (apps/git-hosting): a POST carrying `command=fetch` is served without a
 * prior info/refs round trip; the fetch is only answered with a pack when `done` is
 * sent; `deepen` is ignored (the pack holds the full history closure of the wanted
 * commit, so `deepen 1` is still sent for standard servers that honor it); packs use
 * ofs-delta. A standard git server answers the same request with a shallow-info
 * section followed by the packfile.
 */

export class SourceUnavailable extends Schema.TaggedError<SourceUnavailable>()(
	'SourceUnavailable',
	{
		message: Schema.String
	}
) {}

export interface SourceFile {
	readonly path: string;
	readonly content: Uint8Array;
}

const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const MAX_INFLATED_BYTES = 256 * 1024 * 1024;
const MAX_FILES = 5000;
const MAX_TREE_DEPTH = 32;
const MANIFESTS_DIR = 'manifests';

const unavailable = (message: string) => new SourceUnavailable({ message });
const failWith = (message: string) => Effect.fail(unavailable(message));

type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

const OBJECT_TYPES: Readonly<Record<number, ObjectType | undefined>> = {
	1: 'commit',
	2: 'tree',
	3: 'blob',
	4: 'tag'
};

// ---------------------------------------------------------------------------
// inflate (RFC 1950/1951) that reports how many input bytes it consumed. Port of
// zlib's puff.c. Errors are recorded in `err`; bit readers then return 0 so every
// loop terminates and callers read `err` once.
// ---------------------------------------------------------------------------

interface Huffman {
	readonly count: Uint16Array;
	readonly symbol: Uint16Array;
}

const buildHuffman = (lengths: ReadonlyArray<number>, n: number): Huffman => {
	const count = new Uint16Array(16);
	const symbol = new Uint16Array(n);
	for (let i = 0; i < n; i++) count[lengths[i] ?? 0] = (count[lengths[i] ?? 0] ?? 0) + 1;
	const offs = new Uint16Array(16);
	for (let len = 1; len < 15; len++) offs[len + 1] = (offs[len] ?? 0) + (count[len] ?? 0);
	for (let i = 0; i < n; i++) {
		const len = lengths[i] ?? 0;
		if (len !== 0) {
			symbol[offs[len] ?? 0] = i;
			offs[len] = (offs[len] ?? 0) + 1;
		}
	}
	return { count, symbol };
};

const FIXED_LITERAL = buildHuffman(
	Array.from({ length: 288 }, (_, i) => (i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8)),
	288
);
const FIXED_DISTANCE = buildHuffman(
	Array.from({ length: 30 }, () => 5),
	30
);

const LENGTH_BASE = [
	3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131,
	163, 195, 227, 258
];
const LENGTH_EXTRA = [
	0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0
];
const DIST_BASE = [
	1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049,
	3073, 4097, 6145, 8193, 12289, 16385, 24577
];
const DIST_EXTRA = [
	0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13
];
const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

class Inflater {
	pos: number;
	err: string | undefined = undefined;
	private bitBuf = 0;
	private bitCnt = 0;
	private outPos = 0;
	readonly out: Uint8Array<ArrayBuffer>;

	constructor(
		private readonly data: Uint8Array,
		start: number,
		expectedSize: number
	) {
		this.pos = start;
		this.out = new Uint8Array(expectedSize);
	}

	private bits(need: number): number {
		let val = this.bitBuf;
		while (this.bitCnt < need) {
			const byte = this.data[this.pos];
			if (byte === undefined) {
				this.err = 'unexpected end of compressed data';
				return 0;
			}
			this.pos++;
			val |= byte << this.bitCnt;
			this.bitCnt += 8;
		}
		this.bitBuf = val >> need;
		this.bitCnt -= need;
		return val & ((1 << need) - 1);
	}

	private decode(h: Huffman): number {
		let code = 0;
		let first = 0;
		let index = 0;
		for (let len = 1; len <= 15; len++) {
			code |= this.bits(1);
			if (this.err !== undefined) return -1;
			const count = h.count[len] ?? 0;
			if (code - count < first) return h.symbol[index + (code - first)] ?? -1;
			index += count;
			first += count;
			first <<= 1;
			code <<= 1;
		}
		this.err = 'invalid huffman code';
		return -1;
	}

	private stored(): void {
		this.bitBuf = 0;
		this.bitCnt = 0;
		const d = this.data;
		if (this.pos + 4 > d.length) {
			this.err = 'unexpected end of compressed data';
			return;
		}
		const len = (d[this.pos] ?? 0) | ((d[this.pos + 1] ?? 0) << 8);
		const nlen = (d[this.pos + 2] ?? 0) | ((d[this.pos + 3] ?? 0) << 8);
		this.pos += 4;
		if (len !== (~nlen & 0xffff)) {
			this.err = 'corrupt stored block';
			return;
		}
		if (this.pos + len > d.length) {
			this.err = 'unexpected end of compressed data';
			return;
		}
		if (this.outPos + len > this.out.length) {
			this.err = 'inflated data exceeds declared size';
			return;
		}
		this.out.set(d.subarray(this.pos, this.pos + len), this.outPos);
		this.pos += len;
		this.outPos += len;
	}

	private codes(lit: Huffman, dist: Huffman): void {
		while (this.err === undefined) {
			let sym = this.decode(lit);
			if (this.err !== undefined) return;
			if (sym < 256) {
				if (this.outPos >= this.out.length) {
					this.err = 'inflated data exceeds declared size';
					return;
				}
				this.out[this.outPos++] = sym;
			} else if (sym === 256) {
				return;
			} else {
				sym -= 257;
				if (sym >= 29) {
					this.err = 'invalid length symbol';
					return;
				}
				const len = (LENGTH_BASE[sym] ?? 0) + this.bits(LENGTH_EXTRA[sym] ?? 0);
				const dsym = this.decode(dist);
				if (this.err !== undefined) return;
				if (dsym < 0 || dsym >= 30) {
					this.err = 'invalid distance symbol';
					return;
				}
				const distance = (DIST_BASE[dsym] ?? 0) + this.bits(DIST_EXTRA[dsym] ?? 0);
				if (this.err !== undefined) return;
				if (distance > this.outPos) {
					this.err = 'distance too far back';
					return;
				}
				if (this.outPos + len > this.out.length) {
					this.err = 'inflated data exceeds declared size';
					return;
				}
				for (let i = 0; i < len; i++) {
					this.out[this.outPos] = this.out[this.outPos - distance] ?? 0;
					this.outPos++;
				}
			}
		}
	}

	private dynamic(): void {
		const nlen = this.bits(5) + 257;
		const ndist = this.bits(5) + 1;
		const ncode = this.bits(4) + 4;
		if (this.err !== undefined) return;
		if (nlen > 286 || ndist > 30) {
			this.err = 'bad dynamic block counts';
			return;
		}
		const lengths: Array<number> = new Array<number>(320).fill(0);
		for (let i = 0; i < ncode; i++) lengths[CODE_LENGTH_ORDER[i] ?? 0] = this.bits(3);
		if (this.err !== undefined) return;
		const lencode = buildHuffman(lengths, 19);
		const all: Array<number> = new Array<number>(320).fill(0);
		let index = 0;
		while (index < nlen + ndist && this.err === undefined) {
			const sym = this.decode(lencode);
			if (this.err !== undefined) return;
			if (sym < 16) {
				all[index++] = sym;
			} else {
				let prev = 0;
				let rep: number;
				if (sym === 16) {
					if (index === 0) {
						this.err = 'repeat with no previous length';
						return;
					}
					prev = all[index - 1] ?? 0;
					rep = 3 + this.bits(2);
				} else if (sym === 17) {
					rep = 3 + this.bits(3);
				} else {
					rep = 11 + this.bits(7);
				}
				if (index + rep > nlen + ndist) {
					this.err = 'too many code lengths';
					return;
				}
				for (let i = 0; i < rep; i++) all[index++] = prev;
			}
		}
		if (this.err !== undefined) return;
		if ((all[256] ?? 0) === 0) {
			this.err = 'missing end-of-block code';
			return;
		}
		this.codes(
			buildHuffman(all.slice(0, nlen), nlen),
			buildHuffman(all.slice(nlen, nlen + ndist), ndist)
		);
	}

	/** Reads one zlib stream; returns the inflated bytes and the position after the stream. */
	run(): Result.Result<{ readonly out: Uint8Array<ArrayBuffer>; readonly end: number }, string> {
		const cmf = this.data[this.pos];
		const flg = this.data[this.pos + 1];
		if (cmf === undefined || flg === undefined)
			return Result.fail('unexpected end of compressed data');
		if ((cmf & 0x0f) !== 8 || ((cmf << 8) | flg) % 31 !== 0 || (flg & 0x20) !== 0) {
			return Result.fail('invalid zlib header');
		}
		this.pos += 2;
		let last = 0;
		while (last === 0 && this.err === undefined) {
			last = this.bits(1);
			const type = this.bits(2);
			if (this.err !== undefined) break;
			if (type === 0) this.stored();
			else if (type === 1) this.codes(FIXED_LITERAL, FIXED_DISTANCE);
			else if (type === 2) this.dynamic();
			else this.err = 'invalid deflate block type';
		}
		if (this.err !== undefined) return Result.fail(this.err);
		// Drop buffered bits, then skip the 4-byte adler32 trailer.
		this.pos += 4;
		if (this.pos > this.data.length) return Result.fail('unexpected end of compressed data');
		if (this.outPos !== this.out.length)
			return Result.fail('inflated size does not match object header');
		return Result.succeed({ out: this.out, end: this.pos });
	}
}

// ---------------------------------------------------------------------------
// packfile parsing
// ---------------------------------------------------------------------------

type PackEntry =
	| {
			readonly kind: 'base';
			readonly offset: number;
			readonly type: ObjectType;
			readonly data: Uint8Array<ArrayBuffer>;
	  }
	| {
			readonly kind: 'ofs';
			readonly offset: number;
			readonly baseOffset: number;
			readonly delta: Uint8Array<ArrayBuffer>;
	  }
	| {
			readonly kind: 'ref';
			readonly offset: number;
			readonly baseId: string;
			readonly delta: Uint8Array<ArrayBuffer>;
	  };

interface Budget {
	remaining: number;
}

const takeBudget = (budget: Budget, n: number): boolean => {
	if (n > budget.remaining) return false;
	budget.remaining -= n;
	return true;
};

/** Parses the entries of a pack (everything before the 20-byte trailer). */
const parseEntries = (
	pack: Uint8Array,
	budget: Budget
): Result.Result<ReadonlyArray<PackEntry>, string> => {
	const end = pack.length - 20;
	if (pack.length < 32) return Result.fail('pack is too short');
	if (pack[0] !== 0x50 || pack[1] !== 0x41 || pack[2] !== 0x43 || pack[3] !== 0x4b) {
		return Result.fail('missing PACK signature');
	}
	const view = new DataView(pack.buffer, pack.byteOffset, pack.byteLength);
	const version = view.getUint32(4);
	if (version !== 2 && version !== 3) return Result.fail(`unsupported pack version ${version}`);
	const count = view.getUint32(8);
	if (count > end) return Result.fail('pack object count exceeds pack size');
	const entries: Array<PackEntry> = [];
	let pos = 12;
	for (let n = 0; n < count; n++) {
		const offset = pos;
		let byte = pack[pos++];
		if (byte === undefined || pos > end) return Result.fail('truncated pack');
		const typeId = (byte >> 4) & 7;
		let size = byte & 15;
		let shift = 4;
		while ((byte & 0x80) !== 0) {
			byte = pack[pos++];
			if (byte === undefined || pos > end) return Result.fail('truncated pack');
			size += (byte & 0x7f) * 2 ** shift;
			shift += 7;
			if (shift > 49) return Result.fail('object size too large');
		}
		if (!takeBudget(budget, size)) return Result.fail('pack inflates beyond the allowed size');
		let baseOffset = -1;
		let baseId = '';
		if (typeId === 6) {
			let c = pack[pos++];
			if (c === undefined) return Result.fail('truncated pack');
			baseOffset = c & 0x7f;
			while ((c & 0x80) !== 0) {
				c = pack[pos++];
				if (c === undefined) return Result.fail('truncated pack');
				baseOffset = (baseOffset + 1) * 128 + (c & 0x7f);
			}
			baseOffset = offset - baseOffset;
			if (baseOffset < 12) return Result.fail('invalid ofs-delta base');
		} else if (typeId === 7) {
			if (pos + 20 > end) return Result.fail('truncated pack');
			baseId = Hex.encode(pack.subarray(pos, pos + 20));
			pos += 20;
		}
		const inflated = new Inflater(pack.subarray(0, end), pos, size).run();
		if (Result.isFailure(inflated)) return Result.fail(inflated.failure);
		pos = inflated.success.end;
		const type = OBJECT_TYPES[typeId];
		if (typeId === 6)
			entries.push({ kind: 'ofs', offset, baseOffset, delta: inflated.success.out });
		else if (typeId === 7)
			entries.push({ kind: 'ref', offset, baseId, delta: inflated.success.out });
		else if (type !== undefined)
			entries.push({ kind: 'base', offset, type, data: inflated.success.out });
		else return Result.fail(`unknown object type ${typeId}`);
	}
	if (pos !== end) return Result.fail('unexpected data after the last pack object');
	return Result.succeed(entries);
};

const readVarint = (
	delta: Uint8Array,
	start: number
): { readonly value: number; readonly next: number } | undefined => {
	let pos = start;
	let value = 0;
	let shift = 0;
	for (;;) {
		const byte = delta[pos++];
		if (byte === undefined || shift > 49) return undefined;
		value += (byte & 0x7f) * 2 ** shift;
		shift += 7;
		if ((byte & 0x80) === 0) return { value, next: pos };
	}
};

/** Applies a git delta (copy/insert instructions) to `base`. */
const applyDelta = (
	base: Uint8Array,
	delta: Uint8Array,
	budget: Budget
): Result.Result<Uint8Array<ArrayBuffer>, string> => {
	const baseSize = readVarint(delta, 0);
	if (baseSize === undefined) return Result.fail('corrupt delta header');
	const resultSize = readVarint(delta, baseSize.next);
	if (resultSize === undefined) return Result.fail('corrupt delta header');
	if (baseSize.value !== base.length) return Result.fail('delta base size mismatch');
	if (!takeBudget(budget, resultSize.value))
		return Result.fail('pack inflates beyond the allowed size');
	const out = new Uint8Array(resultSize.value);
	let outPos = 0;
	let pos = resultSize.next;
	while (pos < delta.length) {
		const op = delta[pos++] ?? 0;
		if ((op & 0x80) !== 0) {
			let copyOffset = 0;
			let copySize = 0;
			for (let i = 0; i < 4; i++) {
				if ((op & (1 << i)) !== 0) {
					const b = delta[pos++];
					if (b === undefined) return Result.fail('truncated delta');
					copyOffset += b * 2 ** (8 * i);
				}
			}
			for (let i = 0; i < 3; i++) {
				if ((op & (0x10 << i)) !== 0) {
					const b = delta[pos++];
					if (b === undefined) return Result.fail('truncated delta');
					copySize += b * 2 ** (8 * i);
				}
			}
			if (copySize === 0) copySize = 0x10000;
			if (copyOffset + copySize > base.length || outPos + copySize > out.length) {
				return Result.fail('delta copy out of range');
			}
			out.set(base.subarray(copyOffset, copyOffset + copySize), outPos);
			outPos += copySize;
		} else if (op !== 0) {
			if (pos + op > delta.length || outPos + op > out.length)
				return Result.fail('delta insert out of range');
			out.set(delta.subarray(pos, pos + op), outPos);
			pos += op;
			outPos += op;
		} else {
			return Result.fail('delta uses reserved instruction');
		}
	}
	if (outPos !== out.length) return Result.fail('delta result size mismatch');
	return Result.succeed(out);
};

interface GitObject {
	readonly type: ObjectType;
	readonly content: Uint8Array<ArrayBuffer>;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const sha1 = (data: Uint8Array<ArrayBuffer>) =>
	Effect.tryPromise({
		try: () => crypto.subtle.digest('SHA-1', data),
		catch: () => unavailable('SHA-1 digest failed')
	}).pipe(Effect.map((digest) => new Uint8Array(digest)));

const objectId = Effect.fnUntraced(function* (type: ObjectType, content: Uint8Array<ArrayBuffer>) {
	const header = encoder.encode(`${type} ${content.length}\0`);
	const buffer = new Uint8Array(header.length + content.length);
	buffer.set(header, 0);
	buffer.set(content, header.length);
	return Hex.encode(yield* sha1(buffer));
});

/** Verifies the pack, inflates every entry and resolves deltas; returns objects by id. */
const readPack = Effect.fnUntraced(function* (pack: Uint8Array<ArrayBuffer>) {
	if (pack.length < 32) return yield* failWith('git host returned a truncated pack');
	const trailer = Hex.encode(pack.subarray(pack.length - 20));
	const actual = Hex.encode(yield* sha1(pack.slice(0, pack.length - 20)));
	if (trailer !== actual)
		return yield* failWith('git host returned a corrupt pack (checksum mismatch)');
	const budget: Budget = { remaining: MAX_INFLATED_BYTES };
	const parsed = parseEntries(pack, budget);
	if (Result.isFailure(parsed))
		return yield* failWith(`git host returned an invalid pack: ${parsed.failure}`);

	const byOffset = new Map<number, GitObject>();
	const byId = new Map<string, GitObject>();
	let pending: Array<PackEntry> = [];
	for (const entry of parsed.success) {
		if (entry.kind === 'base') {
			const object: GitObject = { type: entry.type, content: entry.data };
			byOffset.set(entry.offset, object);
			byId.set(yield* objectId(object.type, object.content), object);
		} else {
			pending.push(entry);
		}
	}
	while (pending.length > 0) {
		const next: Array<PackEntry> = [];
		let progressed = false;
		for (const entry of pending) {
			if (entry.kind === 'base') continue;
			const base = entry.kind === 'ofs' ? byOffset.get(entry.baseOffset) : byId.get(entry.baseId);
			if (base === undefined) {
				next.push(entry);
				continue;
			}
			const applied = applyDelta(base.content, entry.delta, budget);
			if (Result.isFailure(applied))
				return yield* failWith(`git host returned an invalid pack: ${applied.failure}`);
			const object: GitObject = { type: base.type, content: applied.success };
			byOffset.set(entry.offset, object);
			byId.set(yield* objectId(object.type, object.content), object);
			progressed = true;
		}
		if (!progressed) return yield* failWith('git host returned a pack with unresolvable deltas');
		pending = next;
	}
	return byId;
});

// ---------------------------------------------------------------------------
// protocol v2 framing
// ---------------------------------------------------------------------------

const pktLine = (text: string): Uint8Array<ArrayBuffer> => {
	const payload = encoder.encode(text);
	const out = new Uint8Array(payload.length + 4);
	out.set(encoder.encode((payload.length + 4).toString(16).padStart(4, '0')), 0);
	out.set(payload, 4);
	return out;
};

const concat = (chunks: ReadonlyArray<Uint8Array>): Uint8Array<ArrayBuffer> => {
	const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
	const out = new Uint8Array(total);
	let pos = 0;
	for (const chunk of chunks) {
		out.set(chunk, pos);
		pos += chunk.length;
	}
	return out;
};

const fetchRequestBody = (revision: string): Uint8Array<ArrayBuffer> =>
	concat([
		pktLine('command=fetch\n'),
		pktLine('agent=akua-cluster-agent\n'),
		pktLine('object-format=sha1\n'),
		encoder.encode('0001'),
		pktLine(`want ${revision}\n`),
		pktLine('deepen 1\n'),
		pktLine('no-progress\n'),
		pktLine('done\n'),
		encoder.encode('0000')
	]);

const HEX_LENGTH = /^[0-9a-f]{4}$/;

/** Extracts the raw pack bytes from a v2 fetch response (sections, side-band-64k). */
const extractPack = Effect.fnUntraced(function* (body: Uint8Array) {
	const packChunks: Array<Uint8Array> = [];
	let pos = 0;
	let expectHeader = true;
	let section: 'none' | 'packfile' | 'other' = 'none';
	let sawPackfile = false;
	let finished = false;
	while (pos < body.length && !finished) {
		if (pos + 4 > body.length) return yield* failWith('git host response is truncated');
		const lengthText = decoder.decode(body.subarray(pos, pos + 4));
		if (!HEX_LENGTH.test(lengthText))
			return yield* failWith('git host response is not pkt-line framed');
		const length = Number.parseInt(lengthText, 16);
		pos += 4;
		if (length === 0 || length === 2) {
			finished = true;
		} else if (length === 1) {
			section = 'none';
			expectHeader = true;
		} else if (length === 3 || pos + (length - 4) > body.length) {
			return yield* failWith('git host response is truncated');
		} else {
			const payload = body.subarray(pos, pos + length - 4);
			pos += length - 4;
			if (expectHeader) {
				expectHeader = false;
				section = decoder.decode(payload).trimEnd() === 'packfile' ? 'packfile' : 'other';
				sawPackfile = sawPackfile || section === 'packfile';
			} else if (section === 'packfile') {
				const band = payload[0];
				if (band === 1) packChunks.push(payload.subarray(1));
				else if (band === 3) {
					const message = decoder.decode(payload.subarray(1)).trim().slice(0, 200);
					return yield* failWith(`git host reported an error: ${message}`);
				} else if (band !== 2) return yield* failWith('git host sent an unknown side-band channel');
			}
		}
	}
	if (!sawPackfile) return yield* failWith('git host response contained no packfile');
	if (!finished) return yield* failWith('git host response is truncated');
	return concat(packChunks);
});

// ---------------------------------------------------------------------------
// tree walking
// ---------------------------------------------------------------------------

interface TreeEntry {
	readonly mode: string;
	readonly name: string;
	readonly id: string;
}

const parseTree = (content: Uint8Array): Result.Result<ReadonlyArray<TreeEntry>, string> => {
	const entries: Array<TreeEntry> = [];
	let pos = 0;
	while (pos < content.length) {
		const space = content.indexOf(0x20, pos);
		const nul = space === -1 ? -1 : content.indexOf(0, space);
		if (space === -1 || nul === -1 || nul + 21 > content.length)
			return Result.fail('corrupt tree object');
		entries.push({
			mode: decoder.decode(content.subarray(pos, space)),
			name: decoder.decode(content.subarray(space + 1, nul)),
			id: Hex.encode(content.subarray(nul + 1, nul + 21))
		});
		pos = nul + 21;
	}
	return Result.succeed(entries);
};

const commitTreeId = (content: Uint8Array): string | undefined => {
	const line = decoder.decode(content.subarray(0, 46));
	return /^tree ([0-9a-f]{40})\n/.exec(line)?.[1];
};

const isSafeName = (name: string): boolean =>
	name !== '' &&
	name !== '.' &&
	name !== '..' &&
	!name.includes('/') &&
	!name.includes('\\') &&
	!name.includes('\0');

const walkManifests = Effect.fnUntraced(function* (
	objects: ReadonlyMap<string, GitObject>,
	revision: string
) {
	const commit = objects.get(revision);
	if (commit === undefined || commit.type !== 'commit') {
		return yield* failWith('git host pack does not contain the requested commit');
	}
	const rootId = commitTreeId(commit.content);
	if (rootId === undefined) return yield* failWith('requested commit has no tree');
	const loadTree = Effect.fnUntraced(function* (id: string) {
		const tree = objects.get(id);
		if (tree === undefined || tree.type !== 'tree')
			return yield* failWith('git host pack is missing a tree object');
		const parsed = parseTree(tree.content);
		if (Result.isFailure(parsed)) return yield* failWith(parsed.failure);
		return parsed.success;
	});

	const root = yield* loadTree(rootId);
	const manifests = root.find((entry) => entry.name === MANIFESTS_DIR && entry.mode === '40000');
	if (manifests === undefined) return [] satisfies ReadonlyArray<SourceFile>;

	const files: Array<SourceFile> = [];
	const stack: Array<{ readonly id: string; readonly prefix: string; readonly depth: number }> = [
		{ id: manifests.id, prefix: '', depth: 0 }
	];
	for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
		if (item.depth > MAX_TREE_DEPTH) return yield* failWith('manifests tree is nested too deeply');
		for (const entry of yield* loadTree(item.id)) {
			if (!isSafeName(entry.name)) return yield* failWith('manifests tree contains an unsafe path');
			const path = `${item.prefix}${entry.name}`;
			if (entry.mode === '40000') {
				stack.push({ id: entry.id, prefix: `${path}/`, depth: item.depth + 1 });
			} else if (entry.mode === '100644' || entry.mode === '100755') {
				const blob = objects.get(entry.id);
				if (blob === undefined || blob.type !== 'blob') {
					return yield* failWith('git host pack is missing a blob object');
				}
				files.push({ path, content: blob.content });
				if (files.length > MAX_FILES)
					return yield* failWith(`manifests contain more than ${MAX_FILES} files`);
			}
			// symlinks (120000) and submodules (160000) are skipped.
		}
	}
	return [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
});

// ---------------------------------------------------------------------------
// service
// ---------------------------------------------------------------------------

const REVISION = /^[0-9a-f]{40}$/;

export class GitSource extends Context.Service<
	GitSource,
	{
		/** Files under `manifests/` of `revision` (paths relative to `manifests/`, sorted), blobs only, symlinks/submodules skipped. */
		fetchManifests(args: {
			readonly url: URL;
			readonly revision: string;
			readonly credential: Redacted.Redacted<string>;
		}): Effect.Effect<ReadonlyArray<SourceFile>, SourceUnavailable>;
	}
>()('akua/cluster-agent/GitSource') {
	static readonly layer: Layer.Layer<GitSource, never, HttpClient.HttpClient> = Layer.effect(
		GitSource,
		Effect.gen(function* () {
			const client = yield* HttpClient.HttpClient;

			const fetchManifests = Effect.fn('GitSource.fetchManifests')(function* (args: {
				readonly url: URL;
				readonly revision: string;
				readonly credential: Redacted.Redacted<string>;
			}) {
				if (!REVISION.test(args.revision))
					return yield* failWith('revision must be a 40-character lowercase hex commit id');
				const owner = args.url.pathname.split('/').find((segment) => segment !== '');
				if (owner === undefined) return yield* failWith('repository URL has no owner path segment');
				if (args.url.protocol !== 'https:' && args.url.protocol !== 'http:') {
					return yield* failWith('repository URL must be http(s)');
				}
				const endpoint = `${args.url.origin}${args.url.pathname.replace(/\/+$/, '')}/git-upload-pack`;
				const request = HttpClientRequest.post(endpoint).pipe(
					HttpClientRequest.setHeaders({
						'Git-Protocol': 'version=2',
						Accept: 'application/x-git-upload-pack-result'
					}),
					HttpClientRequest.basicAuth(decodeURIComponent(owner), args.credential),
					HttpClientRequest.bodyUint8Array(
						fetchRequestBody(args.revision),
						'application/x-git-upload-pack-request'
					)
				);
				const response = yield* client
					.execute(request)
					.pipe(
						Effect.mapError((error) =>
							unavailable(`git host request failed (${error.reason._tag})`)
						)
					);
				if (response.status !== 200)
					return yield* failWith(`git host responded with HTTP ${response.status}`);
				const chunks = yield* response.stream.pipe(
					Stream.mapAccumEffect(
						() => 0,
						(total: number, chunk: Uint8Array) =>
							total + chunk.length > MAX_RESPONSE_BYTES
								? failWith(`git host response exceeds ${MAX_RESPONSE_BYTES} bytes`)
								: Effect.succeed([total + chunk.length, [chunk]] as const)
					),
					Stream.runCollect,
					Effect.mapError((error) =>
						error instanceof SourceUnavailable
							? error
							: unavailable(`git host response failed (${error.reason._tag})`)
					)
				);
				const pack = yield* extractPack(concat(chunks));
				const objects = yield* readPack(pack);
				return yield* walkManifests(objects, args.revision);
			});

			return GitSource.of({ fetchManifests });
		})
	);
}
