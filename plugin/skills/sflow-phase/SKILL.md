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

1. From the Boundary result require `ready`, exact `phaseAgent` readiness when required, and its `repositoryPath`; run `singularity-flow phase show <phase> --json` for the bounded contract. Story context remains governed separately. Route `generation.task: code` to `/sf-code` and deterministic convergence to `/sf-converge`; show the returned Shell equivalent and stop.
2. Run `singularity-flow documents list`; view inputs by ID.
3. Reuse the governed prompt or run `singularity-flow wm compose --phase <phase>` once. Never derive `--task` from Story text. Unavailable intelligence is zero-byte context; continue with optional recovery.
4. Run `singularity-flow clarification status <phase> --json`. For `off`, do not ask or record; continue. For `when-needed`, ask and record only for material ambiguity; otherwise continue. For `required`, `ask_user`, wait, record before preparation; stop if unavailable. Stage only `{"responses":[...]}` at `git rev-parse --git-path singularity-flow/clarification-responses/<phase>.json`; never at `singularity/work-items/**/context/clarifications-*.json`. Delete on success; never pass Markdown.
5. Run `singularity-flow story references verify --work-id <WORK-ID> --json`; use returned repository-relative `localPath` values read-only. Run its exact `singularity-flow prepare <phase>` action. Stop on `TODO`, `TBD`, `{{...}}`, instructions, an untouched template, or padding.
6. Use full `[WORK-ID:REQ-001]` and `[WORK-ID:AC-001]` anchors; preserve IDs through tests and conformance.
7. Run `singularity-flow recover <WORK-ID> --phase <phase> --json`; repair governed authoring blockers and recheck.
8. Run `singularity-flow phase draft-check <phase> --json`. Correct every agent finding now from governed evidence; recheck up to three changed fingerprints and stop on an unchanged fingerprint. Never blindly delete markers, invent facts or padding, invoke a nested model, or overwrite another producer; route it to its owner/regenerator.
9. Only when `status` is `ready`, publish with the exact configured producer/channel. Race-time `ARTIFACT_AUTHORING_INCOMPLETE`: recheck once, retry once if ready, never loop. Preserve sanitized `telemetry/<phase>-gen<N>.json`.
10. Run `singularity-flow phase show <phase> --json`; show bounded evidence and report commit/push, the resolved model, and token/cost status. For code or source evidence, show only a bounded source preview plus its hash-bound references; never reproduce source files in full; never submit or approve. Say **Published generation <N> — ready to submit**; never say `publish-ready`. Then show `/sf-submit <phase>` and `singularity-flow submit <phase>`.
