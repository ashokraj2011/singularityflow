---
name: sflow-code
description: Author a code-generation phase with executable tests and exactly-once publication.
disable-model-invocation: true
argument-hint: "[code-generation focus]"

---
# Governed code

<!-- sflow-copilot-pause -->
First run `singularity-flow phase enter --for-agent --json` once. It checks pause before Git or Story discovery. If `paused`, use native Copilot; explicit SFlow requests only offer `/sf-pause off`; never resume implicitly. Otherwise reuse this entry packet for binding, recovery, clarification and references; use `personalization.replyName` literally once per reply/suggestion group, never in artifacts or approval identity.

<!-- sflow-output-contract: clarification-and-artifact -->
**Output contract:** Use governed inputs and pinned clarification; publish/show configured artifacts. For suggested actions, pair Shell with the returned Copilot command; honor `commandGuidance`. If absent, say "Copilot: no verified equivalent"; never invent a slash command.
<!-- sflow-execution-boundary -->
**Boundary:** reuse the entry packet: require `ready`/`workId` and valid `phaseAgent`; cwd=`repositoryPath`. Use returned `workItemRoot`/artifact paths within this Story; never `$HOME`.
Blocked: relay `resolution.issues[].choices` too. Eligible risk needs reason/expiry and authorized human confirmation. Never auto-accept risk.

1. Require entry `phase`, `phaseAgent.valid: true`, `generatesCode: true`, `authoring.policyVerified`. Relay other routes; never draft sign-off. No duplicate pause/session/status.
2. Inspect `recovery.blockers`/`actions`, `intent` and `recovery.testExecution`. Dirty alone is no stop. Review listed paths and all diffs/untracked bytes including `workflow.json`. Repair returned owned, in-scope actions in an open intent; runner repair requires `CODE_DELIVERY_TEST_COMMAND_REQUIRED`. Untracked `.sflow/results/**` need no cleaning; preserve bytes; review tracked/staged reports. Stop on protected/unrelated/unowned edits or lifecycle/authority blockers. Consumed-changed intent needs reviewed `/sf-recover` rollover, never waiver; unchanged publication: relay `next`, stop.
3. Run `singularity-flow phase enter <phase> --work-id <WORK-ID> --compose --for-agent --json` once. Use `context.text`; do not reread it. `contextComposition: not-admitted`: follow actions, stop. Never infer `--task`.
4. Use its `clarification`: For `off`, do not ask or record; continue. For `when-needed`, ask and record only for material ambiguity; otherwise continue. For `required`, `ask_user`, wait, record before code mutation; stop if unavailable. Stage only `{"responses":[...]}` at `git rev-parse --git-path singularity-flow/clarification-responses/<phase>.json`; never at `singularity/work-items/**/context/clarifications-*.json`. Delete on success; never pass Markdown.
5. Use verified `references.repositories[].localPath`; refuse invalid/dirty. `singularity-flow revision status --json` only when `generation > 0`; first-generation authoring creates that candidate. Require an open intent; absent: `singularity-flow phase begin <phase> --json`, honoring adoption/confirmation. Consumed intent requires `/sf-recover`.
6. Implement code/tests, not README. Doc-comment APIs; tags are not docs. Exclude fixtures/docs/deletions/symlinks. In the planned product-source path: `// @clause:ORDER:REQ-001 rationale` (`REQ|BEH|IFC|AC|CON`); executable tests: `// @ac:ORDER:AC-001` above its test. Honor pinned test-only planned-claims opt-outs.
7. Intake tests are advisory. Use `testExecution.commands`: inferred runners need no YAML proposal/approval/amendment. Match argv/cwd/adapter/report; prefer `.venv`. Missing/invalid/ambiguous/policy-blocked runners: `/sf-recover` reviewed adoption. Run resolved tests—no skip/list/dry-run/no-tests; submission runs fresh tests independently. Repair dependencies only when authorized. Failures need repair or eligible human risk review. Never edit protected config, disable hooks or fabricate results. Explicit pins survive refresh; no amendment approvals here.
8. Run `singularity-flow phase prepublish <phase> --for-agent --json` (includes draft-check). Obey `correction.class`/`sameTurn`, `traceabilityRepair.actions`: verify behavior/assertions/hashes; repair owned tags without per-tag confirmation. Implement missing behavior; clarify ambiguity. Rerun tests. Repair other agent findings. Never invent, pad, blindly delete markers, nest models or overwrite producers. `ready` is not test success. Follow returned `repairLoop.protocol` for persistent correction/resume; stop unchanged.
9. Use returned `commands.publish` once when `ready`; absent: relay `commands.next`, stop. On refusal report `requiredTestExecution`: command ID (not shell command), argv/cwd, exit, bounded stderr and guidance. Nonzero exit fails despite passing JUnit. Follow `/sf-recover`; proven runtime repair permits retry without source changes. Source mutation requires review/rollover when consumed. `ARTIFACT_AUTHORING_INCOMPLETE`: recheck once, retry once. Never submit/approve.
10. `singularity-flow phase show <phase> --json` is artifact review, not readiness or task policy. Show bounded preview, hash-bound references and handoff.

TRP: `singularity-flow explain test-recovery`.
