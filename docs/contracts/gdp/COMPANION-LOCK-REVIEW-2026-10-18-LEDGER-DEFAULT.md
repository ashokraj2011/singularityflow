# GDP companion authority review — Flow Ledger on by default — 2026-10-18

Review boundary: `e40a7e4b408800c00948e34e557ba5fedaff3e67` (`main` at the start of this change). The preceding review is `COMPANION-LOCK-REVIEW-2026-10-18-BRANCH-CHECKOUTS.md`.

One GDP-locked companion changes in this change: `workflow-configuration`. It is not a bulk hash refresh, and it adds no approval authority. Every other companion still matches its accepted digest.

## Reviewed in `templates/workflow.yml` (`workflow-configuration`)

- `ledger.enabled` changes from `false` to `true`. Story discovery, resume and return on another machine, and the approval inbox read Stories only from the ledger state index and never scan application branches. A repository made from the starter configuration therefore had all of them refuse until someone ran `ledger init`.
- `branch: state`, `remote: origin` and `publication: warn` are unchanged. Publication still only warns when the state append fails; it never refuses a lifecycle commit for it.
- The comment above the block says why it is on and what happens when it is off. No other key changes.
- Only the starter configuration changes. The code default is unchanged (`ledger-config.mjs`: a configuration with no `ledger` key keeps the ledger off), and an existing repository's `workflow.yml` is never rewritten, so no Story's pinned policy changes.
- `scripts/check.mjs` now requires the template to ship the ledger enabled on the `state` branch, instead of the old opt-in.

Who approves anything is unchanged.

## Accepted digests

| Companion | Reviewed change | Previously accepted | Accepted at this review |
| --- | --- | --- | --- |
| `workflow-configuration` | `ledger.enabled: true` in the starter configuration. | `sha256:f179fc6d6e5b7a171f10fa503d5f5657a7a95b1be727c70fbd10ebaffc665365` | `sha256:ac191216bf8558499df0476034a9164131e1ee04e4ffa9074c300309c7b1c5a8` |
