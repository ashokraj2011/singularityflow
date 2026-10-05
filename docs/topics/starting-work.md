---
id: starting-work
title: Starting work
aliases:
  - start
  - intake
  - jira-intake
  - story-file
commands:
  - start
  - story
related:
  - epics-and-planning
  - pins
  - work-intervals
  - supporting-documents
version: 22
---
Three intake doors, one result: Jira, a manual description, or a Story released from an Epic breakdown. For every new Jira or manual Story, first run `sflow workspace branches --json` and explicitly choose a branch published by every required repository. `sflow start PAY-1234 --jira --from-branch main` then refreshes that remote base, verifies that the configured remote can accept `PAY-1234`, creates the canonical branch, pins its exact base commit, and pushes only `refs/heads/PAY-1234`. The selected base ref is never changed. Existing and Epic-materialized Stories keep their already-pinned lineage instead of choosing a second base.

VS Code starts every Story in a dedicated linked Git worktree and opens that folder after the governed start commit lands. The checkout used to launch Start Work is never switched or cleaned, so a cancelled or unfinished Story can keep its uncommitted files while another Work ID starts independently. The CLI automatically uses the same isolation whenever its launch checkout is dirty; pass `--isolated-worktree` to request it from a clean checkout too. Failed-start cleanup removes only a clean disposable worktree and branch without unique commits. It retains dirty checkouts and unpublished commits with an exact recovery path.

An existing workspace repository is reused, not cloned again for each Story. The ordinary new-Story
launch refreshes only the selected base branch, retains a partial clone's `blob:none` filter, and
cuts the Story from that exact refreshed commit. A linked worktree shares the repository's Git
objects and inherits its sparse checkout. Starting a Story does not pull or merge into the
workspace's current branch. Resume, stale tracking refs, missing repositories, reference repositories,
and required authority/state refreshes can still need their own Git reads or transfers.

On supported POSIX hosts, an exact passing intake receipt can be reused even when onboarding has
pinned the configuration authority. Start still verifies live base, destination, configuration and
publication permission; changed inputs fall back to full validation and never repin the authority.
The daily product-version check uses the same exact-commit configuration object cache as start.
It still observes approved authority; a local disposable configuration projection is not a second
network clone of the application. Windows keeps the full receipt/cache fallback until its storage
profile is qualified; the selected-base refresh itself is cross-platform.

For timing diagnostics, add `--timings` to the CLI start. The Git-private command timing record
separates `start.publication.workflow` from `start.publication.commit`, in addition to authority,
intake, fetch, worktree and readiness spans. This distinguishes repository setup from the durable
commit/push/ledger transaction without logging credentials or repository contents.

In VS Code, Start Work opens at once on Story. It shows the last complete workflow and branch listing for the repository, labelled as last known, while it reads the current one; with none recorded yet, it says it is reading. Readiness is checked once typing the Story ID pauses, not only when the field loses focus. No base is ever preselected, and neither the last known listing nor an earlier answer enables Start: only a passing readiness check for the chosen base and workflow does.

For manual intake, the VS Code User Story form provides four optional local-document slots, for
documents or images. Each selected file needs a name, unique within the Story, and has its own
storage (**Committed to Git** or **On this machine only**) and its own phases (every phase of the
workflow by default). Each file is captured before mutation and recorded with its
SHA-256, name, storage, and phases in `documents.json`. A Git-kept file is copied under
`singularity/work-items/<WORK-ID>/inputs/DOC-nnn/`; a machine-only file stays in this clone's Git
directory, and only its name, size, and hash are committed. The manifest, the Git-kept bytes,
`source.json`, `USER-STORY.md`, and the workflow state land in the single opening governed commit and
are pushed together. The shell form is
`sflow start … --document <FILE> --document-name <NAME>`, with optional `--document-phases <A,B>` and
`--document-store git|local` given once for every document or once per `--document` in the same
order; see `sflow explain supporting-documents`. Intake and later phase
prompts consume the active hash-verified document evidence; they do not rely on the original laptop
path. Embedded instructions remain untrusted evidence, and normal configured size, MIME, and
resource limits still apply.

The larger manual-description editor also offers **Enhance description**. It sends a bounded JSON
draft and the selected file references through private standard input to
`singularity-flow story enhance-description --draft-stdin --json`. The configured model receives a
single tool-free prompt and returns an advisory proposed description. The proposal replaces only the
editable text after the user explicitly chooses **Apply proposal**; until then the authored draft
and proposal are shown separately, and **Discard** leaves the draft unchanged. Enhancement never saves the draft, starts a Story, chooses a
workflow, writes to Git, or changes lifecycle state. Binary files contribute verified metadata but
are not interpreted during enhancement. The equivalent shell form is:

