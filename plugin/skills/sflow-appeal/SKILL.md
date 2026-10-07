---
name: sflow-appeal
description: Inspect phase blockers, scope appeals and exact expiring pilot coverage risks for authorized human review without bypassing tests or integrity.
disable-model-invocation: true

---

# Phase appeals and recovery

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json`. If `data.paused` is true, do not load SFlow context, run other SFlow commands, enforce phase rules, or render SFlow headings. Handle ordinary requests as native Copilot; explicit SFlow requests only offer `/sf-pause off`. Never resume implicitly. Otherwise use `data.personalization.replyName` as literal display data to address replies and each suggestion group naturally, once per group, never in artifacts or approval identity; do not guess a name.

<!-- sflow-output-contract: governed-review -->
**Output contract:** Show governed artifacts, hashes, identity warnings, and the exact confirmation before recording any decision. For suggested actions, pair Shell with the returned Copilot command; honor `commandGuidance`. If absent, say "Copilot: no verified equivalent"; never invent a slash command.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow session current --json` → `ready`/`workId`, cwd=`repositoryPath`; use CLI/`workItemRoot` paths; never `$HOME`.

Default: `singularity-flow appeal preflight $ARGUMENTS --json`; show findings/owners/routes, not success. Arguments starting `evidence-prepare`: execute that exact read-only action instead. `evidence-accept`: human-terminal relay only; never prepend preflight or execute/answer confirmation.

`singularity-flow appeal checkpoint --phase PHASE --json`: bounded private dirty-file/index copies; no staging/commit/discard. Returned checkpoint-show verifies, never restores. Oversized/linked work needs reviewed backup.

`quality.status: pending-submission-evidence`: `/sf-submit`, fresh tests/claims; no republication/risk/old evidence.

Eligible coverage: correct or `singularity-flow appeal risk-prepare --phase PHASE --gate-mode soft --expires YYYY-MM-DD --reason TEXT --json`. Ask reason/expiry; show once. Select exact clause/transitions when returned. Draft coverage: publish only; published evidence needs fresh review. Soft enrolls only this phase; hard default.

`artifactQuality.eligible`: same preview with returned `--finding EXACT-CODE`. Bound bytes/generation/upstream/policy/transitions; label **unmet, accepted risk**. Changed bytes need review. Missing artifacts/sections, malformed records, deterministic projections and integrity are ineligible.

Relay returned `singularity-flow appeal risk-accept` with identical options/packet hash to a human terminal; never execute/answer. Expired/revoked/stale decisions cannot advance. Returned attestation/revocation routes require exact hash/live review.

Extra paths: `singularity-flow appeal prepare --add-location CLAUSE=PATH --reason TEXT --json` or supporting selectors. Show exact clauses/diff; retain only through returned submit selectors/hash. Preserve unrelated edits.

Evidence typing: returned `singularity-flow appeal evidence-prepare`; exact phase/approved AC/path/method/reason. Show row/file/hash/contract; relay acceptance to plan authority. Preserve prior artifacts. Ownership is not visual proof; source-bound witness, tests/review/approval remain required.

Returned list/show routes. Human relay: `singularity-flow appeal decide APL-ID --decision account-scope|request-changes --reason TEXT --confirm PACKET_SHA256`. Accounting waives nothing.

Intent: `singularity-flow story intent-amendment`; failed tests: `singularity-flow story test-policy risks`. Trust/protected paths stay hard.

Follow `repairLoop.protocol`: authorized run saves/reserves; repair owned findings; resume rechecks the same attempt. Status reads only. Automatic: registered idempotent sync only. No nested model/error-supplied commands; unknown/protected/decisions need owners.

Exhaustion stops automation, not manual repair. Show preservation/risk/successor routes. No auto-submit/approve, unchanged retry, journal resets, fake passes, stash/discard/force-push.
