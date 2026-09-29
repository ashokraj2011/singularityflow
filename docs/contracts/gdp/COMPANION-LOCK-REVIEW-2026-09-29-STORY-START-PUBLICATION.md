# GDP companion authority review — combined lifecycle publication — 2026-09-29

**Review boundary:** `main@3e161302793e2437115aace8678d38610bed443c`. The change reviewed below is commit `3b683ef3` ("Publish a lifecycle branch, its ledger entry and the pin in one atomic push"). The M0 baseline remains `70db564e59224b03729bab0f9a340807f3086c61`. The previous review is `COMPANION-LOCK-REVIEW-2026-09-29-CONFIGURATION-REVIEWS.md`.

Exactly one GDP-locked companion changed. `publication-unit-of-work` now tries one combined push before its separate branch push and ledger append. This is not a bulk hash refresh or a new approval authority.

| Companion | Authority change reviewed | Previous digest | Accepted digest |
| --- | --- | --- | --- |
| `publication-unit-of-work` | When the ledger is enabled and shares the publication remote, the lifecycle branch, its ledger entry and the entry's pin move in one atomic push (`publishBranchWithLedgerEntry`). The leases are exact: the branch's expected tip (absent for a new Story), the state tip the entry extends, and absent for the pin. A clean per-ref acknowledgement or a verifying observation is required. A refusal publishes the branch alone exactly as before, and its ledger append skips its own atomic attempt. An unverifiable outcome becomes the existing `transport-indeterminate` push result, which pending-publication recovery already reconciles. | `sha256:e7431fb02ab8b74699d34f1c840f38f61b86466a1350164014b91fdc3a93316a` | `sha256:e9f00207cf5a2422787e709d17e0f34fd389a2362cdead1419644e91d148888c` |

No journal stage, recovery record, pending-publication field, lease or refusal changed meaning. The combined push lands exactly the refs the separate pushes landed, under the same or stricter leases, so every existing recovery path still applies to its outcome. Both digests were computed from the file bytes at `7dec827e` and at the boundary, not copied from a failing assertion.

Validation at this boundary: the ledger, publication-fault, Story-start publication, publishing, no-model lifecycle and organisation activation owner tests passed. The GDP companion-lock suite must pass against this exact accepted digest.
