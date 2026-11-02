# GDP companion authority review — SF Guard, convergence adjudications — 2026-11-02

Review boundary: `5959c12fdacc844dc04399e41737195d6c16c496` (`main` at the start of this change, with the specification revision, split and configuration approval seals). The preceding review is `COMPANION-LOCK-REVIEW-2026-11-02-SF-GUARD-RETAINED-REVIEWS.md`.

One GDP-locked companion changes in this change: `migration-registry`. No other companion differs from its accepted digest at this boundary.

## Reviewed in `src/schema-migrations.mjs` (`migration-registry`)

- `convergence-record` goes to v4 (`migration(3, 4, convergenceRecordV3ToV4)`). The three convergence steps now share one function, `resealedConvergence`: it verifies the stored seal, applies the step's fields and re-seals, exactly as the v1 to v2 and v2 to v3 steps did one by one (the same fields, the same error and code). A v4 projection lets a finding's decision keep its approver's presence block (`findings[].decision.presence`) inside the sealed projection, so the hash contract covers it and an integrity check rebuilds every adjudication with it (SPEC-PSS-v1 §10.10). The step verifies the v3 seal before it migrates, as the v1 and v2 steps do, sets `schemaVersion: 4` and re-seals; a v3 projection has no presence block, so nothing else changes and every older projection still replays.
- Every new projection is v4. The block is optional, so where SF Guard does not apply a v4 projection is the v3 projection with a new version number. It cannot stay v3 there: a v3 file is re-sealed as v4 when read, under a new hash, which would no longer match the convergence artifact that names it. An older build reads a v4 projection as a future version (`SCHEMA_VERSION_FUTURE`) and says so.
- Unchanged: every other family, path pattern and immutability flag.

The authority reads as `model: never`. Nothing here lets an agent decide anything: on a Story SF Guard requires, an adjudication counts only while its signature verifies against the approver's pinned key (`countedConvergence`), and nothing changes where SF Guard does not apply.

## Accepted digests

| Companion | Reviewed change | Previously accepted | Accepted at this review |
| --- | --- | --- | --- |
| `migration-registry` | `convergence-record` v4, written only on a Story with an SF Guard pin. | `sha256:76bad0ffb369fa4dea7fbb97c252346e57644d06054ab83136ed81a953f812c8` | `sha256:86d02a68f3ed08ae0448431f3c0f4cccf971459fb4725da014b423c1fd1e5bfe` |
