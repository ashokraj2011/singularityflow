---
name: sflow-apm
description: Show the repository's APM agent packages - what each deployed, whether its files are still the ones APM wrote, which steps their agents draft - and preview an install, update or publish without changing anything.
disable-model-invocation: true
agent: agent
argument-hint: "[PACKAGE]"
---
# APM agent packages

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly. This skill is already loaded; never call the skill tool for it. Unless paused, continue below in this turn.

<!-- sflow-output-contract: concise-relay -->
**Output contract:** Relay requested CLI fields or output faithfully; preserve warnings/errors and only the explanations required below. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. After a blank line, display each next action as three separate Markdown bullets, in order: "- Copilot: `<copilotCommand>`", "- Shell: `<command>`", "- VS Code (model-free): `<modelFreeCommand>`". Preserve exact returned routes; never combine them on one line or in a table. Missing Copilot: "no verified equivalent"; missing Shell or model-free: "not available for this action". Never invent routes or make further calls for formatting.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.


1. Run `singularity-flow apm status --json` in the Boundary repository. It reads only the committed files: no APM CLI and no network.
2. Say `state` in plain words. For each `packages` item give its `label`, `version` or `commit` and its `primitives`; then each `agents.bindings` entry: an active one drafts its `defaultFor` steps; a waiting one quotes `waiting`, and its steps keep their workflow's own agent. List `agents.unusable` with each `reason`, the `findings`, `cli.found`, and `nextActions` exactly.
3. When the person asks to install, update, publish, start a marketplace or write the organisation's policy, run only its preview: `singularity-flow apm install <PACKAGE> --dry-run`, `singularity-flow apm update --dry-run`, `singularity-flow apm publish <AGENT> --marketplace <CHECKOUT> --dry-run`, `singularity-flow apm marketplace init --name <NAME> --owner <OWNER> --dry-run` or `singularity-flow apm policy init --marketplace <OWNER/REPOSITORY> --dry-run`. Relay what it would change, then give the same command without `--dry-run`: it changes which agents run, so the person runs it in their own terminal.
4. To choose the steps an APM agent drafts, run `singularity-flow apm attach <AGENT> --step <STEP> --dry-run`, relay it, and give the command with `--propose` in place of `--dry-run`, or Workflow Studio.
5. Never edit `apm.yml`, `apm.lock.yaml`, a deployed agent or skill, or `workflow.yml` `apm`, and never run the APM CLI itself.
