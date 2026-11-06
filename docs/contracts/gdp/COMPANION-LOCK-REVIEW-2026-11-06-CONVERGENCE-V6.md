# GDP companion authority review — convergence records v5 and v6 — 2026-11-06

Review boundary: `3a56e242d73ded731dfe0a381a3bab0b4870955c` (`main`, at the start of this review). The preceding review is `COMPANION-LOCK-REVIEW-2026-11-06-AUTO-GATE-RUN.md`.

One GDP-locked companion differs from its accepted bytes: `migration-registry`, changed by the commit that stopped convergence asking what the approved plan answered (family v5) and the commit that keeps a replaced answer (family v6). The full test suite found the drift.

## Reviewed in `src/schema-migrations.mjs` (`migration-registry`)

**`convergenceSealCore` is now the one definition of what a seal covers.** It was a local helper inside the reseal step, and `src/convergence.mjs` now shares it, so a writer and a verifier cannot disagree.

- **Older records keep their seals.** A stored v4 or v5 record is checked and not resealed, because its published report prints that seal, and a new one would turn the report into a mismatch for a Story waiting on approval.
- **What a seal covers is unchanged for an older record:** everything but the seal and the candidate snapshot, read as the version it was sealed at.
- **Only a record holding what v6 adds seals as v6.** Removing a replaced answer from such a record changes the version the core is read at, so the seal no longer matches: `test/convergence-answer-trace.test.mjs`.

**Migrations `4 -> 5` and `5 -> 6`** check the stored seal first and refuse a corrupt source, as every earlier step does. They change only `schemaVersion`.

**What this changes:** nothing about which record verifies, apart from the new fields. A forged record resealed with the real seal still fails on its derived state: `test/spk-converge.test.mjs`.

- **Checked by:** `test/convergence-plan-settled.test.mjs` and `test/convergence-answer-trace.test.mjs` (frozen v4 and v5 bytes keep their seals and reports), and the golden in `test/fixtures/schema-migrations/goldens.json`.

## Accepted digests

| Companion | Reviewed change | Previously accepted | Accepted at this review |
| --- | --- | --- | --- |
| `migration-registry` | Shared seal core; convergence families v5 and v6, each checking its source and leaving older seals as they are | `sha256:a49a0c148ef95606ac503c11728c5e4117c92a6b0f5cd3c140e9dabd7d9d77fc` | `sha256:b05ce6eff1dacf209ca6226919b4d8d488faf7870c07a203117834b60308647f` |
