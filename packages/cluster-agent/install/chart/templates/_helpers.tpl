{{/* The chart installs into akua-system only; the contract fixes the namespace. */}}
{{- define "akua.namespace" -}}
{{- if ne .Release.Namespace "akua-system" -}}
{{- fail (printf "akua-cluster-agent must be installed in namespace akua-system, got %q (use --namespace akua-system --create-namespace)" .Release.Namespace) -}}
{{- end -}}
akua-system
{{- end -}}

{{- define "akua.labels" -}}
app.kubernetes.io/name: akua-cluster-agent
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{/* Call with (dict "root" . "component" "agent"). Selector labels never change: selectors are immutable. */}}
{{- define "akua.componentLabels" -}}
{{ include "akua.labels" .root }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "akua.selectorLabels" -}}
app.kubernetes.io/name: akua-cluster-agent
app.kubernetes.io/component: {{ . }}
{{- end -}}

{{- define "akua.agentImage" -}}
{{ .Values.image.repository }}@{{ .Values.image.digest }}
{{- end -}}

{{- define "akua.updaterImage" -}}
{{- $repo := default .Values.image.repository .Values.updater.image.repository -}}
{{- $digest := default .Values.image.digest .Values.updater.image.digest -}}
{{ $repo }}@{{ $digest }}
{{- end -}}

{{/* Both access shapes are validated here as well as in values.schema.json. */}}
{{- define "akua.access" -}}
{{- $a := .Values.access | default dict -}}
{{- if and (hasKey $a "cluster") (hasKey $a "namespaces") -}}
{{- fail "access must set exactly one of cluster or namespaces, not both" -}}
{{- end -}}
{{- if not (or (hasKey $a "cluster") (hasKey $a "namespaces")) -}}
{{- fail "access must set exactly one of cluster ({}) or namespaces (non-empty list)" -}}
{{- end -}}
{{- if and (hasKey $a "namespaces") (empty $a.namespaces) -}}
{{- fail "access.namespaces must list at least one namespace" -}}
{{- end -}}
{{- /* Akua fully manages a hosted cluster; a connected one keeps the grant its owner chose. */ -}}
{{- if and (eq .Values.enrollment.method "federated") (not (hasKey $a "cluster")) -}}
{{- fail "hosted clusters (enrollment.method federated) grant akua-apply cluster-admin: set access: {cluster: {}}" -}}
{{- end -}}
{{- end -}}

{{- define "akua.podSecurityContext" -}}
runAsNonRoot: true
runAsUser: 65532
runAsGroup: 65532
fsGroup: 65532
seccompProfile:
  type: RuntimeDefault
{{- end -}}

{{- define "akua.containerSecurityContext" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities:
  drop:
    - ALL
{{- end -}}

{{- define "akua.scheduling" -}}
{{- with .Values.priorityClassName }}
priorityClassName: {{ . | quote }}
{{- end }}
{{- with .Values.nodeSelector }}
nodeSelector:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .Values.tolerations }}
tolerations:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .Values.affinity }}
affinity:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- end -}}
