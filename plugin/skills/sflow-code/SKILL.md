---
name: sflow-code
description: Author a code-generation phase with executable tests and exactly-once publication.
disable-model-invocation: true
argument-hint: "[code-generation focus]"

---
# Governed code

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json`. If `data.paused` is true, do not load SFlow context, run other SFlow commands, enforce phase rules, or render SFlow headings. Handle ordinary requests as native Copilot; explicit SFlow requests only offer `/sf-pause off`. Never resume implicitly.

<!-- sflow-output-contract: clarification-and-artifact -->
**Output contract:** Use governed inputs and pinned clarification; publish/show configured artifacts. For suggested actions, pair Shell with the returned Copilot command; honor `commandGuidance`. If absent, say "Copilot: no verified equivalent"; never invent a slash command.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow session current --json` → `ready`/`workId`, cwd=`repositoryPath`; use CLI/`workItemRoot` paths; never `$HOME`.

1. From the Boundary require `phase`, `phaseAgent.valid: true`. `singularity-flow status --json`: match workId/currentPhase; require `phases[<phase>].generationPolicy.task: code` or legacy `implementation-summary` without task.
2. `singularity-flow recover <WORK-ID> --phase <phase> --json`: inspect blockers/actions, intent and `testExecution`. `phaseRepairRequired`/`working-tree` alone is no stop. Inspect `git status --porcelain=v1 --untracked-files=all`, diffs and untracked content including `workflow.json`. Repair returned owned, in-scope authoring actions within an open intent; `repair-repository-test-runner` requires `CODE_DELIVERY_TEST_COMMAND_REQUIRED` and source-scope repair. Untracked `.sflow/results/**` need no cleaning; preserve bytes. Tracked/staged reports still need review. Stop for protected/unrelated/unowned changes or lifecycle/authority blockers. `generation.intent.consumed-changed` requires `/sf-recover` reviewed rollover, never waiver.
3. Read Story context; `singularity-flow wm compose --phase <phase>`.
4. `singularity-flow clarification status <phase> --json`: For `off`, do not ask or record; continue. For `when-needed`, ask and record only for material ambiguity; otherwise continue. For `required`, `ask_user`, wait, record before mutation; stop if unavailable. Stage only `{"responses":[...]}` at `git rev-parse --git-path singularity-flow/clarification-responses/<phase>.json`; never at `singularity/work-items/**/context/clarifications-*.json`. Delete on success; never pass Markdown.
5. `singularity-flow story references verify --work-id <WORK-ID> --json`: use `localPath`; refuse invalid/dirty. Check `singularity-flow revision status --json`. Before authoring require an open intent; if absent run `singularity-flow phase begin <phase> --json`, honoring adoption/confirmation. Consumed intent requires `/sf-recover`.
6. Implement code/tests, not README. Doc-comment APIs; tags are not docs. Exclude fixtures/docs/deletions/symlinks. In the planned product-source path: `// @clause:ORDER:REQ-001 rationale` (`REQ|BEH|IFC|AC|CON`); executable tests: `// @ac:ORDER:AC-001` above its test. Honor pinned test-only planned-claims opt-outs.
7. Intake tests are advisory, not passing evidence. Use `testExecution.commands`; supported `argvSource: inferred` commands require no YAML proposal, approval or Story amendment. Match argv/cwd/adapter/report; prefer `.venv`. Only missing/invalid/ambiguous/policy-blocked runners need setup: resolve missing commands via `/sf-recover` reviewed adoption. Run the resolved tests—no skip/list/dry-run/no-tests; publish independently executes required tests. Repair dependencies only when authorized; failures need repair or eligible human risk review. Never edit protected configuration, disable hooks or fabricate results. Refresh retains explicit pins; no amendment approvals here.
8. Run `singularity-flow phase draft-check <phase> --json`, then `singularity-flow phase prepublish <phase> --json`. Obey `correction.class`/`sameTurn`, `traceabilityRepair.actions`: verify behavior/assertions/hashes; repair owned tags without per-tag confirmation. Implement missing behavior; clarify ambiguity. Rerun tests. Repair other agent findings. Never invent, pad, blindly delete markers, nest models or overwrite producers. `ready` is not test success. Follow returned `repairLoop.protocol` for persistent correction/resume; stop unchanged.
9. Publish once with configured producer/channel only when prepublish is `ready`. On refusal report `requiredTestExecution`: command ID (not shell command), argv/cwd, exit, bounded stderr and guidance. Nonzero exit fails despite passing JUnit. Follow `/sf-recover`; proven runtime repair permits retry without source changes. Source mutation requires review/rollover when consumed. `ARTIFACT_AUTHORING_INCOMPLETE`: recheck once, retry once. Never submit/approve.
10. `singularity-flow phase show <phase> --json` is artifact review, not readiness or task policy. Show bounded preview, hash-bound references and handoff.

TRP: `singularity-flow explain test-recovery`.
