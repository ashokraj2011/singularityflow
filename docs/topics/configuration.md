---
id: configuration
title: Configuration, capabilities, and the policy fold
aliases:
  - workflow-yml
  - sflow-config
  - capabilities
  - policy-fold
related:
  - pins
  - quick-fix
  - escalation
version: 30
commands:
  - configuration
  - workflow
---
`main` holds application code; `sflow/config` holds approved configuration; a story branch receives an exact copy of its own workflow's closure at creation. Configuration changes ride review branches with PR discipline — including capability-tree edits. The effective policy for a story is a fold: workflow defaults → work-type overrides → capability constraints (root to leaf), where later layers may tighten but never weaken — protected paths union, approval floors hold, a capability's self-approval ban cannot be re-allowed downstream. The fold runs once at start and pins; everything downstream reads the folded result.

## Purpose and prerequisites

Use this topic when the current goal matches **configuration**. Start in a repository that uses Singularity Flow unless the command explicitly operates on installation or machine-local workspace state. Run `sflow doctor` when setup, identity, credentials, or repository health is uncertain, and use `sflow status` or `sflow home` to confirm the selected work before a mutation.

## Use it from each surface

- **Shell:** `sflow configuration`, `sflow workflow`. Run `singularity-flow configuration --help` for the exact forms supported by this build.
- **Copilot:** `/sf-help` followed by the documented CLI fallback. The skill must preserve the CLI result and ask before it changes anything.
- **VS Code:** open Singularity Flow **Configuration Center**. The extension renders engine results; it does not independently decide lifecycle state.

## Guided workflow

1. Read the current state with `sflow home`, `sflow status`, or the relevant list/status form.
2. Review the repository, workspace, Work ID, phase, actor, and any warnings before selecting an action.
3. Preview or prepare the operation when the command offers a dry-run, plan, packet, or exact confirmation.
4. Run the smallest applicable command from this topic. Do not substitute an undocumented subcommand.
5. Re-read state after completion. In Copilot, return to `/sf-home`; in VS Code, refresh the relevant view if it has not already refreshed.

## State and safety

Configuration proposal activation uses semantic transactions, not textual Git merges. A proposal's
change is everything from its merge base with `sflow/config` to its tip, however many commits it has
and whether or not the Git host merged `sflow/config` into it ("Update branch"). Each person's
proposal has its own identity, and a new save of it is a revision of it. A proposal is made on the
`sflow/config` commit its author read; when `sflow/config` moved since, approval re-applies the
proposal's field edits on top, and unrelated approved settings survive. A field both changed
differently is the approver's pick of one of the two values (`configuration approve <PROPOSAL>
--confirm <REVISION> --pick <FILE>#<FIELD>=proposal|current`, a question in the terminal, or a choice
in VS Code); the approval commit records the pick, who proposed and who approved (`Proposed-by`,
`Approved-by`, `Self-approved: yes`). `configuration approve` shows what lands, value by value, and
approves exactly the revision it showed; `--yes` approves only the revision it showed last.
`configuration reject <PROPOSAL> --reason <TEXT>` rejects one, or withdraws your own. A private SQLite
read model speeds lists but cannot approve anything. Shared receipts and an SGOS-backed local journal
support interrupted-operation recovery: running `configuration approve <PROPOSAL>` again on an
approved proposal finishes whatever an interruption left, and never blindly repeats a push. Inspect
with `singularity-flow configuration transactions --json`. See
[Configuration State Service](../CONFIGURATION-STATE-SERVICE.md) for scope and rollout limitations.

### One way in

