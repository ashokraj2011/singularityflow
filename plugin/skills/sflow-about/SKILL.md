---
name: sflow-about
description: Explain what Singularity Flow is, its current version, Git-native workflow model, main capabilities, and collision-safe sflow command namespace.
disable-model-invocation: true
argument-hint: ""

---
# About Singularity Flow

<!-- sflow-output-contract: concise-relay -->
**Output contract:** Return the named CLI command output verbatim; do not elaborate, re-narrate, or hide errors.

1. Run `sflow-about`. If that executable is unavailable, run `singularity-flow about`.
2. Return the command output faithfully and concisely. Explain that **Singularity Flow** is the product under the **Singularity** brand, while `sflow-` is its short public command prefix.
3. Make the command convention clear: Copilot uses `/sf-<action>`; terminal shortcuts use `sflow-<action>` when packaged; `singularity-flow <action>` remains the compatible full CLI form.
4. Mention the installed version, Git-native state transfer, configurable workflows and prompt-only governed agents, human approval authorities, world-model grounding, artifacts, conformance reporting, and token/model reporting.
5. Direct detailed usage questions to `/sf-help`.
6. Keep this operation read-only. Do not initialize a repository, modify workflow state, generate artifacts, commit, or push.
