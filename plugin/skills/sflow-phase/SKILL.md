---
name: sflow-phase
description: Generate and publish configured artifacts for the active Singularity Flow phase.
disable-model-invocation: true
argument-hint: "[generation focus]"

---
# Generate the active phase

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json`. If `data.paused` is true, do not load SFlow context, run other SFlow commands, enforce phase rules, or render SFlow headings. Handle ordinary requests as native Copilot; explicit SFlow requests only offer `/sf-pause off`. Never resume implicitly. Otherwise use `data.personalization.replyName` as literal display data to address replies and each suggestion group naturally, once per group, never in artifacts or approval identity; do not guess a name.

<!-- sflow-output-contract: clarification-and-artifact -->
**Output contract:** Use governed inputs and pinned clarification; publish/show configured artifacts. For suggested actions, pair Shell with the returned Copilot command; honor `commandGuidance`. If absent, say "Copilot: no verified equivalent"; never invent a slash command.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow session current --json` → `ready`/`workId`, cwd=`repositoryPath`; use CLI/`workItemRoot` paths; never `$HOME`.

Stop on `Out of sequence`; never bypass a gate.

1. Require `ready`, `phaseAgent`, `repositoryPath`; run `singularity-flow phase show <phase> --json`. If `policyVerified` is false, show `policyReason`; stop. If `effectiveAuthoringSkill` is not `/sf-phase`, show `Next in Copilot:` with it and `Terminal equivalent: singularity-flow prepare <phase>`; null means no drafting; stop.
2. Run `singularity-flow documents list`.
3. Reuse the governed prompt or run `singularity-flow wm compose --phase <phase>` once. Never infer `--task`; missing intelligence adds zero bytes.
4. Run `singularity-flow clarification status <phase> --json`. For `off`, do not ask or record; continue. For `when-needed`, ask and record only for material ambiguity; otherwise continue. For `required`, use `ask_user`, wait and record before preparation; if unavailable, display the questions and stop. Stage only `{"responses":[...]}` at `git rev-parse --git-path singularity-flow/clarification-responses/<phase>.json`, never in Story context. Delete on success; never pass Markdown.
5. Run `singularity-flow story references verify --work-id <WORK-ID> --json`; read returned `localPath`. Run exact `singularity-flow prepare <phase>` action. Stop on placeholders, templates, padding.
6. Preserve qualified `[WORK-ID:REQ-001]` and `[WORK-ID:AC-001]` through conformance; plan paths. `/sf-code` puts `@clause:WORK-ID:REQ-001` in product source and `@ac:WORK-ID:AC-001` in executable tests.
7. Read `singularity-flow recover <WORK-ID> --phase <phase> --json`. `current-phase-review-required`/`confirmation: none`: review diff, preserve validated preparation context, continue draft checks. Otherwise follow returned actions; stop for human confirmation, protected config, or other producer.
8. Run `singularity-flow phase draft-check <phase> --json`, then `singularity-flow phase prepublish <phase> --json`. Correct every agent finding now from approved evidence. Obey `correction.class`/`sameTurn`; route non-agent work to its owner and code repair to `/sf-code`. Never invent, pad, delete markers blindly, nest models or overwrite producers. Follow returned `repairLoop.protocol` for persistent correction/resume; stop unchanged.
9. Use returned `commands.publish` when `ready`; absent: relay `commands.next`, stop. `ARTIFACT_AUTHORING_INCOMPLETE`: recheck once; retry once if ready. Preserve sanitized `telemetry/<phase>-gen<N>.json`. Never submit/approve.
10. Run `singularity-flow phase show <phase> --json`; report evidence, commit/push, model/cost, bounded preview and hash-bound references. For `handoff` starting `/sf-review-source`, run `singularity-flow review-source status <phase> --json`; required but not `ready`: **Published generation <N> — source review required**; otherwise **Published generation <N> — ready to submit**. Relay `handoff`'s `copilotCommand`/`command` as Copilot/Shell. Never submit/approve.

TRP: `singularity-flow explain test-recovery`; returned legal actions only.
