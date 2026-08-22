# Singularity Flow — Local runbook (no Jira)

The complete lifecycle without a Jira connection: workspace, initialization, repository grounding, manual Story intake, the phase loop, and completion.

Use `sflow explain getting-started`, `sflow explain workspaces-and-sessions`, and `sflow explain manual-authorship` for the packaged tutorials corresponding to this runbook.

Examples use the direct personal aliases installed by
`singularity-flow plugin install`: `/sf-init`, `/sf-session`, `/sf-phase`, `/sf-submit`, and
`/sf-approve`. They do not require a plugin namespace. The packaged compatibility
form remains available when needed, for example
`/singularity-flow/sflow-submit`.

[HOW-TO.md](HOW-TO.md) is the general walkthrough and assumes a Jira-backed intake in places. This document covers the Git-only path end to end, plus two things documented nowhere else: which commands require an interactive terminal, and why `finalize` does not apply to a standalone work item.

---

## Preconditions

**A Git remote is effectively required.** `git.publish: required` is the shipped default in `templates/workflow.yml`, so `start`, `phase publish`, `submit`, and `approve` each commit *and push*. A failed push writes a pending-publication marker and every later command refuses until `singularity-flow sync` succeeds. A local bare repository is sufficient:

```bash
mkdir -p ~/flow && cd ~/flow
git init --bare origin.git
git init -b main app && cd app
git config user.name "Your Name" && git config user.email "you@example.com"
printf '# App\n' > README.md
git add -A && git commit -m "Initial commit"
git remote add origin ../origin.git && git push -u origin main
```

To run fully offline instead, set `git: { publish: off }` in `singularity/workflow.yml` on the base branch and commit it before `start`. Two consequences: `singularity-flow session attach` becomes unusable (it requires `refs/remotes/origin/<ID>`), and `workflow.yml` is hash-pinned at `start`, so it cannot be edited afterwards without failing `gate`.

**`worldModel.grounding: enforce` is the shipped default.** `phase publish` refuses unless `wm compose --phase <phase>` has recorded a grounding record for the next generation against a committed, fresh world model. Set `worldModel.grounding: off` before `start` to skip repository grounding entirely.

**Semantic `wm build` shells out to `copilot`; `wm light` does not.** The default semantic runner is `copilot -p "$(cat {prompt_file})" --allow-all-tools`. Use `wm light` or `sflow-wm-minimal` for deterministic zero-token grounding. For semantic depths without the Copilot CLI on `PATH`, pass `--runner "<command> {prompt_file}"` or disable grounding.

### Commands that require an interactive terminal

`choose()` refuses a non-TTY selection so that no agent can choose a durable human decision on a contributor's behalf.

| Command | Prompts for | Non-interactive alternative |
|---|---|---|
| `start <ID>` | intake source and workflow template | `--selection-receipt TOKEN` |
| `approve <ID>` | typed phase confirmation | `--selection-receipt TOKEN` |
| soft sequence-gate override | typed `continue` | none |

`approve --yes` skips only the typed phase confirmation. Phase agents are resolved automatically and never selected in an approval flow. Everything else — `prepare`, `phase publish`, `artifact`, `submit`, `documents`, all `wm` subcommands, `session`, `agent`, `resume`, `reject`, `status`, `progress`, `report`, `review`, `validate`, `sync`, `gate`, and `nextsteps` — is fully non-interactive.

---

## 1. Workspace (optional)

Create a local workspace without Jira by supplying `--local --id`. When a governed
capability map exists in a lead repository, choose capabilities and let Flow derive
the repositories:

```bash
singularity-flow workspace create --local \
  --id LOCAL-1 --name "Local workspace" \
  --base "$HOME/flow/workspaces" \
  --lead app --repository app="$HOME/flow/origin.git" \
  --confirm LOCAL-1

singularity-flow workspace list
singularity-flow workspace use LOCAL-1 --repository app
singularity-flow workspace current
```

Repositories are declared only at create time (`--repository ID=URL`, repeatable). `workspace use` writes a machine-local selection and never touches Git. See [WORKSPACES.md](WORKSPACES.md).

