---
name: sflow-review-source
description: Independently check a published Story specification or plan against pinned sources and exact clause-to-test mappings, then submit the cited review packet.
disable-model-invocation: true
argument-hint: "[context|status|decide] <phase> [decision arguments]"

---

# Review source coverage

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json`. If `data.paused` is true, do not load SFlow context, run other SFlow commands, enforce phase rules, or render SFlow headings. Handle ordinary requests as native Copilot; explicit SFlow requests only offer `/sf-pause off`. Never resume implicitly. Otherwise use `data.personalization.replyName` as literal display data to address replies and each suggestion group naturally, once per group, never in artifacts or approval identity; do not guess a name.

<!-- sflow-output-contract: governed-review -->
**Output contract:** Show the exact reviewed hashes, cited gaps, exclusions, questions, and test exceptions before any human approval. For suggested actions, pair Shell with the returned Copilot command; honor `commandGuidance`. If absent, say "Copilot: no verified equivalent"; never invent a slash command.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow session current --json` → `ready`/`workId`, cwd=`repositoryPath`; use CLI/`workItemRoot` paths; never `$HOME`.

Explicit `status`: only `singularity-flow review-source status <phase> --json` and handoff. Explicit `decide`: read status, show pending finding, generation, report hash, authority/reason; confirm with the human before that exact decision. Never decide as reviewer or rerun review instead. Unknown forms stop with help. Otherwise review below.

Read `clarifications`/`clarificationGuidance`, including approved scope answers; acknowledge `clarificationsReviewed` IDs with phase/generation/question. Never re-ask settled answers. Deferred answers cannot waive gates/amend intent. Retain a corrected review of this generation for mistaken findings; real gaps need a successor.

1. Run `singularity-flow review-source context <phase> --json`. If `canReview: false`, stop and relay `continuation.actions`. Only the author prepares/checks/publishes the preserved private successor. Require `kind: specification|planning`, publication and pinned inventory. Stop on unavailable/truncated sources. Never cite `unreadableSources`; each needs an `unreadable:<DOC-id>` human decision, carried while unchanged.
2. Use pinned `reviewer.instructions`; never set up/create/select an agent. Retention scopes `requiredReviewerAgentId` to this operation, preserving the author. On `blocked-author-conflict`, relay `recovery.actions`; never relabel history. Compare authored-content, not full-file hashes. Never edit source, artifacts, tests, workflow or approvals.
3. Fill `reportTemplate` against `reportSchema`, preserving exact `binding`/metadata. Cite readable sources; attest only unreadable sources. Planning: preserve singular `clauseId`, `expectedPaths`, `plannedTests`; test-only rows need no product paths. Replace `unreviewed` honestly. Findings: `id`, `severity`, `message`, not `explanation`. Never mark a real gap supported merely to pass validation.
4. Stage at the returned Git-private path. Run `singularity-flow review-source check <phase> --report-file <that-path> --json`; repair format only, at most two changed-packet repair attempts. If `retentionReady` is false, relay fields and stop without commit/push. Retain valid packets, including honest gaps, with `singularity-flow review-source submit <phase> --report-file <that-path>`, once. Neither check nor retention approves or submits the phase.
5. Show hashes, source/clause/clarification IDs, questions, gaps and exceptions. Only `pendingDispositions` IDs allow authorized human `singularity-flow review-source decide <phase> --finding <ID> --reason <TEXT>`; never waive questions/blockers. End with `continuation.actions`: exact Shell/Copilot pair, target generation and owner. If absent, run `singularity-flow review-source status <phase> --json`. Never publish/advance. Relay amendment acknowledgement first; never acknowledge for the person.
