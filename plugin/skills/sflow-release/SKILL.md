---
name: sflow-release
description: Prepare a release-readiness artifact with deployment, observability, rollback, communication and a final readiness decision, for the release step or any step that chose this skill.
disable-model-invocation: true
argument-hint: "[target environment or release window]"

---
# Release readiness

<!-- sflow-copilot-pause -->
First run `singularity-flow phase enter --for-agent --json` once. Lookup from current cwd (non-Git allowed). Never search `/Users`, `$HOME` or parents for a repo. Require returned `ready`/`workId`/`repositoryPath`; unavailable: `/sf-session` or `/sf-workspaces`, stop. It checks pause before Git. If `paused`, native Copilot; only offer `/sf-pause off`, never resume implicitly. Otherwise follow `agentGuide.readOrder` once, reuse binding/recovery/clarification/references and delivered inputs; no duplicate lookups. Use `personalization.replyName` literally in replies, never artifacts or approval identity.

<!-- sflow-output-contract: clarification-and-artifact -->
**Output contract:** Use governed inputs and pinned clarification; publish/show configured artifacts. Honor returned `commandGuidance`: show Shell, Copilot and available `modelFreeCommand` as "VS Code (model-free)". Missing Copilot: "Copilot: no verified equivalent". Never invent routes.
<!-- sflow-execution-boundary -->
**Boundary:** reuse entry `ready`/`workId`, valid `phaseAgent`; cwd=`repositoryPath`. Returned `workItemRoot`/artifact paths only; never `$HOME`.
Blocked: relay `resolution.issues[].choices` too. Eligible risk needs reason/expiry and authorized human confirmation. Never auto-accept risk.

1. Use entry `authoring`. If `policyVerified` is false, show `policyReason`; stop. Continue only if `effectiveAuthoringSkill` is `/sf-release`, or `/sf-phase` with `authoringSkill` null and `<phase>` = `release`; else relay its verified route; null drafts nothing. `retained-generation`: relay `next`, stop.
2. Review entry `recovery` and exact diffs; stop for protected/unowned edits or required human decisions. `successor-preparation-required`: run `successor.preparation.command`, preserve private drafts/publications and refresh entry once. Run `singularity-flow phase enter <phase> --work-id <WORK-ID> --compose --for-agent --json` once; use `context.text` and available release/operations/security grounding. Not admitted: relay blockers/next, stop. Missing WM means zero context, optional recovery. Never infer `--task`.
3. Reuse delivered inputs/reference paths; expand only needed missing/truncated material. Use entry `clarification`: off asks nothing, when-needed only material ambiguity, required asks/records before preparation; never bypass.
4. Run `singularity-flow prepare <phase>` unless prepared in step 2; complete the release report and every artifact-set member it returns. When the step declares a `verification/` member, bind the approved Verification generation, exact paths/hashes, observed results, and gaps in its `evidence-index.md`; otherwise list evidence gaps. Never invent evidence.
5. Cover deployment/preconditions, migrations/flags, validation/metrics/alerts, success, rollback, communication, ownership and escalation.
6. Run `singularity-flow phase prepublish <phase> --for-agent --json` (includes draft-check). Unready: reuse findings/resolution; fresh diagnostics only when requested by its next action. Stay in this phase. Correct agent findings from governed evidence only when `correction.sameTurn`; else route to owner/regenerator. Never blindly delete markers, invent facts/padding, nest models or overwrite producers. Follow `repairLoop.protocol`; stop unchanged.
7. Use returned `commands.publish` when `ready`; absent: relay `commands.next`, stop. Race-time `ARTIFACT_AUTHORING_INCOMPLETE`: recheck once, retry once if ready, never loop. Never submit or approve.
8. Run `singularity-flow phase show <phase> --json`; retain `displayBinding`/`reviewBinding`. Reuse full bodies only after complete visible same-chat display with matching non-null `displayBinding`; else display every published text document in full, with ID/kind/path/bytes/generation/SHA-256 and `--- BEGIN <path> ---` / `--- END <path> ---`. Tool output/summaries are not review. Binary: metadata/open instruction. Show current `reviewBinding`; reuse never carries approval consent.
9. Never submit/approve. Relay each `handoff`: `Next in Copilot: /sf-…` from `copilotCommand`, then `Terminal equivalent: singularity-flow …` from `command`.