**The workspace layer is optional.** Every remaining step works in a plain Git repository.

---

## 2. Initialize the repository

Run initialization from the **target application repository**, not from the
workspace parent directory and not from the cloned Singularity Flow product
source. The correct directory is the Git repository whose source code and
Work-ID branch will be governed:

```text
Plain repository:   ~/flow/app
Managed workspace:  <workspace>/repos/<repository-id>
Example:             ~/flow/workspaces/LOCAL-1/repos/app
```

Confirm the boundary before initializing:

```bash
cd ~/flow/app
git rev-parse --show-toplevel   # must print ~/flow/app
git status --porcelain         # must be empty
```

When `main` is protected, create or reuse the Work-ID branch first and initialize
there:

```bash
singularity-flow init --work-id WORK-123 --base main --fetch
git branch --show-current      # WORK-123
git add singularity
git commit -m "[WORK-123][bootstrap] Initialize Singularity Flow"
git push -u origin WORK-123
```

`init --work-id` creates or reuses `WORK-123` from `main` before it writes any
files. It does not modify or push `main`. If `origin/WORK-123` already exists,
`--fetch` checks out that branch instead of creating a conflicting branch.

`init` writes `singularity/workflow.yml`, `singularity/portfolio.yml`,
`singularity/templates/`, `.github/agents/`, and `singularity/prompts/`,
copying only files that are missing. It does not commit
or push; the explicit Git commands above keep that review boundary visible.

Initialization is safely repeatable on the current branch. It never overwrites
an existing customized file:

```bash
singularity-flow init --check
singularity-flow init --repair
singularity-flow doctor --offline
```

Workflow schema version 2 is mandatory. `init --repair` is additive, so it will
not convert or overwrite a version-1 workflow. There is deliberately no migration
during the POC. If this repository has version 1, use the factory-reset flow below
on a disposable or deliberately chosen branch, then review and commit the new v2
configuration.

### Bootstrap a previously ungoverned remote

From any directory, the organisation bootstrap leaves the detected application
branch untouched and proposes its initial configuration for review:

```bash
singularity-flow bootstrap <REPOSITORY-URL> --capability platform --name "Platform"
```

The result includes the detected application branch, a collision-safe
`sflow/govern/<repository>-<base-sha>` review branch, and the orphan
`sflow/config` and `state` branches. Follow the exact pull-request command printed
by the CLI. Use `--direct` only when direct application-branch publication is an
intentional repository policy.

### Factory reset

Use factory reset only when you intentionally want to discard every governed
workflow, artifact, prompt customization, repository world model, and local
Singularity session in this clone and return to the installed npm package
defaults. Run it from the target application repository:

```bash
cd ~/flow/app
git rev-parse --show-toplevel
singularity-flow factory-reset --dry-run
# Use the exact value printed by the preview, including its HEAD prefix:
singularity-flow factory-reset --confirm "RESET app <HEAD-prefix>"
singularity-flow init --check
git status --short
```

The confirmation value is printed by the preview and uses the actual repository
folder name. Factory reset does not commit the replacement. It also does not
delete application source, Git history, workspace clones, the global workspace
registry, or custom repository agents not bundled with Singularity Flow. The next
workspace registry read automatically forgets registrations whose lead explicitly
declares a non-v2 workflow; `singularity-flow workspace prune --json` reports them.

### Fresh machine reset and reinstall

Use this only when every registered POC workspace, clone, document, generated
artifact, and local Singularity session can be discarded. Run it from a clean
clone of the **Singularity Flow product repository**, not from an application
workspace:

```bash
cd ~/src/singularityflow
git status --short
singularity-flow fresh-install
# Inspect every workspace and additional reset target printed above.
singularity-flow fresh-install --yes
```

From another directory, add `--checkout ~/src/singularityflow` to either command.
`./install.sh --factory-reset [--yes]` remains the low-level equivalent.

### Clean local workspaces without reinstalling

Use this when the machine should behave as if no Singularity workspace has ever
been created, but the CLI, VS Code extension, Copilot plugin, and skills are
already installed correctly:

