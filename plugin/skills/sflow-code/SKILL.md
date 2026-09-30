---
name: sflow-code
description: Author a code-generation phase with executable tests and exactly-once publication.
disable-model-invocation: true
argument-hint: "[code-generation focus]"

---
# Governed code generation

<!-- sflow-output-contract: clarification-and-artifact -->
**Output contract:** Use governed inputs and clarification mode, then publish configured artifacts.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow session current --json` → `ready`/`workId`, cwd=`repositoryPath`; use CLI/`workItemRoot` paths; never `$HOME`.

1. `singularity-flow session current --json`: require `ready: true`, `workId`, `repositoryPath`, `phase`, `phaseAgent.valid: true`. `singularity-flow status --json`: match workId/currentPhase; require `phases[<phase>].generationPolicy.task: code` or legacy `implementation-summary` without task. Keep Story context governed.
2. `singularity-flow recover <WORK-ID> --phase <phase> --json`: inspect recovery flags and actions. For dirty code, inspect Git status/diffs and untracked content, including `workflow.json`; preserve in-scope application/test edits. Continue only with an open/current intent and owned in-phase repair actions; route other actions. Stop for protected/unowned changes or `requiresRecovery: true`. Consumed-changed intent goes to `/sf-recover`, never a waiver. Follow `resolve-code-delivery-test-policy` once, then stop; config refresh cannot change this Story's pin.
3. Optional: `singularity-flow wm compose --phase <phase>`.
4. `singularity-flow clarification status <phase> --json`: For `off`, do not ask or record; continue. For `when-needed`, ask and record only for material ambiguity; otherwise continue. For `required`, `ask_user`, wait, record before mutation; stop if unavailable. Stage only `{"responses":[...]}` at `git rev-parse --git-path singularity-flow/clarification-responses/<phase>.json`; never at `singularity/work-items/**/context/clarifications-*.json`. Delete on success; never pass Markdown.
5. `singularity-flow story references verify --work-id <WORK-ID> --json`: use `localPath`; materialize missing only; refuse invalid/dirty. `singularity-flow revision status --json`.
6. Implement code/tests; README cannot replace them. Doc-comment changed public APIs; `@clause`/`@ac` tags are not docs. Do not count fixtures/docs/deletions/symlinks as source/test. Product source: `// @clause:ORDER:REQ-001` (`REQ|BEH|IFC|AC|CON`); tests: `// @ac:ORDER:AC-001`. Honor pinned opt-outs.
7. Run tests; publication deterministically infers supported structured runners: argv `kind: test`, cwd, roots, adapter; no skip/list/dry-run/no-tests. Compare its argv/report with manual tests. Never edit `singularity/workflow.yml`, protected/pinned paths, disable Git hooks, or add a one-off test-result wrapper merely to satisfy publication. An updated Singularity Flow runtime may support the runner for this same open phase; approved configuration changes affect future Stories only. If no current-Story route exists, report the blocker and stop without repeated publication.
8. Run `singularity-flow phase draft-check <phase> --json` and `singularity-flow phase prepublish <phase> --json`. Correct agent findings, at most three changed fingerprints; advisories do not block. Stop after a repair if the finding and relevant source remain unchanged, even if unrelated draft bytes change. Honor `correction.class`/`sameTurn`; never pad, blindly delete markers, nest models, or overwrite another producer. `prepublish: ready` is not a test pass.
9. Publish once only if prepublish `status` is `ready`, with configured producer/channel. On test refusal, `.-maven-tests` is an ID, not a shell command: report argv/cwd/exit/report from `--json`; recover and stop. Pre-mutation failure keeps the open intent; retry after repair only when the blocking condition changed. `ARTIFACT_AUTHORING_INCOMPLETE`: recheck once, retry once; never loop/submit/approve.
10. `singularity-flow phase show <phase> --json` is artifact review, not readiness or task policy; bounded preview, hash-bound references; stop.
