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
**Boundary:** `singularity-flow session current --json` → verified `ready`/`workId`, cwd=`repositoryPath`; never `$HOME`; `singularity/work-items/<WORK-ID>/`.

Stop on `Out of sequence`; leave `continue` to the human. Never edit state to bypass a gate.

1. Run `singularity-flow status --json`; use its phase/session. Story context stays in the governed workflow; grounding uses the shared repository world model.
2. Run `singularity-flow documents list`; view relevant inputs by stable ID.
3. Reuse the governed prompt delivered this turn. Otherwise run `singularity-flow wm compose --phase <phase>` once. Never compose the same generation twice in one turn or derive `--task` from Story text. Run an exact ensure command only with contributor authorization.
4. Complete the **Human clarification checkpoint** before preparation. Use `ask_user` and wait; `required` pauses. If unavailable, show questions and stop before preparation. Write `{"responses":[{"question":"...","answer":"..."}]}` to a private UTF-8 `.json` file and run `singularity-flow clarification record <phase> --response-file <file.json>`. Never pass Markdown.
5. Run `singularity-flow prepare <phase>`; follow its template, inputs, byte, and heading contract. Re-read artifacts; stop on `TODO`, `TBD`, unresolved `{{...}}`, or instructions. Never publish an untouched template or pad it.
6. Use full anchors such as `[WORK-ID:REQ-001]` and `[WORK-ID:AC-001]`; bare `SPEC-nnn`, `AC-nnn`, or `NFR-nnn` labels are not governed clauses. Preserve IDs through tests and conformance.
7. Run `singularity-flow recover <WORK-ID> --phase <phase> --json`. Re-author each `authoring` blocker, then rerun recovery. No nested Copilot/model invocation. Stop on missing clarification or an unchanged artifact fingerprint.
8. Run the configured-producer publication command from `prepare` or `nextsteps`; never substitute producer/channel. On `ARTIFACT_AUTHORING_INCOMPLETE`, re-author every finding and retry once only after the fingerprint changes. Never add padding. Stop and report the second refusal. Preserve composition, prompt snapshot, and sanitized `telemetry/<phase>-gen<N>.json`; use `--usage-json` only for exact usage.
9. Run `singularity-flow phase show <phase> --json`. Show Markdown in full, source as a bounded source preview with a hash-bound reference, and binaries as metadata plus an open instruction.
10. Report commit/push, telemetry, resolved model, token/cost status, and next action. Do not submit or approve. Show `Next in Copilot: /sf-...`, then `Terminal equivalent: singularity-flow ...`; normal handoff is `/sf-submit <phase>`.