Every change to `sflow/config` is a proposal a person approves, of one of these kinds: workflow, people, package,
capability or onboarding (`sflow/config-change/<kind>/*`). `singularity-flow configuration proposals` is the one list:
drafts saved on this machine, every waiting proposal with its author and its state (draft, proposed, needs a choice),
capability and setup proposals, and an upgrade the Git host would not take directly. `configuration approve` lands a
proposal of every kind, and `configuration reject` rejects one: it is the person's signed step on every surface.
Capability and setup proposals are handed to their own engines after the same view and the same named revision
(`--lead <URL>` names their repository); `capability activate` and `capability setup-activate` are the same approval by
their earlier names, with their own arguments and refusals. Wherever you run them, they take your SF Guard signature
under that repository's own policy, and while SF Guard is on a person who cannot sign is refused, with the reason and
what to do, never approved unsigned. Their proposer is the author of the proposal's first commit, as for every other
proposal, and its proposer rejecting one withdraws it. VS Code's buttons are
**Review and approve**, **Finish and approve** and **Save and approve**: each proposes, then asks once, saying when it
is a self-approval. `workflow activate <BRANCH> --confirm <REVISION>` is the same approval.

`approvalSecurity.allowSelfApproval` governs configuration approvals as it governs Story steps. With it `false` (the
`regulated` default), the author of a proposal cannot approve it: someone else does, and a proposal whose author Git
does not record (an older build's placeholder) is rejected and proposed again. A team repository allows it, and
the approval commit records it (`Self-approved: yes`); a `poc` repository approves its own changes and says so. Only
workflow approvals are added to `singularity/configuration-transactions.json`; a people or package approval is recorded
by its approval commit (`Sflow-Proposal`, `Proposed-by`, `Approved-by`), so older builds keep reading that file.

People and approval policy change by proposal too. A newcomer's first Story start enrolls them as a people proposal:
where the repository allows self-approval, and an approved change never removed them from those groups, they approve it
in the same step, as a self-approval, and the start says so. Otherwise the Story starts without them as an approver and
the proposal waits, once, for someone who may approve configuration. A person a reviewed change removed from a group is
never added back to it at Story start, and an approval that would add its own approver back to it is refused.
`configuration add-current-identity` and its policy options (`--solo`, `--self-approval`, `--auto-enroll`) make a people
proposal; approve it with `configuration approve`.

An approval is refused when it would give a workflow a problem that `workflow validate` reports and the current
`sflow/config` did not have. The refusal names the route: the fix is made in the proposal, so its proposer withdraws it
(`configuration reject`; their drafts come back to fix) and proposes it again, and anyone else rejects it with the
problems as its reason.

Workflow Studio keeps unpublished changes as edits against the configuration they were read from, never a full copy.
When `sflow/config` moves, open or kept, they move onto it and Studio names any value both changed; nothing is
discarded.

### When sflow/config is missing or does not load

`doctor`, `configuration validate` and `workflow fix` check `sflow/config` itself outside a Story checkout, never the
checkout's own `singularity/` files, and say which commit they checked; a Story checkout checks its pin. A
`sflow/config` an outside edit broke is named, with its commit and the problem, wherever new work refuses.
`singularity-flow configuration restore` shows what restoring would do and changes nothing:

- `sflow/config` does not load: it proposes going back to the newest commit in its own history that loads, as a normal
  proposal (`--confirm <COMMIT>`), which `configuration approve` lands. `workflow fix` drafts a repair instead.
- `sflow/config` is missing: it recreates it from the newest copy this machine holds (this clone's
  `origin/sflow/config`, else the newest Story pin, else the copy an earlier build kept on the `state` branch, checked
  against its own manifest), with every file listed first. `--confirm <SOURCE>` pushes one commit only while
  `sflow/config` is still absent, and records who approved it.

Restoring is a person's step: an agent is refused.

### Test setup

Test commands are the repository's, not a workflow step's. They sit in one `tests:` list at the top
of `singularity/workflow.yml`, as many as the repository needs: one per module, runner or level
(`level`: `unit`, `component`, `integration`, `e2e` or `other`). Every step that runs tests (a code
step, or `repositoryTests: run`) uses them, in every workflow; which of them run for a change is decided
from each command's affected directories, as before. A step only says whether it runs tests, and may
run fewer: `testLevels: [unit]` or `testIds: [e2e-local]` on the step or in its workflow's override
(with both, a command runs when its level or its ID is listed). A step's own test commands replace the
repository's for that step only. A Story keeps the commands it started with; once newer ones are
activated, a person who approves its step may adopt them (`story test-policy amend`). If `sflow/config`
was rewritten outside SFlow since the Story started, that adoption is refused with that cause: restore its history on
the Git host, or start a new Story on today's configuration.

One suite run against different targets is several setups with their own IDs, for example `e2e-local`
with `env: { PLAYWRIGHT_BASE_URL: http://localhost:3000 }` and `e2e-relay` with `environment: relay`.
A literal `env` value is the same for everyone and never holds a credential: a URL with a user name or
password, or a secret-looking query parameter, is refused. A URL that differs per machine or carries a
credential is declared in `singularity/environments.yml` and bound on each machine.

Open **Capabilities → Test setup**, **Configuration Center → Test setup**, or the command palette's
**Singularity Flow: Capability Test Setup**. Inspect exact module directories; the tests apply to **the
repository** unless you choose **Only this step**. Tick the suggestions to use and add them together, or
enter an exact argv array, module directory, result adapter/report path, affected directories, timeout,
level, variables and environment. A command with an ID the list already holds replaces it. **Save for
review** makes the ordinary reviewed `sflow/config` proposal; **Save and approve** also approves it at
once, the same approval as Workflow Studio → Changes → Review and approve. Where the server protects
`sflow/config`, it says that a merge through the repository's review is needed and names the branch.
Workflow Studio lists the repository's tests and shows which of them each step runs.

Copilot `/sf-test-setup` reads bounded repository manifests and reporter configuration, explains
the evidence behind its suggestions, and asks before configuration changes or test execution.
Shell `singularity-flow capability test-setup --source-root apps/client --json` provides deterministic
suggestions without executing tests, cloning, or scanning a monorepo recursively. Without a scope
it inspects only the repository root. Missing detection remains pending, not a test failure. A root
with more than one build (a `pom.xml` beside a `package.json` with tests) suggests each build's
command and says so (`TEST_ROOT_BUILD_SYSTEMS`); propose one for each suite the step must run. Each
suggestion names its `ecosystem` (the language its runner tests), and a command accepted with it is
evidence only for that language's files and files of no language below its affected roots, as an
inferred command is. Leave `ecosystem` out of a command you write to cover every file below its roots.

In an Nx workspace a project's Playwright target is a suggestion: its `project.json` target (the
`@nx/playwright:playwright` executor or a plain `playwright test` command), or the one
`@nx/playwright/plugin` infers from its `playwright.config.*`. It runs as `nx run <project>:<target>
--skip-nx-cache --reporter=json` from the workspace root and also covers the projects beside it that
it names in `implicitDependencies`. Publication infers it the same way, with no configuration.
A project's own Jest or Vitest target (the `@nx/jest:jest` executor, a plain `jest`, `vitest` or
`vitest run` command, or the target `@nx/jest/plugin` or `@nx/vite/plugin` infers) is suggested beside
it, with `--json --outputFile=<report>` or `--run --reporter=json --outputFile=<report>` and the report
path written relative to the directory the runner resolves it against; publication runs both for a
changed application. The `@nx/vite:test` executor is not inferred and needs an approved command.

