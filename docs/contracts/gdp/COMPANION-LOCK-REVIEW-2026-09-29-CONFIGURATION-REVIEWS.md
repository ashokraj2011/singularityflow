# GDP companion authority review — configuration-review record family — 2026-09-29

**Review boundary:** `self-repair/final-touch@2edbae2f02a5c4a62168a105ed1f72af1ef6bde6` plus the exact patch reviewed below. The M0 baseline remains `70db564e59224b03729bab0f9a340807f3086c61`. The previous review is `COMPANION-LOCK-REVIEW-2026-09-28-SELF-REPAIR.md`.

Exactly one GDP-locked companion changed. `migration-registry` gains one new version-1 family and no other line. No existing family's version, readable range, migration step or path changed. No migration was added, so no stored record is reinterpreted. This is not a bulk hash refresh or a new approval authority.

| Companion | Authority change reviewed | Previous digest | Accepted digest |
| --- | --- | --- | --- |
| `migration-registry` | Registers `product-configuration-reviews`, the machine-local record of each build's background configuration-review pass (`$local/installations/configuration-reviews.json`): whether it is running, and which review branches it opened. The record is derived and rebuildable; it authorises nothing. | `sha256:0e74b29aefcf954389cda1b993c0110d5201eff0a4a99499495546cccffc5987` | `sha256:9a7053f60e73b4dfe6dfbc587880745fdf489ce376d9900bf80f65fa30fbbac3` |

The family grants no approval and carries no review. The pass it records opens review branches only through the existing review-only configuration refresh, which never pushes `sflow/config`; a person merges each review. Both digests were computed from the file bytes at the boundary and in the patch, not copied from a failing assertion.

Validation at this boundary: the schema-migration goldens cover the new family at version 1. The configuration-review-pass, local-healers, product-requirement and VS Code product-alignment owner tests passed. The GDP companion-lock suite must pass against this exact accepted digest.
