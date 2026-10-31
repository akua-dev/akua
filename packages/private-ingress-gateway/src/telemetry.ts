import { Effect, Layer } from 'effect';
import { FetchHttpClient, HttpBody } from 'effect/http';
import { OtlpSerialization, OtlpTracer, type OtlpResource } from 'effect/observability';

const serviceName = 'platform-private-ingress-gateway';

const resource = (): OtlpResource.Resource => ({
	attributes: [{ key: 'service.name', value: { stringValue: serviceName } }],
	droppedAttributesCount: 0
});

const safeSpanName = (name: string): string => {
	if (name === 'privateIngressGateway.request') return name;
	if (/^http\.(server|client) (GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(name)) return name;
	return 'privateIngressGateway.operation';
};

const safeStatusAttributes = (
	attributes: ReadonlyArray<OtlpResource.KeyValue>
): Array<OtlpResource.KeyValue> => {
	const value = attributes.find((attribute) => attribute.key === 'http.response.status_code')?.value
		.intValue;
	const status =
		typeof value === 'number'
			? value
			: typeof value === 'string' && /^[1-5]\d{2}$/.test(value)
				? Number(value)
				: NaN;
	return Number.isInteger(status) && status >= 100 && status <= 599
		? [{ key: 'http.response.status_code', value: { intValue: status } }]
		: [];
};

const safeTraceData = (data: OtlpTracer.TraceData): OtlpTracer.TraceData => ({
	resourceSpans: data.resourceSpans.map((group) => ({
		resource: resource(),
		scopeSpans: group.scopeSpans.map((scope) => ({
			scope: { name: serviceName },
			spans: scope.spans.map((span) => {
				const attributes = safeStatusAttributes(span.attributes);
				return {
					traceId: span.traceId,
					spanId: span.spanId,
					parentSpanId: span.parentSpanId,
					name: safeSpanName(span.name),
					kind: span.kind,
					startTimeUnixNano: span.startTimeUnixNano,
					endTimeUnixNano: span.endTimeUnixNano,
					attributes,
					droppedAttributesCount:
						span.droppedAttributesCount + span.attributes.length - attributes.length,
					events: [],
					droppedEventsCount: span.droppedEventsCount + span.events.length,
					status: { code: span.status.code },
					links: span.links.map((link) => ({
						traceId: link.traceId,
						spanId: link.spanId,
						attributes: [],
						droppedAttributesCount: link.droppedAttributesCount + link.attributes.length
					})),
					droppedLinksCount: span.droppedLinksCount
				};
			})
		}))
	}))
});

// The gateway handles arbitrary URLs, headers, tokens, and upstream failures.
// Export only fixed span names, timing, topology, and status.
export const safeSerializationLayer = Layer.effect(
	OtlpSerialization.OtlpSerialization,
	Effect.succeed({
		traces: (data: OtlpTracer.TraceData) => HttpBody.jsonUnsafe(safeTraceData(data)),
		metrics: () => HttpBody.jsonUnsafe({ resourceMetrics: [] }),
		logs: () => HttpBody.jsonUnsafe({ resourceLogs: [] })
	})
);

export const privateIngressTelemetryLayer = (baseUrl: string) =>
	OtlpTracer.layer({
		url: `${baseUrl.replace(/\/$/, '')}/v1/traces`,
		resource: { serviceName }
	}).pipe(Layer.provide(safeSerializationLayer), Layer.provide(FetchHttpClient.layer));
