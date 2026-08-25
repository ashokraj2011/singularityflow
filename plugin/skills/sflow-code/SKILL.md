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
**Boundary:** `singularity-flow workspace current --json` → cwd=`repositoryPath`; never `$HOME`. Story: `singularity/work-items/<WORK-ID>/`.

1. Run `singularity-flow status --json`; use the governed workflow as Story context. Stop unless the active phase's normalized `generation.task` is `code`. Never hard-code `implementation`.
2. Before composition or file access, run `singularity-flow recover <WORK-ID> --phase <phase> --json`. Review and run its exact new-generation command first. Stop on a manual action or unchanged plan fingerprint.
3. Run `singularity-flow wm compose --phase <phase>` only with an open intent. Use its approved grounding and inputs. Materialize missing context only with the contributor's requested authorization.
4. Complete Human clarification before mutation: `ask_user`, wait, then `singularity-flow clarification record <phase> --response-file <file>`. Stop before authoring if required clarification remains unresolved.
5. Run `singularity-flow prepare <phase>`, then `singularity-flow phase begin <phase> --json`. Never change source without an open intent. Adopt existing work only through Flow's exact digest confirmation.
6. Inspect only grounded, approved scope. Implement behavior and executable tests. Fixtures, snapshots, configuration, reports, documentation, deleted tests, and symlinks do not independently satisfy test delivery.
7. Tag tests with full pinned clauses such as `@ac:ORDER:AC-001`; bare identities are refused when ambiguous.
8. Run affected modules' configured quality commands. Tests require argv-form `kind: test`, cwd, affected roots, and a structured adapter. Never add skip, dry-run, collection/list-only, or pass-with-no-tests flags.
9. Complete the phase artifact without placeholders; record changes, decisions, deviations, tests, limitations, and operations.
10. Rerun recovery. Resolve blockers once; stop on an unchanged plan fingerprint.
11. Publish exactly once: `singularity-flow phase publish <phase> --authored governed-agent --channel copilot-host`. This skill owns publication after delegation.
12. Run `singularity-flow phase show <phase> --json`. Show the manifest, bounded previews, hash-bound references, commit/push, telemetry assurance, tests, and next submission command. Stop before submission or approval.
