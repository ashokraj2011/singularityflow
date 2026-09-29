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

1. Require `ready`, matching `phaseAgent`, and `repositoryPath`; run `singularity-flow phase show <phase> --json`. Story context stays in the governed workflow. Route code tasks to `/sf-code` and deterministic convergence to `/sf-converge`; show its Shell equivalent and stop.
2. Run `singularity-flow documents list`; view inputs by ID.
3. Reuse the governed prompt or run `singularity-flow wm compose --phase <phase>` once. Never derive `--task` from Story text. Unavailable intelligence is zero-byte context.
4. Run `singularity-flow clarification status <phase> --json`. For `off`, do not ask or record; continue. For `when-needed`, ask and record only for material ambiguity; otherwise continue. For `required`, `ask_user`, wait, record before preparation; stop if unavailable. Stage only `{"responses":[...]}` at `git rev-parse --git-path singularity-flow/clarification-responses/<phase>.json`; never at `singularity/work-items/**/context/clarifications-*.json`. Delete on success; never pass Markdown.
5. Run `singularity-flow story references verify --work-id <WORK-ID> --json`; use returned `localPath` read-only. Run its exact `singularity-flow prepare <phase>` action. Stop on placeholders, untouched templates, or padding.
6. Use full `[WORK-ID:REQ-001]` and `[WORK-ID:AC-001]` anchors; preserve IDs through tests and conformance.
7. Run read-only `singularity-flow recover <WORK-ID> --phase <phase> --json`; follow only current-phase lawful actions. Stop for human confirmation, protected configuration, or another producer.
8. Run `singularity-flow phase draft-check <phase> --json`, then `singularity-flow phase prepublish <phase> --json`. Correct every agent finding now from approved evidence; recheck at most three changed fingerprints, stop on an unchanged fingerprint. Obey `correction.class` and `sameTurn`: regenerate deterministic output with its exact command; route external/human output to its owner. Never blindly delete markers, invent facts or padding, invoke a nested model, or overwrite another producer.
9. Only when prepublish `status` is `ready`, publish with its exact configured producer/channel; never submit or approve. Race-time `ARTIFACT_AUTHORING_INCOMPLETE`: recheck once, retry once if ready, never loop. Preserve sanitized `telemetry/<phase>-gen<N>.json`.
10. Run `singularity-flow phase show <phase> --json`; show bounded evidence, commit/push, resolved model and token/cost status. For source show a bounded preview and hash-bound references, not full files. Say **Published generation <N> — ready to submit**; never say `publish-ready`. End with `Next in Copilot: /sf-submit <phase>` and `Terminal equivalent: singularity-flow submit <phase>`.
