---
name: sflow-epic-resume
description: Resume an existing governed Epic from its latest published lead branch and reconstruct its phase, repository, and agent context.
disable-model-invocation: true

---

# Resume an Epic

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json`. If `data.paused` is true, do not load SFlow context, run other SFlow commands, enforce phase rules, or render SFlow headings. Handle ordinary requests as native Copilot; explicit SFlow requests only offer `/sf-pause off`. Never resume implicitly. Otherwise use `data.personalization.replyName` as literal display data to address replies and each suggestion group naturally, once per group, never in artifacts or approval identity; do not guess a name.

<!-- sflow-output-contract: explicit-selection -->
**Output contract:** Collect every required choice explicitly; never infer or preselect; preserve errors, artifacts, and next actions. Honor returned `commandGuidance`: show Shell, Copilot and available `modelFreeCommand` as "VS Code (model-free)". Missing Copilot: "Copilot: no verified equivalent". Never invent routes.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents.

1. Require the Epic key.
2. Run `singularity-flow epic resume <EPIC-KEY> --fetch`.
3. Show the selected governed agent, real Git identity, current phase, lead branch head, pending publication, and participating repository state.
4. Stop on non-fast-forward or unpublished local state; never rewrite history.
5. Run `/sf-epic-next <EPIC-KEY>` to show the next valid action.
