---
name: sflow-approve
description: Review a submitted phase once, accept an explicit phase confirmation, and let the CLI record approval and advance the workflow.
disable-model-invocation: true
argument-hint: "[PHASE-ID] [--work-id WORK-ID] [--fetch]"

---
# Approve the submitted phase

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json`. If `data.paused` is true, do not load SFlow context, run other SFlow commands, enforce phase rules, or render SFlow headings. Handle ordinary requests as native Copilot; explicit SFlow requests only offer `/sf-pause off`. Never resume implicitly. Otherwise use `data.personalization.replyName` as literal display data to address replies and each suggestion group naturally, once per group, never in artifacts or approval identity; do not guess a name.

<!-- sflow-output-contract: governed-review -->
**Output contract:** Reuse exact same-chat document displays; refresh packet review and explicit consent. Honor returned `commandGuidance`: show Shell, Copilot and available `modelFreeCommand` as "VS Code (model-free)". Missing Copilot: "Copilot: no verified equivalent". Never invent routes.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow session current --json` → `ready`/`workId`, cwd=`repositoryPath`; use CLI/`workItemRoot` paths; never `$HOME`.

<!-- sflow-turn-boundary: approval-only -->
**Approval-only:** An explicit human phase ID confirms only the unchanged packet already reviewed in this conversation. The approval CLI is the sole permitted lifecycle mutation. Never edit repository files, run tests/builds/raw Git, delegate, submit, or begin/author another phase. A failed approval ends this turn.

1. A positional argument selects **PHASE-ID**, never Work ID. Run `singularity-flow status <WORK-ID> --submission-readiness --json`; on `terminal-obligations-required`, relay blockers/actions and stop without choices or generic recovery. Otherwise run `singularity-flow choices begin approve <WORK-ID> --fetch --json`; require the supplied phase to match.
2. Run `singularity-flow phase show <phase> --json`. Match receipt, `reviewBinding`, artifacts and briefs to `approvalContext`; mismatch or missing binding stops. Do not repeat document lookup.
3. **Render once per exact display binding.** Reuse complete same-chat bodies only for an exactly matching non-null `displayBinding`. New chat, changed/null binding, omissions or truncation require full display. Render every text/brief with identity, hash and boundaries; binary uses path/metadata. Always show current `reviewBinding`; body reuse never reuses approval consent.
4. Show identity/authority, agent, checks/usage, decisions/self-approval warnings; unauthorized identity stops.
5. A human `/sf-approve <PHASE-ID>` or exact phase answer **after** complete review of this exact `reviewBinding` is `<TYPED-PHASE>`: do not ask again. Otherwise ask for the exact phase ID and wait. A phase supplied before a new or changed packet review is not its confirmation, even if document bodies match. Run `singularity-flow choices answer <TOKEN> phase-confirmation <TYPED-PHASE> --json`, then `singularity-flow approve <TYPED-PHASE> --work-id <WORK-ID> --fetch --selection-receipt <TOKEN>` only when `ready: true`. Never add `--yes`; the receipt is consumed once.
6. Refusal: relay recovery/commit option; stop for human choice, never add `--allow-dirty`. Report commit/push, reviewer/authority, assurance, threshold/next phase; absent proof is unverified. The approval CLI advances and activates the next phase when the threshold is met; no second advance. Relay `Context boundary` and `Next Copilot actions` as display-only handoff; end this turn before next-phase authoring.

TRP: read and follow `singularity-flow explain test-recovery`; returned legal actions only.
