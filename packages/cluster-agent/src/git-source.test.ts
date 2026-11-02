import { assert, describe, it } from '@effect/vitest';
import { Effect, Layer, Redacted, Result } from 'effect';
import { Base64 } from 'effect/encoding';
import { HttpClient, HttpClientError, HttpClientResponse } from 'effect/http';
import type { HttpClientRequest } from 'effect/http';
import { GitSource, SourceUnavailable } from './git-source';

/*
 * Fixtures were generated once with the real git binary and embedded as base64 so
 * tests need no git. Repo "main" has 3 commits; HEAD has README.md, manifests/a.yaml
 * (1571 bytes, edited slightly per commit so git stores deltas) and
 * manifests/sub/b.yaml.
 *
 *   gen() { for i in $(seq 1 30); do echo "  key$i: value-$1-line-$i-padding-padding-padding"; done; }
 *   # a.yaml = "apiVersion: v1 / kind: ConfigMap / metadata: / name: a / data:" + gen one
 *   # commit 2: sed 's/key7:/key7x:/'; commit 3: sed 's/key7:/key7y:/;s/key9:/key9z:/'
 *   # author/committer t <t@t>, dates 2026-01-01T00:00:00Z
 *   RESPONSE_B64: GIT_PROTOCOL=version=2 git upload-pack --stateless-rpc .  (stdin: v2 fetch, want HEAD, no-progress, done)
 *   OFS_PACK_B64: git rev-list --objects HEAD | git pack-objects --stdout --delta-base-offset --window=10 --depth=10
 *   REF_PACK_B64: git rev-list --objects HEAD | git pack-objects --stdout --window=10 --depth=10   (ref-delta)
 *   NOMANIFESTS_PACK_B64: one commit with README.md and docs/x.txt, pack-objects --delta-base-offset
 */
const HEAD = '0738abb949a600d187308026b8502774615eefe9';
const A_YAML_BLOB_ID = '02d8827ac3b3103c2e24a8a4f36326313d461bd3';
const NOMANIFESTS_HEAD = '29f782eeb74deff1e3e6e072cd28569ced546c41';
const RESPONSE_B64 =
	'MDAwZHBhY2tmaWxlCjA1MjEBUEFDSwAAAAIAAAAPmAp4nH3OPQ7CMAxA4T2nyM7in9hpJIS4SpLaKkMpqsz96Ql48ze8OM1ymcoO5OykSgC6mHlRLnOFOhyB22BpkD79tHdkXNcujjLIxuQCYqPQQMaOYkKt8mxEvqT+je04c+R7POORsWolEgXIN7hK89j3V4T9ISm2azH9AGcYLXmWCnicfcq7DQIxDADQPlOkp7GdjxMJoVsljn2C4gg6GbE+TMCrn59mkYpmERpVBxdMit1mM4YBUCShdQHSnHt4jdOeHplbU4aMIq1ZT2nyrggsE4BqZy17zYAjjLff1xk9Xn3zW0SuTFQqQLzAT5jrOB7u9qcE/6zwBSJSLMqWB3icfcq5DYAwDADAPlO4p3GcX0KIVfIYQREiRWZ/mICrTyYzxGQRqWhtXeFSKx41tayN4UCmELbkbOAcVX7kHBMEVtllAx18IHIeERb8qDp6v0T4p6hxs3oBrsUfl6kEeJwzNDAwMzFRCHJ1dPF11ctNYeicLPekVGZ6wiudPRN/175IXK8wQcjEAAgUchPzMtNSi0uKGebd52gvddR2f9C7xMpU52vJ6rvsnQDGqhx3OXicU1YoSk1MyU3lAgANUAK8oAR4nDM0MDAzMVFI1KtMzM1hYLrRVHV4s4CNnsqKJZ+T1Qxt3aQvmxgAgUJxaRKDGrdsZYpOWM5c7e3rPBpaXLbXl94GAKMFFqCzYnichdOxbsJAEITh3k9xL2CJGQPGbqlp05/kCzoBZytAJPL0QYrSZMhNs6st/urTxiW/pY9rnssYPtGccpnGsJ/Lez4e4tJc0i1O8RbHJoQSL2kMsfm9T+mBZxTP99TOJbXn/BxolzhNuRz/7p+AErAedBJ09WAtwboebCTY1IOtBNt60D+k6OvFToJdPRi+pBjqBVZqtzLJC27jDQWHEYeSw5hD0WHUoeww7lB4GHn0mhh6qD0MPgZNjD5Vn0afqk/37S/e3ehT9Wn0qfo0+lR9Gn2qPo0+VZ9Gn6pPo0/Vp9HvVL/7X/8bhCkYBqICeJwzNDAwMzFRSNKrTMzNYQg53LSncXKos4w7Qz2/8Lof0wverwUAvC8M4bMDeJxLLMgMSy0qzszPs1IoM+TKzsxLsVLwS8xNLS5ITE7lyk0tSUxJLEm04lJQyAOKWikkcQEA0YUQ76kEeJwzNDAwMzFRCHJ1dPF11ctNYeicLPekVGZ6wiudPRN/175IXK8wQcjEAAgUchPzMtNSi0uKGfYqr9A6tenDt+tzun4euvl0k8iNS4UA7sUggaAEeJwzNDAwMzFRSNSrTMzNYbCXYedJe9BxV+2oWeXUi67PntfKnjMxAAKF4tIkBjVu2coUnbCcudrb13k0tLhsry+9DQDDCBff8gEC2IJ6w7MQPC4kqKTzYyYxPUYb03icW8yziGdDKiNjxeQ0xqTNJxmjWAA8vAYkqQR4nDM0MDAzMVEIcnV08XXVy01h6Jws96RUZnrCK509E3/XvkhcrzBByMQACBRyE/My01KLS4oZHM8pJmZtzPcNS7BmmsnAmeS9tNYBALNRGiKgBHicMzQwMDMxUUjUq0zMzWGIOWjW2CVtu2SW2oHmmYWep8xF/aVNDIBAobg0iUGNW7YyRScsZ6729nUeDS0u2+tLbwMAn9gWfPABAtiCesOzEDwuJKik82MmMT1GG9N4nFvMs5BnQyrj5DTGpM0nGaNYADMLBarGduscgHQE3MwzGK3FVCtLJrJVMDAwNgENMDAwMA==';
