import { Effect, Predicate, Schema } from "effect"
import YAML from "yaml"
import { kclIdent } from "./manifest"
import { resolveInSnapshot, type Snapshot } from "./snapshot.effect"
import { kclStringLiteral } from "./values-schema"

/**
 * Typed KCL schemas from the CustomResourceDefinitions in a dependency
 * (`crds = ...` in `akua.toml`): one KCL package per served group/version,
 * one schema per kind, imported as `crds.<dep>.<group>.<version>`. The
 * openAPIV3Schema becomes closed KCL schemas, so an unknown field, a wrong
 * type, a missing required field or a value outside an enum is a compile
 * error in the consumer's `package.k`.
 *
 * Only YAML is parsed: chart templates are read with their template
 * actions removed, never executed. Output depends only on the input bytes,
 * so it is deterministic and safe to regenerate on every render.
 */

/** Bumped whenever the generated KCL changes for the same CRDs. */
export const CRD_CONVERTER_VERSION = "1"

export class CrdsInvalid extends Schema.TaggedError<CrdsInvalid>()("CrdsInvalid", {
  message: Schema.String
}) {}

interface OpenApi {
  readonly type?: string
  readonly description?: string
  readonly properties?: Readonly<Record<string, OpenApi>>
  readonly required?: ReadonlyArray<string>
  readonly items?: OpenApi
  readonly additionalProperties?: OpenApi | boolean
  readonly enum?: ReadonlyArray<unknown>
  readonly nullable?: boolean
  readonly "x-kubernetes-int-or-string"?: boolean
  readonly "x-kubernetes-preserve-unknown-fields"?: boolean
  readonly "x-kubernetes-embedded-resource"?: boolean
}

const OpenApiShape: Schema.Codec<OpenApi> = Schema.Struct({
  type: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  properties: Schema.optionalKey(Schema.Record(Schema.String, Schema.suspend((): Schema.Codec<OpenApi> => OpenApiShape))),
  required: Schema.optionalKey(Schema.Array(Schema.String)),
  items: Schema.optionalKey(Schema.suspend((): Schema.Codec<OpenApi> => OpenApiShape)),
  additionalProperties: Schema.optionalKey(
    Schema.Union([Schema.Boolean, Schema.suspend((): Schema.Codec<OpenApi> => OpenApiShape)])
  ),
  enum: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  nullable: Schema.optionalKey(Schema.Boolean),
  "x-kubernetes-int-or-string": Schema.optionalKey(Schema.Boolean),
  "x-kubernetes-preserve-unknown-fields": Schema.optionalKey(Schema.Boolean),
  "x-kubernetes-embedded-resource": Schema.optionalKey(Schema.Boolean)
})

const Validation = Schema.Struct({ openAPIV3Schema: Schema.optionalKey(OpenApiShape) })

/** The parts of an `apiextensions.k8s.io/v1` (or legacy `v1beta1`) CustomResourceDefinition read here. */
const CrdShape = Schema.Struct({
  metadata: Schema.optionalKey(Schema.Struct({ name: Schema.optionalKey(Schema.String) })),
  spec: Schema.Struct({
    group: Schema.String,
    names: Schema.Struct({ kind: Schema.String }),
    version: Schema.optionalKey(Schema.String),
    validation: Schema.optionalKey(Validation),
    versions: Schema.optionalKey(Schema.Array(Schema.Struct({
      name: Schema.String,
      served: Schema.optionalKey(Schema.Boolean),
      deprecated: Schema.optionalKey(Schema.Boolean),
      deprecationWarning: Schema.optionalKey(Schema.String),
      schema: Schema.optionalKey(Validation)
    })))
  })
})

const decodeCrd = Schema.decodeUnknownEffect(CrdShape)

/** One served version of one kind: what a generated schema is made from. */
interface CrdVersion {
  readonly group: string
  readonly version: string
  readonly kind: string
  /** The CRD's `metadata.name`, for the file header. */
  readonly crd: string
  /** Where the document was found, for conflict reports. */
  readonly file: string
  readonly deprecated: boolean
  readonly deprecationWarning: string | undefined
  readonly schema: OpenApi | undefined
}

const decoder = new TextDecoder()
const encoder = new TextEncoder()

const isManifestFile = (name: string) => /\.(ya?ml|json)$/i.test(name)

/**
 * The files `crds` selects: a file, or every manifest under a directory
 * (`.` for the whole tree). `undefined` when it names nothing.
 */
const selectFiles = (files: Snapshot, selector: string): ReadonlyArray<string> | undefined => {
  const normalized = resolveInSnapshot(selector)
  if (normalized === undefined) return undefined
  if (normalized !== "" && files.has(normalized)) return [normalized]
  const prefix = normalized === "" ? "" : `${normalized}/`
  const selected = Array.from(files.keys())
    .filter((name) => name.startsWith(prefix) && isManifestFile(name))
    .toSorted()
  return selected.length === 0 && normalized !== "" ? undefined : selected
}

