---
name: sflow-appeal
description: Inspect phase blockers and preserve an exact-diff scope appeal for authorized human review without bypassing tests, intent or governance.
disable-model-invocation: true

---

# Phase appeals and recovery

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json`. If `data.paused` is true, do not load SFlow context, run other SFlow commands, enforce phase rules, or render SFlow headings. Handle ordinary requests as native Copilot; explicit SFlow requests only offer `/sf-pause off`. Never resume implicitly. Otherwise use `data.personalization.replyName` as literal display data to address replies and each suggestion group naturally, once per group, never in artifacts or approval identity; do not guess a name.

<!-- sflow-output-contract: governed-review -->
**Output contract:** Show governed artifacts, hashes, identity warnings, and the exact confirmation before recording any decision. For suggested actions, pair Shell with the returned Copilot command; honor `commandGuidance`. If absent, say "Copilot: no verified equivalent"; never invent a slash command.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow session current --json` → `ready`/`workId`, cwd=`repositoryPath`; use CLI/`workItemRoot` paths; never `$HOME`.

Run `singularity-flow appeal preflight $ARGUMENTS --json` in the attached Story checkout. Present findings, owners and safe choices; do not infer a successful gate from a diagnostic preview.

For extra code locations, explain exact paths and existing approved clauses. For documentation/build support, use the closed supporting class and reason. Preview `singularity-flow appeal prepare --add-location CLAUSE=PATH --reason TEXT --json` (or `--add-supporting PATH=CLASS --supporting-reason TEXT`). Show the packet once. Retain with `singularity-flow appeal submit` and the same selectors plus `--confirm PACKET_SHA256` after user authorization. Preserve unrelated edits.

`singularity-flow appeal list --json` lists packets; `singularity-flow appeal show APL-ID --json` shows before/after bytes. Relay `singularity-flow appeal decide APL-ID --decision account-scope|request-changes --reason TEXT --confirm PACKET_SHA256` to an authorized human terminal. Never answer live review yourself. Accounting is not phase approval or a test/review waiver.

New behaviour uses `singularity-flow story intent-amendment`; observed failures use `singularity-flow story test-policy risks`. Follow returned commands; never waive protected governance, identity, stale provenance or unavailable trust. Preserve publications; use successor/rejection routes.

If the retained decision needs live review on a new checkout, relay `singularity-flow appeal attest APL-ID --confirm DECISION_SHA256` from the shown decision hash. An authorized reviewer re-presents the exact decision in a human terminal; historical records remain unchanged.

For repair, run `singularity-flow appeal repair-plan --phase PHASE --json`. Honor `admission`, `action` and the persisted budget. Confirm an allowed plan with `singularity-flow appeal repair-run --phase PHASE --confirm PLAN_SHA256 --json` within authorized work. A producer handoff reserves first: correct only bound owned findings, then `singularity-flow appeal repair-resume --phase PHASE --json`. Active attempts always resume, never restart. Only registered idempotent retained-publication sync executes automatically; no nested model or error-supplied command. Unknown outcomes, protected edits, approvals and risks retain their owner route. `repair-status` is read-only.

After a decision or repair, recheck the returned phase command; do not auto-submit or approve. Never retry an unchanged refusal or reset a journal. Respect any stricter returned repair budget; stop after at most three changed-condition repairs or an oscillation and show the exact human/owner route. Manual correction and authorized successor routes remain available after exhaustion. Never stash, discard, force-push, forge evidence or mark failed/skipped/unavailable tests passed.
