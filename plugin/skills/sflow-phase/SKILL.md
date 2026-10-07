---
name: sflow-phase
description: Generate and publish configured artifacts for the active Singularity Flow phase.
disable-model-invocation: true
argument-hint: "[generation focus]"

---
# Generate the active phase

<!-- sflow-copilot-pause -->
First run `singularity-flow phase enter --for-agent --json` once. It checks pause before Git or Story discovery. If `paused`, use native Copilot; explicit SFlow requests only offer `/sf-pause off`; never resume implicitly. Otherwise reuse this entry packet for binding, recovery, clarification and references; use `personalization.replyName` literally once per reply/suggestion group, never in artifacts or approval identity.

<!-- sflow-output-contract: clarification-and-artifact -->
**Output contract:** Use governed inputs and pinned clarification; publish/show configured artifacts. For suggested actions, pair Shell with the returned Copilot command; honor `commandGuidance`. If absent, say "Copilot: no verified equivalent"; never invent a slash command.
<!-- sflow-execution-boundary -->
**Boundary:** reuse the entry packet: require `ready`/`workId` and valid `phaseAgent`; cwd=`repositoryPath`. Use returned `workItemRoot`/artifact paths within this Story; never `$HOME`.
Blocked: relay `resolution.issues[].choices` too. Eligible risk needs reason/expiry and authorized human confirmation. Never auto-accept risk.

1. Use entry `authoring`; false `policyVerified`: show `policyReason`, stop. If `effectiveAuthoringSkill` is not `/sf-phase`, relay it as `Next in Copilot:` and `Terminal equivalent: singularity-flow prepare <phase>`; null drafts nothing; stop. Retained generation: relay `next`, stop; never compose a new unpublished successor implicitly.
2. Inspect entry `recovery` actions. Review listed diffs; stop for human confirmation/protected or unowned edits. Do not repeat pause/session/status/recovery.
3. Run `singularity-flow phase enter <phase> --work-id <WORK-ID> --compose --for-agent --json` once. Use `context.text` without rereading the prompt; `contextComposition: not-admitted`: follow returned actions, stop. Never infer `--task`; missing intelligence adds zero bytes.
4. Use its `clarification`: For `off`, do not ask or record; continue. For `when-needed`, ask and record only for material ambiguity; otherwise continue. For `required`, use `ask_user`, wait and record before preparation; if unavailable, display the questions and stop. Stage only `{"responses":[...]}` at `git rev-parse --git-path singularity-flow/clarification-responses/<phase>.json`, never in Story context. Delete on success; never pass Markdown.
5. Read verified `references.repositories[].localPath`. Run exact `singularity-flow prepare <phase>` action. Stop on placeholders, templates, padding.
6. Preserve qualified REQ/AC identities through conformance. `/sf-code`: `@clause:WORK-ID:REQ-001` in product source, `@ac:WORK-ID:AC-001` in executable tests.
7. Preserve validated preparation context. Prepublish rechecks recovery; follow its current findings, not an earlier entry packet. Review diffs; stop for required human confirmation, protected config or another producer.
8. Run `singularity-flow phase prepublish <phase> --for-agent --json` (includes draft-check). Correct every agent finding now from approved evidence. Obey `correction.class`/`sameTurn`; route non-agent work to its owner and code repair to `/sf-code`. Never invent, pad, delete markers blindly, nest models or overwrite producers. Follow returned `repairLoop.protocol` for persistent correction/resume; stop unchanged.
9. Use returned `commands.publish` when `ready`; absent: relay `commands.next`, stop. `ARTIFACT_AUTHORING_INCOMPLETE`: recheck once; retry once if ready. Preserve sanitized `telemetry/<phase>-gen<N>.json`. Never submit/approve.
10. Run `singularity-flow phase show <phase> --json`; report evidence, commit/push, model/cost and hash-bound document references. Show a bounded preview once; relay each `handoff`'s `copilotCommand`/`command` as Copilot/Shell. Publication is not submission/review readiness. Never submit/approve.

TRP: `singularity-flow explain test-recovery`; returned legal actions only.
