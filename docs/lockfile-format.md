# `akua.toml` and `akua.lock`

A Package declares what it depends on in `akua.toml` and records exactly
what it got in `akua.lock`. Both files are TOML and both are committed.

| | `akua.toml` | `akua.lock` |
|---|---|---|
| Holds | intent: name, version, dependencies, signing keys | evidence: one entry per dependency with its digest |
| Written by | you, and `akuapkg init`, `add`, `remove` | `akuapkg init`, `add`, `remove`, `lock`, `update`, `vendor add` |
| Review question | do we want this dependency? | is this the expected digest and signature? |

A change to `akua.lock` without a matching change to `akua.toml` deserves a
close look in review. `akuapkg lock --check` fails CI when the two disagree.

## `akua.toml`

```toml
[package]
name = "hello"
version = "0.1.0"
edition = "akua.dev/v1alpha1"

[dependencies]
k8s = { oci = "oci://ghcr.io/kcl-lang/k8s", version = "1.35" }
cert-manager = { url = "https://github.com/cert-manager/cert-manager/releases/download/v1.16.0/cert-manager.crds.yaml", crds = true }
traefik = { oci = "oci://ghcr.io/traefik/helm/traefik", version = "37.1.1" }
```

`akuapkg add` and `remove` rewrite the file in a canonical form: comments
are dropped and each dependency becomes its own `[dependencies.<name>]`
table. Both forms mean the same thing.

### `[package]`