const OFS_PACK_B64 =
	'UEFDSwAAAAIAAAAPmAp4nH3OPQ7CMAxA4T2nyM7in9hpJIS4SpLaKkMpqsz96Ql48ze8OM1ymcoO5OykSgC6mHlRLnOFOhyB22BpkD79tHdkXNcujjLIxuQCYqPQQMaOYkKt8mxEvqT+je04c+R7POORsWolEgXIN7hK89j3V4T9ISm2azH9AGcYLXmWCnicfcq7DQIxDADQPlOkp7GdjxMJoVsljn2C4gg6GbE+TMCrn59mkYpmERpVBxdMit1mM4YBUCShdQHSnHt4jdOeHplbU4aMIq1ZT2nyrggsE4BqZy17zYAjjLff1xk9Xn3zW0SuTFQqQLzAT5jrOB7u9qcE/6zwBSJSLMqWB3icfcq5DYAwDADAPlO4p3GcX0KIVfIYQREiRWZ/mICrTyYzxGQRqWhtXeFSKx41tayN4UCmELbkbOAcVX7kHBMEVtllAx18IHIeERb8qDp6v0T4p6hxs3oBrsUfl6kEeJwzNDAwMzFRCHJ1dPF11ctNYeicLPekVGZ6wiudPRN/175IXK8wQcjEAAgUchPzMtNSi0uKGebd52gvddR2f9C7xMpU52vJ6rvsnQDGqhx3OXicU1YoSk1MyU3lAgANUAK8oAR4nDM0MDAzMVFI1KtMzM1hYLrRVHV4s4CNnsqKJZ+T1Qxt3aQvmxgAgUJxaRKDGrdsZYpOWM5c7e3rPBpaXLbXl94GAKMFFqCzYnichdOxbsJAEITh3k9xL2CJGQPGbqlp05/kCzoBZytAJPL0QYrSZMhNs6st/urTxiW/pY9rnssYPtGccpnGsJ/Lez4e4tJc0i1O8RbHJoQSL2kMsfm9T+mBZxTP99TOJbXn/BxolzhNuRz/7p+AErAedBJ09WAtwboebCTY1IOtBNt60D+k6OvFToJdPRi+pBjqBVZqtzLJC27jDQWHEYeSw5hD0WHUoeww7lB4GHn0mhh6qD0MPgZNjD5Vn0afqk/37S/e3ehT9Wn0qfo0+lR9Gn2qPo0+VZ9Gn6pPo0/Vp9HvVL/7X/8bhCkYBqICeJwzNDAwMzFRSNKrTMzNYQg53LSncXKos4w7Qz2/8Lof0wverwUAvC8M4bMDeJxLLMgMSy0qzszPs1IoM+TKzsxLsVLwS8xNLS5ITE7lyk0tSUxJLEm04lJQyAOKWikkcQEA0YUQ76kEeJwzNDAwMzFRCHJ1dPF11ctNYeicLPekVGZ6wiudPRN/175IXK8wQcjEAAgUchPzMtNSi0uKGfYqr9A6tenDt+tzun4euvl0k8iNS4UA7sUggaAEeJwzNDAwMzFRSNSrTMzNYbCXYedJe9BxV+2oWeXUi67PntfKnjMxAAKF4tIkBjVu2coUnbCcudrb13k0tLhsry+9DQDDCBff4gGCdnicW8yziGdDKiNjxeQ0xqTNJxmjWAA8vAYkqQR4nDM0MDAzMVEIcnV08XXVy01h6Jws96RUZnrCK509E3/XvkhcrzBByMQACBRyE/My01KLS4oZHM8pJmZtzPcNS7BmmsnAmeS9tNYBALNRGiKgBHicMzQwMDMxUUjUq0zMzWGIOWjW2CVtu2SW2oHmmYWep8xF/aVNDIBAobg0iUGNW7YyRScsZ6729nUeDS0u2+tLbwMAn9gWfOABhDF4nFvMs5BnQyrj5DTGpM0nGaNYADMLBarffD/EaBztwbw/SMz6utdQkP0cNQ==';
