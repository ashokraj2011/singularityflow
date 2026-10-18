# GDP companion authority review — premium-multiplier example — 2026-10-19

Review boundary: `f7da75cce3155452211590853a028d0275772083` (`main` at the start of this change). The preceding review is `COMPANION-LOCK-REVIEW-2026-10-18-LEDGER-DEFAULT.md`.

One GDP-locked companion changes in this change: `workflow-configuration`. It is not a bulk hash refresh, and it adds no approval authority. Every other companion still matches its accepted digest.

## Reviewed in `templates/workflow.yml` (`workflow-configuration`)

- The `tokens` block gains a commented `premiumMultipliers` example under the existing commented `pricing` example. Reports estimate Copilot premium requests as requests times these multipliers, and with none configured the estimate reads "unavailable"; the starter configuration did not say the key exists.
- The example uses placeholder names (`premium-model-name`, `included-model-name`), because only `templates/modelTiers.yml` may name a model. Every added line is a YAML comment. The parsed configuration of a repository made from the starter is unchanged, and no multiplier is assumed: GitHub publishes and changes them.
- No other key changes, and an existing repository's `workflow.yml` is never rewritten.

Who approves anything is unchanged.

## Accepted digests

| Companion | Reviewed change | Previously accepted | Accepted at this review |
| --- | --- | --- | --- |
| `workflow-configuration` | Commented `tokens.premiumMultipliers` example. | `sha256:ac191216bf8558499df0476034a9164131e1ee04e4ffa9074c300309c7b1c5a8` | `sha256:cacf4584ba99ccd05f86f003958c35ea42a038793658de3c15b34b9c2a13ea03` |
