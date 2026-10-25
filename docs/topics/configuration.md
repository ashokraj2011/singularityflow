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
version: 11
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

Configuration proposal activation uses semantic transactions, not textual Git merges. A stable
proposal identity can have multiple preserved, immutable revisions. Unrelated approved settings
survive activation; competing edits return exact fields for review. A private SQLite read model
speeds lists but cannot approve anything. Shared receipts and an SGOS-backed local journal support
interrupted-operation recovery. Inspect with `singularity-flow configuration transactions --json`;
explicitly reconcile an exact retained operation with `singularity-flow configuration reconcile
<CFT-ID> --json` or `/sf-configuration reconcile <CFT-ID>`. Reconciliation observes authority and
finishes pending reference sync; it never blindly repeats a push. See
[Configuration State Service](../CONFIGURATION-STATE-SERVICE.md) for scope and rollout limitations.

### Test setup

Open **Capabilities → Test setup**, **Configuration Center → Test setup**, or the command palette's
**Singularity Flow: Capability Test Setup**. Inspect exact module directories, then explicitly choose
the workflow and phase. Review inferred commands before adding them to the draft, or enter an exact
argv array, module directory, result adapter/report path, affected directories and timeout.
Saving uses the ordinary reviewed `sflow/config` proposal; non-test commands and other workflows
are preserved. Shared-phase edits affect every workflow that inherits that phase.

Copilot `/sf-test-setup` reads bounded repository manifests and reporter configuration, explains
the evidence behind its suggestions, and asks before configuration changes or test execution.
Shell `singularity-flow capability test-setup --source-root apps/client --json` provides deterministic
suggestions without executing tests, cloning, or scanning a monorepo recursively. Without a scope
it inspects only the repository root. Missing detection remains pending, not a test failure.

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

A Node package can declare several test commands, and each runner it declares is its own run with its
own evidence: unit (Jest, Vitest, mocha, `node --test`, Create React App's `react-scripts test`, Angular's
Karma or `@angular-builders/jest` builder), end-to-end (`playwright test`, `cypress run`) and component
(a Playwright CT config, `cypress run --component`). Every script is read through its `npm run`
references and `&&`/`;` steps to the runner, whatever the script is called; a runner that ends its script
runs through it with the reporter after `--`, one inside a chain runs alone through the package
manager's exec (`npx --no-install`, `pnpm exec`, `yarn`). Scripts running a runner the same way collapse
into one, a narrower run (`--project`, `--grep`) beside the whole one is left out, and two that differ
in configuration are refused with both named. A Playwright config no script runs is run directly.
Playwright and pytest results name each test, so an `@ac` tag on one is credited only when that test
ran and passed (a test that passed only on a retry is flaky, not passed). mocha reports through
`mocha-junit-reporter` when installed, else its JSON reporter (`mocha-json`); Cypress through its JUnit
reporter.

Elsewhere: a .NET product project runs the test projects that reference it (`tests/App.Tests` beside
`src/App`), and is refused when none does; a Maven module with the failsafe plugin runs `verify` and
reads `failsafe-reports` with the `surefire-reports` beside it; a Python module without
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

To save a chosen command from Copilot or a terminal, preview it with `singularity-flow capability
test-setup --step <STEP> [--workflow <WORKFLOW>]` and either `--use <SUGGESTION-ID>` or the command in
full (`--id`, `--argv '<JSON ARRAY>'`, `--working-directory`, `--affected-root`, `--adapter`,
`--report`). The preview shows the `singularity/workflow.yml` diff and changes nothing; its printed
`--confirm <digest>` command proposes exactly that change through the same reviewed save as the
Test setup page. A command with the same ID is replaced; every other check is kept. Run from a
Story's checkout, it also names the Story's adoption once the proposal is activated. For a command one
Story needs before that, a step approver accepts a Story-only command (`decision test-command`, see
test-recovery).

Existing Stories retain their configuration pin. An approved command-only revision can be reviewed
for adoption in the **current code phase** through `singularity-flow story test-policy amend <WORK-ID>
--phase <PHASE> --reason "Configure the previously undetected test runner" --json` and `/sf-recover`.
Authored code/documents are preserved; fresh execution evidence is required. Inspection alone
does not establish the pre-code failure baseline, accept failures, or alter intake's test-scope choice.

These commands can change repository or machine-local state: `configuration`, `workflow`. They remain subject to identity, authority, sequence, freshness, branch, worktree, and exact-confirmation checks. Signed handles are session-bound and are never shared between the shell, Copilot, and VS Code. Durable repository and workspace records are the shared source of truth.

## Change agents, skills and instructions

In a repository with an approved configuration authority (`sflow/config`), `agents create|edit`, `skill create|edit|attach|detach|remove` and `instruction create|edit|remove` save each change as a draft on this machine. A draft is checked against the approved configuration together with every earlier draft, so a skill that is still a draft can already be attached. No Story uses a draft. `singularity-flow configuration drafts` lists them (`skill list`, `instruction list` and `agents list` show them too), `configuration discard <NUMBER>` drops one, and `configuration propose` sends all of them as one review. `configuration approve` then shows what the proposal changes, asks once, and activates exactly that revision; nobody copies a commit. Workflow Studio shows the same drafts under **Changes** and publishes them with its own edits. Without an authority, changes are written to the working tree as before.

## Troubleshooting

- If `singularity/workflow.yml` has a mistake, every command that reads it refuses and lists every problem in the file, not just the first. Each problem names its line, quotes it, suggests the likely intended name ("Did you mean 'requirements'?") and gives one fix. YAML mistakes such as a misaligned line are explained in plain words, with the indentation the line belongs at. Run `singularity-flow configuration validate` to check again; it prints one line when the configuration is valid, and `--json` returns the problems under `error.details.configurationProblems`. In VS Code, saving the file shows each problem on its line.
- If the selected Story or branch is wrong, stop and use `sflow home`, `sflow session`, or `sflow workspace list` before retrying.
- If a command refuses because state moved, refresh and use the newly rendered action instead of replaying an old handle or confirmation.
- If publication or synchronization is pending, follow the exact recovery command in the refusal and verify with `sflow doctor`.
- If a Copilot or VS Code action is unavailable, use the displayed CLI fallback; do not guess a command from the label.

## Related topics

Continue with `sflow explain pins`, `sflow explain quick-fix`, `sflow explain escalation`.
