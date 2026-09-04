# ADR 0005: GDP authority ownership and compatibility

- Status: accepted for contract implementation; runtime rollout not authorized
- Date: 2026-09-04
- Baseline: `main@70db564e`
- Decision owner: Singularity Flow repository maintainers

## Context

The GDP source proposal spans delivery modes, proof, workflows, Auto, SGOS, World Model, evidence,
approvals, and publication. Several of those systems already have durable authority. Implementing
the proposal as independent modules would create competing Candidates, schedulers, evidence
verdicts, approvals, or publishers and would make recovery ambiguous.

## Decision

GDP is an orchestration and aggregate layer over existing owners:

- SGOS owns Candidate identity and governed execution.
- Creation-pinned workflow runtimes own existing Story lifecycle state.
- WMB owns the shared World Model; WEL owns witnessed clause observations; CAB owns future exact
  checker evidence after their own release gates.
- Existing approval authorities and Action Authorization own human decisions.
- The existing publication unit of work owns commit, push, pending markers, and recovery.
- MIG owns schema registration and read migration.

GDM and PFC may introduce new semantic records only where the family catalog identifies a gap.
They reference existing records and cannot reinterpret historical evidence as stronger assurance.
No package upgrade enrolls existing or in-flight work. A legacy subject remains bound to its
creation runtime until an explicit, previewed, digest-confirmed migration at a stable boundary.

Delivery selection uses `selectionStrategy: recommend | fixed | human-choice` separately from
`deliveryMode: workflow | outcome`. Auto remains a pace. Proof profile and autonomy remain
independent decisions.

## Consequences

M0 introduces no runtime behavior. M1 may add pure compatibility projections. Later implementation
must extend existing services rather than introduce an equivalent top-level writer. A proposed
writer that overlaps the ownership table is a contract failure and requires a new ADR before code.

The price is deliberate sequencing across SGOS, WMB, WEL, and CAB. The benefit is that a push
failure, stale Candidate, approval, or migration has one authoritative recovery path.
