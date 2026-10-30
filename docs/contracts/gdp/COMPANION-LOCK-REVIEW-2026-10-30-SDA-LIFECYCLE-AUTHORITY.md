# GDP companion authority review — SDA lifecycle authority adapter — 2026-10-30

Review boundary: `804e00ee4c7387fc720ca9766988bf9484907bcb` (`main` at the start of this change). The preceding review is `COMPANION-LOCK-REVIEW-2026-10-30-SDA-LEASED-PUSHES.md`.

SDA M4 puts the subject branch behind the lifecycle authority adapter (`src/sda/story-branch-authority.mjs`, ADR 0018 option A). Two GDP-locked companions changed:
- `publication-unit-of-work` (`src/publication-unit-of-work.mjs`);
- `code-assurance-bridge-architecture-contract` (`docs/contracts/cab/architecture-v0.2.json`), whose publication binding named the export M4 removes.

No other locked companion drifted at the boundary. This is a bounded review of how the unit of work reports its refusals, of who may call it, and of where CAB's design contract points for publication. It is not a bulk hash refresh, and it adds no approval authority.

## Reviewed in `src/publication-unit-of-work.mjs`

- **Its one caller is the adapter.**
  - The `publishLifecycleChange` export is removed. The adapter constructs `GitPublicationUnitOfWork` itself, and every workflow family publishes through `lifecycleAuthority(root).publish(...)`.
  - `test/sda-lifecycle-boundary.test.mjs` refuses any other construction in `src/`.
- **A transition held by an earlier retained one now has a code.** The refusal "has a pending publication. Synchronize it before another mutation." carries `PUBLICATION_PENDING`. That is the code `state-planes.mjs` already reports for the same condition.
- **A retained commit whose push failed now carries its outcome class (SDA §7.1).**
  - `OUTCOME_UNKNOWN` when the push outcome is `transport-indeterminate`.
  - `REVISION_CONFLICT` when the remote refused a lease another writer had moved.
  - Neither otherwise.
  - The error also carries `pushOutcome`, beside the existing `publicationRefAdvanced` and `publicationCommit`. Codes, messages, details and the pending record are unchanged.
- **Unchanged:**
  - the authority check and the expected-revision requirement (SDA-AC-025);
  - the subject lock;
  - the publication journal and its preimage;
  - the commit;
  - the atomic branch, ledger and pin push;
  - signing;
  - the pending record and recovery.

## Reviewed in `docs/contracts/cab/architecture-v0.2.json`

- **The `publication` fact still names the same authority**, `lifecycle-publication-unit-of-work`, in the same module, with `cabMayAuthorize: false`.
- **Only its symbol changes:** from the removed `publishLifecycleChange` to `GitPublicationUnitOfWork`, the class that function constructed and that the adapter now constructs.
- **Unchanged:** every other binding, the forbidden parallel authorities, the identity projections and the rollout.

## Accepted digests

| Companion | Reviewed change | Previously accepted | Accepted at this review |
| --- | --- | --- | --- |
| `code-assurance-bridge-architecture-contract` | The publication binding names `GitPublicationUnitOfWork` in place of the removed `publishLifecycleChange`. | `sha256:e71e748f53d7608e545cb19cc2472daf4c91553c4ad3561469df8252d0ad3731` | `sha256:032e0bc4fc6f8318ff80a47f92faa3be113a0961ff13379ab86c08413e6683dc` |
| `publication-unit-of-work` | Called only through the lifecycle authority adapter; a pending refusal is coded `PUBLICATION_PENDING`; a retained push failure carries its outcome class and push outcome. | `sha256:c89fcdd32611be18fcbe57d015c08068717b8b4d7039363d3bc8998b45f7b7e9` | `sha256:00fa6a094b8b278f9e1a881891d9ba5b3f4df018b9be16a3cc084d1c0259b427` |
