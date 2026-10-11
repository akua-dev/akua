import { Effect, Predicate, Schema } from "effect"

/**
 * A chart's `values.schema.json` as a typed KCL `schema Values` (plus one
 * schema per nested object), so `charts.<name>.Values { ... }` checks values
 * at the call site. The previous release's generator: objects, primitives,
 * arrays and enums; `$ref`, `allOf`/`oneOf`/`anyOf`, `pattern` and `format`
 * collapse to `any`.
 */

export class ValuesSchemaInvalid extends Schema.TaggedError<ValuesSchemaInvalid>()("ValuesSchemaInvalid", {
  message: Schema.String
}) {}

interface JsonSchema {
  readonly type?: string | ReadonlyArray<string>
  readonly properties?: Readonly<Record<string, JsonSchema>>
  readonly required?: ReadonlyArray<string>
  readonly items?: JsonSchema
  readonly default?: unknown
  readonly description?: string
}

const JsonSchemaShape: Schema.Codec<JsonSchema> = Schema.Struct({
  type: Schema.optionalKey(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
  properties: Schema.optionalKey(Schema.Record(Schema.String, Schema.suspend((): Schema.Codec<JsonSchema> => JsonSchemaShape))),
  required: Schema.optionalKey(Schema.Array(Schema.String)),
  items: Schema.optionalKey(Schema.suspend((): Schema.Codec<JsonSchema> => JsonSchemaShape)),
  default: Schema.optionalKey(Schema.Unknown),
  description: Schema.optionalKey(Schema.String)
})

const decodeSchema = Schema.decodeUnknownEffect(Schema.fromJsonString(JsonSchemaShape))

/**
 * The generated KCL source, or `undefined` when the root is not an object
 * (Helm values are always a dict, so the chart has no usable schema).
 */
export const valuesSchemaKcl = Effect.fn("valuesSchemaKcl")(function*(text: string) {
  const root = yield* decodeSchema(text).pipe(
    Effect.mapError((error) => new ValuesSchemaInvalid({ message: `values.schema.json not valid JSON: ${error.message}` }))
  )
  if (primaryType(root.type) !== "object") return undefined
  const schemas: Array<string> = []
  yield* emitObject(root, "Values", schemas)
  return schemas.join("\n")
})

const members = (type: JsonSchema["type"]): ReadonlyArray<string> =>
  type === undefined ? [] : typeof type === "string" ? [type] : type

const primaryType = (type: JsonSchema["type"]) => members(type).find((member) => member !== "null") ?? ""

const sortedEntries = <A>(record: Readonly<Record<string, A>>): ReadonlyArray<readonly [string, A]> =>
  Object.entries(record).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))

const emitObject = (schema: JsonSchema, name: string, out: Array<string>): Effect.Effect<void, ValuesSchemaInvalid> =>
  Effect.gen(function*() {
    let body = `schema ${name}:\n`
    if (schema.description !== undefined) body += `${docstring(schema.description, 4)}\n`
    const properties = sortedEntries(schema.properties ?? {})
    if (properties.length === 0) {
      // A schema body needs one statement; the wildcard keeps `{}` constructible.
      out.push(`${body}    _: any = None\n\n`)
      return
    }
    const required = new Set(schema.required ?? [])
    for (const [property, propertySchema] of properties) {
      // Emitted verbatim into the schema body: anything but an identifier could inject KCL.
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(property)) {
        return yield* new ValuesSchemaInvalid({
          message: `values.schema.json property name is not a valid KCL identifier: ${JSON.stringify(property)}`
        })
      }
      const type = yield* renderType(`${name}${pascalCase(property)}`, propertySchema, out)
      const nullable = typeof propertySchema.type !== "string" && members(propertySchema.type).includes("null")
      const fallback = defaultLiteral(propertySchema)
      const optional = nullable || !(required.has(property) || fallback !== undefined) ? "?" : ""
      body += `    ${property}${optional}: ${type}${fallback === undefined ? "" : ` = ${fallback}`}\n`
      if (propertySchema.description !== undefined) body += `${docstring(propertySchema.description, 4)}\n`
    }
    // After the nested schemas it names, as the previous release emitted them.
    out.push(`${body}\n`)
  })

