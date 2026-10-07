---
name: sflow-review
description: Inspect a governed review bundle or author a configured review phase; return its exact lifecycle handoff.
disable-model-invocation: true
argument-hint: "[phase] [review emphasis]"

---
# Portable review bundle and independent review

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json`. If `data.paused` is true, do not load SFlow context, run other SFlow commands, enforce phase rules, or render SFlow headings. Handle ordinary requests as native Copilot; explicit SFlow requests only offer `/sf-pause off`. Never resume implicitly. Otherwise use `data.personalization.replyName` as literal display data to address replies and each suggestion group naturally, once per group, never in artifacts or approval identity; do not guess a name.

<!-- sflow-output-contract: governed-review -->
**Output contract:** Show governed artifacts, hashes, identity warnings, and the exact confirmation before recording any decision. For suggested actions, pair Shell with the returned Copilot command; honor `commandGuidance`. If absent, say "Copilot: no verified equivalent"; never invent a slash command.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow session current --json` → `ready`/`workId`, cwd=`repositoryPath`; use CLI/`workItemRoot` paths; never `$HOME`.

Run `singularity-flow review <phase> --format json` for the explicit or active phase. Inspect artifacts, checks, decisions, diff/evidence; not retained source review or approval. HTML: `singularity-flow review <phase> --format html --out <file>`.

1. Run `singularity-flow status --json` and `singularity-flow phase show <phase> --json`. Author only the current in-progress phase with verified effective authoring skill `/sf-review`. Otherwise perform inspection steps 3–6 and handoff 10; never compose, publish or invent a `review` phase.
2. For that authoring phase only, read Story context and `singularity-flow wm compose --phase <phase> --evidence`; use its complete prompt. Missing WM adds zero context; never rebuild implicitly or derive `--task` from Story text.
3. Read approved inputs, implementation summary, verification evidence, diff and cited source.
4. Review correctness, acceptance coverage, maintainability, architecture alignment, security, failures, observability, rollout, rollback, and tests.
5. Rank findings by severity with file/line references.
6. Do not silently fix findings unless explicitly asked.
7. Prepare/author that configured review phase, then `singularity-flow phase prepublish <phase> --for-agent --json` (includes draft-check). If unready, `singularity-flow recover <WORK-ID> --phase <phase> --json`; stay here. Correct every agent authoring finding now only when `correction.sameTurn`; route other producers to their owner. Never delete markers blindly, invent facts/padding, nest models or overwrite producers. Substantive findings need a separate fix decision. Follow returned `repairLoop.protocol`; stop unchanged.
8. Use returned `commands.publish` when `ready`; absent: relay `commands.next`, stop. Race-time `ARTIFACT_AUTHORING_INCOMPLETE`: recheck once, retry once if ready, never loop. Never submit or approve.
9. If published, `singularity-flow phase show <phase> --json`; retain `displayBinding` and `reviewBinding`. Reuse bodies only from a complete visible same-chat display with exactly matching non-null `displayBinding`. Otherwise reproduce every published text document in full: ID/kind/path/bytes/generation/SHA-256 and `--- BEGIN <path> ---` / `--- END <path> ---`. New chat, changed/null binding, omissions or truncation require full display. Tool output or summaries are not review. Binary: path/metadata/open instruction. Show the current `reviewBinding`; body reuse never reuses approval consent.
10. After authoring, refresh `singularity-flow review <phase> --format json`. Relay `continuation.actions`: phase and Shell/Copilot pair. Correction, review, human disposition and recovery precede Submit. If absent, `singularity-flow nextsteps <WORK-ID> --json`. Never submit or approve automatically.
