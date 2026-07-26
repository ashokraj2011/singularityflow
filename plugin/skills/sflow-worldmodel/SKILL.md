---
name: sflow-worldmodel
description: Build, verify, inspect, and compose the repository-owned world model used to ground governed phase prompts.
---

# Manage the repository world model

Use the requested operation:

- Initialize configuration: `singularity-flow wm init`.
- Build from the exact source tree: `singularity-flow wm build [--phase PHASE] [--task TEXT] [--focus TEXT] [--depth quick|standard|deep]`.
- Verify freshness and generation metadata: `singularity-flow wm check`.
- Inspect routed context: `singularity-flow wm context <PHASE> [--task TEXT] [--concat] [--evidence] [--no-persona]`.
- Compose a governed prompt: `singularity-flow wm compose [--persona ID] [--phase ID] [--task TEXT] [--evidence] [--dry-run]`.

The model remains in the repository. Always report its generated timestamp, source-tree hash, commit, selected views, and stale reason. Do not claim it is current when `wm check` fails.
