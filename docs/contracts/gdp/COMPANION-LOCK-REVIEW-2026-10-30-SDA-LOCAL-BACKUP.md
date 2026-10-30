# GDP companion authority review — SDA local backup record family — 2026-10-30

Review boundary: `97ad71b413797668bdb3316d04d4fc6e65750727` (`main` at the start of this change). The preceding review is `COMPANION-LOCK-REVIEW-2026-10-30-SDA-LIFECYCLE-AUTHORITY.md`.

SDA M5 adds `backup create|inspect|restore` (`src/local-backup.mjs`). Its manifest is a new durable record family, so it is registered in the migration registry, as §15 of the SDA specification requires. One GDP-locked companion changed:
- `migration-registry` (`src/schema-migrations.mjs`).

No other locked companion drifted at the boundary. This is a bounded review of one added family. It is not a bulk hash refresh, and it adds no approval authority.

## Reviewed in `src/schema-migrations.mjs`

- **One family is added:** `local-backup-manifest`, version 1, with no migration steps.
  - Its readable range is v1 only, like every other family. A manifest a newer build wrote is refused with `SCHEMA_VERSION_FUTURE`, and `backup inspect` and `backup restore` restore nothing from it.
  - Its path pattern, `$backup/manifest.json`, names a directory the person chose outside every checkout of the repository. It never matches a repository, Git-directory or machine-state path, so `familyForStoredPath` resolves no existing record to it.
- **What the record holds:** the backup's ID, its creation time, the random machine ID of the laptop that made it, a digest of the repository's comparison key, the configuration drafts as stored (each with its operation ID and payload digest), the laptop-local documents by Work ID, key, SHA-256 and size, and what the backup does not carry. It holds no path, credential, lock token or session handle.
- **It authorizes nothing.** Restoring a backup saves each draft again through the ordinary draft save and restores a document only where the Story holds that exact record. It never proposes, approves, commits or pushes.
- **Unchanged:** every other family, its versions, migration steps and path patterns; `readRecord`, `stampCurrentRecord` and the registry's validation.

## Accepted digests

| Companion | Reviewed change | Previously accepted | Accepted at this review |
| --- | --- | --- | --- |
| `migration-registry` | Registers `local-backup-manifest` v1 for the SDA M5 backup manifest. | `sha256:42fd772fad7125b5f8bcf5173011dc7916c0211a51d6414ccfd7f28c5d2b85ab` | `sha256:a8ec48d5f731946f0bbb06689e1b3c57a3a8e55364a67a83979c1b73f4df65c8` |
