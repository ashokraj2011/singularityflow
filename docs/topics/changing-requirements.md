---
id: changing-requirements
title: Changing requirements during a Story
aliases:
  - intent-amendment
  - intent-amendments
  - still-holds
  - amend
questions:
  - The requirements changed, what do I do?
  - What do I do when the requirements change partway through a Story?
  - How do I change the requirements of a Story?
  - How do I change the acceptance criteria after the scope is approved?
  - How do I change the scope of a Story?
  - What is an intent amendment?
  - How does an intent amendment work?
  - Who approves an intent amendment?
  - Which steps run again after an amendment?
  - What does still holds mean?
  - Why can't I publish after an amendment?
  - Why is my draft refused after an amendment?
  - How big is a requirement change?
  - What is an editorial change?
  - Who approves a material change?
  - What does change impact do?
  - What does the Change impact section of the report count?
keywords:
  - acceptance criteria
  - change
  - changed
  - change impact
  - editorial
commands:
  - decisions
  - story
  - upstream-issue
  - spec
related:
  - reconciliation
  - approvals
  - phase-appeals
  - rejection-and-rework
  - evidence-matrix
version: 12
---
When what a Story must do changes after its scope is approved, you do not edit the approved scope. You propose an intent amendment. The scope step's approvers decide it, and SFlow works out which later steps keep their approval and which run again. This topic walks one change from start to finish.

## Purpose and prerequisites

Use this topic when a requirement or an acceptance criterion changes partway through a Story.

- The scope step is approved, and the current step comes after it (in progress or awaiting approval).
- Before the scope is approved there is nothing to amend: revise the scope draft and review it as usual.
- Reopen a closed Story first: `sflow reopen WORK-ID --fetch --to <step> --reason "<why>"`.
- One amendment waits at a time. Decide the pending one before you propose another.

## Choose the route for the change

| What changed | Route | Who decides |
|---|---|---|
| New or changed behaviour, or changed acceptance criteria | Intent amendment: `sflow story intent-amendment` | The scope step's approvers |
| An approved document's wording, same intent (not the scope) | `sflow upstream-issue propose-amendment --phase <step> --reason "<why>"` | That step's approvers |
| A defect you found in an earlier step | `sflow upstream-issue raise --phase <step> --about <ID> --problem "<what>"` | That step's approvers |
| A code step needs another file, supporting file or plan row | A departure `/sf-code` records, or a plan amendment (PAM-001) with `sflow decision plan` | The plan's approvers |
| A screenshot or inspection typed as the wrong evidence | A phase appeal: `sflow appeal evidence-prepare` | A plan approver |
| A wrong or missing test command | `sflow decision test-command`, or `sflow story test-policy amend` | An approver of the step |

Only the first row changes intent. A forward amendment cannot change a step that defines clauses. A clause departure in a code step becomes an intent amendment when a person proposes it. The other rows are in `sflow explain approvals`, `sflow explain phase-appeals` and `sflow explain test-recovery`.

## Use it from each surface

- **Copilot:** `/sf-amend` (or `/sf-amend propose`) drafts, previews and proposes the change in your words; `/sf-reject intent-amendment propose` still does the same. `/sf-decide WORK-ID` opens the Decide card. Copilot never decides or acknowledges an amendment for you. In Copilot CLI, `/decide WORK-ID` opens the same card.
- **Shell:** `sflow story intent-amendment status|draft|preview|propose|decide|acknowledge`, `sflow decisions WORK-ID` and `sflow upstream-issue revalidate`. Run `singularity-flow story --help` for the exact forms.
- **VS Code:** the Decide card, from the Command Palette: **Singularity Flow: Decide Everything This Step Waits On**. It needs no model. No VS Code form proposes an amendment; use Copilot or the terminal.

| Action | Who | Where |
|---|---|---|
| Propose | Anyone on the Story | `/sf-amend propose` (`/sf-reject intent-amendment propose` still works), or `story intent-amendment propose` |
| Approve or reject | The scope step's approvers | The Decide card, or `story intent-amendment decide` in your own terminal |
| Acknowledge | Anyone on the Story | The Decide card, or `story intent-amendment acknowledge` in your own terminal |
| Say a kept step still holds | That step's approvers | Yes or no in `/sf-decide WORK-ID`, the Decide card, or `upstream-issue revalidate` |

## Guided workflow

