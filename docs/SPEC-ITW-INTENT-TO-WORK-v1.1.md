# Intent to work (ITW) — v1.1: say what you want; SFlow does the work

**Specification ID:** `ITW-v1.1`

**Status:** Built. M1 (2026-11-25): kinds, the composer, team rules, the Story's own workflow, `singularity-flow work`. M2 (2026-11-25 and 2026-11-26): `/sf-task` takes the turn of what comes next and carries on after each answer in the same chat (`src/task-turn.mjs`, test/task-turn-carry.test.mjs), words on an open task are its own (`TASK_OPEN_HERE`, `--new`), VS Code's approval page carries a task's chat on, `work status` and the last message, "… and open a pull request", a started task gains a step after its current one (`work add`, REQ-009), and a code step's files that touch a `tasks.paths` rule add that rule's steps (REQ-014). M3 (2026-11-25 and 2026-11-26): an investigation's report starts a fix (`--from`), a fix whose code needs a migration or a contract file becomes a change (REQ-014), the refactor's checks before and after, at its code step and on the decisions card (REQ-015, `src/refactor-behaviour.mjs`), and documents bound to their version (`--document`). M4 (2026-11-25 and 2026-11-26): skills from the library and trusted marketplaces (REQ-010) and a marketplace agent as the plan (REQ-011, `src/task-agents.mjs`). M5 (2026-11-25 and 2026-11-26): VS Code's Start a task box (`singularityFlow.startTask`), journeys that count a person's actions (test/journey-tasks.test.mjs), and the task fuzzer (test/task-composition-fuzz.test.mjs) beside the Story fuzzer (test/story-fuzzer.test.mjs). Built 2026-11-26: what the team already has (its own workflows, agents and skills) before any marketplace (REQ-020, `src/task-local.mjs`). Replaces [ITW v1](SPEC-ITW-INTENT-TO-WORK-v1.md). Also takes in the useful parts of
an outside draft, "SPEC-IEX v1.1, Intent to Verified Execution" (2026-11-07); section 5 lists what was left out of it and
why.

**Owner:**
- 2026-11-24:
  - "intent to work. ..when someone /sf-task or something it will automatically spinup workflow using the intent and do
    the work"
  - "why do we need workflows ..let it be dynamic"
  - "it can check the marketplace for skills also"
- 2026-11-25, on merging the two: "i think this can superside the other sf-task spec"

**Builds on:**
- step intents (`STEP_INTENTS` in `src/phase-roles.mjs`), from which `src/step-intent-settings.mjs` derives each step's
  settings;
- the workflow walk, which finds loops and stops before anything starts;
- Story workflow snapshots ([WFA](WFA-WORKFLOW-SNAPSHOTS.md));
- automatic approval of clean steps, and approval in the chat;
- plain-chat routing ([PCR](SPEC-PCR-PLAIN-CHAT-ROUTING-v1.md)): a question in a plain chat needs no task;
- software kinds (`src/software-kinds.mjs`);
- the skill library, and trusted marketplaces with their conversion review
  ([MCR](SPEC-MCR-MARKETPLACE-CONVERSION-REVIEW-v1.md));
- Story lessons ([LRN](SPEC-LRN-STORY-LESSONS-v1.md)).

**What changed from v1:**
- Two new kinds:
  - `refactor`, which checks what must not change before and after;
  - `review`, which reports on a change and edits nothing.
- An investigation never edits code. "Fix it" carries its report forward.
- "Quick" never removes a step. A change that turns out bigger gets the steps it needs.
- A task that names a document uses the exact version it started with.
- After a person answers, the work carries on with nothing typed.
- Progress is quiet: one line per finished step.
- The last message says plainly what was done and what was checked.
- Journey tests count a person's actions and keep mechanical ones at zero.
- A code task ends with the checked change on the Story's branch. A pull request is opened only when the person asks
  (owner, 2026-11-25).

---

## 1. Why

Starting work today means choosing a base, an intake and a workflow (`/sf-start`), and someone has to have written that
workflow first. `/sf-auto` runs work by itself, but it needs capability IDs and a hash confirmation for each flight. A
person who wants a bug fixed should be able to say so and get the fix, with the same guardrails. A person who wants a
bug understood, a spec written or code tidied should get that too, from the same line.

## 2. What a person does

```text
/sf-task fix the login timeout on slow networks
```

SFlow answers with one line and starts:

```text
Plan: code → tests → you approve the code. Say "add a design step" to change it.
```

It then does the work in the same chat, step after step. It stops only where a person must decide: an approval the team
rules give a person, or a real question. After the answer it carries on by itself. The work ends with the checked change
on the task's branch:

```text
Done: the fix is checked and committed on TASK-12's branch. Say "open the pull request" when you want one.
```

The same chat can go on from one task to the next:

```text
/sf-task why do cancelled orders still send emails?      → a report: what was seen, the cause, what to change
fix it                                                   → a fix task that starts from that report
/sf-task write a spec for order export                   → docs/specs/order-export.md on the task's branch
make the date range part of the file name                → the same document, revised
/sf-task implement the order export spec                 → a feature task bound to that version of the spec
```

