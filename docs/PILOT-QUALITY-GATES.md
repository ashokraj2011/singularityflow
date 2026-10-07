# Pilot quality gates and recorded risk

Scope appeals account for exact extra paths in an editable generation. They do not waive an approval's missing-coverage check. Appeal preflight now reads that check too, so a submitted generation cannot appear ready merely because recovery has nothing to repair.

## Choose at Story intake

The VS Code intake form offers **Hard** (default) and **Pilot soft**. CLI/Copilot intake can use `singularity-flow start STORY ... --gate-mode soft`. The selected mode is pinned into the immutable Story creation policy and the intake receipt. Changing the UI selection invalidates the preview.

Soft mode alone skips nothing. The registered pilot exception is **missing implementation coverage** at an open, published or submitted code-delivery phase, including custom phase names and future workflow definitions. An approved phase's expired exception can also be renewed on an active Story. Failed tests and document exceptions retain their existing test-policy/recovery routes. Unknown gates require their owning repair route, not automatic acceptance.

## Existing Story: preserve its publication

In the attached Story checkout:

```sh
singularity-flow appeal preflight --phase implementation --json
singularity-flow appeal risk-prepare --phase implementation --gate-mode soft --expires YYYY-MM-DD --reason "Explain the missing coverage and why the pilot may proceed" --json
```

Review the exact clauses, generation/candidate, policy/claim hashes, expiry and transitions. An editable candidate is bound to its generation-start baseline and exact application/test/evidence bytes; its packet covers publication only. After publication, preview and accept retained coverage afresh: the published packet defaults to submission, approval, downstream consumption and terminal implementation coverage. No draft exception silently approves published evidence. Narrow a published packet with repeated `--clause EXACT-ID` or `--transition submit|approve|consume|terminal` if appropriate.

For a newly published generation, submission first runs required tests and creates its observed claim map. Until then, risk preflight reports `pending-submission-evidence` and the ordinary submit route; it cannot create a retained-evidence exception prematurely. After submission, fresh human risk review is required before approval can accept remaining coverage gaps.

This also applies after rejection and a successor publication. Older observed claim maps remain immutable audit evidence, not the successor's live binding. Builds written before this correction can retain an older pointer: the updated CLI authenticates that exact historical pointer and the current pending publication, then creates fresh evidence through ordinary submission. It never relabels an old passing result, changes published application bytes, or requires an unpublished generation-three prompt for a published generation two. Changed, forged or current-generation invalid bindings still require integrity recovery rather than risk acceptance.

An authorized human then runs **in a real terminal**:

```sh
singularity-flow appeal risk-accept --phase implementation --gate-mode soft --expires YYYY-MM-DD --reason "The same reviewed reason" --confirm PACKET_SHA256 --json
```

Type the exact confirmation shown by the terminal. This records/publishes an append-only human decision; it does not approve or advance the phase, alter source, rewrite a publication, run tests or claim the missing screenshot was verified. Re-run preflight, then explicitly perform the returned submission/approval route. Copilot uses `/sf-appeal` for preview and must relay human-only acceptance, not impersonate consent.

`--gate-mode soft` on an existing hard-mode Story is explicitly reviewed phase-local enrollment; the original pinned policy remains unchanged. The acceptance is bounded to its exact generation, policy, claims, unmet observation and selected transitions. An expiry is required (at most 90 days). New evidence/generations require new review; unrelated passing tests never establish visual correctness.

## Audit and recovery

Preflight returns accepted/remaining clauses, identity, reason, expiry, decision hash and status. Approval retains the active risk IDs. Governance and the evidence matrix retain the missing obligation as **excepted / accepted-risk**, never satisfied proof; verification obligations still need their own evidence. A completed Story with active exceptions is labelled complete-with-exceptions.

After clone/key loss, preflight exposes `needs-reattestation`. An authorized human can re-review the retained record with `appeal risk-attest PQR-ID --confirm DECISION_SHA256`; no historical bytes are rewritten. To withdraw it, use `appeal risk-revoke PQR-ID --reason "Explain withdrawal" --confirm DECISION_SHA256`. Revocation does not retroactively undo an approval but prevents later consumption/closure from relying on the revoked exception.

The Git decision history is checked append-only: deleting a revocation from committed JSON cannot revive an earlier acceptance. An expired exception requires a fresh expiry and review; a revoked packet requires a fresh reviewed reason or expiry, not re-attestation. Acceptance/revocation commits own only `workflow.json` and `STATUS.md`, leaving unfinished artifacts and an unrelated staged index untouched.

## Always hard

Identity/authority, protected governance edits, unaccounted source scope, invalid/forged/stale evidence, publication provenance, lifecycle ordering, required independent reviews and required tests are not covered by this exception. Use the registered repair/plan amendment/configuration authority/test-risk route. Neither a soft flag, a hand-edited JSON record, a hash alone nor a model's approval counts as human consent.
