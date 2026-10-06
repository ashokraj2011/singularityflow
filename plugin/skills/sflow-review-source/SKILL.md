---
name: sflow-review-source
description: Independently check a published Story specification or plan against pinned sources and exact clause-to-test mappings, then submit the cited review packet.
disable-model-invocation: true
argument-hint: "<specification|planning>"

---

# Review source coverage

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json`. If `data.paused` is true, do not load SFlow context, run other SFlow commands, enforce phase rules, or render SFlow headings. Handle ordinary requests as native Copilot; explicit SFlow requests only offer `/sf-pause off`. Never resume implicitly.

<!-- sflow-output-contract: governed-review -->
**Output contract:** Show the exact reviewed hashes, cited gaps, exclusions, questions, and test exceptions before any human approval. For suggested actions, pair Shell with the returned Copilot command; honor `commandGuidance`. If absent, say "Copilot: no verified equivalent"; never invent a slash command.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow session current --json` → `ready`/`workId`, cwd=`repositoryPath`; use CLI/`workItemRoot` paths; never `$HOME`.

1. Run `singularity-flow review-source context <phase> --json`. Require `kind: specification|planning`, a current published generation and complete pinned inventory. Stop on unavailable/truncated readable sources. `unreadableSources` cannot be cited; each needs an `unreadable:<DOC-id>` human decision, carried across reports/generations while unchanged.
2. Use pinned `reviewer.instructions`; no agent setup, creation, or persistent agent selection is needed. Retention scopes `requiredReviewerAgentId` to this review, preserving the author. On `blocked-author-conflict`, relay `recovery.actions`: honestly publish a successor, never relabel history. Compare authored-content hashes only; registered-file integrity is separately verified. Do not edit source, artifacts, tests, workflow or approvals.
3. Author `reportTemplate` against the returned `reportSchema`; never borrow another Story's format. Preserve the exact `binding`. Specification rows use `id`, `sourceId`, `line`, `quote`, `outcome`, and for covered rows `scenarioId`/`clauseIds`; exclusions need `reason`, questions need `question`. Unreadable coverage uses `attestation` instead of line/quote. Planning rows are prefilled: preserve singular `clauseId`, `expectedPaths`, `plannedTests`, disposition/reason and obligation metadata. Replace every `unreviewed` assessment with an honest `supported` or `unsupported`; pinned test-only rows legitimately have no product paths. Findings require `id`, `severity` (`blocking`/`advisory`), and `message`, not `explanation`. Never mark a real gap supported merely to pass validation.
4. Stage only at the returned Git-private path. Run `singularity-flow review-source check <phase> --report-file <that-path> --json` before submit. Correct listed format fields locally, then recheck; at most two changed-packet repair attempts, never a repeated identical failure. If `retentionReady` is false, report the exact fields and stop without commit/push. A format-valid packet may still expose semantic gaps or human decisions: retain those honestly with `singularity-flow review-source submit <phase> --report-file <that-path>`, once, under the independent reviewer. A check grants no authority. Do not rewrite the author's plan/specification from this review route.
5. Show retained hash, sources/clauses, findings, exclusions, questions and test exceptions. Corrections go to the artifact author; exclusions, attested/unreadable rows and test exceptions need authorized human `singularity-flow review-source decide <phase> --finding <ID> --reason <TEXT>`. Review corrected generations again. Return control to the phase author; do not advance the phase from this review route. Relay any explicit amendment acknowledgement route first; never acknowledge for the person.
