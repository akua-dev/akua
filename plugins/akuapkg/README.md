# akuapkg skills

Agent workflows for common akuapkg tasks. Each directory is a skill in the
[Agent Skills](https://agentskills.io/specification) format: a `SKILL.md`
with a `name` and a `description` in its frontmatter, and step-by-step
instructions in its body. Agents read the descriptions of all skills and
load a skill's body only when a task matches it.

| Skill | What it does |
|---|---|
| [new-package](skills/new-package/) | Scaffold a Package typed against Kubernetes and CRDs |
| [inspect-package](skills/inspect-package/) | Audit a Package or chart before using it |
| [test-and-lint](skills/test-and-lint/) | Set up checks, tests and golden snapshots |
| [diff-gate](skills/diff-gate/) | Show and gate what a change does to the rendered output |
| [publish-signed](skills/publish-signed/) | Publish a cosign-signed, attested Package |
| [migrate-helmfile](skills/migrate-helmfile/) | Turn a `helmfile.yaml` into a Package |

## Installing

See [plugin installation](../README.md#install).

Validate a skill with `bunx skills-ref validate ./skills/<name>`.

## Writing a skill

Keep each skill to one task, use real `akuapkg` commands, and say what
success looks like. See [docs/agent-usage.md](../../docs/agent-usage.md).
