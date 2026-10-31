import akua.ctx
import json
import k8s.api.apps.v1 as appsv1
import k8s.api.core.v1 as corev1

schema Image:
    repository: str
    tag?: str = "0.1.2"
    digest?: str = ""
    pullPolicy?: str = "IfNotPresent"

schema Service:
    port?: int = 8080

schema Environment:
    identityIssuer?: str = "https://id.akua.dev"
    identityJwksUrl?: str = ""
    identityAudience?: str = ""
    mountPublicKeySecret?: bool = True
    mountRouteTableConfigMap?: bool = True
    publicKeyPath?: str = "/var/run/private-ingress-gateway/public-key.pem"
    routeTablePath?: str = "/var/run/private-ingress-gateway-routes/routes.json"
    publicKeySecretName?: str = "private-ingress-gateway-route-token-public-key"
    publicKeySecretKey?: str = "public-key.pem"
    routeTableConfigMapName?: str = "private-ingress-gateway-route-table"
    routeTableConfigMapKey?: str = "routes.json"
    otelEndpoint?: str = ""

schema RouteTable:
    createConfigMap?: bool = False
    routes?: [{str:}] = []

schema Gateway:
    namespace?: str = "platform-system"
    replicaCount?: int = 2
    image?: Image = {}
    imagePullSecrets?: [corev1.LocalObjectReference] = []
    command?: [str] = []
    args?: [str] = []
    podSecurityContext?: {str:} = {}
    extraVolumes?: [corev1.Volume] = []
    extraVolumeMounts?: [corev1.VolumeMount] = []
    service?: Service = {}
    env?: Environment = {}
    routeTable?: RouteTable = {}
    # Keep exported Input defaults JSON-compatible; resource defaults are applied below.
    resources?: corev1.ResourceRequirements = {}

schema Input:
    cluster_id?: str
    values_private_ingress_gateway?: Gateway = {}

input: Input = ctx.input()
_values = input.values_private_ingress_gateway
_resource_requests = _values.resources.requests or {}
_resource_limits = _values.resources.limits or {}
_name = "private-ingress-gateway"
_labels = {"app.kubernetes.io/name" = _name, "app.kubernetes.io/instance" = _name}
_mounts = [
    if _values.env.mountPublicKeySecret:
        corev1.VolumeMount {name = "route-token-public-key", mountPath = "/var/run/private-ingress-gateway", readOnly = True}
    if _values.env.mountRouteTableConfigMap:
        corev1.VolumeMount {name = "route-table", mountPath = "/var/run/private-ingress-gateway-routes", readOnly = True}
] + _values.extraVolumeMounts
_volumes = [
    if _values.env.mountPublicKeySecret:
        corev1.Volume {name = "route-token-public-key", secret = {secretName = _values.env.publicKeySecretName, items = [{key = _values.env.publicKeySecretKey, path = "public-key.pem"}]}}
    if _values.env.mountRouteTableConfigMap:
        corev1.Volume {name = "route-table", configMap = {name = _values.env.routeTableConfigMapName, items = [{key = _values.env.routeTableConfigMapKey, path = "routes.json"}]}}
] + _values.extraVolumes

resources = [
    appsv1.Deployment {
        metadata = {name = _name, namespace = _values.namespace, labels = _labels}
        spec = {
            replicas = _values.replicaCount
            selector.matchLabels = _labels
            template = {
                metadata.labels = _labels
                spec = {
                    automountServiceAccountToken = False
                    if _values.imagePullSecrets:
                        imagePullSecrets = _values.imagePullSecrets
                    securityContext = {runAsNonRoot = True, seccompProfile.type = "RuntimeDefault"} | _values.podSecurityContext
                    containers = [corev1.Container {
                        name = _name
                        image = _values.image.repository + ("@" + _values.image.digest if _values.image.digest else ":" + _values.image.tag)
                        imagePullPolicy = _values.image.pullPolicy
                        if _values.command:
                            command = _values.command
                        if _values.args:
                            args = _values.args
                        ports = [{name = "http", containerPort = 8080}]
                        env = [
                            if input.cluster_id:
                                {name = "PRIVATE_INGRESS_GATEWAY_CLUSTER_ID", value = input.cluster_id}
                                {name = "PRIVATE_INGRESS_GATEWAY_IDENTITY_AUDIENCE", value = _values.env.identityAudience or "private-ingress-gateway:" + input.cluster_id}
                                {name = "PRIVATE_INGRESS_GATEWAY_IDENTITY_ISSUER", value = _values.env.identityIssuer}
                                if _values.env.identityJwksUrl:
                                    {name = "PRIVATE_INGRESS_GATEWAY_IDENTITY_JWKS_URL", value = _values.env.identityJwksUrl}
                            {name = "PRIVATE_INGRESS_GATEWAY_PORT", value = str(_values.service.port)}
                            {name = "PRIVATE_INGRESS_GATEWAY_PUBLIC_KEY_PATH", value = _values.env.publicKeyPath}
                            {name = "PRIVATE_INGRESS_GATEWAY_ROUTE_TABLE_PATH", value = _values.env.routeTablePath}
                            if _values.env.otelEndpoint:
                                {name = "OTEL_EXPORTER_OTLP_ENDPOINT", value = _values.env.otelEndpoint}
                        ]
                        if _mounts:
                            volumeMounts = _mounts
                        readinessProbe = {httpGet = {path = "/healthz", port = "http"}, initialDelaySeconds = 5, periodSeconds = 10}
                        livenessProbe = {httpGet = {path = "/healthz", port = "http"}, initialDelaySeconds = 15, periodSeconds = 20}
                        resources = corev1.ResourceRequirements {
                            **_values.resources
                            requests: {
                                if "cpu" not in _resource_requests:
                                    cpu = "25m"
                                if "memory" not in _resource_requests:
                                    memory = "64Mi"
                            }
                            limits: {
                                if "memory" not in _resource_limits:
                                    memory = "256Mi"
                            }
                        }
                        securityContext = {allowPrivilegeEscalation = False, capabilities.drop = ["ALL"], readOnlyRootFilesystem = True}
                    }]
                    if _volumes:
                        volumes = _volumes
                }
            }
        }
    }
    corev1.Service {
        metadata = {name = _name, namespace = _values.namespace, labels = _labels}
        spec = {type = "ClusterIP", selector = _labels, ports = [{name = "http", port = _values.service.port, targetPort = "http"}]}
    }
    if _values.routeTable.createConfigMap:
        corev1.ConfigMap {
            metadata = {name = _values.env.routeTableConfigMapName, namespace = _values.namespace, labels = _labels}
            data = {"${_values.env.routeTableConfigMapKey}" = json.encode({routes = _values.routeTable.routes})}
        }
]
