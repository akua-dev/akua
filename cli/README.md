# Akua CLI

`akua` drives Akua Cloud from a terminal: create Kubernetes clusters, add
machines, package an application, and install it, all from one command. It is
a single self-contained executable, built for three audiences - a person
typing commands interactively, a CI pipeline calling it non-interactively, and
a coding agent driving it programmatically - and every command adapts its
output to whichever one is running it.

Every command is generated directly from Akua's public API, so the CLI never
drifts out of sync with what the platform can actually do.

The canonical executable is `akua`.

**Source.** The CLI lives in [`akua-dev/akua`](https://github.com/akua-dev/akua)
under `cli/`, next to the package toolchain that `akua pkg` embeds; it was
previously published from `akua-dev/cli`. The CLI and the package toolchain
share one version and one `v<version>` release
([../docs/releasing.md](../docs/releasing.md)). See
[CONTRIBUTING.md](CONTRIBUTING.md) to build and test it.

## Install

```sh
brew install akua-dev/tap/akua
akua --version
akua --help
akua commands --limit 1
akua pkg version
```

Upgrade with:

```sh
brew update
brew upgrade akua
```

The formula is maintained in `akua-dev/homebrew-tap`.

No Homebrew? See [manual install](docs/install.md) for checksummed release
archives.

## First commands

```sh
akua auth login               # sign in with your browser
akua workspaces list          # see your workspaces
akua workspaces use my-team   # run later commands in this workspace
akua clusters list            # list clusters in it
akua clusters create --help   # every command documents its arguments and flags
```

## Sign in

For an interactive browser/device login:

```sh
akua auth login
```

The CLI prints a verification URL and code, then attempts to open the URL in a
browser. Use `--no-browser` when the machine cannot open a browser; complete
the verification in any browser instead.

```sh
akua auth login --no-browser
```

For CI and coding agents, prefer an ephemeral environment credential instead of
an interactive login:

```sh
export AKUA_API_TOKEN='sk_akua_...'
akua auth status
```

For a local persisted token without an interactive login:

```sh
akua auth login --token 'sk_akua_...'
akua auth status
akua auth logout
```

`AKUA_API_TOKEN` takes precedence over a stored token. Login writes to the
selected config file, defaulting to `~/.config/akua/config.json`.
The directory is forced to `0700` and the file to
`0600`. Login replaces only `token` and preserves unknown config keys. Logout
removes only the stored `token`, also preserving unknown config keys, and cannot
clear `AKUA_API_TOKEN` from the parent process.

### Keep separate logins

Set `AKUA_CONFIG_DIR` to keep a login and its saved Workspace in a separate
directory, without changing `HOME`. Use the same directory for every command
that should use that login:

```sh
export AKUA_CONFIG_DIR="$HOME/.config/akua-work"
akua auth login
akua auth status
akua workspaces list
```

Switch to another login by setting `AKUA_CONFIG_DIR` to another directory.
Unset it to use the XDG or HOME configuration. Config file selection follows
this order (empty environment variables count as unset):

1. `$AKUA_CONFIG_DIR/config.json`
2. `$XDG_CONFIG_HOME/akua/config.json`
3. `$HOME/.config/akua/config.json`

Either override works without `HOME`. The CLI reads only the selected file;
if it doesn't exist, you're signed out unless `AKUA_API_TOKEN` is set.
`AKUA_API_TOKEN` still overrides every stored login. `akua auth status` shows
the selected path in human output and as `data.config_path` in JSON output.
Login, logout, and saved Workspace context all use that file.

## Choose a workspace

A browser login can reach more than one workspace. Save the one you work in:

```sh
akua workspaces use my-team     # by slug, name, or ws_... ID
akua workspaces use             # on a terminal: choose from a list
akua workspace switch other     # the same command
akua workspaces current         # which workspace, and where the choice comes from
akua workspaces use --clear     # forget it
```

Workspace-scoped commands send the workspace as the `Akua-Context` header for
you, chosen in this order: the `--workspace` (`-w`) flag, then
`AKUA_WORKSPACE`, then the workspace saved in the selected config file (see
[Keep separate logins](#keep-separate-logins)).

## Built for humans, CI, and agents

An interactive TTY defaults to human prose. The CLI switches to compact agent
output automatically when any of these signals are active, so an agent gets
usable output without extra flags:

- `AGENT=true` or `AGENT=<name>` (for example `AGENT=codex`);
- a detected provider environment such as Codex, Claude Code, Cursor, Aider,
  Devin, OpenCode, Amp, Cody, Replit, or Windsurf;
- CI providers including GitHub Actions, GitLab CI, Buildkite, CircleCI,
  Jenkins, TeamCity, or Azure Pipelines;
- non-TTY stdout.

Values `AGENT=0`, `AGENT=false`, and an empty `AGENT` do not activate agent mode.
Explicit output flags win over detection:

```sh
akua commands --output human
akua commands --output agent
akua commands --json
akua commands --quiet
AKUA_OUTPUT=json akua auth status
```

The supported modes are `human`, `agent`, `json`, and `quiet`. Success data is
written to stdout; progress and warnings belong on stderr. Unknown commands,
flags, and output modes fail loudly with stable nonzero exit codes.

## Run commands

Every public Akua operation is available as a generated command, kept current
with the API automatically: `operationId: clusters.create` becomes
`akua clusters create`. Path parameters are arguments and request fields are
typed flags, generated from the API schema:

```sh
akua clusters create --name demo --region-id reg_123
akua clusters get clu_123
akua machines create --cluster-id clu_123 --instance-type cax11
akua installs get-logs inst_123 --tail 100
```

On a terminal, lists print as tables and objects as aligned fields; `--json`
prints the full API response, ready for `jq`
(`akua clusters list --json | jq -r '.data.data[].id'`). Errors name the flag
to fix and the command to run next.

Scripts and agents can also send the whole request as one JSON object from
stdin or a named file. Generated commands accept one JSON object whose only
keys are `path`, `query`, `headers`, and `body`; flags override its fields.
Secret fields also take a `--<flag>-file` form that reads a file or stdin
(`akua secrets create --name db --kind generic --value-file -`), so secrets
stay off the command line; typing them as plain flags prints a warning:

```sh
printf '{"query":{"limit":5}}' | akua workspaces list --input -
akua machines create --input - < ./machine.json
```

Discover the current surface instead of relying on a fixed list:

```sh
akua commands --json
akua commands --resource workspaces
akua commands --operation-id workspaces.list
```

Request input is schema-validated before it is sent and never included in
diagnostics. The CLI stays provider-neutral: it has no provider-specific commands,
flags, environment variables, or credential loaders. Provider-specific values
belong only in the generated request body.

## Learn more

The full command reference and platform guides live at
[docs.akua.dev](https://docs.akua.dev).

Contributing to this repo? See [CONTRIBUTING.md](CONTRIBUTING.md).
