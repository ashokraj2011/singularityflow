# GDP companion authority review — workflow bundle — 2026-09-22

**Review boundary:** `main@dca87c409b4901199c92703d42737270300d4a72`

**M0 baseline retained:** `70db564e59224b03729bab0f9a340807f3086c61`

This review reconciles one exact companion authority changed by the portable workflow-bundle
feature. The M0 baseline commit is intentionally unchanged: it identifies the original GDP contract
decision, while the companion digest identifies the currently reviewed migration authority bytes.
This is not a bulk hash refresh.

## Reviewed drift

| Companion | Authority change reviewed | Previous digest | Accepted digest |
| --- | --- | --- | --- |
| `migration-registry` | Registers the closed, immutable `workflow-bundle` schema-v1 family so exported workflow dependency closures remain readable and future versions fail closed. | `sha256:37b9b4b2d9c9527fbd384dd46f8bd9f8b284ca559f675cca3ae595d6faaee338` | `sha256:f5bc636a3191eb67bf786cf5260ded5b0d664cb6dc9b1eeddcd0e2a8bc8b8652` |

The registration grants no workflow execution, approval, publication, import, or overwrite authority.
It only lets the common migration boundary identify and validate the portable bundle record family.
Import and copy remain separate previewed configuration mutations with exact plan confirmation;
unknown schemas, changed digests, path escapes, dependency conflicts, and existing target IDs fail
before repository mutation.

## Validation evidence

The review validates the migration golden catalog, GDP companion lock, command registry, portable
bundle round trip and tamper rejection, and the governed proposal boundary. The bundle remains a
configuration transport artifact rather than a GDP proof, delivery mode, or runtime authority.

## Sanctioned reconciliation procedure

1. Run the GDP companion-lock test and confirm `migration-registry` is the only changed companion.
2. Verify the new family is frozen and immutable and that its golden catalog entry matches schema v1.
3. Run migration, workflow-transfer, command-registry, and GDP contract-freeze tests.
4. Accept only the reviewed digest above; retain `baselineCommit` unchanged.
5. Require another bounded companion review for any later migration-registry byte change.