/**
 * A file under a chart's `templates/` (a `Chart.yaml` beside that
 * directory): Go template actions are removed, so the YAML around them
 * parses. Nothing is executed.
 */
const isChartTemplate = (files: Snapshot, name: string) => {
  const segments = name.split("/")
  const index = segments.lastIndexOf("templates")
  if (index < 0 || index === segments.length - 1) return false
  const chart = segments.slice(0, index).join("/")
  return files.has(chart === "" ? "Chart.yaml" : `${chart}/Chart.yaml`)
}

const withoutTemplateActions = (text: string) => text.replace(/\{\{[\s\S]*?\}\}/g, "")

/** Kubernetes objects in a manifest file, `List` items flattened; unparsable documents are skipped. */
const objectsIn = (text: string): ReadonlyArray<unknown> => {
  const out: Array<unknown> = []
  const push = (value: unknown) => {
    if (Predicate.hasProperty(value, "kind") && value.kind === "List" && Predicate.hasProperty(value, "items")) {
      if (Array.isArray(value.items)) for (const item of value.items) out.push(item)
      return
    }
    out.push(value)
  }
  for (const document of YAML.parseAllDocuments(text, { uniqueKeys: false })) {
    if (document.errors.length > 0) continue
    const value: unknown = document.toJS({ maxAliasCount: 100 })
    if (Array.isArray(value)) value.forEach(push)
    else push(value)
  }
  return out
}

const isCrd = (value: unknown) =>
  Predicate.hasProperty(value, "kind") && value.kind === "CustomResourceDefinition" &&
  Predicate.hasProperty(value, "apiVersion") && Predicate.isString(value.apiVersion) &&
  value.apiVersion.startsWith("apiextensions.k8s.io/")

/** Every served version of every CRD the selector reaches, deduplicated, sorted by group, version and kind. */
export const extractCrds = Effect.fn("extractCrds")(function*(files: Snapshot, selector: string) {
  const selected = selectFiles(files, selector)
  if (selected === undefined) {
    return yield* new CrdsInvalid({ message: `\`crds = "${selector}"\` names no file or directory in the dependency` })
  }
  const found = new Map<string, { readonly version: CrdVersion; readonly canonical: string }>()
  for (const file of selected) {
    const raw = decoder.decode(files.get(file) ?? new Uint8Array())
    const text = isChartTemplate(files, file) ? withoutTemplateActions(raw) : raw
    for (const value of objectsIn(text).filter(isCrd)) {
      const crd = yield* decodeCrd(value).pipe(
        Effect.mapError((error) => new CrdsInvalid({ message: `${file}: malformed CustomResourceDefinition: ${error.message}` }))
      )
      const { spec } = crd
      const versions = spec.versions ??
        (spec.version === undefined ? [] : [{ name: spec.version, schema: spec.validation }])
      for (const entry of versions) {
        if ("served" in entry && entry.served === false) continue
        const version: CrdVersion = {
          group: spec.group,
          version: entry.name,
          kind: spec.names.kind,
          crd: crd.metadata?.name ?? `${spec.names.kind}.${spec.group}`,
          file,
          deprecated: "deprecated" in entry && entry.deprecated === true,
          deprecationWarning: "deprecationWarning" in entry ? entry.deprecationWarning : undefined,
          schema: entry.schema?.openAPIV3Schema ?? spec.validation?.openAPIV3Schema
        }
        const key = `${version.group}/${version.version}/${version.kind}`
        const canonical = JSON.stringify(sortKeys(version.schema ?? null))
        const prior = found.get(key)
        if (prior === undefined) found.set(key, { version, canonical })
        else if (prior.canonical !== canonical) {
          return yield* new CrdsInvalid({
            message: `conflicting definitions of ${version.kind} (${version.group}/${version.version}) in ` +
              `${prior.version.file} and ${file} - narrow \`crds\` to one of them`
          })
        }
      }
    }
  }
  if (found.size === 0) {
    return yield* new CrdsInvalid({
      message: `no CustomResourceDefinition found in ${selected.length} manifest file(s) under \`${selector}\``
    })
  }
  return Array.from(found.values(), ({ version }) => version).toSorted((a, b) =>
    compare(a.group, b.group) || compare(a.version, b.version) || compare(a.kind, b.kind)
  )
})

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

const sortKeys = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(sortKeys)
    : Predicate.isObject(value)
    ? Object.fromEntries(Object.entries(value).toSorted(([a], [b]) => compare(a, b)).map(([k, v]) => [k, sortKeys(v)]))
    : value

/** `cert-manager.io` as a KCL package segment: `cert_manager_io`. */
export const groupIdent = (group: string) => kclIdent(group.toLowerCase())

