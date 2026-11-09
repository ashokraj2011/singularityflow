# Repository test commands (RTC) — v1: how a repository runs its tests is set once, for the repository

Status: owner decisions recorded 2026-11-09. Being built.

How a repository runs its tests belongs to the repository, not to a step of one workflow. A repository has as many
test setups as it needs: one per module, runner or level (unit, component, integration, end-to-end). Test setup saves
them once, for the repository. Every step that runs tests uses them, in every workflow, and a step says only whether
it runs tests and, if it wants fewer, which ones. The person who chose the command activates it in the same place, and the review says what to do next.

## Owner decisions (2026-11-09)

The owner said "test setup should be at repo level" and "lets implement that change", taking the plan as
recommended, except where decision 3 notes otherwise. The owner added that there can be several test
configurations (decision 4).

1. **Test commands are the repository's.** They sit in one `tests:` list at the top of `singularity/workflow.yml`.
   That file is already the repository's own SFlow configuration on `sflow/config`. The list belongs to no workflow
   and no step.
   - A separate file was considered. It would need its own Story pin, refresh, proposal and retirement handling,
     and none of that is needed: Stories already pin this file.
2. **Saving is still a reviewed change, and the person who chose the command activates it there.** The command
   runs on every developer's machine and in Auto, so a person sees it once before it does.
   - VS Code's Test setup offers **Save and activate**. It is the same activation as Build with Copilot's Finish.
   - From a chat, the result gives the person the activation line to type. The agent never activates.
3. **A Story already in progress keeps its test commands** (`[SPK:CON-039]`: a Story is held to the rules in force
   when it started). The recommendation had been to adopt repository tests automatically when a Story had no test
   command of its own yet. That would break `[SPK:CON-039]`, so it is not built. As today, the Story's next turn
   offers the adoption (`story test-policy amend`) to a person who approves that step. The offer now includes
   repository tests.
4. **A repository has several test setups.** Examples: a backend and a frontend, unit and end-to-end runners, or
   one suite with a different profile.
   - Each is one named command in `tests:`, with the folders it covers and, optionally, its level.
   - By default, a step that runs tests runs every one that covers the change.
   - A step may name the levels or IDs it runs: for example, Code runs `unit` and `component`, and a later
     Verify step runs `e2e`.

## What happens today (main 2e3e74c8c)

- **Where the command goes.** `capability test-setup` (src/test-setup-proposal.mjs) and VS Code's Test setup save a
  test command into `phases.<step>.qualityCommands`, or `workTypes.<workflow>.phaseOverrides.<step>.qualityCommands`.
  A proposal therefore reads as a workflow change.
- **Saving.** It goes through `configuration save --propose` to a branch under `sflow/config-change/workflow/`.
- **Activating.** `singularity-flow workflow activate <BRANCH> --confirm <COMMIT>` does it, and so does Workflow
  Studio → Changes → Review and activate.
- **The review is a dead end.** Test setup's next step is `workflow proposal <BRANCH>`. A code comment says it shows
  "the exact activation command", but it does not, so a Copilot turn stopped with no way forward (2026-11-09,
  office).
- **The Changes count reads 0.** Workflow Studio's count of waiting proposals is filled only after Changes is opened.
  A proposal made from a chat therefore shows as 0.
- **Stories in progress.** They keep their pinned commands. `activatedTestCommandsFor`
  (src/activated-test-commands.mjs) finds what an amendment would adopt, but it reads only the step and the
  workflow's override.

## Requirements

- `[RTC:REQ-001]` **The repository's list.** `tests:` at the top of `singularity/workflow.yml` is a list of any
  number of test commands.
  - Each has the same shape and contract as a step's test command (`normalizeRequiredTestCommand`).
  - `kind` is `test`, and IDs are unique.
  - Each has an optional `level`: `unit`, `component`, `integration`, `e2e` or `other`. A command without a level is
    `other`. The level is also accepted on a step's own test command.
  - Several may cover the same folders: for example, a unit and an end-to-end runner for one package.
  - A command written down by the team keeps its source comment, as today `[TCE:REQ-063]`.
- `[RTC:REQ-002]` **Steps use it.** A step that runs tests gets the repository's tests at resolution, unless it has
  test commands of its own. "Runs tests" is decided by the same rules as today: a code step, or `repositoryTests:
  run`.
  - **Which ones.** By default, a step gets every repository test. Which of them run for a change is decided as
    today, from each command's `affectedRoots` and the execution mode.
  - **A step may narrow it** with `testLevels: [<level>…]`, `testIds: [<id>…]`, or both, set on the step or in its
    workflow's override. With both, a command runs when its level or its ID is listed.
    - A named ID that `tests:` does not hold is a configuration error.
    - So is a level that no repository test has.
  - A step's own test commands, or its workflow's override, replace the repository's for that step only.
  - Commands of other kinds (lint, build, findings) are unchanged.
  - A configuration without `tests:` resolves byte for byte as before, so existing Stories and digests do not move.
