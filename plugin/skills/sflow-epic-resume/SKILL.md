---
name: sflow-epic-resume
description: Resume an existing governed Epic from its latest published lead branch and reconstruct its phase, repository, and agent context.
disable-model-invocation: true

---

# Resume an Epic

<!-- sflow-output-contract: explicit-selection -->
**Output contract:** Collect every required choice explicitly; never infer or preselect; preserve errors, artifacts, and next actions.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents.

1. Require the Epic key.
2. Run `singularity-flow epic resume <EPIC-KEY> --fetch`.
3. Show the selected governed agent, real Git identity, current phase, lead branch head, pending publication, and participating repository state.
4. Stop on non-fast-forward or unpublished local state; never rewrite history.
5. Run `/sf-epic-next <EPIC-KEY>` to show the next valid action.
