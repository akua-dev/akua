# Cluster connector

The agent that runs in a customer's Kubernetes cluster. It keeps one
WebSocket to Akua (`/v1/cluster_connectors/me:connect`), applies the releases
Akua chooses with an embedded Go engine (`akua-apply`) and reports what it
sees. A second deployment, the updater, replaces the agent with the next
release and rolls back when the new one is not healthy.

The cluster's owner decides what the agent may touch: a grant for the whole
cluster or for named namespaces, bound to the ServiceAccount `akua-apply` that
every apply impersonates. With the namespaced grant, a release that needs more
waits for the owner.

| Path | Contents |
| --- | --- |
| [`install/`](install/) | The Helm chart and Akua package that install or repair the agent, with every value and object documented |
| [`src/`](src/) | The agent and updater: TypeScript and Effect, one Bun binary |
| [`engine/`](engine/) | `akua-apply`, the Go apply engine |

Install and repair: [install/README.md](install/README.md).

Part of [Akua's open-source tools](../../README.md). See also
[CONTRIBUTING.md](../../CONTRIBUTING.md).
