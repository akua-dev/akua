import akua.ctx
import k8s.api.apps.v1 as apps
import k8s.api.core.v1 as core
import k8s.api.networking.v1 as networking

schema Image:
    repository?: str = "cloudflare/cloudflared"
    tag?: str = "2026.5.1"
    pullPolicy?: str = "IfNotPresent"

schema Transport:
    protocol?: str = "quic"

schema NetworkPolicy:
    enabled?: bool = False
    egress?: [networking.NetworkPolicyEgressRule] = []

schema Connector:
    namespace?: str = "platform-system"
    replicaCount?: int = 1
    image?: Image = {}
    transport?: Transport = {}
    tunnelTokenSecretName?: str = "cloudflare-tunnel-token"
    tunnelTokenSecretKey?: str = "token"
    resources?: core.ResourceRequirements = {}
    networkPolicy?: NetworkPolicy = {}

schema Input:
    release_name?: str = "cloudflare-tunnel-connector"
    values_cloudflare_tunnel_connector?: Connector = {}

input: Input = ctx.input()
_v = input.values_cloudflare_tunnel_connector
_name = "cloudflare-tunnel-connector"
_labels = {"app.kubernetes.io/name" = _name, "app.kubernetes.io/instance" = input.release_name}
_requests = _v.resources.requests or {}
_limits = _v.resources.limits or {}

resources = [
    apps.Deployment {
        metadata = {name = _name, namespace = _v.namespace, labels = _labels}
        spec = {
            replicas = _v.replicaCount
            selector.matchLabels = _labels
            template = {
                metadata.labels = _labels
                spec = {
                    automountServiceAccountToken = False
                    securityContext = {runAsNonRoot = True, seccompProfile.type = "RuntimeDefault"}
                    containers = [{
                        name = "cloudflared"
                        image = _v.image.repository + ":" + _v.image.tag
                        imagePullPolicy = _v.image.pullPolicy
                        args = ["tunnel", "--no-autoupdate", "--metrics", "0.0.0.0:2000", "--protocol", _v.transport.protocol, "run", "--token", "$(TUNNEL_TOKEN)"]
                        env = [{name = "TUNNEL_TOKEN", valueFrom.secretKeyRef = {name = _v.tunnelTokenSecretName, key = _v.tunnelTokenSecretKey}}]
                        ports = [{name = "metrics", containerPort = 2000}]
                        readinessProbe = {httpGet = {path = "/ready", port = "metrics"}, initialDelaySeconds = 5, periodSeconds = 10}
                        livenessProbe = {httpGet = {path = "/ready", port = "metrics"}, initialDelaySeconds = 15, periodSeconds = 20}
                        resources = core.ResourceRequirements {
                            **_v.resources
                            requests: {
                                if "cpu" not in _requests:
                                    cpu = "25m"
                                if "memory" not in _requests:
                                    memory = "64Mi"
                            }
                            limits: {
                                if "memory" not in _limits:
                                    memory = "256Mi"
                            }
                        }
                        securityContext = {allowPrivilegeEscalation = False, capabilities.drop = ["ALL"], readOnlyRootFilesystem = True}
                    }]
                }
            }
        }
    }
    if _v.networkPolicy.enabled:
        networking.NetworkPolicy {
            metadata = {name = _name, namespace = _v.namespace, labels = _labels}
            spec = {podSelector.matchLabels = _labels, policyTypes = ["Egress"], egress = _v.networkPolicy.egress}
        }
]