```sh
singularity-flow story enhance-description --draft-stdin --json < story-draft.json
```

## Testing is advisory at Story start

Create the Story before proving its tests pass. Missing test detection, an unknown/stale baseline,
and observed test failures never require a test-readiness receipt at intake. Older test-only
`baselinePolicy: required` and pre-Story settings do not turn tests into an admission ticket.
Configuration bytes and existing Story pins are not silently rewritten. Explicit non-test
dependency/build/start prerequisites remain separately enforced when approved policy requires them.

Intake records independent baseline (`reuse`, optional reviewed `run`, `defer`) and execution-scope
choices. Pass `--readiness-baseline <CHOICE>` to preflight and start. Reuse displays existing exact-base
observations if available; absence remains pending. Defer records unverified observation. Neither
marks tests passed nor accepts failure risk. Story start does not scan the module tree, install
dependencies, execute tests, or manufacture an empty passing receipt.

Copilot `/sf-test-setup` (Shell: `singularity-flow capability test-setup --json`) inspects selected
application directories, suggests exact structured commands, and guides reviewed configuration.
Copilot then runs the chosen checks during coding/verification. SFlow validates fresh candidate-bound
results before publication; an assertion that tests passed is not evidence. Existing failures are
repaired in the Story or handled by an eligible, explicit human risk decision, never silently skipped.

An optional baseline helps distinguish regressions from existing failures. Only if requested, inspect
`singularity-flow precheck --quick --json`, then preview `singularity-flow precheck --run --scope
dependency-test --json` and confirm its exact plan. In VS Code choose **Review baseline commands**,
review the commands/runtime, then confirm. Selecting `run` alone executes nothing. `--scope full`
adds the approved broader build/quality/start checks. A failed optional run remains a failure but does
not prevent Story creation; choose reuse/defer to continue, without granting a later gate exception.

For an active code phase with a pinned configuration, adding the command to today's YAML does not
change the Story's pin. Review the command-only change on `sflow/config`, then preview
`singularity-flow story test-policy amend <WORK-ID> --phase <CODE-PHASE> --reason "Configure the previously undetected test runner" --json`
and follow its human-confirmed apply action. This preserves authored code and documents and requires
fresh test evidence. Missing commands remain a repairable test-configuration gate at code publication,
not a reason to refuse specification/planning or claim tests passed.

Ongoing scope is a separate `--test-execution-mode changed-and-affected|all-configured` choice,
sealed with the Story. Affected mode infers runners for affected modules; configured required
commands remain required and may themselves run a full suite. All-configured mode adds the
repository-native suite to configured commands and affected-module runners; it does not recursively
scan a large monorepo to guess extra commands. Configure additional suites explicitly. Existing failures default to repair in the Story; accepting them uses
the separately authorized test-risk flow, not deferral or scope selection.

To run a selected base while another Story is open, use
`singularity-flow precheck --run --base-commit <EXACT-OID> --scope dependency-test --json`, then
confirm the returned plan with the same base/scope and `--confirm-plan <PLAN-ID>`. The CLI reuses
Git objects in a temporary detached checkout (retaining sparse selection); it does not clone,
switch, clean, or rewrite the open Story. Temporary cleanup failure never turns completed evidence
into a failed test; retained checkout paths are reported for cleanup.

Approved test-only runtime settings live alongside that policy:

```yaml
repositoryReadiness:
  requiredBeforeStory: false
  baselinePolicy: choice
  testRuntime:
    nodeOptions: [--no-experimental-webstorage]
```

The optional flag is a reviewed Node/jsdom compatibility setting, not a global default. It applies
only to readiness and later test commands, never dependencies, source files, or the parent shell.
Readiness receipts bind the CLI host's Node version, platform, architecture and effective Node-options hash; a
changed runtime/profile makes a receipt stale. Stories pin the approved profile; publication binds
it in the separate test-input hash and records CLI host runtime identity with each test result. This
does not change the application-source hash or require an approver's laptop to use the execution
host's Node version. Unsupported flags require a compatible runtime or a reviewed configuration
repair. No arbitrary environment variables or Node injection flags are accepted by this profile.

