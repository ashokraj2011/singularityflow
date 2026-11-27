# Watch the code base (WCB) — v1

Status: owner rule, 2026-11-27. Built on branch `watch-code-base` (from `fix-source-loop`).

## The rule, in the owner's words

> "We should care about the code base, not any of these settings files or any config files or test folders."

> "We should worry about the clauses and the hooks and test cases. If any code changes that was not agreed upon in
> planning phase, surface it, let copilot explain if it has touched, add the reason in documents and carry forward.
> If human has done, let them do it and move forward."

The trigger (office, 2026-11-27): a Java extension wrote `.vscode/settings.json` after Planning was published. The
submission was refused with a route to the Decide page, which had nothing for it and sent the person back to submit.
`fix-source-loop` (96aa138eb) stopped editor files from counting. This spec takes the rule to every file that is not a
clause, a hook or a test.

## What stops a Story, and nothing else

Only three things are hard stops (WCB:REQ-001):

1. **Clauses.** Every agreed clause has its code and a test case (spec coverage, as today).
2. **Tests.** The required test cases run and pass on the delivered code (code delivery, test pins, review freshness,
   as today). A commit to code after its code step was approved changes the delivered code, so it still goes back to
   that code step.
3. **Hooks and governance.** SFlow's own hooks and governance files (the protected paths and `.github/hooks`) are
   unchanged.

Everything below is about what is *not* a stop.

## Requirements

### Files SFlow never counts

- **WCB:REQ-002** Workspace-local files are never counted by any gate, never part of a code step's candidate, never
  listed, never asked about: an editor's or IDE's own files (`isEditorConfigurationPath`, from 96aa138eb), files named to
  stay on one machine (`.env`, `.env.*`, `*.local.*`, `application-local.*`: `alwaysLocalName`), and a test runner's
  output folders (`test-results/`, `playwright-report/`, `blob-report/`, tracked or not). One predicate, `isWorkspaceLocalPath`
  (src/workspace-local-paths.mjs, a leaf the Copilot edit guard never loads), is shared by every gate below. Unstaged, they stay where they are; staged, the checkout
  hold still names them, since a commit could take them.
- **WCB:REQ-003** Tool configuration (lint, format, `.editorconfig`) and build, dependency and CI files are code-base
  files: never a stop, and at the code step taken up with the change and listed (REQ-009).

### Document steps (no code delivery)

- **WCB:REQ-004** A document step's publication never refuses a changed application file outside its own documents
  (today `PHASE_ARTIFACT_ONLY_CHANGES`). It does not register or commit that file: the file stays in the checkout,
  untouched. A protected path still refuses (REQ-001.3). Another step's own document under the Story's `artifacts/`
  is a Story record, not code, and keeps its refusal.
- **WCB:REQ-005** A document step's submission never refuses application files changed after its publication (today
  `PHASE_SOURCE_CHANGED_AFTER_PUBLICATION`) when a code step comes later in the workflow: that code step takes them up.
  With no code step ahead, uncommitted files never refuse (they are not delivered); a *commit* that changes code an
  approved code step delivered keeps its return to that code step (REQ-001.2). A Story with no code step at all: REQ-017.
- **WCB:REQ-006** A document step never holds for unstaged or untracked application files: not its approval's checkout
  hold (today `LIFECYCLE_WORKTREE_REVIEW_REQUIRED`), not recovery's review roster, so not its composition either (today
  `PHASE_CONTEXT_WORKTREE_REVIEW_REQUIRED`). Staged files still hold: SFlow's approval commit must never take them. When a
  code step comes later, its review does not answer for the code base either: a commit of application files alone made
  while it waits (today `STORY_REVIEW_INTERVENING_COMMIT`), or code and test configuration changed since its submission
  (today `STORY_REVIEW_SOURCE_CHANGED`, `STORY_REVIEW_TEST_INPUT_CHANGED`), never holds its approval.
- **WCB:REQ-007** The Decide page has no row for a document step's application files (the `documentStepChanges`
  set-aside row 96aa138eb added): there is nothing to decide.

### The code step takes up what changed

