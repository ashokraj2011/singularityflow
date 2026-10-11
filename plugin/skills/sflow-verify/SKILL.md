---
name: sflow-verify
description: Verify implementation against acceptance criteria, run checks, capture evidence, and register the Singularity Flow verification artifact.
disable-model-invocation: true
argument-hint: "[test scope or environment]"

---
# Verification phase

<!-- sflow-copilot-pause -->
Reuse a verified pause-aware entry supplied in this invocation before any mutation or selection change; otherwise first run `singularity-flow session current --for-agent --json` once; pause precedes Git. If `paused`: native Copilot, only `/sf-pause off`, never resume implicitly. Reuse binding/`personalization.replyName`; fresh operation checks/consent remain required.

<!-- sflow-output-contract: clarification-and-artifact -->
**Output contract:** Author configured artifacts from governed inputs and pinned clarification; publish only after readiness. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. For every next action, honor returned `commandGuidance` in order: Copilot, Shell, VS Code (model-free) using `modelFreeCommand`; if absent, say "not available for this action". Missing Copilot: "no verified equivalent". Never invent routes.
<!-- sflow-execution-boundary -->
**Boundary:** reuse entry `ready`/`workId`, cwd=`repositoryPath`; CLI/`workItemRoot` paths only; never `$HOME`. No duplicate lookup.

1. Run `singularity-flow nextsteps --json` for any workflow. Stop at recovery, pending publication, approval, completion or cancellation. For Boundary phase `release`, never author verification: relay the returned release routes and stop.
2. Require Boundary `ready`, phase `verification`, exact `phaseAgent`; otherwise relay the nextsteps route and stop. Run `singularity-flow phase show verification --for-agent --json`. If `policyVerified` is false, show `policyReason`; stop. If `effectiveAuthoringSkill` is not `/sf-phase`, relay it and stop. Keep Story context governed.
3. Run `singularity-flow phase enter verification --compose --for-agent --json`; use `context.text` and `retainedExecutionEvidence`. Never derive `--task` from Story text.
4. Read approved requirements/design/implementation/source.
5. Map each AC to evidence and qualified `@ac:WORK-ID:AC-001` in an executable test. Inspect source-bound `@clause:WORK-ID:REQ-001` as a trace witness, not a verdict. Reject bare `AC-001`; honor reviewed test-only/non-code exemptions.
6. Use bound runs over stale prose; IDE discovery is not execution. Honor runner ownership; no substitute commands. Command success is not criterion acceptance. Source edits need governed repair/fresh evidence.
7. Cover relevant regression, boundaries, failures, security, accessibility/performance.
8. Preparation is not authoring. Run `singularity-flow prepare verification`; use the native file-edit tool to complete the existing artifact with observed evidence and `Agent brief`: verdict, failures/omissions, risk, release recommendation. Resolve TODOs, preserve managed blocks. Failed/unavailable tests are not passes; never invent results.
9. Run `singularity-flow phase prepublish verification --for-agent --json` (includes draft-check). If unready, run read-only `singularity-flow recover <WORK-ID> --phase verification --json`. Correct every agent finding now; route other producers to owner. Never delete markers blindly, invent facts, use padding, invoke nested models, or overwrite another producer. Follow returned `repairLoop.protocol` for persistent correction/resume; stop unchanged.
10. Use returned `commands.publish` when `ready`; absent: relay `commands.next`, stop. Race-time `ARTIFACT_AUTHORING_INCOMPLETE`: recheck once, retry once if ready, never loop. Never submit or approve.
11. Run `singularity-flow phase show verification --for-agent --json`; summarize tests, gaps, publication, verified Markdown-preview links, generation/hashes and `reviewBinding`. No bodies/code/diffs; summaries/links are not human review or reusable approval consent.
12. Never submit/approve. End with each `handoff` from step 11: `Next in Copilot: /sf-…` from its `copilotCommand`, then `Terminal equivalent: singularity-flow …` from its `command`.
