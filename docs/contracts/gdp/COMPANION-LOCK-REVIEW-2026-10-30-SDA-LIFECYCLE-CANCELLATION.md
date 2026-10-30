# GDP companion authority review — SDA cancellation through the unit of work — 2026-10-30

Review boundary: `b6fd24faef1699db2a6ac87656db5d199f5133a4` (`main` at the start of this change, with SDA M5). The preceding review is `COMPANION-LOCK-REVIEW-2026-10-30-SDA-LOCAL-BACKUP.md`.

SDA §7.3 asks that cancellation propagate to the underlying operation. After M4 the lifecycle authority adapter (`src/sda/story-branch-authority.mjs`) honoured a cancellation only before a transition started. One GDP-locked companion changed: `publication-unit-of-work` (`src/publication-unit-of-work.mjs`). No other locked companion drifted at the boundary. This is a bounded review of where a running transition may stop. It is not a bulk hash refresh, and it adds no approval authority.

## Reviewed in `src/publication-unit-of-work.mjs`

- **`execute` accepts `signal`.** The adapter passes the signal its `publish` was given. No production caller passes one yet, so every existing transition behaves as before.
- **The signal is honoured at stage boundaries up to the push, and no further.**
  - **Once the subject lock is held, before the preimage and journal.** Nothing has been written. The refusal is `SDA_OPERATION_CANCELLED` (class `cancelled`), from the shared `assertNotCancelled`.
  - **Just before `commit-created`.** The check sits inside the existing pre-commit `unwind`. So a cancellation is undone exactly as a failed pre-commit step is, and as `sync` recovers a dead pre-commit transaction: the preimage is restored, the journal cleared, and the subject lock released. The refusal is the same `SDA_OPERATION_CANCELLED`.
  - **After the commit, before `publishing`.** The commit is already the branch's, so rollback stays forbidden. The commit is retained exactly as a push that never started would leave it:
    - the pending marker is written, with `pushOutcome: not-attempted` and `recoveryStage: branch-ref-advanced-before-publication`;
    - the journal is cleared;
    - the refusal is `PUBLICATION_CANCELLED_BEFORE_PUSH`. It carries `publicationRefAdvanced`, `publicationCommit` and `pushOutcome`, so it reads as `retained-locally` and the existing remediation routes it to `sync`.

    This holds in every publishing mode, `warn` included, because the caller asked to stop. A local-only (`mode: off`) transition has no push, so it completes.
  - **Never during or after the push.** Neither the branch push nor the combined branch, ledger and pin push receives the signal. A push in flight runs to its existing deadline, so its outcome is never abandoned half-known.
- **The marker a failed push leaves is unchanged.** Its fields, their order and their values are built by one function, which the cancellation marker shares. The sync command named in the refusal is computed once for both paths.
- **Unchanged:**
  - the authority check and the expected-revision requirement (SDA-AC-025);
  - the subject lock;
  - the publication journal and its preimage;
  - admission and the Candidate;
  - the commit;
  - the atomic branch, ledger and pin push;
  - signing;
  - recovery.
- **Checked by:**
  - `test/sda-lifecycle-conformance.test.mjs`. The subject branch and the in-memory adapter pass the same three cases: cancelled before the commit, cancelled before the push, and cancelled while the push is in flight.
  - Two Git-only tests in the same file. One shows HEAD, the working tree and the journal as they were after a pre-commit cancellation. The other shows `syncPendingLifecyclePublication` publishing the retained commit.

## Accepted digests

| Companion | Reviewed change | Previously accepted | Accepted at this review |
| --- | --- | --- | --- |
| `publication-unit-of-work` | `execute` honours a cancellation signal before `commit-created` (rolled back) and before `publishing` (retained for sync), never during the push; the failed-push marker is built by a shared function, unchanged. | `sha256:00fa6a094b8b278f9e1a881891d9ba5b3f4df018b9be16a3cc084d1c0259b427` | `sha256:04a059bc53149704fa7e2464e505b565bf419787a61c280df994b798da53d6e1` |
