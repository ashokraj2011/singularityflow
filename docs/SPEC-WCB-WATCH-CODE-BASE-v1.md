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
  output folders (`test-results/`, `playwright-report/`, `blob-report/`). One predicate, `isWorkspaceLocalPath`
  (src/application-paths.mjs), is shared by every gate below. Unstaged, they stay where they are; staged, the checkout
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
  approved code step delivered keeps its return to that code step (REQ-001.2).
- **WCB:REQ-006** A document step's approval never holds for unstaged or untracked application files (today
  `LIFECYCLE_WORKTREE_REVIEW_REQUIRED`). Staged files still hold: SFlow's approval commit must never take them.
- **WCB:REQ-007** The Decide page has no row for a document step's application files (the `documentStepChanges`
  set-aside row 96aa138eb added): there is nothing to decide. Recovery still shows the set-aside for anyone who wants it.

### The code step takes up what changed

- **WCB:REQ-008** Code committed while a document step was open is part of the code step's change set. When a code
  step's first work interval opens, its baseline is where code was last governed: the latest published commit of an
  earlier code step, else the Story's base commit. It moves back only when commits between there and HEAD changed an
  application file (SFlow's own records are not application files); otherwise it is HEAD, exactly as before. An
  explicit baseline (readiness repair, a test-command amendment) is never moved.
- **WCB:REQ-009** A code generation's begin never refuses code that already changed since its baseline (today
  `GENERATION_DIRTY_START`, whatever the `dirtyStart` policy, first generation or later). It carries it: the
  generation-start receipt records `baseline.mode: 'inherited'` and `inherited: { paths, digest }`. A protected path or
  a path outside the step's source boundary still refuses (REQ-001.3; the boundary is the workflow's own rule).
- **WCB:REQ-010** At every publication of a code step (prepublish, the agent's publish and a person's publish), each
  changed application file no plan row names (uncommitted, or committed since the generation's baseline) is settled:
  the plan's clear classes as today (companion, test support, documentation, ignore file, generated), and every other
  file as a `plan-accounting` settlement of class `out-of-plan`, `by: 'sflow'`, with
  `effect: { file, class: 'out-of-plan', writer, reason, kind }`. The file joins that step's candidate and is published
  with it. Nobody is asked; nothing is refused. Never settled this way: a protected path (refused), a workspace-local
  file (REQ-002), a file a person rejected as a departure (its author restores it, as today), a file whose settlement a
  person undid (theirs to answer, as today), a file that already waits as an open departure, a file another code step's
  plan names (`GENERATION_EXCLUSIONS_UNSAFE`, as today).

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
  settlement into `effect.reason`. A Copilot file with no reason is never a stop: it is recorded and shown as "by
  Copilot: no reason written", and the publish result tells the author to add it.
- **WCB:REQ-013** The code step's prompt protocol, the `/sf-code` skill and the implementation template's guidance tell
  Copilot to write that section for any file it changed that no plan row names, instead of recording a file departure.
  Departures stay for plan rows, tests, wording and clauses.

### One place a person sees it

- **WCB:REQ-014** The code approval lists every out-of-plan file of that step, each marked `by Copilot: <reason>` or
  `by you`: the Decide card's approval row (`details.outsidePlan` and one line each in `details.lines`), the approval
  page and step sheet that read that row, and `Settled for you` (one group, "changed outside the plan").
- **WCB:REQ-015** Undo is returning the step. While the code step is still open, undoing a settlement hands that file
  back as a question, as for any settled file; once the step awaits approval, its approver returns it first; once
  approved, it is history.

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
| Document submission | `PHASE_SOURCE_CHANGED_AFTER_PUBLICATION` | refused application files changed after publication | refuses only a commit to an approved code step's delivered code, by its return (REQ-005) |
| Document approval | `LIFECYCLE_WORKTREE_REVIEW_REQUIRED` | held for any changed file | holds only for staged files and Story records (REQ-006) |
| Decide page | `generation-rollover` (documents) | a set-aside row | no row (REQ-007) |
| Code step's interval | (baseline) | HEAD | where code was last governed, when code was committed since (REQ-008) |
| Code generation begin | `GENERATION_DIRTY_START` | refused, or `--adopt-existing --confirm <digest>` | carried, `inherited` (REQ-009); protected and boundary paths still refuse |
| Code publication | `GENERATION_EXCLUDED_CHANGES_UNRESOLVED` | refused a file no row names (a person's publish), or recorded a departure (the agent's) | settled `out-of-plan` with writer and reason (REQ-010) |
| Code approval | `DEPARTURES_UNDECIDED` | held until a person decided each file departure | no file departure is recorded for an out-of-plan file (REQ-010); earlier ones keep their hold (REQ-016) |
| Decide page | `plan-accounting` question | "Say where <file> belongs" while the code step is open | none for a file publication settles (REQ-010) |
| Every gate | (counting) | editor files only (96aa138eb) | every workspace-local file (REQ-002) |

Still refused, by design: protected paths (`CHANGE_SET_POLICY_VIOLATION`, `GENERATION_DIRTY_START` for a protected or
out-of-boundary path), a clause without its code or test (spec coverage), a failing or narrowed required test, a file
another code step's plan names (`GENERATION_EXCLUSIONS_UNSAFE`), a rejected departure not yet restored
(`DEPARTURE_REJECTED_NOT_REVERTED`), and a commit to delivered code after its code step's approval.

## Tests

- `test/watch-code-base.test.mjs` (real CLI, slow lane): a classic-delivery Story where, during Intake, a person writes
  code uncommitted and commits code, a config file and editor and test-output files change; Intake publishes, submits
  and is approved with no question; the code step begins without adoption; Copilot-attributed (a recorded
  observed write) and person-made out-of-plan files settle at publication; the code step is approved with no person
  question; the approval row lists each out-of-plan file with its writer and Copilot's reason. A second case: a clause
  with no test case is still refused (REQ-001.1).
- `test/document-step-files.test.mjs` (updated): a document step's application files no longer refuse or show a row.
- Unit: `test/code-outside-plan.test.mjs` for attribution (each basis), reason parsing and the workspace-local predicate.

## Gaps

- A Copilot write made through a shell command (`sed -i`, a generator) leaves no observed write, so it reads "by you".
  SF Guard's shell records say a shell call changed the checkout, not which file.
- A hook that ran in another checkout (a symlinked folder, VS Code's linked-folder case) wrote its records there.
- A commit that merges upstream into the Story branch during a document step changes application files too; the code
  step then lists upstream's files as "by you". A merge base is not yet subtracted.
- A workflow with no code step at all governs no code: a document step's code changes are left in the checkout and
  never listed.
