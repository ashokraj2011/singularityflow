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

1. `singularity-flow session current --json`: require `ready: true`, `workId`, `repositoryPath`, `phase`, and required `phaseAgent.valid: true`. `singularity-flow status --json` must match workId/currentPhase and show `phases[<phase>].generationPolicy.task: code` or legacy `implementation-summary` without task. Stop on mismatch. `singularity-flow phase show <phase> --json` is artifact review, not readiness or task policy. Keep Story context governed.
2. Run `singularity-flow recover <WORK-ID> --phase <phase> --json`; stop for manual/unchanged/other-producer recovery.
3. Use prompt or run `singularity-flow wm compose --phase <phase>`; WM optional.
4. Run `singularity-flow clarification status <phase> --json`. For `off`, do not ask or record; continue. For `when-needed`, ask and record only for material ambiguity; otherwise continue. For `required`, `ask_user`, wait, record before mutation; stop if unavailable. Stage only `{"responses":[...]}` at `git rev-parse --git-path singularity-flow/clarification-responses/<phase>.json`; never at `singularity/work-items/**/context/clarifications-*.json`. Delete on success; never pass Markdown.
5. `singularity-flow story references verify --work-id <WORK-ID> --json`: read `localPath`, materialize missing only, refuse invalid/dirty. Run returned prepare/begin; require intent/digest/snapshot. Check `singularity-flow revision status --json`; publish eligible head.
6. Implement code/tests; fixtures/docs/deletions/symlinks do not count. Bind approved clauses in planned product-source paths with adjacent `// @clause:ORDER:REQ-001` (`REQ|BEH|IFC|AC|CON`). Tag test ACs `// @ac:ORDER:AC-001`. Honor reviewed test-only/non-code/planned-claims opt-outs; no unrelated tags.
7. Run tests; publication deterministically infers supported structured runners. Require argv-form `kind: test`, cwd, roots, adapter; no skip/list/dry-run/no-tests. Never edit `singularity/workflow.yml`, protected paths, pinned Story snapshot, or add a one-off test-result wrapper merely to satisfy publication. Unsupported runners need approved configuration authority outside the active Story.
8. Run `singularity-flow phase draft-check <phase> --json`, then `singularity-flow phase prepublish <phase> --json`. Correct every agent finding now; at most three changed fingerprints; stop on an unchanged fingerprint. Obey `correction.class`/`sameTurn`; never delete markers blindly, invent facts, use padding, invoke nested models, or overwrite another producer.
9. Only when prepublish `status` is `ready`, publish once with configured producer/channel. On `ARTIFACT_AUTHORING_INCOMPLETE`, recheck once, retry once if ready; never loop. Do not submit/approve.
10. Run `singularity-flow phase show <phase> --json`; show bounded source preview, hash-bound references, commit/push, tests, submit routes; stop.
