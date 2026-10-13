# Every resource is a typed schema: the Kubernetes core types of one
# Kubernetes version (`k8s` in akua.toml), and the cert-manager
# Certificate generated from its CustomResourceDefinition at a pinned
# git tag (`cert-manager`, generated into .akua/crds/). A misspelled
# field, a wrong type or a value outside an enum fails the render.
#
#   akuapkg render --package examples/16-typed-crds/package.k --out ./rendered
import akua.ctx
import k8s.api.apps.v1 as appsv1
import k8s.api.core.v1 as corev1
import crds.cert_manager.cert_manager_io.v1 as certmanager

schema Input:
    """Public inputs for 16-typed-crds."""
    name: str = "web"
    """Name of every resource, and the app label."""

    image: str = "nginx:1.27"
    """Container image."""

    replicas: int = 2
    """Replica count."""

    host: str = "web.example.com"
    """DNS name the certificate is issued for."""

    issuer: str = "letsencrypt"
    """The cert-manager ClusterIssuer that signs the certificate."""

input: Input = ctx.input()

_labels = {"app.kubernetes.io/name" = input.name}

resources = [
    appsv1.Deployment {
        metadata.name = input.name
        metadata.labels = _labels
        spec = {
            replicas = input.replicas
            selector.matchLabels = _labels
            template = {
                metadata.labels = _labels
                spec.containers = [corev1.Container {
                    name = input.name
                    image = input.image
                    ports = [{containerPort = 80, name = "http"}]
                }]
            }
        }
    }
    corev1.Service {
        metadata.name = input.name
        spec = {
            selector = _labels
            ports = [{port = 80, targetPort = "http"}]
        }
    }
    certmanager.Certificate {
        metadata.name = input.name
        spec = {
            secretName = "${input.name}-tls"
            dnsNames = [input.host]
            issuerRef = {name = input.issuer, kind = "ClusterIssuer"}
            privateKey.algorithm = "ECDSA"
        }
    }
]