Inspection also reads the test commands the team already wrote down: `AGENTS.md`, a coding tool's
root instruction file (`<TOOL>.md` beside its `.<tool>/` folder), `.github/copilot-instructions.md`,
`.github/instructions/*.md`, skills (`SKILL.md` under `.github/skills`, `skills/` and any
`.<tool>/skills`), the `run:` steps of
`.github/workflows/*.yml`, Makefile test targets, `scripts/test*` and package scripts, at the root and
in each `--source-root`. Each line is parsed by fixed rules, never by a model, and completed into a
full command, listed under `instructionCandidates` with its file and line: `VAR=x` prefixes become
`env`, `cd dir &&` becomes the working directory, the runner is found under its wrapper (`npx`,
`pnpm exec`, `yarn`, `./mvnw`, `./gradlew`, `python -m`), the affected root is the module that folder
belongs to, and the runner's reporter arguments and result adapter are added the way publication
infers them. So `BASE_URL=http://localhost:3000 npx playwright test --project=chromium` in AGENTS.md
becomes `npx playwright test --project=chromium --reporter=json` with `env: { BASE_URL: … }` and the
`playwright-json` adapter. A secret-looking variable is never read: the candidate names it, for
`singularity/environments.yml`. A line that cannot be completed (a pipe, a shell variable, a runner SFlow
does not complete yet) is listed with the reason. Nothing is used until a person proposes it with
`--use <ID>` and an approver activates it; the proposed `workflow.yml` keeps a comment naming the file
and line. Team import and Build with Copilot complete the test commands they write the same way.

