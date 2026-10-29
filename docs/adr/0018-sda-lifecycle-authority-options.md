# ADR 0018 — SDA Phase B: where lifecycle authority lives

- **Status:** Proposed. The options are recorded; the decision is open and gates SDA Stage 3 onward.
- **Date:** 2026-10-29
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

Open. Until it is made:

- **Phase A proceeds under option A.** That is SDA's stated position: M0–M2 change no authority.
- **M1's ledger idempotency fix lands regardless of the choice.** B needs it, and A benefits from it.
- **Stage 3 (M3) does not start until this record is accepted with a chosen option.**

## Consequences

- No lifecycle write path changes before this record is accepted.
- The SDA M2 report will carry the measurements criterion 1 asks for.
