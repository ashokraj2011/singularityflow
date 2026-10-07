---
name: sflow-review-source
description: Independently check a published Story specification or plan against pinned sources and exact clause-to-test mappings, then submit the cited review packet.
disable-model-invocation: true
argument-hint: "[context|status|decide] <phase> [decision arguments]"

---

# Review source coverage

<!-- sflow-copilot-pause -->
Review: first run `singularity-flow review-source context --for-agent --json` once; it checks pause before Git and returns the current binding and exact review material. Explicit `status`/`decide`: first run `singularity-flow pause status --json`, then verify `singularity-flow session current --json`. If `paused`/`data.paused`, use native Copilot; explicit SFlow requests only offer `/sf-pause off`; never resume implicitly. Use returned `personalization.replyName` once per reply/suggestion group, never in artifacts or approval identity.

<!-- sflow-output-contract: governed-review -->
**Output contract:** Show the exact reviewed hashes, cited gaps, exclusions, questions, and test exceptions before any human approval. For suggested actions, pair Shell with the returned Copilot command; honor `commandGuidance`. If absent, say "Copilot: no verified equivalent"; never invent a slash command.
<!-- sflow-execution-boundary -->
**Boundary:** reuse this invocation's review entry: require `ready`/`workId`, valid `phaseAgent`; cwd=`repositoryPath`. Use returned `workItemRoot`/artifact and Git-private staging paths; never `$HOME`.

`status`: only `singularity-flow review-source status <phase> --json` and handoff. `decide`: read status, show finding/generation/report hash/authority/reason; obtain human confirmation. Never decide as reviewer or rerun review instead. Unknown forms: help, stop.

Read pinned `clarifications`/`clarificationGuidance`; acknowledge `clarificationsReviewed` IDs with phase/generation/question. Never re-ask settled answers. Deferred answers cannot waive gates/amend intent. Correct mistaken reviews in this generation; real gaps need successors.

1. Consume entry in `reviewGuide.readOrder`; texts/schema/template are complete. No key-enumeration, repeated hash/inventory queries or rescans. Include explicit phase in the first call. `canReview: false`: relay `continuation.actions`, stop; only the author prepares/publishes successors. Require `kind: specification|planning`, publication and inventory at `reportTemplate.binding`. Stop on unavailable/truncated sources. Never cite `unreadableSources`; each needs an `unreadable:<DOC-id>` human decision, carried while unchanged.
2. Use pinned `reviewer.instructions`; never set up/create/select an agent. Retention scopes `requiredReviewerAgentId` to this operation, preserving author. `blocked-author-conflict`: relay `recovery.actions`, never relabel history. Compare authored-content, not full-file hashes. Never edit source, artifacts, tests, workflow or approvals.
3. Fill `reportTemplate` against `reportSchema`, preserving its exact `binding`/metadata. Cite readable sources; attest only unreadable sources. Planning: preserve singular `clauseId`, `expectedPaths`, `plannedTests`; test-only rows need no product paths. Replace `unreviewed` honestly. Findings: `id`, `severity`, `message`, not `explanation`. Never mark a real gap supported merely to pass validation.
4. Stage at the returned Git-private path. Run `singularity-flow review-source check <phase> --report-file <that-path> --json`; repair format only, at most two changed-packet repair attempts. If `retentionReady` is false, relay fields and stop without commit/push. Retain valid packets, including honest gaps, with `singularity-flow review-source submit <phase> --report-file <that-path>`, once. Neither check nor retention approves or submits the phase.
5. Show hashes, source/clause/clarification IDs, questions, gaps/exceptions. Only `pendingDispositions` allow authorized human `singularity-flow review-source decide <phase> --finding <ID> --reason <TEXT>`; never waive blockers. End with `continuation.actions`: Shell/Copilot pair, target generation/owner. If absent: `singularity-flow review-source status <phase> --json`. Never publish/advance. Relay amendment acknowledgement first; never acknowledge for the person.
