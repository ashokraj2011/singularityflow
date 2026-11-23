# ADR 0019 — A Story's state lives off its code branch; its documents join the code base

- **Status:** Proposed (2026-11-23). It supersedes [ADR 0018](0018-sda-lifecycle-authority-options.md) once accepted.
- **Date:** 2026-11-23
- **Baseline:** `main@99b0b01f8`
- **Decision owner:** Singularity Flow repository maintainers
- **Spec:** [SSB-v1](../SPEC-SSB-STORY-STATE-BRANCH-v1.md)

## Context

ADR 0018 (accepted 2026-10-30) kept option A: the Story's `<WORK-ID>` branch owns its lifecycle state, beside its code.
So every Story branch, every pull request and, after a merge, the default branch carry SFlow's records:
- `singularity/work-items/<WORK-ID>/**`;
- the pinned configuration copy;
- `singularity/configuration-source.json`.

Every approval, decision and receipt is also a commit on the code branch.

The owner, 2026-11-23:
- "Lets not store all singularity things in the branch, Why cant it be in state branch?"
- Asked what drives it: "yes mostly for clean PRs".
- Then the decision: "documents will be in the PR and it should be part of the code base. The workflow, .singularity
  and all can be in state".

## Decision

1. **The Story's code branch holds code and the step documents.** Each step's document (requirements, design, plan,
   the code summary, verification evidence, the release report) is written under the code base's documents folder,
   `docs/stories/<WORK-ID>/` by default. It is reviewed in the pull request and merged with the code.
2. **Everything else SFlow keeps for a Story lives on that Story's own state ref**, `refs/singularity/state/<WORK-ID>`
   (the branch `sflow/state/<WORK-ID>` on a host that refuses SFlow's own refs):
   - `workflow.json`, the lifecycle authority;
   - approvals, decisions, receipts, reviews, clarifications, context and telemetry;
   - the pinned configuration copy and its binding.

   It has no application history and is one per Story, so Stories never contend for one ref. Not being a branch, it
   shows in no branch list and starts no CI. The ledger's `state` branch stays the shared proof and index plane, as
   today.
3. **A step lands whole or not at all.** The Story branch, its state ref, the ledger entry and its pin advance in one
   atomic push under exact leases, the same mechanism `publishBranchWithLedgerEntry` uses today with one more ref.
4. **Every state record names the exact code commit it is about**, so an approval still binds the code it approved.
5. **New Stories only.** A Story started before this ships finishes on today's layout; nothing is migrated.
6. **Option A remains the reading of a Story without a state ref**, so both layouts are read for as long as an old
   Story exists.

## Options considered

- **A, keep today's layout (ADR 0018):** records on the code branch. Rejected by the owner for clean pull requests and a
  clean code base.
- **A with a code-only pull request branch ([CPR-v1](../SPEC-CPR-CLEAN-PULL-REQUESTS-v1.md)):** clean pull requests in
  about two days, but the Story branch keeps its records and its bookkeeping commits during the work. Kept as the
  fallback if this decision is not built.
- **B with one shared `state` branch:** every Story and every developer would push the same ref at every step.
  Rejected for contention.
- **B with a state ref per Story (chosen):** isolated per Story, and an atomic push of two refs on one remote.

## Consequences

- Pull requests and the default branch hold code and documents only, with no SFlow bookkeeping. The Story branch gets a
  commit only when code or a document changes, so CI no longer runs for an approval or a decision.
- SFlow reads and writes a Story's state in a second checkout at `.singularity/`, inside the Story's checkout but
  ignored by Git (`.git/info/exclude`), so agents read it as workspace files and nothing commits it.
- Every surface that finds a Story's files changes: the engine, VS Code, the Copilot hooks and the tests. A path
  resolver (spec M1) makes that one change, not 180.
- A teammate who checks out only the Story branch sees code and documents. SFlow fetches the state ref when it opens
  the Story, as it fetches the Story branch today.
- Retention: the state ref is never merged, so a host never deletes it. The ledger's pins keep the code commits alive
  after a host deletes a merged Story branch, as today.
