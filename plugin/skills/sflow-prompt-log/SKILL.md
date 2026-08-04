---
name: sflow-prompt-log
description: Enable, disable, inspect, or display the workspace-local audit log of governed prompts Singularity Flow sends to Copilot for each agent and Story phase. Use when a contributor or reviewer needs prompt provenance without changing workflow state.
---

# Manage governed prompt auditing

1. Interpret `$ARGUMENTS` as one of `on`, `off`, `status`, `list`, or `view <record-id>`; use `status` when no action is supplied.
2. Run `singularity-flow prompt-log <action>`, forwarding filters such as `--agent`, `--phase`, `--work-id`, and `--limit` unchanged.
3. Explain that capture is off by default, machine-local, and applies only to future `wm compose` handoffs. It does not backfill prompts or change workflow state.
4. For `list`, reproduce the complete table. For `view`, reproduce the complete prompt and identify its agent, Story, phase, generation, timestamp, and hash from `singularity-flow prompt-log view <id> --json`.
5. Never claim this captures Copilot's hidden system prompt, chat history, or provider internals. It captures only the governed prompt assembled by Singularity Flow.
6. Warn that prompts can contain proprietary requirements and source context. The logger removes recognized token shapes, records any redaction count, and stores the result only in the selected workspace (or the repository-local Git control area when no workspace is active).
