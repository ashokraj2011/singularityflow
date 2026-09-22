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

1. Run `singularity-flow phase show <phase> --json`; require `ready`, `phaseAgent`, and `generation.task: code`. Never hard-code `implementation`; otherwise show routes and stop. Story context stays governed.
2. Run `singularity-flow recover <WORK-ID> --phase <phase> --json`; execute its generation action, or stop on manual/unchanged recovery.
3. Use the prompt or run `singularity-flow wm compose --phase <phase>` once. Unavailable intelligence is non-blocking.
4. Run `singularity-flow clarification status <phase> --json`. For `off`, do not ask or record; continue. For `when-needed`, ask and record only for material ambiguity; otherwise continue. For `required`, `ask_user`, wait, record before mutation; stop if unavailable. Stage only `{"responses":[...]}` at `git rev-parse --git-path singularity-flow/clarification-responses/<phase>.json`; never at `singularity/work-items/**/context/clarifications-*.json`. Delete on success; never pass Markdown.
5. Run `singularity-flow story references verify --work-id <WORK-ID> --json`; keep `localPath` read-only, materialize only missing, refuse invalid/dirty. Run returned prepare/begin; require intent/digest/buffers/snapshot. Run `singularity-flow revision status --json`. `singularity-flow phase publish <phase>` consumes only a current, prechecked, eligible head; refuse stale, incomplete, abandoned, recovery-required, or ineligible state. No REV loop means ordinary publication.
6. Implement scope and executable tests. Fixtures, docs, deletions, and symlinks do not satisfy test delivery. Tag `@ac:ORDER:AC-001`.
7. Run native tests; publication deterministically infers supported structured runners. Require argv-form `kind: test`, cwd, affected roots, and a structured adapter. Never use skip/list/dry-run/pass-with-no-tests flags. Never edit `singularity/workflow.yml`, protected paths, or the pinned Story snapshot, or add a one-off test-result wrapper merely to satisfy publication. Unsupported runners require approved configuration authority outside the active Story.
8. Complete the artifact; run `singularity-flow phase draft-check <phase> --json`. Correct every agent finding now in this Copilot turn from governed evidence; recheck up to three changed fingerprints and stop immediately on an unchanged fingerprint. Never blindly delete markers, invent facts or padding, invoke a nested Copilot/model invocation, or overwrite human-, deterministic-, or external-authored output; route to its owner.
9. Only when `status` is `ready`, publish once with the configured producer/channel. On `ARTIFACT_AUTHORING_INCOMPLETE`, recheck once, retry once if ready; never loop.
10. Run `singularity-flow phase show <phase> --json`; show bounded source preview, hash-bound references, commit/push, telemetry, tests, and submit routes; stop before submission/approval.
