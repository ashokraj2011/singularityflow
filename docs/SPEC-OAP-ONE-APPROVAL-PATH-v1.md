# One approval path (OAP) — v1

Status: owner request 2026-10-24 ("all these approvals, pending commits should be seamless … too many
clicks and ceremonies … one standard way and easy"). The owner accepted all five recommended
answers in [Decisions for the owner](#decisions-for-the-owner) on 2026-10-24 and asked for M0
first, each defect reproduced by a failing test before it is fixed.

The trigger was a real Story (2026-10-24): planning was submitted, an intent amendment was proposed
six hours later, and approval refused with a sentence that named neither the commit nor the amendment.
6fd93941 and c669bf3a now name the commits and the amendment, and show them before the review. The
case itself is still slow, though. The person has to decide the amendment with one command family,
return planning with another, resubmit, and then approve. Nothing ever showed them that whole path
in one place.

## What a person meets today

From a code reading on 2026-10-24 (three inventories: ceremony, holds, pending state):

| | Today |
|---|---|
| Things that can stop an approval | 39 conditions; 23 of them are seen only when `approve` runs, after the person reviewed and typed the phase |
| Separate places that list pending work | 11 concepts (unpushed commits, transport intents, decision list, routing decision, owed witnesses/scope items, intent amendments, forward amendments, appeals, repair journal, TRP risks, quality risks), each with its own reader; none lists them all |
| Command families a decision can need | about 13 (`decisions record`, `decision test-risk/evidence-reuse/visual-profile/test-command/witness/risk/scope/applicability/completeness/plan`, `story intent-amendment`, `upstream-issue`, `story test-policy`, `appeal`, `sync`, `push retry`, `decision choose`) |
| Simplest approval (one approver, no checklist) | terminal: command + typed phase (phase often typed twice); Copilot: 2 turns; VS Code: 3 clicks + typed phase; then every surface sends the person to Copilot for `/clear` and `/sf-next` |
| A decision recorded while the step waits | some kinds are allowed between submission and approval; others (intent-amendment propose/decide/acknowledge, forward amendments, `decision test-command`) silently make the submission stale, so approval later demands a fresh submission |

Defects found by that reading, each reproduced by a failing test before it was fixed in M0
(`test/oap-m0-approval-defects.test.mjs`, `test/approval-intervening-commits.test.mjs`):

1. **Fixed.** VS Code sent `--witness-mapping <sha>=exception`; the CLI requires
   `exception:<facet>`, so a witness exception recorded in VS Code was refused. The form now asks
   which part of the test falls short, and one builder (`storyApprovalArguments`) writes the
   arguments the CLI parses.
2. **Fixed.** VS Code demanded a self-approval tick and passed `--acknowledge-self-approval`, which
   Story approval never reads. The form now states the self-approval, as the terminal and Copilot
   do; the typed phase stays the one deliberate act (decision 4).
3. **Fixed.** A Story-only test command could be requested, accepted or revoked while its step
   awaited approval. The commit made the approval stale, and accepting it changed what the
   submitted review ran. It is now refused while the step awaits approval
   (`TEST_COMMAND_DECISION_DURING_REVIEW`), naming the route to return the step first; the decision
   list offers that route instead of a record.
4. **Did not reproduce.** Approving an intent amendment reopens the step awaiting approval, even
   one that only adds a clause the step does not cite, so its acknowledgement always comes before a
   fresh submission. A test pins this.
5. **Fixed.** At a step awaiting approval, the decision list's headline counted every item while
   readiness, next steps and the refusal counted only the ones approval waits for. Each item now
   says whether it holds the approval (`holdsApproval`), the packet carries `holding`, the headline
   counts those, and the VS Code approval page reads `holding`.
6. **Fixed in VS Code.** Reviews and Approvals offered "Approve…" on a step the decision list held.
   The card now leads with "Decide what blocks this step". The CLI inbox never offered Approve, and
   `/sf-approve` already routes a held step to `/sf-decide`.
7. **Fixed.** VS Code discarded the approval's result. It now shows the CLI's headline and next step
   and keeps the full result in the output channel.
8. **Fixed.** Copilot could not approve a phase whose policy requires the approval checklist:
   `phase show` listed no articles and `/sf-approve` passed no `--article`. `phase show` now carries
   `approvalChecklist`. `/sf-approve` asks for one answer per article with the confirmation and
   passes them. The refusal for unanswered articles (`APPROVAL_CHECKLIST_INCOMPLETE`) now routes to
   answering them, where before it routed to recover or reject.

## The standard way

One sentence: **every surface shows one list of what is pending, one check of whether approval
would pass, and one form that records the approver's decisions and the approval together.**

### 1. One approval check

Built in M1 (2026-10-24):

- `evaluateApproval` (src/state.mjs) holds every check approval makes, in the order it always made
  them, as named stages over shared facts. `approvePhase` records: it calls `evaluateApproval` and
  throws its first refusal unchanged, then makes the transition. A preview (`preview: true`) runs
  every stage. It keeps each refusal as a hold and skips only a stage whose inputs a failed stage did
  not establish (`needs`, or a `foundation` stage such as the phase sequence or the review packet).
  It never writes, publishes or prints; a commit still to publish is a `machine` hold. The gate and
  the preview cannot disagree because they are the same code.
- `src/approval-check.mjs` gives each hold one owner class (`APPROVAL_HOLD_OWNERS`) and one route.
  The route is the one the refusal names for itself; otherwise work the author revises is returned
  for changes and what Singularity Flow finishes is inspected with `recover`:

  | Owner class | Meaning | Shown as |
  |---|---|---|
  | `you-decide` | this approver can clear it now (checklist answers, witness or binding flags) | a field in the approval form; Approve stays |
  | `someone-decides` | another person or group decides (scope approvers for a pending intent amendment, TRP risk authority, a decision list, another approver) | the hold with its route; no Approve |
  | `author-repairs` | the work has to change and be submitted again (source changed, evidence stale, artifact incomplete) | the hold with the return-for-changes route; no Approve |
  | `machine` | Singularity Flow finishes it itself (a commit still to publish, a changed publication snapshot) | the hold with its route; no Approve |

- Submission readiness (and so the `/sf-approve` packet), `phase show`, `nextsteps`, VS Code
  Reviews and Approvals, and the VS Code approval page read this one result as `approvalCheck`.
  "Approve" is offered only when nothing outside `you-decide` remains; `nextsteps` puts the first
  hold's route where it offered the approval. The CLI inbox reads remote state only, so it shows
  submitted steps as before and `/sf-approve` reads the check.
- Guard (`test/oap-m1-approval-check.test.mjs`): every code the check throws has an owner class.
  Nothing in `evaluateApproval` runs outside a stage, and the record step throws nothing of its
  own. On a real Story, the preview's first hold is the code recording refuses with.
- Measured cost: readiness on a step awaiting approval took 1.6 s against 1.5 s before (one
  planning fixture). A code step's preview also replays its delivery receipt.

### 2. Decisions never make a submission stale by accident

- One registry, `REVIEW_EFFECTS`, gives every lifecycle commit kind exactly one effect on a step
  awaiting approval:
  - `review-safe`: may sit between submission and approval;
  - `returns-step`: the command returns the step itself, in the same commit, and says so before it runs;
  - `refused-during-review`: refused up front, naming the alternative (the precedent is
    `assertReceiptsMayBeRecorded`).
- `applicabilityDecisionCommit` reads this registry instead of its own list. A test fails when a
  command that commits has no entry.
- Intent amendments: propose, reject and acknowledge only add amendment records and never change an
  approved artifact, so they become `review-safe`. A rejected amendment then leaves the submission
  valid, and the person approves with no resubmission. An approved amendment already reopens the
  step awaiting approval (M0 test), so the reopen is what makes the submission stale, not the
  history rule. This removes the detour that started this plan.
- `decision test-command` changes what the checks run, so it becomes `returns-step` while the step
  awaits approval. The decision list labels that option "returns <step> for a fresh run".

Built in M2 (2026-10-24):

- `REVIEW_EFFECTS` (src/state.mjs) gives every lifecycle event type, and every decision kind a
  command records (`decision-made:<kind>`), one effect. It has a fourth value beside the three
  above: `stales-submission`, for the kinds that still need a fresh submission. Those are named now
  instead of being stale by default, and the approval refusal names each such commit. A review-safe
  decision names each state list it appends to with that list's history event.
  `applicabilityDecisionCommit` reads those lists from the registry and no longer keeps its own.
  Auto resumes a stopped flight over exactly those decisions, as before.
- Intent amendments (approval-check.mjs). Each case is verified exactly: an exact path allowlist,
  an exact `workflow.json` key diff and the commit's own event hash. Anything more fails closed and
  stales the submission as before.
  - A rejected amendment's proposal and rejection pass as one verified pair
    (`rejectedIntentAmendments`, bdd4049e). Approval records the pair, and the approval check notes
    it.
  - A proposal still waiting for a decision is checked the same way
    (`pendingIntentAmendmentProposals`). It makes nothing stale. It holds the approval as
    `someone-decides` (`APPROVAL_INTENT_AMENDMENT_PENDING`): rejecting it keeps the submission, and
    approving it reopens the step. An amendment proposed before the submission holds nothing, as
    before.
  - An acknowledgement may also stamp the steps the amendment reopened
    (`intentAmendmentAcknowledgements`).
  - An approval below the amendment's threshold is not verified, so it still stales the submission.
  - The approval that installs an amendment is `returns-step`, because it reopens the step awaiting
    approval (the M0 D4 test).
- `decision test-command` stays `refused-during-review`, as M0 built it
  (`TEST_COMMAND_DECISION_DURING_REVIEW`, with the route that returns the step first), rather than
  returning the step itself.
- Tests:
  - `test/approval-intervening-commits.test.mjs`: a pending proposal holds approval, and propose,
    reject, approve needs no resubmission;
  - `test/oap-m1-approval-check.test.mjs`: pairs that are not exactly one rejection still block;
  - `test/oap-m2-review-effects.test.mjs`: every event type and recorded decision kind has one
    entry, and a proposal with a file of its own stales the submission.
  - Checked in real VS Code 1.143: with the proposal pending, Reviews showed "Someone else decides:
    Approving planning waits for intent amendment AMD-001 to be decided" and no Approve. After the
    rejection, Approve was offered and recorded the approval of generation 1 with no new submission.

### 3. One pending list

- The decision list (`singularity-flow decisions <WORK-ID>`, `/sf-decide`, VS Code Decide) becomes
  the one list of everything a person must decide on a Story. It gains: intent amendments (decide
  and acknowledge), forward amendments, the routing decision, appeals, lapsed test-run risks while
  awaiting approval, TRP and quality risks for the operation at hand, and owed witnesses and scope
  items.
- The step's approval itself is the list's last item, so "what do I do next" is always the first
  open item of one list.
- Inbox, Reviews, the Navigator badge, `nextsteps` and the journey count and order from the same
  packet. A test asserts the counts are equal across surfaces (defect 5).
- Each item says who decides. An item for another group shows their names and how to ask them. It
  is never a dead end and never asks the current person to type something they cannot record.
- Unpushed Story commits and transport intents are `machine` items. `sync` runs them automatically,
  and `push retry` folds into `sync`. A person sees them only when the automatic attempt fails,
  with the one failing cause.

### 4. One approval ceremony

The same three moments on every surface: **review → decide → confirm once.**

- **Review.** The documents open where the person already is (VS Code editor, Copilot preview links,
  terminal pager). Opening the review starts no clock.
- **Decide.** Every `you-decide` hold appears in the approval form or packet: checklist articles,
  witness mappings (default "adequate", as the CLI already accepts), renewals and risk acceptances
  this approver holds. Each one is answered in place.
- **Confirm once.** One deliberate act: typing the phase ID once (VS Code, terminal), or replying
  with it (Copilot). `approve <phase>` given after the review in the same terminal is that
  confirmation. Nobody types the phase twice.
- **One commit.** The approver's decisions and the approval are recorded together, in one commit and
  one push. Their decisions then never count as commits after the submission.
- **The receipt binds the packet digest, not a 15-minute timer.** Approval is refused only when what
  was reviewed changed, never because the review took long. The digest already proves nothing
  changed.
- **The next step is shown where the approval happened.** VS Code shows the result and a "Next"
  button; the terminal prints the next command. A context reset is suggested only to Copilot users,
  and only once.
- **Copilot keeps working in the same turn** where the skill can continue. After `/sf-decide` records
  decisions it continues to the approval confirmation instead of ending the turn. This removes an
  exit; no skill edit in this plan adds a stop, relay or hand-off.
- **Several approvers.** The second approver sees "1 of 2 approvals recorded (<name>)" in the same
  form. Their own fields carry forward any decisions already recorded, so they answer only what is
  theirs.

### 5. Request changes is one action

- A step that needs `author-repairs` gets one action, "Request changes": the reason, and the target
  step preselected from the hold. It runs `reject … --to <step>` with the members and repair flags
  the hold implies.
- The author's next action becomes "Revise <step>", with the hold's text as the brief. After a
  fresh submission the approver gets the same review → decide → confirm path.

## Milestones

Each milestone ends with a real VS Code walk over CDP and, once Copilot is involved, a live
`/sf-approve` run on a fixture Story; green headless suites alone do not close a milestone.

| Milestone | Scope | Done when |
|---|---|---|
| M0 Defects (done 2026-10-24) | The eight reported defects above, each with a failing test first | seven fixed, one did not reproduce and is pinned by a test; checked in the real extension |
| M1 One check (done 2026-10-24) | `evaluateApproval` and the record step; owner classes; readiness, packet, phase show, Reviews, Approvals, the approval page and `nextsteps` read it | guard test: no refusal is found only at approve time; "Approve" is not offered on a held step; checked in the real extension |
| M2 Review effects (done 2026-10-24) | `REVIEW_EFFECTS` registry; intent-amendment propose/reject/acknowledge are review-safe; `decision test-command` stays refused during review (M0) | the amendment-after-submission fixture (test/approval-intervening-commits.test.mjs): propose, then reject the amendment, then approve planning with no resubmission |
| M3 One list | The decision list holds every pending kind and the approval; all surfaces count from it; `sync` and `push retry` unify | equal counts across surfaces (test); no pending kind is missing from the list (registry test) |
| M4 One ceremony | Decisions recorded in the approval commit; digest-bound receipt; phase typed once; `/sf-decide` continues to approval | simplest approval: one review plus one confirmation on every surface; a 40-minute review still approves |
| M5 Next step in place | Result and next action on the approving surface; one context-reset suggestion for Copilot | VS Code and terminal approvals never send the person to Copilot to continue |

Order: M0 first, because it is small and fixes real refusals. M1 next, because everything else reads
it. M2 and M3 can run in parallel after M1; they touch different files. M4 and M5 come last.

## Guards that keep it standard

- `test/gate-parity.test.mjs` (extended): `evaluateApproval` produces every approval refusal.
- A `REVIEW_EFFECTS` registry test (`test/oap-m2-review-effects.test.mjs`): every lifecycle event
  type and every decision kind a command records has one entry.
- A pending-kinds registry test: every pending concept named in the table above has a decision-list
  item kind or is a `machine` item.
- A surface-count test: inbox, Reviews, badge, `nextsteps` and journey report the same open count
  for one fixture Story.
- A skill pin: `/sf-approve` and `/sf-decide` keep their "continue" sentences
  (`scripts/skill-policy.mjs`).

## Decisions for the owner

All five accepted as recommended (2026-10-24).

1. **A rejected intent amendment keeps the step's submission valid.** Recommended: yes. It changed
   no approved clause, so approval absorbs nothing unreviewed.
2. **The approver's own decisions are recorded in the approval commit.** Recommended: yes. It means
   one commit and one push, and their decisions never make the submission stale. The alternative is
   separate commits that are each `review-safe`.
3. **The selection receipt is bound to the packet digest, not 15 minutes.** Recommended: yes.
4. **Confirmation stays one typed phase ID.** Recommended: yes. One deliberate act stays; the second
   one goes. The alternative is a single "Approve" button, which removes the last friction but also
   the explicit-intent check.
5. **`push retry` folds into `sync`.** Recommended: yes. One command for "finish what was not
   published".

## Out of scope

- Approving several steps or Stories at once.
- Changing who may approve (groups, minimums, self-approval policy).
- Initiative (Epic) approvals. They get the same treatment after Stories, reusing the same check
  and list.