const renderType = (name: string, schema: JsonSchema, out: Array<string>): Effect.Effect<string, ValuesSchemaInvalid> =>
  Effect.gen(function*() {
    const nonNull = members(schema.type).filter((member) => member !== "null")
    if (typeof schema.type !== "string" && nonNull.length > 1) {
      if (nonNull.some((member) => member === "object" || member === "array")) return "any"
      return nonNull.map(primitive).join(" | ")
    }
    switch (primaryType(schema.type)) {
      case "object":
        yield* emitObject(schema, name, out)
        return name
      case "array":
        return `[${schema.items === undefined ? "any" : yield* renderType(`${name}Item`, schema.items, out)}]`
      default:
        return primitive(primaryType(schema.type))
    }
  })

const PRIMITIVES: ReadonlyMap<string, string> = new Map([
  ["string", "str"],
  ["integer", "int"],
  ["number", "float"],
  ["boolean", "bool"]
])

const primitive = (type: string) => PRIMITIVES.get(type) ?? "any"

/** The `default` as a KCL literal, when it fits one of the declared types. */
const defaultLiteral = (schema: JsonSchema): string | undefined => {
  if (!("default" in schema)) return undefined
  const value = schema.default
  if (schema.type === undefined) return kclLiteral(value)
  for (const type of members(schema.type)) {
    const literal = defaultForType(value, type)
    if (literal !== undefined) return literal
  }
  return undefined
}

const KNOWN_TYPES = new Set(["null", "boolean", "string", "integer", "number", "array", "object"])

const defaultForType = (value: unknown, type: string): string | undefined => {
  switch (type) {
    case "boolean":
      return Predicate.isBoolean(value) ? kclLiteral(value) : undefined
    case "string":
      return Predicate.isString(value) ? kclLiteral(value) : undefined
    case "integer":
      return Predicate.isNumber(value) && Number.isInteger(value) ? value.toFixed(0) : undefined
    case "number":
      return Predicate.isNumber(value) ? kclLiteral(value) : undefined
    default:
      return KNOWN_TYPES.has(type) ? undefined : kclLiteral(value)
  }
}

const kclLiteral = (value: unknown): string | undefined => {
  if (value === null) return "None"
  if (Predicate.isBoolean(value)) return value ? "True" : "False"
  if (Predicate.isNumber(value)) return String(value)
  if (Predicate.isString(value)) return kclStringLiteral(value)
  if (Array.isArray(value)) {
    const items = value.map(kclLiteral)
    return items.every(Predicate.isString) ? `[${items.join(", ")}]` : undefined
  }
  if (Predicate.isObject(value)) {
    const entries: Array<string> = []
    for (const [key, entry] of sortedEntries(value)) {
      const literal = kclLiteral(entry)
      if (literal === undefined) return undefined
      entries.push(`${kclStringLiteral(key)}: ${literal}`)
    }
    return `{${entries.join(", ")}}`
  }
  return undefined
}

/** A KCL string literal: `\`, `"`, newline, carriage return and tab escaped. */
export const kclStringLiteral = (value: string) =>
  `"${
    value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"").replaceAll("\n", "\\n").replaceAll("\r", "\\r")
      .replaceAll("\t", "\\t")
  }"`

/**
 * A docstring under a field. The text is the chart's, so every quote that
 * could form or extend a `"""` delimiter is escaped: no breaking out.
 */
const docstring = (text: string, indent: number) => {
  const pad = " ".repeat(indent)
  const trimmed = neutralizeTripleQuotes(text.trim())
  return trimmed.includes("\n")
    ? `${pad}"""\n${trimmed.split("\n").map((line) => `${pad}${line}`).join("\n")}\n${pad}"""`
    : `${pad}"""${trimmed}"""`
}

const neutralizeTripleQuotes = (text: string) => {
  const chars = Array.from(text)
  return chars.map((char, index) => {
    if (char !== "\"") return char
    const run = chars[index - 1] === "\"" || chars[index + 1] === "\""
    const edge = index === 0 || index === chars.length - 1
    return run || edge ? "\\\"" : char
  }).join("")
}

/** `replicaCount` / `image_pull_policy` to `ReplicaCount` / `ImagePullPolicy`, always an identifier. */
const pascalCase = (text: string) => {
  let out = ""
  let capitalize = true
  for (const char of text) {
    if (/[A-Za-z0-9]/.test(char)) {
      out += capitalize ? char.toUpperCase() : char
      capitalize = false
    } else {
      capitalize = true
    }
  }
  return out === "" ? "_" : /^[0-9]/.test(out) ? `_${out}` : out
}
