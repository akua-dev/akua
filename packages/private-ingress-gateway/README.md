# Private ingress gateway

The private ingress gateway is the in-cluster HTTP boundary for hostname routes whose upstream services aren't reachable from the public internet. The domain dispatcher authenticates each routed request with a short-lived ES256 token. The gateway validates that token, resolves the projected backend, removes untrusted forwarding metadata, and streams the request and response without buffering their bodies.

The backend URL selects the network destination. The app-facing `Host` and `X-Forwarded-Host` are rebuilt from the verified public host, and `X-Forwarded-Proto` is rebuilt as `https`, matching the managed route's canonical HTTPS/WSS public URL. The backend can still use HTTP. The token does not sign a protocol field, so an incoming forwarded protocol is discarded rather than trusted. Other forwarding, Cloudflare and platform trust headers remain scrubbed. This lets applications recognize their public origin without exposing the internal Service hostname or trusting caller-supplied proxy metadata.

## Runtime architecture

The gateway uses TypeScript, Bun, and Effect. Effect owns the HTTP server lifecycle, configuration, file access, route-table reloads, WebCrypto service, upstream HTTP transport, cancellation, and graceful shutdown. The compiled OCI image contains one Bun executable; public keys and route state are mounted at runtime.

Keep the request path streaming and bounded. Parse and index route state only when its mounted content changes. Don't add a Promise compatibility API, a second runtime, or a separate copy of the dispatcher-to-gateway trust-header policy.

## Rust optimization boundary

A Rust implementation is a later optimization option, not a current migration requirement. Consider that rewrite only after production profiles show that this gateway consumes meaningful CPU or memory at expected traffic, or that tail latency is dominated by the Bun runtime rather than network and upstream latency.

A replacement must preserve the existing HTTP and security contract: token validation, `403`/`404`/`502`/`503` responses, manual redirect passthrough, header scrubbing, bidirectional streaming, route-table reloads, cancellation, and graceful shutdown. Benchmark the same workload and ship the Rust version only when the measured gain justifies the additional implementation and operational surface.

## Trust and configuration

The gateway verifies ES256 service tokens against the configured issuer and
JWKS endpoint. The default issuer is `https://id.akua.dev`, with public keys at
`/.well-known/jwks.json`. Set `PRIVATE_INGRESS_GATEWAY_IDENTITY_ISSUER`,
`PRIVATE_INGRESS_GATEWAY_IDENTITY_JWKS_URL` and
`PRIVATE_INGRESS_GATEWAY_IDENTITY_AUDIENCE` for a different installation.
For a Cluster, the audience is `private-ingress-gateway:<cluster-id>`; deployments
that provide `PRIVATE_INGRESS_GATEWAY_CLUSTER_ID` derive that audience by default.
Only subject `service:domain-dispatcher` with scope `gateway:route` is accepted.
Tokens must have a key ID and expire within 60 seconds of issuance. Public keys
are cached for ten minutes, so retiring keys must remain published across that
window and the token lifetime.

During the key migration, a separately mounted PEM public key A also verifies
the legacy token. That token binds the method, path, public host, Workspace,
Install and route. The gateway never needs the signing key. The JWKS service
token authenticates routing for the configured Cluster; the local route table
selects the backend. Caller headers cannot select a backend URL.

Both token paths, including key overlap, rejection cases and a JWKS outage,
are exercised through the HTTP boundary in `src/gateway-network.test.ts`.

## Build and deploy

From this repository's root:

```sh
bazel test //bazel/gateway:check //bazel/gateway:compile_action_contract_tests
bazel build //bazel/gateway:private_ingress_gateway_image
```

The image index contains Linux amd64 and arm64 binaries, each built with its
pinned Bun runtime and architecture-specific distroless base. Each compile
action rejects embedded build paths before producing an artifact.

`deploy/` is the `kaas-capability-private-ingress-gateway` akuapkg Package.
From this package directory, render it with
`akua pkg render --package deploy/package.k --inputs deploy/inputs.yaml`.
Set `values_private_ingress_gateway.image.repository` to the image you built or
received; the example registry is a placeholder. The Package mounts only the
public key and route table and disables the Pod's ServiceAccount token.

With `cluster_id`, the Package also creates `gw-<id>` after removing the
`clu_` prefix. Both Services select the same gateway Pods and belong to the
same Install. Both Services use the configured namespace, which defaults to
`platform-system`; local instances can select their own namespace.
