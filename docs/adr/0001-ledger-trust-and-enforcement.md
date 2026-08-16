# ADR 0001: Capability-ledger trust and enforcement

- Status: accepted and current
- Date: 2026-07-31

This record is maintained as the current trust boundary. Later implementation details are folded
into this document rather than leaving the accepted decision as a historical snapshot.

## Decision

Singularity Flow describes the ledger as tamper-evident, not tamper-proof. Each
repository chooses and snapshots one trust tier:

| Tier | Mechanism | Claim |
|---|---|---|
| T0 | Hash chain and source pins | Offline integrity and ordering |
| T1 | T0 plus protected branch and authority-derived ownership | Hosting-platform rewrite resistance |
| T2 | T1 plus signed ledger commits | Publisher identity proof |
| T3 | T2 plus mandatory server validation or authenticated merge receipts | Server-enforced admission |

Governed agents are prompt and tool context. Approval authority is resolved independently from
configured identity groups. An entry records actor, governed agent, authority group, and
identity assurance in separate fields.

`ledger.enforcement: shadow` reports drift. `required` makes unverifiable ledger state
a governance error. T2 and T3 configurations require signed commits. Flow never
claims that CODEOWNERS proves the payload actor or that a branch rule was historically
enabled.

## Consequences

T3 requires organization-specific Git infrastructure and cannot be promised by the
portable package. A deployment without mandatory server validation has an honest
ceiling of T2.
