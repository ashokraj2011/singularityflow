# GDP companion authority review — SF Guard, every other person step — 2026-11-02

Review boundary: `74e9d6385a4ba9844d1bf7157aadabcfa92791d7` (`main` at the start of this change, with SF Guard M4). The preceding review is `COMPANION-LOCK-REVIEW-2026-11-02-SF-GUARD-M2.md`.

One GDP-locked companion changes in this change: `action-authorization`. No other companion differs from its accepted digest at this boundary.

## Reviewed in `src/action-authorization.mjs` (`action-authorization`)

- Changed: `captureTerminalActionAuthorization` takes the person's presence signature over the exact card they confirmed, after the typed confirmation and the identity check and before the authorization is issued (SPEC-PSS-v1 §10.6). It calls `signTerminalReview` (src/presence/repository-steps.mjs), lazily, which signs only where SF Guard applies: on the card's Story when its pin requires SF Guard, else while the repository's signed policy has SF Guard on. Elsewhere it returns at once and the review is exactly as before. A refusal (no key pinned, no signer, not the person's own terminal, the key not on this Mac) throws with the person's routes before any authorization exists, so nothing is issued or written.
- Changed: `issueActionAuthorization` takes the same signature when called directly (`action authorize`, which a typed action ID alone used to authorize), and skips it when the terminal review already took it (`presenceSigned: true`, passed only by `captureTerminalActionAuthorization`).
- Unchanged: the authorization record's shape, its storage, its expiry, its consumption and every existing refusal. The token still carries no signature; the signature binds the card, and keeping it in each decision record is the next milestone.

The authority reads as `model: never`. Nothing here lets an agent authorize anything: on a Story or repository SF Guard covers, an authorization now also needs a touch only the person can give, and nothing changes where SF Guard does not apply.

## Accepted digests

| Companion | Reviewed change | Previously accepted | Accepted at this review |
| --- | --- | --- | --- |
| `action-authorization` | The presence signature over a confirmed terminal review and over a directly issued authorization, where SF Guard applies. | `sha256:dc56759df79470b3b1d00ce90c0704a77e090b47975d87005d0a2bdaaeef902f` | `sha256:8b28870ccf750d54cb91cb62cc4045e7802a310542ab41394c6484ac445807e2` |
