# Using akuapkg with AI agents

akuapkg is built to be driven by coding agents as well as people. An agent
runs it like any other command, as `akuapkg` or as `akua pkg`; there is no
MCP server to set up.

## What an agent gets

- **JSON without asking.** akuapkg detects agent sessions (`AGENT`,
  `CLAUDECODE`, `GEMINI_CLI`, `CURSOR_CLI` or `AKUA_AGENT` set) and prints
  JSON as if `--json` were passed. `--no-json` forces text.
- **Errors to branch on.** Failures carry a stable `code`, a `suggestion`
  when one is known, and a typed exit code (0 success, 1 user error, 2 system
  error, 6 out of CPU budget). See [cli-contract.md](cli-contract.md).
- **Type errors with locations.** Because Packages are typed, a wrong field
  name or type comes back as a compile error with file, line and often a
  suggestion, which an agent can fix without guessing.
- **A safe default.** Renders run in the sandbox, and in agent context a
  render also refuses `replace` overrides in `akua.toml`.

## Skills

The repository ships [Agent Skills](https://agentskills.io) under
[`skills/`](../plugins/akuapkg/skills/): task procedures an agent loads when the task
matches.

| Skill | Use when |
|---|---|
| [new-package](../plugins/akuapkg/skills/new-package/) | starting a Package, typed against Kubernetes and CRDs |
| [inspect-package](../plugins/akuapkg/skills/inspect-package/) | auditing a Package or chart before using it |
| [test-and-lint](../plugins/akuapkg/skills/test-and-lint/) | setting up checks, tests and golden snapshots |
| [diff-gate](../plugins/akuapkg/skills/diff-gate/) | reviewing what a dependency or input change does to the output |
| [publish-signed](../plugins/akuapkg/skills/publish-signed/) | publishing a signed, attested Package |
| [migrate-helmfile](../plugins/akuapkg/skills/migrate-helmfile/) | turning a `helmfile.yaml` into a Package |

Agents that read repository-local skills pick them up from a checkout. For a
global install, follow your agent's instructions for Agent Skills.

## A typical loop

```text
intent: "add Traefik to the checkout service"

akuapkg add traefik --oci oci://ghcr.io/traefik/helm/traefik --version 37.1.1
edit package.k: call traefik.template(...) with typed traefik.Values
akuapkg check                  # parse, imports, lockfile
akuapkg render --dry-run       # type errors come back as E_RENDER_KCL
akuapkg test --golden          # snapshot drift shows what changed
git commit, open a pull request; CI runs akuapkg lock --check and verify
```

## Writing a skill

A skill is a directory with a `SKILL.md` (see
[the specification](https://agentskills.io/specification)):

```markdown
---
name: my-skill
description: What this does and when to use it, with trigger words.
---

# My skill

Step-by-step instructions.
```

Validate it with `bunx skills-ref validate ./plugins/akuapkg/skills/my-skill`.

## Related topics

- [CLI contract](cli-contract.md)
- [Command reference](https://docs.akua.dev/akua/cli)
- [Typed resources](typed-resources.md)