/** `CertificateRequest` as a file name: `certificate_request`. */
const snakeCase = (kind: string) =>
  kind.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2").toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")

/** The import path of a generated group/version package. */
export const crdModulePath = (dependency: string, group: string, version: string) =>
  `crds.${kclIdent(dependency)}.${groupIdent(group)}.${kclIdent(version)}`

/** KCL keywords: attribute names that need a `$` prefix. */
const KEYWORDS = new Set([
  "True",
  "False",
  "None",
  "Undefined",
  "import",
  "as",
  "rule",
  "schema",
  "mixin",
  "protocol",
  "check",
  "for",
  "assert",
  "if",
  "elif",
  "else",
  "or",
  "and",
  "not",
  "in",
  "is",
  "lambda",
  "all",
  "any",
  "filter",
  "map",
  "type"
])

/** An attribute name as KCL spells it: bare, `$keyword`, or a quoted string. */
const attributeName = (name: string) =>
  !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? kclStringLiteral(name) : KEYWORDS.has(name) ? `$${name}` : name

/** `replicaCount` / `x-foo.bar` to `ReplicaCount` / `XFooBar`, always an identifier. */
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

/**
 * A raw docstring: no escapes or `${}` interpolation inside, and nothing that
 * could close it early (the text is the CRD author's).
 */
