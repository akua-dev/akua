import { DateTime, Option, Predicate } from 'effect';

import { decodeJsonTextOption } from '../api/json';

import type { NextStep } from './errors';

/**
 * Terminal rendering for people: list pages become tables, objects become
 * aligned `key  value` lines, timestamps become dates. Machines keep the
 * JSON (`--json`) and agent renderers, which this module never touches.
 */

const MAX_COLUMNS = 6;
const MAX_CELL = 60;
/** Column order for list tables. */
const PRIORITY = ['id', 'name', 'slug', 'title', 'kind', 'type', 'state', 'status', 'phase'];
/** Nested fields that describe the row itself, for example `lifecycle.state` or `metadata.type`. */
const NESTED_COLUMNS = new Set(['kind', 'type', 'state', 'status', 'phase']);
const TIME_COLUMNS = ['created_at', 'started_at'];
/** Wire fields that only matter to programs. */
const HIDDEN_IN_TABLES = new Set([
	'etag',
	'html_url',
	'updated_at',
	'workspace_id',
	'organization_id',
	'owner_type',
	'owner_id'
]);

export function humanData(data: unknown): string[] {
	if (data === undefined) return [];
	if (data === null) return ['Done.'];
	if (Predicate.isObject(data) && Array.isArray(data.data)) {
		return [
			...humanTable(data.data),
			...(data.has_more === true ? ['', 'More results are available.'] : [])
		];
	}
	if (Array.isArray(data)) return humanTable(data);
	if (Predicate.isObject(data)) return keyValues(data);
	return [String(data)];
}

export function humanNextSteps(steps: readonly NextStep[]): string[] {
	if (steps.length === 0) return [];
	const width = Math.max(...steps.map((step) => step.command.length));
	return [
		'',
		'Next steps:',
		...steps.map((step) =>
			step.description === undefined
				? `  ${step.command}`
				: `  ${step.command.padEnd(width)}  ${step.description}`
		)
	];
}

/** One streamed event: log lines print their content, other events their data. */
export function humanStreamItem(item: unknown): string {
	if (!Predicate.isObject(item) || !Predicate.isString(item.data)) return `${String(item)}\n`;
	if (item.event === 'end') return '';
	const payload = Option.getOrUndefined(decodeJsonTextOption(item.data));
	if (Predicate.isObject(payload) && Predicate.isString(payload.content)) {
		return payload.content.endsWith('\n') ? payload.content : `${payload.content}\n`;
	}
	return `${item.data}\n`;
}

function humanTable(rows: readonly unknown[]): string[] {
	if (rows.length === 0) return ['No results.'];
	if (!rows.every(Predicate.isObject)) return rows.map((row) => cell('', row));
	const flattened = rows.map((row) => flatten(row));
	const columns = tableColumns(flattened);
	const headers = columns.map(columnHeader(columns));
	const body = flattened.map((row) => columns.map((column) => cell(column, row[column])));
	const widths = headers.map((header, index) =>
		Math.max(header.length, ...body.map((line) => (line[index] ?? '').length))
	);
	const format = (line: readonly string[]) =>
		line
			.map((value, index) => value.padEnd(widths[index] ?? 0))
			.join('  ')
			.trimEnd();
	return [format(headers), ...body.map(format)];
}

/**
 * Up to six columns: identity, then kind and state (top level first, then
 * one nested field per name), then one timestamp, then the API's field order.
 */
function tableColumns(rows: ReadonlyArray<Record<string, unknown>>): string[] {
	const keys: string[] = [];
	for (const row of rows) {
		for (const key of Object.keys(row)) if (!keys.includes(key)) keys.push(key);
	}
	const lastSegment = (key: string) => key.split('.').at(-1) ?? key;
	const nestedSeen = new Set<string>();
	const time = TIME_COLUMNS.find((column) => keys.includes(column));
	const visible = keys.filter((key) => {
		if (HIDDEN_IN_TABLES.has(key) || key.endsWith('_url')) return false;
		if (key.endsWith('_at')) return key === time;
		if (!key.includes('.')) return true;
		const last = lastSegment(key);
		if (!NESTED_COLUMNS.has(last) || nestedSeen.has(last) || keys.includes(last)) return false;
		nestedSeen.add(last);
		return true;
	});
	const rank = (key: string) => {
		const priority = PRIORITY.indexOf(lastSegment(key));
		if (priority >= 0) return priority + (key.includes('.') ? 0.5 : 0);
		return key === time ? PRIORITY.length : PRIORITY.length + 1;
	};
	// Array sort is stable, so equally ranked columns keep the API's field order.
	return [...visible].sort((left, right) => rank(left) - rank(right)).slice(0, MAX_COLUMNS);
}

/** `lifecycle.state` shows as STATE unless another column also ends in `state`. */
function columnHeader(columns: readonly string[]) {
	return (column: string) => {
		const last = column.split('.').at(-1) ?? column;
		const unique = columns.filter((other) => other.split('.').at(-1) === last).length === 1;
		return (unique ? last : column).replace(/[._]/g, ' ').toUpperCase();
	};
}

function keyValues(object: Readonly<Record<string, unknown>>): string[] {
	const entries = Object.entries(flatten(object));
	if (entries.length === 0) return ['Done.'];
	const width = Math.max(...entries.map(([key]) => key.length));
	return entries.map(([key, value]) => `${key.padEnd(width)}  ${cell(key, value, Infinity)}`);
}

/** Lifts one level of nested objects into `parent.child` keys. */
function flatten(object: Readonly<Record<string, unknown>>): Record<string, unknown> {
	const flat: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(object)) {
		if (Predicate.isObject(value) && Object.keys(value).length > 0) {
			for (const [child, nested] of Object.entries(value)) flat[`${key}.${child}`] = nested;
		} else {
			flat[key] = value;
		}
	}
	return flat;
}

function cell(key: string, value: unknown, limit = MAX_CELL): string {
	const text = cellText(key, value);
	return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function cellText(key: string, value: unknown): string {
	if (value === null || value === undefined) return '-';
	if (Predicate.isNumber(value) && key.endsWith('_at')) return timestamp(value);
	if (Array.isArray(value)) {
		if (value.length === 0) return '-';
		return value.every((item) => !Predicate.isObject(item) && !Array.isArray(item))
			? value.map(String).join(', ')
			: `${value.length} items`;
	}
	if (Predicate.isObject(value)) return JSON.stringify(value);
	return String(value);
}

/** API timestamps are Unix seconds; larger values are already milliseconds. */
function timestamp(value: number): string {
	const millis = value > 1e12 ? value : value * 1000;
	const iso = DateTime.formatIso(DateTime.makeUnsafe(millis));
	return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}
