# GDP companion authority review — specification usage records — 2026-11-01

Review boundary: `c15830837912a4726549d27c391b0abde31e6d79` (`main` at the start of this change). The preceding review is `COMPANION-LOCK-REVIEW-2026-10-31-SPEC-LIBRARY.md`.

One GDP-locked companion changes in this change: `migration-registry`. No other companion differs from its accepted digest at this boundary.

## Reviewed in `src/schema-migrations.mjs` (`migration-registry`)

- New: one record family of the specification library (SPEC-SPA v1.3 S2, `src/spec-library/usage.mjs`), version 1 with no migrations:
  - `spec-usage` at `singularity/specifications/<SPEC-ID>/usage/<WORK-ID>/{<NNNNNN>,delivered}.json` on the configured state branch, `immutable`. A Story's claim on the clauses of its attached slice, one record per approved generation of its first step, and its delivery once it is closed. Each record is built only from the Story's committed state, so a repair writes the same bytes. It is published through `publishToStateBranch` with an `absent` precondition and its exact SHA-256; a record already there with other bytes is reported and never overwritten.
- The golden fixture carries one `spec-usage` record.

The family reads as `model: never`. Nothing here changes who approves anything: a usage record is written after the approval has landed, never inside it, and a failed write never holds the Story.

## Accepted digests

| Companion | Reviewed change | Previously accepted | Accepted at this review |
| --- | --- | --- | --- |
| `migration-registry` | The `spec-usage` family. | `sha256:1bdb6909d60409b76ff6d7fa9454ba06925f3e3d89f4d149181f5904b0a88fb6` | `sha256:81d0f9c4f8308e84308674356f6e7b55f59c1423a814575e395aa394ffdbdee8` |
