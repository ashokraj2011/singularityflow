---
name: sflow-requirements
description: Produce and register a requirements artifact, with scope and testable acceptance criteria, for the requirements step or any step that chose this skill.
disable-model-invocation: true
argument-hint: "[additional business context]"

---
# Requirements

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json`. If `data.paused` is true, do not load SFlow context, run other SFlow commands, enforce phase rules, or render SFlow headings. Handle ordinary requests as native Copilot; explicit SFlow requests only offer `/sf-pause off`. Never resume implicitly. Otherwise use `data.personalization.replyName` as literal display data to address replies and each suggestion group naturally, once per group, never in artifacts or approval identity; do not guess a name.

<!-- sflow-output-contract: clarification-and-artifact -->
**Output contract:** Use governed inputs and pinned clarification; publish/show configured artifacts. For suggested actions, pair Shell with the returned Copilot command; honor `commandGuidance`. If absent, say "Copilot: no verified equivalent"; never invent a slash command.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow session current --json` → `ready`/`workId`, cwd=`repositoryPath`; use CLI/`workItemRoot` paths; never `$HOME`.

1. For the Boundary `phase`, run `singularity-flow phase show <phase> --json`. If `policyVerified` is false, show `policyReason`; stop. Continue only if `effectiveAuthoringSkill` is `/sf-requirements`, or `/sf-phase` with `authoringSkill` null and `<phase>` = `requirements`; else show `Next in Copilot:` `effectiveAuthoringSkill` and `Terminal equivalent: singularity-flow prepare <phase>`, or that a null route drafts nothing; stop. Its governed workflow is Story context.
2. Run `singularity-flow documents list`; view relevant inputs before deciding what is unclear.
3. Run `singularity-flow wm compose --phase <phase>`; use its complete prompt and the approved inputs it names. Missing WM means zero context and ordinary repo access; recovery is optional. Never derive `--task` from Story text.
4. Run `singularity-flow clarification status <phase> --json`. For `off`, do not ask or record; continue. For `when-needed`, ask and record only for material ambiguity; otherwise continue. For `required`, use `ask_user` once, wait and record before preparation; if unavailable, display the questions and stop; even when evidence looks complete, confirm outcome, scope and acceptance. Record via `singularity-flow clarification record <phase> --response-file <file>`.
5. Run `singularity-flow prepare <phase>` and read the returned path and `source.json`.
6. Inspect only grounding-selected files. Do not implement code.
7. Cover problem, outcome, scope, measurable acceptance criteria with stable qualified `[WORK-ID:AC-001]` anchors (using the actual work ID), dependencies, assumptions, risks, confirmed decisions, and deferred questions. Never use a bare `AC-001` as the authoritative clause ID.
8. Run `singularity-flow phase draft-check <phase> --json`, then `singularity-flow phase prepublish <phase> --json`. If unready, run read-only `singularity-flow recover <WORK-ID> --phase <phase> --json`; stay in this phase. Correct every agent finding now from governed evidence only when `correction.sameTurn`; otherwise route to its owner/regenerator. Never blindly delete markers, invent facts or padding, invoke a nested model, or overwrite another producer. Follow returned `repairLoop.protocol` for persistent correction/resume; stop unchanged.
9. Only when prepublish `status` is `ready`, publish via `singularity-flow phase publish <phase>` with its configured producer/channel. Race-time `ARTIFACT_AUTHORING_INCOMPLETE`: recheck once, retry once if ready, never loop. Never submit or approve.
10. Run `singularity-flow phase show <phase> --json`; retain `displayBinding` and `reviewBinding`. Reuse bodies only from a complete visible same-chat display with exactly matching non-null `displayBinding`. Otherwise reproduce every published text document in full: ID/kind/path/bytes/generation/SHA-256 and `--- BEGIN <path> ---` / `--- END <path> ---`. New chat, changed/null binding, omissions or truncation require full display. Tool output or summaries are not review. Binary: path/metadata/open instruction. Show the current `reviewBinding`; body reuse never reuses approval consent.
11. Report decisions, tokens, and commit. End with each returned `handoff`: `Next in Copilot: /sf-…` from its `copilotCommand`, then `Terminal equivalent: singularity-flow …` from its `command`; do not submit or approve.