```bash
cd /path/outside/all/singularity/workspaces
singularity-flow local-reset --dry-run
# Review every workspace path in the preview.
singularity-flow local-reset --confirm "RESET LOCAL"
```

The command deletes only registered workspace roots whose own `workspace.json`
matches the registry. It clears sessions, caches, recovery data, and extension
state, but leaves installed product surfaces and unregistered repositories alone.
Afterward, create a new workspace from VS Code or the CLI.

The first command is a read-only preview. The second requires the explicit
`--yes`, deletes only registry entries proven by a matching `workspace.json`,
uninstalls old CLI/plugin/VS Code copies, and installs current CLI, plugin,
skills, and VS Code extension builds. It refuses to run when the installer clone
is inside a workspace that would be deleted. Unregistered directories are not
deleted. Singularity Flow credentials and profile data are cleared when the
reinstalled VS Code extension first activates.

In Copilot CLI, `/sf-init` performs the same check-and-repair sequence and
shows every added file for review. To recover or initialize an existing Work
ID from another terminal, use:

```bash
singularity-flow init --repair --work-id WORK-123 --base main --fetch
```

This creates, reuses, or fast-forwards `WORK-123`; it does not modify `main`.
Review and commit any restored files on the Work-ID branch before continuing.

Make any policy changes now on `WORK-123` and commit them before `start`:
`workflow.yml` and every artifact template are hash-pinned into the work item
at `start`, and `governance.protectedPaths` blocks changing them afterwards.
An approved pull request to `main` is optional and is needed only when the team
wants future Work IDs to inherit this process configuration.

---

## 3. Build the repository world model

Run on the initialized `WORK-123` branch, before starting its workflow.

For the smallest validated model:

```bash
cd /absolute/path/to/the/application-repository
sflow-wm-minimal
```

This creates a deterministic light development-focused model with zero model
tokens and commits it locally without pushing. Use `sflow-wm-minimal --phase
design` to take the minimum required views from phase configuration, or add
`--publish` when the current branch is ready for normal publication. Light mode
indexes paths and build metadata only; use a semantic depth when the phase must
make architectural, behavioral, security, or impact claims.

### Phase-by-phase minimum commands

Run these commands from the application repository on the Work-ID branch. Use
the section for the workflow profile selected when the work item was started;
do not run phases from a different profile. Each command reads that phase's
configured `worldModel.views`, makes a deterministic light build, validates
it, and commits it locally:

#### Spec-Driven Standard

```bash
sflow-wm-minimal --phase specification
sflow-wm-minimal --phase planning
sflow-wm-minimal --phase implementation
sflow-wm-minimal --phase convergence
sflow-wm-minimal --phase verification
sflow-wm-minimal --phase release
```

#### Quick fix

```bash
sflow-wm-minimal --phase implement
sflow-wm-minimal --phase verify
```

#### Feature

```bash
sflow-wm-minimal --phase intake
sflow-wm-minimal --phase requirements
sflow-wm-minimal --phase design
sflow-wm-minimal --phase implementation-spec
sflow-wm-minimal --phase implementation
sflow-wm-minimal --phase verification
sflow-wm-minimal --phase conformance
```

#### Bug fix

```bash
sflow-wm-minimal --phase intake
sflow-wm-minimal --phase reproduction
sflow-wm-minimal --phase fix-design
sflow-wm-minimal --phase fix-spec
sflow-wm-minimal --phase implementation
sflow-wm-minimal --phase verification
sflow-wm-minimal --phase conformance
```

#### Chore

```bash
sflow-wm-minimal --phase intake
sflow-wm-minimal --phase implementation
sflow-wm-minimal --phase verification
sflow-wm-minimal --phase conformance
```

#### Figma export to mobile app

```bash
sflow-wm-minimal --phase design-intake
sflow-wm-minimal --phase design-inventory
sflow-wm-minimal --phase component-mapping
sflow-wm-minimal --phase mobile-spec
sflow-wm-minimal --phase implementation
sflow-wm-minimal --phase visual-verification
sflow-wm-minimal --phase conformance
```

