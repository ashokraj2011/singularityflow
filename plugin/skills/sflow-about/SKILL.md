---
name: sflow-about
description: Show CLI and VS Code versions, build identities, build dates and mismatches, and explain Singularity Flow.
disable-model-invocation: true

---
# About Singularity Flow

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly.

<!-- sflow-output-contract: concise-relay -->
**Output contract:** Relay requested CLI fields or output faithfully; preserve warnings/errors and only the explanations required below. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. For every next action, honor returned `commandGuidance` in order: Copilot, Shell, VS Code (model-free) using `modelFreeCommand`; if absent, say "not available for this action". Missing Copilot: "no verified equivalent". Never invent routes. On a refusal or any stop, relay the returned route before ending: `remediationPlan` steps, else `commandGuidance`, `nextAction`, `continuation.actions` or `recovery.actions`, in that order; with none, offer `/sf-nextsteps`. Never retry an unchanged condition; run a returned action only when the person asks.
<!-- sflow-execution-boundary -->
**Boundary:** machine-local; no repository or Story required. Use explicit arguments or SFlow-returned paths; never search `$HOME` or infer a repository. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.

1. Run `sflow-about --markdown`. If that executable is unavailable, run `singularity-flow about --markdown`.
2. Render the build-information table visibly in Copilot, not just in tool output, a file link or a completion notice. Keep running-command, PATH CLI and VS Code rows separate; retain versions, build identities, UTC dates, mismatches, errors and unknowns. Never infer alignment from equal versions. Explain briefly that **Singularity Flow** is the product under the **Singularity** brand.
3. Make the command convention clear: Copilot uses `/sf-<action>`; terminal shortcuts use `sflow-<action>` when packaged; `singularity-flow <action>` remains the compatible full CLI form.
4. Summarize capabilities briefly. Build dates are not installation times. The VS Code About view also shows its loaded UI build; shell extension rows describe installed bytes, not a running window.
5. Direct detailed usage questions to `/sf-help`.
6. Keep this operation read-only. Do not initialize a repository, modify workflow state, generate artifacts, commit, or push.
