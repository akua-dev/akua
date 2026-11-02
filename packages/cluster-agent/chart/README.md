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
`enrollment.method=federated`; connected clusters use `code`.

## Access

`access` is the customer's grant to the ServiceAccount `akua-system/akua-apply`.
Every apply and prune impersonates it, so these bindings are the agent's whole
authority over workloads.

- `{"cluster": {}}`: ClusterRoleBinding `akua-apply` to ClusterRole `cluster-admin`.
- `{"namespaces": ["a", "b"]}`: in each listed namespace, RoleBinding
  `akua-apply` to ClusterRole `admin`. The namespaces must already exist.

## Objects

- ServiceAccounts `akua-agent`, `akua-agent-updater` (token mounted) and
  `akua-apply` (no token; only impersonated).
- ClusterRole and ClusterRoleBinding `akua-agent`: read nodes, read the
  `kube-system` namespace (for the cluster UID).
- Role and RoleBinding `akua-agent`: impersonate `akua-apply`; get, update,
  patch Secrets `akua-agent-identity` and `akua-tunnel-connector`.
- Role and RoleBinding `akua-agent-updater`: get, patch Deployment
  `akua-agent`; read ReplicaSets and Pods; get Secret `akua-agent-identity`.
- Secrets `akua-agent-identity` and `akua-tunnel-connector`: created empty with
  `helm.sh/resource-policy: keep`. The agent may not create Secrets, so the
  chart creates them; the keys the agent writes are not declared by the chart
  and survive `helm upgrade` and `helm uninstall`.
- Secret `akua-agent-enrollment`: holds the code; rendered only for the `code`
  method with a non-empty code.
- Deployment `akua-agent`: one replica, `Recreate`, so two agents never
  reconcile at once.
- Deployment `akua-agent-updater`: one replica, `Recreate`; patches the agent
  image after a release is chosen on the platform.
