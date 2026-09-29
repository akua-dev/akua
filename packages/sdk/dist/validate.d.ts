import type { StandardSchemaV1 } from '@standard-schema/spec';
import { AkuaError } from './errors';
import akuaSchema from './schemas/akua.json';
export type SchemaName = keyof typeof akuaSchema.$defs & string;
export declare class AkuaContractError extends AkuaError {
    readonly schemaName: SchemaName;
    readonly validationErrors: ReadonlyArray<object>;
    readonly raw: unknown;
    constructor(schemaName: SchemaName, validationErrors: ReadonlyArray<object>, raw: unknown);
}
export declare function validateAs<T>(schemaName: SchemaName, value: unknown): T;
export declare function standardSchemaFor<T>(schemaName: SchemaName): StandardSchemaV1<unknown, T>;