#### POC workflow

```bash
sflow-wm-minimal --phase poc-intake
sflow-wm-minimal --phase poc-impact-analysis
sflow-wm-minimal --phase poc-ui-exploration
sflow-wm-minimal --phase poc-test-generation
sflow-wm-minimal --phase poc-validation
sflow-wm-minimal --phase poc-publication-review
```

#### Benchmark A and Benchmark B

Both benchmark workflows use the same phase IDs so their outcomes remain comparable:

```bash
sflow-wm-minimal --phase intake
sflow-wm-minimal --phase design
sflow-wm-minimal --phase implementation
sflow-wm-minimal --phase testing
sflow-wm-minimal --phase conformance
```

Benchmark A requires the published world model, so add `--publish` to the command for its current
phase. Benchmark B deliberately disables world-model, AST, and agent-brief context; the commands
above document the available phase IDs but are not required for that generic-context arm.

You normally run only the current phase's command when Singularity Flow reports
that grounding is missing or stale; running every command in advance is not
required. To operate on a branch without checking it out first, add
`--branch WORK-123`. To commit and push the validated model immediately, add
`--publish`; otherwise the default `--local` commit is pushed with the next
normal workflow publication.

The phase ID must exist in the repository's `singularity/workflow.yml`.
Customized workflows use the same pattern:

```bash
sflow-wm-minimal --phase <configured-phase-id>
singularity-flow wm check
```

If you need a single broader model instead of the minimum phase-specific
views, use `sflow-wm-minimal --views all`.

### Equivalent low-level commands

```bash
singularity-flow wm init
singularity-flow wm light --local
# Equivalent depth form
singularity-flow wm build --depth light --local
singularity-flow wm check
```

`--local` commits `singularity/world-model/` without pushing. The later
`singularity-flow start WORK-123` publication pushes that commit together with
the first workflow-state commit.

Light mode has no model workers or synthesis checkpoints. If a semantic builder
is interrupted or final synthesis fails, rerun the same `wm build` command.
Completed view packets are retained under
`singularity/world-model/.checkpoints/`, verified against the exact source,
prompt, and options, and skipped; only pending views restart. Resume is the
default, `--resume` is the explicit spelling, and `--no-resume` deliberately
reruns all views. The checkpoint disappears after a validated model is
installed.

Flags: `--phase <id>` · `--views a,b,c|all` · `--task TEXT` · `--focus TEXT` · `--depth light|quick|standard|deep` · `--parallel`/`--no-parallel` · `--workers N` · `--resume`/`--no-resume` · `--branch B` · `--remote R` · `--runner "CMD {prompt_file}"`. `--runner`, workers, and resume apply only to semantic depths.

---

## 4. Manual Story intake

`start` asks two durable questions: intake source (skipped when manual detail flags are present) and workflow template. The first phase's default governed agent activates automatically from `.github/agents/*.agent.md`.

### Prepared story file

Keep the file outside the repository; `start` refuses a dirty tree unless `--allow-dirty` is passed.

```yaml
# /tmp/story.yml
title: Add invoice export
user: Finance operations analyst
problem: Finance teams currently assemble invoice exports manually.
desiredOutcome: Authorized users can export the filtered invoice set in a reusable format.
acceptanceCriteria:
  - An authorized user can export the currently filtered invoices.
  - The export contains invoice ID, customer, status, currency, and total.
  - Unauthorized users cannot start or download an export.
```

```bash
git status --porcelain          # must be empty
singularity-flow start WORK-123 --story-file /tmp/story.yml
```

`--story-file` accepts `.yml`, `.yaml`, or `.json` for the structured form, and `.md` or `.txt` for a prose story whose title comes from the first `# Heading`. Optional keys: `scope.in`, `scope.out`, `stakeholders`, `urgency`, `constraints`, `dependencies`, `risks`, `notes`, and `documents[{path|url, label, kind}]`. Relative document paths resolve against the story file's directory. See [examples/manual-story.yml](examples/manual-story.yml).

