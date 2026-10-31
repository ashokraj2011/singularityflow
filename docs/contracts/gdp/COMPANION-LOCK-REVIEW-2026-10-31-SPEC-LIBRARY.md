# GDP companion authority review — specification library — 2026-10-31

Review boundary: `a1aebf12566153877cdd51ea6cb2a93b9d3c637c` (`main` at the start of this change). The preceding review is `COMPANION-LOCK-REVIEW-2026-10-31-SWEEP-PUBLICATION-OUTCOMES.md`.

One GDP-locked companion changes in this change: `migration-registry`. No other companion differs from its accepted digest at this boundary.

## Reviewed in `src/schema-migrations.mjs` (`migration-registry`)

- New: five record families of the specification library (SPEC-SPA v1.3 S1, `src/spec-library/`), each version 1 with no migrations:
  - `spec-draft` at `$git/spec-drafts/<SPEC-ID>/<NNNNNN>.json`: one immutable snapshot of a specification draft on this clone. Writers stamp `currentSchemaVersion`; `readDraft` checks each snapshot against its own `snapshotSha256` and takes the highest-numbered snapshot that verifies as the head. A snapshot a newer build wrote is refused with `SCHEMA_VERSION_FUTURE`, never treated as damaged. It never enters a repository.
  - `spec-manifest`, `spec-gap-ledger`, `spec-research` and `spec-quality` at `singularity/specifications/<SPEC-ID>/<NNNNNN>/{manifest,gaps,research,quality}.json` on the configured state branch, all `immutable`. They are published together in one commit through `publishToStateBranch`, with the manifest path as an `absent` precondition and the exact SHA-256 of every file; readers verify every file against the manifest's digests and refuse a revision whole when one does not match.
- Changed: `local-backup-manifest` goes from version 1 to 2. Version 2 also carries each specification draft's head snapshot (`specDrafts`). The one migration, `localBackupManifestV1ToV2`, adds `specDrafts: []`: a version 1 backup carried no specification drafts. It is deterministic and copies every other field unchanged.
- The golden fixture carries one record per new family and the version 1 to 2 backup manifest migration.

Every new family reads as `model: never`. Nothing here changes who approves anything: a specification revision is advisory, publishing it approves nothing, and deciding a gap, settling the checklist, publishing and discarding are the person's own steps (`OWN_TERMINAL_STEPS`, `spec-library-decision`).

## Accepted digests

| Companion | Reviewed change | Previously accepted | Accepted at this review |
| --- | --- | --- | --- |
| `migration-registry` | Five `spec-*` families; `local-backup-manifest` v2 with its migration. | `sha256:a8ec48d5f731946f0bbb06689e1b3c57a3a8e55364a67a83979c1b73f4df65c8` | `sha256:1bdb6909d60409b76ff6d7fa9454ba06925f3e3d89f4d149181f5904b0a88fb6` |
