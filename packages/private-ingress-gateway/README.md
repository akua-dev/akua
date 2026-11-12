# Private ingress gateway

The private ingress gateway is the in-cluster HTTP boundary for hostname
routes whose upstream services are not reachable from the public internet.
Akua's dispatcher authenticates each routed request with a short-lived ES256
service token. The gateway verifies that token, resolves the backend of the
public host from its mounted route table, removes untrusted forwarding
metadata, and streams the request and response without buffering their
bodies.

The backend URL selects the network destination. `Host` and `X-Forwarded-Host`
are rebuilt from the public host and `X-Forwarded-Proto` is rebuilt as
`https`; an incoming forwarded protocol is discarded. Other forwarding,
Cloudflare and platform trust headers stay scrubbed, so applications see their
public origin without trusting caller-supplied proxy metadata.

The gateway is TypeScript on Bun, built with Effect, and ships as one
executable in an OCI image. Route state is mounted at runtime.

## Trust and configuration

The gateway verifies ES256 service tokens against the configured issuer and
JWKS endpoint. The default issuer is `https://id.akua.dev`, with public keys at
`/.well-known/jwks.json`. Set `PRIVATE_INGRESS_GATEWAY_IDENTITY_ISSUER`,
`PRIVATE_INGRESS_GATEWAY_IDENTITY_JWKS_URL` and
`PRIVATE_INGRESS_GATEWAY_IDENTITY_AUDIENCE` for a different installation.
For a Cluster, the audience is `private-ingress-gateway:<cluster-id>`; deployments
that provide `PRIVATE_INGRESS_GATEWAY_CLUSTER_ID` derive that audience by default.
Only the dispatcher's subject `service:domain-dispatcher` with scope `gateway:route` is accepted.
Tokens must have a key ID and expire within 60 seconds of issuance. Public keys
are cached for ten minutes, so retiring keys must remain published across that
window and the token lifetime.

The service token authenticates the dispatcher for this gateway; only the
route table selects a backend, and caller headers can never name one. The table
is JSON, `{"routes": [{"public_host": "...", "backend_url": "http://..."}]}`,
read from `PRIVATE_INGRESS_GATEWAY_ROUTE_TABLE_PATH` (or inline from
`PRIVATE_INGRESS_GATEWAY_ROUTE_TABLE`). Each host appears once; a host listed
twice serves nothing. The file is re-read when it changes, so a ConfigMap update
applies without a restart; until the file exists the gateway answers `503`.

Token verification, including key overlap, rejection cases and a JWKS outage,
is exercised through the HTTP boundary in `src/gateway-network.test.ts`.

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
route table and disables the Pod's ServiceAccount token.

With `cluster_id`, the Package also creates `gw-<id>` after removing the
`clu_` prefix. Both Services select the same gateway Pods and belong to the
same Install. Both Services use the configured namespace, which defaults to
`platform-system`; local instances can select their own namespace.
