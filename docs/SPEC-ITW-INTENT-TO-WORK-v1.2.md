# Intent to work (ITW) — v1.2: the requirement first, then the shape

**Specification ID:** `ITW-v1.2`

**Status:** Built 2026-11-27 on branch sf-task-v12 (M1 to M5 built together, in src/task-shape.mjs, src/task-followups.mjs,
src/task-history.mjs, with src/task-composition.mjs, src/task-amendment.mjs, src/task-change-contracts.mjs,
src/task-agents.mjs, src/task-turn.mjs and `work`), walked by test/journey-tasks-shapes.test.mjs; M6 built 2026-11-28 (src/task-shape.mjs `taskApprovalWhy`, src/choices.mjs, src/agent-output.mjs); M7 (REQ-114) decided, not built. Builds on [ITW v1.1](SPEC-ITW-INTENT-TO-WORK-v1.1.md) and replaces its composition
(REQ-003, the default approvals of REQ-004 and REQ-005, and the offer of the team's own workflow in REQ-020). Everything
else in v1.1 stays as it is: the front door, the Story, carrying the turn on, adding a step, skills, a marketplace agent
as the plan, investigating, refactoring, documents and the last message.

**Owner, 2026-11-27, in order:**
- "let it take the requirement and the task and according to task ask if they want to use any agents from marketplace or
  sflow can decide. analyze stories just do it and create a document and ask if they want to take any further action
  using it like create story out of anything from analysis ... like bug analysis if yes start a new story with this
  detail. big changes will use spec, planning, implementation and testing. small changes requirement in a detail way
  then implement and test in one step"
- "SFlow + copilot + human will decide small or big, so this will happen only after the requirement and analysis of it.
  every requirement still needs a test, and SFlow runs the tests itself rather than trusting the agent (yes). and check
  the previous learning and suggest what agent was used for similar change previously and suggest it"
- The same day, gaps in v1.1: the team's `tasks:` rules were skipped when a kind ran a named workflow (a `use` rule, or
  the team's own workflow chosen); a task grew only for a migration or a contract file, not for what its code touched;
  and a question before the work starts is ceremony: the team's own matching workflow needs no question, only
  marketplace items ask.
- Two additions approved the same day ("do all the changes discussed"): a big change whose analysis finds UI or
  architecture work gets design with its spec, so it never skips design; and where SFlow's Copilot hooks do not run, the
  `/sf-task` skill carries its turn on by its own instructions, with no stall and no new exit.

---

## 1. Why

v1.1 chose a task's steps from its kind before anyone had written down what the task is. A one-line fix and a change to
the billing schema both started as "fix", and only a migration in the code could make the second one bigger. The size of
a change is known once its requirement and its analysis exist: which files, which areas, whether data or a public
interface changes. So v1.2 writes the requirement first and decides the shape at its approval, with Copilot, SFlow and the
person each taking part.

## 2. What a person does

```text
/sf-task make the value module return 2
Plan: requirement → implement and test → SFlow runs the tests. You approve the requirement and the code.
...
Approve the requirement v1 · Small change: implement and test next?            → Yes
...
Approve Implement and test v1?                                                  → Yes
Done: TASK-12 is done: Requirement, Implement and test, Tests, on branch TASK-12. Checks that ran: npm test (2 tests, all passed).
```

Three person actions: the words, the requirement's Yes, the code's Yes. A big change adds the plan's Yes:

```text
Approve the requirement v1 · Big change: spec, plan, code and tests next (the requirement names 7 files in 3 areas)?
```

An analysis asks for nothing until it is done:

```text
/sf-task why does the value module return 1?
...
TASK-13 is done: the report is in artifacts/design/design.md.
Start a story from one of these findings? Each starts a new task that carries only that finding; No starts nothing, and the report stays.
1) Return the approved value from the value module  2) Pin the value in a test  No   → 1
```

Two person actions: the words and the one follow-up.

## 3. The rules

**ITW:REQ-101, three shapes.** A person sees three shapes; the nine kinds stay inside SFlow.

| Shape | Kinds | Steps | A person approves |
|---|---|---|---|
| Analysis | investigate, review, docs | requirement → the report or document | nothing; the follow-up they choose |
| Small change | fix, chore, change, feature, tests, once its requirement says small | requirement → implement and test → SFlow runs the tests | the requirement and the code |
| Big change | the same kinds, once its requirement says big; a refactor always | requirement → spec [→ design] → plan → code → tests | the requirement, the plan and the code |

- A refactor is always big and keeps v1.1's steps (requirement → plan: what must not change → code → tests, REQ-015): its
  plan says what must not change, which no small change can promise.
- A task that runs a named workflow (a `use` rule, the team's own workflow, a marketplace or local agent's workflow) has
  that workflow's steps, with the team's rules added (REQ-107). Its shape is "your team's workflow" or "the agent's
  workflow"; it is not sized.
- The plan line, `work status` and the last message say "Small change", "Big change" or "Analysis" (`shape`). The kind is
  still recorded (`composition.kind`) and still chosen from the words as in v1.1.

**ITW:REQ-102, the requirement first.** Every code task starts with one requirement step (the intake, labelled
"Requirement") followed by one code step (labelled "Implement and test") and SFlow's run of the tests (the tests step,
REQ-104). The composition says so: `sizing: 'requirement'`.
- The requirement says what is wanted as numbered clauses, each with how it will be tested; then an analysis: the files
  and areas it likely touches (the World Model's likely files reach this step's prompt in its brief), any data or schema
  change, any public interface change, and the risk; then the size Copilot proposes ("Size: small change" or "Size: big
  change") and why. SFlow says this in the Story's intake, under "How SFlow sizes this task", so Copilot reads it with the
  person's words.
- The requirement step asks only what the words leave open (`clarification.mode: when-needed`): with nothing open it
  asks nothing, and the person's next action is its approval. v1.1's "the intake always asks" is replaced.
- The team's rules (`always`, `paths`) apply to this composition as to any: they only add.
- A team that wants the kind's own steps for every task, as v1.1 composed them, says `tasks: { sizing: kind }` (default
  `requirement`). The Rules place's preview and the skill catalogue show the kind's own steps, what a big change gets.

