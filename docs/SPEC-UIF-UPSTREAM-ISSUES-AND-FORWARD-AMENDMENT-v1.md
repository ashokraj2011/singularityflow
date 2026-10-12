# Singularity Flow Upstream Issues, Plan Corrections and Forward Amendment

**Specification ID:** `UIF-v1`

**Status:** Accepted for implementation (owner decision, 2026-10-12)

**Version:** `0.2.0`

**Date:** 2026-10-12

**Related work:** [Phase self-repair analysis](PHASE-SELF-REPAIR-ANALYSIS.md) (Tier C, items C1, C2,
C3), narrow plan amendments (`plan-amendments.mjs`, E2G-012), evidence-contract corrections
(`plan-evidence-amendments.mjs`), intent amendments (`state.mjs`, `amendment.mjs`), selective
preservation for skill-version adoption (`lifecycle-transitions.mjs`).

## 1. Decision

A later phase that finds a defect in an earlier, approved phase must be able to keep working while
the earlier phase's owners decide what to do, and the fix must not rewind the Story unless the
owners choose a return. Three capabilities provide this:

1. **Upstream issues (C1):** any participant, including the phase's governed agent, raises an issue
   against an earlier phase from any phase status. Raising never blocks. The earlier phase's
   approvers decide: plan correction, forward amendment, return, accepted risk, or dismissal.
2. **Plan corrections (C3):** the plan's approvers correct an approved plan in place, adding a
   missing row or test, and removing or replacing a wrong path, as an append-only overlay that
   every plan reader applies. No phase is reset.
3. **Forward amendment (C2):** the earlier phase's approvers approve a corrected artifact as a new
   approved generation of that phase without re-running it. Downstream phases keep their approval
   and are marked for **revalidation** instead of being reset. Revalidation is a decision (unchanged,
   correction or return) that must be recorded before the Story completes.

## 2. Invariants

1. No agent approves anything. Raising is open; every decision needs the owning phase's authority,
   checked the way approvals are (`approval-authority.mjs`).
2. Every record is append-only, committed in the Story aggregate, published with a lifecycle
   `decision_made` event, and bound to exact digests (owner generation, map or artifact bytes,
   prior row).
3. An approved artifact is never edited in place. Plan corrections overlay a plan; forward
   amendments create a successor generation; the previous generation stays in history.
4. Raising an upstream issue never refuses the current phase. Only completion requires every issue
   and every revalidation to be decided.
5. The current phase keeps its draft through every outcome, including a return.
6. Existing behaviour is unchanged for Stories that use none of this.

## 3. Upstream issues (C1)

### 3.1 Record

Two append-only lists. `workflow.upstreamIssues[]` holds each issue as raised; `workflow.upstreamIssueDecisions[]`
holds each decision, naming its issue. An issue is never edited, so every raise and every decision
is one appended entry: a single decision commit, which may sit between a step's submission and its
approval without staling either (`state.mjs` decision-commit classification). Each issue:

| Field | Meaning |
|---|---|
| `id` | `UPI-NNN` |
| `phase` | The earlier phase the issue is about (must precede the raising phase in `phaseOrder`) |
| `raisedIn` | The phase current when raised, and its status |
| `about` | Clause ID or section, at most 200 characters |
| `problem`, `assumption`, `impact` | Text, `problem` 20 to 1,000 characters |
| `proposed` | `plan-correction`, `amend`, `return`, `accept-risk` or `unknown` |
| `producerGeneration`, `producerArtifacts` | What the issue was raised against (artifact paths and digests) |
| `source` | For `--from-artifact`, the artifact path and the item digest that makes raising idempotent |
| `raisedBy`, `authored`, `agent` | Git identity; `human` or `governed-agent`; the session's agent as audit context |
| `at` | Timestamp |

Each decision is `{ issue, outcome, reason, link, expiresAt, actor, authorityGroup, identityAssurance,
at }`. An issue's latest decision applies; an expired accepted risk reopens it.

