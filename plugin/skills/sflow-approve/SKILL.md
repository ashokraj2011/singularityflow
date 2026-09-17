---
name: sflow-approve
description: Review and approve a submitted phase as the current Git identity, recording its human authority group, phase-default agent, self-approval warning, hashes, commit, and push.
disable-model-invocation: true
argument-hint: "[WORK-ID] [--fetch]"

---
# Approve the submitted phase

<!-- sflow-output-contract: governed-review -->
**Output contract:** Show governed artifacts, hashes, identity warnings, and the exact confirmation before recording any decision.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow session current --json` → `ready`/`workId`, cwd=`repositoryPath`; use CLI/`workItemRoot` paths; never `$HOME`.

<!-- sflow-turn-boundary: approval-only -->
**Turn boundary — approval-only:** This is review, not authority to execute the reviewed plan. The typed phase ID is only a selection answer; it is not approval by itself. The approval CLI is the sole permitted mutation, including its governed commit/push. Never edit, create, delete, or patch repository files; never run tests, checks, builds, raw `git`, or separate commit/push; never delegate work; and never run submit, `next`, `nextsteps`, `/sf-next`, phase begin, generation, or next-phase work. Any refusal, mismatch, objection, or failed approval ends this turn.

Git identity—not agent selection—must match an approval authority.

1. Run `singularity-flow choices begin approve <WORK-ID> --fetch --json` first; use its phase, generation, hashes, review packet, and token.
2. Run `singularity-flow phase show <phase> --json` for `approvalContext.phase`. Require Work ID, phase, generation, paths, and SHA-256 values to match `approvalContext`; otherwise stop as a review-integrity failure.
3. **Always show the generated artifacts in Copilot before asking for a decision.** In a visible assistant response, reproduce every returned generated current-phase text document in full, including `agent-brief`, between `--- BEGIN <path> ---` and `--- END <path> ---`, with ID, kind, bytes, generation, and full SHA-256. A Shell/tool block does not satisfy artifact review. If response bounds require several messages, continue until every document is visible; never truncate or summarize instead. Never say “shown above.” Never ask for approval based only on a filename or summary.
4. Show reviewer/authority, phase agent, checks, usage, prior decisions, generator, packet hash, and self-approval warning. Unauthorized identity stops.
5. Only now: Ask the reviewer to type the exact phase ID from `approvalContext.phase`. Do not supply, autocomplete, infer, or silently record it. Run `singularity-flow choices answer <TOKEN> phase-confirmation <TYPED-PHASE> --json`, then `singularity-flow approve <TYPED-PHASE> --work-id <WORK-ID> --fetch --selection-receipt <TOKEN>` only when `ready: true`. Never add `--yes`; the CLI revalidates and consumes the receipt exactly once.
6. On `Out of sequence` or `Soft sequence warning`, render any current artifacts, relay the refusal, leave `continue` to the human, and stop.
7. Require the approval result to report its governed commit/publication. Otherwise report unverified approval and stop; never retry or infer success.
8. Report commit/push, reviewer, authority, agent, assurance, self-approval, remaining threshold, and next phase. Do not execute another tool afterward.
9. Reproduce `Context boundary` and `Next Copilot actions` as display-only handoff text; immediately end this turn before the next phase.
