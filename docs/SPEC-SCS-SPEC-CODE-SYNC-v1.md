# Spec–code sync (SCS) — v1

Status: owner decisions recorded 2026-11-08 (every recommended default taken). M1 to build first and land on main; M2, M3 and M4 to build on a separate branch.

The code and the approved documents must say the same thing. When they don't, a person decides each
difference once: either the code changes to match the document, or the document changes to match the
code through its own approvers. Nothing overwrites an approved document. Much of this exists on main
48668471f. This spec closes the gaps that remain, without adding a step to any workflow.

## Owner decisions (2026-11-08)

The owner took every recommended default below.

1. **Deviated and unplanned conformance verdicts hold the conformance step's approval,** as partial
   and missing already do. *Decided: yes.*
2. **"Accept for now" on a gap** is the existing accepted risk: a reason and an expiry of at most 90
   days, decided by the approvers of the step that owns the clause, as an upstream issue's risk is
   today. *Decided: yes, with no permanent accept. A difference that should stay goes through
   "Update the spec".*
3. **What a person types after `/sf-code` or `/sf-phase` is recorded in the Story,** secrets redacted
   and size-bounded. A capability can turn this off. *Decided: on.*
4. **Each recorded `/sf-code` instruction is accounted for at prepublish,** as in-plan (with its
   clauses) or as a departure. An unaccounted instruction holds the code step's approval and never
   publish. *Decided: yes.*
5. **Convergence items join the one decisions list.** The Adjudicate page and `/adjudicate` stay
   for a release as filtered views, then are retired. *Decided: yes.*
6. **Quick-fix, careful-change, poc-lite, poc-workflow, document-test-repair and the demo loops stay
   unchanged.** *Decided: yes.*

## What exists today (main 48668471f)

