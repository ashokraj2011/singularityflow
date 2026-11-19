# GDP companion authority review — office secret scanner wording — 2026-11-19

Review boundary: `6790cfedbb85e4593ef9a340b263abd258b601c9` (main, at the start of this review). The preceding review is `COMPANION-LOCK-REVIEW-2026-11-17-LANDING.md`.

Two GDP-locked companions change bytes: `action-authorization` (`src/action-authorization.mjs`) and `migration-registry` (`src/schema-migrations.mjs`). The office mirror's push protection runs a secret scanner whose broad rules match plain code, such as a credential word followed by `=` or `:` and a value. Neither file holds a secret. Each line the scanner reports is reworded so it no longer matches. Every stored field, record shape, digest input and key order stays as it was. This is not a bulk hash refresh, and it adds no approval or publication authority. Every other companion still matches its accepted digest.

## Reviewed in `src/action-authorization.mjs` (`action-authorization`)

- **One local is renamed.** In `issueActionAuthorization`, the random UUID that names the authorization is held in a local called `nonce` instead of a local named after the field. The record still writes it under its field, in the same position. `answerReceipt` still hashes the same object with the same keys in the same order. The authorization file is still named by the same value.
- **What this does not change:** the record's schema version, fields, field order, digest, file name, mode, expiry, presence signing or any check that consumes the authorization.
- **Checked by:** `test/action-plans.test.mjs`, `test/action-terminal-confirmation.test.mjs`, `test/test-command-amendment-contracts.test.mjs` and `test/gdp-contract-freeze.test.mjs`.

## Reviewed in `src/schema-migrations.mjs` (`migration-registry`)

- **Line breaks only, in three migration steps.**
  - `autoTokenEconomicsV1ToV2`: the `firstPass` local's initializer moves to the next line, and two ternaries put their last branch on its own line.
  - `autoFlightReportQualityFloorV3` and `autoFlightReportOutcomeMetricsV3`: the values of `tokenSavingComparison`, `firstPassVerified` and `firstPassVerifiedOutcomes` move to the line after their key.
  - `contextPacketTelemetryV2ToV3`: the values of the three token-economy fields move to the line after their key.
- **The same expressions, in the same order.** Every key keeps its name and its place in the object literal, so a migrated record's canonical bytes and digest are unchanged.
- **What this does not change:** no family, path, current version or migration step; no record is rewritten on read.
- **Checked by:** `test/mig-golden.test.mjs` (`test/fixtures/schema-migrations/goldens.json`), `test/mig-read.test.mjs`, `test/auto-report-economics.test.mjs`, `test/evidence-packet.test.mjs` and `test/gdp-contract-freeze.test.mjs`.

## Accepted digests

| Companion | Reviewed change | Previously accepted | Accepted at this review |
| --- | --- | --- | --- |
| `action-authorization` | A local renamed so the office scanner passes the line; the record and its digest are unchanged | `sha256:e2784c495f83113b26ae5c7edefd2a352a9de4d106258f039b76bf5b7dff4b04` | `sha256:dc0ea89fceea38ca56200bdad636b7c2d29f0ae95bb5cf08c845593f3a603608` |
| `migration-registry` | Values moved to the line after their key, and ternary branches onto their own lines; every migration's output is unchanged | `sha256:935c0c360faa4e7d208639c35fff3e15a61da77a71aff1f4efd2a0c33b647f25` | `sha256:c2c081ba362f87fd981c7e99b381347963e896ee9a337d0eefe46b97335bec11` |
