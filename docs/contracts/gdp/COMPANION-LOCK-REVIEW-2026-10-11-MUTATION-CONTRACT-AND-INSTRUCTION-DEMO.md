# GDP companion authority review — mutation contract and instruction demo — 2026-10-11

Review boundary: `c815d908ffed78fa18fd3ea37020eaceaeefaac4`. The preceding review is `COMPANION-LOCK-REVIEW-2026-10-10-WORKFLOW-BUNDLE-V8.md`.

Two GDP-locked companions changed, `migration-registry` and `workflow-configuration`. `main` already carried unreviewed changes to both, so the lock failed on `main`: `2e600393` ("Enforce phase mutation contracts and three-surface next actions") edited `src/schema-migrations.mjs`, and `ea5233f7` ("feat: compose skill instructions at explicit steps and seed test-repair demo") edited `templates/workflow.yml`, both without a companion review. The previously accepted digests are the files as of `2e600393^` and `0f536079`. This review covers those changes after the fact. It is not a bulk hash refresh or a new approval authority.

## Reviewed after the fact in `src/schema-migrations.mjs`

- One machine-local family is added: `copilot-mutation-contract` at version 1, at `$local/copilot-boundaries/<sha256>.mutation.json`. It sits beside the existing `copilot-repository-boundary` family, whose path pattern (`<sha256>.json`) does not match the new `.mutation.json` files, so no stored record changes family.
- The family is new, so it has no migration steps and no historical records to project.
- No other family, migration step, path or classification changes.

## Reviewed after the fact in `templates/workflow.yml`

- One packaged work type is added, `demo-instruction-test-loop`, with four new phases: `demo-instruction-intake`, `demo-instruction-test`, `demo-instruction-repair` and `demo-instruction-close`. The change is 98 added lines and no removed or edited lines.
- The work type declares its `implement` omission with a reason and the `quality-reviewers` authority, requires planned claims at intake, limits document uploads to intake, and bounds both decision loops at three rounds with `enforceConditions: true`.
- Every new phase names existing approval authorities (`product-approvers`, `quality-reviewers`, `engineering-reviewers`) with a minimum of one. Only the repair phase writes source (`source-and-artifact`); the others are `artifact-only`.
- No existing work type, phase, authority, policy or default changes.

## Accepted digests

| Companion | Reviewed change | Previously accepted | Accepted at this review |
| --- | --- | --- | --- |
| `migration-registry` | Adds the machine-local `copilot-mutation-contract` family v1 (no steps). | `sha256:775b67f5211646883259a7b2773ca7c4fe81e5d7d712149bbfd8ba5e2e86f8a6` | `sha256:418bf1c7a738d6edb7d7f22db76b0b220b30c49f21122f88b29b25b99422b42f` |
| `workflow-configuration` | Adds the `demo-instruction-test-loop` work type and its four phases; nothing existing changes. | `sha256:dae5059f63781e9ed25b159cc6c2f8d6ae7202d83ceeaddd15eab423c8ce6216` | `sha256:bc2438fef7d062036e1576f9d57b4117b5e26afcb8ee4bca9dc92989f3c87b18` |
