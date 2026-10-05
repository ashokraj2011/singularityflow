# GDP companion authority review — workflow bundle v4 — 2026-10-05

Review boundary: `d1dd5cc87a9d41316971bb03fbaa4298dfff1e54` plus the workflow-bundle v4 patch reviewed below. The preceding review is `COMPANION-LOCK-REVIEW-2026-10-04-STEP-ACTION-RECEIPTS.md`.

One GDP-locked companion changed, `migration-registry`. At the boundary its bytes still had the digest the preceding review accepted, so nothing is reviewed after the fact. This is not a bulk hash refresh or a new approval authority.

## Reviewed drift

| Companion | Authority change reviewed | Previous digest | Accepted digest |
| --- | --- | --- | --- |
| `migration-registry` | The immutable `workflow-bundle` family moves from schema 3 to 4. Version 4 adds `imports`, the records of where a bundle's imported files came from, and lets a bundle carry the exact bytes of the imported (vendored) skills and templates its agents' locks name and of its MCP servers' imported descriptors. The one added step, 3 → 4, sets `imports: {}`: a historical bundle carried no imported copies, so the projection invents none, keeps the stored identity and digest, and the reader still applies the contract of the stored version. | `sha256:a0fece4e4a1073d537ab4a5647980edb51e2e7258022c5c6a9dfef0a044d433e` | `sha256:b5411b0bd0267af28e8545c3e82dd2ea39d2151d7e3b8a15a74d8dc7c9d45c14` |

The change grants no import, overwrite, approval or publication authority. A carried copy is accepted only when it matches the hash its lock pins, belongs to an agent or MCP server the bundle carries, and lives under `singularity/imports/`; a record must describe a file the bundle carries, or a generated artifact of an agent it carries. Import stays a previewed configuration mutation confirmed by its exact plan: a same-name conflict blocks it until a person chooses keep, replace or a new name, and those choices are bound into the plan digest.

## Validation evidence

The review runs the migration golden catalog, the historical bundle projection test (v1 and v2 now project through v4 with `imports: {}` and their stored identity), the workflow-transfer and workflow-transfer-conflicts suites (vendored copies, record validation, reader refusals, conflict choices), the skill-package transport suite, and the GDP contract-freeze test.

## Sanctioned reconciliation procedure

1. Run the GDP companion-lock test and confirm `migration-registry` is the only changed companion.
2. Verify the family stays immutable, its golden catalog lists schema 4 with `imports: {}`, and historical projections keep their stored identity.
3. Run the migration, mig-read, workflow-transfer, workflow-transfer-conflicts, skp-transport and GDP contract-freeze tests.
4. Accept only the reviewed digest above; retain `baselineCommit` unchanged.
5. Require another bounded companion review for any later migration-registry byte change.
