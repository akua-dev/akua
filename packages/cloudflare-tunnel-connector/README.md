# Cluster tunnel connector

This akuapkg Package runs `cloudflared` in a Cluster. It uses QUIC by default
and obtains the tunnel token through a Kubernetes Secret reference. The token
value is not part of the Package inputs or rendered manifest.

Set `values_cloudflare_tunnel_connector.tunnelTokenSecretName` and
`tunnelTokenSecretKey` to identify the Secret in the configured namespace.
The default namespace is `platform-system`. The Pod disables automatic
ServiceAccount token mounting, runs as a non-root user and uses a read-only
root filesystem. Optional egress NetworkPolicy rules are declared in the
Package inputs.

From this directory, render the Package with:

```sh
akua pkg render --package package.k --inputs inputs.yaml
```

The Kubernetes schemas are vendored for offline rendering. The adjacent
`input.schema.json` is exported from `package.k`; regenerate it with
`akua pkg export --package package.k --out input.schema.json` when changing inputs.
