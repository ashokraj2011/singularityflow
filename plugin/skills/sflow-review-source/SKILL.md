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

Read packet `clarifications`/`clarificationGuidance`, including planning's approved scope answers;
acknowledge each ID in `clarificationsReviewed` after reading it. Cite phase/generation/question ID.
Reconcile wording with answered checkpoints; do not re-ask settled questions. Deferred answers are
not decisions; clarification neither waives gates nor silently amends intent. If the artifact
already follows an answer, retain a corrected review of this generation; real gaps need a successor.

1. Run `singularity-flow review-source context <phase> --json`. Require `kind: specification|planning`, a current published generation and complete pinned inventory. Stop on unavailable/truncated readable sources. `unreadableSources` cannot be cited; each needs an `unreadable:<DOC-id>` human decision, carried across reports/generations while unchanged.
2. Use pinned `reviewer.instructions`; no agent setup, creation, or persistent agent selection is needed. Retention scopes `requiredReviewerAgentId` to this review, preserving the author. On `blocked-author-conflict`, relay `recovery.actions`: honestly publish a successor, never relabel history. Compare authored-content hashes only; registered-file integrity is separately verified. Do not edit source, artifacts, tests, workflow or approvals.
3. Author `reportTemplate` against `reportSchema`, preserving exact `binding`. Specification rows: `id`, `sourceId`, `line`, `quote`, `outcome`; covered: `scenarioId`/`clauseIds`; excluded: `reason`; question: `question`; unreadable coverage: `attestation`, not line/quote. Planning: preserve singular `clauseId`, `expectedPaths`, `plannedTests` and all pinned metadata. Replace `unreviewed` with honest `supported`/`unsupported`; test-only rows need no product paths. Findings: `id`, `severity` (`blocking`/`advisory`), `message`, not `explanation`. Never mark a real gap supported merely to pass validation.
4. Stage at the returned Git-private path. Run `singularity-flow review-source check <phase> --report-file <that-path> --json`; repair format only, at most two changed-packet repair attempts. If `retentionReady` is false, relay fields and stop without commit/push. Retain valid packets, including honest gaps, with `singularity-flow review-source submit <phase> --report-file <that-path>`, once. Neither check nor retention approves or submits the phase.
5. Show hashes, source/clause/clarification IDs, questions, gaps and exceptions. Only `pendingDispositions` IDs permit authorized human `singularity-flow review-source decide <phase> --finding <ID> --reason <TEXT>`; questions/blockers cannot be waived there. Return to the author; review corrected generations again, never advance. Relay amendment acknowledgement first; never acknowledge for the person.
