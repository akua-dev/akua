import type { AkuaCliError, NextStep } from './errors';
import { humanData, humanNextSteps, humanStreamItem } from './human';
import type { OutputMode } from './mode';
import type * as Stream from 'effect/Stream';

export interface RenderEnvelope<StreamFailure = never> {
	command: string;
	status?: 'ok';
	observations?: readonly string[];
	data?: unknown;
	stream?: Stream.Stream<unknown, StreamFailure, never>;
	next_steps?: readonly NextStep[];
	/** Lines a person reads instead of `observations` and `data`; never part of JSON or agent output. */
	human?: readonly string[];
}

export function renderStreamSuccess(
	envelope: RenderEnvelope<unknown>,
	data: unknown,
	mode: OutputMode
): string {
	if (mode === 'quiet') return '';
	const item: RenderEnvelope = {
		status: 'ok',
		command: envelope.command,
		data
	};
	if (mode === 'json') return `${JSON.stringify(item)}\n`;
	return mode === 'human' ? humanStreamItem(data) : renderSuccess(item, mode);
}

export function renderSuccess(envelope: RenderEnvelope<unknown>, mode: OutputMode): string {
	if (mode === 'quiet') {
		return '';
	}

	const payload: RenderEnvelope = {
		status: 'ok',
		command: envelope.command,
		observations: envelope.observations,
		data: envelope.data,
		next_steps: envelope.next_steps,
		human: envelope.human
	};
	if (mode === 'json') {
		return `${JSON.stringify({ ...payload, human: undefined }, null, 2)}\n`;
	}
	if (mode === 'agent') {
		return renderToon({ ...payload, human: undefined });
	}

	return renderHuman(payload);
}

export function renderError(error: AkuaCliError, mode: OutputMode): string {
	const payload = error.toPayload();
	if (mode === 'quiet') {
		return '';
	}
	if (mode === 'json') {
		return `${JSON.stringify(payload, null, 2)}\n`;
	}
	if (mode === 'agent') {
		return renderToon(payload);
	}

	const lines = [`Error: ${error.message}`];
	if (error.requestId) {
		lines.push(`Request ID: ${error.requestId}`);
	}
	lines.push(...humanNextSteps(error.nextSteps));
	return `${lines.join('\n')}\n`;
}

export function renderToon(value: unknown): string {
	return `${renderValue(value, 0).join('\n')}\n`;
}

function renderHuman(envelope: RenderEnvelope<unknown>): string {
	const lines = [
		...(envelope.human ?? [...(envelope.observations ?? []), ...humanData(envelope.data)]),
		...humanNextSteps(envelope.next_steps ?? [])
	];
	return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

function renderValue(value: unknown, indent: number, key?: string): string[] {
	const prefix = ' '.repeat(indent);
	if (value === undefined) {
		return [];
	}
	if (value === null || typeof value !== 'object') {
		return [`${prefix}${key ? `${key}: ` : ''}${String(value)}`];
	}
	if (Array.isArray(value)) {
		return renderArray(value, indent, key);
	}

	const lines: string[] = [];
	if (key) {
		lines.push(`${prefix}${key}:`);
	}
	if (isRecord(value)) {
		for (const [childKey, childValue] of Object.entries(value)) {
			lines.push(...renderValue(childValue, key ? indent + 2 : indent, childKey));
		}
	}
	return lines;
}

function renderArray(values: readonly unknown[], indent: number, key = 'items'): string[] {
	const prefix = ' '.repeat(indent);
	if (values.length === 0) {
		return [`${prefix}${key}[0]:`];
	}

	const rows = values.filter(isRecord);
	if (rows.length === values.length) {
		const keys = Object.keys(rows[0] ?? {}).filter((candidate) =>
			rows.every(
				(row) =>
					row[candidate] === undefined ||
					row[candidate] === null ||
					typeof row[candidate] !== 'object'
			)
		);
		if (keys.length > 0) {
			return [
				`${prefix}${key}[${rows.length}]{${keys.join(',')}}:`,
				...rows.map((row) => `${prefix}  ${keys.map((field) => escapeCell(row[field])).join(',')}`)
			];
		}
	}

	return [
		`${prefix}${key}[${values.length}]:`,
		...values.map((item) => `${prefix}  ${String(item)}`)
	];
}

function escapeCell(value: unknown): string {
	if (value === undefined || value === null) {
		return '';
	}
	const text = String(value);
	if (/[\n,]/.test(text)) {
		return JSON.stringify(text);
	}
	return text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}
