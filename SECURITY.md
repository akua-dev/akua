# Security

akuapkg assumes the Package it renders is untrusted. Its KCL runtime and its
Helm and Kustomize engines run in a Wasmtime sandbox with no host
filesystem, network, environment or process access, under memory and CPU
budgets. Dependencies are fetched by the host only from sources `akua.toml`
names, and pinned by digest in `akua.lock`.

- [docs/why.md](docs/why.md) explains why rendering needs a sandbox, with the
  Helm, Kustomize, Argo CD and Flux advisories behind it.
- [docs/security-model.md](docs/security-model.md) lists every guarantee, how
  it is enforced, and what akuapkg does not protect against.

## Supported versions

Security fixes land in the latest release. akuapkg and the `akua` CLI share
one version; upgrade to the newest
[release](https://github.com/akua-dev/akua/releases/latest).

## Reporting a vulnerability

Report vulnerabilities privately through
[GitHub Security Advisories](https://github.com/akua-dev/akua/security/advisories/new),
not in a public issue. Include the akuapkg version (`akuapkg --version`), a
minimal Package or command that reproduces the issue, and what an attacker
gains.

Especially relevant reports:

- anything that lets a Package read or write host files, reach the network,
  read the environment or start a process during a render;
- a render that escapes its memory or CPU budget;
- a dependency that akuapkg accepts although its bytes do not match
  `akua.lock`, or a signature check that passes when it should fail.

We prioritize fixes ahead of feature work and coordinate disclosure timing
with you.
