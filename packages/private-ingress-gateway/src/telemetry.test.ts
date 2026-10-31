import { expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import type { HttpBody } from 'effect/http';
import { OtlpSerialization, type OtlpTracer } from 'effect/observability';
import { safeSerializationLayer } from './telemetry';

const bodyText = (body: HttpBody.HttpBody) =>
	body._tag === 'Uint8Array' ? new TextDecoder().decode(body.body) : JSON.stringify(body);

it.effect('exports gateway timing and status without request, token or error data', () =>
	Effect.gen(function* () {
		const serialization = yield* OtlpSerialization.OtlpSerialization;
		const input: OtlpTracer.TraceData = {
			resourceSpans: [
				{
					resource: {
						attributes: [{ key: 'secret', value: { stringValue: 'secret-resource' } }],
						droppedAttributesCount: 0
					},
					scopeSpans: [
						{
							scope: { name: 'secret-scope' },
							spans: [
								{
									traceId: 'a'.repeat(32),
									spanId: 'b'.repeat(16),
									parentSpanId: undefined,
									name: 'privateIngressGateway.request',
									kind: 2,
									startTimeUnixNano: '100',
									endTimeUnixNano: '200',
									attributes: [
										{ key: 'url.path', value: { stringValue: '/secret-path?token=secret-query' } },
										{ key: 'server.address', value: { stringValue: 'secret-host' } },
										{ key: 'http.response.status_code', value: { intValue: 403 } },
										{ key: 'authorization', value: { stringValue: 'secret-token' } }
									],
									droppedAttributesCount: 0,
									events: [
										{
											name: 'secret-event',
											timeUnixNano: '200',
											attributes: [
												{
													key: 'http.response.status_code',
													value: { intValue: '403-secret-error' }
												}
											],
											droppedAttributesCount: 0
										}
									],
									droppedEventsCount: 0,
									status: { code: 2, message: 'secret-error' },
									links: [],
									droppedLinksCount: 0
								},
								{
									traceId: 'a'.repeat(32),
									spanId: 'c'.repeat(16),
									parentSpanId: 'b'.repeat(16),
									name: '/secret-path?token=secret-query',
									kind: 1,
									startTimeUnixNano: '110',
									endTimeUnixNano: '180',
									attributes: [
										{ key: 'http.response.status_code', value: { intValue: '403-secret-error' } }
									],
									droppedAttributesCount: 0,
									events: [],
									droppedEventsCount: 0,
									status: { code: 1 },
									links: [],
									droppedLinksCount: 0
								}
							]
						}
					]
				}
			]
		};
		const output = bodyText(serialization.traces(input));
		expect(output).toContain('privateIngressGateway.request');
		expect(output).toContain('privateIngressGateway.operation');
		expect(output).toContain('"startTimeUnixNano":"100"');
		expect(output).toContain('"code":2');
		expect(output).toContain('"http.response.status_code"');
		expect(output).toContain('"intValue":403');
		expect(output.match(/http.response.status_code/g)).toHaveLength(1);
		expect(output).not.toContain('secret-');
		expect(output).not.toContain('token');
	}).pipe(Effect.provide(safeSerializationLayer))
);
