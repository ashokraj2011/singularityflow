---
name: sflow-phase
description: Generate and publish configured artifacts for the active Singularity Flow phase.
disable-model-invocation: true
argument-hint: "[generation focus]"

---
# Generate the active phase

<!-- sflow-output-contract: clarification-and-artifact -->
**Output contract:** Resolve paths under singularity/work-items/<WORK-ID>/ in this repository; never search outside it. Use the complete governed prompt and approved inputs, ask unresolved questions, then publish and show configured artifacts.

On `Out of sequence`, stop and relay the error. On `Soft sequence warning`, show it and leave `continue` to the human. Never edit state to bypass a gate.

1. Run `singularity-flow status --json`; use its active phase and session. Story context comes from this governed workflow record, while the world model is shared by the repository.
2. Run `singularity-flow documents list` and view every relevant uploaded input by its stable ID.
3. Run `singularity-flow wm compose --phase <phase>`, adding configured `--evidence`, and use the complete prompt. If missing/stale, run its exact ensure command only after contributor authorization, then compose identically. Never add a Story title or conversational objective as `--task`; direct `wm ... --task` is reserved for an explicitly requested ad-hoc task guide.
4. Execute any **Human clarification checkpoint** before preparation. Use `ask_user` and wait. `required` pauses; `when-needed` continues only without material ambiguity. If unavailable, display questions and stop before preparation. Record answers with `singularity-flow clarification record <phase> --response-file <file>`; stop on failure.
5. Run `singularity-flow prepare <phase>` and read its configured template and approved inputs.
6. Complete only configured artifacts, preserving metadata, confirmed clarifications, and visible deferrals. Re-read each; stop on `TODO`, `TBD`, unresolved `{{...}}`, or template instructions. Never publish an untouched template.
7. For specifications, assign stable `SPEC-nnn` identifiers mapped to `AC-nnn`. For implementation/tests, preserve both identifiers. For conformance, compare every identifier with file/line evidence and disclose all self-approvals.
8. Run `singularity-flow phase publish <phase> --authored governed-agent --channel copilot-host`. Commit composition, prompt snapshot, and sanitized `telemetry/<phase>-gen<N>.json` without raw traces or conversation identifiers. Usage may be `pending` until submit; use `--usage-json` only for exact external records.
9. Run `singularity-flow phase show <phase> --json`. Reproduce every published text document in full in the visible assistant response between `--- BEGIN <path> ---` and `--- END <path> ---`, preceded by ID, kind, bytes, and SHA-256. Never replace the published document with a summary. A Shell/tool block does not count, and never say it was “shown above.” For binary documents, show path, metadata, and open instruction.
10. Report commit, push result, telemetry, resolved model, token/cost status, and next action. Do not submit or approve automatically. Show the next direct Copilot action first as `Next in Copilot: /sf-...`, then its exact CLI form as `Terminal equivalent: singularity-flow ...`. For the normal published-phase handoff, use `/sf-submit <phase>` and `singularity-flow submit <phase>`.
