# GDP companion authority review — local evidence review channel — 2026-10-09

Review boundary: `d206b553b742bb73b549cdee5add2870e0c7f0a5`. The preceding review is `COMPANION-LOCK-REVIEW-2026-10-09-HOOK-PUBLICATION-AND-RECORD-FAMILIES.md`, which reported this drift and did not accept it because it changes how an approval is granted. The product owner sanctioned this review on 2026-10-09 ("review, then accept").

One GDP-locked companion changes: `action-authorization` (`src/action-authorization.mjs`). It was accepted at `sha256:63de1360…` (the `4e0942da` bytes). `59c88c23` and `1c0f1d2d` changed it. At the boundary its digest is `sha256:ecf788b638cbc305cfb598c2b6013e1569c479499cc84c9f7eec27fb636195df`. The file is unchanged from `1c0f1d2d` to the boundary.

This is not a bulk hash refresh and it adds no general approval channel.

## Reviewed in `src/action-authorization.mjs`

### `59c88c23` — terminal review on stderr

- The terminal review card and its prompt move from stdout to stderr, because a `--json` caller's buffered stdout hid the card while the prompt waited for an answer.
- stderr must now be a TTY as well as stdin and stdout.
- The answer is trimmed; a wrong answer gets two more tries; Enter still cancels at once. The typed label must still match exactly, and the identity check before and after the answer is unchanged.

Accepted: the same person, at the same terminal, confirms the same exact card.

### `1c0f1d2d` — local browser review for evidence corrections only

`captureEvidenceReviewAuthorization` presents an evidence-contract correction in a one-shot page served by the CLI process itself (`src/local-evidence-review.mjs`, not a companion), so the review can start from Copilot or VS Code where no terminal is attached.

What bounds it:

- **Scope.** It accepts only an action whose ID is `PEA-` plus 24 hex characters, whose plan preview kind is `evidence-contract-correction-preview`, and whose retained evidence bytes match the preview's size and SHA-256. Anything else is refused (`ACTION_LOCAL_REVIEW_UNAVAILABLE`). The page states that the correction is a classification change, not a visual pass or phase approval, and that tests and source-bound proof remain required.
- **Who can answer.** The server listens on `127.0.0.1` on a random port at a path holding a 256-bit random secret that is never printed. It checks the `Host` header (no DNS rebinding), requires a `GET` of the page before a `POST`, the page's own form nonce, a matching `Origin`, `application/x-www-form-urlencoded`, and `Sec-Fetch-Site: same-origin` when sent. The person must type the exact confirmation label.
- **Lifetime.** One decision only, then the server closes; it expires after at most 15 minutes. Cancel, timeout, a mismatched label or a closed browser accept nothing.
- **Content safety.** A strict Content-Security-Policy, escaped text, and only captured PNG/JPEG/WebP bytes are served; SVG/HTML and repository paths never are.
- **Binding.** The issued authorization carries `channel: 'local-evidence-review'`. `consumeActionAuthorization` with `requireEvidencePresentation` admits only that channel, for the same `PEA-` action and preview kind, and still requires the same root, plan hash, action, subject, revision, card hash and unexpired witness. Every use consumes the witness. The terminal channel cannot be satisfied by a browser witness, or the reverse.
- **Identity.** The local identity is read before the page opens and again after the decision; a change accepts nothing.

Residual risk, accepted: another process running as the same user could read the secret URL from the arguments passed to the system browser launcher while it runs, and answer the form. Such a process is already inside the user's trust boundary (it could edit the repository and state directly), so this does not widen who can act.

## Accepted digest

| Companion | Reviewed change | Previously accepted | Accepted at this review |
| --- | --- | --- | --- |
| `action-authorization` | Terminal review on stderr with retries (`59c88c23`); a one-shot localhost review channel restricted to `PEA-` evidence-contract corrections and bound to its own witness channel (`1c0f1d2d`). | `sha256:63de1360825c9024fa9d21fdc69375d2950948bdb648987b4398f55b18e152b7` | `sha256:ecf788b638cbc305cfb598c2b6013e1569c479499cc84c9f7eec27fb636195df` |