Story PAY-1, "Retry failed card payments", has four steps: Intake (the scope), Design, Implement and Verify. The approved scope says PAY-1:AC-001 "A failed payment is retried up to 3 times." and PAY-1:AC-002 "Retries wait 5 seconds between attempts." Design is approved and cites both. Implement is half done: begun, with some code written. Now the business wants up to 5 retries, and no retry at all after a fraud decline.

1. **Choose the route.** AC-001 changes and a new criterion is needed. That is new behaviour: an intent amendment.
2. **Draft, preview, propose.** Say the change in your own words. The draft is a copy of the approved scope, kept beside the checkout's Git data, never in the Story. Revise AC-001 in its `sflow-draft` slot, and add AC-003 "A fraud decline stops retrying at once." with its plan row. The preview records nothing. Here it says "It adds AC-003 and revises AC-001." and "Design is reopened: it cites AC-001." Implement has never published, so the preview does not name it; it runs again after Design. Then propose it as AMD-001. Implement, the step it was proposed from, pauses until AMD-001 is decided.
   - Copilot: `/sf-amend propose` (`/sf-reject intent-amendment propose` still works)
   - Shell: `sflow story intent-amendment draft --clause PAY-1:AC-001 --work-id PAY-1` (`--clause AC-001` names the same clause; a short ID that could mean several is refused with their full IDs), edit the file it names, then `sflow story intent-amendment preview --file <DRAFT> --work-id PAY-1` and `sflow story intent-amendment propose --file <DRAFT> --reason "<why>" --authored human --work-id PAY-1`
   - VS Code (model-free): not available
3. **The scope approvers decide.** The card shows each changed clause, who proposed it and what it reaches. Rejecting keeps the scope and every submission as they are. Approving reopens Design.
   - Copilot: `/sf-decide PAY-1` opens the Decide card; Copilot cannot decide for you
   - Shell: `sflow story intent-amendment decide AMD-001 --decision approve --confirm AMD-001 --work-id PAY-1` (or `--decision reject`)
   - VS Code (model-free): the Decide card
4. **Someone acknowledges.** Anyone on the Story reads what changed and acknowledges it. Until then no step can begin, prepare, publish, submit or be approved (`INTENT_AMENDMENT_ACKNOWLEDGEMENT_REQUIRED`).
   - Copilot: `/sf-decide PAY-1` opens the card; Copilot cannot acknowledge for you
   - Shell: `sflow story intent-amendment acknowledge AMD-001 --work-id PAY-1`
   - VS Code (model-free): the Decide card
5. **Design, reopened in place.** The Story resumes at Design (`/sf-resume PAY-1` in another chat or checkout; Shell `sflow resume PAY-1`). Its old text is kept read only in the Story folder at `context/superseded/design-gen2-before-AMD-001/design.md`, and the new prompt names that file. Leave Implement's unfinished code where it is. AMD-001 recorded it, file by file, when it closed Implement's code generation. Design does not count that code against itself, and its publication commits none of it. Compose Design again and write it against the amended scope. A person may publish the old text unchanged if it still holds; an agent's draft must be composed again first. Its approvers approve it again. Design still answers for a recorded file changed since, and for new code: put back what was recorded, or set it aside.
   - Copilot: `/sf-phase` (an agent writes it again), or `/sf-publish design` for your own unchanged text; then `/sf-submit` and `/sf-approve design --work-id PAY-1`
   - Shell: `sflow prepare` (it prepares the current step, Design) and `sflow phase enter design --work-id PAY-1 --compose --for-agent --json`; a person's unchanged text: `sflow phase publish design --authored human --channel manual-in-place`; then `sflow submit design` and `sflow approve design --work-id PAY-1 --fetch`
   - VS Code (model-free): `@sflow /submit design`, then `@sflow /approve design --work-id PAY-1`
   - Legacy: a Story started before `spec.preAmendmentDrafts` still sets the code aside first. `/sf-recover` (Shell `sflow recover PAY-1 --phase design --json`) offers it and keeps a private copy; bring the code back before Implement starts again.
