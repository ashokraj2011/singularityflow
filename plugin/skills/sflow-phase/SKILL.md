---
name: sflow-phase
description: Generate and publish the configured artifact for any active Singularity Flow phase, including custom feature, bugfix, chore, specification, reproduction, and conformance phases.
argument-hint: "[generation focus]"
disable-model-invocation: true
---
# Generate the active phase

1. Run `singularity-flow status --json`; use only the active phase and current persona session.
2. Run `singularity-flow wm context <phase> --task "<work objective>" --concat`, adding `--evidence` when configured. Rebuild the model if missing or stale.
3. Run `singularity-flow documents list`, view every relevant uploaded input by its stable ID, then run `singularity-flow prepare <phase>` and read its configured template, approved inputs, active persona prompt, and repository evidence.
4. Complete only the active phase's configured artifacts. Preserve managed metadata and remove all placeholders and unsupported claims.
5. For specifications, assign stable `SPEC-nnn` identifiers mapped to `AC-nnn`. For implementation/tests, preserve both identifiers. For conformance, compare every identifier with file/line evidence and disclose all self-approvals.
6. Run `singularity-flow phase publish <phase>`. Add `--usage-json <file>` only when the provider supplied exact usage JSON.
7. Report the generation commit, push result, token status, and next action. Do not submit or approve automatically.