A test command may carry `env`: literal, non-secret variables it always runs with
(`env: { BASE_URL: http://localhost:3000 }`), applied at every run of it (publication and
submission gates, `tests run`, test recovery) after the base environment and before
environment-bound values. Names are UPPER_CASE; reserved names (`PATH`, `HOME`, `NODE_*`, `GIT_*`,
proxies) and names that read like a secret are refused, and a secret-looking value given to
`--env` is too: declare those in `singularity/environments.yml`. The variables are part of the
command, so a changed value is a changed command. An engine older than this key reads the workflow
and ignores `env`, as it ignores every command key it does not know, so a repository that relies on
`env` needs every runner on a version that knows it.

A Node package can declare several test commands, and each runner it declares is its own run with its
own evidence: unit (Jest, Vitest, mocha, `node --test`, Create React App's `react-scripts test`, Angular's
Karma or `@angular-builders/jest` builder), end-to-end (`playwright test`, `cypress run`) and component
(a Playwright CT config, `cypress run --component`). Every script is read through its `npm run`
references and `&&`/`;` steps to the runner, whatever the script is called; a runner that ends its script
runs through it with the reporter after `--`, one inside a chain runs alone through the package
manager's exec (`npx --no-install`, `pnpm exec`, `yarn`). Scripts running a runner the same way collapse
into one, a narrower run (`--project`, `--grep`) beside the whole one is left out, and two that differ
in configuration are refused with both named. A Playwright config no script runs is run directly, and
so is one a script runs through bare `npx` (which could download a runner), with the arguments that
script selects. Vitest with its own printing reporter (`--reporter=verbose`) runs with both; one that
writes a file is not a gate's run, because it would take SFlow's report path too.
Playwright and pytest results name each test, so an `@ac` tag on one is credited only when that test
ran and passed (a test that passed only on a retry is flaky, not passed). mocha reports through
`mocha-junit-reporter` when installed, else its JSON reporter (`mocha-json`); Cypress through its JUnit
reporter.

Elsewhere: a .NET product project runs the test projects that reference it (`tests/App.Tests` beside
`src/App`), and is refused when none does; a Maven module with the failsafe plugin runs `verify` and
reads `failsafe-reports` with the `surefire-reports` beside it (at a reactor root, test setup suggests
the command of each declared module that holds tests, since each writes its own reports); a Python module without
`pyproject.toml` (requirements files, `setup.py`, `setup.cfg`, `Pipfile`, `tox.ini`, `noxfile.py`) runs
pytest, under `uv run --locked` beside a `uv.lock` or `poetry run` beside a `poetry.lock` with no `.venv`
(tox and nox environments run only when configured). An Android module runs
`:<module>:test<Variant>UnitTest` and, with `src/androidTest`, `:<module>:connected<Variant>AndroidTest`,
which starts only while `adb devices` lists a device (otherwise it is blocked with
`ANDROID_DEVICE_UNAVAILABLE`; SFlow never starts an emulator). Product flavors, Gradle Managed Devices,
Kotlin multiplatform targets and Xcode schemes and destinations are proposed by test setup with the
fields a person supplies. A configured `cargo-json` command reads libtest's JSON lines from its stdout:
`cargo test -- -Z unstable-options --format json` (nightly, or `RUSTC_BOOTSTRAP=1`) or
`cargo nextest run --message-format libtest-json`.

