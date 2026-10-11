---
name: sflow-approve
description: Review a submitted phase once, accept an explicit phase confirmation, and let the CLI record approval and advance the workflow.
disable-model-invocation: true
argument-hint: "[PHASE-ID] [--work-id WORK-ID] [--fetch]"

---
# Approve the submitted phase

<!-- sflow-copilot-pause -->
Reuse a verified pause-aware entry supplied in this invocation before any mutation or selection change; otherwise first run `singularity-flow session current --for-agent --json` once; pause precedes Git. If `paused`: native Copilot, only `/sf-pause off`, never resume implicitly. Reuse binding/`personalization.replyName`; fresh operation checks/consent remain required.

<!-- sflow-output-contract: governed-review -->
**Output contract:** Reuse exact same-chat document displays; refresh packet review and explicit consent. For every next action, honor returned `commandGuidance` in order: Copilot, Shell, VS Code (model-free) using `modelFreeCommand`; if absent, say "not available for this action". Missing Copilot: "no verified equivalent". Never invent routes.
<!-- sflow-execution-boundary -->
**Boundary:** reuse entry `ready`/`workId`, cwd=`repositoryPath`; CLI/`workItemRoot` paths only; never `$HOME`. No duplicate lookup.

<!-- sflow-turn-boundary: approval-only -->
**Approval-only:** An explicit human phase ID confirms only the unchanged packet already reviewed in this conversation. The approval CLI is the sole permitted lifecycle mutation. Never edit repository files, run tests/builds/raw Git, delegate, submit, or begin/author another phase. A failed approval ends this turn.

1. A positional argument selects **PHASE-ID**, never Work ID. Run `singularity-flow status <WORK-ID> --submission-readiness --json`; on `terminal-obligations-required`, relay blockers/actions and stop without choices or generic recovery. Otherwise run `singularity-flow choices begin approve <WORK-ID> --fetch --json`; require the supplied phase to match.
2. Run `singularity-flow phase show <phase> --for-agent --json`. Match receipt, `reviewBinding`, artifacts and briefs to `approvalContext`; mismatch or missing binding stops. Do not repeat document lookup.
3. **Render once per exact display binding.** Reuse complete visible same-chat bodies only for an exactly matching non-null `displayBinding`. New chat, changed/null binding, omissions or truncation require full display. Render every text/brief with identity, hash and `--- BEGIN <path> ---` / `--- END <path> ---`; binary uses path/metadata. Tool output or summaries are not review. Truncated content: stop. Always show current `reviewBinding`; body reuse never reuses approval consent.
4. Show identity/authority, agent, checks/usage, decisions/self-approval warnings; unauthorized identity stops.
5. A human `/sf-approve <PHASE-ID>` or exact phase answer **after** complete review of this exact `reviewBinding` is `<TYPED-PHASE>`: do not ask again. Otherwise ask for the exact phase ID and wait. A phase supplied before a new or changed packet review is not its confirmation, even if document bodies match. Run `singularity-flow choices answer <TOKEN> phase-confirmation <TYPED-PHASE> --json`, then `singularity-flow approve <TYPED-PHASE> --work-id <WORK-ID> --fetch --selection-receipt <TOKEN> --for-agent --json` only when `ready: true`. Never add `--yes`; the receipt is consumed once. `--for-agent` changes presentation, not authority.
6. Refusal or `PHASE_ALREADY_APPROVED`: relay returned actions and end this turn; never add `--allow-dirty`. Success: report the compact decision, commit/push, authority and self-approval warning. Do not reproduce artifacts, fetch next-phase context, delegate, or continue authoring. Relay a display-only handoff for a **new turn**, with Copilot, Shell, and VS Code (model-free), or explicit unavailability. The approval CLI advances and activates the next phase when the threshold is met; no second advance. End this turn before next-phase authoring.

TRP: read and follow `singularity-flow explain test-recovery`; returned legal actions only.
