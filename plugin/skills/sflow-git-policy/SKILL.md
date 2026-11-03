---
name: sflow-git-policy
description: Discover repository commit policy, inspect approved coverage, or validate an exact owner-issued plan without committing or approving.
disable-model-invocation: true

---
# Repository commit policy

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly. This skill is already loaded; never call the skill tool for it. Unless paused, continue below in this turn.

<!-- sflow-output-contract: concise-relay -->
**Output contract:** Relay requested CLI fields or output faithfully; preserve warnings/errors and only the explanations required below. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. After a blank line, display each next action as three separate Markdown bullets, in order: "- Copilot: `<copilotCommand>`", "- Shell: `<command>`", "- VS Code (model-free): `<modelFreeCommand>`". Preserve exact returned routes; never combine them on one line or in a table. Missing Copilot: "no verified equivalent"; missing Shell or model-free: "not available for this action". Never invent routes or make further calls for formatting.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.

Run `singularity-flow git-policy show --for-agent --json` once unless the user selected `discover`, `plan` or `validate`. For discovery, run `singularity-flow git-policy discover --for-agent --json`. For plan or validation, use only the exact `--operation` identifier already issued by the CLI; never manufacture an operation, write an executable plan, infer a tracking key or select a different adapter. Run that selected command once.

Summarize adopted mode, exact policy/authority, hook coverage and observed failures. Discovery never executes hooks or JavaScript configuration. Registered checks are approved equivalents, not native hook execution. Native validation belongs to the existing commit owner. Keep object-created, ref-advanced and remote outcomes distinct. Unknown remains unknown; none implies approval or CI success.

Follow the returned repair/setup or existing configuration-review route. Never disable hooks, add skip flags/environment, install a guessed tool, alter protected hook/configuration files, amend a retained commit, or replay a timestamp-producing hook. No commit, push, activation or approval is performed by this skill. Relay the next action without executing it.