| Path | Where | Code follows spec | Spec follows code |
|---|---|---|---|
| Departures in the code step `[CQF:REQ-020]` | every code step | rejecting a departure; the model reverts it | accepting writes a plan amendment, plan row correction, forward amendment (wording) or intent amendment (clause) |
| Prepublish traceability | every code step | missing `@clause`/`@ac` tags and planned tests are refused and repaired; unplanned files become path departures | — |
| Conformance step: the model writes a spec-to-code report, one verdict per clause | feature, bugfix, chore, findings-remediation, figma-mobile, classic-delivery, spec-code-test-loop, benchmarking-a/-b | **partial**/**missing** verdicts are decision items: raise an upstream issue, return to the owning step, reuse a recorded run, or return to the code step for a fresh run | through an upstream issue whose approvers choose `amend`, then a hand-written forward amendment |
| Convergence and adjudication `[SPK:REQ-070]` | spec-driven-standard, reference-driven-build | `rework` | `update-intent`, then `story intent-amendment draft` (one slot per clause) |
| Intent amendment | every workflow after scope approval | — | `story intent-amendment propose` (also `/sf-reject intent-amendment`) |
| Forward amendment and revalidation `[UIF]` | every workflow | — | `upstream-issue propose-amendment`; later steps revalidate (`unchanged`) or return |
| Spec drift | closed Stories | `spec drift decide --restore --story` | `--adopt --story` |

Every approval gate checks that each approved input still has the bytes it was approved with
(`gate.inputs.integrity`). An earlier document edited in place stops approval.

## Gaps

- **G1. A deviation can pass unseen.** `conformanceVerdictGaps` (src/conformance-verdicts.mjs) turns
  only `partial` and `missing` into decision items. A row the model marks `deviated` or `unplanned`
  holds nothing, and its Deviation cell may be empty. A typed instruction that changes behaviour
  inside planned files ends here.
- **G2. "Update the spec" takes three steps for a conformance gap:** raise an upstream issue, its
  approvers choose `amend`, then someone writes the amended document by hand. Convergence already
  drafts the amendment; conformance does not.
- **G3. Two decision tables.** Departures, conformance gaps, upstream issues and amendments are in
  the decisions list (`/sf-decide`, the VS Code decisions card). Convergence items are only in the
  Adjudicate table (`story adjudicate`, `/adjudicate`).
- **G4. What the person asked for is not recorded.** The prompt hook reads only the leading `/sf-…`
  name, and SF Guard keeps a hash. The approver and the conformance author cannot see that someone
  typed "make the timeout 10s".
- **G5. A typed instruction that changes a requirement depends on the model noticing.** The
  `/sf-code` skill says to record a clause departure, but nothing asks the model to account for each
  instruction.

## Model

A **difference** is one clause where the code and an approved document disagree:
- a conformance row with a verdict other than `matched`;
- a convergence item;
- a departure;
- a recorded instruction (M4) that has not been accounted for.

A person picks one of these for each difference, and each choice writes only records that exist today:

| Choice | Records written | Decided by |
|---|---|---|
| **Fix the code** | return to the code step (`reject --to`), or convergence `rework` | the step's approvers |
| **Update the spec** | an intent amendment of the Story's scope (`story intent-amendment draft --clause`, then `propose`): the step that defines clauses changes only this way, and a forward amendment refuses it. For a document step's wording, a forward amendment proposed for an upstream issue. Convergence `update-intent` | the scope step's approvers (a document step's own approvers for its wording) |
| **Accept for now** | accepted risk on the upstream issue, with a reason and an expiry of at most 90 days | the approvers of the step that defines the clause (the scope step) |
| **The verdict is wrong** | `dismiss` with a reason; the report's next generation corrects the row | the approvers of the step that defines the clause (the scope step) |

## M1 Every disagreeing verdict is a decision `[SCS:REQ-010]`

Built 2026-11-08. New Stories pin `spec.conformanceDifferences: decide`. A Story pinned before the field
existed reads as `legacy` and keeps partial and missing only, so no approved report is held by an upgrade.

- `[SCS:REQ-010]` `deviated` and `unplanned` rows become decision items, as `partial` and `missing`
  are. Approval of the conformance step and the terminal gate hold until each is decided. Publishing
  the report is not held.
- `[SCS:REQ-011]` A `deviated` or `unplanned` row states what differs in its Deviation cell. The
  draft check refuses an empty cell for these verdicts, and the model repairs it in the same turn.
- `[SCS:REQ-012]` Each item offers the four choices in the Model table, with the existing authority rules. A
  difference is owned by the scope step; fixing the code returns to the code step. An intent or forward
  amendment waiting for its approvers holds the row as *amending*: it still holds approval, and the
  amendment is its own item in the list.
- `[SCS:REQ-013]` An `unplanned` row whose paths an accepted departure already covers is decided by
  that departure. It is shown as decided, with the departure's ID, never asked twice.
- `[SCS:REQ-014]` A `deviated` row on a clause an approved intent or forward amendment already
  changed is shown against the amended text. The report's next generation re-judges it, as convergence's
  `verdict-against-superseded-clause` does.

## M2 "Update the spec" in one choice `[SCS:REQ-020]`

Built 2026-11-08 on the M2 branch. The choice is recorded like any other on the decisions card, the Copilot CLI
`/sf-decide` forms and the terminal table, with a reason, and writes only the draft: no record, no decision. The
draft is the Story's own draft file beside the checkout's Git data
(`<git dir>/singularity-flow/intent-amendment-drafts/<WORK-ID>.md`), the one file a `/sf-reject` turn may
edit, never committed until `propose`. A note beside it says which clauses it holds and which scope bytes it
was built from. With that note, the list says where the draft is and that writing and proposing it is next.
The list never writes over a draft someone changed.

- `[SCS:REQ-020]` Choosing **Update the spec** drafts the intent amendment for the clause without a
  command to copy. In M1 the choice is the `story intent-amendment draft --clause` command. The draft is
  built from the approved bytes, model-free, with one marked slot per clause holding:
  - the verdict;
  - the Deviation cell;
  - the person's reason.

  This is the slot format of src/intent-amendment-draft.mjs.
- `[SCS:REQ-021]` A person, or the Story's agent in `/sf-phase` on the owning step, writes the wording.
  `propose` refuses while a slot is left, as it does today.
- `[SCS:REQ-022]` The owning document's approvers decide the amendment.
  - An approved amendment makes a new generation of that step.
  - Every later step that reads it gets a revalidation row in the same decisions list: still holds,
    or return.
  - The conformance step is always one of these, and its approver confirms the report or returns it
    for a new one.
- `[SCS:REQ-023]` The difference is decided once the amendment is approved. Until then it holds
  approval and names who clears it.

## M3 One decisions list `[SCS:REQ-030]`

- `[SCS:REQ-030]` Convergence items appear in the decisions list as kind `convergence-item`, with
  the dispositions `rework`, `update-intent`, `accepted-deviation`, `dismissed` and `deferred`. They
  are written by the existing `story adjudicate --answers --expect` path.
- `[SCS:REQ-031]` One problem is one item. A convergence item, a conformance row, a departure and an
  upstream issue naming the same clause and the same difference are shown once, as the list already
  merges a conformance gap with its issue.
- `[SCS:REQ-032]` The list appears on:
  - the VS Code decisions card;
  - the Copilot CLI `/sf-decide` forms;
  - the terminal table.

  A step only a person may take stays that way: the card runs the CLI outside the chat's shell, and
  no chat turn records it.
- `[SCS:REQ-033]` The Adjudicate page and `/adjudicate` show only convergence items for one release,
  then are retired (owner decision 5).

## M4 What the person asked for `[SCS:REQ-040]`

- `[SCS:REQ-040]` The prompt hook keeps the text a person types after `/sf-code` or `/sf-phase`:
  - a person's prompt only, never a subagent's task;
  - secrets removed by the diagnostic redactor;
  - at most 2,000 characters per turn and 20 turns per generation;
  - in the local turn record.

  It works on VS Code Copilot Chat and Copilot CLI. IntelliJ is parked.
- `[SCS:REQ-041]` Prepublish copies the recorded text into the generation's record as **Asked for**,
  committed with the Story. A capability's `policy.typedFocus: off` turns recording off.
- `[SCS:REQ-042]` In a code step each recorded instruction is accounted for before the step's approval:
  - `within-plan` with the clause IDs it implements; or
  - a departure ID.

  The model states this with one command a `/sf-code` turn may run
  (`departure account --instruction N (--clauses ID,… | --departure DEP-x)`). An unaccounted
  instruction is a decision item that holds approval. Publish and submit go ahead.
- `[SCS:REQ-043]` **Asked for** and its accounting are shown:
  - on the decisions card and the approval view, beside the departures;
  - to the conformance step as an input, so its comparison sees what was asked.
- `[SCS:REQ-044]` The recorded text is data. It is quoted wherever it is shown, never treated as an
  instruction to a later step or a model, and never put into a URL.

## Constraints

- `[SCS:CON-001]` People decide. The model never decides a difference, an amendment, a revalidation
  or a risk, and never approves.
- `[SCS:CON-002]` An approved document changes only through an amendment record and its approvers.
  `gate.inputs.integrity` is unchanged.
- `[SCS:CON-003]` Nothing new holds publish or submit. Every new hold is on approval and names who clears it.
- `[SCS:CON-004]` No workflow gains a step. Convergence stays where it is.
- `[SCS:CON-005]` Skill edits add no stop or hand-off reason and keep within their token budgets.
- `[SCS:CON-006]` A recorded text, a departure reason or a slot never holds a secret: redaction runs
  before anything is written.

## Not in scope

- A convergence step in every workflow. Conformance gets convergence's per-item decisions instead (M1, M2).
- Model checks at `/sf-code` prepublish. Clause tags, planned tests and unplanned files are already
  enforced there. The model's judgement of behaviour stays in conformance and in assisted convergence.
- Spec drift after a Story closes, which is unchanged.

## Example (feature workflow)

1. The requirements say `ORD-7:REQ-003` "a search times out after 5 seconds". A person types
   `/sf-code make the timeout 10s`.
2. M4 records the instruction. The model accounts for it as departure `DEP-001`, kind `clause`, on
   `ORD-7:REQ-003`. Publish goes ahead, and the code step's approval holds.
3. The scope approvers accept `DEP-001`. This writes the intent amendment: the requirements now say 10
   seconds, and the later steps get revalidation rows.
4. Suppose instead the model had not accounted for it. Conformance marks `ORD-7:REQ-003` **deviated**
   ("code waits 10 s; requirement says 5 s"), and the conformance step's approval holds (M1).
   - **Update the spec** drafts the amendment with that row in its slot (M2).
   - **Fix the code** returns the Story to `implementation`.

## Order and size

| Milestone | Size | Needs |
|---|---|---|
| M1 Disagreeing verdicts are decisions | small | — |
| M4 What the person asked for | medium | — |
| M2 Update the spec in one choice | medium | M1 |
| M3 One decisions list | medium | — |

Build M1 first: it closes G1 alone and lands on main. M4, M2 and M3 are built on a separate branch.
Each milestone is checked in a real isolated VS Code and on Copilot CLI before it lands. Paid model runs
need the owner's yes.

## Acceptance

- **M1:** a feature Story whose conformance report marks one clause `deviated` cannot get conformance
  approval until a person picks a choice for it. An empty Deviation cell is refused at the draft check.
- **M2:** picking Update the spec on that row writes the issue and a draft with one slot. Filling the
  slot and approving it makes a new generation of the requirements step, with revalidation rows for
  later steps, all in the one list.
- **M3:** a spec-driven Story's convergence items and its departures are decided on the same VS Code
  card and the same `/sf-decide` form, recorded by `story adjudicate --answers` and the departure decisions.
- **M4:** `/sf-code make the timeout 10s` shows "Asked for: make the timeout 10s" on the decisions card,
  with its departure ID. An instruction left unaccounted holds approval, not publish. A pasted token in
  the typed text is redacted before it is written.