Outcomes: `plan-correction` (link to a plan correction id), `amend` (link to a forward amendment
id), `return` (link to the change request), `accept-risk` (with `expiresAt`, at most 90 days), and
`dismiss`.

### 3.2 Commands

- `upstream-issue raise --phase <earlier> --about <id|section> --problem <text> [--assumption]
  [--impact] [--proposed <kind>] [--authored governed-agent]`. It may run from any status of the
  current phase.
- `upstream-issue raise --from-artifact [--phase <current>]` creates one issue per item under
  `## Upstream discrepancies` that names an earlier phase. It is idempotent per item text.
- `upstream-issue list [--open]` (read-only).
- `upstream-issue decide <UPI> --outcome <outcome> --reason <text> [--expires <date>]
  [--link <id>]`. It is decided by the earlier phase's approvers.
  - `return` performs the return (3.3).
  - `plan-correction` and `amend` require the linked record to exist and target the same phase.

### 3.3 Return from any status

`decide --outcome return` resets the range from the earlier phase (`resetPhaseRangeForRework` with
`retain: true`) and records a change request, exactly as `reject --to` does today, but:
- it is available while the current phase is `in_progress`;
- it is authorized by the earlier phase's approvers;
- it keeps the current phase's working files (rework never deletes them).

Repair budgets still apply.

### 3.4 Visibility and completion

- Open issues appear in `status`, `nextsteps`, the phase review (submit and approve), and the entry
  packet's upstream summary.
- Completion requires every issue to be decided: terminal readiness reports
  `UPSTREAM_ISSUES_OPEN` with the exact `decide` command for each.
- An `accept-risk` decision expires: an expired one counts as open.

## 4. Plan corrections (C3)

### 4.1 Record

A new entry kind in `workflow.planAmendments[]`, alongside the existing narrow amendments and
evidence corrections:

```json
{ "id": "PRC-NNN", "kind": "plan-row-correction", "ownerPhase": "planning", "ownerGeneration": 1,
  "ownerMapSha256": "<sha>", "operations": [ ... ], "reason": "...", "actor": "...",
  "authorityGroup": "...", "identityAssurance": null, "at": "...", "upstreamIssue": "UPI-001" }
```

Operations:

| Operation | Effect | Binding |
|---|---|---|
| `add-row { clauseId, expectedPaths[], tests[], fulfillment }` | Adds a row for an approved clause the plan omitted | The clause is active and has no row |
| `add-test { clauseId, test }` | Adds a planned test to a row | `previousClaimSha256` of the row |
| `remove-location { clauseId, path }` | Removes a wrong expected path | `previousClaimSha256`; never the last path of a row that needs one |
| `replace-location { clauseId, from, to }` | Removes one path and adds another | `previousClaimSha256` |

### 4.2 Application

`applyPlanRowCorrections(record, workflow)` is applied by the shared plan reader next to
`applyPlanEvidenceAmendments` (`specifications.mjs` `readBoundSpecificationClaimMap` and
`withAmendmentRecord`, and the evidence graph). A correction applies only to the exact owner
generation and map digest; a later approved plan supersedes it. Rows changed by corrections are
judged by every consumer (coverage, delivery evidence, terminal gate) as if the plan had said so.

### 4.3 Command and authority

`decision plan` gains `--add-row <clause>=<path>[,<path>]` (with `--test <path>` and
`--fulfillment`), `--add-test <clause>=<path>`, `--remove-location <clause>=<path>` and
`--replace-location <clause>=<from>:<to>`. Authority: the owner plan phase's approvers
(`evidenceOwnerAuthorities`), confirmed in a live terminal review of the exact rows before and after
(`captureTerminalActionAuthorization`), because a correction can remove an obligation; the record
keeps `authorizationId` and `reviewAssurance: live-terminal-exact-plan-review`. A script or a
governed agent cannot record one. `--dry-run` validates and shows the correction without recording.
A correction and a narrow amendment are separate decisions. The decision commit is recognized like
other plan decisions (`state.mjs` decision-commit classification, list `planAmendments`).

