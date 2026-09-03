---
name: sflow-code
description: Author any Singularity Flow phase whose normalized generation task is code, with one generation boundary, executable tests, and exactly-once publication.
disable-model-invocation: true
argument-hint: "[code-generation focus]"

---
# Governed code generation

<!-- sflow-output-contract: clarification-and-artifact -->
**Output contract:** Use the complete governed prompt and approved inputs, ask unresolved questions, then publish and show configured artifacts.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow session current --json` → verified `ready`/`workId`, cwd=`repositoryPath`; never `$HOME`; `singularity/work-items/<WORK-ID>/`.

1. Run `singularity-flow status --json`; use the governed workflow as Story context. Stop unless the active phase's normalized `generation.task` is `code`. Never hard-code `implementation`.
2. Run `singularity-flow recover <WORK-ID> --phase <phase> --json` before file access. Execute its exact new-generation command first. For a consumed generation, use `phase rollover <phase>` and that preview's confirmation; never replay a stale digest. Stop on manual action or an unchanged plan.
3. Use the governed prompt delivered this turn, or run `singularity-flow wm compose --phase <phase>` once with an open intent. If composition reports unavailable World-Model intelligence—missing or unreachable, or stale under staleness `fail`—treat it as explicit zero-context evidence, not a code-generation blocker. Show an exact returned recovery command only as an optional improvement; do not run it from this skill and continue with ordinary repository access.
4. Complete Human clarification before mutation: `ask_user`, wait, write only `{"responses":[{"question":"...","answer":"..."}]}` to a private temporary `.json` file, then run `singularity-flow clarification record <phase> --response-file <file.json>`. Never pass Markdown. Stop before authoring if required clarification remains unresolved.
5. Run `singularity-flow prepare <phase>`, then `singularity-flow phase begin <phase> --json`. Never change source without an open intent. Adopt only through exact digest confirmation. Save all buffers before publication and honor snapshot-change refusals.
6. Implement the approved scope and executable tests. Fixtures, reports, documentation, deleted tests, and symlinks do not satisfy test delivery.
7. Tag tests with full pinned clauses such as `@ac:ORDER:AC-001`; bare identities are refused when ambiguous.
8. Run affected modules' configured quality commands. Tests require argv-form `kind: test`, cwd, affected roots, and a structured adapter. Never add skip, dry-run, collection/list-only, or pass-with-no-tests flags.
9. Complete the phase artifact without placeholders; record changes, decisions, deviations, tests, limitations, and operations.
10. Rerun recovery. Resolve blockers once; stop on an unchanged plan fingerprint.
11. Publish exactly once with the configured-producer command printed by `prepare` or returned by `nextsteps`. Never substitute `governed-agent` for a deterministic phase or pair `deterministic` with `copilot-host`. This skill owns publication after delegation.
12. Run `singularity-flow phase show <phase> --json`. Show the manifest, bounded previews, hash-bound references, commit/push, telemetry assurance, tests, and next submission command. Stop before submission or approval.
