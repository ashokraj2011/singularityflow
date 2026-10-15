---
name: sflow-submit
description: Validate and submit the active Singularity Flow phase for human approval, registering changed artifacts and running configured quality commands.
disable-model-invocation: true
argument-hint: "[--confirm sha256:<DIGEST> for a reviewed Convergence] [--skip-checks only when explicitly authorized]"

---
# Submit

<!-- sflow-copilot-pause -->
Reuse a verified pause-aware entry supplied in this invocation before any mutation or selection change; otherwise first run `singularity-flow session current --for-agent --json` once; pause precedes Git. If `paused`: native Copilot, only `/sf-pause off`, never resume implicitly. Reuse binding/`personalization.replyName`; fresh operation checks/consent remain required.

<!-- sflow-output-contract: governed-review -->
**Output contract:** Show artifact references, hashes, warnings, and confirmation before a decision. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. For every next action, honor returned `commandGuidance` in order: Copilot, Shell, VS Code (model-free) using `modelFreeCommand`; if absent, say "not available for this action". Missing Copilot: "no verified equivalent". Never invent routes. Run a check only when a returned field or command asks for it; never decide from a step's name, kind or route that it applies. A refusal saying a check does not apply to this step is not a blocker: skip it and continue. Act on a result's `act` first: its state, `do` routes and any `ask`. A bounded result lists `omittedFields` with exact line ranges in `agentOutput.path`; read only those you need with your file tool. Never stop because a result is long or was saved to a file.
<!-- sflow-execution-boundary -->
**Boundary:** reuse entry `ready`/`workId`, cwd=`repositoryPath`; CLI/`workItemRoot` paths only; never `$HOME`. No duplicate lookup.

`Out of sequence`: stop; humans confirm soft warnings.

1. Run `singularity-flow status <WORK-ID> --submission-readiness --for-agent --json --submit-if-ready`; require matching work/phase and its readiness fields. Trust `lifecycleReady`; never republish. For `terminal-obligations-required`, relay blockers/actions and stop—no submit or generic recovery.
2. `lifecycleReady: true`: **Published generation <N> — ready to submit**; otherwise disable Submit. Generation zero means unpublished, not missing code. `generation-required`: relay `authoringProgress.stage`, preservation instruction and exact `nextCommand`/`nextSkill`. Finish missing summary/planned bindings or validate the authored draft; never redo existing code, infer publication from manual tests, use session UUID as WORK-ID or generate/publish here.
3. Source review is part of readiness: only when it reports `source-review-required`, relay `sourceReviewFindings` and its exact review actions; never run a separate review check. Reviewer reports are not approval. Pending amendment acknowledgement requires the person's explicit choice.
4. `confirmationRequired: true`: show full warning and returned Work-ID-pinned command; human provides `continue`.
5. Readiness `classification` `convergence-advance-required`: never generic `singularity-flow submit`. Run returned `singularity-flow story advance` without `--confirm`; show review/digest, stop on unresolved dispositions. Invoked with `--confirm sha256:<DIGEST>` equal to the shown digest, or the person confirms it here: run it with `--confirm` once. Changed digest requires fresh review.
6. Unless `submitIfReady.submitted`, run returned Work-ID-pinned submit command. `--skip-checks` requires authorization.
7. On failure, fingerprint refusal plus artifact/check hashes and diagnosed runtime evidence. Nonzero exit fails despite passing JUnit. Proven environment repair permits retry without republishing unchanged source; changed source/artifacts need reviewed rollover. Stop on an unchanged condition or after three distinct repairs. Never loop quality commands or waive tests/integrity/policy. `/sf-recover` never substitutes for terminal decisions.
8. Use `submitIfReady.review`, else `singularity-flow phase show <phase> --for-agent --json`. Summarize submitted status/checks/warnings and list each artifact/brief's identity, generation/hash and verified Markdown-preview link. Preserve `displayBinding` and fresh `reviewBinding`; never reproduce document bodies, code or diffs. Tool output or summaries are not review.
9. Offer the approval route, not an approval decision. The human must review the complete linked documents; changed/null bindings or incomplete material need fresh review before approval. Never infer review from a summary, opening a preview or successful submission.
10. Report commit/push/hashes/checks/cost; offer `/sf-approve <PHASE-ID> --work-id <WORK-ID>` with real IDs; never approve.

TRP: follow `singularity-flow explain test-recovery`.
