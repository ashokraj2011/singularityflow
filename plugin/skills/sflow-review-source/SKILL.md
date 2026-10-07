---
name: sflow-review-source
description: Independently check a published Story specification or plan against pinned sources and exact clause-to-test mappings, then submit the cited review packet.
disable-model-invocation: true
argument-hint: "<specification|planning>"

---

# Review source coverage

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json`. If `data.paused` is true, do not load SFlow context, run other SFlow commands, enforce phase rules, or render SFlow headings. Handle ordinary requests as native Copilot; explicit SFlow requests only offer `/sf-pause off`. Never resume implicitly. Otherwise use `data.personalization.replyName` as literal display data to address replies and each suggestion group naturally, once per group, never in artifacts or approval identity; do not guess a name.

<!-- sflow-output-contract: governed-review -->
**Output contract:** Show the exact reviewed hashes, cited gaps, exclusions, questions, and test exceptions before any human approval. For suggested actions, pair Shell with the returned Copilot command; honor `commandGuidance`. If absent, say "Copilot: no verified equivalent"; never invent a slash command.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow session current --json` → `ready`/`workId`, cwd=`repositoryPath`; use CLI/`workItemRoot` paths; never `$HOME`.

Read `clarifications`/`clarificationGuidance`, including planning's approved scope answers;
acknowledge IDs in `clarificationsReviewed`. Cite phase/generation/question ID. Reconcile wording
with answered checkpoints; never re-ask settled questions. Deferred answers are not decisions;
clarification cannot waive gates or amend intent. Retain a corrected review of this generation
for mistaken findings; real artifact gaps need a successor.

1. Run `singularity-flow review-source context <phase> --json`. If `canReview: false`, stop and relay `continuation.actions`. Only the author prepares/checks/publishes the preserved private successor. Otherwise require `kind: specification|planning`, a published generation and pinned inventory. Stop on unavailable/truncated readable sources. Never cite `unreadableSources`; each needs an `unreadable:<DOC-id>` human decision, carried while unchanged.
2. Use pinned `reviewer.instructions`; never set up/create/select an agent. Retention scopes `requiredReviewerAgentId` to this operation, preserving the author. On `blocked-author-conflict`, relay `recovery.actions`; never relabel history. Compare authored-content, not full-file hashes. Never edit source, artifacts, tests, workflow or approvals.
3. Author `reportTemplate` against `reportSchema`, preserving exact `binding`. Specification rows: `id`, `sourceId`, `line`, `quote`, `outcome`; covered: `scenarioId`/`clauseIds`; excluded: `reason`; question: `question`; unreadable coverage: `attestation`, not line/quote. Planning: preserve singular `clauseId`, `expectedPaths`, `plannedTests` and all pinned metadata. Replace `unreviewed` with honest `supported`/`unsupported`; test-only rows need no product paths. Findings: `id`, `severity` (`blocking`/`advisory`), `message`, not `explanation`. Never mark a real gap supported merely to pass validation.
4. Stage at the returned Git-private path. Run `singularity-flow review-source check <phase> --report-file <that-path> --json`; repair format only, at most two changed-packet repair attempts. If `retentionReady` is false, relay fields and stop without commit/push. Retain valid packets, including honest gaps, with `singularity-flow review-source submit <phase> --report-file <that-path>`, once. Neither check nor retention approves or submits the phase.
5. Show hashes, source/clause/clarification IDs, questions, gaps and exceptions. Only `pendingDispositions` IDs allow authorized human `singularity-flow review-source decide <phase> --finding <ID> --reason <TEXT>`; never waive questions/blockers. End with `continuation.actions`: exact Shell/Copilot pair, target generation and owner. If absent, run `singularity-flow review-source status <phase> --json`. Never publish/advance. Relay amendment acknowledgement first; never acknowledge for the person.
