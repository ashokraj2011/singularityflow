---
name: sflow-phase
description: Generate and publish the configured artifact for any active Singularity Flow phase, including custom feature, bugfix, chore, specification, reproduction, and conformance phases.
disable-model-invocation: true
argument-hint: "[generation focus]"

---
# Generate the active phase

<!-- sflow-output-contract: clarification-and-artifact -->
**Output contract:** Use the complete governed prompt and approved inputs, ask unresolved questions, then publish and show configured artifacts.

Sequence gates may be hard or soft. On `Out of sequence`, stop immediately and relay the error. On `Soft sequence warning`, show the full warning and leave the interactive `continue` decision to the human; never self-confirm. Use `singularity-flow nextsteps` only for read-only guidance and never edit managed state to bypass a gate.

1. Run `singularity-flow status --json`; use only the active phase and current governed-agent session.
2. Run `singularity-flow documents list` and view every relevant uploaded input by its stable ID.
3. Run `singularity-flow wm compose --phase <phase> --task "<work objective>"`, adding `--evidence` when configured, and use the complete prompt. If missing/stale, build with the same phase/task and compose again. Composition records agent, views, routed files, evidence, clarification, hashes, and prompt snapshot.
4. If the composed prompt contains **Human clarification checkpoint**, execute it before preparation. Use `ask_user` for the configured batch and wait for the contributor. A `required` checkpoint must pause even when the evidence looks complete; a `when-needed` checkpoint may continue only after explicitly finding no material ambiguity. If `ask_user` is unavailable, display the questions and stop before preparation or publication.
5. Run `singularity-flow prepare <phase>` and read its configured template and approved inputs.
6. Complete only the active phase's configured artifacts. Preserve managed metadata, incorporate confirmed clarification decisions, keep explicitly deferred decisions visible, and remove all placeholders and unsupported claims.
7. For specifications, assign stable `SPEC-nnn` identifiers mapped to `AC-nnn`. For implementation/tests, preserve both identifiers. For conformance, compare every identifier with file/line evidence and disclose all self-approvals.
8. Run `singularity-flow phase publish <phase> --authored governed-agent --channel copilot-host`. Commit composition, prompt snapshot, and sanitized `telemetry/<phase>-gen<N>.json` without raw traces or conversation identifiers. Current-response usage may be `pending` until submit reconciles it; use `--usage-json` only for exact external records.
9. Run `singularity-flow phase show <phase> --json` after publication. In the visible assistant response, reproduce every returned published text document in full between `--- BEGIN <path> ---` and `--- END <path> ---`, preceded by its stable ID, kind, byte count, and SHA-256. A Shell/tool block, even when it contains the text, is collapsible and does not satisfy artifact review. Never say “shown above,” “rendered above,” or “documents shown,” and never replace the published document with a summary. For a binary document, show its absolute path, metadata, and open instruction.
10. Report the generation commit, push result, telemetry record, resolved model, token/cost status, and next action. Do not submit or approve automatically.
