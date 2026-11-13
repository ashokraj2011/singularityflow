# GDP companion authority review — the Test run workflow — 2026-11-13

Review boundary: `5f89b2478ea8ab6aec0e55b9161824a28b0d3b25` (`main`, at the start of this review). The preceding review is `COMPANION-LOCK-REVIEW-2026-11-12-READABLE-TERMINAL-CARD.md`.

One GDP-locked companion differs from its accepted bytes: `workflow-configuration` (`templates/workflow.yml`). `0a4b40cc9` changed it without a review. That commit's touched tests did not include `test/gdp-contract-freeze.test.mjs`, and the touched-area run for the next change found the drift. This review records what changed, read from the file. The file does not change here. It is not a bulk hash refresh, and it adds no approval authority. Every other companion still matches its accepted digest.

## Reviewed in `templates/workflow.yml` (`workflow-configuration`)

- **A new shipped workflow, Test run (`test-run`).** It has one step and omits `scope`, `plan` and `implement`. Each omission names a reason and the existing group `quality-reviewers`.
- **A new step, `test-run`.** It writes only its report (`writeScope: artifact-only`), its artifact kind is `test-evidence`, and it runs the repository's own tests (`repositoryTests: run`). It is signed off by the existing `quality-reviewers` group (minimum 1), and rejected work goes back to the step itself.
- **Comments only** on `careful-change` and `poc-lite`. Their omits, reasons and authorities are unchanged. The comments now say that a responsibility no step holds is settled by the workflow's declared reason. That is the engine rule `omittedByEveryRoute` (`src/evidence/applicability.mjs`, owner 2026-11-12), where a person's recorded decision still stands over it.
- **What this does not change:** no other step or workflow, no approval group or member, no sign-off minimum, no send-back target of an existing step, and no repository test or quality command.
- **Checked by:** `test/test-run-workflow.test.mjs`, `test/workflow-simulation.test.mjs`, `test/workflow-planned-claims.test.mjs` and `test/gdp-contract-freeze.test.mjs`.

## Accepted digests

| Companion | Reviewed change | Previously accepted | Accepted at this review |
| --- | --- | --- | --- |
| `workflow-configuration` | Test run ships as one artifact-only step that runs the repository's tests; it omits scope, plan and implement, recorded by quality-reviewers; comments on two existing omits | `sha256:d6aa8fcd6e918cd2d015f92bd5c3982bc5ef04e3bbdffcd794e593f0360832ee` | `sha256:bfa39c3fb714d62999b11b107b8b8393eba6e8f24770e2bb4123ba2979371816` |
