# GDP companion authority review — SDA leased governed pushes — 2026-10-30

Review boundary: `fa3094b83c6c1ec2308d0b6516dd8bc6dec16ab5` (`main` at the start of this change). The preceding review is `COMPANION-LOCK-REVIEW-2026-10-29-APPROVER-REFRESH-RECORDS.md`.

Two GDP-locked companions changed in SDA M1 (`fa3094b83`), which landed without this review: `candidate-custody` (`src/auto/auto-candidate.mjs`) and `publication-unit-of-work` (`src/publication-unit-of-work.mjs`). No other locked companion drifted at the boundary. This is a bounded review of SDA-AC-025 ("every governed push passes an expected revision"). It is not a bulk hash refresh, and it adds no approval authority.

## Reviewed in `src/auto/auto-candidate.mjs`

- The two pushes of immutable refs are now create-only:
  - the recovery journal ref;
  - the Candidate's retained ref.
- Each uses `--force-with-lease=<ref>:`. Each was already probed absent first.
- What changes: a concurrent writer that created the same ref with another commit now refuses the push, where before it was fast-forwarded.
- Unchanged: what a Candidate holds, who may create one, and how custody is proven.

## Reviewed in `src/publication-unit-of-work.mjs`

- **Every publishing mode now names the remote revision it replaces.**
  - The unit of work passes `expectedRemoteSha`, which is `null` to create.
  - Or it states an `unleased` reason, which it forwards to the branch push helper.
  - Otherwise it refuses with `PUSH_EXPECTED_REVISION_REQUIRED` before anything is written.
- **Every production caller already named a revision.** No source states an `unleased` reason for the unit of work; `test/governed-push-lease.test.mjs` lists every stated reason.
- **Unchanged:** the authority check, the publication journal, the atomic branch, ledger and pin push, and recovery.

## Accepted digests

| Companion | Reviewed change | Previously accepted | Accepted at this review |
| --- | --- | --- | --- |
| `candidate-custody` | Create-only leases on the recovery journal and retained Candidate refs. | `sha256:03b1245b4a315a452c1d8e3c339214af53fd815011ab4299673a5f47ce210f5d` | `sha256:262e2465b186372c381224b2f3eb568cefa00968d41a3cccf6fd6a8a1f7d1161` |
| `publication-unit-of-work` | A publishing mode names its expected remote revision or states why not (SDA-AC-025). | `sha256:bbff2a3a9cc255c7c697fa45862e1be57bf92e74bb6a3944813e61e6f32ce807` | `sha256:c89fcdd32611be18fcbe57d015c08068717b8b4d7039363d3bc8998b45f7b7e9` |
