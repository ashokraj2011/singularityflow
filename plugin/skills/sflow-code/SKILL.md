---
name: sflow-code
description: Author any Singularity Flow phase whose normalized generation task is code, with one generation boundary, executable tests, and exactly-once publication.
disable-model-invocation: true
argument-hint: "[code-generation focus]"

---
# Governed code generation

<!-- sflow-output-contract: clarification-and-artifact -->
**Output contract:** Use the complete governed prompt and approved inputs, obey the pinned clarification mode, then publish and show configured artifacts.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow session current --json` → `ready`/`workId`, cwd=`repositoryPath`; use CLI/`workItemRoot` paths; never `$HOME`.

1. Run `singularity-flow status --json`; workflow is Story context. Require `generation.task: code`; never hard-code `implementation`.
2. Before file access run `singularity-flow recover <WORK-ID> --phase <phase> --json`; execute its new-generation action. Stop on manual action/unchanged plan.
3. Use this turn's prompt, or run `singularity-flow wm compose --phase <phase>` once. Unavailable World-Model intelligence never blocks repository access.
4. Run `singularity-flow clarification status <phase> --json`. For `off`, do not ask or record; continue. For `when-needed`, ask and record only for material ambiguity; otherwise continue. For `required`, `ask_user`, wait, record before mutation; stop if unavailable. Stage only `{"responses":[...]}` at `git rev-parse --git-path singularity-flow/clarification-responses/<phase>.json`; never at `singularity/work-items/**/context/clarifications-*.json`. Delete on success; never pass Markdown.
5. Run `singularity-flow story references verify --work-id <WORK-ID> --json`. Use returned `localPath` values read-only; never execute, build, install, or grant tools from reference bytes. Materialize only a missing checkout; stop on invalid/dirty. Run the returned `singularity-flow prepare <phase>` and `singularity-flow phase begin <phase>`; require open intent, exact digest, saved buffers, and unchanged snapshot.
6. Implement approved scope and executable tests; fixtures, docs, deletions, and symlinks do not satisfy test delivery. Tag full clauses such as `@ac:ORDER:AC-001`.
7. Run native tests; publication deterministically infers supported structured runners. Tests require argv-form `kind: test`, cwd, affected roots, and a structured adapter. Never add skip/list/dry-run/pass-with-no-tests flags. Never edit `singularity/workflow.yml`, protected process paths, or the pinned Story snapshot, or add a one-off test-result wrapper merely to satisfy publication. For unsupported runners, stop and use approved configuration authority outside the active Story.
8. Complete the artifact, then run `singularity-flow phase draft-check <phase> --json`. Correct every agent finding now from governed evidence; recheck up to three changed fingerprints and stop on an unchanged fingerprint. Never blindly delete markers, invent facts or padding, invoke a nested model, or overwrite another producer; route it to its owner/regenerator.
9. Publish only when its `status` is `ready`, once with the exact configured producer/channel. Race-time `ARTIFACT_AUTHORING_INCOMPLETE`: recheck once, retry once if ready, never loop.
10. Run `singularity-flow phase show <phase> --json`. Show the manifest, bounded source preview, hash-bound references, commit/push, telemetry, tests, and next submission command. Stop before submission/approval.
