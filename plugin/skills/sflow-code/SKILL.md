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
2. `singularity-flow recover <WORK-ID> --phase <phase> --json`: inspect `requiresRecovery`, `blockers[]`, action IDs/modes. `phaseRepairRequired`/`working-tree` alone is no stop. For `current-phase-review-required` or dirty code, inspect `git status --porcelain=v1 --untracked-files=all`, staged/unstaged diffs and untracked content incl. `workflow.json`. Verify code phase/pinned scope; intent must be open/current if present, else step 5 begins it. Allow owned in-phase `prepare-artifact`, `complete-artifact`, `repair-agent-brief-source`, `complete-code-delivery`; route others. Stop for protected/unrelated/unowned changes, other manual/producer actions or `requiresRecovery: true`. `generation.intent.consumed-changed`: Shell + `/sf-recover`, never `/sf-code` or waiver.
3. Optional: `singularity-flow wm compose --phase <phase>`.
4. `singularity-flow clarification status <phase> --json`: For `off`, do not ask or record; continue. For `when-needed`, ask and record only for material ambiguity; otherwise continue. For `required`, `ask_user`, wait, record before mutation; stop if unavailable. Stage only `{"responses":[...]}` at `git rev-parse --git-path singularity-flow/clarification-responses/<phase>.json`; never at `singularity/work-items/**/context/clarifications-*.json`. Delete on success; never pass Markdown.
5. `singularity-flow story references verify --work-id <WORK-ID> --json`: use `localPath`; materialize missing only; refuse invalid/dirty. `singularity-flow revision status --json`.
6. Implement code/tests; README may accompany, not replace code/tests. Never count fixtures/docs/deletions/symlinks as source/test; planned product-source paths: `// @clause:ORDER:REQ-001` (`REQ|BEH|IFC|AC|CON`); executable tests: `// @ac:ORDER:AC-001`. Honor test-only/non-code/planned-claims opt-outs.
7. Run tests; publication deterministically infers supported structured runners: argv `kind: test`, cwd, roots, adapter; no skip/list/dry-run/no-tests. Compare its argv/report with manual tests. Never edit `singularity/workflow.yml`, protected/pinned paths, disable Git hooks, or add a one-off test-result wrapper merely to satisfy publication. Unsupported runners need approved configuration authority outside the active Story.
8. `singularity-flow phase draft-check <phase> --json`; `singularity-flow phase prepublish <phase> --json`. Correct every agent finding now; at most three changed fingerprints. Initial template is baseline; stop on an unchanged fingerprint only after correction. `correction.class`/`sameTurn`; never delete markers blindly, invent facts/padding, nest models or overwrite another producer. `prepublish: ready` does not mean tests passed.
9. Publish once only if prepublish `status` is `ready`, with configured producer/channel. On test refusal, `.-maven-tests` is an ID, not a shell command: report argv/cwd/exit/report from `--json`; recover and stop. Pre-mutation failure keeps the open intent; retry after repair. `ARTIFACT_AUTHORING_INCOMPLETE`: recheck once, retry once; never loop/submit/approve.
10. `singularity-flow phase show <phase> --json` is artifact review, not readiness or task policy; bounded preview, hash-bound references; stop.
