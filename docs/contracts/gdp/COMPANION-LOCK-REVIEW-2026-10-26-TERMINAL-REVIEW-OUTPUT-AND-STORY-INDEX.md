# GDP companion authority review — Terminal-reviewed output and the Story index record — 2026-10-26

Review boundary: `f411aa265cb92216aabc9ac1172364da176ee93a` (`main` at the start of this review). The preceding review is `COMPANION-LOCK-REVIEW-2026-10-23-PUBLICATION-PUSH-FAILURE-ROUTE.md`.

Two GDP-locked companions changed on `main` after that review without one of their own, and the freeze test has failed since: `action-authorization` (`3b81ba8c`) and `migration-registry` (`4de17463`). This review reads both changes after the fact. It is not a bulk hash refresh, and it adds no approval authority. Every other companion still matches its accepted digest.

## Reviewed in `src/action-authorization.mjs` (`action-authorization`, `3b81ba8c`)

- **What changed:** two lines in `captureTerminalActionAuthorization`. After its existing checks pass (stdin, stdout and stderr are all TTYs, and the confirmation card is valid), it sets `globalThis.__SINGULARITY_FLOW_PERSON_AT_TERMINAL = true` before reading the person's answer.
- **Who reads it:** only `agentOutputGoverned` in `src/agent-output.mjs`, which then returns false, so that command's `--json` result is printed whole instead of as a bounded agent envelope. The person who reviewed the action at the terminal sees its full result (the two wca-submission terminal tests).
- **Why it is safe:** it changes how much output is printed, never what is authorized. The card, the identity check (`actorKey` before and after), the typed confirmation, the receipt and the single-use consumption are unchanged. An agent's piped run never reaches the line: the TTY checks refuse it first with `ACTION_TERMINAL_PRESENTATION_REQUIRED`. A declined confirmation prints its refusal whole too, which reveals nothing the terminal card did not already show.

## Reviewed in `src/schema-migrations.mjs` (`migration-registry`, `4de17463`)

- **What changed:** one new record family, `story-index` at version 1, for `$local/story-index.json`: the machine's index of which checkout holds each workspace Story (`src/story-index.mjs`). It has no migration steps.
- **Why it is safe:** the index is a lookup and cache. Every read re-verifies an entry against Git, and it is never authority for a Story, a step, an approval or a publication. It lives in the machine-local area, not in any repository or governed branch. No existing family, version or migration changed.

Who approves anything is unchanged. Approval authorities, sequence gates and publication policy are untouched.

## Accepted digests

| Companion | Reviewed change | Previously accepted | Accepted at this review |
| --- | --- | --- | --- |
| `action-authorization` | Direct terminal review marks the process as read by a person, so that command's `--json` result is printed whole (`agentOutputGoverned` false); set only after the existing TTY and card checks. | `sha256:ecf788b638cbc305cfb598c2b6013e1569c479499cc84c9f7eec27fb636195df` | `sha256:dc56759df79470b3b1d00ce90c0704a77e090b47975d87005d0a2bdaaeef902f` |
| `migration-registry` | Registers the machine-local `story-index` record family at version 1 (`$local/story-index.json`), a re-verified cache that is never authority. | `sha256:31054ef20836147789698b24a358421fd7de45f26fb64e887395021476741477` | `sha256:bb157e513ae0d77fbb2b0e8a9a1e79fd3a3b3eb93de4350f25a3f514ab8969b0` |
