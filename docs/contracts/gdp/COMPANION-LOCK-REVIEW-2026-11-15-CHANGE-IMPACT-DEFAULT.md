# GDP companion authority review — change impact on by default — 2026-11-15

Review boundary: `589c11df0472e580100c5970d2c354c746e05933` (branch `cic7`, SPEC-CIC stage 7, at the start of this review). The preceding review is `COMPANION-LOCK-REVIEW-2026-11-13-TEST-RUN-WORKFLOW.md`.

One GDP-locked companion changes here: `workflow-configuration` (`templates/workflow.yml`). The owner decided on 2026-11-15 that change impact is on by default, and that the seeded workflows show it. This review records what changed, read from the file. It is not a bulk hash refresh, and it adds no approval authority. Every other companion still matches its accepted digest.

## Reviewed in `templates/workflow.yml` (`workflow-configuration`)

- **One setting added to the `spec` block: `changeImpact: on`,** with a comment saying what it does and that `off` turns it off for Stories started after the change. It is the value the engine now uses where a workflow does not set it (`normalizeSpecPolicy`), written out so a person sees it. With it on, a Story pins `spec.changeImpact: on` and `spec.observedDependencies: on`, as it did when a repository wrote the setting itself (SPEC-CIC section 7.6).
- **What it changes for a new Story:** each published step records what it depended on, and each intent amendment is sized editorial, refinement or material. A material amendment is approved by the scope step's own approval groups, since no `scopeChangeAuthority` is named, and an editorial one by the scope approvers as before.
- **What this does not change:** no step, workflow, approval group, member, sign-off minimum or send-back target; no repository test or quality command; and no Story already started, whose pinned policy is read as it was (REQ-019).
- **Checked by:** `test/cic-change-impact-default.test.mjs`, `test/cic-change-classes.test.mjs`, `test/cic-dependency-records.test.mjs` and `test/gdp-contract-freeze.test.mjs`.

## Accepted digests

| Companion | Reviewed change | Previously accepted | Accepted at this review |
| --- | --- | --- | --- |
| `workflow-configuration` | The `spec` block writes `changeImpact: on`, the new default, with a comment | `sha256:bfa39c3fb714d62999b11b107b8b8393eba6e8f24770e2bb4123ba2979371816` | `sha256:8c79391c8d2154578325856d0f064e73db5b3471f8c2f74acb52e779201f3b17` |
