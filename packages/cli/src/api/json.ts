import { Schema } from 'effect';

/** A JSON object, the shape of every request partition. */
export const JsonRecord = Schema.Record(Schema.String, Schema.Json);
export type JsonRecord = typeof JsonRecord.Type;
export const asJsonRecord = Schema.decodeUnknownOption(JsonRecord);

/** JSON text to a JSON value. */
export const JsonText = Schema.fromJsonString(Schema.Json);
export const decodeJsonText = Schema.decodeEffect(JsonText);
export const decodeJsonTextOption = Schema.decodeOption(JsonText);
