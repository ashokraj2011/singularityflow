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
2. `singularity-flow recover <WORK-ID> --phase <phase> --json`: inspect `requiresRecovery`, `blockers[]`, action IDs/modes. `phaseRepairRequired`/`working-tree` alone is no stop. For `current-phase-review-required` or dirty code, run `git status --porcelain=v1 --untracked-files=all`; inspect staged/unstaged diffs and untracked content including `workflow.json`. In-scope application and test edits are not a reason to clean or reset the worktree. Verify code phase/pinned scope; intent must be open/current if present, else step 5 begins it. Allow owned in-phase `prepare-artifact`, `complete-artifact`, `repair-agent-brief-source`, `complete-code-delivery`; route others. Stop for protected/unrelated/unowned changes, other manual/producer actions or `requiresRecovery: true`. `generation.intent.consumed-changed` goes to `/sf-recover`, never `/sf-code` or waiver. Follow `resolve-code-delivery-test-policy` once; config refresh does not change this Story's pin.
3. `singularity-flow wm compose --phase <phase>` if needed.
4. `singularity-flow clarification status <phase> --json`: For `off`, do not ask or record; continue. For `when-needed`, ask and record only for material ambiguity; otherwise continue. For `required`, `ask_user`, wait, record before mutation; stop if unavailable. Stage only `{"responses":[...]}` at `git rev-parse --git-path singularity-flow/clarification-responses/<phase>.json`; never at `singularity/work-items/**/context/clarifications-*.json`. Delete on success; never pass Markdown.
5. `singularity-flow story references verify --work-id <WORK-ID> --json`: use `localPath`; materialize missing; refuse invalid/dirty. `singularity-flow revision status --json`.
6. Implement code/tests; README cannot replace them. Doc-comment public APIs; tags are not docs. Exclude fixtures/docs/deletions/symlinks. In the planned product-source path put `// @clause:ORDER:REQ-001` (`REQ|BEH|IFC|AC|CON`); in executable tests put `// @ac:ORDER:AC-001`. Honor pinned test-only planned-claims opt-outs.
7. Run tests; publication deterministically infers supported structured runners: argv `kind: test`, cwd, roots, adapter; no skip/list/dry-run/no-tests. Compare its argv/report with manual tests. Never edit `singularity/workflow.yml`, protected/pinned paths, disable Git hooks, or add a one-off test-result wrapper merely to satisfy publication. Updated runtime may support this phase; approved configuration changes affect future Stories only. No current-Story route: report blocker; stop.
8. Run `singularity-flow phase draft-check <phase> --json` and `singularity-flow phase prepublish <phase> --json`. Correct every structured agent authoring finding in this Copilot turn; at most three changed fingerprints. Initial template is baseline; stop on an unchanged fingerprint only after correction. If blocking finding code and source code remain unchanged, stop this attempt despite other draft changes. Honor `correction.class`/`sameTurn`; never blindly delete markers, invent facts, use padding, invoke a nested model, or overwrite another producer. `prepublish: ready` does not mean tests passed.
9. Publish once only if prepublish `status` is `ready`, with configured producer/channel. On test refusal, `.-maven-tests` is an ID, not a shell command: report argv/cwd/exit/report from `--json`; recover/stop. Pre-mutation failure keeps the open intent; retry after repair only when blocker changed. `ARTIFACT_AUTHORING_INCOMPLETE`: recheck once, retry once; never create a publication retry loop/submit/approve.
10. `singularity-flow phase show <phase> --json` is artifact review, not readiness or task policy; bounded preview, hash-bound references; stop.
