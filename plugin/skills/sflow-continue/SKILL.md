---
name: sflow-continue
description: Review a revision-bound action plan and execute only its selected current action.
disable-model-invocation: true
argument-hint: "[WORK-ID]"
---
# Continue governed work

<!-- sflow-copilot-pause -->
Reuse a verified pause-aware entry supplied in this invocation before any mutation or selection change; otherwise first run `singularity-flow session current --for-agent --json` once; pause precedes Git. If `paused`: native Copilot, only `/sf-pause off`, never resume implicitly. Reuse binding/`personalization.replyName`; fresh operation checks/consent remain required.

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. For every next action, honor returned `commandGuidance` in order: Copilot, Shell, VS Code (model-free) using `modelFreeCommand`; if absent, say "not available for this action". Missing Copilot: "no verified equivalent". Never invent routes. On a refusal read `remediationPlan`: run its first read-only step once and follow `context.strategy`; never retry an unchanged condition or edit an earlier phase to clear it. One returned `automatic` plan-hash action (such as `sync`) may run once, then re-enter once. Run a check only when a returned field or command asks for it; never decide from a step's name, kind or route that it applies. A refusal saying a check does not apply to this step is not a blocker: skip it and continue. Act on a result's `act` first: its state, `do` routes and any `ask`. A bounded result lists `omittedFields` with exact line ranges in `agentOutput.path`; read only those you need with your file tool. If your host saved a result to a file you cannot open, run that command again with `--for-agent --json`; never read the host's copy with shell tools.
<!-- sflow-execution-boundary -->
**Boundary:** reuse entry `ready`/`workId`, cwd=`repositoryPath`; CLI/`workItemRoot` paths only; never `$HOME`. No duplicate lookup.

1. Run `singularity-flow action plan <arguments> --json`.
2. Show plan ID, expiry, branch, HEAD, current lifecycle state, and every ordered action. Clearly separate executable `NOW` actions from `THEN` and `ALTERNATIVE` actions.
3. If there is no executable action, explain the missing choice or prerequisite. Never replace placeholders such as `<assignee>` or `<phase>` by guessing.
4. Ask the contributor to approve one exact action ID. Opening this skill is not approval to mutate.
5. For a mutating action, run `singularity-flow action authorize <PLAN-ID> --action <ACTION-ID> --confirm <ACTION-ID> --json` only after that confirmation. Capture its one-time token. Read-only actions do not need authorization.
6. Run `singularity-flow action execute <PLAN-ID> --action <ACTION-ID> --authorization <TOKEN>` with that token. The CLI consumes it once and rejects changed HEAD, branch, staged/unstaged bytes, lifecycle snapshot, expired plans, fabricated actions, and reused authorizations.
7. Report the command's real commit, push, pending-publication, artifact, approval, and next-action output. Never claim completion from the plan alone.