| Field | Required | Notes |
|---|---|---|
| `name` | yes | a KCL identifier |
| `version` | yes | the Package's version; `publish` uses it as the default tag |
| `edition` | yes | `akua.dev/v1alpha1` |
| `strict_signing` | no | require every remote dependency to be locked with a signature from `[signing].cosign_public_key`. Defaults to `true` when that key is set, `false` otherwise. See [Signing](#signing). |

### `[dependencies]`

Each key is the alias the Package imports, and the value names one source:

| Source | Shape | Imported as |
|---|---|---|
| OCI | `{ oci = "oci://ghcr.io/org/chart", version = "1.2.3" }` | `charts.<name>`, `pkgs.<name>` or a KCL module, by artifact type |
| Git | `{ git = "https://github.com/org/repo", tag = "v1.2.3" }` or `rev = "<commit>"` | as for OCI |
| Helm repository | `{ repo = "https://charts.example.com", chart = "app", version = "1.2.3" }` | `charts.<name>` |
| Local path | `{ path = "./chart" }` | as for OCI |
| URL | `{ url = "https://example.com/crds.yaml", crds = true }` | CRD source only |

Options on any dependency:

| Option | Meaning |
|---|---|
| `crds = true` or `crds = "<file or dir>"` | generate typed schemas from the CustomResourceDefinitions in the source, imported as `crds.<name>.<group>.<version>`; see [typed-resources.md](typed-resources.md) |
| `replace = { path = "../fork" }` | use a local copy of an `oci` or `git` dependency while `akua.lock` keeps pinning the canonical source; for local debugging only |

`akuapkg add` writes these for you:

```sh
akuapkg add traefik --oci oci://ghcr.io/traefik/helm/traefik --version 37.1.1
akuapkg add temporal --repo https://go.temporal.io/helm-charts --chart temporal --version 0.62.0
akuapkg add upstream --git https://github.com/org/repo --tag v1.0.0
akuapkg add shared --path ./shared
akuapkg add k8s --k8s 1.36 --force
```

### Versions

- **OCI** versions are tags, resolved to a manifest digest when locked.
- **Helm repository** versions are an exact version or a semver requirement
  (`">=0.60, <0.63"`); the highest matching chart in the repository's
  `index.yaml` is locked.
- **Git** dependencies take a `tag` or a full commit `rev`; the commit is
  locked.
- **Path** dependencies are hashed; `akuapkg verify` reports when the
  directory no longer matches.

`akuapkg update` re-resolves every dependency, or one with `--dep`, to what
its source serves now and rewrites the lock entries.

### Paths stay inside the workspace

`path` dependencies and `replace` overrides must resolve inside the
workspace; absolute paths and `..` escapes are rejected. `akuapkg publish`
removes every `replace` before it packs, so consumers never inherit one.
Renders fail on any `replace` when `AKUA_REJECT_REPLACE=1` is set or an
agent runs akuapkg.

### Signing

```toml
[signing]
cosign_public_key = "./cosign.pub"     # verify OCI dependencies
cosign_private_key = "./cosign.key"    # sign on publish
```

Both paths are relative to the workspace. With `cosign_public_key`, `add`,
`lock`, `update` and `vendor add` refuse an OCI dependency without a valid
cosign signature from that key (`E_COSIGN_SIG_MISSING`, `E_COSIGN_VERIFY`)
and record the key in its lock entry. With `cosign_private_key`,
`akuapkg publish` signs the pushed artifact and attaches a SLSA v1
provenance attestation; an encrypted key's passphrase comes from
`AKUA_COSIGN_PASSPHRASE`. Keys are ECDSA P-256 in PEM; keyless signing is
not supported.

## `akua.lock`

```toml
# akua.lock - machine-maintained. Never hand-edit.

version = 1

[[package]]
name = "cert-manager"
version = "url"
source = "url+https://github.com/cert-manager/cert-manager/releases/download/v1.16.0/cert-manager.crds.yaml"
digest = "sha256:6b81e668c80301955ea3c618a0e29ceb98b54d1d80a7b0082c77e5c7d827b41b"

[[package]]
name = "k8s"
version = "1.35"
source = "oci://ghcr.io/kcl-lang/k8s"
digest = "sha256:078b87bde17d1e1ec6670372e82de668bdbac36417878bb89fe3385d605759b7"

[[package]]
name = "prometheus"
version = "v0.80.0"
source = "git+https://github.com/prometheus-operator/prometheus-operator@v0.80.0"
digest = "git:56cc9eea5f8bffedbc4a77ae08555dd5f510ed76"
```

Entries are sorted by name, carry no timestamps, and end with a newline, so
the file diffs cleanly.

| Field | Notes |
|---|---|
| `name` | the `[dependencies]` key |
| `version` | the resolved version (`local` for paths, `url` for URLs) |
| `source` | `oci://...`, `git+https://...@<ref>`, `helm+<repo-url>#<chart>`, `path+file://...` or `url+https://...` |
| `digest` | `sha256:` of the OCI blob, chart archive, file or directory; `git:<commit>` for git |
| `vendor_digest` | `sha256:` of the vendored tree under `.akua/vendor/<name>/`, when it differs from `digest` |
| `signature` | `cosign:key:sha256:<key id>`: the key that verified this OCI dependency when it was locked. Only OCI dependencies carry one; git, Helm-repository and URL sources have no signing layer |
| `crds_digest` | for a CRD dependency, `sha256:` of its generated schemas under `.akua/crds/<name>/` as `lock` wrote them; a render uses that directory only while it has this digest |
| `replaced` | `{ path = "..." }` while a `replace` is active |

A new digest drops the fields that were bound to the old one, such as
`signature`, unless resolution verified them again.

`signature` records which key verified the bytes at lock time; it is not a
signature itself. A later render does not verify again: it serves cached or
vendored copies, and generated CRD schemas, only when they match the digests
in `akua.lock` (and, with a key configured, only when the entry names that
key). Trust in those copies therefore rests on a reviewed `akua.lock` and
its digests, so review lock changes like code.

## Workflows

### Locking

`akuapkg add` adds the entry to `akua.toml`, fetches the source, verifies its
signature when a key is configured, and writes the lock entry and any
generated CRD schemas. `akuapkg lock` does the same for everything in
`akua.toml`; `akuapkg lock --check` changes nothing and fails when
`akua.lock` or `.akua/crds/` would change.

### Verifying (CI)

`akuapkg verify`:

1. checks that every declared dependency is locked, every locked one is
   declared, and path dependencies still match their digest;
2. under `strict_signing`, requires each remote entry's `signature` to name
   the configured key: `missing-signature` when there is none,
   `signature-mismatch` for another key, `signature-unverifiable` when
   `strict_signing = true` is set without a key;
3. without strict signing, lists unsigned remote dependencies as warnings;
4. exits 0 when there is no violation, 1 otherwise.

`akuapkg verify --tarball PKG.tgz --sig PKG.tgz.sig` checks a packed Package
against its detached signature instead.

A render with a key configured uses a cached or vendored OCI dependency only
when its lock entry records that key; otherwise it fetches and verifies
again, or, with `--offline`, fails with `E_COSIGN_SIG_MISSING`.

### Vendoring (offline renders)

`akuapkg vendor add <name>` copies a dependency into `.akua/vendor/<name>/`.
Renders prefer the vendored copy over the cache and the network, so with
every dependency vendored, `akuapkg render --offline` needs neither.
`akuapkg vendor check` reports drift between the vendor tree and the lock;
`vendor list` shows what is vendored. `akuapkg pack` includes the vendor
tree unless you pass `--no-vendor`.
[examples/12-vendor-offline](../examples/12-vendor-offline/) shows the
layout.

## KCL modules from OCI

OCI artifacts published with KCL's `kpm`, such as everything under
`ghcr.io/kcl-lang`, work as ordinary dependencies. akuapkg recognizes them
by their manifest annotations and makes them importable by alias, as with
`import k8s.api.apps.v1`. akuapkg reads `akua.toml`, not KCL's `kcl.mod`.

## Related topics

- [Typed resources](typed-resources.md)
- [Package format](package-format.md)
- [Security model](security-model.md#supply-chain)
