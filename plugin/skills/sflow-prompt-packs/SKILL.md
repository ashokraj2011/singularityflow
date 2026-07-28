---
name: sflow-prompt-packs
description: Inspect, trust, synchronize, and refresh hash-pinned remote Markdown prompt packs used as optional Copilot context; prompt packs are not people, working lenses, or approval authorities.
---

# Manage remote Markdown prompt packs

Choose the requested operation:

- Discover: `singularity-flow prompt-packs list`.
- Inspect: `singularity-flow prompt-packs status [PACK]`.
- First trust: `singularity-flow prompt-packs lock <PACK>`.
- Review an update: `singularity-flow prompt-packs lock <PACK> --update`.
- Materialize only locked content: `singularity-flow prompt-packs sync <PACK>`.
- Refresh generated Markdown: `singularity-flow prompt-packs refresh-output <RESOURCE-ID> [--replace]`.

First trust and updates require exact pack-name confirmation. Never edit `singularity/agents.lock.yml` manually, bypass a changed hash, send credentials, or overwrite local output unless the user explicitly requests `--replace`.

A prompt pack adds Markdown instructions, templates, or generated context to the active Copilot session. It cannot act as a human, select a working lens, or approve/reject lifecycle state.