## 3. The rules

**ITW:REQ-001, the front door.**
- `/sf-task <words>` in Copilot: VS Code, Copilot CLI and IntelliJ.
- `singularity-flow work "<words>" [--kind KIND] [--json]` in the terminal shows the plan and writes nothing; `--start`
  starts it. (`task` was taken: it is SGOS's `task list|show|evidence|retry`.)
- `/sf-task` with no words continues the person's open task.
- A question asked in a plain chat needs no task. `/sf-task` is for work whose result should be kept.

**ITW:REQ-002, the kind of task.**
- The agent says which kind the words describe: `fix`, `feature`, `change`, `refactor`, `tests`, `docs`,
  `investigate`, `review` or `chore`.
- SFlow refuses a kind it does not know.
- When the words fit two kinds equally, the person is asked once, with the kinds as choices.

**ITW:REQ-003, the steps, composed.** SFlow builds the steps from the kind, the same way every time:

| Kind | Steps (by step intent) |
|---|---|
| fix, chore | intake → code → test |
| change | intake → plan → code → test |
| feature | intake → requirements → plan → code → test |
| refactor | intake → plan (what must not change) → code → test (the same checks, before and after) |
| tests | intake → code (the tests) → test |
| docs | intake → design (writes the document, kept with the Story on its branch; a later task starts from it with `--from`) |
| investigate | intake → design (investigate) → report |
| review | intake → report (findings on the named change) |

- Each step's settings come from its intent, as for any workflow that says what its steps are for.
- The composed steps are walked before anything starts: a plan that would loop or stop is never started.
- The agent may suggest a larger plan for a large task, for example adding design to a feature. The person sees it in
  the plan line.

**ITW:REQ-004, the team's rules.** `tasks:` in `singularity/workflow.yml` replaces whole workflows with a few rules that
always apply:
- `always`: steps or approvals every task of a kind gets. Defaults:
  - every code change gets a test step;
  - a person approves the delivered code;
  - a person approves a plan where there is one.
- `paths`: touching these files adds a step or a reviewer, for example a security review for `src/auth/**`, or a plan
  approval for `db/migrations/**`.
- `use`: a kind (or paths) that must follow a named workflow, for example `release: Classic delivery`.
  - An existing workflow is then used as it is.
  - Workflows stay for work a team must do the same way every time.

The rules are checked last. They only add steps or raise approvals; nothing a person or an agent says removes one. "Skip
the tests" on a code change is refused with the rule's words. The rules change like any configuration: a reviewed
proposal.

**ITW:REQ-005, approvals.**
- SFlow approves each step that is clean, as it does today, and records that it did.
- A person approves what the rules give a person, and nothing else.

**ITW:REQ-006, the Story's own workflow.**
- The composed steps become the Story's workflow, frozen into its snapshot like any pinned workflow. They are never
  written to `workflow.yml`, so a task needs no configuration proposal.
- `workflow check`, the walk and the audit read it as they read any Story's workflow.
- A Story reopened on another laptop has the same steps.

**ITW:REQ-007, the Story.** Every task is a Story; a small fix is a small Story.
- Its ID is a Jira key when the words or `--work-id` name one. Otherwise it is the next free `<prefix>-<n>`; the prefix
  is `tasks.idPrefix`, default `TASK`.
- Its base is the repository's default branch.
- Its intake is the person's words and anything they attached.

**ITW:REQ-008, doing the work.**
- In the chat, SFlow runs each step after the last, with the turn continuations it uses today. It stops at a person's
  approval or a real question.
- After the answer, the work carries on with nothing typed:
  - An answer or approval given in the chat continues in the same turn.
  - An approval given on the VS Code approval page or Decide card sends the continue line into the chat itself.
- No step needs a typed step ID, hash or "resume". `/sf-task` with no words is only for coming back later.
- Built 2026-11-26: the `/sf-task` turn that ran `work … --start` goes on into the new Story's first step (the intake's
  question, then its writing) with nothing typed; the step's own work goes on, once its submission waits for a person's
  approval, into that approval's question, as the approval-only turn of that step; and the approval-only turn goes on,
  after the person's own Yes in the chat is recorded, with the next step's work or the next approval question. The
  after-tool hook records the same turn again as that next action's, as if `/sf-task` were typed, once the Story shows
  what the call did: a task's Story created in this checkout during the turn, the step the turn was bound to submitted
  during it and waiting for a person, or that step approved by an approval recorded during it (`src/task-turn.mjs`
  taskTurnContinuation, `copilot-repository-boundary.mjs` carryTaskTurn). Nothing is written or approved under the next
  action's rules before that, the host's word that a command succeeded counts for nothing, and the new turn's answers
  start afresh, so no answer given before decides the approval and the Yes approves nothing more. A decision or a return
  is still the person's on its card. When the task's last step completes, what the task did (`work status`) is said in
  the same turn. Owner, 2026-11-26: a step SFlow approves itself (a change's or a feature's intake, for one) also goes
  on into the next action, the next step's work or approval question, once its automatic approval is recorded during the
  turn; its result no longer says "End this turn" on a task's Story. This replaces OSA decision D7 ("the turn that
  submitted does not start the next step", OSA:REQ-050) for task Stories only. A classic Story, and a turn typed as
  `/sf-approve` or `/sf-next`, end as before. VS Code's Journey (its route list and Generate button) and nextsteps'
  guided router name `/sf-task` on a task's Story.