### Inline, without a file

```bash
singularity-flow start WORK-123 \
  --title "Add invoice export" \
  --description "Finance needs a repeatable filtered export." \
  --acceptance-criteria "An authorized user can export the filtered invoice set."
```

### Fully interactive

```bash
singularity-flow start WORK-123
```

Asks for title, user, problem, desired outcome, acceptance criteria, and supporting documents.

### Non-interactive, via a selection receipt

```bash
singularity-flow choices begin start WORK-123 --json     # prints the token and durable choice sets
TOKEN=<uuid>
singularity-flow choices answer $TOKEN intake-source     manual        --json
singularity-flow choices answer $TOKEN workflow-template feature       --json
singularity-flow choices status $TOKEN --json            # ready: true
singularity-flow start WORK-123 --story-file /tmp/story.yml --selection-receipt $TOKEN
```

A receipt is a UUIDv4, single use, valid for 15 minutes, and bound to the repository HEAD — any commit between `choices begin` and the consuming command invalidates it.

`start` requires the current branch to be named exactly after the Work ID. With
the protected-`main` bootstrap above it reuses `WORK-123`, writes
`singularity/work-items/WORK-123/` (`workflow.json`, `STATUS.md`,
`source.json`, `USER-STORY.md`), commits
`[WORK-123][init] start feature workflow`, pushes, and copies any supporting
documents into `inputs/DOC-nnn/`.

### Local Epic

Epics do not require Jira either. `epic start --local` allocates the next local identifier (`SF-E-001`, `SF-E-002`, …) and reserves it atomically by pushing the reservation branch.

```bash
git switch main && git status --porcelain     # must be clean
singularity-flow epic start --local \
  --title "Invoice export epic" \
  --description "Finance needs governed invoice exports." \
  --goal "Ship a filtered, authorized invoice export"
```

All three flags are required, and `--profile` defaults to `epic-planning`. Before the first local Epic, populate `approvalAuthorities` in `singularity/portfolio.yml` when the selected profile requires named members. The first phase's governed agent activates automatically; there is no role picker.

Continue in Copilot with `/sf-epic-sources`, `/sf-epic-requirements`,
`/sf-epic-planning`, and `/sf-initiative-materialize`. Their CLI equivalents are
`singularity-flow epic sources`, `singularity-flow epic requirements`,
`singularity-flow epic planning`, and `singularity-flow initiative materialize`.
Materialization seeds Story branches such as `SF-S-001-001`. See
[INITIATIVE-ORCHESTRATION.md](INITIATIVE-ORCHESTRATION.md).

---

## 5. Session and governed agent

```bash
singularity-flow session status --json
singularity-flow session candidates --json
singularity-flow session attach WORK-123 --json
singularity-flow agent WORK-123 --agent architect
```

`session attach` fetches the configured remote, requires `refs/remotes/origin/<ID>` to exist, fast-forwards only, and activates the current phase's default agent. `agent --agent` is an explicit local override for exceptional work. It does not create a commit and cannot grant approval authority.

---

## 6. The phase loop

The `feature` work type runs `intake → requirements → design → implementation-spec → implementation → verification → conformance`. Inspect any work type without starting work using `singularity-flow workflow simulate feature`.

For each phase:

```bash
singularity-flow wm ensure  --phase intake
singularity-flow wm compose --phase intake --dry-run
singularity-flow wm compose --phase intake
singularity-flow prepare intake
# author singularity/work-items/WORK-123/artifacts/intake/intake.md
singularity-flow artifact scan --phase intake
singularity-flow phase publish intake
singularity-flow phase show intake
singularity-flow submit --phase intake
singularity-flow approve WORK-123 --fetch
```

The model is shared across Stories and reused when its scoped source snapshot is unchanged. Story context comes from the governed workflow; use `--task` only for an explicitly requested ad-hoc task guide.

Artifacts must exceed the phase's configured `minimumBytes` and contain no `TODO`, `TBD`, `{{…}}`, or `[describe …]` placeholders; `publish` and `submit` both refuse otherwise. Phases with `writeScope: artifact-only` reject any change outside `artifacts/<phase>/` — source code belongs to `implementation` and `verification`.