6. **Implement, written again.** AMD-001 closed Implement's code generation and set its old prompt aside. Publishing the old draft is refused with `PHASE_DRAFT_PREDATES_AMENDMENT`, naming the way out in this step: `phase begin implement` while its generation is closed, then `phase enter implement --compose`. The code AMD-001 recorded is carried into the new generation as its starting point, and the new prompt names the old summary read only. Only that code is carried: a recorded file changed since, or new code, is refused at `phase begin` (`GENERATION_DIRTY_START`, naming the files). Put back what was recorded, or set it aside with `/sf-recover`, and begin again. The agent raises the limit to 5, adds the fraud stop and its tests, and publishes. Then submit and approve, and go on to Verify.
   - Copilot: `/sf-code` (it writes the code, then checks and publishes it), then `/sf-submit` and `/sf-approve implement --work-id PAY-1`
   - Shell: `sflow prepare` (now at Implement, it opens the code version again) and `sflow phase enter implement --work-id PAY-1 --compose --for-agent --json`, then `sflow phase prepublish implement --for-agent --json --publish-if-ready`, `sflow submit implement` and `sflow approve implement --work-id PAY-1 --fetch`
   - VS Code (model-free): once its code is published, `@sflow /submit implement`, then `@sflow /approve implement --work-id PAY-1`

### Variation: Design keeps its approval

Now say Design names only AC-002 and does not take Intake as an input (its prompt still holds every scope clause), and the Story has observed dependencies on (below). Design keeps its approval (rule E8), and only Implement reopens. Design's prompt held AC-001, so its own approvers are asked "Does Design still hold after AMD-001?" The preview says so first, with the recommended answer. Yes keeps Design's approval, bound to the amended scope. No returns the Story to Design, and the steps after it run again. Implement reads Design, so it cannot complete until the row is answered (`AMENDMENT_STILL_HOLDS_REQUIRED`), and neither can the Story.

- Copilot: `/sf-decide PAY-1`, then answer Yes, No or Not now, and give your reason
- Shell: `sflow upstream-issue revalidate design --work-id PAY-1 --amendment AMD-001 --outcome unchanged --reason "<why>"` (`--outcome return` for No; the reason takes 20 to 1000 characters)
- VS Code (model-free): the Decide card

A chat records only the yes or no the person gave for that row, with the reason they typed. Under SF Guard no row is asked in chat. In VS Code's own chat, an answer that cannot reach SFlow goes to the card instead.

## What happens to each later step

- **Kept (rule E8):** an approved step after the scope keeps its approval when its documents cite none of the changed or stale clauses, nothing else it decided over changed, and every step before it was kept. Code and convergence steps, steps tied to a workflow decision or a skill, a planning step when a clause is added (unless the amendment carries its rows), and a step whose document cannot be read always run again.
- **Asked "still holds":** a kept step whose prompt held a changed clause, on a Story with observed dependencies on. Until its approvers answer, each step that reads it waits, and so does the Story's end. Nothing else waits.
- **Reopened:** the first step that is not kept reopens in place at its next generation. Every step after it runs again.

An amendment that only brings the scope in line with what a conformance report found resets nothing and needs no acknowledgement. Each step that read the scope gets a "still holds" row instead (`sflow explain workflow-authoring`).

## How big is the change

With change impact on (below), every amendment has a size, set by rules and never by a model:

| Size | When | What approving it does | Who approves |
|---|---|---|---|
| Editorial | It only rewords clauses that have no bound test, are no acceptance criterion, and change no expected path or test | Nothing runs again and no step is asked "still holds": the evidence of the reworded clauses is carried, and the record says it was carried as editorial | The scope step's approvers |
| Refinement | It removes a clause, or changes one with a bound test, an acceptance criterion, or its expected paths or tests | What the rest of this topic describes | The scope step's approvers |
| Material | It adds a clause, adds a path outside what the Story's plan admits or under a protected path, or what its clauses are bound to cannot be read | The same as a refinement | The scope-change authority: `spec.scopeChangeAuthority`, or else the scope step's approvers |

- The preview and the Decide card say the size and why, each reason with its rule (for example `tested-clause`), and who decides.
- Whoever proposes may suggest a bigger size with `--class` (in chat, ask `/sf-amend` for it). A smaller one is raised to what the rules say, and the preview says why. It is never refused for that.
- An approver may raise the size while approving: **Approve AMD-001 as a material change** on the Decide card, or `sflow story intent-amendment decide AMD-001 --decision approve --confirm AMD-001 --class material`. Nobody can make it smaller.
- Someone outside the scope-change authority who approves a material change is refused (`INTENT_AMENDMENT_MATERIAL_AUTHORITY`). The refusal names who decides it; they approve it on the Decide card or in their own terminal.
- In chat, `/sf-amend propose` (or `/sf-reject intent-amendment propose`) drafts the change from your words and shows you its preview: what changes, how big it is and why, what runs again, what is kept and who decides. It proposes it only after your own yes. A No, Not now or no answer proposes nothing. Copilot never decides or acknowledges it.

