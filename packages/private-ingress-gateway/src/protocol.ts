import { Schema } from 'effect';

export const ORIGIN_ROUTE_WIRE_ID_PATTERN = /^oro_[a-z0-9]+$/;
export const ORIGIN_ROUTE_WIRE_ID_MESSAGE = 'Origin route IDs must use the oro_<id> wire format';

export const OriginRouteWireIdSchema = Schema.NonEmptyString.check(
	Schema.isPattern(ORIGIN_ROUTE_WIRE_ID_PATTERN, { message: ORIGIN_ROUTE_WIRE_ID_MESSAGE })
);

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

export function requestPathForRouteToken(url: URL): string {
	return `${url.pathname}${url.search}`;
}

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