const REF_PACK_B64 =
	'UEFDSwAAAAIAAAAPmAp4nH3OPQ7CMAxA4T2nyM7in9hpJIS4SpLaKkMpqsz96Ql48ze8OM1ymcoO5OykSgC6mHlRLnOFOhyB22BpkD79tHdkXNcujjLIxuQCYqPQQMaOYkKt8mxEvqT+je04c+R7POORsWolEgXIN7hK89j3V4T9ISm2azH9AGcYLXmWCnicfcq7DQIxDADQPlOkp7GdjxMJoVsljn2C4gg6GbE+TMCrn59mkYpmERpVBxdMit1mM4YBUCShdQHSnHt4jdOeHplbU4aMIq1ZT2nyrggsE4BqZy17zYAjjLff1xk9Xn3zW0SuTFQqQLzAT5jrOB7u9qcE/6zwBSJSLMqWB3icfcq5DYAwDADAPlO4p3GcX0KIVfIYQREiRWZ/mICrTyYzxGQRqWhtXeFSKx41tayN4UCmELbkbOAcVX7kHBMEVtllAx18IHIeERb8qDp6v0T4p6hxs3oBrsUfl6kEeJwzNDAwMzFRCHJ1dPF11ctNYeicLPekVGZ6wiudPRN/175IXK8wQcjEAAgUchPzMtNSi0uKGebd52gvddR2f9C7xMpU52vJ6rvsnQDGqhx3OXicU1YoSk1MyU3lAgANUAK8oAR4nDM0MDAzMVFI1KtMzM1hYLrRVHV4s4CNnsqKJZ+T1Qxt3aQvmxgAgUJxaRKDGrdsZYpOWM5c7e3rPBpaXLbXl94GAKMFFqCzYnichdOxbsJAEITh3k9xL2CJGQPGbqlp05/kCzoBZytAJPL0QYrSZMhNs6st/urTxiW/pY9rnssYPtGccpnGsJ/Lez4e4tJc0i1O8RbHJoQSL2kMsfm9T+mBZxTP99TOJbXn/BxolzhNuRz/7p+AErAedBJ09WAtwboebCTY1IOtBNt60D+k6OvFToJdPRi+pBjqBVZqtzLJC27jDQWHEYeSw5hD0WHUoeww7lB4GHn0mhh6qD0MPgZNjD5Vn0afqk/37S/e3ehT9Wn0qfo0+lR9Gn2qPo0+VZ9Gn6pPo0/Vp9HvVL/7X/8bhCkYBqICeJwzNDAwMzFRSNKrTMzNYQg53LSncXKos4w7Qz2/8Lof0wverwUAvC8M4bMDeJxLLMgMSy0qzszPs1IoM+TKzsxLsVLwS8xNLS5ITE7lyk0tSUxJLEm04lJQyAOKWikkcQEA0YUQ76kEeJwzNDAwMzFRCHJ1dPF11ctNYeicLPekVGZ6wiudPRN/175IXK8wQcjEAAgUchPzMtNSi0uKGfYqr9A6tenDt+tzun4euvl0k8iNS4UA7sUggaAEeJwzNDAwMzFRSNSrTMzNYbCXYedJe9BxV+2oWeXUi67PntfKnjMxAAKF4tIkBjVu2coUnbCcudrb13k0tLhsry+9DQDDCBff8gEC2IJ6w7MQPC4kqKTzYyYxPUYb03icW8yziGdDKiNjxeQ0xqTNJxmjWAA8vAYkqQR4nDM0MDAzMVEIcnV08XXVy01h6Jws96RUZnrCK509E3/XvkhcrzBByMQACBRyE/My01KLS4oZHM8pJmZtzPcNS7BmmsnAmeS9tNYBALNRGiKgBHicMzQwMDMxUUjUq0zMzWGIOWjW2CVtu2SW2oHmmYWep8xF/aVNDIBAobg0iUGNW7YyRScsZ6729nUeDS0u2+tLbwMAn9gWfPABAtiCesOzEDwuJKik82MmMT1GG9N4nFvMs5BnQyrj5DTGpM0nGaNYADMLBarGduscgHQE3MwzGK3FVCtLJrJVDQ==';
