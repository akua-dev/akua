<div align="center">
  <img src="assets/logo.png" height="200" alt="Akua" />

  <h1>Akua</h1>

  <p>Build it once. Install it for every customer.</p>

  <p>
    <a href="https://github.com/akua-dev/akua/releases/latest"><img alt="Release" src="https://img.shields.io/github/v/release/akua-dev/akua?label=release&style=flat-square"></a>
    <a href="https://docs.akua.dev"><img alt="Docs" src="https://img.shields.io/badge/docs-docs.akua.dev-blue?style=flat-square"></a>
    <a href="./LICENSE"><img alt="License" src="https://img.shields.io/badge/license-Apache--2.0-blue?style=flat-square"></a>
  </p>
</div>

---

Each customer gets their own install, on a server run by Akua or on their
own. Every one stays up to date. Your coding agent runs it all: it builds the
software with you, publishes it as a package, and installs it for each
customer.

This repository holds the open-source tools behind that: the `akua` CLI your
coding agent uses to publish and install, and `akuapkg`, the package format.
They work with Akua and on their own:

| Tool                           | What it does                                                                                                                                                              | Install                                         |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| [`akua`](packages/cli/)        | Publish and install from a terminal, a CI pipeline or a coding agent: clusters, machines, installs, domains, team. Every command is generated from Akua's public API.                | `brew install akua-dev/tap/akua`                |
| [`akuapkg`](packages/akuapkg/) | Build typed Kubernetes packages: KCL instead of YAML templates, Helm and Kustomize in a sandbox, every dependency pinned by digest. Also built into `akua` as `akua pkg`. | `curl -fsSL https://cli.akua.dev/install \| sh` |

## Quick start

### Run Akua from your terminal

```sh
brew install akua-dev/tap/akua
akua auth login               # sign in with your browser
akua workspaces use my-team   # choose the workspace to work in
akua clusters list
akua commands --resource installs
```

Every command takes `--json`, and output switches to a compact agent format
when a coding agent or CI runs it. No Homebrew? Use the
[checksummed release archives](packages/cli/docs/install.md).
Full guide: [docs.akua.dev/cli](https://docs.akua.dev/cli).

### Let your coding agent set Akua up

Give your coding agent one instruction:

```text
Fetch https://docs.akua.dev/agent-setup/prompt and complete the Akua CLI
quickstart with me.
```

The agent installs the CLI, signs you in through your browser and asks before
every consequential step. Package-authoring skills: [plugins/akuapkg](plugins/akuapkg/).

### Build a typed Kubernetes package

```sh
curl -fsSL https://cli.akua.dev/install | sh   # or: brew install akua-dev/tap/akuapkg
akuapkg init hello && cd hello
akuapkg render --inputs inputs.example.yaml
```

A typo in a field or a value your Kubernetes version does not accept fails the
render with the file and line. Walkthrough with CRDs and Helm charts:
[packages/akuapkg](packages/akuapkg/#quick-start).
Docs: [docs.akua.dev/akua](https://docs.akua.dev/akua).

## Repository layout

| Path                                    | Contents                                                                                                                     |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| [`packages/cli`](packages/cli/)         | The `akua` CLI                                                                                                               |
| [`packages/akuapkg`](packages/akuapkg/) | akuapkg: the Bun + Effect host, its CLI and TypeScript SDK                                                                   |
| [`crates/`](crates/)                    | The sandboxed render worker (Rust to WebAssembly), the Helm and Kustomize engines (Go to WebAssembly) and the Wasmtime addon |
| [`packages/cluster-connector`](packages/cluster-connector/) | The agent that runs in a customer's cluster and keeps its installs up to date; also an Akua package |
| [`packages/cloudflare-tunnel-connector`](packages/cloudflare-tunnel-connector/) | An akuapkg Package that runs `cloudflared` in a cluster |
| [`packages/private-ingress-gateway`](packages/private-ingress-gateway/) | The in-cluster HTTP boundary for routes whose services are not public |
| [`plugins/`](plugins/)                  | Agent plugins and skills                                                                                                     |
| [`examples/`](examples/)                | Runnable packages, each with its rendered output                                                                             |
| [`docs/`](docs/)                        | Format specifications (package, lockfile, CLI contract), security model, building and releasing                              |

`akua` and `akuapkg` release together: one version, one
[GitHub Release](https://github.com/akua-dev/akua/releases) with archives for
macOS, Linux and Windows. Changes: the release notes on each
[GitHub Release](https://github.com/akua-dev/akua/releases).

## Status

Alpha. The package format, the JSON output and the error and exit codes are
stable enough to build on; interfaces can still change before 1.0.

## Security

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).
The sandbox's guarantees and limits are in
[docs/security-model.md](docs/security-model.md).

## Contributing

Issues are welcome: bug reports, reproductions, root-cause analysis and design
feedback. Development happens in Akua's internal monorepo, which this
repository mirrors exactly, so code pull requests cannot be merged here yet.
See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[Apache-2.0](LICENSE).