- `[RTC:REQ-003]` **Stories pin what they started with.** The resolved commands enter the Story's snapshot like any
  configured command `[SPK:CON-039]`.
  - `activatedTestCommandsFor` also reads the repository's `tests:`, so the existing offer to adopt includes them.
  - Nothing is adopted without a person.
- `[RTC:REQ-004]` **Order of use.** A step's own commands, then the repository's tests, then a Story's test decision,
  then a Story's pinned guess, then inference. This is the order `[TCE]` "Sources and precedence" already gives, with
  repository tests as configured commands.
- `[RTC:REQ-005]` **Test setup saves for the repository.**
  - `capability test-setup --use <ID>` (or a spelled-out command) without `--step` proposes a change to `tests:`.
  - **Several at once.** `--use` may be repeated, so several suggestions go into one proposal. VS Code's Test setup
    lets the person tick several.
  - **IDs.** A command with an ID already in `tests:` replaces that entry, and the preview says so. Any other command
    is added.
  - **Levels.** A suggestion keeps the level SFlow found for it (unit, component, e2e). A spelled-out command takes
    `--level`.
  - `--step <STEP>` [`--workflow <WORKFLOW>`] still saves a command for that step only, as an override.
  - VS Code's Test setup (Capabilities and Configuration Center) chooses "the repository" by default, and "only this
    step" as the other choice.
  - The preview's diff, plan digest and `--confirm` work as today.
- `[RTC:REQ-006]` **Save and activate.** VS Code's Test setup offers **Save and activate** next to **Save for
  review**.
  - It runs the same activation as Build with Copilot's Finish, for the exact proposal it just made.
  - Where `sflow/config` is protected on the server, it says that a merge through the repository's review is needed,
    and names the branch.
  - A chat result's next step names the activation line for the person, and the VS Code place: Workflow Studio →
    Changes → Review and activate.
- `[RTC:REQ-007]` **The review shows the way forward.**
  - When a proposal is valid and not merged, `workflow proposal <BRANCH>` (text and `--json` `nextAction`) gives the
    exact `workflow activate … --confirm <COMMIT>` line, and the VS Code place.
  - A proposal that changes only `tests:` reads as "Repository tests", not as a change to each workflow. That holds
    in the terminal, in Workflow Studio → Changes and in `workflow proposals`.
- `[RTC:REQ-008]` **The Changes count is never a false 0.**
  - Workflow Studio shows no number until it has checked.
  - It checks once when it opens, in the background, without delaying the page.
- `[RTC:REQ-009]` **Workflow Studio shows where a step's tests come from.**
  - The repository's tests have their own place, listed with their level and folders.
  - A step that runs tests shows which of them it runs: all, the levels or IDs it names, or "this step's own".
- `[RTC:REQ-010]` **Words.** The topic page, `help`, the `/sf-test-setup` skill and the docs say:
  - test commands are the repository's;
  - a step only says whether it runs tests;
  - the person activates a saved command, and where to do it.

  The skill still never activates for the person.

## Not in scope

- Moving existing step commands to `tests:`. They keep working as step overrides. A later "Move to the repository"
  action may come.
- Adopting repository tests into a Story in progress without a person (decision 3).
- Carrying `tests:` in a workflow bundle. The commands name this repository's folders.

## Acceptance

- A configuration with `tests:` and a code step with no test commands resolves that step with the repository's
  tests, and the Story snapshot pins them.
- A step with its own test command keeps it. A configuration without `tests:` hashes as before.
- With a unit and an e2e command in `tests:`, a step with `testLevels: [unit]` resolves with the unit one only, and a
  step with no selection resolves with both. An unknown ID or level in a selection is refused.
- `capability test-setup --use A --use B --confirm …` proposes both in one change.
- `capability test-setup --use <ID> --confirm …` without `--step` proposes a change to `tests:` only.
- `workflow proposal <BRANCH>` on that proposal names "Repository tests" and gives the activation line.
- VS Code: Test setup → Save and activate activates it. Workflow Studio's Changes count is not 0 while a proposal
  waits.
- `story test-policy amend` on an earlier Story offers the repository's command.
