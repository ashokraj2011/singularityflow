# GDP companion authority review — sweep batch 3, publication outcomes — 2026-10-31

Review boundary: `fc7b10482abf34371f91bcc4fb3d3cc84b721566` (`main` at the start of this change, with sweep batches 1 and 2). The preceding review is `COMPANION-LOCK-REVIEW-2026-10-30-SDA-LIFECYCLE-CANCELLATION.md`.

The SDA sweep found refusals from the publication unit of work that named the wrong next step or none. One GDP-locked companion changed: `publication-unit-of-work` (`src/publication-unit-of-work.mjs`). No other locked companion drifted at the boundary. This is a bounded review of the words and routes two refusals carry. It is not a bulk hash refresh, and it adds no approval authority.

## Reviewed in `src/publication-unit-of-work.mjs`

- **`PUBLICATION_PENDING` names its subject's sync (sweep E10).** The refusal a transition meets when its subject already has a retained commit carried no details. In an approval turn its plan pointed at reject. It now carries `details.subject` and `details.nextAction`: the subject's own sync from `subjectSyncCommand` (`sync <ID>`, `initiative sync <ID>`, `goal sync <ID>`, `adhoc sync <ID>`). The check, its position (after the subject lock, before any write) and its code are unchanged.
- **The sync a retained commit names comes from the same function.** Story and Initiative keep the commands they had. A Goal or ad hoc session now names its own sync instead of "the appropriate sync command". This covers the refusal after a failed push and the cancellation before the push.
- **A lost race leads with the set-aside preview (sweep B2).** The class was already computed: `REVISION_CONFLICT` when Git refused the lease because the remote moved (`non-fast-forward`, `fetch first`, `stale info`). The message still said "Run sync after fixing remote access", but sync sends the same commit under the same lease and can never land it. For a Story or Initiative the message now says another clone published first and names `<sync> --set-aside`, the preview. `details.nextAction` is that preview. Every other failed push keeps its message and its sync route.
- **Unchanged:**
  - the authority check and the expected-revision requirement (SDA-AC-025);
  - the subject lock, the journal and its preimage;
  - admission and the Candidate;
  - the commit and the atomic branch, ledger and pin push;
  - the retained marker's fields and outcome, including `pushOutcome` and `OUTCOME_UNKNOWN` / `REVISION_CONFLICT`;
  - cancellation;
  - recovery.
- **Checked by:**
  - `test/publication-faults.test.mjs`, "a lost race names its set-aside preview, and the pending publication after it names its sync". It runs for a Story and an Initiative: a real leased push loses to another clone, then the next transition meets the pending publication.
  - `test/refusal-remediation.test.mjs`. Each retained commit's plan names its own subject's route, the set-aside after a lost race, and sync first in an approval turn.

## Accepted digests

| Companion | Reviewed change | Previously accepted | Accepted at this review |
| --- | --- | --- | --- |
| `publication-unit-of-work` | `PUBLICATION_PENDING` names its subject's sync; every retained commit names its own subject's sync; a lost race (`REVISION_CONFLICT`) names the set-aside preview instead of "fix remote access". | `sha256:04a059bc53149704fa7e2464e505b565bf419787a61c280df994b798da53d6e1` | `sha256:6cc1ff7c45e3b1d332a0186dc8e915426306f2c39a83999a3b13d03247594493` |