Evidence corrections and row corrections each pin the row they replace as the readers showed it when
they were decided, so the readers replay both kinds together in recorded order
(`applyPlanCorrections`). Every touched row is re-validated with the plan's own row normalizer, and
the whole corrected plan against approved verification intent, before anything is recorded. A row
proven without executable tests (`non-test`) cannot gain a test this way.

## 5. Forward amendment (C2)

### 5.1 Scope

Any approved artifact phase that is not a code phase, including the scope step (which today's
intent amendment already covers). Code phases change through their own generations.

### 5.2 Flow

1. **Propose.** `story amend propose --phase <P> --reason <text> [--upstream-issue <UPI>]` captures
   the edited artifact bytes of `P` from the working tree. The command refuses if no byte changes
   or another proposal for `P` is pending. It records the exact old and new digests and, for clause
   phases, the clause diff.
2. **Decide.** `story amend decide <FAM> --decision approve|reject --reason <text>`, by `P`'s
   approvers. Approval creates generation `g+1` of `P` with the new bytes, approved by the decision
   (no authoring run, no new review packet beyond the amendment record), and re-pins every
   downstream input binding that pointed at `P`'s previous generation.
3. **Revalidation.** Every downstream phase that consumed `P` (declared inputs, planned-claim
   ownership or clause dependencies) gets `revalidation: { amendment, required: true }` and keeps
   its status:
   - an approved phase stays approved;
   - the current phase continues, and its next composition uses the new input (prompt recompose).
4. **Resolve.** `story amend revalidate <phase> --outcome unchanged|corrected|return --reason`, by
   that phase's approvers:
   - `unchanged` records that the phase still holds;
   - `corrected` links a plan correction or a later amendment;
   - `return` performs a return to that phase (3.3).

### 5.3 Completion

Terminal readiness reports `AMENDMENT_REVALIDATION_REQUIRED` for each unresolved revalidation, with
the exact command. The final gate's approval-staleness check accepts an approved phase whose input
was re-pinned by an approved amendment once its revalidation is resolved.

### 5.4 Relation to intent amendment

Intent amendment remains for scope-step changes proposed from phase feedback. The shared
successor-generation code is factored out so both create an approved successor the same way;
forward amendment differs only in revalidating instead of resetting.

## 6. Prompts and routes

- The authoring contract's upstream discrepancy protocol names `upstream-issue raise --from-artifact`
  as the way to file recorded discrepancies.
- The phase review lists recorded discrepancies with the raise command, and open issues with their
  decide command.
- Refusal remediation for upstream-caused codes offers `upstream-issue raise` alongside restore.
- Final-gate recovery on an open Story offers `upstream-issue raise` for each owner phase instead
  of `reopen`.

## 7. Acceptance

1. A Story in implementation raises an issue against planning, keeps working, and completes after
   planning's approvers record a plan correction that adds the missing row; no phase is reset.
2. The same Story raises an issue against the specification; its approvers approve a forward
   amendment.
   - Planning and implementation keep their approvals and get revalidation.
   - Planning's approvers record `unchanged`.
   - Implementation is corrected by its next generation.
   - Completion succeeds only after both are resolved.
3. A `return` decision from an in-progress phase resets from the earlier phase, keeps the current
   draft, and respects repair budgets.
4. Every decision refuses without the owning authority, with a stale binding, or when the target is
   not earlier. Every record verifies after a fresh clone.
5. Stories that use none of these features keep their exact aggregate shape and behaviour.

## 8. Delivery

| Milestone | Content |
|---|---|
| UIF-M1 | Plan corrections (C3): record, reader application, `decision plan` options, tests |
| UIF-M2 | Upstream issues (C1): record, raise, list, decide (except `amend`), return from any status, completion check, visibility |
| UIF-M3 | Forward amendment (C2): propose, decide, successor generation, re-pinning, revalidation, completion check, intent-amendment factoring |
| UIF-M4 | Prompt, review and remediation routes (section 6) |