### Change impact

`spec.changeImpact`, in the workflow configuration's `spec` block, turns on observed dependencies (below) and the sizes above together. It is on by default (since 2026-11-15), applied in code: `sflow init` and the shipped workflows write no setting, so an older SFlow build still loads them, and Workflow Studio, the builder and `sflow workflow check` show "Change impact: on (default)". `spec.changeImpact: off` turns both off, and so does `spec.observedDependencies: off` with no `spec.changeImpact`. It is pinned when a Story starts, so a Story started before keeps its behaviour. To name who approves a material change, add `spec.scopeChangeAuthority: <approval group>`.

```yaml
spec:
  changeImpact: on
  scopeChangeAuthority: product-owners
```

## Drafts written before the amendment

New Stories pin `spec.preAmendmentDrafts: refuse`. Stories started before it keep the old behaviour.

- At approval the reopened step's earlier prompt is set aside, its open code generation is closed, and its draft is copied read only to `context/superseded/<step>-gen<N>-before-AMD-001/`. A later reset step holding unpublished work is treated the same way. A kept step is never touched.
- A code step publishes only from a code generation opened under the amended scope, and a prompt composed before the amendment must be composed again. Until its generation is open again, Copilot cannot edit its code.
- A document step an agent wrote (`--authored governed-agent`, or no `--authored`) publishes only after it is composed again. A person's text may be the old text unchanged. If a prompt for that generation was composed before the amendment, compose again first, whoever publishes.

## Observed dependencies

`spec.observedDependencies`, in the workflow configuration's `spec` block, is on with change impact (the default) and pinned when a Story starts. It stays valid on its own: `changeImpact: off` with `observedDependencies: on` keeps it without the sizes. With it on:

- Each published generation records what it depended on: the clauses its prompt held, claims, changed paths, bound tests, witnesses, bindings and citations.
- A step whose record is missing or incomplete counts as affected, so rule E8 never keeps it. A step published without a composed prompt has no complete record, so expect more steps to run again.
- Except a separate plan whose rows the amendment carries: once an approver of that plan signs them in their own decision on the amendment, they are its answer, and it keeps its approval even with an incomplete record. The preview and the Decide card say so.
- Two kinds of generation have no prompt by design, and record what they read instead: the scope generation an approved amendment publishes (the proposal its approvers decided), and a document SFlow assembles itself with no model call (its governed inputs). Code a model wrote still needs its composed prompt.
- A clause that depends on a removed clause is stale too. A changed clause no plan claims reaches every later step whose record does not rule it out.
- A kept step whose prompt held a changed clause it does not cite gets a "still holds" row.

See it with `sflow spec dependencies [<step>] --work-id WORK-ID`: each generation, `resolved` or `unresolved` with its reasons, and its edges by kind.

## What the Story report counts

`sflow report WORK-ID` (also `--format html` and `--format json`) has a **Change impact** section once the Story has an intent amendment. It counts what the changes did, for each approved amendment and for the Story:

| Count | What it is |
|---|---|
| Requirement changes | Amendments approved, by size (editorial, refinement, material, or no size where change impact is off), and those rejected or waiting |
| Cone size | The clauses each change reached (changed, or depending on a changed one), and the later steps with published work it reached |
| Widened share | Of those steps, the ones reached only because what they depended on is not fully recorded (observed dependencies) |
| Evidence kept | Evidence items preserved as unaffected, or carried as editorial |
| "Still holds" | Questions asked, and their answers: still holds, redo, or open |
| Rework | Steps reset after they had started, and the generations they published again since |
| Publications refused | Publications of a draft written before an amendment (`PHASE_DRAFT_PREDATES_AMENDMENT`) |
| Churn | Clause changes, clauses changed more than once, and clauses that went back to an earlier statement |

