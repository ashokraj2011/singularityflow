---
name: sflow-requirements
description: Produce and register a requirements artifact, with scope and testable acceptance criteria, for the requirements step or any step that chose this skill.
disable-model-invocation: true
argument-hint: "[additional business context]"

---
# Requirements

<!-- sflow-copilot-pause -->
First run `singularity-flow phase enter --for-agent --json` once. Lookup from current cwd (non-Git allowed). Never search `/Users`, `$HOME` or parents for a repo. Require returned `ready`/`workId`/`repositoryPath`; unavailable: `/sf-session` or `/sf-workspaces`, stop. It checks pause before Git. If `paused`, native Copilot; only offer `/sf-pause off`, never resume implicitly. Otherwise follow `agentGuide.readOrder` once, reuse binding/recovery/clarification/references and delivered inputs; no duplicate lookups. Use `personalization.replyName` literally in replies, never artifacts or approval identity.

<!-- sflow-output-contract: clarification-and-artifact -->
**Output contract:** Use governed inputs and pinned clarification; publish/show configured artifacts. Honor returned `commandGuidance`: show Shell, Copilot and available `modelFreeCommand` as "VS Code (model-free)". Missing Copilot: "Copilot: no verified equivalent". Never invent routes.
<!-- sflow-execution-boundary -->
**Boundary:** reuse entry `ready`/`workId`, valid `phaseAgent`; cwd=`repositoryPath`. Returned `workItemRoot`/artifact paths only; never `$HOME`.
Blocked: relay `resolution.issues[].choices` too. Eligible risk needs reason/expiry and authorized human confirmation. Never auto-accept risk.

1. Use entry `authoring`. If `policyVerified` is false, show `policyReason`; stop. Continue only if `effectiveAuthoringSkill` is `/sf-requirements`, or `/sf-phase` with `authoringSkill` null and `<phase>` = `requirements`; else relay its verified route; null drafts nothing. `retained-generation`: relay `next`, stop.
2. Run `singularity-flow documents list`; view relevant inputs before deciding what is unclear.
3. Review recovery/diffs; stop for protected/unowned edits or human decisions. `successor-preparation-required`: run `successor.preparation.command`, preserve drafts/publications, refresh entry once. Run `singularity-flow phase enter <phase> --work-id <WORK-ID> --compose --for-agent --json` once; use `context.text`/reference paths. Not admitted: relay blockers/next, stop. Missing WM: optional zero context. Never infer `--task`; expand only needed missing/truncated inputs.
4. Use entry `clarification`. For `off`, do not ask or record; for `when-needed`, only material ambiguity; for `required`, use `ask_user`, wait and record before preparation; unavailable: show questions and stop. Confirm outcome, scope and acceptance. Record via `singularity-flow clarification record <phase> --response-file <file>`.
5. Run `singularity-flow prepare <phase>` unless prepared in step 3; use its returned path and `source.json`.
6. Inspect only grounding-selected files. Do not implement code.
7. Cover problem, outcome, scope, measurable acceptance criteria with stable qualified `[WORK-ID:AC-001]` anchors (using the actual work ID), dependencies, assumptions, risks, confirmed decisions, and deferred questions. Never use a bare `AC-001` as the authoritative clause ID.
8. Run `singularity-flow phase prepublish <phase> --for-agent --json` (includes draft-check). Unready: reuse findings/resolution; fresh diagnostics only when requested by its next action. Stay in this phase. Correct agent findings from governed evidence only when `correction.sameTurn`; else route to owner/regenerator. Never blindly delete markers, invent facts/padding, nest models or overwrite producers. Follow `repairLoop.protocol`; stop unchanged.
9. Use returned `commands.publish` when `ready`; absent: relay `commands.next`, stop. Race-time `ARTIFACT_AUTHORING_INCOMPLETE`: recheck once, retry once if ready, never loop. Never submit or approve.
10. Run `singularity-flow phase show <phase> --json`; retain `displayBinding`/`reviewBinding`. Reuse full bodies only after complete visible same-chat display with matching non-null `displayBinding`; else display every published text document in full, with ID/kind/path/bytes/generation/SHA-256 and `--- BEGIN <path> ---` / `--- END <path> ---`. Tool output/summaries are not review. Binary: metadata/open instruction. Show current `reviewBinding`; reuse never carries approval consent.
11. Report decisions, tokens, and commit. End with each returned `handoff`: `Next in Copilot: /sf-…` from its `copilotCommand`, then `Terminal equivalent: singularity-flow …` from its `command`; do not submit or approve.
