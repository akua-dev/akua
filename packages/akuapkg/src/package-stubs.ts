/**
 * Import-only stubs for Akua-Package dependencies (`import pkgs.<name>`):
 * the upstream's `import` and `schema` declarations plus a `render` lambda
 * bound to its alias, so a consumer gets the upstream's types without
 * running its body. A port of the previous release's `pkg_stub`; textual,
 * relying on the indentation every `package.k` follows. KCL parses the
 * result when the consumer imports it.
 */

/** Rust's `str::lines`: no trailing empty line, `\r\n` stripped. */
const lines = (text: string) => {
  const all = text.split(/\r?\n/)
  return all.at(-1) === "" ? all.slice(0, -1) : all
}

/**
 * Blank out `@ui(...)` decorators (KCL's resolver rejects unknown ones),
 * multi-line forms included. Lines are kept so diagnostics keep their
 * line numbers.
 */
export const stripAkuaDecorators = (source: string) => {
  if (!source.includes("@ui(")) return source
  const all = lines(source)
  let out = ""
  for (let index = 0; index < all.length; index++) {
    const line = all[index] ?? ""
    if (!line.trimStart().startsWith("@ui(")) {
      out += `${line}\n`
      continue
    }
    let depth = parenBalance(line)
    out += "\n"
    while (depth > 0 && index + 1 < all.length) {
      index++
      depth += parenBalance(all[index] ?? "")
      out += "\n"
    }
  }
  return out
}

/** Net parenthesis balance of a line, ignoring string literals and comments. */
const parenBalance = (line: string) => {
  type State = "code" | "single" | "double" | "single3" | "double3"
  let state: State = "code"
  let depth = 0
  for (let index = 0; index < line.length; index++) {
    const char = line[index]
    const triple = line.slice(index, index + 3)
    switch (state) {
      case "code":
        if (triple === "\"\"\"" || triple === "'''") {
          state = triple === "\"\"\"" ? "double3" : "single3"
          index += 2
        } else if (char === "\"") state = "double"
        else if (char === "'") state = "single"
        else if (char === "(") depth++
        else if (char === ")") depth--
        else if (char === "#") return depth
        break
      case "single":
      case "double":
        if (char === "\\") index++
        else if (char === (state === "single" ? "'" : "\"")) state = "code"
        break
      case "single3":
      case "double3":
        if (triple === (state === "single3" ? "'''" : "\"\"\"")) {
          state = "code"
          index += 2
        }
        break
    }
  }
  return depth
}

/**
 * The `schema` / `protocol` blocks of a `package.k`, and the imports they
 * reference. Top-level assignments and expressions (the body) are dropped,
 * and so are `charts.*` imports, which exist only in the upstream's own render.
 */
export const extractSchemas = (source: string) => {
  const imports: Array<readonly [line: string, alias: string]> = []
  let schemas = ""
  let inSchema = false
  for (const line of lines(stripAkuaDecorators(source))) {
    const trimmed = line.trimStart()
    const blank = trimmed === ""
    const indented = line.startsWith(" ") || line.startsWith("\t")
    const comment = trimmed.startsWith("#")
    if (inSchema) {
      if (blank || indented || comment) {
        schemas += `${line}\n`
        continue
      }
      inSchema = false
    }
    if (blank) {
      // Runs of blank lines collapse to one separator.
      if (!schemas.endsWith("\n\n")) schemas += "\n"
      continue
    }
    if (indented) continue
    if (trimmed.startsWith("import ")) {
      if (trimmed.startsWith("import charts.")) continue
      const alias = importedName(trimmed)
      if (alias !== undefined) imports.push([line, alias])
      continue
    }
    if (trimmed.startsWith("schema ") || trimmed.startsWith("protocol ")) {
      inSchema = true
      schemas += `${line}\n`
    }
  }
  let out = imports
    .filter(([, alias]) => referencesModule(schemas, alias))
    .map(([line]) => `${line}\n`)
    .join("")
  if (out !== "" && schemas.trim() !== "") out += "\n"
  out += schemas
  return out.endsWith("\n") ? out : `${out}\n`
}

/** `import a.b.c as d` names `d`; `import a.b.c` names `c`. */
const importedName = (line: string) => {
  const target = (line.split("#")[0] ?? "").trim().slice("import ".length).trim()
  const as = target.lastIndexOf(" as ")
  if (as >= 0) return target.slice(as + 4).trim().split(/\s+/)[0]
  return target.split(/\s+/)[0]?.split(".").at(-1)
}

/** Whether `source` uses `identifier.` outside comments and string literals. */
const referencesModule = (source: string, identifier: string) => {
  let index = 0
  while (index < source.length) {
    const char = source[index] ?? ""
    if (char === "#") {
      const end = source.indexOf("\n", index)
      index = end < 0 ? source.length : end
      continue
    }
    if (char === "\"" || char === "'") {
      index = skipString(source, index, char)
      continue
    }
    if (
      source.startsWith(identifier, index) &&
      !/[A-Za-z0-9_]/.test(source[index - 1] ?? "") &&
      source[index + identifier.length] === "."
    ) {
      return true
    }
    index++
  }
  return false
}

const skipString = (source: string, start: number, quote: string) => {
  const triple = quote.repeat(3)
  if (source.startsWith(triple, start)) {
    const end = source.indexOf(triple, start + 3)
    return end < 0 ? source.length : end + 3
  }
  for (let index = start + 1; index < source.length; index++) {
    if (source[index] === "\\") index++
    else if (source[index] === quote) return index + 1
  }
  return source.length
}

/**
 * The stub module for dependency `alias`: its schemas plus
 * `render = lambda inputs: Input -> [{str:}]` dispatching to `pkg.render`.
 */
export const stubModule = (alias: string, source: string) => {
  const schemas = extractSchemas(source)
  const parameter = schemas.split("\n").some((line) => line.trimStart().startsWith("schema Input")) ? "Input" : "{str:}"
  let out = "# Akua-package stub. Auto-generated; do not edit.\nimport akua.pkg as _pkg\n\n" + schemas
  if (!out.endsWith("\n\n")) out += "\n"
  return out +
    `render = lambda inputs: ${parameter} -> [{str:}] {\n` +
    "    _flat = {**inputs}\n" +
    "    _pkg.render(_pkg.Render {\n" +
    `        package = "${alias}"\n` +
    "        inputs = _flat\n" +
    "    })\n" +
    "}\n"
}
