# ADR 0010 — CAB reuses authority and separates Candidate from evidence

- **Status:** Proposed for independent CAB-R0 review
- **Date:** 2026-09-05
- **Scope:** Code Assurance Bridge v0.2

## Decision

CAB is an evidence integration over the existing SGOS Candidate, GVM Program, Capability Pack,
phase approval, and lifecycle publication authorities. It must not own a Candidate store,
scheduler, registry, quorum, or publisher.

Candidate bytes and verification inputs occupy one immutable subject plane. Checker attempts,
findings, bundles, and review references occupy a separate append-only evidence plane. Evidence
may refer to a Candidate; a Candidate cannot refer to evidence created after freeze.

The exact mapping is machine-checked in
[`../contracts/cab/architecture-v0.2.json`](../contracts/cab/architecture-v0.2.json).

## Consequences

- Candidate/evidence self-reference is impossible by construction.
- Changed Candidate bytes always start a new verification cycle.
- CAB evidence cannot advance a Story or Git ref on its own.
- Existing publication recovery remains the only recovery for an accepted Candidate commit.
- Legacy module evidence remains readable without acquiring an exact-test claim.

## Rejected alternatives

- a CAB-specific Candidate archive;
- a CAB verification scheduler beside GVM;
- CAB approval or publish commands;
- storing checker output in the Candidate tree and rehashing the Candidate afterward.
