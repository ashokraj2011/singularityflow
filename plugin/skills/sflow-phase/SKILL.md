---
name: sflow-phase
description: Generate and publish the configured artifact for any active Singularity Flow phase, including custom feature, bugfix, chore, specification, reproduction, and conformance phases.
argument-hint: "[generation focus]"
disable-model-invocation: true
---
# Generate the active phase

1. Run `singularity-flow status --json`; use only the active phase and current persona session.
2. Run `singularity-flow wm context <phase> --task "<work objective>" --concat --no-persona`, adding `--evidence` when configured. Rebuild the model if missing or stale. This loads mandatory phase/persona views without duplicating the persona prompt.
3. Run `singularity-flow wm inject --phase <phase>` and use the returned persona prompt. It applies matching `worldModel.injection.rules` and records the exact injected file hashes for the next generation.
4. Run `singularity-flow documents list`, view every relevant uploaded input by its stable ID, then run `singularity-flow prepare <phase>` and read its configured template and approved inputs.
5. Complete only the active phase's configured artifacts. Preserve managed metadata and remove all placeholders and unsupported claims.
6. For specifications, assign stable `SPEC-nnn` identifiers mapped to `AC-nnn`. For implementation/tests, preserve both identifiers. For conformance, compare every identifier with file/line evidence and disclose all self-approvals.
7. Run `singularity-flow phase publish <phase>`. Add `--usage-json <file>` only when the provider supplied exact usage JSON. The generation commit must include the injection audit record.
8. Report the generation commit, push result, token status, and next action. Do not submit or approve automatically.