const NOMANIFESTS_PACK_B64 =
	'UEFDSwAAAAIAAAAFngd4nH3KMQ6AIAwAwJ1XdHcpRFpIjPErFWp0QBKt/9cXePPZpQpMISdJK9UotcRREHOVLFLG1XMqrHkLyZOTx/Z+gcFki83gmTiESIgw4MeV3tphpj/Fnb3JeWx62+1e33AjSKQEeJwzNDAwMzFRCHJ1dPF11ctNYeicLPekVGZ6wiudPRN/175IXK8wQcjEAAgUUvKTixkkHkzwWrG42q554fX3GtobbrhGqd0BAEkdGzE5eJxTVihKTUzJTeUCAA1QAryhAnicMzQwMDMxUajQK6koYXDd2bzPbLsNe8edOXu25+xu+FO9IRwAxbUOXTN4nMvI5AIAAhcA3CejmZZ7vS1bK/gugsL3evfCIYyD';

const SECRET = 'tok-secret-123';
const URL_UNDER_TEST = new URL('https://git.akua.dev/acme/platform.git');

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const fromBase64 = (value: string): Uint8Array<ArrayBuffer> => {
	const decoded = Base64.decode(value);
	return Result.isSuccess(decoded) ? new Uint8Array(decoded.success) : new Uint8Array(0);
};

const concat = (chunks: ReadonlyArray<Uint8Array>): Uint8Array<ArrayBuffer> => {
	const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
	let pos = 0;
	for (const chunk of chunks) {
		out.set(chunk, pos);
		pos += chunk.length;
	}
	return out;
};

const pkt = (payload: Uint8Array): Uint8Array<ArrayBuffer> =>
	concat([encoder.encode((payload.length + 4).toString(16).padStart(4, '0')), payload]);

const bandPkt = (band: number, data: Uint8Array): Uint8Array<ArrayBuffer> =>
	pkt(concat([new Uint8Array([band]), data]));

/** Wraps a raw pack in a protocol v2 response: shallow-info, then a side-band-64k "packfile" section. */
const wrapPack = (pack: Uint8Array, chunkSize = 4000): Uint8Array<ArrayBuffer> => {
	const parts: Array<Uint8Array> = [
		pkt(encoder.encode('shallow-info\n')),
		pkt(encoder.encode(`shallow ${HEAD}\n`)),
		encoder.encode('0001'),
		pkt(encoder.encode('packfile\n')),
		bandPkt(2, encoder.encode('Enumerating objects\n'))
	];
	for (let off = 0; off < pack.length; off += chunkSize)
		parts.push(bandPkt(1, pack.subarray(off, off + chunkSize)));
	parts.push(encoder.encode('0000'));
	return concat(parts);
};

const sha1 = (data: Uint8Array<ArrayBuffer>) =>
	Effect.promise(() => crypto.subtle.digest('SHA-1', data)).pipe(
		Effect.map((d) => new Uint8Array(d))
	);