**ITW:REQ-103, the shape is decided at the requirement's approval.**
- When the requirement is submitted, SFlow reads Copilot's proposal from it and checks it against facts SFlow computes
  itself (src/task-shape.mjs), the same way every time:
  - the files the requirement names that are in the repository, or would be new beside files that are, tests apart;
  - their areas (the first two folders of each path);
  - a data change (a migration or a migration tool's schema file, as REQ-014) or a public interface (a contract file);
  - a team `paths` rule whose files are named and that adds a requirements, design or plan step or gives the plan to a
    person;
  - the limits of a small change: at most 5 files and at most 2 areas.
- Copilot's "big", or any fact over a limit, makes the change big; SFlow only ever overrules towards big. With no proposal
  written, the facts decide.
- A big change gains its steps then (REQ-105), after the requirement, which waits for its approval: one task change per
  step, recorded with the shape and why (`change: 'add'`, `shape: 'big'`, `because`).
- The approval's question says the shape and what comes next, so the person's one Yes approves the requirement and
  confirms the shape: "Approve the requirement v1 · Small change: implement and test next?", or "… · Big change: spec,
  plan, code and tests next?" with the facts that made it big.
- The person who wants a bigger change says so instead of Yes ("make it a big change"): `work shape big` adds the big
  steps, then the same question is asked again. A big change stays big: steps are only added after the start.

**ITW:REQ-104, a small change: implement and test in one step.**
- The code step writes the code and its tests in one generation.
- SFlow runs the tests itself: the code step's own gate runs the repository's test commands before its publication and
  keeps the run as the step's delivery evidence (`tests run`, the code step's `testsAtSubmit`); an agent's claim that
  tests pass counts for nothing. Zero tests found, a skipped required test or a timeout is never a pass (v1.1 §4).
- Every clause of the requirement needs a test: the requirement plans the code (it is its plan), its planned-claims table
  names a planned test for each clause, and the code step's check holds the publication until each one is covered.
