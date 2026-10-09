---
name: sflow-continue
description: Review a revision-bound action plan and execute only its selected current action.
disable-model-invocation: true
argument-hint: "[WORK-ID]"
---
# Continue governed work

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json`. If `data.paused` is true, do not load SFlow context, run other SFlow commands, enforce phase rules, or render SFlow headings. Handle ordinary requests as native Copilot; explicit SFlow requests only offer `/sf-pause off`. Never resume implicitly. Otherwise use `data.personalization.replyName` as literal display data to address replies and each suggestion group naturally, once per group, never in artifacts or approval identity; do not guess a name.

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions. Honor returned `commandGuidance`: show Shell, Copilot and available `modelFreeCommand` as "VS Code (model-free)". Missing Copilot: "Copilot: no verified equivalent". Never invent routes.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow session current --json` → `ready`/`workId`, cwd=`repositoryPath`; use CLI/`workItemRoot` paths; never `$HOME`.

1. Run `singularity-flow action plan <arguments> --json`.
2. Show plan ID, expiry, branch, HEAD, current lifecycle state, and every ordered action. Clearly separate executable `NOW` actions from `THEN` and `ALTERNATIVE` actions.
3. If there is no executable action, explain the missing choice or prerequisite. Never replace placeholders such as `<assignee>` or `<phase>` by guessing.
4. Ask the contributor to approve one exact action ID. Opening this skill is not approval to mutate.
5. For a mutating action, run `singularity-flow action authorize <PLAN-ID> --action <ACTION-ID> --confirm <ACTION-ID> --json` only after that confirmation. Capture its one-time token. Read-only actions do not need authorization.
6. Run `singularity-flow action execute <PLAN-ID> --action <ACTION-ID> --authorization <TOKEN>` with that token. The CLI consumes it once and rejects changed HEAD, branch, staged/unstaged bytes, lifecycle snapshot, expired plans, fabricated actions, and reused authorizations.
7. Report the command's real commit, push, pending-publication, artifact, approval, and next-action output. Never claim completion from the plan alone.
