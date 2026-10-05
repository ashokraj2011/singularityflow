# GDP companion authority review — skill master in workflow bundles — 2026-10-05

Review boundary: `27298580e6149fd008d23298ee6770e88fae9a5f` plus the skill master patch reviewed below. The preceding review is `COMPANION-LOCK-REVIEW-2026-10-05-WORKFLOW-BUNDLE-V4.md`.

Three GDP-locked companions changed: `migration-registry`, `workflow-configuration` and `smart-initialization-v1`. `main` already carried unreviewed changes to the last two, so the lock failed on `main`. `fb036910` ("Make phase recovery actionable and defer intake test execution") edited `templates/workflow.yml` and `src/initialization/proposal.mjs` without a companion review. At the boundary their digests were `sha256:dd5b183194d047e60a02268e66d6e75640ca88bf1a1b661711056647dd983794` and `sha256:1701ccd4b2c0bae3543916d594d640402a7d14d504d01867ed631a66cb0da208`. `migration-registry` still had the digest the preceding review accepted. This review covers those two changes after the fact, with the skill master change on top. It is not a bulk hash refresh or a new approval authority.

Reviewed after the fact in `templates/workflow.yml`:

- `fb036910` sets `repositoryReadiness.requiredBeforeStory: false` and rewrites the block's comment.
  - **What is relaxed.** The packaged configuration no longer requires an exact-base readiness receipt before a Story is created. Intake records the person's baseline choice but neither installs dependencies nor runs tests, and test outcomes at intake are advisory.
  - **What still holds.** This relaxes when readiness is observed, not whether tests are required. `structuredTests: required-for-code` is unchanged, so a code phase still needs fresh structured test evidence, or an eligible human risk decision, before it publishes.
  - **Resolve-outside choices.** An explicit choice to resolve base failures outside the Story is now enforced when coding starts, instead of at creation.
  - **Repository policy.** A repository whose own policy keeps `requiredBeforeStory: true` with required dependency, build or start prerequisites is still blocked at creation until those pass at the exact base.
  - **Pinned Stories.** The block is repository-wide, so no packaged work-type or step digest changes, and Stories pinned before it still verify.

Reviewed after the fact in `src/initialization/proposal.mjs`:

- `fb036910` makes smart initialization propose `proof.preStory.requiredBeforeStory: false`, matching the packaged template.
  - The other `preStory` fields are unchanged: `dependencyHydration: when-detected`, `build: off` and `structuredTests: required-for-code`.
  - Proof remains mandatory at candidate admission.
  - Repositories initialized earlier keep the value they stored.

## Reviewed drift

| Companion | Authority change reviewed | Previous digest | Accepted digest |
| --- | --- | --- | --- |
| `workflow-configuration` | `repositoryReadiness.requiredBeforeStory` becomes `false`, with its explanatory comment, as above. | `sha256:e5b3f3c84c06b2b0312eb38e1f97672a7c572516acc1314ac028fba5a506ac44` | `sha256:dd5b183194d047e60a02268e66d6e75640ca88bf1a1b661711056647dd983794` |
| `smart-initialization-v1` | Smart initialization proposes `proof.preStory.requiredBeforeStory: false`, as above. | `sha256:ba9b3bb95a0974a42bf42161c26f78f4389a3f2a43343bffb7091af9e868f3a6` | `sha256:1701ccd4b2c0bae3543916d594d640402a7d14d504d01867ed631a66cb0da208` |
| `migration-registry` | The immutable `workflow-bundle` family moves from schema 4 to 5. Version 5 lets a bundle carry the skill master's skills (`singularity/skill-library/<id>/SKILL.md`) that its agents attach, once each. The one added step, 4 → 5, only sets the version: a historical bundle carried no such skills, so the projection invents none, keeps the stored identity and digest, and the reader still applies the contract of the stored version. | `sha256:b5411b0bd0267af28e8545c3e82dd2ea39d2151d7e3b8a15a74d8dc7c9d45c14` | `sha256:c54dcba9a46bc6386b4abfe7e8d32647354eccd96f8f659675e4f87dd0fcb8e7` |

The change grants no import, overwrite, approval or publication authority. A carried skill is accepted only as a valid SKILL.md whose name is its ID, at its canonical path, and only when a carried agent attaches it; every skill a carried agent attaches must travel with it. Import stays a previewed configuration mutation confirmed by its exact plan, and a same-name skill blocks it until a person keeps theirs, replaces it, or imports it under a new name.

## Validation evidence

For the settings above, the review runs the repository-readiness configuration, Story intake start, smart initialization and phase publication readiness tests. For the bundle change it runs the migration golden catalog, the historical bundle projection test (v1 to v4 project through v5 with their stored identity), the workflow-transfer, workflow-transfer-conflicts and skill-library suites (carried skills, reader refusals, conflict choices and renames), and the GDP contract-freeze test.

## Sanctioned reconciliation procedure

1. Run the GDP companion-lock test and confirm `migration-registry`, `workflow-configuration` and `smart-initialization-v1` are the only changed companions.
2. Verify the family stays immutable, its golden catalog lists schema 5, and historical projections keep their stored identity.
3. Run the repository-readiness, Story intake, smart initialization, phase publication readiness, migration, mig-read, workflow-transfer, workflow-transfer-conflicts, skill-library and GDP contract-freeze tests.
4. Accept only the reviewed digests above; retain `baselineCommit` unchanged.
5. Require another bounded companion review for any later byte change to these companions.