- The person approves the delivered code. Then SFlow runs the tests once more in the tests step, which nobody is asked
  about: SFlow approves it when the repository's tests pass at its submission (`testsAtSubmit: repository`). It is SFlow's
  own run, and the record the Story's final check reads for each clause (built 2026-11-27: with the code step last, the
  final evaluation found the clauses' test evidence open and routed the code's approval to the evidence matrix, so the
  run that records it stays a step of its own). Decided (owner, 2026-11-28: "Hidden step is fine"): the tests step stays
  SFlow's own, and the evidence model is not changed.

**ITW:REQ-105, a big change: spec, plan, code and tests.**
- Steps: the requirement → spec (the repository's requirements step, labelled "Spec") → plan → code (labelled "Code") →
  tests. The requirement keeps the requirement IDs it wrote, beside the spec's (`clauseKeeps`), and stays the person's
  (`personKeeps`).
- Design: when the analysis finds UI or architecture work (a named file in a UI folder or with a UI extension, a new
  module or service folder, or a public interface), the spec is followed by the repository's design step, so a big UI or
  architecture change never skips design. A small change never gains design unless the person asks ("add a design
  step", REQ-009).
- A person approves the requirement, the plan and the code; SFlow approves the spec, the design and the tests when they
  are clean. The team's rules can raise any of these.

**ITW:REQ-106, a small change that turns out bigger grows by itself.** At the code step's submission SFlow reads the
application files the code changed (tests apart) with the same facts as REQ-103. When they are over a small change's limits,
change the data or a public interface, or touch a `paths` rule that adds a plan, the task grows to big and says so in one
line: a plan step goes before the code, SFlow returns the code to it (REQ-014's `grow`, `task-grown`), and a tests step goes
after the code. The requirement stands as its spec. A fix grows into a change, as in v1.1; the other kinds keep their
kind. A person approves the plan, then the code again. No extra yes.

**ITW:REQ-107, the team's rules in every shape.** `always` and `paths` rules (their steps and `personApproves`) apply
to every task: a sized one, a refactor, and one that runs a named workflow (`use`, the team's own workflow, an agent's
workflow).
- On a named workflow they only add: a step the workflow already has is not added again; a rule's step the workflow lacks
  goes where its intent goes; a step whose approval a rule gives a person is the person's. The workflow's own steps keep
  their order and settings. `use` still picks the workflow.
- With nothing added, the Story runs the workflow exactly as v1.1 ran it (`uses`), so its records are the same.
- A started task that runs a named workflow gains a `paths` rule's steps for the files its code changed, as a composed
  one does (REQ-014).

**ITW:REQ-108, the team's own matching workflow needs no question.** When one of the team's own workflows covers the task
(v1.1 REQ-020's rule), the task uses it with no question; the plan line says "from your team's workflow …" and the rules
still add to it (REQ-107). `--without-workflow ID` declines it. An agent the repository has but whose workflow is not
imported yet, and every marketplace agent, still ask, because their workflow comes in through the conversion review.

**ITW:REQ-109, an analysis is done, then offers follow-ups.**
- An investigate, review or docs task has no approval by a person: SFlow approves its requirement and its report or
  document when they are clean (reviewer ready, checks passed), as it approves any clean step. The requirement asks only
  what the words leave open (REQ-102).
- Its report ends with "## Follow-ups": one numbered item for each finding that could be its own Story, its title on the
  first line and its details after. SFlow asks for it in the Story's intake, under "How SFlow sizes this task".
- When the task is done, `work status` names each follow-up with the complete command that starts it (`followUps`); the
  last message asks "Start a story from: 1) … 2) …", one choice each and "No". One Yes starts the new Story:
  `work "<its title>" --from <ID> --finding <N> --start`, whose intake carries that finding's details and where they came
  from, not the whole report. A docs task's follow-up is "Implement <its document>", which starts a task bound to that
  version of the document (`--document`, REQ-016).
- `--from <ID>` without `--finding` carries the whole report, as in v1.1.

**ITW:REQ-110, the agent used for similar changes before.** With the plan, SFlow reads this repository's history, on this
machine only (OMK: usage and outcomes stay local):
- earlier task Stories whose records this checkout holds (merged into it, or on a local branch), each with its kind, the
  areas and files its code changed or its requirement named, where its steps came from (`composition.agent`, `local`,
  `uses`, `skills`) and how it went: approved first time (no step returned, every person-approved step at version 1), how
  many returns, how many versions;
- the Story lessons kept for those files (src/story-lessons.mjs, `singularity/knowledge/records`).
- A Story is similar when it is of the same shape group (code or analysis) and shares an area with this task (the files
  `--path` names and those the words name).
- The plan names the source used most for similar changes: "For similar changes to src/value you used acme's qa agent 3
  times, 2 approved first time. Use it, or let SFlow decide?". It is asked where a yes can still choose the steps (before
  the Story starts): a marketplace or local agent asks, with "let SFlow decide" as the default (`--without-agent`); the
  team's own workflow is used without asking (REQ-108) and the line says so. Marketplace agents that fit are offered as in
  v1.1 when the history names none. The lessons kept for the files are named in one line ("2 lessons from earlier
  Stories reach its steps").
- With no history the plan says nothing more.

**ITW:REQ-111, the turn goes on without hooks.** Where SFlow's Copilot hooks do not run (IntelliJ Copilot's local agent,
a folder opened through a symbolic link), the after-tool hook cannot carry the `/sf-task` turn on (src/task-turn.mjs).
- A task's start, submission and approval results say who carries the turn on: `taskTurn.carriedBy` is `hooks` when a
  live `/sf-task` turn record (the prompt hook's, `copilot-boundaries`) binds this repository, else `skill`. SFlow decides
  this from the record's absence, never from the host's word.
- With `skill`, the sflow-task skill goes on by its own instructions: after each start, submission or approval it reads
  the Story's next action (`work status <ID> --json`, its `next`) and does it in the same turn, stopping only at a
  person's approval or question, exactly where the hook path stops. No new stop, relay or hand-off.
- Where SFlow knows hooks were expected and did not run in a Copilot chat (`SFLOW_HOOKS_OFF`), its guard is off, so SFlow
  stops there and says why, as today. Decided (owner, 2026-11-28: "Stop and say why").

**ITW:REQ-112, counting a person's work.** The journeys (test/journey-tasks.test.mjs and test/journey-tasks-shapes.test.mjs)
count a person's actions through the real CLI:
- a small change: 3 (the words, the requirement's Yes, the code's Yes);
- a big change: 4 (and the plan's Yes);
- an analysis: 2 (the words, one follow-up's Yes);
- a small change that grows: 4 (the words, the requirement, the plan, the code);
- nothing typed again between them (v1.1 REQ-019).

**ITW:REQ-113, every decision says why (owner, 2026-11-28: no one gets stuck, and every decision says plainly why the
person is making it).** Each of a task's questions to a person carries one plain line, `why`, that says why the person
is asked and what each answer does (src/task-shape.mjs `taskApprovalWhy`), and every stop has a way forward on the same
screen:
- the requirement's approval: you decide what gets built; Yes starts implement and test (a big change: the spec, then the
  plan); a small one also offers "Make it a big change" beside the Yes, a choice with its complete command, after which
  the requirement asks its Yes again;
- the plan's approval: you decide how the code is written; Yes: the code is written to it;
- the code's approval: you decide whether this code goes in; Yes: SFlow runs the tests itself and approves the tests
  step when they pass;
- a refactor's plan: you decide what must not change; Yes: the code is changed to it, and SFlow checks that what passed on
  the base before any edit still passes; its code: you decide whether the refactor goes in, its behaviour the same, checked
  before and after; Yes: SFlow runs the tests again at the tests step. A refactor keeps v1.1's steps, so every refactor
  Story says these lines. A Story of another kind started under v1.1 (no `sizing`) keeps its approval's own words
  ("Your Yes approves Plan version 1 as you reviewed it."), as §4 says;
- a step a team's rule gives a person says the `because` of each rule that gave it that approval, and only those: two
  rules on the same step are said on one line ("the team's rules ask: A; B"). The composition keeps them
  (`approvalRules`: each `{ intent, rule, because }`, once per intent and rule, present only when a rule gives a person an
  approval; a step a rule adds later adds its own), and the step's pinned reason is the same words. A Story recorded
  before them names no rule it cannot tell gave the step ("the team's task rules give it to you");
- Not now, on each, says what waits: "Not now: the plan waits; /sf-task brings it back." (the requirement, the spec, the
  plan, the code, the tests, the review);
- a done analysis asks "Start a story from one of these findings?" and says that each starts a new task carrying only that
  finding, and that No starts nothing and keeps the report;
- the agent used before asks "Use it, or let SFlow decide?", its No said in those words (`noWords`).
Steps SFlow approves itself (the hidden tests step, an analysis's report) ask nobody. The grown task asks no question: one
line says why it grew. `SFLOW_HOOKS_OFF` says why and gives the complete fix (REQ-111).

**ITW:REQ-114, making a big change small (owner, 2026-11-28: "Offer it"). Decided, not built.** A big change's requirement
approval offers "Make it a small change" beside the Yes, as a small one offers "Make it a big change": a choice with its
complete command (`singularity-flow work shape small --work-id <ID> --json`) and a why line ("Make it a small change: no
spec or plan; implement and test come next, with any step a team's rule adds."). The command takes out the steps the big
shape added (the change records with `shape: 'big'`), only while the requirement waits for its approval and none of those
steps has started, keeps every step a team's rule gave the task, names the code step "Implement and test" again, and
records the person's choice, so a version of the requirement submitted later is not made big again by its own facts. The
requirement then asks its Yes again: the approval's receipt is bound to the Story as it was. A small change whose code
turns out bigger still grows (REQ-106).
Why not built yet: every task change so far only adds a step (v1.1 REQ-009, "a started task only gains steps"), and each
is replayed on every later load through the Story's append-only snapshot chain (src/workflow-snapshot-task-changes.mjs,
src/task-change-contracts.mjs, src/task-change-review.mjs). Taking steps out is a new kind of task change: its decision
and summary records, the replay of a removal (the step's assets kept, its policy taken out), the review of its state
change, and the invariants that steps and a person's approvals only grow, each with its exception named. A Story with
such a change cannot be read by an SFlow that does not know it, so the record is version-sensitive (src/upgrade-contract.mjs).
It is built as M7 with those suites run.

## 4. Stories already in flight

A Story records its composition when it starts. One started under v1.1 has no `sizing` and keeps its steps, its
approvals, its question words and its growth (a fix into a change for a migration or contract file only). Nothing here
rewrites a Story's record. The team's rules added to a named workflow (REQ-107) apply to tasks started after this
version; a v1.1 Story that ran a `use` workflow keeps running it as it is.

## 5. What v1.1's composition section becomes

| v1.1 | v1.2 |
|---|---|
| REQ-003: steps from the kind (fix: intake → code → test, …) | REQ-101–106: requirement → implement and test, or the big steps, decided at the requirement's approval; analysis as before |
| REQ-004 defaults: every code change gets a test step | Unchanged, and the tests step of a small change is SFlow's alone: it runs the tests and approves itself when they pass |
| REQ-004 defaults: a person approves a plan where there is one | Unchanged; the requirement of a sized task is always a person's |
| REQ-005: a person approves what the rules give a person | Unchanged; an analysis gives a person nothing |
| REQ-020: the team's own workflow is offered with a question | REQ-108: used without asking |
| A11: a fix takes 4 actions | REQ-112: a small change takes 3 |

## 6. Acceptance

- **B1:** `/sf-task make the value module return 2` composes requirement → implement and test → SFlow runs the tests;
  the requirement asks nothing; the approval asks "Approve the requirement v1 · Small change: implement and test next?";
  the Story ends after the code's approval with its tests run by SFlow at the code step and again at the tests step,
  which SFlow approves; 3 person actions.
- **B2:** A requirement that proposes a big change, or names more than 5 files or more than 2 areas, a migration or a
  contract file, gains spec, plan and tests steps at its submission; its question says "Big change" and why; the Story ends
  with the requirement, the plan and the code approved by a person; 4 person actions.
- **B3:** A big change whose requirement names a UI file gains a design step after the spec.
- **B4:** A small change whose code changes 6 application files grows: a plan before the code, the code returned to it,
  a tests step after it, one line saying why.
- **B5:** A `use` rule's workflow and the team's own workflow gain an `always` rule's step and a `paths` rule's step for
  the files the task names; a workflow that already has the step does not gain it twice; with no rule, the Story's
  composition is v1.1's byte for byte.
- **B6:** The team's own covering workflow is used with no question; a marketplace agent still asks.
- **B7:** An investigation ends with its report approved by SFlow, no person's approval, and `followUps`; one Yes starts
  a fix whose intake holds that finding alone; 2 person actions.
- **B8:** With an earlier Story of this repository that used a marketplace agent for the same area and was approved
  first time, the plan says so and asks "Use it, or let SFlow decide?"; with none, it says nothing.
- **B9:** With no live turn record, a task's results say `taskTurn.carriedBy: skill`, and a journey walked with the hooks
  off reaches the end with the same person actions.
- **B10:** A Story started before this version keeps its steps and its approval words.
- **B11:** Each approval of a sized task carries `why` (the requirement's, the plan's, the code's, a rule's step's); a
  small requirement's approval offers "Make it a big change" with its complete command; a done analysis's `ask` says what
  each answer does. A refactor's plan and code carry their own; Not now names what waits; a step two rules give a person
  says both rules' reasons and no other rule's.
- **B12:** A small change whose person answers "Make it a big change" at its requirement gains a spec and a plan; the
  same requirement asks its Yes again ("… · Big change: spec, plan, code and tests next (you asked for it)?") in the same
  turn, nothing typed; then the plan and the code; 5 person actions (the words, the choice, three Yeses).
- **B13 (decided, not built):** A big change whose person answers "Make it a small change" at its requirement loses the
  spec, design, plan and tests its shape added, keeps every step a team's rule gave it, and asks its Yes again
  ("… · Small change: implement and test next (you asked for it)?").

## 7. Open questions for the owner, with the default built (7 and 8 decided 2026-11-28)

1. **The limits of a small change.** Default: at most 5 application files and 2 areas, tests apart.
2. **Making a big change small.** Default: not after the start; a big change stays big (steps are only added). The person
   can make a small change big at the requirement's approval.
3. **Where the agent question is asked.** Default: with the plan, before the Story starts, because an agent's yes
   chooses the steps and a started task only gains steps. Its analysis is the words, the files they name and the
   repository's history. The alternative, asking at the requirement's approval, needs a re-plan of the steps not started
   yet (not built).
4. **Design in a big change.** Default: the repository's design step right after the spec, SFlow-approved, so its own
   template and review apply. The alternative is one "spec and design" step.
5. **A refactor.** Default: always big, with v1.1's steps (its plan says what must not change); it gains no spec step.
6. **An analysis's follow-ups.** Default: from the report's "Follow-ups" section; a docs task's one follow-up implements
   its document.
7. **Hooks expected but not run.** Decided (owner, 2026-11-28: "Stop and say why"): where SFlow knows a Copilot chat's
   hooks were expected and did not run (`SFLOW_HOOKS_OFF`, a VS Code folder opened through a link), SFlow's guard is
   off, so SFlow stops there and says why, as today. The skill carries the turn on where no hook is installed for the
   host (IntelliJ's local agent) and wherever SFlow's commands still run.
8. **One step for implement and test, with nothing after it.** Decided (owner, 2026-11-28: "Hidden step is fine"): the
   tests step stays SFlow's own (no person, no question), because the final evaluation reads each clause's test evidence
   from it. The evidence model is not changed.

## 8. Milestones

| Milestone | Scope |
|---|---|
| M1 | The requirement first, the shape at its approval, a small change in one step, growth (REQ-101 to 106, 112) |
| M2 | The team's rules in every shape, the team's own workflow without a question (REQ-107, 108) |
| M3 | An analysis with no approval, and its follow-ups (REQ-109) |
| M4 | The agent used for similar changes before, and the lessons (REQ-110) |
| M5 | The turn without hooks; the skill text, help and topics (REQ-111) |
| M6 | Every decision says why, with a way forward on the same screen (REQ-113, owner 2026-11-28) |
| M7 | Making a big change small at its requirement (REQ-114, owner 2026-11-28: "Offer it"); not built |