To save chosen commands from Copilot or a terminal, preview them with `singularity-flow capability
test-setup` and `--use <SUGGESTION-ID>` (repeat it for several), or one command in full (`--id`,
`--argv '<JSON ARRAY>'`, `--working-directory`, `--affected-root`, `--adapter`, `--report`, `--level`,
`--env NAME=VALUE` for each variable, `--environment <ID>`, and `--ecosystem <LANGUAGE>` to keep it to
one language). Without `--step` they go into `tests:`; `--step <STEP> [--workflow <WORKFLOW>]` saves for
that step only. A suggestion keeps the level SFlow found, and a Playwright suggestion names the variable
its config reads its base URL or endpoint from. The preview shows the `singularity/workflow.yml` diff and
changes nothing; its printed `--confirm <digest>` command proposes exactly that change through the same
reviewed save as the Test setup page. A command with the same ID is replaced, and the preview says so;
every other entry is kept. The result names the activation line for the person who chose the commands
and the VS Code place; an agent never activates. Run from a Story's checkout, it also names the Story's
adoption once the proposal is activated. For a command one Story needs before that, a step approver
accepts a Story-only command (`decision test-command`, see test-recovery).

`workflow proposal <BRANCH>` shows a waiting proposal and, while it is valid and not merged, the exact
`configuration approve <BRANCH> --confirm <COMMIT>` line and Workflow Studio → Changes → Review and approve,
and whether approving it would be your own self-approval. Where the server protects `sflow/config` the update is
refused, nothing changes, and the proposal is merged through the repository's review. A proposal that changes only `tests:` reads as **Repository
tests**, in the terminal and in Workflow Studio → Changes, whose count shows no number until it has
checked the proposals.

Existing Stories retain their configuration pin. An approved command-only revision can be reviewed
for adoption in the **current code phase** through `singularity-flow story test-policy amend <WORK-ID>
--phase <PHASE> --reason "Configure the previously undetected test runner" --json` and `/sf-recover`.
Authored code/documents are preserved; fresh execution evidence is required. Inspection alone
does not establish the pre-code failure baseline, accept failures, or alter intake's test-scope choice.

