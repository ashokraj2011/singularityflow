---
name: sflow-implement
description: Implement the approved Singularity Flow design, add or update tests, and create the implementation summary while preserving phase traceability.
disable-model-invocation: true
argument-hint: "[implementation focus]"

---
# Implementation phase

<!-- sflow-output-contract: clarification-and-artifact -->
**Output contract:** Use the complete governed prompt and approved inputs, ask unresolved questions, then publish and show configured artifacts.
<!-- sflow-execution-boundary -->
**Boundary:** Flow-reported root only (Story: `singularity/work-items/<WORK-ID>/`). Deterministic: `--no-model`; kernel model: forbidden.

1. Run `singularity-flow implement --json` first. Relay its subject, phase, generation, publication/approval state, milestone, checkpoint, and kernel operations. Stop at `recovery` or `approval`; otherwise author below and publish through the returned kernel operation.
1. Run `singularity-flow status --json`; stop if the current phase is not `implementation`. Use that governed workflow as Story context.
2. Run `singularity-flow wm compose --phase implementation` and use the complete returned prompt. If the grounding plan is missing or stale, show and run the exact returned ensure command only with explicit contributor authorization, then rerun the identical compose command. Never add the Story title or a conversational implementation objective as `--task`. Use the shared development and testing grounding to select entry points, conventions, and commands.
3. Read approved requirements, design artifacts, and the source locations selected by the grounding package.
4. Inspect further files only as the implementation requires within this repository.
5. Implement only approved scope; add or update tests and documentation. Tag tests with the corresponding `@ac:AC-n` identifiers.
6. Run relevant format, build, lint, and test commands.
7. Run `singularity-flow prepare implementation` and complete the summary with changed components, decisions, deviations, tests, limitations, and operational notes. Fill `Agent brief` with the implemented outcome, consequential decisions, validation result, residual limitations, and rollout considerations for downstream agents. Re-read the completed summary and stop if it still contains `TODO`, `TBD`, an unresolved `{{...}}` token, or template instruction text. Never publish the untouched prepared summary.
8. Only after the source changes, tests, and completed summary all exist, run `singularity-flow phase publish implementation --authored governed-agent --channel copilot-host`.
9. Run `singularity-flow phase show implementation --json`, then reproduce every published text document in full in the visible assistant response between `--- BEGIN <path> ---` and `--- END <path> ---`, with its ID, kind, byte count, and hash. A collapsible Shell/tool block does not count. Never say “shown above.” Never replace it with a summary. Source files such as `.java`, `.js`, `.ts`, and `.py` are text documents and must be reproduced, not labeled binary. For true binary documents, show the absolute path, metadata, and open instruction.
10. Report commands and outcomes. Do not submit or approve automatically. End with `Next in Copilot: /sf-submit implementation`, followed by `Terminal equivalent: singularity-flow submit implementation`.
