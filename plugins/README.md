# Agent plugins

Give your coding agent the [akuapkg package-authoring skills](akuapkg/):
create a Package, inspect dependencies, run checks and goldens, compare
rendered output, publish signed artifacts, and migrate a Helmfile.

The `akuapkg` directory is a self-contained
[Agent Plugins v1](https://agent-plugins.org/specification) package.

## Install

Use the [open skills installer](https://github.com/vercel-labs/skills) to
discover the skills and choose your agent:

```sh
bunx skills add akua-dev/akua
```

You can also copy the directories from `akuapkg/skills/` into your agent's
skills directory. Install the [akuapkg binary](../packages/akuapkg/#install)
to run their commands.

Part of [Akua's open-source tools](../README.md).
