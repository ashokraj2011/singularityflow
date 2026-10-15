---
name: sflow-review-source
description: Independently check a published Story specification or plan against pinned sources and exact clause-to-test mappings, then submit the cited review packet.
disable-model-invocation: true
argument-hint: "[context|stage|check|submit|status|decide] <phase> [operation arguments]"

---

# Review source coverage

<!-- sflow-copilot-pause -->
Review: first run `singularity-flow review-source context --for-agent --json` once; it checks pause before Git and returns exact review material. Explicit `stage`/`check`/`submit`/`status`/`decide`: reuse this invocation's verified entry, otherwise run `singularity-flow session current --for-agent --json` once. If `paused`, native Copilot; only `/sf-pause off`, never resume implicitly. Use `personalization.replyName` once per reply/suggestion group, never artifacts or approval identity. Lookup from current cwd (non-Git allowed). Never search `/Users`, `$HOME` or parents for a repo. Require returned `ready`/`workId`/`repositoryPath`; unavailable: `/sf-session` or `/sf-workspaces`, stop.

<!-- sflow-output-contract: governed-review -->
**Output contract:** Show the exact reviewed hashes, cited gaps, exclusions, questions, and test exceptions before any human approval. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. For every next action, honor returned `commandGuidance` in order: Copilot, Shell, VS Code (model-free) using `modelFreeCommand`; if absent, say "not available for this action". Missing Copilot: "no verified equivalent". Never invent routes. Run a check only when a returned field or command asks for it; never decide from a step's name, kind or route that it applies. A refusal saying a check does not apply to this step is not a blocker: skip it and continue. A command's JSON is complete even when long: if your tool saved it to a file, read that file to its end before acting; never treat a saved or long result as truncated or stop because of its size.
<!-- sflow-execution-boundary -->
**Boundary:** reuse this invocation's review entry: require `ready`/`workId`, valid `phaseAgent`; cwd=`repositoryPath`. Use returned `workItemRoot`/artifact and Git-private staging paths; never `$HOME`.

Explicit `stage`/`check`/`submit`: relay once. `status`: read. Legacy `decide`: retain phase/finding/reason; hand off to `/sf-review-decide` in a new turn. Never confirm/decide as reviewer. Unknown: help, stop.

Read pinned `clarifications`/`clarificationGuidance`; acknowledge `clarificationsReviewed` IDs with phase/generation/question. Never re-ask settled answers. Deferred answers cannot waive gates/amend intent. Correct mistaken reviews in this generation; real gaps need successors.

1. Consume entry in `reviewGuide.readOrder`; texts/schema/template are complete. No key-enumeration, repeated hash/inventory queries or rescans. Include explicit phase in the first call. `canReview: false`: relay `continuation.actions`, stop; only the author prepares/publishes successors. Require `kind: specification|planning`, publication and inventory at `reportTemplate.binding`. Stop on unavailable/truncated sources. Never cite `unreadableSources`; each needs an `unreadable:<DOC-id>` human decision, carried while unchanged.
2. Use `reviewer.instructions`; no agent setup/selection. Retention scopes `requiredReviewerAgentId`, preserving author. `blocked-author-conflict`: relay `recovery.actions`, never relabel history. Compare authored-content hashes. Never edit source, artifacts, tests, workflow or approvals.
3. Fill `reportTemplate` against `reportSchema`, preserving its exact `binding`/metadata. Cite readable sources; attest only unreadable sources. Planning: preserve singular `clauseId`, `expectedPaths`, `plannedTests`; test-only rows need no product paths. Replace `unreviewed` honestly. Findings: `id`, `severity`, `message`, not `explanation`. Never mark a real gap supported merely to pass validation.
4. Use `stagingProtocol`: file-edit tool at its exact path; terminal-only: `kernelStage` with completed shell-quoted JSON. Native file-read for outputs; no shell writers/parsers, mkdir, pipes/chains. Run `singularity-flow review-source check <phase> --report-file <that-path> --json` standalone; repair format only, at most two changed-packet repair attempts. If `retentionReady` is false, stop without commit/push. Retain valid packets, including honest gaps, with `stagingProtocol.retain`, once; never phase approval/submission. Tool-form refusal: correct the form, not the review/clarification.
5. Show hashes, source/clause/clarification IDs, questions, gaps/exceptions. Only `pendingDispositions` allow `/sf-review-decide <phase> --finding <ID> --reason <TEXT>` in a separate human-decision turn; never decide as reviewer or waive blockers. End with `continuation.actions`, target generation/owner; absent: `singularity-flow review-source status <phase> --json`. Never publish/advance or acknowledge amendments for the person.
