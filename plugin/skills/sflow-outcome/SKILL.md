---
name: sflow-outcome
description: Review a Story delivery and ask which test, local application setup, evidence review or repair to perform next.
disable-model-invocation: true
agent: agent
argument-hint: "[WORK-ID] [--capability ID]"

---
# Check the outcome

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly. This skill is already loaded; never call the skill tool for it. Unless paused, continue below in this turn.

<!-- sflow-output-contract: concise-relay -->
**Output contract:** Relay requested CLI fields or output faithfully; preserve warnings/errors and only the explanations required below. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. Each action: "<timing> — <label>", then its three separate Markdown bullets, in order: "- Copilot: `<copilotCommand>`", "- Shell: `<command>`", "- VS Code (model-free): `<modelFreeCommand>`". Keep returned routes exact; never apart from their label, on one line or in a table. Missing Copilot: "no verified equivalent"; missing Shell or model-free: "not available for this action". Never invent routes or make more calls for formatting. Where the steps say ask_user, use your host's question tool: ask_user in the Copilot CLI, vscode_askQuestions in VS Code; it is unavailable only when neither exists.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.

1. Use the Boundary repository. With an explicit Work ID, do not require or change the active Story. Without an ID, run `singularity-flow session current --json` and require its `ready` Story; use its exact `repositoryPath` as cwd.
2. Run `singularity-flow outcome <WORK-ID> --for-agent --json`, adding `--capability` only when the person named one.
3. From `data.outcome`, summarize `lifecycle`, `completion`, `validation.steps`, retained test results and diagnostic runs separately. Show application readiness and genuine errors. A missing launch configuration is a setup choice, not a Story blocker. Backend and CLI deliveries use their declared tests and evidence without an invented web UI.
4. Show acceptance gaps and owed checks, with exact reference/evidence paths. An existing screenshot is not a recorded sign-off. Preserve `open.scopeItems` and `open.blocking` routes; never turn an advisory into a new approval gate.
5. Ask `validation.question` now with its `choices`. Prefer native `sflowDeliveryValidation` with the exact Work ID and returned `application.capability`. Without that tool use `ask_user`; without a question tool print the question and choices and wait. A summary alone is not the handoff. Do not call the native tool again after cancellation or an unchanged refusal.
6. Only after an explicit choice: run the selected returned app start/stop or tests route. Run a start in your terminal tool's background (async) mode, as its choice's `how` says, then `singularity-flow app status --json` until ready. Missing launch settings: use the setup route and `/sf-run-app`'s exact issued draft, preview it and save a personal checkout profile after the person confirms it. Do not modify shared test definitions, source files or secret values. A required environment binding is the person's terminal action. Report actual results and offer the remaining choices, without automatically asking them again. Repair uses its exact author/owner route; Continue shows existing workflow actions and waives nothing. Human sign-off uses `sflowWitnessReview` or the person's exact witness command, never model-supplied checklist answers. No acceptance, submission or approval here.
