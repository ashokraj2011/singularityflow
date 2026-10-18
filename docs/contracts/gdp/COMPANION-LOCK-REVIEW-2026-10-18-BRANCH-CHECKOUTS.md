# GDP companion authority review — workspace branch checkouts — 2026-10-18

Review boundary: `364c902fb4a31c310481e3dfb5d897f0a90d1c5a` (`main` when this drift was found by the full test suite). The preceding review is `COMPANION-LOCK-REVIEW-2026-10-17-WORKFLOW-BUILDS.md`.

One GDP-locked companion differs from its accepted digest at this boundary: `migration-registry`. It changed in `8f58d079` ("Recover Story intake in independent branch-named workspace checkouts"), merged after the preceding review without a review of its own; this review covers that drift after the fact. It is not a bulk hash refresh, and it adds no approval authority. Every other companion still matches its accepted digest.

## Reviewed in `src/schema-migrations.mjs` (`migration-registry`)

- New: the `workspace-branch-checkout` family, version 1 with no migrations, at `$git/branch-checkout.json`. It is the ownership receipt of an independent branch checkout (`src/workspace-branch-checkout.mjs`): workspace and repository IDs, the original repository path and URL, the branch, the base commit and when it was created. It is written atomically with mode 0600 inside that checkout's own Git directory, after the checkout proved independent object storage.
- New: the `workspace-branch-pointer` family, version 1 with no migrations, at `[$workspace/].singularity-flow/branch-checkouts/<branch>/<repository>.json`. It holds only the retry marker that lets intake find the checkout, written atomically with mode 0600 in the workspace folder.
- Both are read through `readRecord` by `readBranchRecord` (`src/workspace-branch-locations.mjs`), which refuses links, non-files and records over 16 KB and treats an unreadable record as absent. A receipt only selects a location: callers still verify Git identity and lifecycle authority (`workspaceBranchMember` checks the workspace ID and base commit).
- Each path resolves to exactly its own family through `familyForStoredPath` (checked for `$git/branch-checkout.json` and pointer paths with and without `$workspace/`); no existing family's paths or versions changed.

Neither record enters a repository, a Story snapshot or a bundle. Who approves anything is unchanged.

## Accepted digests

| Companion | Reviewed change | Previously accepted | Accepted at this review |
| --- | --- | --- | --- |
| `migration-registry` | `workspace-branch-checkout` and `workspace-branch-pointer` v1 families. | `sha256:2ed65ecee765ba3fcec3c7f259f970f51992dd376776b00a94ed8ffc3aa70a1d` | `sha256:b010402f5395514566ae22e7a1d2cc9793588c51f19b305e671ea010e113fcfc` |