const docstring = (text: string, indent: string) => {
  let body = text.trim().replaceAll("\"\"\"", "'''")
  if (body === "") return ""
  if (/["\\]$/.test(body)) body += " "
  if (body.startsWith("\"")) body = ` ${body}`
  const lines = body.split(/\r?\n/)
  return lines.length === 1
    ? `${indent}r"""${body}"""\n`
    : `${indent}r"""\n${lines.map((line) => (line.trim() === "" ? "" : `${indent}${line.trimEnd()}`)).join("\n")}\n${indent}"""\n`
}

const META_IMPORT = "_metav1"

/**
 * One group/version package: the schemas of its kinds, named after the
 * kind and the property path, unique within the package.
 */
class PackageEmitter {
  private readonly names = new Set<string>()

  /** A schema name not used yet in this package. */
  unique(name: string) {
    let candidate = name
    for (let suffix = 2; this.names.has(candidate) || KEYWORDS.has(candidate); suffix++) candidate = `${name}${suffix}`
    this.names.add(candidate)
    return candidate
  }

  /** The schemas of one kind, its root first: the contents of `<kind>.k`. */
  kind(version: CrdVersion, metaModule: string) {
    const blocks: Array<string> = []
    const name = this.unique(pascalCase(version.kind))
    const root = version.schema ?? {}
    const apiVersion = kclStringLiteral(`${version.group}/${version.version}`)
    const kind = kclStringLiteral(version.kind)
    let body = `schema ${name}:\n`
    const description = [
      root.description ?? "",
      version.deprecated ? `Deprecated: ${version.deprecationWarning ?? `${version.group}/${version.version} is deprecated`}` : ""
    ].filter((line) => line !== "").join("\n\n")
    body += docstring(description, "    ")
    body += `    apiVersion: ${apiVersion} = ${apiVersion}\n`
    body += `    kind: ${kind} = ${kind}\n`
    body += `    metadata?: ${META_IMPORT}.ObjectMeta\n`
    const reserved = new Set(["apiVersion", "kind", "metadata", "status"])
    const required = new Set(root.required ?? [])
    const index = blocks.push("") - 1
    for (const [property, schema] of sortedEntries(root.properties ?? {})) {
      if (reserved.has(property)) continue
      body += this.attribute(property, schema, required.has(property), `${name}${pascalCase(property)}`, blocks)
    }
    if (version.schema === undefined || openEnded(root)) body += `    [...str]: any\n`
    blocks[index] = body
    return `# Generated by akuapkg from the CustomResourceDefinition \`${version.crd}\`. Do not edit.\n` +
      `import ${metaModule} as ${META_IMPORT}\n\n` + blocks.join("\n")
  }

  private attribute(property: string, schema: OpenApi, required: boolean, hint: string, blocks: Array<string>) {
    const optional = !required || schema.nullable === true ? "?" : ""
    return `    ${attributeName(property)}${optional}: ${this.type(schema, hint, blocks)}\n` +
      docstring(schema.description ?? "", "    ")
  }

  private type(schema: OpenApi, hint: string, blocks: Array<string>): string {
    if (schema["x-kubernetes-int-or-string"] === true) return "int | str"
    const literals = enumLiterals(schema)
    if (literals !== undefined) return literals
    switch (schema.type) {
      case "string":
        return "str"
      case "integer":
        return "int"
      case "number":
        return "float"
      case "boolean":
        return "bool"
      case "array":
        return `[${schema.items === undefined ? "any" : this.type(schema.items, `${hint}Item`, blocks)}]`
      case "object":
      case undefined:
        return this.object(schema, hint, blocks)
      default:
        return "any"
    }
  }

  private object(schema: OpenApi, hint: string, blocks: Array<string>) {
    const properties = sortedEntries(schema.properties ?? {})
    const additional = schema.additionalProperties
    if (properties.length === 0) {
      if (Predicate.isObject(additional)) return `{str:${this.type(additional, `${hint}Value`, blocks)}}`
      if (schema.type === undefined && schema["x-kubernetes-preserve-unknown-fields"] !== true) return "any"
      return "{str:any}"
    }
    const name = this.unique(hint)
    const index = blocks.push("") - 1
    const required = new Set(schema.required ?? [])
    let body = `schema ${name}:\n${docstring(schema.description ?? "", "    ")}`
    for (const [property, propertySchema] of properties) {
      body += this.attribute(property, propertySchema, required.has(property), `${name}${pascalCase(property)}`, blocks)
    }
    if (Predicate.isObject(additional)) body += `    [...str]: ${this.type(additional, `${name}Value`, blocks)}\n`
    else if (openEnded(schema)) body += "    [...str]: any\n"
    blocks[index] = body
    return name
  }
}

/** Fields beyond the declared properties are kept by the API server. */
const openEnded = (schema: OpenApi) =>
  schema["x-kubernetes-preserve-unknown-fields"] === true || schema["x-kubernetes-embedded-resource"] === true ||
  schema.additionalProperties === true

/** An enum of strings or integers as a KCL literal union. */
const enumLiterals = (schema: OpenApi): string | undefined => {
  const values = (schema.enum ?? []).filter((value) => value !== null)
  if (values.length === 0) return undefined
  if (schema.type === "string" && values.every(Predicate.isString)) {
    return Array.from(new Set(values), kclStringLiteral).join(" | ")
  }
  if (schema.type === "integer" && values.every((value) => Predicate.isNumber(value) && Number.isInteger(value))) {
    return Array.from(new Set(values), String).join(" | ")
  }
  return undefined
}

const sortedEntries = <A>(record: Readonly<Record<string, A>>): ReadonlyArray<readonly [string, A]> =>
  Object.entries(record).toSorted(([a], [b]) => compare(a, b))

/**
 * `meta/v1`: the ObjectMeta every generated kind's `metadata` has. Its own,
 * so the schemas need no other dependency; the list fields controllers own
 * are untyped, so a `k8s` ObjectMeta value fits as `{**meta}`.
 */
const OBJECT_META = `# Generated by akuapkg: Kubernetes object metadata (meta/v1). Do not edit.

schema ObjectMeta:
    r"""Standard object metadata of every Kubernetes resource."""
    annotations?: {str:str}
    creationTimestamp?: str
    deletionGracePeriodSeconds?: int
    deletionTimestamp?: str
    finalizers?: [str]
    generateName?: str
    generation?: int
    labels?: {str:str}
    managedFields?: [any]
    name?: str
    namespace?: str
    ownerReferences?: [any]
    resourceVersion?: str
    selfLink?: str
    uid?: str
`

/** A generated group/version package, for reports. */
export interface CrdModule {
  readonly module: string
  readonly kinds: ReadonlyArray<string>
}

/**
 * The generated tree of dependency `dependency`, keyed relative to its
 * directory in the `crds` package (`crds/<ident>/`): `meta/v1/` plus
 * `<group>/<version>/<kind>.k` for every served version.
 */
export const crdSchemaTree = Effect.fn("crdSchemaTree")(function*(dependency: string, files: Snapshot, selector: string) {
  const versions = yield* extractCrds(files, selector)
  const ident = kclIdent(dependency)
  const metaModule = `crds.${ident}.meta.v1`
  const tree = new Map<string, Uint8Array>([["meta/v1/object_meta.k", encoder.encode(OBJECT_META)]])
  const modules = new Map<string, Array<string>>()
  const emitters = new Map<string, PackageEmitter>()
  for (const version of versions) {
    const directory = `${groupIdent(version.group)}/${kclIdent(version.version)}`
    const emitter = emitters.get(directory) ?? new PackageEmitter()
    emitters.set(directory, emitter)
    let file = `${directory}/${snakeCase(version.kind)}.k`
    for (let suffix = 2; tree.has(file); suffix++) file = `${directory}/${snakeCase(version.kind)}_${suffix}.k`
    tree.set(file, encoder.encode(emitter.kind(version, metaModule)))
    const module = crdModulePath(dependency, version.group, version.version)
    modules.set(module, [...(modules.get(module) ?? []), version.kind])
  }
  return {
    files: tree satisfies Snapshot,
    modules: Array.from(modules, ([module, kinds]): CrdModule => ({ module, kinds })).toSorted((a, b) =>
      compare(a.module, b.module)
    )
  }
})