**ITW:REQ-009, changing the plan.**
- "Add a design step" or "skip the plan" re-composes the steps from the current one forward. Done steps stay, and the
  rules still apply.
- The change is recorded with who asked for it.
- Built 2026-11-25: a step whose approval the team's rules give a person is a person's when it is added to a started
  task, whoever adds it (`work add`, or a rule at the code's submission): an `always` rule for the task's kind, or a
  `paths` rule for the files the task started with or its code changed. Only the added step's approval rises; the change
  record refuses any other. A plan or requirements step added to a fix leaves the requirement IDs with the intake that
  wrote them (`clauseKeeps`), beside its own, as a feature's requirements step sits beside its plan; before, adding one
  was always refused. A Story whose test agreement (`testRecovery`) was confirmed for its steps keeps them: the agreement
  binds the intake plan confirmed at the start, and a new step would leave it describing other steps. `work add` is
  refused with the complete command that starts the task again with the step from its own words
  (`work "<its title>" --kind KIND --add STEP --new --start`), whose start confirms an agreement for the new steps, and
  names the cancel of the first. Every other refusal that restarts a task names the same command, never a placeholder.

**ITW:REQ-010, skills for each step.**
- For each composed step, SFlow looks for skills that fit, by:
  - the step's intent, matched to a marketplace skill's `pdlc-task` through the table conversion uses
    (`AGENT_TASK_INTENTS`);
  - what the task touches: the repository's software kinds (web, backend, mobile and so on) and the person's words,
    matched to the skill's tags.
- Sources, in order:
  1. the repository's skill library;
  2. trusted marketplaces, read at the commit the repository trusts.

  An untrusted marketplace is never read. (Built 2026-11-25: a trusted HTTPS index marketplace is read too, its entries'
  `phases` naming the steps they are for. Its skill list is kept in the clone's Git folder for an hour, so a plan read
  does not fetch the index each time; `skill catalog` reads it fresh. An import from an index keeps the entry's tags
  and steps, so the next task finds it in the library. `skill catalog` and VS Code's All skills page read the approved
  configuration Stories use: a marketplace only the working copy of workflow.yml trusts is named "not approved yet" on
  its row and never read.)
- A marketplace skill marked approved or `ga` is offered directly. One marked proposed or beta needs the person's yes.
- A marketplace skill not yet in the repository costs one yes the first time, with its exact text shown, as any import.
  It is then in the library, and the next task uses it without asking. (Built 2026-11-25: a Git repository
  marketplace's skill can also be imported on its own, before any task asks: `marketplace browse` names its
  `import preview "market:<id>/<skill>" --as skill`, and Workflow Studio's Library gives it **Add to the skill master**,
  through the same preview and review.)
- The plan line names the skills it uses: "code → tests (with web-e2e-test-generation from acme, new here: add it?)".
- The exact skill text a Story uses is frozen into its snapshot.

**ITW:REQ-011, a marketplace agent as the plan.** When one marketplace agent's stages cover the task, SFlow offers that
agent's workflow as the plan, through the conversion review. Its steps then replace the composed ones, with the team
rules still applied.
(Built 2026-11-25: `src/task-agents.mjs`. The plan reads each trusted marketplace's agents at its pinned commit, kept per
commit like its skills, and converts each as `workflow from-agent` does, with the answers its import recorded. An agent
covers the task when its workflow has a step for each of the task's own steps but the intake (a requirements step
before the code also plans it), and its code is the task's kind of code: an agent whose code steps only write tests
covers a tests task, and one with a code step never covers a task that changes no code. One agent is offered: one
already imported first, then the fewest extra steps. The plan result's `agentOffer` asks one question, with
`workflow from-agent --review` to read first; `--use-agent MARKETPLACE/AGENT` is yes, `--without-agent` is no, and
`--start` with the offer unanswered is refused (`TASK_AGENT_YES_NEEDED`). A yes to an agent whose workflow is not in the
repository is refused at the start (`TASK_AGENT_IMPORT_NEEDED`) with its import through the conversion review as the
next action, and a start without it; in Copilot the yes confirms the import the review proposed and the task keeps its
own steps, as for a marketplace skill. Once imported, the task's steps are that workflow's, the team's `always` and
`paths` rules still adding steps and approvals, and the composition records the marketplace, the agent, its version and
the commit its import read, so the Story's snapshot and a second laptop have the same steps. Tested by
test/task-agents.test.mjs.) (Built 2026-11-26: walked to its end by test/journey-tasks.test.mjs, slow lane: a tests task
from the fixture marketplace's QA agent, its workflow imported through the conversion review, followed by its routes. The
agent's hard gate is a Story value its intake's submission records (`--decision channel=<channel>`); the route follower
answers such a question from the journey's scripted answer per value name (`values: { channel: 'web' }`), as the agent
asks the person in the turn the route names. The task ends closed with the agent's four steps; the person takes 5 actions:
the words, the intake's question, the channel, and the approvals of the requirements and the tests. Not yet: the
submission's route names the value only as `<channel>`, with neither the agent's question nor its choices.) (Built
2026-11-26, second round: the hard gate is asked once, in the agent's own words with its choices, in the intake's
clarification (its topic, `src/phase-roles.mjs` storyValueTopic); the intake's submission records the answer the person
gave there (`src/story-value-answers.mjs`: the answer to that question naming exactly one choice), so no submit route carries the
value (`decisionSubmitArguments`, submission readiness) and none names `<channel>`. With no answer recorded, the submission
asks the agent's question with one complete command per choice (`DECISION_INPUTS_MISSING` with `details.question` and
`choices`, an `ask-person` act). The journey's person answers it in the clarification, and takes 4 actions: the words,
the intake's answers, and a Yes to the requirements and to the tests, nothing typed again.)

