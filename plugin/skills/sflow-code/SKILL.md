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

1. Run `singularity-flow phase show <phase> --json`; require `ready`, `phaseAgent`, and `generation.task: code`. Keep Story context governed; never assume `implementation`.
2. Run read-only `singularity-flow recover <WORK-ID> --phase <phase> --json`; act only in this phase; stop for manual/unchanged recovery or another producer.
3. Use prompt or run `singularity-flow wm compose --phase <phase>` once; absent WM is non-blocking.
4. Run `singularity-flow clarification status <phase> --json`. For `off`, do not ask or record; continue. For `when-needed`, ask and record only for material ambiguity; otherwise continue. For `required`, `ask_user`, wait, record before mutation; stop if unavailable. Stage only `{"responses":[...]}` at `git rev-parse --git-path singularity-flow/clarification-responses/<phase>.json`; never at `singularity/work-items/**/context/clarifications-*.json`. Delete on success; never pass Markdown.
5. Run `singularity-flow story references verify --work-id <WORK-ID> --json`; use `localPath` read-only, materialize only missing, refuse invalid/dirty. Run returned prepare/begin; require intent/digest/snapshot. Check `singularity-flow revision status --json`; publication consumes its eligible head.
6. Implement product code and executable tests; fixtures/docs/deletions/symlinks do not count. Bind each approved source-bound clause in its planned product-source path with an adjacent qualified comment like `// @clause:ORDER:REQ-001` (`REQ|BEH|IFC|AC|CON`). In test files tag ACs `// @ac:ORDER:AC-001`. Tags are witnesses, not proof. Honor reviewed test-only/non-code/planned-claims opt-outs; never add unrelated tags.
7. Run tests; publication deterministically infers supported structured runners. Require argv-form `kind: test`, cwd, affected roots, and adapter. No skip/list/dry-run/pass-with-no-tests. Never edit `singularity/workflow.yml`, protected paths, the pinned Story snapshot, or add a one-off test-result wrapper merely to satisfy publication. Unsupported runners require approved configuration authority outside the active Story.
8. Run `singularity-flow phase draft-check <phase> --json`, then `singularity-flow phase prepublish <phase> --json`. Correct every agent finding now from evidence; recheck at most three changed fingerprints; stop on an unchanged fingerprint. Obey `correction.class`/`sameTurn`; never delete markers blindly, invent facts, use padding, invoke nested models, or overwrite another producer.
9. Only when prepublish `status` is `ready`, publish once with its configured producer/channel. On `ARTIFACT_AUTHORING_INCOMPLETE`, recheck once, retry once if ready; never loop. Never submit or approve.
10. Run `singularity-flow phase show <phase> --json`; show bounded source preview, hash-bound references, commit/push, telemetry, tests, and submit routes; stop.