/** Re-seals a pack body with a valid trailer so structural errors (not the checksum) are exercised. */
const seal = Effect.fnUntraced(function* (body: Uint8Array<ArrayBuffer>) {
	return concat([body, yield* sha1(body)]);
});

const hex = (bytes: Uint8Array): string =>
	Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

interface Served {
	readonly status?: number;
	readonly body: Uint8Array<ArrayBuffer>;
}

type Seen = Array<HttpClientRequest.HttpClientRequest>;

const layerFor = (client: HttpClient.HttpClient) =>
	GitSource.layer.pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, client)));

const run = (layer: ReturnType<typeof layerFor>, revision: string) =>
	Effect.gen(function* () {
		const source = yield* GitSource;
		return yield* source.fetchManifests({
			url: URL_UNDER_TEST,
			revision,
			credential: Redacted.make(SECRET)
		});
	}).pipe(Effect.provide(layer));

const fetchWith = (served: Served, revision = HEAD, seen: Seen = []) =>
	run(
		layerFor(
			HttpClient.make((request) => {
				seen.push(request);
				return Effect.succeed(
					HttpClientResponse.fromWeb(
						request,
						new Response(served.body, { status: served.status ?? 200 })
					)
				);
			})
		),
		revision
	);

const assertManifests = Effect.fnUntraced(function* (
	files: ReadonlyArray<{ path: string; content: Uint8Array }>
) {
	assert.deepStrictEqual(
		files.map((f) => f.path),
		['a.yaml', 'sub/b.yaml']
	);
	const [a, b] = files;
	assert.strictEqual(
		decoder.decode(b?.content),
		'apiVersion: v1\nkind: Namespace\nmetadata:\n  name: b\n'
	);
	assert.strictEqual(a?.content.length, 1571);
	const text = decoder.decode(a?.content);
	assert.isTrue(text.includes('  key7y: value-one-line-7-padding-padding-padding\n'));
	assert.isTrue(text.includes('  key9z: value-one-line-9-padding-padding-padding\n'));
	const blob = concat([encoder.encode('blob 1571\0'), a?.content ?? new Uint8Array(0)]);
	assert.strictEqual(hex(yield* sha1(blob)), A_YAML_BLOB_ID);
});

