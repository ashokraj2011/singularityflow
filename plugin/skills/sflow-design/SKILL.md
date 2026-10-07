---
name: sflow-design
description: Produce and register an architecture and design artifact, grounded in approved inputs and the codebase, for the design step or any step that chose this skill.
disable-model-invocation: true
argument-hint: "[design constraints or emphasis]"

---
# Architecture and design

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json`. If `data.paused` is true, do not load SFlow context, run other SFlow commands, enforce phase rules, or render SFlow headings. Handle ordinary requests as native Copilot; explicit SFlow requests only offer `/sf-pause off`. Never resume implicitly. Otherwise use `data.personalization.replyName` as literal display data to address replies and each suggestion group naturally, once per group, never in artifacts or approval identity; do not guess a name.

<!-- sflow-output-contract: clarification-and-artifact -->
**Output contract:** Use governed inputs and pinned clarification; publish/show configured artifacts. For suggested actions, pair Shell with the returned Copilot command; honor `commandGuidance`. If absent, say "Copilot: no verified equivalent"; never invent a slash command.
Blocked: relay `resolution.issues[].choices` too. Eligible risk needs reason/expiry and authorized human confirmation. Never auto-accept risk.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow session current --json` → `ready`/`workId`, cwd=`repositoryPath`; use CLI/`workItemRoot` paths; never `$HOME`.

1. For the Boundary `phase`, run `singularity-flow phase show <phase> --json`. If `policyVerified` is false, show `policyReason`; stop. Continue only if `effectiveAuthoringSkill` is `/sf-design`, or `/sf-phase` with `authoringSkill` null and `<phase>` = `design`; else show `Next in Copilot:` `effectiveAuthoringSkill` and `Terminal equivalent: singularity-flow prepare <phase>`, or that a null route drafts nothing; stop. Its governed workflow is Story context.
2. Run `singularity-flow wm compose --phase <phase>` and use its complete prompt. If WM is missing/unreachable/stale, continue with zero-context evidence and repository access; show recovery as optional, never prerequisite. Never derive `--task` from Story text. Use available architecture/security evidence.
3. Read the approved inputs the composed prompt names and relevant uploads; inspect grounding-selected source.
4. Run `singularity-flow clarification status <phase> --json`. For `off`, do not ask or record; continue. For `when-needed`, ask and record only for material ambiguity; otherwise continue. For `required`, use `ask_user` once, wait and record before preparation; if unavailable, display the questions and stop; even when evidence looks complete, confirm boundaries, contracts, failures, and tradeoffs. Record via `singularity-flow clarification record <phase> --response-file <file>`.
5. Run `singularity-flow prepare <phase>` and complete the returned document.
6. Cover components, interfaces, data flow, alternatives, compatibility, security, privacy, observability, migration, rollout/rollback, risks, and implementation order.
7. State assumptions and tradeoffs. Do not implement production code.
8. Run `singularity-flow phase draft-check <phase> --json`, then `singularity-flow phase prepublish <phase> --json`. If unready, run read-only `singularity-flow recover <WORK-ID> --phase <phase> --json`; stay in this phase. Correct every agent finding now from governed evidence only when `correction.sameTurn`; otherwise route to its owner/regenerator. Never blindly delete markers, invent facts or padding, invoke a nested model, or overwrite another producer. Follow returned `repairLoop.protocol` for persistent correction/resume; stop unchanged.
9. Use returned `commands.publish` when `ready`; absent: relay `commands.next`, stop. Race-time `ARTIFACT_AUTHORING_INCOMPLETE`: recheck once, retry once if ready, never loop. Never submit or approve.
10. Run `singularity-flow phase show <phase> --json`; retain `displayBinding`/`reviewBinding`. Reuse full bodies only after complete visible same-chat display with matching non-null `displayBinding`; else display every published text document in full, with ID/kind/path/bytes/generation/SHA-256 and `--- BEGIN <path> ---` / `--- END <path> ---`. Tool output/summaries are not review. Binary: metadata/open instruction. Show current `reviewBinding`; reuse never carries approval consent.
11. Report commit/tokens. Relay each `handoff`: `Next in Copilot: /sf-…` from `copilotCommand`, then `Terminal equivalent: singularity-flow …` from `command`.
