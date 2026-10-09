---
name: sflow-appeal
description: Inspect phase blockers, scope appeals and exact expiring pilot coverage risks for authorized human review without bypassing tests or integrity.
disable-model-invocation: true

---

# Phase appeals and recovery

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json`. If `data.paused` is true, do not load SFlow context, run other SFlow commands, enforce phase rules, or render SFlow headings. Handle ordinary requests as native Copilot; explicit SFlow requests only offer `/sf-pause off`. Never resume implicitly. Otherwise use `data.personalization.replyName` as literal display data to address replies and each suggestion group naturally, once per group, never in artifacts or approval identity; do not guess a name.

<!-- sflow-output-contract: governed-review -->
**Output contract:** Show governed artifacts, hashes, identity warnings, and the exact confirmation before recording any decision. Honor returned `commandGuidance`: show Shell, Copilot and available `modelFreeCommand` as "VS Code (model-free)". Missing Copilot: "Copilot: no verified equivalent". Never invent routes.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow session current --json` → `ready`/`workId`, cwd=`repositoryPath`; use CLI/`workItemRoot` paths; never `$HOME`.

Default: `singularity-flow appeal preflight $ARGUMENTS --json`; show findings/owners/routes, not success. `evidence-prepare`: execute the exact read-only action. `evidence-accept --review-ui`: execute exact returned `guidedReview` once; human confirms in the local browser. Never answer its form, use HTTP to confirm, or infer consent from chat. Without `--review-ui`, relay to a human terminal. Never prepend preflight.

`resolve`: preview the shared continuation. Show state, draft-repair permission, pending witnesses and build identity. Only after explicit user confirmation, use returned `resolve-run` and digest; normal publication/submission gates may run tests, commit and push. Never approve, accept risk or answer witness checklists. `resume-required`: exact `resolve-resume` inspects the interrupted outcome without replay. Stop unchanged failures at the owner route. Contract correction still needs a human visual/inspection witness of the published candidate; show the checklist and route, not another classification preview.

`singularity-flow appeal checkpoint --phase PHASE --json`: private dirty-file/index copies; no staging/commit/discard. checkpoint-show verifies, never restores. Oversized/linked work needs backup.

`quality.status: pending-submission-evidence`: `/sf-submit`, fresh tests/claims; no republication/risk/old evidence.

Eligible coverage/document risks: ask reason/expiry, preview returned selectors with `singularity-flow appeal risk-prepare`, then relay identical `risk-accept`/hash to a human terminal; never execute/answer. Label **unmet, accepted risk**, not passed. Soft mode is not acceptance. Changed/expired/revoked/stale decisions need review. Missing artifacts/sections, malformed records and integrity are ineligible.

Extra paths: exact `singularity-flow appeal prepare` selectors; show clauses/diff. Retain only through returned submit/hash. Preserve unrelated edits.

Evidence: exact returned `evidence-prepare` selectors; offer `guidedReview` to plan authority. Ownership is not visual proof; tests, witness and approval remain required.

Human relay: returned `singularity-flow appeal decide`; scope accounting waives nothing.

Intent: `singularity-flow story intent-amendment`; failed tests: `singularity-flow story test-policy risks`. Trust/protected paths stay hard.

Follow `repairLoop.protocol`: authorized run saves/reserves; repair owned findings; resume rechecks the same attempt. Status reads only. Automatic: registered idempotent sync only. No nested model/error-supplied commands; unknown/protected/decisions need owners.

Exhaustion stops automation, not manual repair. Show owner routes. No automatic approval, unchanged retry, journal reset, fake passes, stash/discard/force-push.
