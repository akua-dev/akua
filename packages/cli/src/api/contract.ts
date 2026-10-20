import type { JsonSchema as EffectJsonSchema } from 'effect';

/**
 * The public API contract the CLI executes, as generated from cnap's
 * `docs/openapi-public.json` into `src/generated/contract.gen.ts`.
 *
 * It is the request side of the OpenAPI document only: operations, their
 * parameters, request bodies as JSON Schema (draft 2020-12, `$ref`s point
 * into `definitions`). Responses, including error bodies, are rendered as
 * the JSON the API returns, so their schemas are not carried.
 */
export interface ApiContract {
	readonly resources: readonly ApiResource[];
	/** Every distinct parameter, keyed by `<in>:<name>[:<n>]`, shared by operations. */
	readonly parameters: Readonly<Record<string, ApiParameter>>;
	/** Reachable `components.schemas` entries, referenced as `#/$defs/<name>`. */
	readonly definitions: Readonly<Record<string, JsonSchema>>;
	readonly operations: readonly ApiOperation[];
}

export interface ApiResource {
	/** Command group name, for example `clusters`. */
	readonly name: string;
	readonly title: string;
	readonly description?: string;
}

export type ParameterLocation = 'path' | 'query' | 'header';

export interface ApiParameter {
	readonly name: string;
	readonly in: ParameterLocation;
	readonly required: boolean;
	readonly description?: string;
	readonly schema: JsonSchema;
}

export interface ApiOperation {
	/** OpenAPI operationId `<resource>.<action>`, for example `clusters.createWorkerBootstrap`. */
	readonly id: string;
	readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
	/** OpenAPI path template, for example `/clusters/{id}:resume`. */
	readonly path: string;
	readonly summary: string;
	readonly auth: boolean;
	/** Keys into `ApiContract.parameters`; path parameters come first, in template order. */
	readonly parameters: readonly string[];
	readonly body?: ApiRequestBody;
	/** Present when the success response is a Server-Sent Events stream. */
	readonly stream?: ApiEventStream;
}

export interface ApiRequestBody {
	readonly required: boolean;
	readonly schema: JsonSchema;
}

export interface ApiEventStream {
	/** SSE event name that carries a serialized failure cause. */
	readonly failureEvent: string;
}

export type JsonSchema = EffectJsonSchema.JsonSchema;
