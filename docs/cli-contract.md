# CLI contract

Every `akuapkg` command, and every `akua pkg` command, follows the rules on
this page. Scripts and agents can rely on them; a command that breaks one is
a bug. The per-command reference, generated from the CLI, is at
[docs.akua.dev/akua/cli](https://docs.akua.dev/akua/cli).

## 1. Output

### 1.1 `--json` is universal

Every command accepts `--json` and then prints
exactly one JSON document to stdout. Without it, commands print short human
text. `--no-json` forces text.

```sh
akuapkg render --json
```

```json
{"format":"raw-manifests","target":"./deploy","manifests":1,"hash":"sha256:c2625ffcff26b6c760cf30d4a6423d5d08c21cd47231294e4c933824d4359208","files":["000-configmap-hello.yaml"]}
```

### 1.2 Structured errors

A failure prints one error object to stderr (as
JSON under `--json`, as text otherwise) and exits non-zero:

```json
{"level":"error","code":"E_PACKAGE_MISSING","message":"Package.k not found","path":"nope.k","suggestion":"pass the Package.k path explicitly or cd to its directory","docs":"https://cli.akua.dev/errors/E_PACKAGE_MISSING"}
```

| Field | Meaning |
|---|---|
| `code` | Stable identifier, `E_SHOUTY_SNAKE_CASE`. Match on this, not on the message. Every code is documented at [docs.akua.dev/akua/errors](https://docs.akua.dev/akua/errors). |
| `message` | Human-readable summary |
| `path` | The file or field that caused it, when there is one |
| `suggestion` | A fix, when one is known |
| `docs` | Link to the code's documentation |

### 1.3 Determinism

The same command over the same files prints the
same bytes: rendered manifests in `resources` order, keys in a stable order,
no timestamps.

### 1.4 Agent context

When an AI agent runs akuapkg, it switches to JSON output by itself. It
checks these environment variables:

| Variable | Agent |
|---|---|
| `AGENT` | Goose, Amp, Codex, Cline, OpenCode and others that follow the convention |
| `CLAUDECODE` | Claude Code |
| `GEMINI_CLI` | Gemini CLI |
| `CURSOR_CLI` | Cursor CLI |
| `AKUA_AGENT` | any agent, explicitly |

If one is set, commands print JSON as if `--json` were given. There is no
banner or other announcement. Explicit flags win: `--no-json` prints text.
`--no-agent-mode` ignores the detection for one command, and
`AKUA_NO_AGENT_DETECT=1` turns it off entirely.

Agent context also makes renders reject `replace` overrides in
`akua.toml`, as `AKUA_REJECT_REPLACE=1` does.

## 2. Exit codes

| Code | Meaning |
|---|---|
| 0 | Success. Warnings (for example unsigned dependencies under `verify`) do not change it. |
| 1 | User error: invalid flags or inputs, a type error in the Package, a dependency that cannot be resolved, a failed check |
| 2 | System error: I/O or an unexpected failure in akuapkg itself |
| 3 | Reserved: policy denied |
| 4 | Reserved: rate limited |
| 5 | Reserved: needs approval |
| 6 | Timeout: the render ran out of its CPU budget (`E_RENDER_BUDGET_DEADLINE`) |

No command exits with any other code. Codes 3 to 5 are reserved for callers
that wrap akuapkg and are not produced today.

## 3. Idempotency keys

Every command accepts `--idempotency-key`, so wrappers can pass one
uniformly. akuapkg does not use it today.

## 4. Plan mode

Every command accepts `--plan`. `vendor add` honors it: it reports what it
would materialize and writes nothing. Other commands accept the flag and
ignore it; use `render --dry-run` to render without writing.

## 5. Time bounds

Every command accepts `--timeout` but does not enforce it: a render is
bounded by its CPU budget instead, and running out exits 6
(`E_RENDER_BUDGET_DEADLINE`). To bound wall-clock time, including network
fetches, run akuapkg under a deadline of your own, as
`@akua-dev/sdk/process` does (see [sdk.md](sdk.md)).

## 6. Other universal flags

`--no-agent-mode` ignores agent detection. `--log`, `--log-level`,
`--verbose`, `--no-color`, `--no-progress` and `--no-interactive` are
accepted for compatibility and do not change behavior. Commands do not
prompt, except `repl` and the opt-in `--wizard`.

## 7. Render flags

- `--max-depth` is accepted; nested `pkg.render` calls are capped at depth
  16 (`E_RENDER_BUDGET_DEPTH`).
- `--summary-out FILE` also writes the render summary JSON, with a trailing
  newline, to `FILE`. It does not change stdout and conflicts with
  `--dry-run` and `--stdout`.
- `--debug` adds the resources as the Package produced them, before YAML
  normalization, to the JSON output (`evalResult`).
- `--strict` rejects charts referenced by a raw path instead of an
  `akua.toml` dependency (`E_STRICT_UNTYPED_CHART`).
- `--offline` resolves dependencies only from `.akua/vendor/` and the local
  cache.

## 8. Stability

akuapkg is pre-1.0. Error codes and exit codes keep their meaning; keys in
JSON output are not renamed or removed without a changelog entry. New flags,
keys and error codes can appear in any release.
