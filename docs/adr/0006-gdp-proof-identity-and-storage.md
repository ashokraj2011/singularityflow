# ADR 0006: GDP proof identity, storage planes, and retention

- Status: accepted for contract implementation; durable writers not authorized
- Date: 2026-09-04
- Baseline: `main@70db564e`
- Decision owner: Singularity Flow repository maintainers

## Context

The source proposal's Predicate Result and Proof Summary examples reference the Change Passport
hash while the Passport embeds their hashes. No deterministic writer can construct that cycle.
The proposal also names 34 new families without assigning paths, authority planes, or retention.

## Decision

GDP introduces a stable Proof Subject made from the exact Candidate, Completion Contract, Effect
Policy, Proof Policy/Profile, and explicit WMM baseline/delta availability. Predicate Results,
Signals, Gaps, invalidations, and Proof Summaries bind this subject. A Change Passport references the
subject and latest summary, but proof records never reference the current Passport.

Logical storage is separated into:

- immutable subject content on the governed work branch;
- append-only evidence on the governed work branch but outside the application Candidate manifest;
- authorized decisions on the governed work branch;
- machine-local operational journals in the Git common directory;
- disposable local projections and caches.

The state branch may contain a derived discovery index or release gap snapshot. It is not a second
source for Story truth. WMB remains the owner of reusable state-branch World Model data.

Semantic hashes exclude operational clocks, duration, process/host identity, checkout paths, cache
keys, and transport state. Operational receipts may retain bounded versions of those fields while
referencing the deterministic result.

Content required to verify a published Passport is retained. Expiry initiates a governed retention
decision and never silently deletes a verification pin. Operational/cache cleanup is allowed only
after reference and recovery checks.

## Consequences

New evidence can be attached without changing application Candidate identity, while the Proof
Subject still names the exact Candidate it evaluates. Appending evidence produces a new summary and
Passport revision. M0 schemas are design artifacts and remain absent from MIG until their delivery
milestone provides migration, path, concurrency, recovery, and package evidence.
