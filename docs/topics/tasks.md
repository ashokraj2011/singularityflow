---
id: tasks
title: "Tasks: say what you want done"
aliases:
  - task
  - sf-task
  - intent-to-work
  - team-rules
  - task-rules
commands:
  - work
  - rules
related:
  - starting-work
version: 25
---
Say what you want done and SFlow does the rest of the setting up: `/sf-task fix the login timeout on slow networks` in Copilot, or `sflow work "fix the login timeout on slow networks" --start` in a terminal. There is no base, workflow or Story ID to choose. The words name a kind of task (fix, feature, change, refactor, tests, docs, investigate, review or chore), and you see one of three shapes:

| Shape | Kinds | Steps | You approve |
|---|---|---|---|
| Small change | fix, chore, change, feature, tests, when the requirement says small | requirement → implement and test → SFlow runs the tests | the requirement and the code |
| Big change | the same kinds, when the requirement says big; a refactor always | requirement → spec (→ design) → plan → code → tests | the requirement, the plan and the code |
| Analysis | investigate, review, docs | requirement → the report or document, then follow-ups | nothing; you choose a follow-up |

**The requirement first.** A code task starts with its requirement: numbered clauses, each with how it is tested; an analysis of the files and areas it likely touches, any data or public interface change and the risk; and the size Copilot proposes ("Size: small change"). It asks only what your words leave open. When it is submitted SFlow checks the proposal against the files the requirement names: a small change touches at most 5 files in at most 2 areas, with no migration, schema or contract file, and no team `paths` rule that plans those files. SFlow only ever makes a change bigger. The approval question says the shape ("Approve the requirement v1 · Small change: implement and test next?"), so your one Yes approves the requirement and confirms it. Say "make it a big change" instead (`sflow work shape big`) and the big steps are added; a big change stays big.

