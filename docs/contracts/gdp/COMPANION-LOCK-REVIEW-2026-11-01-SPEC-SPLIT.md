# GDP companion authority review — specification splits — 2026-11-01

Review boundary: `f840dc33c78e9bb8659476f9c2916edbfb60b717` (`main` at the start of this change, with the Spec Studio's S2 to S4). The preceding review is `COMPANION-LOCK-REVIEW-2026-11-01-SPEC-USAGE.md`.

One GDP-locked companion changes in this change: `migration-registry`. No other companion differs from its accepted digest at this boundary.

## Reviewed in `src/schema-migrations.mjs` (`migration-registry`)

- New: two record families of the specification library (SPEC-SPA v1.3 S5, `src/spec-library/split.mjs`), each version 1 with no migrations:
  - `spec-split` at `singularity/specifications/<SPEC-ID>/splits/<NNNNNN>/split.json` on the configured state branch, `immutable`. One published split of a reviewed revision: the parent revision and its manifest digest, the child specifications with the parent clauses each takes and those clauses' text digests, the Story slices with their `start` commands, and the clauses not delivered here with their reasons. It is published through `publishToStateBranch` with an `absent` precondition and its exact SHA-256; a retry with the same operation returns the split already published.
  - `spec-split-proposal` at `$git/spec-split-proposals/<SPEC-ID>/<NNNNNN>.json`, in the clone's shared Git storage and never in a commit. The plan proposed for one revision on this clone, checked when it is proposed and again when it is published; a newer proposal for the same revision replaces it.
- The golden fixture carries one record of each.

Both families read as `model: never`. Nothing here changes who approves anything: publishing a split is the person's own step, and a split starts no Story.

## Accepted digests

| Companion | Reviewed change | Previously accepted | Accepted at this review |
| --- | --- | --- | --- |
| `migration-registry` | The `spec-split` and `spec-split-proposal` families. | `sha256:81d0f9c4f8308e84308674356f6e7b55f59c1423a814575e395aa394ffdbdee8` | `sha256:ad66567c8a508131271edcbd3088443857fe2b4881133e4b9dd7a4d274b709c0` |
