---
id: workflow-decisions
title: Decisions, branches and loops in Story workflows
aliases:
  - decisions
  - decision
  - branch
  - if-else
  - loop-until
  - next-action
questions:
  - How do I make a Story skip a phase when it is not needed?
  - How do I loop back to an earlier phase until a goal is met?
  - How does a person choose what happens next in a Story?
  - Why was a phase skipped?
commands:
  - decision
  - submit
related:
  - workflow-authoring
  - story-lifecycle
  - approvals
version: 2
---
A decision sits after one phase of a Story workflow and chooses what happens next: the next phase, a later one (skipping those between), an earlier one, or the end of the Story. Running Stories keep the decisions they started with.

## Purpose and prerequisites

Use a decision when not every Story needs every phase, when a phase should repeat until its result is good enough, or when a person should choose the route. There are three kinds:

- **branch** (if / else): ordered rules read values the phase recorded when it was submitted, such as `risk: high`, and choose a route. The last route has no rule and takes everything else.
- **loop**: go back to an earlier phase until a goal holds, such as `ready: yes`, at most `maxRounds` times.
- **ask**: the Story pauses and a person from the decision's approval groups chooses one of its options.

## Use it from each surface

- **Shell:** `singularity-flow submit --decision NAME=VALUE` records what a branch or loop reads; `singularity-flow decision show` and `singularity-flow decision choose` read and answer a waiting decision.
- **Copilot:** the phase skill records the values when it submits; `/sf-decide` shows a waiting decision's options and records the person's choice and reason.
- **VS Code:** Workflow Studio adds a decision after a step. During a Story, the journey shows skipped steps and loop rounds, and a waiting decision offers its options as buttons.

## Guided workflow

### Configure a decision

In VS Code, open **Workflow Studio**, select a workflow and choose **Add a decision** after a step. From configuration, add `decisions` to the work type:

```yaml
workTypes:
  feature:
    phases: [intake, requirements, design, implementation-spec]
    decisions:
      - id: needs-requirements
        after: intake
        kind: branch
        label: Does this need full requirements?
        inputs: [{ name: risk, values: [low, medium, high] }]
        routes:
          - { id: risky, label: Risky, when: { risk: [medium, high] }, to: requirements }
          - { id: simple, label: Simple, to: design }
      - id: until-ready
        after: design
        kind: loop
        label: Rework until the design is ready
        inputs: [{ name: ready, values: [yes, no] }]
        goal: { ready: yes }
        back: requirements
        maxRounds: 3
      - id: direction
        after: requirements
        kind: ask
        label: Where next?
        routes:
          - { id: continue, label: Continue, to: next }
          - { id: stop, label: Finish here, to: end }
```

A route's `to` is a phase of the workflow, `next`, or `end`. A rule compares a recorded value with a choice, a list of choices, `{ not: ... }`, or for numbers `atLeast`, `atMost`, `above` and `below`. `by` names the approval groups that decide; it defaults to the approvers of the phase before the decision. Configuration refuses a route that skips a phase a later phase still reads, unless that input is optional, and a route that skips the phase that plans the claims a code phase must meet.

### During a Story

The phase before a branch or loop records its values when it is submitted:

```bash
singularity-flow submit --decision risk=high
```

Submission is refused until every value is given, and the reviewer approves exactly the values the decision will read. On approval the decision applies: skipped phases show as skipped, with the decision and route that skipped them, and a loop opens a change request that tells the earlier phase why it is back.

When a Story waits for a person, see the question and its options, then choose with a reason:

```bash
singularity-flow decision show --json
singularity-flow decision choose --option continue --reason "Requirements are settled" --expected <KEY>
```

`--expected` binds the choice to the question you saw; it is refused if the decision changed. An ask that allows any step also accepts `--to <PHASE>` or `--to end`.

## State and safety

No decision removes the person a governed workflow relies on. A rule may send work back, or skip a phase a person signs off, only after a phase a person signs off, so every round passes someone who saw what approving does. A loop that reaches its limit stops and waits for a person instead of continuing.

Decisions are pinned with the Story when it starts, like every other workflow policy, so a later configuration change never reroutes running work. The Story records the values each phase submitted, which phases were skipped and by which route, the rounds each loop used, a question waiting for a person, and a log of every routed and chosen decision with its actor and reason. A person's choice is a governed `decision-made` lifecycle event, allowed only for members of the decision's approval groups. This build writes Story state version 12, which older builds refuse to read, so everyone on a team upgrades together.

## Troubleshooting

- **Submission asks for `--decision`:** the phase feeds a branch or loop. Record each value the message lists.
- **A loop stopped and asks a person:** its rounds are used. Choose another round or move on with `decision choose`.
- **Roll-forward is refused:** the newest rework came from a decision. Finish the round, or reject or reopen with a reason.
- **A phase was skipped unexpectedly:** run `decision show` to see the recorded values and the route that skipped it.

## Related topics

Continue with `sflow explain workflow-authoring`, `sflow explain story-lifecycle`, or `sflow explain approvals`.
