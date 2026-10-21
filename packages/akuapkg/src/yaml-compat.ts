import * as YAML from "yaml"

/**
 * Engine output (Helm, Kustomize) as the previous release read it, so a
 * Package renders the same bytes it did there.
 *
 * - Helm writes Kubernetes YAML with YAML 1.1 scalars, where a leading-zero
 *   integer is octal: a plain mapping value such as `defaultMode: 0755` is the
 *   number 493. Every other leading-zero digit string (`"0755"`, a `0755`
 *   sequence item, `0789`) stays a string, as the previous YAML 1.2 reader
 *   (serde_yaml) kept it; the 1.2 core schema would read it as a decimal.
 * - Mapping keys reach KCL sorted, as the previous JSON bridge delivered them.
 * - Empty documents (`---` separators, `{}`) are dropped.
 */
export const parseEngineManifests = (text: string): Array<unknown> => {
  const documents = YAML.parseAllDocuments(normalizeLegacyOctal(text), {
    customTags: (tags) => [LEADING_ZERO_STRING, ...tags]
  })
  if (!Array.isArray(documents)) return []
  const failed = documents.find((document) => document.errors.length > 0)
  if (failed !== undefined) throw failed.errors[0]
  return documents
    .map((document) => document.toJS())
    .filter((value) => !isEmptyDocument(value))
    .map(sortKeys)
}

/** Leading-zero digit strings that are not numbers in serde_yaml's YAML 1.2. */
const LEADING_ZERO_STRING: YAML.ScalarTag = {
  tag: "tag:yaml.org,2002:str",
  default: true,
  identify: () => false,
  test: /^[-+]?0[0-9]+$/,
  resolve: (value) => value
}

const isEmptyDocument = (value: unknown) =>
  value === null || value === undefined ||
  (typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0)

/** Mapping keys sorted by code unit, recursively; sequences keep their order. */
export const sortKeys = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(sortKeys)
    : value !== null && typeof value === "object"
    ? Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => [key, sortKeys(entry)])
    )
    : value

/**
 * Rewrite plain mapping values that are YAML 1.1 octal integers (`0755`) as
 * decimal (`493`). Quoted values, sequence items and block-scalar content
 * keep their text.
 */
export const normalizeLegacyOctal = (text: string): string => {
  let blockScalarIndent: number | undefined
  return text.split(/(?<=\n)/).map((lineWithEnding) => {
    const line = lineWithEnding.replace(/\r?\n$/, "")
    const ending = lineWithEnding.slice(line.length)
    const indent = line.length - line.replace(/^ +/, "").length

    if (blockScalarIndent !== undefined) {
      if (line.trim() === "" || indent > blockScalarIndent) return lineWithEnding
      blockScalarIndent = undefined
    }
    const valueStart = mappingValueStart(line)
    if (valueStart === undefined) return lineWithEnding
    const value = line.slice(valueStart)
    const trimmed = value.trimStart()
    if (trimmed.startsWith("|") || trimmed.startsWith(">")) {
      blockScalarIndent = indent
      return lineWithEnding
    }
    const octal = /^([-+]?)0([0-7]+)(?=$|[ \t#,\]}])/.exec(trimmed)
    if (octal === null) return lineWithEnding
    const [token, sign, digits] = octal
    const number = (sign === "-" ? -1 : 1) * Number.parseInt(digits ?? "", 8)
    const leading = value.length - trimmed.length
    return `${line.slice(0, valueStart + leading)}${number}${trimmed.slice(token.length)}${ending}`
  }).join("")
}

/** Index just past a mapping key's `:` (outside quotes), if the line has one. */
const mappingValueStart = (line: string): number | undefined => {
  let singleQuoted = false
  let doubleQuoted = false
  let escaped = false
  for (let index = 0; index < line.length; index++) {
    const char = line[index]
    if (doubleQuoted) {
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === "\"") doubleQuoted = false
      continue
    }
    if (singleQuoted) {
      if (char === "'") singleQuoted = false
      continue
    }
    if (char === "\"") doubleQuoted = true
    else if (char === "'") singleQuoted = true
    else if (char === ":" && (index + 1 === line.length || /\s/.test(line[index + 1] ?? ""))) return index + 1
  }
  return undefined
}
