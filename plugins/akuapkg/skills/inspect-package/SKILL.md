---
name: inspect-package
description: Audit an akuapkg Package or a Helm chart before using it - its input schema, dependencies and their digests, signatures, and what it renders with sample inputs. Use when evaluating a third-party Package, reviewing a dependency upgrade, checking whether a dependency is signed, or looking at what a chart from Artifact Hub, GHCR or another registry would deploy.
license: Apache-2.0
---

# Inspect a Package before using it

Rendering is sandboxed, so it is safe to render an untrusted Package to see
what it produces. Applying the output is not automatically safe: review it.

## Steps

1. Get the Package:
   - published: `akuapkg inspect --oci oci://REGISTRY/REPO --tag TAG`
     prints its metadata and input schema without unpacking it;
     `akuapkg pull --ref oci://REGISTRY/REPO --tag TAG --out ./pkg`
     downloads it;
   - packed tarball: `akuapkg inspect --tarball PKG.tar.gz`;
   - a chart: create a scratch Package (`akuapkg init scratch`) and
     `akuapkg add` the chart.

2. Read the input contract:

   ```sh
   akuapkg export --package ./pkg/package.k
   ```

3. List dependencies, their sources and digests, and whether they are
   signed:

   ```sh
   akuapkg tree --workspace ./pkg
   akuapkg verify --workspace ./pkg
   ```

   `verify` warns about unsigned dependencies, or fails on them when the
   Package configures a cosign key.

4. Render with sample inputs, without the network:

   ```sh
   akuapkg render --package ./pkg/package.k --inputs sample.yaml --stdout
   ```

   Add `--offline` once dependencies are cached, and `--strict` to refuse
   charts referenced by raw path.

5. Review the output for privileged containers, host mounts, RBAC
   (especially `ClusterRole` and `*` verbs), webhooks, CRDs and Helm hook
   resources (`helm.sh/hook` annotations).

## Report

Summarize: inputs, dependencies with source, digest and signature status,
the kinds and counts rendered, and every finding from step 5.

## References

- [docs/security-model.md](../../../../docs/security-model.md): what the sandbox
  does and does not protect
- [docs/lockfile-format.md](../../../../docs/lockfile-format.md)
