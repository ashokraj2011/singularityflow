# GDP companion authority review — TypeScript Playwright description — 2026-10-19

Review boundary: `279443295ac30c4866a0eb418b432619b84da91c` (`main` at the start of this change). The preceding review is `COMPANION-LOCK-REVIEW-2026-10-19-PREMIUM-MULTIPLIERS.md`.

One GDP-locked companion changes in this change: `workflow-configuration`. It is not a bulk hash refresh, and it adds no approval authority. Every other companion still matches its accepted digest.

## Reviewed in `templates/workflow.yml` (`workflow-configuration`)

- The `poc-workflow` work type's `description` now says what its gates already require: its `poc-validation` step runs `npx --no-install tsc --noEmit` and `npx --no-install playwright test`, so it is a profile for TypeScript Playwright suites run through npm. A team with a Java, Python or .NET Playwright suite could pick it from the catalog without knowing its validation could never pass.
- The `typescript-compile` and `playwright-tests` quality commands are unchanged and still required; no gate is removed, relaxed or made optional. The label, phases, approvals, MCP policy and repair budget are unchanged.
- The previous `poc-workflow` node digest is registered as a known packaged revision in `src/packaged-workflow-history.mjs`, so a repository seeded from the earlier package still upgrades; a repository-customized node keeps its own bytes. An existing repository's `workflow.yml` is never rewritten.

Who approves anything is unchanged.

## Accepted digests

| Companion | Reviewed change | Previously accepted | Accepted at this review |
| --- | --- | --- | --- |
| `workflow-configuration` | `poc-workflow` description names its TypeScript Playwright gates. | `sha256:cacf4584ba99ccd05f86f003958c35ea42a038793658de3c15b34b9c2a13ea03` | `sha256:2c1629170aea3e0ae5511cfd021899b35eb7120d2d61d1ca600605afda761b4a` |
