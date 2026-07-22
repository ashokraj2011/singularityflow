---
name: sflow-about
description: Explain what Singularity Flow is, its current version, Git-native workflow model, main capabilities, and collision-safe sflow command namespace.
argument-hint: ""
disable-model-invocation: true
---
# About Singularity Flow

1. Run `sflow-about`. If that executable is unavailable, run `singularity-flow about`.
2. Return the command output faithfully and concisely. Explain that **Singularity Flow** is the product under the **Singularity** brand, while `sflow-` is its short public command prefix.
3. Make the command convention clear: Copilot uses `/sflow-<action>`; terminal shortcuts use `sflow-<action>` when packaged; `singularity-flow <action>` remains the compatible full CLI form.
4. Mention the installed version, Git-native state transfer, configurable workflows and personas, world-model grounding, artifacts and approvals, conformance reporting, and token/model reporting.
5. Direct detailed usage questions to `/sflow-help`.
6. Keep this operation read-only. Do not initialize a repository, modify workflow state, generate artifacts, commit, or push.