**ITW:REQ-012, words and progress.**
- The plan is one line.
- No commit, digest or step ID is shown to a person.
- Progress is one line when a step finishes, for example "Code done; running the tests." A passing check or an
  automatic approval adds no line of its own; both are in the Story's record.
- A stop says what is needed, why, and the one thing to do: "The integration tests need the test database. Your
  changes are kept. Start it, then say go on."

**ITW:REQ-013, investigating.**
- An `investigate` task never edits code. It may run the repository's tests and other commands that change nothing, to
  reproduce the problem.
- Its report says:
  - what was seen;
  - whether the problem was reproduced, and how;
  - the cause, when the evidence supports one, otherwise the guesses that remain;
  - what is affected;
  - the next step.
- It never claims a cause the evidence does not support, and never says anything is fixed.
- "Fix it" in the same chat starts a `fix` task whose intake is the report. A question the investigation already
  answered is not asked again.

**ITW:REQ-014, size comes from what changes, not from the words.**
- "Quick", "small" or "just" never remove a step or an approval.
- When the code step's changes touch a `paths` rule, that rule's step or reviewer is added before the code approval,
  with one line saying why.
- When a `fix` turns out to need a public interface or a data change, SFlow says so in one line and re-composes forward
  as a `change`: a plan step is added, and the person approves the plan. Done steps stay. Steps are only added, so this
  needs no extra yes.
- Built 2026-11-25 (the third bullet): decided at the code's submission, by path only, from the application files the
  code changed, never a test's own files. A data change is a migration (a `migration`/`migrations` folder or `db/migrate`,
  the folders the delivery receipt already calls migrations) or a migration tool's schema file (`schema.prisma`,
  `db/schema.rb`, `db/structure.sql`); a public interface is its contract file (an OpenAPI, Swagger or AsyncAPI document,
  a `.proto`, a GraphQL schema). An exported signature changed in source is not read: nothing cheap and deterministic
  knows it. The plan goes where a plan goes, before the code step that waits for its approval, as one `grow` task change
  (TSC-NNN: from fix, to change, why, and the files); the composition's kind becomes `change`. SFlow then returns the
  code to the plan itself (its own return, `task-grown`), so the code is never approved before a person approves the
  plan. The plan is written from the code on the branch; once it is approved SFlow starts the code's next version itself,
  settled with an undo, and a person approves the code. The team's `always` rules for `change` then apply too. When the
  plan cannot be added the code stays with its approvers and the line says why; when the return cannot be made the line
  gives the person's return command.

**ITW:REQ-015, refactoring.**
- The plan step says what must not change (outputs, public interfaces, errors, formats, side effects and order, as they
  apply) and which checks show it.
- Before any edit, SFlow runs those checks on the base and records the results.
- The test step runs the same checks after the change.
- A check that passed before and fails after is a behaviour change. The step stops and names it. The person then
  chooses one of two things:
  - keep the old behaviour: the work goes back to the code step;
  - accept the new behaviour: the task becomes a `change`, and its plan is revised.
- A check that already failed before stays a finding; the refactor does not approve it.
- What no check covers is named in the last message. A refactor is never reported as safer than what ran.
- Built 2026-11-25: the "before" is `tests base` on the test step's commands (the start's `task.before`), kept by base
  commit, command and Node; the test step's own run is the "after". When the test step's tests fail, each failed command
  is compared with its kept run before the change (`baseCheckFacts`), at the submission and at the approval alike, and
  SFlow does not return the failure to the code on its own: a test that passed before and fails after is named as a
  behaviour change, with the person's two filled choices, keep the old behaviour (the test step back to the code step,
  whose next version SFlow starts) or accept the new one (back to the plan); a test that failed before too is a finding
  the refactor does not approve, with the test step's usual choices; a command with no run before kept (or one on
  another Node) cannot be told, and the first choice runs it before the change. The person's return to the plan from
  that stop is the acceptance: the task becomes a `change` in one revision that keeps every step and its state (a `grow`
  task change that adds no step, with the checks and the return), SFlow starts the plan's next version, then the code's
  and the tests', each settled with an undo. Not yet: a journey that walks a refactor through a behaviour change end to
  end, and the last message's list of what no check covers.
