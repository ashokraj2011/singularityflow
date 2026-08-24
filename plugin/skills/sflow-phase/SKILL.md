---
name: sflow-phase
description: Generate and publish configured artifacts for the active Singularity Flow phase.
disable-model-invocation: true
argument-hint: "[generation focus]"

---
# Generate the active phase

<!-- sflow-output-contract: clarification-and-artifact -->
**Output contract:** Use the complete governed prompt and approved inputs, ask unresolved questions, then publish and show configured artifacts.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow workspace current --json` → cwd=`repositoryPath`; never `$HOME`. Story: `singularity/work-items/<WORK-ID>/`.

Stop on `Out of sequence`; show a soft warning and leave `continue` to the human. Never edit state to bypass a gate.

1. Run `singularity-flow status --json`; use its phase/session. Story context comes from the governed workflow; the repository world model is shared across Stories.
2. Run `singularity-flow documents list`; view relevant inputs by stable ID.
3. Run `singularity-flow wm compose --phase <phase>` with configured `--evidence` and use the complete prompt. Run a missing/stale model's exact ensure command only with contributor authorization. Never derive `--task` from Story text; it is only for an explicitly requested ad-hoc guide.
4. Complete the **Human clarification checkpoint** before preparation. Use `ask_user` and wait; `required` pauses. If unavailable, show questions and stop before preparation. Record answers with `singularity-flow clarification record <phase> --response-file <file>`.
5. Run `singularity-flow prepare <phase>`; read its template, inputs, and exact authored-byte/heading contract. Complete only configured artifacts; managed blocks do not count. Re-read them; stop on `TODO`, `TBD`, unresolved `{{...}}`, or template instructions. Never publish an untouched template or pad it.
6. Specifications use stable `SPEC-nnn` mapped to `AC-nnn`; implementation/tests preserve both. Conformance compares every ID with file/line evidence and discloses self-approval.
7. Run `singularity-flow recover <WORK-ID> --phase <phase> --json`. For each `authoring` blocker, reopen the artifact and re-author it from the composed prompt and answers, then rerun recovery. Stay in this Copilot turn—no nested Copilot/model invocation. Stop on missing clarification or an unchanged artifact fingerprint.
8. Run `singularity-flow phase publish <phase> --authored governed-agent --channel copilot-host`. On `ARTIFACT_AUTHORING_INCOMPLETE`, re-author every structured finding and retry this exact command once, only after the fingerprint changes. Never add padding. Stop and report the second refusal. Preserve the composition, prompt snapshot, and sanitized `telemetry/<phase>-gen<N>.json` without raw traces or conversation identifiers; use `--usage-json` only for exact external usage.
9. Run `singularity-flow phase show <phase> --json`. Show eligible Markdown in full; use a bounded preview and hash-bound reference for source. For binaries, show path, metadata, and open instruction.
10. Report commit/push, telemetry, resolved model, token/cost status, and next action. Do not submit or approve. Show `Next in Copilot: /sf-...`, then `Terminal equivalent: singularity-flow ...`; normal handoff is `/sf-submit <phase>`.
