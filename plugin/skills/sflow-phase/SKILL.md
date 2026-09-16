---
name: sflow-phase
description: Generate and publish configured artifacts for the active Singularity Flow phase.
disable-model-invocation: true
argument-hint: "[generation focus]"

---
# Generate the active phase

<!-- sflow-output-contract: clarification-and-artifact -->
**Output contract:** Use the complete governed prompt and approved inputs, obey the pinned clarification mode, then publish and show configured artifacts.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow session current --json` → `ready`/`workId`, cwd=`repositoryPath`; use CLI/`workItemRoot` paths; never `$HOME`.

Stop on `Out of sequence`; only the human may `continue`. Never bypass a gate.

1. Run `singularity-flow status --json`; use its phase/session. Story context stays governed; grounding uses the shared world model.
2. Run `singularity-flow documents list`; view inputs by ID.
3. Reuse the governed prompt or run `singularity-flow wm compose --phase <phase>` once. Never recompose or derive `--task` from Story text. Unavailable World-Model intelligence is zero-byte context; continue and show optional recovery.
4. Run `singularity-flow clarification status <phase> --json`. For `off`, do not ask or record; continue. For `when-needed`, ask and record only for material ambiguity; otherwise continue. For `required`, `ask_user`, wait, record before preparation; stop if unavailable. Stage only `{"responses":[...]}` at `git rev-parse --git-path singularity-flow/clarification-responses/<phase>.json`; never at `singularity/work-items/**/context/clarifications-*.json`. Delete on success; never pass Markdown.
5. Run `singularity-flow story references verify --work-id <WORK-ID> --json`. Use only returned repository-relative `localPath` values, read-only; materialize only through its exact action and never edit/reset. Run the exact returned `singularity-flow prepare <phase>` command; follow its template/input/byte/heading contract. Re-read artifacts; stop on `TODO`, `TBD`, unresolved `{{...}}`, or instructions. Never publish an untouched template or pad it.
6. Use full anchors such as `[WORK-ID:REQ-001]` and `[WORK-ID:AC-001]`; bare `SPEC-nnn`, `AC-nnn`, or `NFR-nnn` labels are not governed clauses. Preserve IDs through tests and conformance.
7. Run `singularity-flow recover <WORK-ID> --phase <phase> --json`; repair its authoring blockers from governed evidence, then recheck.
8. Run `singularity-flow phase draft-check <phase> --json`. Correct every agent finding now from governed evidence; recheck up to three changed fingerprints and stop on an unchanged fingerprint. Never blindly delete markers, invent facts or padding, invoke a nested model, or overwrite another producer; route it to its owner/regenerator.
9. Only when `status` is `ready`, publish with the exact configured producer/channel. Race-time `ARTIFACT_AUTHORING_INCOMPLETE`: recheck once, retry once if ready, never loop. Preserve sanitized `telemetry/<phase>-gen<N>.json`.
10. Run `singularity-flow phase show <phase> --json`; show text, bounded previews with hash-bound references, and binary metadata. Report commit/push, resolved model and token/cost status; never submit or approve. If recorded, say exactly **Published generation <N> — ready to submit**; never say `publish-ready`. End `Next in Copilot: /sf-submit <phase>` then `Terminal equivalent: singularity-flow submit <phase>`.
