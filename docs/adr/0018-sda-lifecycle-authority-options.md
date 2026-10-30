# ADR 0018 — SDA Phase B: where lifecycle authority lives

- **Status:** Accepted, option A (2026-10-30). The Story branch stays lifecycle authority.
- **Date:** 2026-10-29 (proposed); 2026-10-30 (accepted)
- **Baseline:** `main@c6a65e33b`
- **Decision owner:** Singularity Flow repository maintainers

## Context

SDA (`docs/SPEC-SDA-STORAGE-INDEPENDENT-WORKFLOW-v1.md` §6) separates read-path work (Phase A, M0–M2,
no authority change) from the question this record holds open: whether lifecycle authority moves off
the Story branch.

Today, per `docs/GIT-BRANCH-STORAGE.md`:

- The Story's `<WORK-ID>` branch owns its lifecycle state, and that state shares history with the
  Story's source commits.
- The configured `state` branch (the ledger) is "a proof and projection plane; it does not authorize
  lifecycle mutations".
- `sflow/config` is the configuration authority, a separate namespace.

Mechanisms any option must preserve:

- `publishBranchWithLedgerEntry` (`src/ledger.mjs`) advances the Story branch, its ledger entry and
  its pin in one `--atomic` push under exact leases.
- Publication recovery runs through the publication journal and pending-publication records. Pending
  pushes live in the transport outbox, whose `outcome-unknown` records are reconciled by an exact
  remote match.
- Ledger trust tiers T2 and T3 require commit signing (`src/ledger-config.mjs`).
- Stories without a workflow snapshot run as `legacy-live` with an unproven closure
  (`src/story-execution-context.mjs`).
- Takeover (`session takeover`) fetches the Story branch, because the configuration closure travels
  on it.
- The writer fence is `product.yml` `minimumBuild`, read from approved configuration
  (`src/product-requirement.mjs`).
- Session discovery already reads the ledger, not application branches. With the ledger disabled,
  remote discovery refuses. The seeded template enables the ledger; the code default is off.

The SDA M0 inventory (`benchmarks/sda/inventory.json`) classifies 128 modules as shared state, with
711 Git call sites among them: 194 write and 94 remote. That is the surface a change of authority
would touch.

## Options

### A. Keep the Story branch as lifecycle authority

Phase A's read index serves advisory reads, and writes stay as they are.

- **For:** no migration, and no change to signing, takeover, recovery or the atomic push. Every
  existing Story keeps its exact meaning.
- **Against:** source history and lifecycle history stay coupled. Lifecycle writes stay Git commits on
  the source branch, and a source-control replacement would still need lifecycle state from it.

### B. Promote the ledger to lifecycle authority

The ledger already moves atomically with the branch and pin.

- **For:** lifecycle state gets a namespace separate from source while staying in Git. Discovery
  already reads it.
- **Against:**
  - The meaning of "proof and projection" changes.
  - Every in-flight Story needs a migration at a stable boundary.
  - Old clients must be fenced through `minimumBuild`.
  - A repository with the ledger disabled has no lifecycle authority unless enabling it becomes a
    prerequisite.
  - Ledger idempotency is payload-blind today (SDA §7.2 item 1). It must be fixed first.

### C. A service-backed lifecycle authority

Authenticated, conditional transactions in a hosted service (SDA Stage 5).

- **For:** the end state SDA describes, with storage replaceable by design.
- **Against:** a new operational system, identity provider, availability and disaster-recovery story,
  and audit export. Out of v1 scope; it needs its own specification.

## Criteria for the decision

1. Whether Phase A's read index removes enough of the cost users feel. The M0 baseline is the
   reference, and the M2 result will show what remains. If what remains is in writes, takeover or
   source-history size, B gains weight; if it is not, A holds.
2. The share of in-flight and `legacy-live` Stories a migration would touch.
3. Whether every supported repository can run with the ledger enabled.
4. The signing and trust-tier story under each option.
5. What an old client does after cutover, demonstrated with the `minimumBuild` fence.

## Decision

**Option A.** The maintainers chose it on 2026-10-30, after SDA M2. The Story's `<WORK-ID>` branch
remains lifecycle authority, and the `state` ledger remains proof and projection.

Against the criteria:

1. **Read cost.** M2 (`benchmarks/sda/m2-read-index.md`) serves the Story list and the intake
   catalog from verified local records, with no Git process and no network when they are past their
   interval or the remote is unreachable.
   - What remains is two local Git reads in `nextsteps` and the snapshot's `git status`. None of it is
     in writes, takeover or source-history size, the costs that would have argued for B.
   - The measurements are macOS only; Windows remains open in Phase A.
2. **Migration.** None. No in-flight or `legacy-live` Story is touched.
3. **Ledger prerequisite.** None. A repository with the ledger disabled keeps its lifecycle authority.
4. **Signing and trust tiers.** Unchanged.
5. **Old clients.** There is no cutover, so no `minimumBuild` fence is needed.

## Consequences

- **The lifecycle write path is unchanged:**
  - `publishBranchWithLedgerEntry`'s atomic push of branch, ledger entry and pin under exact leases;
  - the publication journal;
  - the transport outbox;
  - signing;
  - takeover's fetch of the Story branch.
- **SDA Stage 3 (M3) may start.** Its deliverables change no authority: transactional drafts, typed
  configuration intent, lazy workspace cloning and lease-proven lock recovery.
- **M4 is narrowed.** "Lifecycle persistence behind adapters" puts the existing Story-branch
  authority behind the lifecycle authority adapter. No new namespace is introduced. The Git adapter
  that M1's conformance harness runs is that production adapter.
- **SDA-AC-019 does not apply.** It covers authority migration and writer fencing, and there is no
  migration.
- **Source history and lifecycle history stay coupled.** This is option A's accepted cost: replacing
  source control would still need lifecycle state from it.
- **Revisiting the decision.** A move to B or C needs a new record that supersedes this one, with
  measurements showing that the remaining cost is in writes, takeover or source-history size. Option
  C needs its own specification (SDA Stage 5).
