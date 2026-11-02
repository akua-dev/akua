# akua-cluster-agent

Installs the Akua cluster agent and its updater into a Kubernetes cluster.
The chart creates no CRDs and no Namespace. Its RBAC mirrors `agentClusterRole`,
`agentRole` and `updaterRole` in `../src/contract.ts`.

## Install or repair

```sh
helm upgrade --install akua-cluster-agent <chart> \
  --namespace akua-system --create-namespace \
  --set image.digest=sha256:<digest> \
  --set enrollment.code=akua_enr_<43 characters> \
  --set-json 'access={"namespaces":["team-a","team-b"]}'
```

The release must be named in namespace `akua-system`; any other namespace fails
the render. The same command is the repair path: it re-applies both
Deployments. If `akua-agent-identity` still holds the agent's key, the agent
keeps its identity and ignores the code.

## Values

| Value | Meaning |
| --- | --- |
| `platformOrigin` | Akua API origin (https). Default `https://api.akua.dev`. |
| `image.repository`, `image.digest` | Agent image; digest is required (`sha256:` + 64 hex). |
| `updater.image.repository`, `updater.image.digest` | Updater image; each falls back to the agent image when empty. |
| `access` | Required. Exactly one of `{"cluster": {}}` or `{"namespaces": [...]}`. |
| `enrollment.method` | `code` (connected cluster) or `federated` (hosted cluster). |
| `enrollment.code` | Single-use code, `akua_enr_` + 43 characters. `code` method only. |
| `enrollment.agentId`, `enrollment.federatedAudience` | Required for `federated`: agent ID (`cag_...`) and the audience of the projected ServiceAccount token. |
| `release.version`, `release.protocol` | Written to the `akua.dev/release` annotation on the agent Deployment (version defaults to the chart appVersion, protocol to 1). The updater rewrites it on each update; re-running the install resets it. |
| `distribution` | Optional: `k0s`, `k3s`, `kubeadm`, `eks`, `gke`, `aks`, `other`. |
| `priorityClassName`, `nodeSelector`, `tolerations`, `affinity` | Passed to both pods. |

Hosted clusters install this chart as a k0s Helm extension with
`enrollment.method=federated` and `access: {cluster: {}}`: Akua fully manages
a hosted cluster, so its `akua-apply` is cluster-admin and the chart refuses
any other grant there. Connected clusters use `code` and keep the minimal
grant their owner chose.

The Akua package in the parent directory (`../akua.toml`, `../package.k`)
renders this chart unchanged, with the chart's values as its typed inputs, so
`helm upgrade --install` and an Akua install produce the same objects. The
chart is the only source of the agent's manifests.

## Access

`access` is the customer's grant to the ServiceAccount `akua-system/akua-apply`.
Every apply and prune impersonates it, so these bindings are the agent's whole
authority over workloads.

- `{"cluster": {}}`: ClusterRoleBinding `akua-apply` to ClusterRole `cluster-admin`.
- `{"namespaces": ["a", "b"]}`: in each listed namespace, RoleBinding
  `akua-apply` to ClusterRole `admin`. The namespaces must already exist.
  RoleBinding `akua-apply-system` also binds `admin` in `akua-system`, Akua's
  own namespace, so the namespaced objects of a release update without you.

## Updates

A release is this chart rendered for the cluster. The updater applies it as
`akua-apply` without its own objects, keeps the last good one in Secret
`akua-agent-bundle`, and rolls back to it when the new agent does not pass its
health gate. Once the updater verified the new agent and is idle, the agent
applies the updater's own objects the same way, keeps the last good ones in
Secret `akua-updater-bundle`, and rolls back to them when the new updater does
not become ready and report to the platform in time. They never update at
the same time. With the
`namespaces` grant, a release that changes cluster-scoped objects (such as
the `akua-agent` ClusterRole) or bindings outside `akua-system` waits for you:
Akua shows the missing permissions and the `helm upgrade` command, and the
rights stay with you.

## Objects

- ServiceAccounts `akua-agent`, `akua-agent-updater` (token mounted) and
  `akua-apply` (no token; only impersonated).
- ClusterRole and ClusterRoleBinding `akua-agent`: read nodes, read the
  `kube-system` namespace (for the cluster UID).
- Role and RoleBinding `akua-agent`: impersonate `akua-apply`; get, update,
  patch Secrets `akua-agent-identity`, `akua-tunnel-connector` and
  `akua-updater-bundle`; get Secret `akua-agent-bundle`.
- Role and RoleBinding `akua-agent-updater`: impersonate `akua-apply`; get
  Deployment `akua-agent`; read ReplicaSets and Pods; get Secrets
  `akua-agent-identity` and `akua-updater-bundle`; get, update, patch Secret
  `akua-agent-bundle`.
- Secrets `akua-agent-identity`, `akua-tunnel-connector`, `akua-agent-bundle`
  and `akua-updater-bundle`: created empty with
  `helm.sh/resource-policy: keep`. The agent may not create Secrets, so the
  chart creates them; the keys the agent writes are not declared by the chart
  and survive `helm upgrade` and `helm uninstall`.
- Secret `akua-agent-enrollment`: holds the code; rendered only for the `code`
  method with a non-empty code.
- Deployment `akua-agent`: one replica, `Recreate`, so two agents never
  reconcile at once.
- Deployment `akua-agent-updater`: one replica, `Recreate`; applies a release
  chosen on the platform and gates it (see Updates).
