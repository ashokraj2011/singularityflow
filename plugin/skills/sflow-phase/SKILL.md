---
name: sflow-phase
description: Generate and publish configured artifacts for the active Singularity Flow phase.
disable-model-invocation: true
argument-hint: "[generation focus]"

---
# Generate the active phase

<!-- sflow-copilot-pause -->
First run `singularity-flow phase enter --for-agent --json` once. Lookup from current cwd (non-Git allowed). Never search `/Users`, `$HOME` or parents for a repo. Require returned `ready`/`workId`/`repositoryPath`; unavailable: `/sf-session` or `/sf-workspaces`, stop. It checks pause before Git. If `paused`, native Copilot; only offer `/sf-pause off`, never resume implicitly. Otherwise follow `agentGuide.readOrder` once, reuse binding/recovery/clarification/references and delivered inputs; no duplicate lookups. Read `clarification.checkpoint`: missing answers permit questions, not drafting. Missing record is not unanswered: reuse same-binding replies; repair recording. Never ask users to supply questions or slice control instructions. Use `personalization.replyName` literally in replies, never artifacts or approval identity.

<!-- sflow-output-contract: clarification-and-artifact -->
**Output contract:** Use governed inputs and pinned clarification; publish/show configured artifacts. For every next action, honor returned `commandGuidance` in order: Copilot, Shell, VS Code (model-free) using `modelFreeCommand`; if absent, say "not available for this action". Missing Copilot: "no verified equivalent". Never invent routes.
<!-- sflow-execution-boundary -->
**Boundary:** reuse entry `ready`/`workId`, valid `phaseAgent`; cwd=`repositoryPath`. Honor `mutationContract`. Returned `workItemRoot`/artifact paths only; never `$HOME`.
Blocked: relay `resolution.issues[].choices` too. Eligible risk needs reason/expiry and authorized human confirmation. Never auto-accept risk.

1. Use entry `authoring`; false `policyVerified`: show `policyReason`, stop. If `effectiveAuthoringSkill` is not `/sf-phase`, relay it as `Next in Copilot:` and `Terminal equivalent: singularity-flow prepare <phase>`; null drafts nothing; stop. `retained-generation`: relay `next`, stop.
2. Review diffs. `contextAdmission.pendingEvidence`: preserve held files/index; repair verified drafts; review contracts before publication. Otherwise stop for human/protected/unowned edits. `successor-preparation-required`: run `successor.preparation.command`; preserve private drafts/publications, refresh entry once. Blocked: relay diagnostics; no loops/implicit successors/duplicate lookups.
3. Run `singularity-flow phase enter <phase> --work-id <WORK-ID> --compose --for-agent --json` once. Use `context.text`. `contextComposition: not-admitted`: relay `contextAdmission.blockers`/`next`, stop; no retries. Never infer `--task`; no intelligence: zero bytes.
4. Follow `clarification.checkpoint`; off skips. Reuse same-binding human replies; ask only unanswered/changed questions with `ask_user` (unavailable: show them and stop). File-edit `{"responses":[...]}` at `clarification.responseStagingPath`, run `checkpoint.recordAction` alone. On refusal preserve replies/staging; repair recording, not questions. Remove staging only on success; record before preparation. No Story-context writes or Markdown.
5. Read `references.repositories[].localPath`. Run `singularity-flow prepare <phase>` unless prepared in step 2. Stop on placeholders/templates/padding.
6. Preserve REQ/AC IDs; `/sf-code` owns tags. Retained files: `evidence` fulfillment, primary visual/inspection contracts. Review `planningEvidenceRepair` when `sameTurn`; recheck.
7. Preserve preparation context. Prepublish rechecks recovery; honor verified draft holds, never accept them. Stop for other human/protected/unowned changes.
8. Run `singularity-flow phase prepublish <phase> --for-agent --json` (includes draft-check). Correct every agent finding now from approved evidence. Obey `correction.class`/`sameTurn`; route non-agent work to its owner and code repair to `/sf-code`. Never invent, pad, delete markers blindly, nest models or overwrite producers. Follow returned `repairLoop.protocol` for persistent correction/resume; stop unchanged.
9. Use returned `commands.publish` when `ready`; absent: relay `commands.next`, stop. `ARTIFACT_AUTHORING_INCOMPLETE`: recheck once; retry once if ready. Preserve sanitized `telemetry/<phase>-gen<N>.json`. Never submit/approve.
10. Run `singularity-flow phase show <phase> --for-agent --json`; report evidence, commit/push, model/cost, hash-bound documents and one bounded preview. Relay each `handoff`'s `copilotCommand`/`command` pair. Publication is not submission/review readiness.
