---
id: calm-architecture
title: Deterministic CALM architecture projection
aliases:
  - architecture
  - calm
  - arch.calm
  - architecture projection
commands:
  - architecture
related:
  - world-model
  - capability-management
  - evidence-and-ledger
version: 3
---

The `arch.calm@1` product projects validated World Model facts into a deterministic FINOS CALM
document. It is derived evidence, not editable architecture authority. Identical bound inputs
produce identical CALM, provenance, and validation receipts. Heuristic or model-advisory facts
cannot create architecture elements.

## Purpose and prerequisites

Use this topic to inspect repository architecture, trace an element to its sources, validate the
projection, record Story-scoped architecture intent, or export a reviewed copy. Enable
`worldModel.projections.arch.calm.enabled` in approved repository configuration. A repository
World Model must exist for repository-wide elements. Story intent additionally requires an active
or explicit work item. The pinned offline CALM validator is used; these commands do not contact an
external service or invoke a model.

## Use it from each surface

- **Shell:** run `sflow architecture show`, `sflow architecture explain <ELEMENT-ID>`,
  `sflow architecture sources <ELEMENT-ID>`, or `sflow architecture validate`.
- **Copilot:** run `/sf-architecture` and choose a bounded status, validation, explanation,
  provenance, intent, or export action. The skill never approves or publishes a lifecycle phase.
- **VS Code:** open Singularity Flow **World Model → Architecture** to browse the summary, element
  table, relationships, provenance, validation receipt, and Story overlay without editing generated
  files.

## Guided workflow

1. Run `sflow architecture doctor` to confirm the World Model, projection contract, validator, and
   current repository boundary.
2. Run `sflow architecture show` for the bounded architecture summary and element table.
3. Run `sflow architecture explain <ELEMENT-ID>` to inspect one element and its relationships.
4. Run `sflow architecture sources <ELEMENT-ID>` to verify exact Fact and evidence provenance.
5. Run `sflow architecture validate` to verify the generated structure and projection receipt.
6. For a Story-only proposed change, record reviewed architecture intent and render its planned
   overlay. The overlay never rewrites the repository-wide observed projection.
7. Run `sflow architecture export --out <REPOSITORY-RELATIVE-PATH>` only after reviewing the exact
   destination and projection identity.

## State and safety

Generated files under `singularity/world-model/projections`, their source maps, and receipts are
immutable derived state. Change the cited capability declaration, policy, contract, or source fact
and rebuild instead of editing projection bytes. Repository-wide observed architecture is reusable
across Stories at the same source identity; Story intent remains a separate planned overlay.
Credential-bearing URLs, paths outside the verified repository, unsupported facts, and facts below
the contract's assurance threshold are not emitted. Export requires an explicit repository-relative
destination and does not mutate World Model, Story state, or approval authority.

## Troubleshooting

- If no projection exists, inspect `sflow wm status` and explicitly build or refresh the approved
  World Model; ordinary lifecycle work remains available when architecture intelligence is absent.
- If an element is missing, inspect its facts and assurance with `sflow architecture sources`; do
  not add it by hand to generated CALM.
- If validation fails, run `sflow architecture doctor` and repair the cited contract, validator, or
  stale source input before rebuilding.
- If Story intent is unavailable, resume the intended work item or pass its documented `--work-id`.
- If export is refused, choose a new repository-relative destination and review the refreshed action.

## Related topics

- [World model grounding and views](world-model.md)
- [Capability management](capability-management.md)
- [Evidence and ledger](evidence-and-ledger.md)