- Built 2026-11-26: the "before" never ran: `task.before` named the test step, and `tests base` runs only a code step's
  commands (TESTS_PHASE_NOT_CODE). It names the code step now, and a refactor's test step reads its commands as the code
  step's (`baseCheckFacts` `here`: the same program in the same folder under the test step's own ID; another step's run
  not kept here is unknown, never a pass). **At the code step too** (`src/refactor-behaviour.mjs`): the code step runs the
  same tests before its publication, so at every publication of a refactor's code step each command's latest failed run
  of the version being written (the gate's or the agent's own `tests run`) is compared with the run before the change. A
  test that passed before and failed in a run of this version stops the publication (`REFACTOR_BEHAVIOUR_CHANGED`), named,
  with the person's two complete commands, each a person's own step the Copilot guard refuses to an agent
  (person-step-catalog.mjs `refactor-behaviour`): `work behaviour keep` records the choice for that version
  (`behaviourDecisions`, a DECISION_MADE commit by the step's approvers) and the author goes on in the code step, where a
  run that still fails is its ordinary repair, told that the person kept the old behaviour; `work behaviour accept`
  returns the code step, still being written, to the plan by the person's return (rejectPhase `behaviourChange`, its open
  version and code kept in place, amended-drafts.mjs), the task becomes a change and SFlow starts the plan's next version,
  settled with an undo, as at the test step; the code is then written on in the same version. The stop holds when a later
  run of the version passes again: once SFlow saw it change behaviour, only the person's choice lets it through. **The
  last message** (`work status` once the task is done, `src/task-checks.mjs`): the checks that ran ("Checks that ran: npm
  test (2 tests, all passed).") and, for a refactor, each planned evidence row of its plan (the plan template's
  machine-readable table: the clause's sentence, its Planned tests) that no check covered: tests `not-applicable:`, or no
  passing test of a named file in any run the code or test step kept ("Not covered by any check: The log line keeps its
  format."). Walked end to end by test/journey-tasks.test.mjs (slow lane): a refactor whose code lists two errors in
  another order stops at its code step's gate; the person keeps the old behaviour, the code restores it, the task ends
  with that last message (5 person actions: the words, the intake's question, the plan, the choice, the code); and one
  where the person accepts it, which ends as a change with a revised plan (6: the revised plan's approval too). Not yet:
  the choice on the decisions card (it is a person's terminal command today), and a test whose expectation the author
  edits, with no run of the version failing, is not stopped.
- Built 2026-11-26, second round: **on the decisions card** (decision-list.mjs `refactor-behaviour`, with
  decision-plain.mjs, decision-advice.mjs and `decisions record`): the code step's behaviour change is an item that holds
  its publication, "Keep the old behaviour that Code changed?", with SFlow's recommendation to keep it (a refactor
  promises it) and both choices, each the person's own step (never a chat's yes; the code step's approvers decide it);
  `work behaviour keep|accept` stays its Shell route, and its Copilot route is the card (`/sf-decide <W>`, as every step
  the card records: model-free-commands.mjs decideCardStep). **An edited test**: a change to what an existing test
  expects (an edited or removed test, from the working tree's diff against the Story's base, its comments and blank
  lines aside, so a criterion's tag is no change; an added test is new work) is a behaviour change too, though every run
  passes; keeping it puts back each part of a changed test that says what it expects as the base had it (by the hunks of
  its zero-context patch; a hunk of comments alone, such as a criterion's tag the author added, stays), a removed test
  whole, and a keep covers the whole version: what still differs is the author's to restore (`REFACTOR_BEHAVIOUR_KEPT`).
  **The plan's label**: the kind change gives the plan it keeps the change's own label
  ("Plan"), in its composition, its pinned step and its state, through the task change record (task-change-contracts.mjs
  `relabeledStep`, replayed; a kind change recorded before keeps its label), so every reader names the same steps.
  Journeys (slow lane), with the after-tool hook: keep on the card (6 person actions: the words, the intake's answer, a
  Yes to the plan, keep, `/sf-task` again, as a card decision carries no chat on, a Yes to the code); accept at the
  terminal (7: and a Yes to the revised plan); an author who edits the test so no run fails, kept on the card (the
  same 6), SFlow putting back what the test expected with the author's tags kept, the code restored.
- Built 2026-11-26, third round: **SF Guard** signs the choice as every other person decision: each keep and accept is a
  `behaviourDecisions` record (person-step-catalog.mjs family `work.behaviour`, its card line naming the choice, the step
  and the version), signed where the Story is written, one card and one touch; a refusal writes nothing (a keep's tests
  are put back only after its record is written) and names the person's own terminal with the exact command
  (`PSS_CARD_NOT_SHOWN`, `where: 'own-terminal'`). The gate counts a keep only when its signature verifies
  (presence/counted.mjs); an accept's record rides with its return to the plan, as an upstream issue's return does.
  **The chat after the card**: `decisions record` says when a task's step goes on after what it recorded (`continueTask`:
  `/sf-task` and the agent's instruction); VS Code's Decide card then sends `/sf-task` to the chat the person used last,
  as after an approval page (extension.ts continueTaskAfterDecision), unless a chat opened the card, whose turn reads the
  same answer; Copilot CLI's card hands the instruction to the agent, which names `/sf-task` (no turn carries on from a
  card decision: the card records outside the turn's terminal). Journeys: keep on the card and the edited test take 5
  person actions now, nothing typed again; accept at the terminal stays 7.

**ITW:REQ-016, documents.**
- A `docs` task writes its document as its own step's document, kept with the Story on its branch. Git keeps its
  versions. (Built 2026-11-25: a code step with no code or tests left no evidence for the intake's criteria, so the
  task's end was refused; a change to a file such as README is a `fix` or `chore`.)
- While the task is open, "change section 2" or "add the timeout case" revises the same document in the same task.
- A task that names a document (a path, or "the spec we wrote") uses the document's exact version when the task starts.
  The Story records that commit and path.
- Later edits do not change the running task. At the next stop SFlow says a newer version exists and offers to re-plan
  from the current step.
- When a person approved the named document in an earlier task, it stands as the requirements: a `feature` composes
  intake → plan → code → test.

**ITW:REQ-017, "this", "it" and "that spec".**
- In the same chat, these mean the open task, its document or its report.
- When two things could be meant, one question names both.
- A new, unrelated request starts a new task. It takes nothing from the earlier task's steps or approvals.

**ITW:REQ-018, the end of a task, and the last message.**
- The end point depends on the kind (owner, 2026-11-25):
  - a code kind ends with the change checked, approved where the rules say so, and committed on the Story's branch;
  - `docs` ends with the document committed on the Story's branch;
  - `investigate` and `review` end with the report.
- A pull request is opened only when the person asks:
  - in the task's words ("… and open a pull request"), so the plan line ends with it;
  - or afterwards ("open the pull request"), which opens it for the finished task with no new task.
- The last message says:
  - what was done, and where it is (the Story's branch, the document's path, or the pull request link when one was
    asked for);
  - which checks ran and passed, and which did not run;
  - what a person approved;
  - anything left open.
- It never calls something checked that no check covered.

**ITW:REQ-019, counting a person's work.**
- Journey tests count a person's actions in two groups:
  - real decisions: approvals the rules give a person, and real questions;
  - everything else: typed commands, continue lines, repeated questions, and pages opened only to move on.
- For the journeys in section 7, the second group is zero.

**ITW:REQ-020, what the team already has, first.** (Owner, 2026-11-26: "sf-task also can pick up locally available
skills and agents ...and of course scan marketplace also".) Workflows run exactly as they are: a task only adds to what
it composes, and never rewrites, reorders or drops a team's workflow's steps.
- Before any marketplace, a task's plan reads what the repository already has, in this order:
  1. its own workflows: made in Workflow Studio, made from an agent (`workflow from-agent`), or imported. Never one
     SFlow ships, one archived, or one a marketplace agent's import made (REQ-011 offers that one by the agent's name);
  2. its agents, converted as `workflow from-agent <PATH>` converts them: each in `.github/agents` (a
     `<name>.agent.md`, or a folder holding `agent.md`), and each APM installed, read from APM's copy of its package in
     `apm_modules` (its `apm.yml`). An agent with no numbered stages is a chat agent and is never offered;
  3. the marketplaces the repository trusts (REQ-011).
- A `tasks.use` rule still decides its kind (A8): nothing else is offered, and a yes to another workflow is refused.
- A workflow or agent covers the task by REQ-011's rule: a step for each of the task's own steps, the task's kind of
  code, and no code step for a docs, investigate or review task. A team's workflow tells its kind of code from the tasks of
  the library skills attached to its code steps, or from the agent it was made from while the repository still has it.
  Because it runs as it is, it also has a step for each step the team's rules add, and leaves to a person each step the
  rules give a person. Otherwise it is not offered, so no rule is lost (A4).
- One offer, never a list: a workflow already here first, then an agent the repository has, then a marketplace agent;
  in a group, the fewest steps the task does not need, then by name. A deprecated or retired item is never offered.
- The offer says where it is from ("Your team's workflow Secure fix covers this task: use it as the plan, exactly as it
  is, code → tests?", "Installed agent qa-test-automation-agent covers this task: …"). `--use-workflow ID` is the yes:
  the Story runs that workflow as a `use` rule runs it, its steps in its order, nothing composed into it and none taken
  out (a skip of one of its steps is refused), and the composition records it (`local`). The plan line and `work status`
  say "from your team's workflow …". For an agent whose workflow is not here yet, the yes names its import through its
  conversion review (`workflow from-agent <PATH> --propose`), as a marketplace agent's does, and a start without it.
  `--without-workflow ID` is the no: the task keeps its own steps and nothing more is asked.
- Skills (REQ-010): after the library and before any marketplace, the repository's own skills: each
  `.github/skills/<id>/SKILL.md`, and each `.agents/skills/<id>/SKILL.md`, where APM installs a package's skills. Their
  tags say what they are for, as a library skill's do; for one APM installed, `apm.lock.yaml` names its package, and
  APM's copy of the package adds its tasks and tags. A skill the library also has is the library's; one the repository
  has is never offered from a marketplace. Each one used is frozen into the Story's snapshot from where the plan read it,
  with that path and where it came from (`from`: `apm` or `repository`, and its `package`).
- A skill of the repository's own that cannot be used (its `SKILL.md` unreadable or invalid, a link, or changed since
  APM installed it) is a note on the plan, with what fixes it (`apm install`, or the file to correct). It never stops a
  task: the plan goes on without it, and the Story's start never reads it.
- (Built 2026-11-26: `src/task-local.mjs` reads the team's workflows, agents and skills; `src/task-agents.mjs` orders and
  offers them; `src/task-composition.mjs` runs the chosen workflow as it is; `src/workflow-snapshots.mjs` freezes a
  local skill from its path. Tested by test/task-local-plan.test.mjs. As for a `use` rule's workflow, a started task that
  runs the team's workflow does not grow by a `paths` rule its code touches later (REQ-014): its offer already covered
  the rules that applied to the files it named.)

## 4. What stays as it is

These already hold in SFlow, and `/sf-task` keeps them:
- The agent proposes. SFlow's code composes the steps, checks them and records what happened. Model text never
  approves anything.
- An approval is given through SFlow's approval: the page, the card, or the yes it asks for in the chat. It is never
  read from other words.
- Zero tests found, a skipped required test or a timeout is never a pass.
- Results from before a change do not count for the changed code.
- No made-up Story ID. Hooks and tests are never switched off to get a green result.

## 5. From IEX, left out, and why

| IEX proposed | Here instead |
|---|---|
| A second kind of work beside the Story (work requests, execution runs, and moving a run into a Story) | Every task is a Story. Approvals, evidence, lessons, AI credits and the Code Explainer are all kept per Story; a second kind would split each of them. |
| A document store outside Git, with saves and versions | Documents live in the repository, on the Story's branch. Git is the version history. |
| A plan compiler, a capability registry and admission records | The steps are composed by fixed rules from step intents and the team's rules; the existing walk and checks catch loops. |
| An SFlow-owned chat screen with one adaptive result area | SFlow works inside Copilot's chat (VS Code, CLI, IntelliJ) and its existing pages. |
| Standing permission, handing running work to another machine, undo of any change, cloud and data changes | Out of scope. Resuming a Story on a second laptop is [SSB](SPEC-SSB-STORY-STATE-BRANCH-v1.md)'s job. |
| Analysis with no task | Already there: a plain chat answers questions ([PCR](SPEC-PCR-PLAIN-CHAT-ROUTING-v1.md)). |

## 6. How it relates to what exists

- `/sf-start` stays the explicit route: base, intake and workflow chosen by hand.
- `/sf-auto` stays for bounded runs with nobody at the keyboard. A later version may let `/sf-task` hand a plan to it.
- Workflows stay, and are optional. A `use` rule, or the person ("use Feature"), picks one.
- With [SSB](SPEC-SSB-STORY-STATE-BRANCH-v1.md), the composed workflow lives with the rest of the Story's state.
- Lessons ([LRN](SPEC-LRN-STORY-LESSONS-v1.md)) reach a task's steps as they reach any Story's.

## 7. Acceptance

- **A1:** In a repository with no workflow of its own, `/sf-task fix …`:
  - composes intake → code → test;
  - starts a Story with a generated ID;
  - runs to the code approval with no other command.
- **A2:** The same words and the same repository give the same plan.
- **A3:** A `paths` rule for `src/auth/**` adds its step when the task touches auth, and only then.
- **A4:** "Skip the tests" on a code change is refused with the rule's words. No rule is ever removed by a task.
- **A5:** A `docs` task has no code step. An `investigate` task ends with a report, and no source file changed.
- **A6:** In a web project with a trusted marketplace:
  - the code step offers `web-e2e-test-generation` (in SFlow the code step writes the tests and the test step runs
    them, so a skill that writes tests belongs to the code step; built so 2026-11-25);
  - its first use asks one yes with its text shown;
  - the next task uses it without asking.
- **A7:** A proposed or beta skill needs a yes. An untrusted marketplace is never read.
- **A8:** `use: { release: classic-delivery }` makes a release task follow that workflow unchanged.
- **A9:** The Story's snapshot holds the composed steps and the skill texts. A second laptop resumes the same steps.
- **A10:** A journey test walks `/sf-task` to the checked change on VS Code and the Copilot CLI, then "open the pull
  request" opens it. The Story fuzzer composes tasks of every kind, and the invariant checks hold.
- **A11:** A fix takes four person actions: the words, the intake's one question (the intake always asks), the plan
  approval (a fix's intake is its plan) and the code approval. Every other kind also asks a person for exactly two
  approvals. Measured by test/journey-tasks.test.mjs (2026-11-25). Built 2026-11-26: on every kind, the words, the
  intake's answer and the Yes to each approval are all a person does, in one chat with nothing else typed: the start goes
  on into the intake, each submission into its approval question or, for a step SFlow approves itself (owner,
  2026-11-26), into the next step, each Yes into the next step, and the last step's completion into what the task did
  (test/task-turn-carry.test.mjs, through the real hooks, for a fix and for a change whose intake SFlow approves). The
  route follower still types `/sf-task` between turns, so the journeys' counts are unchanged. Built 2026-11-26, second
  round: the route follower runs the host's after-tool hook after each shell command the agent runs in a task's chat and
  follows SFlow's note when the turn goes on; a task's approval is asked in that chat (`choices begin approve`, the
  person's Yes, its onYes and the approval, each through the real guard), and the reviewer sub-agent has a chat of its
  own. Measured: a fix takes 4 (the words, the intake's answer, two Yeses), nothing typed again; the marketplace agent's
  tests task 4. The hook reads the command as the agent typed it, quoted: joined unquoted, a task's words starting
  "add …" read as `work add`, and the start did not carry on.
- **A12:** "Fix it" after an investigation starts a fix whose intake is the report. No question is asked twice.
- **A13:** A refactor that changes the order of two errors stops at its test step and names the change. A refactor with
  every check unchanged ends by listing the checks that ran. (Built 2026-11-26: it stops at its code step's own gate,
  where the tests run first, and at its test step; its last message lists the checks that ran and what no check covered.
  Walked by test/journey-tasks.test.mjs.)
- **A14:** "Quick fix the permission check" in `src/auth/**` gets the security review step.
- **A15:** A `fix` that turns out to need a database migration becomes a `change` with a plan approval. Its code step
  is kept.
- **A16:** A docs task writes `docs/specs/x.md`, and "change section 2" revises the same file in the same task. Then:
  - a feature task naming the spec uses that exact version;
  - an edit to the spec while the task runs does not change it;
  - the next stop says a newer version exists.
- **A17:** On the VS Code approval page, Yes continues the chat with nothing typed. In the Copilot CLI, a yes in the
  chat continues in the same turn. (Built 2026-11-26: the submission's turn asks the approval in the chat, and once it is
  recorded the `/sf-task` turn is bound to the next step's work or approval question; so is a step SFlow approves itself
  (owner, 2026-11-26). Neither result says "End this turn" on a task's Story; test/task-turn-carry.test.mjs.)
- **A18:** A task with five automatic approvals and twelve passing checks shows one line per finished step and nothing
  else.
- **A19:** An unrelated second request in the same chat starts a new task. The first task's approvals are not reused.
- **A20:** The last message of a code task names the Story's branch, the checks that ran, those that did not, and what a
  person approved. No pull request exists unless the person asked for one.
- **A21:** "… and open a pull request" in the task's words puts the pull request at the end of the plan line and opens
  it. "Open the pull request" after a finished task opens it without starting a new task.
- **A22:** In a repository with its own workflows, an agent APM installed and a trusted marketplace's agent:
  - a task's plan offers the team's workflow that covers it first, then the installed agent, then the marketplace's,
    one offer, the same for the same words and repository;
  - the yes starts a Story whose steps are exactly that workflow's; a `use` rule still wins; a deprecated or retired
    item is never offered;
  - a skill in `.github/skills` or one APM installed is used for a step the library has nothing for, and frozen into the
    Story's snapshot; a broken one is a note, and the task starts.

  Built 2026-11-26 (test/task-local-plan.test.mjs).

## 8. Milestones

| Milestone | Scope | Size |
|---|---|---|
| M1 | Kinds (with refactor and review), the composer, team rules, the Story's own workflow, `singularity-flow work` (REQ-002 to 007); built 2026-11-25 | about 1 week |
| M2 | `/sf-task` in Copilot: running step after step, carrying on after an answer, quiet progress, changing and growing the plan, the last message (REQ-001, 008, 009, 012, 014, 017, 018) | about 1 week |
| M3 | Investigate then fix, refactor checks before and after, documents bound to a version (REQ-013, 015, 016) | 3 to 4 days |
| M4 | Skills from the library and trusted marketplaces, first-use import, a marketplace agent as the plan (REQ-010, 011) | 3 to 4 days |
| M5 | VS Code's Start a task box, journeys with action counts, the fuzzer, one real run (REQ-019) | 2 to 3 days |

About 3½ to 4 weeks.

## 9. Open questions for the owner

1. **Where a code task ends.** Decided (owner, 2026-11-25): at the checked change on the Story's branch. A pull request
   is opened only when asked (REQ-018).
2. **The ID prefix** when no Jira key is given. Default `TASK`.
3. **Default approvals.** Default: a person approves the plan (where there is one) and the delivered code; SFlow
   approves every other clean step. The rules can raise this.
4. **A new marketplace skill's first use.** Default: one yes, with its text shown. The alternative is to use approved
   skills from a trusted marketplace with no yes.
5. **The kinds.** Default: fix, feature, change, refactor, tests, docs, investigate, review and chore.
