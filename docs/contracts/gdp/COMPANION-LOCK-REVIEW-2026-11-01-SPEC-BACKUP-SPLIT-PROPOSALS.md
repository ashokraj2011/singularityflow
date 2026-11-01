# GDP companion authority review — split proposals in local backups — 2026-11-01

Review boundary: `af14ddc81538864f29400d4ba65c5cd0c0c53816` (`main` at the start of this change, with the Spec Studio's S5). The preceding review is `COMPANION-LOCK-REVIEW-2026-11-01-SPEC-SPLIT.md`.

One GDP-locked companion changes in this change: `migration-registry`. No other companion differs from its accepted digest at this boundary.

## Reviewed in `src/schema-migrations.mjs` (`migration-registry`)

- Changed: `local-backup-manifest` goes from version 2 to 3. Version 3 also carries each specification split proposal on the clone (`splitProposals`, the whole `spec-split-proposal` record as its file holds it), because a proposal exists only on the clone that proposed it until it is published. The new migration, `localBackupManifestV2ToV3`, adds `splitProposals: []`: a version 2 backup carried no split proposals. It is deterministic and copies every other field unchanged. A version 1 backup reads through both steps.
- Unchanged: the `spec-split-proposal` family itself (version 1). Restore writes a backed-up record create-only at its own path, so a proposal staged on this clone in the meantime is never replaced, and a clone holding a different plan for the same revision keeps its own, as a backed-up specification draft is restored.
- The golden fixture carries a frozen version 3 backup manifest beside the version 1 and 2 records. The backup tests' newer-build fixture is now one past the current version, so it still refuses with `SCHEMA_VERSION_FUTURE`.

The family reads as `model: never`. Nothing here changes who approves anything: a backup and its restore propose, approve, commit and push nothing, and publishing a split stays the person's own step.

## Accepted digests

| Companion | Reviewed change | Previously accepted | Accepted at this review |
| --- | --- | --- | --- |
| `migration-registry` | `local-backup-manifest` v3 with its migration. | `sha256:ad66567c8a508131271edcbd3088443857fe2b4881133e4b9dd7a4d274b709c0` | `sha256:0276ce08aa0558f2a76721e77b8335354226f165529c89a06364be95e61ccbe9` |
