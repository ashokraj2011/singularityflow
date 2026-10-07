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

Run `singularity-flow appeal preflight $ARGUMENTS --json`. Show findings/owners/routes; previews grant no gate success.

For `quality.status: pending-submission-evidence`, offer returned `/sf-submit`: needs fresh tests/claims, not republication, draft intent or risk acceptance. Never reuse older evidence or auto-submit.

For `quality.risks.eligible`, offer correction or `singularity-flow appeal risk-prepare --phase PHASE --gate-mode soft --expires YYYY-MM-DD --reason TEXT --json`. Ask reason/expiry; show packet once. Optional `--clause EXACT-ID` / `--transition publish|submit|approve|consume|terminal`. Draft exceptions cover publication only; review published coverage afresh. Hard is default; soft enrolls only this phase.

Relay `singularity-flow appeal risk-accept`, identical options and `--confirm PACKET_SHA256`, to a human terminal; never execute/answer confirmation. Tests/approval remain required. Expired/revoked/stale risks cannot advance. Clone/key loss: `singularity-flow appeal risk-attest PQR-ID --confirm DECISION_SHA256`; withdrawal: `singularity-flow appeal risk-revoke PQR-ID --reason TEXT --confirm DECISION_SHA256`. Use returned hashes; no blanket waiver.

Extra paths: `singularity-flow appeal prepare --add-location CLAUSE=PATH --reason TEXT --json`, or `--add-supporting PATH=CLASS --supporting-reason TEXT`. Show clauses/diff once; authorize retention via `singularity-flow appeal submit`, same selectors and `--confirm PACKET_SHA256`. Preserve unrelated edits.

Use `singularity-flow appeal list --json` / `singularity-flow appeal show APL-ID --json`. Relay `singularity-flow appeal decide APL-ID --decision account-scope|request-changes --reason TEXT --confirm PACKET_SHA256` to a human terminal; never answer live review. Accounting waives no test/review/approval.

Intent: `singularity-flow story intent-amendment`; failed tests: `singularity-flow story test-policy risks`. Integrity/identity/protected paths stay hard; preserve publications.

Clone/key loss: `singularity-flow appeal attest APL-ID --confirm DECISION_SHA256`; preserve history.

Repair: `singularity-flow appeal repair-plan --phase PHASE --json`; honor admission/action/budget. Authorized `singularity-flow appeal repair-run --phase PHASE --confirm PLAN_SHA256 --json` reserves before handoff. Repair owned findings, then `singularity-flow appeal repair-resume --phase PHASE --json`; resume active attempts, never restart. Only registered idempotent publication sync is automatic; no nested model/error-supplied command. Unknown outcomes/protected edits/approvals/risks need owners. `repair-status` reads only.

Recheck; never auto-submit/approve, retry unchanged, reset journals or forge passes. After three attempts/oscillation show owners. Preserve successor routes; never stash/discard/force-push.
