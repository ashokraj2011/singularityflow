# GDP companion authority review — skill master in workflow bundles — 2026-10-05

Review boundary: `38bf8ed5edffc64b1b253f415736a3f691068746` plus the skill master patch reviewed below. The preceding review is `COMPANION-LOCK-REVIEW-2026-10-05-WORKFLOW-BUNDLE-V4.md`.

One GDP-locked companion changed, `migration-registry`. At the boundary every companion had the digest the preceding review accepted, so nothing is reviewed after the fact. This is not a bulk hash refresh or a new approval authority.

## Reviewed drift

| Companion | Authority change reviewed | Previous digest | Accepted digest |
| --- | --- | --- | --- |
| `migration-registry` | The immutable `workflow-bundle` family moves from schema 4 to 5. Version 5 lets a bundle carry the skill master's skills (`singularity/skill-library/<id>/SKILL.md`) that its agents attach, once each. The one added step, 4 → 5, only sets the version: a historical bundle carried no such skills, so the projection invents none, keeps the stored identity and digest, and the reader still applies the contract of the stored version. | `sha256:b5411b0bd0267af28e8545c3e82dd2ea39d2151d7e3b8a15a74d8dc7c9d45c14` | `sha256:c54dcba9a46bc6386b4abfe7e8d32647354eccd96f8f659675e4f87dd0fcb8e7` |

The change grants no import, overwrite, approval or publication authority. A carried skill is accepted only as a valid SKILL.md whose name is its ID, at its canonical path, and only when a carried agent attaches it; every skill a carried agent attaches must travel with it. Import stays a previewed configuration mutation confirmed by its exact plan, and a same-name skill blocks it until a person keeps theirs, replaces it, or imports it under a new name.

## Validation evidence

The review runs the migration golden catalog, the historical bundle projection test (v1 to v4 project through v5 with their stored identity), the workflow-transfer, workflow-transfer-conflicts and skill-library suites (carried skills, reader refusals, conflict choices and renames), and the GDP contract-freeze test.

## Sanctioned reconciliation procedure

1. Run the GDP companion-lock test and confirm `migration-registry` is the only changed companion.
2. Verify the family stays immutable, its golden catalog lists schema 5, and historical projections keep their stored identity.
3. Run the migration, mig-read, workflow-transfer, workflow-transfer-conflicts, skill-library and GDP contract-freeze tests.
4. Accept only the reviewed digest above; retain `baselineCommit` unchanged.
5. Require another bounded companion review for any later byte change to this companion.
