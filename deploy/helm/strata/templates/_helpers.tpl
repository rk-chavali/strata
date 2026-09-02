{{/*
Name helpers, following the conventions `helm create` establishes so that anyone who has
read another chart can predict what these produce.
*/}}

{{- define "strata.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "strata.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "strata.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "strata.labels" -}}
helm.sh/chart: {{ include "strata.chart" . }}
{{ include "strata.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{/*
Selector labels are immutable on a Deployment, so they deliberately exclude anything that
changes between releases : no version, no chart. Putting `app.kubernetes.io/version` in
here would make every `helm upgrade` that bumps the image fail with "field is immutable".
*/}}
{{- define "strata.selectorLabels" -}}
app.kubernetes.io/name: {{ include "strata.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/* The Secret holding the GitHub token, whether the chart made it or the operator did. */}}
{{- define "strata.githubSecretName" -}}
{{- if .Values.github.existingSecret -}}
{{- .Values.github.existingSecret -}}
{{- else -}}
{{- printf "%s-github" (include "strata.fullname" .) -}}
{{- end -}}
{{- end -}}

{{- define "strata.hasGithubToken" -}}
{{- if or .Values.github.existingSecret .Values.github.token -}}true{{- end -}}
{{- end -}}

{{- define "strata.pvcName" -}}
{{- if .Values.persistence.existingClaim -}}
{{- .Values.persistence.existingClaim -}}
{{- else -}}
{{- printf "%s-data" (include "strata.fullname" .) -}}
{{- end -}}
{{- end -}}
