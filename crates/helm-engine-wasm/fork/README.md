# Helm v4.1.4 patch: no client-go

`helm-v4.1.4.patch` removes Helm's transitive `k8s.io/client-go`
dependency from the engine. Bazel applies it to the pinned Helm v4.1.4
sources before compiling the engine (see `bazel/source_dependencies.bzl`).

## Why

Upstream Helm pulls client-go into every build through a blank import
(`internal/version/clientgo.go`) and through `lookup`, `New(*rest.Config)`
and the capabilities scheme walk. The engine never talks to a cluster, and
without client-go the wasm module is roughly a quarter of the size.

## What the patch changes

1. **`pkg/engine/engine.go`**: drops `New(*rest.Config)` and
   `RenderWithClient(..., *rest.Config)`; keeps `Render` and
   `RenderWithClientProvider`.
2. **`pkg/engine/lookup_func.go`**: removes the client-go, dynamic and
   discovery imports. `ClientProvider` keeps its shape but returns `any`;
   `NewLookupFunction` returns a function that always errors. akuapkg calls
   `engine.Render` without a client, so `lookup` never reaches a cluster.
3. **`pkg/chart/common/capabilities.go`**: replaces the client-go scheme
   walk with a fixed set of common API versions, and the client-go module
   version with a fixed Kubernetes version string.
4. **`internal/version/clientgo.go`**: removes the blank import.

## Updating Helm

1. Change the Helm tag and checksum in `bazel/source_dependencies.bzl`.
2. Re-create the patch against the new tag. Expect conflicts in
   `engine.go` and `capabilities.go`. `fork/apply.sh` clones a tag into
   `third_party/helm-fork/` and applies the patch, for working on it by
   hand.
3. Update `go-src/go.mod` and `go-src/go.sum`.
4. Render the examples that use Helm and compare them with their committed
   `rendered/` directories.
