# GDP companion authority review — workflow bundle v8 — 2026-10-10

Review boundary: `616d5eed7782effebb70ef00904123c078f5abae`. The preceding review is `COMPANION-LOCK-REVIEW-2026-10-10-REGISTERED-WORLD-MODEL-REMOVED.md`.

One GDP-locked companion changed, `migration-registry`. `main` already carried an unreviewed change to it, so the lock failed on `main`: `14fc0cd1` ("feat: add first-class reusable instructions referenced by skills") edited `src/schema-migrations.mjs` without a companion review. The previously accepted digest is the file as of `80f7d89c`. This review covers that change after the fact. It is not a bulk hash refresh or a new approval authority.

## Reviewed after the fact in `src/schema-migrations.mjs`

- The immutable `workflow-bundle` family moves from schema 7 to 8. Version 8 lets a bundle carry `instruction` assets: the exact definitions of the reusable instructions its skills reference, each at its canonical path and validated with the instruction parser. The bundle reader refuses a v8 bundle that references an instruction it does not carry (`WORKFLOW_BUNDLE_DEPENDENCY_MISSING`) or carries one that no skill references (`WORKFLOW_BUNDLE_DEPENDENCY_EXTRA`), and refuses instruction references in a bundle older than v8.
- The one added step, 7 → 8, changes only `schemaVersion`. A historical bundle carried no instructions, so the projection invents none, keeps the stored identity and digest, and the reader still applies the contract of the stored version.
- No other family, migration step, path or classification changes.

## Accepted digests

| Companion | Reviewed change | Previously accepted | Accepted at this review |
| --- | --- | --- | --- |
| `migration-registry` | `workflow-bundle` schema 7 → 8 (instruction assets); the 7 → 8 step only sets `schemaVersion: 8`. | `sha256:0e6df671b05046e9c08e57ce958e4dc57935318546bec3a0e013e02b16bb206b` | `sha256:775b67f5211646883259a7b2773ca7c4fe81e5d7d712149bbfd8ba5e2e86f8a6` |