A confirmed run that encounters an existing failure writes a Git-private
`repository-test-baseline` record. The record contains the exact base commit, manifest and plan
digests, test tool, sanitized command outcome, structured counts and failing testcase names when
a fresh report is available, and report hashes. It contains no raw command output or environment.
After a confirmed, structured test failure, the runner collects the remaining selected test
commands so the baseline does not hide another failing suite; it does not proceed to application
start. Missing structured results remain explicitly unavailable. Review this baseline before feature
coding and fix the failing tests as separate setup or Bug work. When a complete, unchanged
dependency/test baseline contains unambiguous JUnit, Jest, Vitest, or Node TAP failure identities, run
`singularity-flow precheck --risk-status --json` to inspect eligibility. The exact human reviewer
may then record a local acknowledgement using `singularity-flow precheck --accept-test-risk
--confirm-baseline sha256:<DIGEST> --reason "..." --expires <ISO-8601> --json`. The decision is
Git-private, bound to the exact command and base, and expires within 30 days. An eligible,
unchanged decision can permit Story creation with the observed failures shown separately in the
Story readiness document. It is **not** a passing test receipt or a publication waiver; later
phase checks still require passing proof. Missing reports, changed failures, and failed dependency
restoration cannot be accepted through this route. Story creation records the baseline and
acceptance digests, status, expiry, and failing testcase identities on its branch; the free-text
risk rationale remains in the machine-local Git-private decision.

Story creation also seals the Story's test policy in `context/test-policy.json`: which tests run (the affected modules, or every configured test under the Story test policy pilot), what happens to failures the base already has, that each acceptance criterion is verified by an automated test unless its verification contract says otherwise, the risk categories and the longest risk acceptance, and the repository's test capability at the base. The capability names every build module with the test command that would run it, whether that runner reads each test case or only counts tests, the strongest assurance it can reach, and any module with no supported runner, two build systems, or a missing launcher. Start prints it, `singularity-flow story test-policy show` repeats it, and a plan whose planned tests could not run is refused before any code is written. Failures on the base are repaired inside the Story by default; pass `--baseline-failures resolve-outside` to require that the base passes before the Story starts. Start then refuses, naming every failing test the confirmed readiness probe found, or asks for that probe when the base has not been observed.

Story start includes one shared, read-only readiness check in the CLI, Copilot flow, and VS Code preview. Workflow choices come from the exact selected base (or the approved shared configuration), not from whichever branch happened to launch the form. Selecting another base refreshes the workflow catalog; a workflow absent from that base is cleared and must be chosen again. After the operator selects a base and workflow, readiness proves all of the following before a Story branch, approval-membership change, checkout, commit, or push is allowed:

- the approved configuration is pinned to one exact authority revision, or the selected base carries a validated legacy configuration;
- the chosen workflow resolves, its planned-claim policy is operational, and every phase has one installed default governed agent;
- every required repository has an exact base commit and Story destination ref, and the configured Git publication authority passed its preflight;
- optional intelligence remains optional: a missing World Model, AST pack, model provider, telemetry span, or Copilot plugin does not block Story creation.

The preview is provisional. `sflow start` recomputes it immediately before mutation so a configuration or remote change between preview and Start cannot reuse stale evidence. The successful result includes the readiness checks and a digest-bound receipt for the selected configuration commit, base commits, and destination refs.

A passing preview can also hand Start what it observed. Add `--mint-intake-receipt` to a preview that names its workflow and `preflight.intakeReceipt` returns a receipt ID; pass it to Start as `--intake-receipt <ID>`. The receipt authorizes nothing. Start still observes approved configuration, the base, the Story destination and the state tip again, all at once, dry-runs publication afresh and recomputes readiness; it only skips fetching and observing what the preview already proved unchanged. An expired (15 minutes), edited, already used or foreign receipt, a different request, or anything that moved runs the ordinary start, and `data.intakeReceipt` says which and why. Receipts are single-use and machine-local, issued for one-repository Stories with approved shared configuration on macOS and Linux, and `SINGULARITY_FLOW_STORY_INTAKE_RECEIPTS=off` switches them off. VS Code and `/sf-start` use them automatically.

Read-only reference repositories can be fetched ahead of Start too. `singularity-flow story references inspect --reference-repository ID=URL --reference-branch ID=BRANCH --prefetch` pins each branch and fetches that exact commit into a machine-local store in the repository's Git directory (at most eight entries and 512 MiB, least recently used first out). Start still resolves every pin itself and copies from the store only when it holds exactly that commit; Git verifies every object, and the safety checks and detached checkout run as before. VS Code does this for a completed reference row after a short pause, and shows each stage of Start while it runs.

Use this explicit preview when scripting or diagnosing Start:

- **Shell:** `singularity-flow workspace branches --json --intake --preflight-story PAY-1234 --from-branch main --work-type feature`
- **Copilot:** `/sf-start` runs and presents the same preflight after you choose the base and workflow.

Before choosing, `singularity-flow workspace branches --json --intake --work-id PAY-1234` also reports `existingWork` from the listings the catalog already makes: `new`, `local-story`, `local-seed`, `local-conflict`, `published` (a remote branch of that name, which may be a started Story or a released Epic seed), or `unknown` when a repository could not be read. Only `new` means no further check is needed. `intake.workflowCatalogScope` says whether the listed workflows apply to every base (`approved-configuration`) or must be read from the chosen base (`selected-base`).