describe('GitSource', () => {
	it.effect('reads manifests from a real git upload-pack v2 response', () =>
		Effect.gen(function* () {
			yield* assertManifests(yield* fetchWith({ body: fromBase64(RESPONSE_B64) }));
		})
	);

	it.effect('resolves ofs-delta objects (small side-band chunks cross inflate boundaries)', () =>
		Effect.gen(function* () {
			for (const chunkSize of [4000, 7, 61]) {
				yield* assertManifests(
					yield* fetchWith({ body: wrapPack(fromBase64(OFS_PACK_B64), chunkSize) })
				);
			}
		})
	);

	it.effect('resolves ref-delta objects', () =>
		Effect.gen(function* () {
			yield* assertManifests(yield* fetchWith({ body: wrapPack(fromBase64(REF_PACK_B64)) }));
		})
	);

	it.effect('sends a v2 fetch request with Basic owner:token auth', () =>
		Effect.gen(function* () {
			const seen: Seen = [];
			yield* fetchWith({ body: wrapPack(fromBase64(OFS_PACK_B64)) }, HEAD, seen);
			const request = seen[0];
			assert.strictEqual(request?.method, 'POST');
			assert.strictEqual(request?.url, 'https://git.akua.dev/acme/platform.git/git-upload-pack');
			assert.strictEqual(request?.headers['git-protocol'], 'version=2');
			const auth = request?.headers['authorization'] ?? '';
			assert.isTrue(auth.startsWith('Basic '));
			const decoded = Base64.decode(auth.slice('Basic '.length));
			assert.strictEqual(
				Result.isSuccess(decoded) ? decoder.decode(decoded.success) : '',
				`acme:${SECRET}`
			);
			const body = request?.body;
			const text =
				body !== undefined && body._tag === 'Uint8Array' ? decoder.decode(body.body) : '';
			assert.isTrue(text.includes('command=fetch'));
			assert.isTrue(text.includes(`want ${HEAD}`));
			assert.isTrue(text.includes('deepen 1'));
			assert.isTrue(text.includes('done'));
		})
	);

	it.effect('returns an empty list when the commit has no manifests directory', () =>
		Effect.gen(function* () {
			const files = yield* fetchWith(
				{ body: wrapPack(fromBase64(NOMANIFESTS_PACK_B64)) },
				NOMANIFESTS_HEAD
			);
			assert.deepStrictEqual(files, []);
		})
	);

	it.effect('fails when the pack does not contain the wanted commit', () =>
		Effect.gen(function* () {
			const error = yield* Effect.flip(
				fetchWith({ body: wrapPack(fromBase64(OFS_PACK_B64)) }, NOMANIFESTS_HEAD)
			);
			assert.instanceOf(error, SourceUnavailable);
			assert.include(error.message, 'requested commit');
		})
	);

	it.effect('rejects a malformed revision before any request', () =>
		Effect.gen(function* () {
			const seen: Seen = [];
			const error = yield* Effect.flip(fetchWith({ body: new Uint8Array(0) }, 'main', seen));
			assert.instanceOf(error, SourceUnavailable);
			assert.strictEqual(seen.length, 0);
		})
	);

	it.effect('maps HTTP 401 to SourceUnavailable without the credential', () =>
		Effect.gen(function* () {
			const error = yield* Effect.flip(
				fetchWith({ status: 401, body: encoder.encode(`bad token ${SECRET}`) })
			);
			assert.instanceOf(error, SourceUnavailable);
			assert.include(error.message, '401');
			assert.notInclude(error.message, SECRET);
			assert.notInclude(error.message, Base64.encode(`acme:${SECRET}`));
		})
	);

	it.effect('maps a band-3 fatal message to SourceUnavailable', () =>
		Effect.gen(function* () {
			const body = concat([
				pkt(encoder.encode('packfile\n')),
				bandPkt(3, encoder.encode('fatal: Unable to assemble pack: boom\n')),
				encoder.encode('0000')
			]);
			const error = yield* Effect.flip(fetchWith({ body }));
			assert.instanceOf(error, SourceUnavailable);
			assert.include(error.message, 'Unable to assemble pack: boom');
		})
	);

	it.effect('fails on a response without a packfile section (ack only)', () =>
		Effect.gen(function* () {
			const body = concat([
				pkt(encoder.encode('acknowledgments\n')),
				pkt(encoder.encode('NAK\n')),
				encoder.encode('0000')
			]);
			const error = yield* Effect.flip(fetchWith({ body }));
			assert.include(error.message, 'no packfile');
		})
	);

	it.effect('fails on a truncated response, a truncated pack and a corrupt pack', () =>
		Effect.gen(function* () {
			const pack = fromBase64(OFS_PACK_B64);
			const wrapped = wrapPack(pack);
			const cutResponse = yield* Effect.flip(
				fetchWith({ body: wrapped.slice(0, wrapped.length - 40) })
			);
			assert.instanceOf(cutResponse, SourceUnavailable);

			// Checksum no longer matches the trailer.
			const cutPack = yield* Effect.flip(
				fetchWith({ body: wrapPack(pack.slice(0, pack.length - 30)) })
			);
			assert.include(cutPack.message, 'checksum');

			// Valid trailer over truncated content: the object parser itself must notice.
			const resealed = yield* seal(pack.slice(0, 700));
			const structural = yield* Effect.flip(fetchWith({ body: wrapPack(resealed) }));
			assert.include(structural.message, 'invalid pack');

			// Flipped byte: caught by the checksum, and (resealed) by the object parser or id lookup.
			const flipped = pack.slice();
			flipped[400] = (flipped[400] ?? 0) ^ 0xff;
			const corrupt = yield* Effect.flip(fetchWith({ body: wrapPack(flipped) }));
			assert.include(corrupt.message, 'checksum');
			const resealedCorrupt = yield* seal(flipped.slice(0, flipped.length - 20));
			const corruptStructure = yield* Effect.flip(fetchWith({ body: wrapPack(resealedCorrupt) }));
			assert.instanceOf(corruptStructure, SourceUnavailable);
		})
	);

	it.effect('maps transport failures without leaking the credential', () =>
		Effect.gen(function* () {
			const layer = layerFor(
				HttpClient.make((request) =>
					Effect.fail(
						new HttpClientError.HttpClientError({
							reason: new HttpClientError.TransportError({
								request,
								description: `connect failed for ${SECRET}`
							})
						})
					)
				)
			);
			const error = yield* Effect.flip(run(layer, HEAD));
			assert.instanceOf(error, SourceUnavailable);
			assert.notInclude(error.message, SECRET);
		})
	);
});
