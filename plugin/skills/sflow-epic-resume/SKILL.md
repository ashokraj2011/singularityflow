---
name: sflow-epic-resume
description: Resume an existing governed Epic from its latest published lead branch and reconstruct its phase, repository, and agent context.
disable-model-invocation: true

---

# Resume an Epic

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly.

<!-- sflow-output-contract: explicit-selection -->
**Output contract:** Collect every required choice explicitly; never infer or preselect; preserve errors, artifacts, and next actions. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. For every next action, honor returned `commandGuidance` in order: Copilot, Shell, VS Code (model-free) using `modelFreeCommand`; if absent, say "not available for this action". Missing Copilot: "no verified equivalent". Never invent routes.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents.

1. Require the Epic key.
2. Run `singularity-flow epic resume <EPIC-KEY> --fetch`.
3. Show the selected governed agent, real Git identity, current phase, lead branch head, pending publication, and participating repository state.
4. Stop only on a CLI refusal (it checks the checkout itself); never rewrite history.
5. Run `/sf-epic-next <EPIC-KEY>` to show the next valid action.
