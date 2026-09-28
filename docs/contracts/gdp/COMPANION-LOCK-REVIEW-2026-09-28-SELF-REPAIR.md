# GDP companion authority review — self-repair record families — 2026-09-28

**Review boundary:** `main@45ddadb3a288eabc2677bf7ce4d94abadb5c1ce3` plus the exact self-repair patch reviewed below. The M0 baseline remains `70db564e59224b03729bab0f9a340807f3086c61`.

Exactly one GDP-locked companion changed. `migration-registry` gains three new version-1 families and no other line. No existing family's version, readable range, migration step or path changed. No migration was added, so no stored record is reinterpreted. This is not a bulk hash refresh or a new approval authority.

| Companion | Authority change reviewed | Previous digest | Accepted digest |
| --- | --- | --- | --- |
| `migration-registry` | Registers three families. `product-alignment` is the machine-local record of each build's first-run pass (`$local/installations/alignment-current.json`). `product-requirement` is the optional reviewed `singularity/product.yml` naming a repository's minimum build, its signed release source and the artifact-builder key that must have signed it. `product-requirement-checks` is the machine-local record of the last requirement verdict per repository (`$local/installations/requirement-checks.json`). The two machine-local records are derived and rebuildable. The requirement file is honoured only when read from an approved configuration authority. | `sha256:527e182feaa3415f5de395deaa1ab938b527837deae27e0c1c7f95912fdc12e3` | `sha256:0e74b29aefcf954389cda1b993c0110d5201eff0a4a99499495546cccffc5987` |

The new families grant no approval and carry no review: the requirement file changes only through the ordinary approved-configuration review, and product installation keeps the distribution installer's signature verification, rollback bytes and compensating restore. Both digests were computed from the file bytes at `main` and in the patch, not copied from a failing assertion.

Validation at this boundary: schema-migration goldens cover every new family at version 1. The product-alignment, product-requirement, upgrade-contract and distribution-install owner tests passed. The GDP companion-lock suite must pass against these exact accepted digests.
