# GDP companion authority review — team import sessions — 2026-10-14

Review boundary: `fa62ca486832e84b5b12279d87af105af55edc4d` (`main` at the start of this change). The preceding review is `COMPANION-LOCK-REVIEW-2026-10-13-WORKFLOW-BUNDLE-V9.md`.

One GDP-locked companion changed: `migration-registry` (`src/schema-migrations.mjs`). No other locked companion drifted at the boundary. This is a bounded review of two new record families. It is not a bulk hash refresh, and it adds no approval authority.

## Reviewed in `src/schema-migrations.mjs`

- Two families are registered at version 1 with no migrations, for `workflow import-team` (`src/team-import/`):
  - `team-import-session`: the machine-local conversion session, `$local/team-imports/tis_<16 hex>/session.json`. It holds the capture manifest, the selected entry, the issued candidate path, recorded answers and compile results, and an integrity digest that `readTeamImportSession` checks.
  - `team-import-candidate`: the one file the model writes into that session, `$local/team-imports/tis_<16 hex>/candidate.json`. `validateCandidate` closes it: fixed fields, namespaced IDs, and evidence spans checked against the capture.
- Neither record ever enters a repository, a Story snapshot or a bundle. The bundle a conversion writes is an ordinary `workflow-bundle` v9, built by the shared compiler.
- Both families read as `model: never`. Writers stamp `currentSchemaVersion`, and the golden fixture carries one v1 record for each.
- Who approves anything is unchanged. A conversion never imports, activates or approves configuration. Its output goes through `workflow import` and its review like any other bundle.

## Accepted digests

| Companion | Reviewed change | Previously accepted | Accepted at this review |
| --- | --- | --- | --- |
| `migration-registry` | `team-import-session` and `team-import-candidate` v1 families. | `sha256:2831e1cec66227b350858e6efb3269f1fd7e18b3c4f4fe94390bc26059fe47cf` | `sha256:00321fc2cd686da3e36dc7b2fb4902dda6d64e10929aa2245e116d7a950b0dfc` |