SFlow no longer keeps a `sflow/config-history/<commit>` branch per approved commit [owner, 2026-11-16]. A Story
reads its own pinned copy, and what a Story started from is its pin plus `sflow/config`'s own commit history. An
upgrade (the installer, VS Code's after-install pass or `workspace refresh-configuration`) removes the old
`sflow/config-history/*` branches, their archive tags (`refs/tags/sflow/config-history/<commit>`) and
`sflow/config-refresh/*` review branches once `sflow/config` holds the build's configuration, each under a lease;
`sflow/config`, `sflow/config-change/*` proposals, `state`, Story and application branches are never changed. A
ref the host refuses to delete is reported and harmless. The same run clears each registered clone on this machine
of its stale tracking refs and fetched archive tags for those refs, and of the private refs that kept a configuration
commit for a retryable upload once `sflow/config` holds that commit, deleting refs only, never a file. SFlow no
longer writes a copy of the configuration to the `state` branch; a copy an earlier build wrote stays, is never
authority, and is only the last source `configuration restore` offers.
`ledger.configurationHistory` stays valid and does nothing. `configuration cleanup-history` was removed
[owner, 2026-11-16]: an upgrade does its work.

These commands can change repository or machine-local state: `configuration`, `workflow`. They remain subject to identity, authority, sequence, freshness, branch, worktree, and exact-confirmation checks. Signed handles are session-bound and are never shared between the shell, Copilot, and VS Code. Durable repository and workspace records are the shared source of truth.

### Change impact

`spec.changeImpact: on` in the workflow's `spec` block is the one setting for how SFlow handles a change of requirements
partway through a Story. It turns on observed dependencies (each published step records what it depended on) and the
sizes of an intent amendment together: editorial, refinement or material, set by rules. An editorial change carries the
evidence of the clauses it rewords, and a material one is approved by `spec.scopeChangeAuthority`, an approval group, or
else by the scope step's own approvers. It is on by default (since 2026-11-15). The default is applied in code, so
`sflow init`, the shipped workflows and new workflows write no setting, and a teammate on an older SFlow build still loads
the configuration. Workflow Studio, the workflow builder and `workflow check` show the effective value, for example
"Change impact: on (default)". `spec.changeImpact: off` turns it off, and so does `spec.observedDependencies: off` with no `spec.changeImpact`, as a
repository wrote it before the default. Only `changeImpact: on` together with `observedDependencies: off` is refused. It
is pinned when a Story starts: a Story started before keeps its behaviour, and nothing it recorded is rewritten. See
`sflow explain changing-requirements`.

## Change agents, skills and instructions

In a repository with an approved configuration authority (`sflow/config`), `agents create|edit`, `skill create|edit|attach|detach|remove` and `instruction create|edit|remove` save each change as a draft on this machine. `agents create|edit --step STEP` also makes the agent the one that drafts that step, in the same save: the agent and its step are proposed and approved together, and the step leaves the agent that drafted it before. Every agent is written the way Workflow Studio writes it, whichever command made it, and only that way: `configuration save` refuses an agent file (in `singularity/agents/`, or `.github/agents/` before a repository's agents move) and names `agents edit`. A draft is checked against the approved configuration together with every earlier draft, so a skill that is still a draft can already be attached. A change that does not check is refused with the problem, and nothing is saved. No Story uses a draft. `singularity-flow configuration drafts` lists them (`skill list`, `instruction list` and `agents list` show them too) with any that the approved configuration already has or that no longer apply to it, `configuration discard <NUMBER> --listing <LISTING>` (the listing it printed) or `configuration discard <DRAFT-ID>` drops one, and `configuration propose` sends all of them as one review. A draft approved from another clone is settled when you propose, not proposed again; a draft that conflicts is named with its discard command. A save names its operation with `--operation-id ID`, so running it again returns the same draft; without one, repeating the latest save of the same skill, instruction or agent is the same save, and an edit back to an earlier value is a new change. When the Git host merged a proposal and deleted its branch, `configuration approve` records it; when the proposal was closed unmerged, its drafts are waiting again. `configuration approve` then shows what the proposal changes, asks once, and activates exactly that revision; nobody copies a commit. Workflow Studio shows the same drafts under **Changes**, each with a Discard button, and publishes them with its own edits; a draft already approved or no longer applying is left out, and the result says so. Without an authority, changes are written to the working tree as before.

## Troubleshooting

- If `singularity/workflow.yml` has a mistake, every command that reads it refuses and lists every problem in the file, not just the first. Each problem names its line, quotes it, suggests the likely intended name ("Did you mean 'requirements'?") and gives one fix. YAML mistakes such as a misaligned line are explained in plain words, with the indentation the line belongs at. Run `singularity-flow configuration validate` to check again; it prints one line when the configuration is valid, and `--json` returns the problems under `error.details.configurationProblems`. In VS Code, saving the file shows each problem on its line.
- If the selected Story or branch is wrong, stop and use `sflow home`, `sflow session`, or `sflow workspace list` before retrying.
- If a command refuses because state moved, refresh and use the newly rendered action instead of replaying an old handle or confirmation.
- If publication or synchronization is pending, follow the exact recovery command in the refusal and verify with `sflow doctor`.
- If a Copilot or VS Code action is unavailable, use the displayed CLI fallback; do not guess a command from the label.

## Related topics

Continue with `sflow explain pins`, `sflow explain quick-fix`, `sflow explain escalation`.