The list offers application branches only. It leaves out the branches Singularity Flow owns (everything under `sflow/`, the ledger branch, `state` by default, and ledger pins published as `singularity/pins/` branches) and orphan branches: branches that share no history with the default branch, such as `gh-pages`. Orphans are named per repository under `orphaned`, so a branch you expected is explained rather than missing, and VS Code lists them under the choices as not offered. They are found from each clone's remote-tracking refs without contacting the remote; a shallow clone reports none. Whatever the list says, Story start refuses an orphan base with `STORY_BASE_ORPHAN` before it changes anything.

A branch that is another Story's own is labelled with that Story (`choices[].story` in the JSON, "Story ID: title" in VS Code). Start a Story from it and the new Story records the Story it is built on as `lineage.baseStory`: its Work ID, title, branch, the exact commit, where that Story itself lands, its Epic and the Stories above it. A new Story with no Epic of its own takes that Story's Epic (`lineage.epicInheritedFrom` names where it came from). `sflow status` and the Journey show both. The link is found from the exact base commit: the Story whose workflow claims the branch, as its canonical, work or registered child branch. So a Story on a custom branch name is found too, and the Stories merged into `main` link nothing. The pull request then follows that Story; see `sflow explain pull-requests-and-stacks`.

Schema-compatible historical records are migrated in memory when they are read. Singularity Flow does not silently rewrite the shared configuration or state branches during Story start. When a persistent upgrade is required, readiness returns a user-reviewed route instead of partially creating the Story:

- **Shell:** `singularity-flow workspace reinitialize --dry-run --json`
- **Copilot:** `/sf-admin`

Review the returned plan and apply only its exact confirmation command. Re-run Start afterward; it will recompute readiness against the upgraded authority. This separation keeps upgrades recoverable and prevents a Story mutation from unexpectedly changing organization policy.

## Purpose and prerequisites

Use this topic when the current goal matches **starting work**. Start in a governed checkout unless the command explicitly operates on installation or machine-local workspace state. Run `sflow doctor` when setup, identity, credentials, or repository health is uncertain, and use `sflow status` or `sflow home` to confirm the selected work before a mutation.

## Use it from each surface

- **Shell:** `sflow start`, `sflow story`. Run `singularity-flow start --help` or `singularity-flow story --help` for the exact forms supported by this build.
- **Copilot:** `/sf-start`. The skill must preserve the CLI result and ask before any governed mutation.
- **VS Code:** open Singularity Flow **My Work and Workspaces**. The extension renders engine results; it does not independently decide lifecycle state.

## Guided workflow

1. Read the current state with `sflow home`, `sflow status`, or the relevant list/status form.
2. Review the repository, workspace, Work ID, configured remote, remote base branches, and workflow. Remote access is mandatory and no branch is preselected.
3. Run or review the Story-start readiness preview. Treat warnings about optional intelligence as advisory; resolve every workflow, agent, configuration-authority, and Git-publication blocker before continuing.
4. Preview or prepare the operation when the command offers a dry-run, plan, packet, or exact confirmation.
5. Run the smallest applicable command from this topic. Do not substitute an undocumented subcommand.
6. Re-read state after completion. In Copilot, return to `/sf-home`; in VS Code, refresh the relevant view if it has not already refreshed.

## State and safety

These commands can mutate governed or machine-local state: `start`, `story`. They remain subject to identity, authority, sequence, freshness, branch, worktree, and exact-confirmation checks. Signed handles are session-bound and are never shared between the shell, Copilot, and VS Code. Durable repository and workspace records are the shared source of truth.

## Troubleshooting

- If the selected Story or branch is wrong, stop and use `sflow home`, `sflow session`, or `sflow workspace branches --json` before retrying.
- If remote branch discovery or publication preflight fails, fix the configured Git remote before retrying. No Story branch or state has been created yet.
- If readiness reports a persistent configuration upgrade, preview it with `singularity-flow workspace reinitialize --dry-run --json` or `/sf-admin`. Do not hand-edit protected configuration in a Story branch.
- If only World Model, AST, model-provider, telemetry, or Copilot readiness is unavailable, continue: those facilities are non-blocking for Story creation.
- If a command refuses because state moved, refresh and use the newly rendered action instead of replaying an old handle or confirmation.
- If publication or synchronization is pending, follow the exact recovery command in the refusal and verify with `sflow doctor`.
- If a Copilot or VS Code action is unavailable, use the displayed CLI fallback; do not guess a command from the label.

## Related topics

Continue with `sflow explain epics-and-planning`, `sflow explain pins`, `sflow explain work-intervals`.
