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

1. Run `singularity-flow status --json` and use the governed workflow as Story context. Stop unless the active phase's normalized `generation.task` is `code`; never hard-code `implementation`.
2. Run `singularity-flow wm compose --phase <phase>` and use its approved grounding and inputs. Materialize missing model context only after the contributor gives the authorization requested by the returned command.
3. Complete the Human clarification checkpoint before mutation. Use `ask_user`, wait for the answer, and record it with `singularity-flow clarification record <phase> --response-file <file>`. Stop before authoring if required clarification remains unresolved or cannot be recorded.
4. Run `singularity-flow prepare <phase>`, then `singularity-flow phase begin <phase> --json`. Begin is a local, idempotent receipt boundary; it creates no lifecycle event, commit, push, or ledger entry. Never change application source before an open generation intent exists. Existing work may be adopted only through the exact digest confirmation Flow returns and only when Story policy permits it.
5. Inspect only the repository locations needed by the grounding package and approved scope. Implement the requested behavior and add or update executable tests. Fixtures, snapshots, page objects, configuration, reports, documentation, deleted tests, and symlinks do not independently satisfy test delivery.
6. Tag executable tests with full pinned clause identities such as `@ac:ORDER:AC-001`. A bare `@ac:AC-001` is compatibility input only and is refused when namespaces are ambiguous.
7. Run the affected module's configured quality commands. Required tests must use argv-form `kind: test` commands with a working directory, affected roots, and structured result adapter. Do not add skip, dry-run, collection-only, list-only, or pass-with-no-tests flags.
8. Complete the configured phase artifact and remove every placeholder. Record changed components, decisions, deviations, tests, limitations, and operational notes.
9. Before publishing, run `singularity-flow recover <WORK-ID> --phase <phase> --json`. Resolve every blocker, rerun once, and stop if its plan fingerprint is unchanged.
10. Run `singularity-flow phase publish <phase> --authored governed-agent --channel copilot-host` exactly once. If another skill delegated here, this skill owns publication and the caller must stop after this skill returns.
11. Run `singularity-flow phase show <phase> --json`. Show the publication manifest, bounded source previews, and hash-bound references; do not replay generated source files in full. Report commit, push, telemetry/model assurance, test evidence status, and the next explicit submission command. Stop before submission or approval.
