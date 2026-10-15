---
name: sflow-review-decide
description: Record a confirmed, hash-bound human disposition for an existing source-review exclusion or test exception; never independently review or approve a phase.
disable-model-invocation: true
argument-hint: "<phase> --finding <ID> --reason <TEXT> [--work-id <WORK-ID>]"
---

# Decide a pending source-review exception

<!-- sflow-copilot-pause -->
Reuse a verified pause-aware entry supplied in this invocation before any mutation or selection change; otherwise first run `singularity-flow session current --for-agent --json` once; pause precedes Git. If `paused`: native Copilot, only `/sf-pause off`, never resume implicitly. Reuse binding/`personalization.replyName`; fresh operation checks/consent remain required.

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. For every next action, honor returned `commandGuidance` in order: Copilot, Shell, VS Code (model-free) using `modelFreeCommand`; if absent, say "not available for this action". Missing Copilot: "no verified equivalent". Never invent routes. On a refusal read `remediationPlan`: run its first read-only step once and follow `context.strategy`; never retry an unchanged condition or edit an earlier phase to clear it. One returned `automatic` plan-hash action (such as `sync`) may run once, then re-enter once. Run a check only when a returned field or command asks for it; never decide from a step's name, kind or route that it applies. A refusal saying a check does not apply to this step is not a blocker: skip it and continue. Act on a result's `act` first: its state, `do` routes and any `ask`. A bounded result lists `omittedFields` with exact line ranges in `agentOutput.path`; read only those you need with your file tool. Never stop because a result is long or was saved to a file.
<!-- sflow-execution-boundary -->
**Boundary:** reuse entry `ready`/`workId`, cwd=`repositoryPath`; CLI/`workItemRoot` paths only; never `$HOME`. No duplicate lookup.

Human-decision-only: no direct repository edits, reviewer retention, tests, publication, submission or approval.

1. Require the supplied phase and Work ID to match the active binding. Preserve supplied finding/reason; ask only for missing values. Run `singularity-flow review-source decision-context <phase> --work-id <WORK-ID> --finding <ID> --reason <TEXT> --json` once. A missing/stale finding or unauthorized identity stops. If the selected agent is the source reviewer, relay the returned author-selection route for a new turn; never silently switch agents.
2. Show `binding` and `packetSha256`: exact report, generation, finding, reason and human authority. Require explicit human confirmation of this packet. Reuse a same-chat confirmation only when all those values are unchanged; never infer consent from the reason, invocation, reviewer output or a supplied `--confirm` flag. A changed packet needs fresh review, not repeated unchanged questions.
3. After confirmation, run the returned `commandGuidance.command` once, standalone. The CLI checks authority, pending status and exact confirmation again inside its transaction. This records only this exception; it does not attest a screenshot, approve or advance the phase. Stop on refusal; never retry unchanged or relax a gate.
4. End this turn. Relay the result's `continuation.actions`; if absent, read `singularity-flow review-source status <phase> --json` once. Another pending finding needs its own human decision; a ready review routes to submission in a new turn.
