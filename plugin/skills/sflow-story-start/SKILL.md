---
name: sflow-story-start
description: Select a Jira Story, workflow, and prompt-only governed agent, then create or resume its canonical governed branch.
disable-model-invocation: true
argument-hint: "<JIRA-STORY-KEY>"

---
# Start a governed Jira Story

<!-- sflow-output-contract: explicit-selection -->
**Output contract:** Collect every required choice explicitly; never infer or preselect; preserve errors, artifacts, and next actions.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow workspace current --json` → cwd=`repositoryPath`; never `$HOME`. Story: `singularity/work-items/<WORK-ID>/`.

1. Without a key, run `singularity-flow jira assigned --type Story --json` and ask the contributor to choose. Never infer it.
2. Run `singularity-flow jira pull <STORY-KEY> --json`; show its details before mutation.
3. Verify its Jira project routes to this repository or active workspace; otherwise switch first.
4. Run `git status --short`; stop for unrelated changes.
5. Run `singularity-flow workspace branches --json`. Present branches published by every required repository and require a choice; stop if a remote fails. Start `singularity-flow story start <STORY-KEY> --fetch --from-branch <SELECTED-BRANCH>` interactively and bridge workflow choices through `ask_user`. For `poc-workflow`, ask for the exact authorized target and pass `--target-url <AUTHORIZED-URL>`.
6. If persistent terminal input is unavailable:
   - Run `singularity-flow choices begin start <STORY-KEY> --json`.
   - Present and record `base-branch`; never preselect it.
   - Record `jira` for `intake-source`.
   - Present the workflow-template and governed-agent options with `ask_user`.
   - Record answers with `singularity-flow choices answer`.
   - When ready, run `singularity-flow story start <STORY-KEY> --fetch --selection-receipt <TOKEN>`; add `--target-url <AUTHORIZED-URL>` only for `poc-workflow`.
7. Show the Epic → Jira Story → canonical branch lineage, base/commit, workflow, agent, phase, outputs, commit, and pushed Story ref. Verify the base ref did not move.
8. Then run `singularity-flow wm availability --phase <CURRENT-PHASE> --task "<STORY-TITLE>"`. If grounding is missing/stale, show the matching `wm ensure` command and require authorization. Never use `--local`.
9. Show world-model provenance and push status. On failure, keep intake and explain that `/sf-phase` waits for `/sf-worldmodel`.
10. Continue only when asked; offer `/sf-phase` and read-only `/sf-nextsteps`.

The canonical branch is the exact Jira key. Jira intake pins the normalized issue snapshot in Git; it does not silently update Jira status or create an approval. Main, workspace, and Epic intake never require or warn about a world model.
