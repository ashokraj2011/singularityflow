# GDP companion authority review — the terminal card a person reads — 2026-11-12

Review boundary: `92c7d042e88968a099b002284c54a3dd8603d55a` (`main`, at the start of this review). The preceding review is `COMPANION-LOCK-REVIEW-2026-11-09-STOPPED-GROUPS.md`.

One GDP-locked companion differs from its accepted bytes: `action-authorization`. `d7d0b5b53` changed it without a review; that commit's touched tests did not include `test/gdp-contract-freeze.test.mjs`, and the full suite after integration found the drift. This review records what changed, read from the code. The file does not change here. It is not a bulk hash refresh, and it adds no approval authority. Every other companion still matches its accepted digest.

## Reviewed in `src/action-authorization.mjs` (`action-authorization`)

`captureTerminalActionAuthorization`, the direct-terminal confirmation of an exact action.

- **What the person reads:** the card written to stderr before the question is now `readableCard({ plan, action })`. A field or array entry whose whole value is a digest or a commit is left out, and a digest inside a text reads `(as reviewed)`. Everything else on the card is printed as before. This follows the owner's rule of 2026-11-11 that a person never reads a digest.
- **What is bound and signed is unchanged:** `reviewedPlan` and `reviewedAction` are still the whole structured clones. The SF Guard signature (`signTerminalReview`), `issueActionAuthorization`, the recorded `planHash`, `actionId`, `subject`, `revision` and the `cardSha256` of the terminal presentation are all computed from the whole card, never from the readable one.
- **What the person types is unchanged:** the confirmation is still the exact `label`, three attempts at most, Enter cancels. No digest was ever typed, so hiding digests removes nothing a person needed to confirm.
- **What this does not change:** the TTY requirement, the label validation, the identity check after the answer, the token's expiry, and every other channel (`captureEvidenceReviewAuthorization` and the agent channel print nothing new).
- **Checked by:** `test/action-terminal-confirmation.test.mjs` (the printed card names no `planHash` and no 64-hex value; the plan it binds is the whole one) and `test/gdp-contract-freeze.test.mjs`.

## Accepted digests

| Companion | Reviewed change | Previously accepted | Accepted at this review |
| --- | --- | --- | --- |
| `action-authorization` | The terminal card a person reads leaves out digests and commits; the card bound, signed and recorded is the whole one | `sha256:9b62f5d1749d94a97223844181b893e32fe0b07c228fde74ad0d703c1b2eb44e` | `sha256:e2784c495f83113b26ae5c7edefd2a352a9de4d106258f039b76bf5b7dff4b04` |
