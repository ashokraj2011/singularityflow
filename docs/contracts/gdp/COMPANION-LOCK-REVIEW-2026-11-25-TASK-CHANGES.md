# GDP companion authority review — a step added to a started task — 2026-11-25

Review boundary: `f6d78043a214c52ec5b665c88874180fe9b65014` (`main`, the base of `itw-integration`). The preceding review is `COMPANION-LOCK-REVIEW-2026-11-21-STEP-INTENTS.md`.

One GDP-locked companion differs from its accepted bytes: `migration-registry` (`src/schema-migrations.mjs`). Intent to work (docs/SPEC-ITW-INTENT-TO-WORK-v1.1.md, REQ-009 and REQ-014) lets a started task gain a step; the change registers the two records that step leaves. This review reads the file as `itw-integration` leaves it. Every other companion still matches its accepted digest.

## Reviewed in `src/schema-migrations.mjs` (`migration-registry`)

- **Two new record families, nothing else.** `task-change-decision` (version 1, immutable, `context/task-changes/TSC-NNN-decision.json` under a Story's work item) is the decision a step added to a started task leaves: the step, who asked, when, and the rule and its reason when a team's path rule added it. `task-change-summary` (version 1, immutable) is its summary on the Story's record. No existing family, version, migration or path changes.
- **What this does not change:** no approval group, member, minimum or rule changes; a task only gains steps, never loses one, and a step that may change source files stays a person's. The new snapshot revision is replayed and checked on every load of the Story (`src/task-change-verify.mjs`), beside the test-command amendments.
- **Checked by:** `test/task-amendment.test.mjs`, `test/workflow-snapshots.test.mjs`, `test/gdp-contract-freeze.test.mjs`.

## Accepted digests

| Companion | Reviewed change | Previously accepted | Accepted at this review |
| --- | --- | --- | --- |
| `migration-registry` | Two new immutable record families for a step added to a started task | `sha256:c2c081ba362f87fd981c7e99b381347963e896ee9a337d0eefe46b97335bec11` | `sha256:219ed2a1510129cf99582fdef16886766b9ad947b00e58720a77d7ba11865631` |