- **WCB:REQ-008** Code committed while a document step was open is part of the code step's change set. When a code
  step's first work interval opens, its baseline is where code was last governed: the latest published commit of an
  earlier code step, else the Story's base commit. It moves back only when commits between there and HEAD changed an
  application file (SFlow's own records are not application files); otherwise it is HEAD, exactly as before. An
  explicit baseline (readiness repair, a test-command amendment) is never moved.
- **WCB:REQ-009** A code generation's begin never refuses code that already changed since its baseline (today
  `GENERATION_DIRTY_START`, whatever the `dirtyStart` policy, first generation or later). It carries it: the
  generation-start receipt records `baseline.mode: 'inherited'` and `inherited: { paths, digest }`. A generation an
  amendment closed (SPEC-CIC) still carries exactly its recorded code as `carried`; code changed since, or new code, makes
  it `inherited` instead of a refusal. A protected path or a path outside the step's source boundary still refuses
  (REQ-001.3; the boundary is the workflow's own rule).
- **WCB:REQ-010** At every publication of a code step (the agent's publish and a person's), each changed application
  file no plan row names (uncommitted, or committed since the generation's baseline) is settled:
  the plan's clear classes as today (companion, test support, documentation, ignore file, generated), and every other
  file as a `plan-accounting` settlement of class `out-of-plan`, `by: 'sflow'`, with
  `effect: { file, class: 'out-of-plan', writer, reason, kind }`. The file joins that step's candidate and is published
  with it. Nobody is asked; nothing is refused. Never settled this way: a protected path (refused), a workspace-local
  file (REQ-002), a file shaped like a key or certificate (`*.pem`, `*.key`, `id_rsa`: SFlow never commits one; it keeps
  today's route), a file a person rejected as a departure (its author restores it, as today), a file whose settlement a
  person undid (theirs to answer, as today), a file that already waits as an open departure, a file another code step's
  plan names (`GENERATION_EXCLUSIONS_UNSAFE`, as today). The agent's prepublish settles the clear classes only, records no
  departure for any other file, and lists what publication will take up (`outsidePlan`). A read before publication (the
  Decide page, recovery, composition) asks about none of them: only a file a person holds stays a question. Spec coverage
  counts a file taken up as claimed: no clause answers for it.

### Who changed it, and why

- **WCB:REQ-011** Attribution is per file, from SFlow's own hook records (the XPL2 observed-write store in the
  checkout's Git directory, written by the Copilot mutation guard in SFlow turns and by SF Guard in plain prompts):
  - `copilot`: a recorded Copilot write left the bytes the file holds now (its `after` digest, or `absent` for a
    deleted file, equals the file's current SHA-256);
  - `person`: anything else. Its `basis` says which: `changed-after-copilot` (a Copilot write is recorded, but someone
    changed the file since), `not-recorded` (hooks recorded other writes, not this file's), `no-hook-records` (no hook
    ran in this checkout: IntelliJ's local agent, a symlinked folder, a terminal).
  Unknown is "by you": no reason is demanded, and nothing waits. Records are evidence, never proof; the approver sees
  the basis.
- **WCB:REQ-012** Copilot writes the reason in its step's document, under a heading `Changes outside the plan` (any
  level), one line per file: the file in backticks, then why (a list item or a table row). SFlow reads it at
  publication, when the document is final, into `effect.reason`; `departure record --kind path` with `--reason` takes the
  file up with that reason at once. A Copilot file with no reason is never a stop: it is recorded and shown as "by
  Copilot: no reason written", and prepublish's `outsidePlan.reasonsMissing` tells the author to add it.
- **WCB:REQ-013** The code step's prompt protocol, the `/sf-code` skill and the implementation template's guidance tell
  Copilot to write that section for any file it changed that no plan row names, instead of recording a file departure.
  Departures stay for plan rows, tests, wording and clauses.

### One place a person sees it

- **WCB:REQ-014** The code approval lists every out-of-plan file of that step, each marked `by Copilot: <reason>` or
  `by you`: the Decide card's approval row (`details.outsidePlan` and one line each in `details.lines`), the approval
  focus page ("Changed outside the plan", at the file), and `Settled for you` (one group, "changed outside the plan").
  The Story's "What this change does" page (SPEC-CSP, section 6 "Outside the plan") reads the same records, the
  `plan-accounting` settlements of class `out-of-plan` not undone: `effect.file`, `effect.writer` (`copilot` or
  `person`) and `effect.reason`, so it shows the same "by Copilot: <reason>" or "by you".
  A file whose class places it as a supporting change (a person's scratch note, a test helper) is committed as one, and
  its settlement says who changed it too, so the approval and the change page list it "by you, as a supporting change"
  (or "by Copilot, as a supporting change", with a reason when Copilot wrote one). The owner decided this for a person's
  scratch note on 2026-11-28: "Commit it". A supporting settlement made before this build carries no writer and is not
  listed.
- **WCB:REQ-015** Undo is returning the step. While the code step is still open, undoing a settlement hands that file
  back as a question, as for any settled file; once the step awaits approval, its approver returns it first; once
  approved, it is history. Keeping one file out is one step (owner, 2026-11-28): while the code step is open and a file
  it took up is still only in the checkout, its settled row on the Decide page has "Keep <file> out of this Story", the
  person's terminal command `singularity-flow decisions undo <ID> --settled <STL> --keep-out <file>`. It undoes the
  take-up, saves the checkout and the Git index in a private recovery copy, and returns exactly that file to its
  committed bytes (an untracked one is removed). No question is asked and nothing is composed; a file already
  committed has no such row.

### A Story with no code step

- **WCB:REQ-017** A Story whose workflow has no code step at all (a docs, investigate or review task, whose steps are
  intake and design: `KIND_STEPS` in src/task-composition.mjs; or a team workflow with none) has no step to take code up.
  The choice (coordinator, 2026-11-27):
  - Code left uncommitted in its checkout never stops it and stays untouched; each approval, and so the last, lists it as
    "Not part of this task" (`details.notPartOfTask` and one line), since nothing delivers it.
  - Code committed on its branch since its base (its own first-parent commits; a merge brings none) would reach the pull
    request with no clause or test check, so its document step's submission stops for it
    (`PHASE_SOURCE_CHANGED_AFTER_PUBLICATION`; the error carries `noCodeStep` and `waits`, its JSON the changed paths
    and the route `singularity-flow decisions <ID>`, and its message the take-out), routed to the Decide page. The page has the
    row: "Take the commit out", the exact `git revert --no-edit <commits>` in the person's terminal; submitted again, it
    goes on. Such a task never grows into one with a code step: a task can gain only requirements, design, plan or review
    (`ADDABLE`), so the code is delivered by a task that has a code step.
  - Code committed after its submission keeps today's approval hold (`STORY_REVIEW_INTERVENING_COMMIT`): returned and
    submitted again, it meets the stop above.

### Migration

- **WCB:REQ-016** No recorded digest changes meaning. Nothing already recorded is reread differently: an `out-of-plan`
  settlement is a new record that only new publications write, and `settledPlanChanges` (the plan amendment record and
  every hash built from it) does not read it; the candidate scope reads it only for the step it names. A Story whose
  code step was published before this build keeps its departures and their holds; its next generation follows this
  spec. A work interval already open keeps its baseline. A generation-start receipt keeps its fields; `inherited` is
  added only to new receipts.

## Gates, before and after

| Gate | Code | Before | After |
|---|---|---|---|
| Document publication | `PHASE_ARTIFACT_ONLY_CHANGES` | refused any changed file outside its artifacts | refuses only another step's document; application files stay in the checkout, not committed (REQ-004) |
| Document scan | (registration) | would register every changed file | registers only the step's own documents (REQ-004) |
| Document submission | `PHASE_SOURCE_CHANGED_AFTER_PUBLICATION` | refused application files changed after publication | refuses only a commit to an approved code step's delivered code, by its return (REQ-005), or, on a Story with no code step, code committed on it, taken out from the Decide page (REQ-017) |
| Document approval (no code step) | (listing) | nothing | lists code left in the checkout as not part of the task (REQ-017) |
| Document approval | `LIFECYCLE_WORKTREE_REVIEW_REQUIRED` | held for any changed file | holds only for staged files and Story records (REQ-006) |
| Document approval | `STORY_REVIEW_INTERVENING_COMMIT` | any commit after submission | not for a commit of application files alone, with a code step ahead (REQ-006) |
| Document approval | `STORY_REVIEW_SOURCE_CHANGED`, `STORY_REVIEW_TEST_INPUT_CHANGED` | code or test configuration changed since submission | not with a code step ahead (REQ-006) |
| Document composition | `PHASE_CONTEXT_WORKTREE_REVIEW_REQUIRED` | held for any changed file | not for application files, which recovery leaves out (REQ-006) |
| Decide page | `generation-rollover` (documents) | a set-aside row | no row (REQ-007) |
| Code step's interval | (baseline) | HEAD | where code was last governed, when code was committed since (REQ-008) |
| Code generation begin | `GENERATION_DIRTY_START` | refused, or `--adopt-existing --confirm <digest>` | carried, `inherited` (REQ-009); protected and boundary paths still refuse |
| Code generation begin (CIC) | `GENERATION_DIRTY_START` | refused code changed since an amendment's closure | carried, `inherited` (REQ-009) |
| Code publication | `GENERATION_EXCLUDED_CHANGES_UNRESOLVED` | refused a file no row names (a person's publish), or recorded a departure (the agent's) | settled `out-of-plan` with writer and reason (REQ-010) |
| Code publication's tests | (candidate, D9) | ran without every file no row names | run with every file publication takes up; only a file a person holds stays out (REQ-010) |
| Code approval | `DEPARTURES_UNDECIDED` | held until a person decided each file departure | no file departure is recorded for an out-of-plan file (REQ-010); earlier ones keep their hold (REQ-016) |
| Decide page | `plan-accounting` question | "Say where <file> belongs" while the code step is open | none for a file publication settles (REQ-010) |
| Code approval | `SPEC_COVERAGE_INCOMPLETE` (unclaimed changed path) | a changed path no clause claims | a file taken up counts as claimed (REQ-010) |
| Code composition | `PHASE_CONTEXT_WORKTREE_REVIEW_REQUIRED` | an out-of-plan file was "unexpected" | it is the step's, as publication takes it up (REQ-010) |
| Every gate | (counting) | editor files only (96aa138eb) | every workspace-local file (REQ-002) |

Still refused, by design: protected paths (`CHANGE_SET_POLICY_VIOLATION`, `GENERATION_DIRTY_START` for a protected or
out-of-boundary path), a clause without its code or test (spec coverage), a failing or narrowed required test, a file
another code step's plan names (`GENERATION_EXCLUSIONS_UNSAFE`), a rejected departure not yet restored
(`DEPARTURE_REJECTED_NOT_REVERTED`), a commit to delivered code after its code step's approval, and a code step's own
files changed after its publication (its next version, on the person's yes: the owner's version rule). Left as they are:
a non-code step that writes source with no approved code step before it (`PHASE_SOURCE_CHANGE_UNGOVERNED`: no code step
governs it), and another step's own document changed under the Story's `artifacts/` (a Story record, not code).

## Tests

- `test/watch-code-base.test.mjs` (real CLI, slow lane): a classic-delivery Story where, during Intake, a person writes
  code uncommitted and commits code, a config file and editor and test-output files change; Intake publishes, submits
  and is approved with no question; the code step begins without adoption; Copilot-attributed (a recorded
  observed write) and person-made out-of-plan files settle at publication; the code step is approved with no person
  question; the approval row lists each out-of-plan file with its writer and Copilot's reason. A second case: a clause
  with no test case is still refused (REQ-001.1). A third: a Story with no code step lists a file left in its checkout
  as not part of it and stops for a commit of code until the Decide page's take-out step clears it (REQ-017).
- `test/document-step-files.test.mjs` (updated): a document step's application files no longer refuse or show a row.
- Unit: `test/code-outside-plan.test.mjs` for attribution (each basis), reason parsing and the workspace-local predicate.
- After main's SSB M3 and CSP merged in: `test/watch-code-base.test.mjs` checks the change page's section 6 lines;
  `test/story-state-ref-approvals.test.mjs` (A4) and `test/workflow.test.mjs` (two artifact-only cases) now expect a
  document step to go ahead and leave code to the code step; `test/source-review-fastpath.test.mjs` counts the one new
  leaf (workspace-local-paths.mjs).
- Updated to the rule: the CIC, base-move, AST, generation-boundary, approval-hold, step-sheet, choices, phase-entry, OAP,
  dead-end, publication-preflight and candidate tests (M1); the CQF departure, appeal, upstream-discrepancy, plugin,
  plan-amendment and candidate-isolation tests, and the settled-advice, settled-decisions and SCS asked-for tests, which
  now reach a file departure by the person undoing its take-up (M2).

## Gaps

- A Copilot write made through a shell command (`sed -i`, a generator) leaves no observed write, so it reads "by you".
  SF Guard's shell records say a shell call changed the checkout, not which file.
- A hook that ran in another checkout (a symlinked folder, VS Code's linked-folder case) wrote its records there.
- A commit that merges upstream into the Story branch during a document step changes application files too; the code
  step then lists upstream's files as "by you". A merge base is not yet subtracted.
- A commit on a Story with no code step that touches both code and the Story's own document is taken out whole by the
  revert; the person makes the document change again.
- Publication takes up a person's scratch note or unrelated edit too (a supporting change, or "by you"). When it breaks
  the tests, publication stops (REQ-001.2) and the person keeps the file out in one step (REQ-015). A file the person
  committed has no keep-out row: it is taken out as any commit is.
- A person's publication now runs the take-up too, so it reads the hook records and the step's document. Timed back to
  back on a quiet machine (1-minute load under 8), 2026-11-28, main 31f0c6c2a against this branch: phase-appeals 288 s
  and 300 s (+4%), journey-lessons 302 s and 313 s (+4%).
- The `/sf-code` and `/sf-phase` skills sit at their token budget: the departure line dropped `--path` and two
  parentheticals to make room for the one line REQ-013 adds.
- After the last code step is approved, a document step's approval still binds the code its review saw: an uncommitted
  edit to a file a plan row names, made while it waits, holds it (`STORY_REVIEW_SOURCE_CHANGED`) until the step is
  returned, as the delivered code's tests ran without it (REQ-001.2).
