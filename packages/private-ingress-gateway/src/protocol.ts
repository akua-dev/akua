import { Schema } from 'effect';

export const OriginRouteWireIdSchema = Schema.NonEmptyString.check(
	Schema.isPattern(/^oro_[a-z0-9]+$/, {
		message: 'Origin route IDs must use the oro_<id> wire format'
	})
);

/**
 * The routes one gateway serves, read from its mounted file: each public host
 * and the backend Service URL its requests go to. Only this table selects a
 * backend; a request never names one.
 */
export const RouteTable = Schema.Struct({
	routes: Schema.Array(
		Schema.Struct({
			public_host: Schema.NonEmptyString,
			backend_url: Schema.URLFromString
		})
	)
});

export const ROUTE_TOKEN_HEADER_NAME = 'x-platform-route';
export const FORWARDED_HOST_HEADER_NAME = 'x-forwarded-host';
export const DISPATCHER_PROBE_HEADER_NAME = 'x-platform-dispatcher-probe';
export const DISPATCHER_PROBE_REQUEST_VALUE = '1';
export const DISPATCHER_PROBE_NONCE_HEADER_NAME = 'x-platform-dispatcher-probe-nonce';
export const DISPATCHER_PROBE_SIGNATURE_HEADER_NAME = 'x-platform-dispatcher-probe-signature';

export type DispatcherProbeClassification =
	| 'upstream'
	| 'not_ready'
	| 'not_found'
	| 'timeout'
	| 'origin_fetch_failed';

export function resolveRouteTargetUrl(baseUrl: string | URL, incomingUrl: URL): URL {
	const target = new URL(baseUrl);
	target.pathname = `${target.pathname.replace(/\/$/, '')}${incomingUrl.pathname}`;
	target.search = incomingUrl.search;
	return target;
}

export function toDispatcherKvKey(hostname: string): string {
	return hostname.trim().replace(/\.$/, '').toLowerCase();
}

const TRUST_BOUNDARY_HEADERS = new Set([
	'forwarded',
	'x-forwarded-for',
	'x-forwarded-host',
	'x-forwarded-proto',
	'x-real-ip'
]);

export function isTrustedForwardHeaderName(name: string): boolean {
	const normalized = name.toLowerCase();
	return (
		TRUST_BOUNDARY_HEADERS.has(normalized) ||
		normalized.startsWith('cf-') ||
		normalized.startsWith('x-platform-')
	);
}
