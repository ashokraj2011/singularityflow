---
name: sflow-agents
description: Inspect, trust, synchronize, and refresh repository or plugin agent Markdown dependencies with hash-pinned remote content.
---

# Manage agent Markdown

Choose the requested operation:

- Discover: `singularity-flow agents list`.
- Inspect: `singularity-flow agents status [AGENT]`.
- First trust: `singularity-flow agents lock <AGENT>`.
- Review an update: `singularity-flow agents lock <AGENT> --update`.
- Materialize only locked content: `singularity-flow agents sync <AGENT>`.
- Refresh generated Markdown: `singularity-flow agents refresh-output <RESOURCE-ID> [--replace]`.

First trust and updates require exact agent-name confirmation. Never edit `singularity/agents.lock.yml` manually, bypass a changed hash, send credentials, or overwrite local output unless the user explicitly requests `--replace`.
