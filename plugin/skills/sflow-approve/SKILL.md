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
**Output contract:** Require human review of exact bound documents outside chat; refresh packet and explicit consent. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. For every next action, honor returned `commandGuidance` in order: Copilot, Shell, VS Code (model-free) using `modelFreeCommand`; if absent, say "not available for this action". Missing Copilot: "no verified equivalent". Never invent routes. Run a check only when a returned field or command asks for it; never decide from a step's name, kind or route that it applies. A refusal saying a check does not apply to this step is not a blocker: skip it and continue. A command's JSON is complete even when long: if your tool saved it to a file, read that file to its end before acting; never treat a saved or long result as truncated or stop because of its size.
<!-- sflow-execution-boundary -->
**Boundary:** reuse entry `ready`/`workId`, cwd=`repositoryPath`; CLI/`workItemRoot` paths only; never `$HOME`. No duplicate lookup.

<!-- sflow-turn-boundary: approval-only -->
**Approval-only:** An explicit human phase ID confirms only the unchanged packet already reviewed in this conversation. The approval CLI is the sole permitted lifecycle mutation. Never edit repository files, run tests/builds/raw Git, delegate, submit, or begin/author another phase. A failed approval ends this turn.

1. A positional argument selects **PHASE-ID**, never Work ID. Run `singularity-flow choices begin approve <WORK-ID> --fetch --json --review-packet`; on `approvalPacket.readiness` `terminal-obligations-required`, relay blockers/actions and stop without choices or generic recovery. Require the supplied phase to match.
2. `approvalPacket.review` is `singularity-flow phase show <phase> --for-agent --json`. Match receipt, `reviewBinding`, artifacts and briefs to `approvalContext`; mismatch or missing binding stops. Do not repeat document lookup.
3. **Review outside chat against the exact binding.** List each artifact/brief's identity, generation/hash and verified Markdown-preview link; binary uses metadata/path. Require human review of complete bound documents; never infer it from opened previews. Reuse same-chat human acknowledgement only for an exactly matching non-null `displayBinding` and unchanged `reviewBinding`. New chat, changed/null binding, omissions or truncation require fresh human review. Tool output or summaries are not review. Show current `reviewBinding`; document reuse never reuses approval consent.
4. Show identity/authority, agent, checks/usage, decisions/`owedDecisions`/self-approval warnings; unauthorized identity stops.
5. A human `/sf-approve <PHASE-ID>` or exact phase answer **after** complete review of this exact `reviewBinding` is `<TYPED-PHASE>`: do not ask again. Otherwise ask for the exact phase ID to confirm linked-document review and approval; wait. A phase supplied before a new or changed packet review is not its confirmation, even if document bodies match. Run `singularity-flow choices answer <TOKEN> phase-confirmation <TYPED-PHASE> --json`, then `singularity-flow approve <TYPED-PHASE> --work-id <WORK-ID> --fetch --selection-receipt <TOKEN> --for-agent --json` only when `ready: true`. Never add `--yes`; the receipt is consumed once. `--for-agent` changes presentation, not authority.
6. Refusal or `PHASE_ALREADY_APPROVED`: relay, end turn; never `--allow-dirty`. Success: commit/push, authority/self-approval. Relay `contextBoundary`: `new` → `/clear`, then `/sf-next`; `compact` → `/compact`, then `/sf-next`; `keep` → next turn. No Shell/model-free reset equivalent. The approval CLI advances and activates the next phase when the threshold is met; no second advance. End this turn before next-phase authoring.

TRP: read and follow `singularity-flow explain test-recovery`; returned legal actions only.
