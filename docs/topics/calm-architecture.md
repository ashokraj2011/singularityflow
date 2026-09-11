---
id: calm-architecture
title: Deterministic CALM architecture projection
aliases:
  - architecture
  - calm
  - arch.calm
commands:
  - architecture
related:
  - world-model
  - capability-management
  - evidence-and-ledger
version: 1
---
The `arch.calm@1` product is a deterministic, model-free FINOS CALM projection of the exact
capability, configuration, and World Model facts admitted by Singularity Flow. It is derived
evidence, not editable architecture authority. Identical bound inputs produce identical CALM and
provenance bytes, and heuristic or model-advisory facts cannot create architecture elements.

## Enable it

The projection is optional and disabled by default during rollout. Enable
`worldModel.projections.arch.calm.enabled` in approved repository configuration. Keep `required:
false` until the repository has reviewed its classifications, interfaces, controls, and offline
validator readiness. Existing repositories and World Model builds are unchanged while disabled.

## Inspect and explain

Use `sflow architecture show` for a bounded summary, `sflow architecture explain` for one element,
and `sflow architecture sources` for its exact provenance. `sflow architecture validate` verifies
the generated structure and receipt, while `sflow architecture doctor` reports missing authority
or configuration with safe recovery. These reads never invoke a model or search outside the
selected repository.

The source map binds each emitted node, interface, relationship, control, and flow to exact source
digests and repository-relative locations. Individual approval-group members, absolute machine
paths, credential-bearing URLs, and unavailable facts are not emitted as architecture.

## Story intent and export

A Story may hold a reviewed architecture-intent file and render a Story-only planned projection.
The planned file never replaces the shared base projection. Fulfilment compares approved clauses
with a later deterministic base projection and keeps `missing`, `deviated`, `not-observable`, and
`fulfilled` outcomes distinct.

Use `sflow architecture export` only with an explicit repository-relative destination. Plain CALM
export copies the governed bytes and does not mutate the World Model, Story state, or authority.
Generated files under `singularity/world-model/projections`, their source maps, and receipts must
not be edited by hand; change the cited capability declaration, policy, contract, or source fact
and rebuild instead.

## Copilot

Run `/sf-architecture` for bounded architecture status, validation, explanation, provenance, or a
reviewed export command. The skill is deterministic and cannot invoke a model, approve intent, or
publish a lifecycle phase.
