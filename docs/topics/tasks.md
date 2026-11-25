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
version: 9
---
Say what you want done and SFlow does the rest of the setting up: `/sf-task fix the login timeout on slow networks` in Copilot, or `sflow work "fix the login timeout on slow networks" --start` in a terminal. There is no base, workflow or Story ID to choose. The words name a kind of task, and the kind gives the steps, the same way every time:

| Kind | Steps |
|---|---|
| fix, chore | intake → code → tests |
| change | intake → plan → code → tests |
| feature | intake → requirements → plan → code → tests |
| refactor | intake → plan (what must not change) → code → tests; before any edit, the tests run once on the base (`sflow tests base`), so what already fails there is never read as a change |
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
before it."), and so is taking a step out after the start.

**A fix that grows.** A `paths` rule also applies to what the code step actually changed: when the code is submitted and
its files match a rule, the rule's steps are added the same way, after the step being worked on, recorded as the rule's
with its `because`, and the submission says so in one line ("Added a review step after the tests: Changes to sign-in are
reviewed."). A rule's step whose place has passed, such as a plan once the code is written, is named and not added.

## State and safety

`work` without `--start` reads only. `--start` creates the Story's branch and its record, as `start` does, under the same identity, authority, branch and publication checks. The composed steps are recorded with the Story; `singularity/workflow.yml` is never written. `work add` writes one Story commit: the step, its decision record and the new version of the task's workflow; every later command checks that version against its history.

## Troubleshooting

- If the words fit no kind, name one with `--kind`; the refusal lists the kinds.
- If the repository's workflow has no step for a purpose the task needs, add one in Workflow Studio, or start the Story with `sflow start` and a workflow of your own.
- If a `tasks:` rule is refused, fix the rule its words name; the plan is shown again once it is valid.

## Related topics

Continue with `sflow explain starting-work`.