Approve without a terminal:

```bash
git status --porcelain                       # must be clean
singularity-flow choices begin approve WORK-123 --json
TOKEN=<uuid>
singularity-flow choices answer $TOKEN phase-confirmation intake        --json
singularity-flow approve WORK-123 --selection-receipt $TOKEN
```

Reject to any phase listed in that phase's `rejectTo`, which invalidates approvals from the target onward:

```bash
singularity-flow reject WORK-123 --fetch --to requirements --reason "Failure behavior is missing"
```

Orientation at any point:

```bash
singularity-flow nextsteps WORK-123 [--json]    # read-only ordered plan
singularity-flow next [--task TEXT]             # one action; grounding reuses the shared repository model
singularity-flow guide WORK-123
```

---

## 7. Documents and evidence

```bash
singularity-flow documents upload ./brief.pdf --label "Finance brief" --kind requirements
singularity-flow documents upload ./exports --kind directory-import
singularity-flow documents upload --url https://example.com/design --label "Design"
singularity-flow documents list WORK-123
singularity-flow documents view DOC-001 --work-id WORK-123
singularity-flow documents detach DOC-001 --reason "Superseded by approved evidence"
singularity-flow documents detach DOC-002 --scope package --reason "Replace the complete export"
singularity-flow documents list WORK-123 --all
```

Uploads require an active work-item session with its current phase agent, and are allowed only in the phases listed by `documents.allowedPhases` — for `feature` that is `intake`, `requirements`, `design`, and `implementation-spec`. Later uploads trigger a soft gate that must be confirmed interactively. `--label` applies to a single document; the per-file limit is `documents.maxFileBytes`.

Detach requires a reason and confirmation, retains the committed file, hides it from the active catalog and all future Copilot prompts, and records a hash-addressed decision. If the evidence was already consumed, only its dependent phase cone is reopened. Use `--all` to inspect detached history. For Epic evidence use `singularity-flow epic sources detach SRC-001 --epic EPIC-123 --reason "..."`; `/sf-documents` and `/sf-upload` provide the same guided actions in Copilot.

---

## 8. Completion

```bash
singularity-flow progress WORK-123
singularity-flow report   WORK-123 --format md --out report.md
singularity-flow review   conformance --format md --out review.md
singularity-flow validate --strict
singularity-flow gate --terminal
```

`gate` re-derives everything from Git rather than trusting `workflow.json`: configuration and template hashes, document integrity, protected paths, per-generation publication commits, grounding and telemetry records, distinct approver identities against the pinned authority registry, acceptance-criteria test tags, and conformance freshness.

**`finalize` does not apply to a standalone work item.** It requires a governed seed at `singularity/seeds/<WORK-ID>.yml`, which only `initiative materialize` or `story fetch` create when a Story is derived from an Epic. A work item started directly with `singularity-flow start` has no seed, and `finalize` reports that the seed is unreadable. For that path, completion is `gate --terminal`.

---

## Checklist

1. Configure a remote, or set `git.publish: off` before `start`.
2. Run `init --work-id <ID>` from the target application repository, then commit `singularity/` on that Work-ID branch before `start`; it is hash-pinned and protected afterwards.
3. Ensure a clean tree before `start`, `resume`, `session attach`, `choices begin approve`, `approve --selection-receipt`, `epic start --local`, and `finalize`.
4. Reserve an interactive terminal for durable contributor choices such as
   `start`, selection receipts, soft-gate confirmation, `approve`, `reject`, and
   `epic start --local`; phase agents are resolved by the workflow.
5. Consume selection receipts without committing in between; they expire in 15 minutes and are single use.
6. Run `wm compose --phase <phase>` before every `phase publish` while grounding is enforced; do not add a Story-specific `--task`.
7. Replace every template placeholder and exceed the phase's minimum byte count.
8. Keep source changes inside `implementation` and `verification`.
9. Name the branch exactly the work ID.
10. Run `singularity-flow sync` after any failed push before continuing.
