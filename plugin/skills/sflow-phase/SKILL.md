---
name: sflow-phase
description: Generate and publish the configured artifact for any active Singularity Flow phase, including custom feature, bugfix, chore, specification, reproduction, and conformance phases.
argument-hint: "[generation focus]"
disable-model-invocation: true
---
# Generate the active phase

Sequence gates may be hard or soft. On `Out of sequence`, stop immediately and relay the error. On `Soft sequence warning`, show the full warning and leave the interactive `continue` decision to the human; never self-confirm. Use `singularity-flow nextsteps` only for read-only guidance and never edit managed state to bypass a gate.

1. Run `singularity-flow status --json`; use only the active phase and current persona session.
2. Run `singularity-flow wm compose --phase <phase> --task "<work objective>"`, adding `--evidence` when configured, and use the complete returned prompt. If the model or exact task guide is missing or stale, first run `singularity-flow wm build --phase <phase> --task "<work objective>"`, then rerun the identical compose command. Composition records the persona, mandatory phase/persona views, task guide, rule-selected files, evidence, remote skills, hashes, and exact prompt snapshot for the next generation.
3. Run `singularity-flow documents list`, view every relevant uploaded input by its stable ID, then run `singularity-flow prepare <phase>` and read its configured template and approved inputs.
4. Complete only the active phase's configured artifacts. Preserve managed metadata and remove all placeholders and unsupported claims.
5. For specifications, assign stable `SPEC-nnn` identifiers mapped to `AC-nnn`. For implementation/tests, preserve both identifiers. For conformance, compare every identifier with file/line evidence and disclose all self-approvals.
6. Run `singularity-flow phase publish <phase>`. Add `--usage-json <file>` only when the provider supplied exact usage JSON. The generation commit must include the grounding composition record and prompt snapshot.
7. Report the generation commit, push result, token status, and next action. Do not submit or approve automatically.
