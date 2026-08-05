---
name: sflow-continue
description: Review a revision-bound action plan and execute only its selected current action.
disable-model-invocation: true
argument-hint: "[WORK-ID]"
---
# Continue governed work

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Never infer a transition. Bind it to current Git and lifecycle state, show it, and execute it only after explicit approval.

1. Run `singularity-flow action plan <arguments> --json`.
2. Show plan ID, expiry, branch, HEAD, current lifecycle state, and every ordered action. Clearly separate executable `NOW` actions from `THEN` and `ALTERNATIVE` actions.
3. If there is no executable action, explain the missing choice or prerequisite. Never replace placeholders such as `<assignee>` or `<phase>` by guessing.
4. Ask the contributor to approve one exact action ID. Opening this skill is not approval to mutate.
5. Run `singularity-flow action execute <PLAN-ID> --action <ACTION-ID> --confirm <KERNEL-CONFIRMATION>` only after that confirmation, using the exact `confirmation.valueFromKernel` from the selected action. Omit `--confirm` only when the action says `confirmation.required: false`. The CLI rejects changed HEAD, branch, worktree, lifecycle snapshot, missing confirmation, expired plans, and replays.
6. Report the command's real commit, push, pending-publication, artifact, approval, and next-action output. Never claim completion from the plan alone.
