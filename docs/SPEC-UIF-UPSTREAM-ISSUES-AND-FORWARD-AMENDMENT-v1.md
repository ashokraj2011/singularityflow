# Singularity Flow Upstream Issues, Plan Corrections and Forward Amendment

**Specification ID:** `UIF-v1`

**Status:** Accepted for implementation (owner decision, 2026-10-12)

**Version:** `0.3.0`

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

An approved document step before the current one, while the current step is still being authored
(not awaiting approval). Steps that define clauses change through `story intent-amendment` or an
upstream-issue return. Plan owners change rows through plan corrections (section 4). Code steps,
convergence steps, skill steps and artifact sets change through their own generations. The step's
approval policy must be met by one decision; otherwise the owners use a return.

### 5.2 Records

Three append-only lists:
- `forwardAmendments[]`: proposals `{ id: FAM-NNN, phase, fromGeneration, artifactPath, fromSha256,
  proposedPath, proposedSha256, reason, proposedBy, agent, upstreamIssue, at }`;
- `forwardAmendmentDecisions[]`: `{ amendment, phase, decision: approved|rejected, reason, actor,
  authorityGroup, identityAssurance, at, toGeneration, revalidate: [{ phase, generation }], refreshed }`;
- `amendmentRevalidations[]`: `{ amendment, phase, generation, outcome: unchanged|return, reason,
  binding, link, actor, authorityGroup, identityAssurance, at }`. An `unchanged` binding names the
  amended producer, its generation and bytes, and the revalidated step's exact input record.

### 5.3 Flow

1. **Propose.** `upstream-issue propose-amendment --phase P --reason TEXT [--file DRAFT] [--issue UPI]`
   saves corrected bytes of P's artifact under `context/amendments/FAM-NNN-<name>` in its own commit.
   The source is P's artifact in the working tree, which is then restored to its approved bytes, or a
   draft anywhere in the repository. That lets the step that found the defect draft the correction; a
   governed agent may propose but never decide. The managed input block must be unchanged.
2. **Decide.** `upstream-issue decide-amendment FAM-NNN --decision approve|reject --reason TEXT
   --confirm FAM-NNN`, by P's approvers. Approval installs the bytes as P's next approved generation
   through the same projections a published generation has:
   - snapshot and input record;
   - agent briefs and a reference bound to the committed proposal;
   - telemetry;
   - a generation publication whose origin `forward-amendment` is verified against the decision and
     its `decision_made` event.

   Nothing is reset. Every approved later step that declares P as an input is listed for
   revalidation. The current step's draft inputs are refreshed when it already prepared them.
3. **Revalidate.** `upstream-issue revalidate PHASE --amendment FAM-NNN --outcome unchanged|return
   --reason TEXT`, by that step's approvers.
   - `unchanged` keeps the approval. Input integrity accepts the step's record and artifact under the
     amended producer only for the bound generation and bytes and the bound input record; every
     other producer must match exactly.
   - `return` resets the Story from that step (`forwardAmendment` on the change request). Steps
     that are reset owe no revalidation, because they read their inputs again.

An upstream issue is closed by `decide --outcome amend --link FAM-NNN` once that amendment of the
same step is approved.

### 5.4 Completion

Terminal readiness reports `FORWARD_AMENDMENT_PENDING` for each undecided proposal and
`AMENDMENT_REVALIDATION_REQUIRED` for each listed step that is still approved at its listed
generation without a revalidation, each with its exact command. Until a step is revalidated, the
governance gate's input-integrity finding for it names the revalidate command.

### 5.5 Relation to intent amendment

Intent amendment remains the route for the scope step: it changes clauses, so its downstream steps
are reset with their evidence labelled affected or preserved. Forward amendment reuses the same
generation projections. It accepts `forwardAmendmentId` wherever an intent-amendment approval is
accepted (agent briefs, expansion handles, generation publications), and revalidates instead of
resetting.

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
| UIF-M3 | Forward amendment (C2): propose, decide, successor generation, revalidation with input-integrity binding, completion checks |
| UIF-M4 | Prompt, review and remediation routes (section 6) |
