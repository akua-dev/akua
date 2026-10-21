/**
 * TOML as the previous release wrote `akua.toml` and `akua.lock`
 * (`toml::to_string_pretty`, toml 1.1 / toml_writer 1.1), so rewritten files
 * stay byte-identical: one section per table in the order tables are met,
 * a table's own values before its subtables, arrays of two or more values one
 * per line, and strings and keys in the encoder's preferred style.
 */

export type TomlValue = string | number | boolean | ReadonlyArray<string>

/** Entries in field order; `undefined` values are left out. */
export type TomlEntries = ReadonlyArray<readonly [string, TomlValue | TomlTable | TomlTables | undefined]>

export interface TomlTable {
  readonly _tag: "Table"
  readonly entries: TomlEntries
}

/** An array of tables (`[[name]]`). */
export interface TomlTables {
  readonly _tag: "Tables"
  readonly tables: ReadonlyArray<TomlTable>
}

export const table = (entries: TomlEntries): TomlTable => ({ _tag: "Table", entries })
export const tables = (list: ReadonlyArray<TomlTable>): TomlTables => ({ _tag: "Tables", tables: list })

const isControl = (code: number) => (code <= 0x1f && code !== 0x09) || code === 0x7f

interface Metrics {
  readonly maxSingleQuotes: number
  readonly maxDoubleQuotes: number
  /** A control character other than tab and newline. */
  readonly escapeCodes: boolean
  /** A backslash. */
  readonly escape: boolean
  readonly newline: boolean
}

const metrics = (value: string): Metrics => {
  let maxSingleQuotes = 0
  let maxDoubleQuotes = 0
  let singles = 0
  let doubles = 0
  let escapeCodes = false
  let escape = false
  let newline = false
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    singles = code === 0x27 ? singles + 1 : 0
    doubles = code === 0x22 ? doubles + 1 : 0
    maxSingleQuotes = Math.max(maxSingleQuotes, singles)
    maxDoubleQuotes = Math.max(maxDoubleQuotes, doubles)
    if (code === 0x5c) escape = true
    else if (code === 0x0a) newline = true
    else if (isControl(code)) escapeCodes = true
  }
  return { maxSingleQuotes, maxDoubleQuotes, escapeCodes, escape, newline }
}

const ESCAPES: Readonly<Record<number, string>> = { 0x08: "\\b", 0x09: "\\t", 0x0c: "\\f", 0x0d: "\\r", 0x5c: "\\\\" }

/** A basic string body: at most `maxQuotes` consecutive `"` stay as they are. */
const escapeBasic = (value: string, multiline: boolean) => {
  const maxQuotes = multiline ? 2 : 0
  let out = ""
  let quotes = 0
  for (const character of value) {
    const code = character.charCodeAt(0)
    quotes = code === 0x22 ? quotes + 1 : 0
    if (code === 0x22) out += quotes > maxQuotes ? "\\\"" : "\""
    else if (code === 0x0a) out += multiline ? "\n" : "\\n"
    else if (ESCAPES[code] !== undefined) out += ESCAPES[code]
    else if (code <= 0x1f || code === 0x7f) out += `\\u${code.toString(16).toUpperCase().padStart(4, "0")}`
    else out += character
  }
  return out
}

const basic = (value: string) => `"${escapeBasic(value, false)}"`
const multilineBasic = (value: string, newline: boolean) => `"""${newline ? "\n" : ""}${escapeBasic(value, true)}"""`

/** A string value in the first style that can hold it without escapes, as toml_writer chooses. */
export const tomlString = (value: string) => {
  const m = metrics(value)
  if (!m.escapeCodes && !m.escape && m.maxDoubleQuotes === 0 && !m.newline) return basic(value)
  if (!m.escapeCodes && m.maxSingleQuotes === 0 && !m.newline) return `'${value}'`
  if (!m.escapeCodes && !m.escape && m.maxDoubleQuotes <= 2) return multilineBasic(value, m.newline)
  if (!m.escapeCodes && m.maxSingleQuotes <= 2) return `'''${m.newline ? "\n" : ""}${value}'''`
  return m.newline ? multilineBasic(value, true) : basic(value)
}

/** A key bare when it can be, else quoted. */
export const tomlKey = (key: string) => {
  if (/^[A-Za-z0-9_-]+$/.test(key)) return key
  const m = metrics(key)
  // A key has no multi-line form: a newline needs an escape.
  const escapeCodes = m.escapeCodes || m.newline
  if (!escapeCodes && !m.escape && m.maxDoubleQuotes === 0) return basic(key)
  if (!escapeCodes && m.maxSingleQuotes === 0) return `'${key}'`
  return basic(key)
}

const tomlValue = (value: TomlValue): string => {
  if (typeof value === "string") return tomlString(value)
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return value.length >= 2 ? `[\n${value.map((item) => `    ${tomlString(item)},\n`).join("")}]` : `[${value.map(tomlString).join(", ")}]`
}

interface Section {
  readonly key: ReadonlyArray<string> | undefined
  readonly array: boolean
  body: string
  hasChildren: boolean
}

/** The document for a root table. */
export const toToml = (root: TomlTable) => {
  const sections: Array<Section> = []
  const emit = (entries: TomlEntries, key: ReadonlyArray<string> | undefined, array: boolean) => {
    const section: Section = { key, array, body: "", hasChildren: false }
    sections.push(section)
    for (const [name, value] of entries) {
      if (value === undefined) continue
      const childKey = [...(key ?? []), name]
      if (typeof value === "object" && "_tag" in value) {
        if (value._tag === "Table") {
          section.hasChildren = true
          emit(value.entries, childKey, false)
        } else if (value.tables.length === 0) {
          section.body += `${tomlKey(name)} = []\n`
        } else {
          for (const element of value.tables) {
            section.hasChildren = true
            emit(element.entries, childKey, true)
          }
        }
      } else {
        section.body += `${tomlKey(name)} = ${tomlValue(value)}\n`
      }
    }
  }
  emit(root.entries, undefined, false)
  return sections
    .filter((section) =>
      section.key === undefined ? section.body !== "" : section.array || section.body !== "" || !section.hasChildren
    )
    .map((section) => {
      if (section.key === undefined) return section.body
      const name = section.key.map(tomlKey).join(".")
      return `${section.array ? `[[${name}]]` : `[${name}]`}\n${section.body}`
    })
    .join("\n")
}
