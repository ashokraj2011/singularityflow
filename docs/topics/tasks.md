---
id: tasks
title: "Tasks: say what you want done"
aliases:
  - task
  - sf-task
  - intent-to-work
commands:
  - work
related:
  - starting-work
version: 12
---
Say what you want done and SFlow does the rest of the setting up: `/sf-task fix the login timeout on slow networks` in Copilot, or `sflow work "fix the login timeout on slow networks" --start` in a terminal. There is no base, workflow or Story ID to choose. The words name a kind of task, and the kind gives the steps, the same way every time:

| Kind | Steps |
|---|---|
| fix, chore | intake → code → tests |
| change | intake → plan → code → tests |
| feature | intake → requirements → plan → code → tests |
| refactor | intake → plan (what must not change) → code → tests; before any edit, the tests run once on the base (`sflow tests base`), and the test step compares its run with it: a test that passed before and fails after is a behaviour change, one that failed before is a finding |
| tests | intake → write the tests → tests |
| docs | intake → write the document (kept with the Story; a later task starts from it with `--from`) |
| investigate | intake → investigate, ending with a report; no code changes |
| review | intake → review, ending with findings; no code changes |

Each step is one of the repository's own steps for that purpose, so it keeps its agent, its template and its settings. A person approves two things: the plan (for a fix, the intake is its plan) and what the task delivers (the code, the document, or the report). SFlow approves the other steps when they are clean.

**The plan first.** `sflow work "<words>"` shows the plan and writes nothing; `--kind` names the kind when the words alone do not. `--start` starts the Story: its ID is a Jira key the words or `--work-id` name, otherwise the next free `TASK-<n>`; its base is the default branch; its intake is your words. The composed workflow is recorded with the Story, so every later command and a second laptop see the same steps. It is never written to `singularity/workflow.yml`.

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
    release: classic-delivery
```

`always` applies to every task of the kinds it names (or `all`); `paths` applies when the task touches those files (`sflow work "<words>" --path src/auth/login.js`); `use` sends a kind to one of the repository's workflows, unchanged. A step is one of intake, requirements, design, plan, code, test or review. Each rule needs a `because`, which the plan shows when the rule adds a step.

**Skills for each step.** Each step gets the skills that fit it, the same way every time. A skill fits a step when one of its tasks is what the step is for (the marketplace's task list, as `workflow from-agent` reads it: `e2e-testing` and `unit-testing` are a code step's, `test-case-creation` a requirements step's) and the task touches it: the skill is for the kind of software this repository is (web, backend, mobile and so on, as `sflow capability kind` shows them), or your words name one of its tags. A skill for another kind of software is never chosen. At most two per step.

- **The repository's skill library first.** A library skill names its tasks in its tags:

  ```yaml
  metadata:
    sflow-tags: [task:e2e-testing, web, playwright]
  ```

  `intent:<step>` names a step directly (`intent:test`). A skill tagged `beta` or `proposed` (or `lifecycle:proposed`) needs your yes.
- **Then the marketplaces the repository trusts**, for a step the library has nothing for, each read at the commit `marketplaces:` in `singularity/workflow.yml` pins. A marketplace the repository does not trust is never read. A skill offered from one is new here: the plan line says "code (with web-e2e-test-generation from acme, new here: add it?) → tests". Your yes reads its exact text (`sflow import preview "market:acme/web-e2e-test-generation" --as skill`) and adds it to the library like any import, with what its marketplace says about it (its tasks, tags and lifecycle). The next task finds it there and asks nothing.

A task with a skill that needs your yes does not start until you answer: `--use-skill <ID>` is yes, `--without-skill <ID>` is no. The Story keeps the exact text of each skill it uses with its steps, so a later change to the library, or a second laptop, uses the same text.

`/sf-start` stays the route for choosing the base, the intake and the workflow by hand.

## Purpose and prerequisites

Use this topic to start work by saying what you want done. The repository must use Singularity Flow (`sflow init`), and its workflow must have a step for each purpose a task uses: intake, plan, code and test, and requirements and design for the kinds that use them. The packaged workflow has them all.

## Use it from each surface

- **Shell:** `sflow work "<what you want done>"` shows the plan; add `--start` to start it. Run `singularity-flow work --help` for every option.
- **Copilot:** `/sf-task <what you want done>`. The agent names the kind of task from your words and starts it; `/sf-task` with no words then does whatever comes next.
- **VS Code:** a task started in Copilot or the terminal appears in **My Work** like any Story.

## Guided workflow

1. Say what you want done, in your own words.
2. Read the one-line plan: the steps, and what you approve.
3. Start it. SFlow picks the Story ID, the base and the steps.
4. Carry on with `/sf-task`, with no words, each time: it does whatever comes next, the step's own work, or your
   approval, asked in the chat. In VS Code, approving a task's step on the approval page carries the chat on by itself.
5. When the last step is done, say `/sf-task open the pull request` if you want one.

While a task is open, words after `/sf-task` belong to it: an answer to its question, or a change you want. Start
another task while one is open with `/sf-task new task: <what you want done>`.

`sflow work status` says where the task on this checkout stands: each step and who approved it. "Fix it" after an
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

**A refactor that changes behaviour.** Run its `task.before` (`sflow tests base`) before any edit. When the refactor's
tests fail, the test step stops and names each test that passed before and fails after. You choose: keep the old
behaviour (the code step's next version restores it) or accept the new one (the task becomes a change, and its plan is
revised first). A test that already failed before is a finding the refactor does not approve.

## Tasks from Ask SFlow evidence

An Ask SFlow task handoff carries the selected reviewed specification revision, its state commit and content and manifest SHA-256 digests, the selected clauses, and supporting evidence references. ITW checks those sources again before creating the Story. A newer revision can be published while the handoff still uses the selected one. A missing or changed selection needs a new plan.

`singularity-flow work handoff ITW-ID --for-person` inspects the original receipt. Add `--start` to accept the prepared plan or retry a retained reservation. ITW keeps one Work ID for that handoff, checks for the matching committed Story when the outcome is uncertain, and reports when recovery needs inspection. The handoff receipts are private to the Git clone and identity. `work status TASK-ID` shows the accepted Story and its ordinary approval steps.

## State and safety

`work` without `--start` reads only; it keeps the list of a trusted marketplace's skills at the commit it reads, in the clone's Git folder, so the same commit is not fetched again. `--start` creates the Story's branch and its record, as `start` does, under the same identity, authority, branch and publication checks. The composed steps are recorded with the Story; `singularity/workflow.yml` is never written. `work add` writes one Story commit: the step, its decision record and the new version of the task's workflow; every later command checks that version against its history.

## Troubleshooting

- If the words fit no kind, name one with `--kind`; the refusal lists the kinds.
- If the repository's workflow has no step for a purpose the task needs, add one in Workflow Studio, or start the Story with `sflow start` and a workflow of your own.
- If a `tasks:` rule is refused, fix the rule its words name; the plan is shown again once it is valid.
- If the start says a skill needs your yes, read the skill (a marketplace one's text is shown), then start again with `--use-skill <ID>` or `--without-skill <ID>`.
- If the start says a skill changed since the plan was shown, show the plan again: it chooses from the library as it is now.

## Related topics

Continue with `sflow explain starting-work`.
