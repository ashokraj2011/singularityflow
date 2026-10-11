---
name: sflow-review
description: Inspect a governed review bundle or author a configured review phase; return its exact lifecycle handoff.
disable-model-invocation: true
argument-hint: "[phase] [review emphasis]"

---
# Portable review bundle and independent review

<!-- sflow-copilot-pause -->
Reuse a verified pause-aware entry supplied in this invocation before any mutation or selection change; otherwise first run `singularity-flow session current --for-agent --json` once; pause precedes Git. If `paused`: native Copilot, only `/sf-pause off`, never resume implicitly. Reuse binding/`personalization.replyName`; fresh operation checks/consent remain required.

<!-- sflow-output-contract: governed-review -->
**Output contract:** Present artifact references, hashes, identity warnings, and the exact confirmation before recording any decision. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. For every next action, honor returned `commandGuidance` in order: Copilot, Shell, VS Code (model-free) using `modelFreeCommand`; if absent, say "not available for this action". Missing Copilot: "no verified equivalent". Never invent routes.
<!-- sflow-execution-boundary -->
**Boundary:** reuse entry `ready`/`workId`, cwd=`repositoryPath`; CLI/`workItemRoot` paths only; never `$HOME`. No duplicate lookup.

Run `singularity-flow review <phase> --format json` for the explicit or active phase. Inspect artifacts, checks, decisions, diff/evidence; not retained source review or approval. HTML: `singularity-flow review <phase> --format html --out <file>`.

1. Run `singularity-flow status --json` and `singularity-flow phase show <phase> --for-agent --json`. Author only the current in-progress phase with verified effective authoring skill `/sf-review`. Otherwise perform inspection steps 3–6 and handoff 10; never compose, publish or invent a `review` phase.
2. For that authoring phase only, read Story context and `singularity-flow wm compose --phase <phase> --evidence`; use its complete prompt. Never derive `--task` from Story text.
3. Read approved inputs, implementation summary, verification evidence, diff and cited source.
4. Review correctness, acceptance coverage, maintainability, architecture alignment, security, failures, observability, rollout, rollback, and tests.
5. Rank findings by severity with file/line references.
6. Do not silently fix findings unless explicitly asked.
7. Prepare/author that configured review phase, then `singularity-flow phase prepublish <phase> --for-agent --json` (includes draft-check). If unready, `singularity-flow recover <WORK-ID> --phase <phase> --json`; stay here. Correct every agent authoring finding now only when `correction.sameTurn`; route other producers to their owner. Never delete markers blindly, invent facts/padding, nest models or overwrite producers. Substantive findings need a separate fix decision. Follow returned `repairLoop.protocol`; stop unchanged.
8. Use returned `commands.publish` when `ready`; absent: relay `commands.next`, stop. Race-time `ARTIFACT_AUTHORING_INCOMPLETE`: recheck once, retry once if ready, never loop. Never submit or approve.
9. If published, `singularity-flow phase show <phase> --for-agent --json`; summarize findings/status and give verified Markdown-preview links with generation/hashes and current `reviewBinding`. Read exact source/artifact bytes for the independent review, but never reproduce bodies/code/diffs in chat. Summaries/links are not human review; document reuse never reuses approval consent.
10. After authoring, refresh `singularity-flow review <phase> --format json`. Relay `continuation.actions`: phase and all three surfaces per the Output contract. Correction, review, human disposition and recovery precede Submit. If absent, `singularity-flow nextsteps <WORK-ID> --json`. Never submit or approve automatically.
