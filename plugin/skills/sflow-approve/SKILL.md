---
name: sflow-approve
description: Review a submitted phase once, accept an explicit phase confirmation, and let the CLI record approval and advance the workflow.
disable-model-invocation: true
argument-hint: "[PHASE-ID] [--work-id WORK-ID] [--fetch]"

---
# Approve the submitted phase

<!-- sflow-output-contract: governed-review -->
**Output contract:** Reuse only same-chat, exact-packet review; preserve explicit consent, identity warnings and CLI result.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow session current --json` → `ready`/`workId`, cwd=`repositoryPath`; use CLI/`workItemRoot` paths; never `$HOME`.

<!-- sflow-turn-boundary: approval-only -->
**Approval-only:** An explicit human phase ID confirms only the unchanged packet already reviewed in this conversation. The approval CLI is the sole permitted lifecycle mutation. Never edit repository files, run tests/builds/raw Git, delegate, submit, or begin/author another phase. A failed approval ends this turn.

1. A positional argument selects **PHASE-ID**, never Work ID; Story comes from session or `--work-id`. Run `singularity-flow choices begin approve <WORK-ID> --fetch --json`. Supplied phase must equal `approvalContext.phase`; mismatch stops.
2. Run `singularity-flow phase show <phase> --json`. Match `reviewBinding` to receipt: repository path/HEAD, Work ID, phase/generation, source commit, packet hash. Match artifacts and brief `documentId`, `documentPath`, and `documentSha256` to `approvalContext`; brief `path` is integrity JSON. Only `fallback-whole` may lack a brief. Missing binding/mismatch: review-integrity failure; stop. Do not perform a second `singularity-flow documents view` lookup.
3. **Render once per exact review binding.** Reuse a complete visible display in this conversation only with matching non-null binding and full document ID/kind/path/bytes/generation/SHA-256 set. New chat, missing context, changed binding, omitted documents or truncated bodies require a new display. Render all text/briefs between `--- BEGIN <path> ---` and `--- END <path> ---` with metadata/binding, across messages if needed. Binary: path/metadata/open instruction. Tool output or summaries are not review. Truncated content: stop; never confirm an incomplete display.
4. Show current identity/authority, agent, checks/usage, decisions and self-approval warnings; unauthorized identity stops.
5. A human `/sf-approve <PHASE-ID>` or exact phase answer **after** the matching display is `<TYPED-PHASE>`: do not ask again. Otherwise ask the reviewer to type the exact phase ID and wait. A phase supplied before a new or changed display is not its confirmation. Never infer consent. Run `singularity-flow choices answer <TOKEN> phase-confirmation <TYPED-PHASE> --json`, then `singularity-flow approve <TYPED-PHASE> --work-id <WORK-ID> --fetch --selection-receipt <TOKEN>` only when `ready: true`. Never add `--yes`; CLI revalidates and consumes the receipt exactly once.
6. Refusal: relay and stop; human owns `continue`. No commit/publication proof: unverified. Report commit/push, reviewer/authority, assurance, threshold and next phase. The approval CLI advances and activates the next phase when the threshold is met; no second advance. Relay `Context boundary` and `Next Copilot actions` as display-only handoff; end this turn before next-phase authoring.

TRP: read and follow `singularity-flow explain test-recovery`; returned legal actions only.
