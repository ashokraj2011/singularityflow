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

Run `singularity-flow appeal preflight $ARGUMENTS --json`. Show findings/owners/routes; no gate success.

`singularity-flow appeal checkpoint --phase PHASE --json` saves bounded private dirty-file/index copies; no staging/commit/discard. `singularity-flow appeal checkpoint-show PCP-ID --phase PHASE --json` verifies, never restores. Oversized/linked work needs reviewed backup.

`quality.status: pending-submission-evidence`: returned `/sf-submit` for fresh tests/claims, not republication/risk/older evidence.

Eligible coverage: correction or `singularity-flow appeal risk-prepare --phase PHASE --gate-mode soft --expires YYYY-MM-DD --reason TEXT --json`. Ask reason/expiry; show once. Optional `--clause EXACT-ID` / `--transition publish|submit|approve|consume|terminal`. Draft coverage: publication only; re-review published evidence. Hard default; soft enrolls this phase only.

`artifactQuality.eligible`: same preview with returned `--finding EXACT-CODE`, not clauses. Bound bytes/generation/upstream/policy/transitions; label **unmet, accepted risk**. Changed bytes need review. Missing artifacts/sections, malformed records, deterministic projections and integrity are ineligible.

Relay `singularity-flow appeal risk-accept`, identical options plus `--confirm PACKET_SHA256`, to human terminal; never execute/answer confirmation. Tests/approval remain required; expired/revoked/stale cannot advance. Use returned risk-attest/risk-revoke commands for clone/key loss or withdrawal; exact decision hash and live review required.

Extra paths: `singularity-flow appeal prepare --add-location CLAUSE=PATH --reason TEXT --json` or `--add-supporting PATH=CLASS --supporting-reason TEXT`. Show clauses/diff once. Authorized retention: `singularity-flow appeal submit`, same selectors/confirmation. Preserve unrelated edits.

`singularity-flow appeal list --json` / `singularity-flow appeal show APL-ID --json`. Human-terminal relay only: `singularity-flow appeal decide APL-ID --decision account-scope|request-changes --reason TEXT --confirm PACKET_SHA256`. Accounting waives no test/review/approval.

Intent: `singularity-flow story intent-amendment`; failed tests: `singularity-flow story test-policy risks`. Trust/protected paths stay hard.

Appeal attestation also needs exact hash/live review; preserve history.

Follow `repairLoop.protocol` and returned repair-plan/run/resume commands: authorized run saves/reserves; repair owned findings; resume rechecks that attempt. Status reads only. Automatic: registered idempotent sync only. No nested model/error-supplied commands; unknown/protected/decisions need owners.

Exhaustion stops automation, not manual repair. Show preservation/risk/successor routes; no auto-submit/approve, unchanged retry, journal resets, fake passes or stash/discard/force-push.