A small change is implemented and tested in one step: the code step writes the code and its tests, SFlow runs the tests itself before the code is published (never the agent's word that they pass), and every clause of the requirement needs a test. After your Yes to the code, SFlow runs them once more in the tests step, which it approves itself when they pass; nobody is asked about it. A big change gets a spec, a design when its analysis finds UI or architecture work (a screen or component file, a new folder, a contract), a plan, the code and its tests; SFlow approves the spec, the design and the tests when they are clean. A small change whose code turns out bigger than a small change grows by itself: a plan comes before the code (SFlow returns the code to it), a tests step after it, and the submission says why in one line.

A refactor is always big and keeps its own steps: requirement → plan (what must not change) → code → tests; before any edit, the tests run once on the base (`sflow tests base`), and the code step and the test step compare their runs with it: a test that passed before and fails after is a behaviour change, one that failed before is a finding.

An analysis is done by SFlow and Copilot with nobody asked: SFlow approves the requirement and the report (or the document) when they are clean. The report ends with "## Follow-ups", one numbered item per finding that could be its own Story; when the task is done `sflow work status` lists them, and `/sf-task` asks "Start a story from: 1) … 2) …". One Yes starts a Story from that finding alone (`--from TASK-2 --finding 1`). A docs task's follow-up implements its document, bound to the version it wrote.

Each step is one of the repository's own steps for that purpose, so it keeps its agent, its template and its settings. A team that wants the kind's own steps for every task, as before, says `tasks: { sizing: kind }`. A task started before this keeps its steps.

**The plan first.** `sflow work "<words>"` shows the plan and writes nothing; `--kind` names the kind when the words alone do not. `--start` starts the Story: its ID is a Jira key the words or `--work-id` name, otherwise the next free `TASK-<n>`; its base is the default branch; its intake is your words. The composed workflow is recorded with the Story, so every later command and a second laptop see the same steps. It is never written to `singularity/workflow.yml`.

**What is in flight.** `sflow work list` lists your tasks and Stories in flight across the workspace's repositories: the ones you started, and the ones checked out on this computer. Each shows its steps (done, now, waits for you, to do, or added) and one line on what it waits for: "Waiting for you: Approve Plan?" when it is in your Needs you, else who it waits for or the step it is at. The ones done this week say where they ended: checked on its branch, pull request open, or report ready. `--offline` shows what was kept from the last read and fetches nothing. `/sf-task` typed with no words, when no task is open in that chat, lists them first.

`sflow work "<words>" --plan-only` is the likely plan VS Code's Work box shows as you type: the kind your words name and the team's rules, with no skill or agent offered and nothing read from a marketplace. When the words do not say the kind, there is no likely plan. The plan the chat says when the task starts is the plan.

**The team's rules.** `tasks:` in `singularity/workflow.yml` adds steps or a person's approval, and never removes one:

```yaml
tasks:
  idPrefix: TASK
  always:
    - kinds: [feature]
      steps: [review]
      because: Every feature gets a conformance review.
  paths:
    - paths: ["src/auth/**"]
      steps: [review]
      personApproves: [test]
      because: Changes to sign-in are reviewed and their test results read by a person.
  use:
    change: classic-delivery
```

`always` applies to every task of the kinds it names (or `all`); `paths` applies when the task touches those files (`sflow work "<words>" --path src/auth/login.js`); `use` sends one kind (fix, feature, change, refactor, tests, docs, investigate, review or chore) to one of the repository's workflows, which then runs exactly as it is. A step is one of intake, requirements, design, plan, code, test or review. Each rule needs a `because`, which the plan shows when the rule adds a step. A rule may have an `id`, so a Story names it by that and not by its place (`always[0]`); a `use` rule can be written `change: { workflow: classic-delivery, because: …, id: … }` to carry its own.

**The team's rules in one list.** `sflow rules` lists them in plain words: the three SFlow keeps for every task (every code change gets tests; a person approves the code; a person approves a plan where there is one), then each rule as "When … : …" with its because and its ID, the ones waiting for review with who proposed them, the ID prefix ("Tasks are named TASK-<n>") and each kind's steps. It also says how many lessons the agents read as team guidance (they add no step), and how many tasks in flight keep the rules they started with: a rule change applies to tasks started after it is approved. `--offline` reads no proposals. In VS Code, the Rules place shows the same list and a form: When (any code changes, a task is of these kinds, or a task touches these files), Then (add a step, a person approves a step, or follow one of this repository's workflows, for one kind) and Why. Beside it, `sflow rules preview --change-set <FILE>` says for each kind of task the steps before and after ("A fix touching src/billing/x.ts: Intake → Code → Tests → Conformance review (added). You approve the plan in the intake and the code."), and every problem with where it is. **Propose this rule** sends one Workflow Studio change set (`tasks.rule.add`, `tasks.rule.change`, `tasks.rule.remove` or `tasks.idPrefix.set`) through `workflow studio apply --propose`, the reviewed path every configuration change takes; it is a Review item in the Needs you of each person who may approve it, and applies once approved. `workflow check`, a configuration save and `configuration approve` check the rules too: a problem in a rule a change adds or changes is refused with its field (`tasks.paths[1].because`); one already there in a rule it leaves alone is a warning.

**Skills for each step.** Each step gets the skills that fit it, the same way every time. A skill fits a step when one of its tasks is what the step is for (the marketplace's task list, as `workflow from-agent` reads it: `e2e-testing` and `unit-testing` are a code step's, `test-case-creation` a requirements step's) and the task touches it: the skill is for the kind of software this repository is (web, backend, mobile and so on, as `sflow capability kind` shows them), or your words name one of its tags. A skill for another kind of software is never chosen. At most two per step.

- **The repository's skill library first.** A library skill names its tasks in its tags:

  ```yaml
  metadata:
    sflow-tags: [task:e2e-testing, web, playwright]
  ```

  `intent:<step>` names a step directly (`intent:test`). A skill tagged `beta` or `proposed` (or `lifecycle:proposed`) needs your yes.
- **Then the repository's own skills**, for a step the library has nothing for: each `SKILL.md` in `.github/skills/<id>/` (Copilot's folder) and `.agents/skills/<id>/` (where APM installs a package's skills). Their tags say what they are for, as a library skill's do; for one APM installed, `apm.lock.yaml` says which package, and APM's copy of that package (`apm_modules`, when it is on this computer) says its tasks and tags. A skill the library also has is the library's. One APM installed and someone changed since is not used, and neither is one whose `SKILL.md` cannot be read: the plan names each in a note with what fixes it (`apm install`, or the file to correct), and the task goes on without it. The Story keeps the exact text of each one it uses, with where it came from.
- **Then the marketplaces the repository trusts**, for a step neither the library nor the repository's own skills have anything for. A Git repository marketplace is read at the commit `marketplaces:` in `singularity/workflow.yml` pins. An HTTPS index marketplace is read through its index; an entry's `phases` name the steps it is for. Its skill list is kept in the clone's Git folder for an hour, so showing a plan does not fetch the index each time (`sflow skill catalog` reads it fresh). A marketplace the repository does not trust is never read. Where an approved configuration is known, a marketplace is read as it trusts it, and one only your working copy of `workflow.yml` trusts is not read: the plan notes it instead. A skill offered from one is new here: the plan line says "code (with web-e2e-test-generation from acme, new here: add it?) → tests". Your yes reads its exact text (`sflow import preview "market:acme/web-e2e-test-generation" --as skill`) and adds it to the library like any import, with what its marketplace says about it (its tasks, tags and lifecycle). The next task finds it there and asks nothing.

A task with a skill that needs your yes does not start until you answer: `--use-skill <ID>` is yes, `--without-skill <ID>` is no. The Story keeps the exact text of each skill it uses with its steps, so a later change to the library, or a second laptop, uses the same text.

**The team's own workflow as the plan.** What the team already has comes first. When one of the repository's own workflows covers the task (one made in Workflow Studio, made from an agent with `sflow workflow from-agent`, or imported; never one SFlow ships or one archived) and the task's kind has no `use` rule, it is the plan with no question: the plan line says whose it is ("Plan, from your team's workflow Secure fix: …"), and so does `sflow work status`. It covers the task by the same rule as an agent below. The team's `tasks:` rules add to it as to any plan: a rule's step the workflow lacks goes where it belongs, a step it has is not added twice, and a step a rule gives a person is theirs; with nothing to add it runs exactly as it is. The same holds for the workflow a `use` rule picks.

- `--without-workflow secure-fix` is no: the task keeps its own steps.
- `--use-workflow secure-fix` names one when more than one would do.

**What you used before.** The plan reads this repository's earlier task Stories that this checkout holds, on this computer only. When an agent or workflow was used most for similar changes (the same area, or a file your words name), it is offered first, with how those Stories went: "For similar changes to src/auth you used acme's secure-fix agent 3 times, 2 approved first time. Use it, or let SFlow decide?". No lets SFlow decide. The plan also names how many lessons earlier Stories left for those files.

Then an agent the repository has: one in `.github/agents` (a `<name>.agent.md`, or a folder holding `agent.md`), or an agent APM installed (its package in `apm_modules`, with its `apm.yml`), whose stages cover the task by the same conversion and rule: "Installed agent qa-test-automation-agent covers this task: add its workflow to this repository and use it as the plan, …?". Its workflow comes in first through its conversion review (`sflow workflow from-agent <its path> --propose`), as a marketplace agent's does; once that change is approved, `--use-workflow <its workflow>` is the yes, and the next plan offers it as the team's own. An agent with no numbered stages is a chat agent and is never offered.

**A marketplace agent as the plan.** When nothing of the team's own covers the task, and one agent of a marketplace the repository trusts has stages that cover it, the plan offers that agent's workflow instead: "acme's qa-test-automation agent covers this task: use its workflow as the plan, requirements → write the tests → tests?". What each stage is for comes from the same conversion `sflow workflow from-agent` makes, read at the commit the repository trusts. The agent covers the task when it has a step for each of the task's own steps (a requirements step before the code also plans it), and its code is the task's kind of code: an agent whose code steps only write tests is offered for a tests task, and one with a code step is never offered for a task that changes no code. Only one agent is offered: one whose workflow is already in the repository first, then the closest fit. An agent marked deprecated is never offered; one marked proposed says so. A question the agent asks before any work, with its choices ("Which channel is this test automation for? 1. web 2. android"), is asked once, in its own words and choices, in the intake's clarification; the intake's submission records your answer, and the skills of each later step follow it.

- Read what it becomes first: `sflow workflow from-agent acme/qa-test-automation-agent --review` shows its conversion review.
- `--use-agent acme/qa-test-automation-agent` is yes: the task's steps are that workflow's, in its order, and the team's `tasks:` rules still add their steps and approvals. The plan line says whose they are ("Plan, from acme's qa-test-automation agent: …"), and the Story records the marketplace, the agent and its version with its steps, so a second laptop resumes the same steps.
- An agent whose workflow is not in the repository yet comes in first through its conversion review, as a reviewed configuration change (`sflow workflow from-agent acme/qa-test-automation-agent --propose`, then the import it shows). Until that change is approved, a start with `--use-agent` says so; `--without-agent` starts the task with its own steps now, and a later task uses the agent's workflow.
- `--without-agent acme/qa-test-automation-agent` is no: the task keeps its own steps and nothing more is asked.

Only one is ever offered: a workflow already in the repository, then an agent the repository has, then a marketplace agent. With nothing that covers the task, the plan is as above and nothing is asked.

`/sf-start` stays the route for choosing the base, the intake and the workflow by hand.

## Purpose and prerequisites

Use this topic to start work by saying what you want done. The repository must use Singularity Flow (`sflow init`), and its workflow must have a step for each purpose a task uses: intake, plan, code and test, and requirements and design for the kinds that use them. The packaged workflow has them all.

## Use it from each surface

- **Shell:** `sflow work "<what you want done>"` shows the plan; add `--start` to start it. Run `singularity-flow work --help` for every option.
- **Copilot:** `/sf-task <what you want done>`. The agent names the kind of task from your words and starts it; `/sf-task` with no words then does whatever comes next. `/sf-explain team rules` explains the team's rules; `sflow rules` lists them as they are.
- **VS Code:** a task started in Copilot or the terminal appears in **My Work** like any Story. The Rules place lists the team's rules and proposes a change to them.

## Guided workflow

1. Say what you want done, in your own words.
2. Read the one-line plan: the steps, and what you approve.
3. Start it. SFlow picks the Story ID, the base and the steps, and the same chat turn goes on into the first step: its
   question, then its writing.
4. Approve in the chat when asked: a step's submission goes on to its approval question, and after your Yes the same
   turn goes on with the next step, as it does after a step SFlow approves itself. `/sf-task`, with no words, is for coming back: it does whatever comes next, the step's
   own work, or your approval, asked in the chat. In VS Code,
   approving a task's step on the approval page carries the chat on by itself, and the Journey's next action names
   `/sf-task` too.
5. When the last step is done, say `/sf-task open the pull request` if you want one.

While a task is open, words after `/sf-task` belong to it: an answer to its question, or a change you want. Start
another task while one is open with `/sf-task new task: <what you want done>`.

`sflow work status` says where the task on this checkout stands: each step and who approved it, and once it is done the
checks that ran. "Fix it" after an
investigation starts a fix from its report (`--from TASK-2`), and a task about a document pins the version it starts with
(`--document docs/specs/export.md`). "… and open a pull request" in the first words ends the plan with one. Before a task starts, "add a design step" or "skip the plan"
(`--add design`, `--skip plan`) changes its steps; a team rule's step, the intake and a code task's tests stay.

**A started task only gains steps.** "Add a design step" on a started task (`sflow work add design`) adds it where it
goes, after the step being worked on: a review after the tests, a design or a plan before the code while the code is not
started yet. Done steps and the current one stay exactly as they are; the steps after it read the new one. It is
recorded with who asked, as a new version of the task's workflow, and needs no approval of its own, since it only adds
work. A step whose place has passed is refused with the reason ("The code is already being written; a plan step goes
before it."), and so is taking a step out after the start. A step a team rule gives a person to approve (`personApproves`) is
theirs when it is added after the start too, and the line says so ("You approve it."). A Story whose test agreement was
confirmed for its steps keeps them: the refusal gives the command that starts the task again with the step.

**A fix that grows.** A `paths` rule also applies to what the code step actually changed: when the code is submitted and
its files match a rule, the rule's steps are added the same way, after the step being worked on, recorded as the rule's
with its `because`, and the submission says so in one line ("Added a review step after the tests: Changes to sign-in are
reviewed."). A rule's step whose place has passed, such as a plan once the code is written, is named and not added.

A fix whose code changes the data (a migration, or `schema.prisma`, `db/schema.rb`, `db/structure.sql`) or a public
interface (an OpenAPI, Swagger or AsyncAPI document, a `.proto`, a GraphQL schema) is a change: the submission says so in
one line, SFlow adds a plan step before the code and returns the code to it, so you approve the plan before the code. The
code is kept on the branch; once the plan is approved SFlow starts the code's next version itself, and you approve the
code as before. Nothing else asks you anything. Tests' own files never count.

**A refactor that changes behaviour.** Run its `task.before` (`sflow tests base`) before any edit: it runs the code
step's tests on the base. The code step runs the same tests before it is published, so a behaviour change usually shows
there first: when a test that passed before fails in a run of the code being written, the code step stops and names it,
and its author changes nothing for it until you choose. So does a change to what an existing test expects (an edited or
removed test, from the code's difference with the base; a comment, such as a criterion's tag, or a new test is not), even
when every run passes. The choice is on the decisions card (`/sf-decide`, VS Code's Decide card), where SFlow recommends
keeping the old behaviour, as a refactor promises: keep it (the code step goes on and restores it, and SFlow puts back
what each changed test expected, keeping comments its author added) or accept the new one (the code goes back to the
plan, the task becomes a change, and SFlow starts the plan's next version to say what changes; the code waits for it as
it is). In a terminal it is
`sflow work behaviour keep` or `sflow work behaviour accept`. Only you choose: Copilot never records it for you. With
SF Guard on, either choice takes your Touch ID, as every other decision of yours does. Chosen on VS Code's Decide card,
the task carries on in the chat you used last with nothing to type (VS Code sends `/sf-task`, as after an approval page);
in Copilot CLI the chat names `/sf-task`. A later
run that passes again does not lift the stop; your choice does. The test step compares its own run the same way. A test
that already failed before is a finding the refactor does not approve. Once it is a change, its plan step is named as a
change's plan ("Plan"), on every screen.

**What no check covered.** A refactor's plan lists what must not change in its planned evidence rows, with the tests
that show each. When the task is done, `sflow work status` says the checks that ran and, for a refactor, each row no
check covered: one whose tests are `not-applicable:`, or name no file a passing test ran in ("Not covered by any check:
The log line keeps its format."). A refactor is never reported as safer than what ran.

## Tasks from Ask SFlow evidence

An Ask SFlow task handoff carries the selected reviewed specification revision, its state commit and content and manifest SHA-256 digests, the selected clauses, and supporting evidence references. ITW checks those sources again before creating the Story. A newer revision can be published while the handoff still uses the selected one. A missing or changed selection needs a new plan.

`singularity-flow work handoff ITW-ID --for-person` inspects the original receipt. Add `--start` to accept the prepared plan or retry a retained reservation. ITW keeps one Work ID for that handoff, checks for the matching committed Story when the outcome is uncertain, and reports when recovery needs inspection. The handoff receipts are private to the Git clone and identity. `work status TASK-ID` shows the accepted Story and its ordinary approval steps.

## State and safety

`work` without `--start` reads only; it keeps the list of a trusted marketplace's skills and agents at the commit it reads, in the clone's Git folder, so the same commit is not fetched again. `--start` creates the Story's branch and its record, as `start` does, under the same identity, authority, branch and publication checks. The composed steps are recorded with the Story; `singularity/workflow.yml` is never written. `work add` writes one Story commit: the step, its decision record and the new version of the task's workflow; every later command checks that version against its history.

## Troubleshooting

- If the words fit no kind, name one with `--kind`; the refusal lists the kinds.
- If the repository's workflow has no step for a purpose the task needs, add one in Workflow Studio, or start the Story with `sflow start` and a workflow of your own.
- If a `tasks:` rule is refused, `sflow rules` lists every problem with where it is; fix those rules (in VS Code's Rules, or a proposed save of `singularity/workflow.yml`), and the plan is shown again once they are valid.
- If the start says a skill needs your yes, read the skill (a marketplace one's text is shown), then start again with `--use-skill <ID>` or `--without-skill <ID>`.
- If the start says a skill changed since the plan was shown, show the plan again: it chooses from the library as it is now.
- If the start says an agent's workflow needs your yes, read its conversion review, then start again with `--use-agent <MARKETPLACE/AGENT>` or `--without-agent <MARKETPLACE/AGENT>`. If it says the workflow is not in the repository yet, import it through its conversion review, or start with `--without-agent` for now.
- If the start says an agent the repository has needs your yes, start again with `--use-workflow <ID>` or `--without-workflow <ID>`. For an agent whose workflow is not here yet, import it through its conversion review first, or start with `--without-workflow` for now.
- Where Copilot runs no SFlow hooks (IntelliJ Copilot's local agent), `/sf-task` carries its own turn on: after each start, submission or approval it reads `sflow work status`, whose `taskTurn.carriedBy` says `skill`, and goes on, stopping only for your approval or question.

## Related topics

Continue with `sflow explain starting-work`.
