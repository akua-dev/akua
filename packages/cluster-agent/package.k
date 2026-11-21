# The Akua package for the cluster agent. It renders the Helm chart in this
# same directory, which is the single source of every agent manifest, so
# `helm upgrade --install` and an Akua install produce the same objects.
# Inputs are the chart's values, typed from its values.schema.json.
import akua.ctx
import charts.agent_chart

schema Input(agent_chart.Values):
    """The cluster agent chart's public inputs."""

input: Input = ctx.input()

resources = agent_chart.template(agent_chart.TemplateOpts {
    values = input
    release = "akua-cluster-agent"
    namespace = "akua-system"
})
