# GDP companion authority review — the hardening landing — 2026-11-20

Review boundary: `0538f8f8edd42dd9d9eadb288e3c855d2b7c83cf` (`landing-11`, at the start of this review). The preceding review is `COMPANION-LOCK-REVIEW-2026-11-20-CEREMONY-LANDING.md`.

One GDP-locked companion differs from its accepted bytes: `publication-unit-of-work` (`src/publication-unit-of-work.mjs`). The hardening track "every limit has an exit" (owner decision of 2026-11-20) changed it. A limit that threw with no code now carries one.

## Reviewed in `src/publication-unit-of-work.mjs` (`publication-unit-of-work`)

- **What changed:** the refusal when the capability ledger has unreconciled local records now carries a code and its facts: `LEDGER_BEHIND_BLOCKED` with the subject, the outbox and pending counts, and `nextAction: singularity-flow ledger reconcile`. Its message is unchanged.
- **What this does not change:** the condition that refuses, the subject it guards, the order of the unit of work's steps, its commit, its push and its recovery. No authority, writer or record family is added. The refusal is raised in exactly the same cases as before.
- **Why:** the refusal had no code, so its route fell to the generic help and doctor commands. With the code, the remediation table names the reconcile route (`src/limit-remediation.mjs`), and the limit table's test fails if a codeless limit returns (`test/limit-exits.test.mjs`).
- **Checked by:** `test/limit-exits.test.mjs`, `test/refusal-ways-out.test.mjs` and `test/gdp-contract-freeze.test.mjs`.

## Accepted digests

| Companion | Reviewed change | Previously accepted | Accepted at this review |
| --- | --- | --- | --- |
| `publication-unit-of-work` | The ledger-behind refusal carries `LEDGER_BEHIND_BLOCKED` and its facts; same condition, message and behaviour | `sha256:0445a89dbe58833ffc327624e9a0c77e921dae908ad8051fe2638931f3a8c4c5` | `sha256:071c67a27b7219768c06f27dbf78d92e602b1b448be84d343de14cad348e6129` |