- Each count says whether it was **recorded** (written when it happened), **derived** (worked out from the Story's other records) or **not recorded**. A Story whose amendments were approved before SFlow kept these counts reports what it can derive and names the rest. With change impact off, amendments have no size, and the rest is counted the same way.
- Only counts are kept, with the amendment, step and generation IDs. No clause text, file contents or paths. `--format json` carries the same counts as `changeImpact`.
- A refused publication is counted in the Story's state, and its next commit carries the count. The refusal itself is unchanged.

## What not to do

- Do not edit an approved document in place. Propose an amendment.
- Do not republish an agent's old draft without composing it again.
- Do not answer another step's "still holds" row. Only that step's approvers may.
- Do not ask Copilot to decide or acknowledge an amendment. Open the Decide card.
- Do not return a step to change what the Story must do. A return changes no approved clause and decides no amendment.

## State and safety

Proposing commits the proposal; the approved scope stays as it is until the scope approvers approve. Approval follows the scope step's approval policy: its groups, distinct people and its self-approval rule. Preview, `status` and `spec dependencies` record nothing. Old drafts, prompts and evidence stay as history; nothing is deleted. On a Story SF Guard requires, the decision and each "still holds" answer are signed in your own terminal; the card hands them there.

## Troubleshooting

- **`INTENT_AMENDMENT_PENDING_PAUSE`:** the step it was proposed from waits. A scope approver decides it on the Decide card (`/sf-decide WORK-ID`), or rejects it: `sflow story intent-amendment decide AMD-001 --decision reject --confirm AMD-001 --work-id WORK-ID`.
- **`APPROVAL_INTENT_AMENDMENT_PENDING`:** a submitted step's approval waits for an amendment proposed after its submission. Decide the amendment first; rejecting it lets the step be approved as submitted.
- **`INTENT_AMENDMENT_ACKNOWLEDGEMENT_REQUIRED`:** someone acknowledges it on the Decide card, or with `sflow story intent-amendment acknowledge AMD-001 --work-id WORK-ID`.
- **`INTENT_AMENDMENT_MATERIAL_AUTHORITY`:** a material change is approved by the scope-change authority. A person in the group the refusal names approves it on the Decide card or in their own terminal; you may still reject it.
- **`INTENT_AMENDMENT_CLASS_LOWERED`:** a size can be raised, never lowered. Approve it at the size it has, or a bigger one.
- **`INTENT_AMENDMENT_CLASS_UNAVAILABLE`:** this Story started without change impact, so its amendments have no size. Run the command without `--class`.
- **`AMENDMENT_STILL_HOLDS_REQUIRED`:** an approver of the kept step answers its row on the Decide card, or with `sflow upstream-issue revalidate`.
- **`PHASE_DRAFT_PREDATES_AMENDMENT`:** write the step again where it is. Run what the refusal names: `sflow phase begin <step> --work-id WORK-ID --json` for a closed code generation, then `sflow phase enter <step> --work-id WORK-ID --compose --for-agent --json`. In Copilot, `/sf-code` or the step's own skill.
- **`INTENT_AMENDMENT_SOURCE_STALE` or `INTENT_AMENDMENT_STALE`:** the Story moved after the proposal. A scope approver chooses **Refresh** on the Decide card, which rejects it and proposes the same change again, or rejects it and proposes afresh.
- **`INTENT_AMENDMENT_PLAN_UNCORRECTED`:** a separate approved plan would no longer match the clauses. Propose again with the rows the refusal names (`--add-row`, `--remove-row`, `--keep-row`). **`INTENT_AMENDMENT_PLAN_CORRECTION_INVALID`:** correct those row flags and propose again. **`INTENT_AMENDMENT_PLAN_STALE`:** reject it and propose it again with the rows the plan needs now.
- **`AMENDMENT_REVALIDATION_INVALID`:** a plan cannot still hold while it lacks rows for the amended clauses. Its approvers correct it with `sflow decision plan`, or answer No.
- **`EVIDENCE_STALE_AFTER_SCOPE_REVISION`:** a step's evidence of a changed clause predates the amendment. A person returns the step to its author, who runs it again.
- **`PHASE_ARTIFACT_ONLY_CHANGES`:** a document step found code changes it answers for: new code, or a file a later code step's record no longer matches. Put back what was recorded, or set it aside with `/sf-recover`. A later step's code an amendment left in place is not counted (step 5), except on a legacy Story, which sets it aside.

## Related topics

Continue with `sflow explain reconciliation`, `sflow explain approvals`, `sflow explain phase-appeals`, `sflow explain rejection-and-rework`.
