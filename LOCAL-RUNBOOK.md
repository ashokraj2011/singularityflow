# Singularity Flow — Local runbook (no Jira)

The complete lifecycle without a Jira connection: workspace, initialization, repository grounding, manual Story intake, the phase loop, and completion.

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

**`wm build` shells out to `copilot`.** The default runner is `copilot -p "$(cat {prompt_file})" --allow-all-tools`. Without the Copilot CLI on `PATH`, pass `--runner "<command> {prompt_file}"` or disable grounding.

### Commands that require an interactive terminal

`choose()` refuses a non-TTY selection so that no agent can choose on a contributor's behalf.

| Command | Prompts for | Non-interactive alternative |
|---|---|---|
| `start <ID>` | intake source, workflow template, working lens | `--selection-receipt TOKEN` |
| `approve <ID>` | working lens, typed phase confirmation | `--selection-receipt TOKEN` |
| `lens`, `resume`, `reject`, `epic start --local` | working lens | none |
| soft sequence-gate override | typed `continue` | none |

`approve --yes` skips only the typed phase confirmation; it still prompts for the working lens. Everything else — `prepare`, `phase publish`, `artifact`, `submit`, `documents`, all `wm` subcommands, `session`, `status`, `progress`, `report`, `review`, `validate`, `sync`, `gate`, `nextsteps` — is fully non-interactive.

---

## 1. Workspace (optional)

`workspace create` is Jira-anchored: it requires `--jira KEY` and `--confirm KEY` even offline. A local workspace anchor exists but is reachable only from Singularity Desktop. Offline creation works with a synthetic key when `--hierarchy-level` is supplied:

```bash
singularity-flow workspace create \
  --jira LOCAL-1 --hierarchy-level 1 --issue-type Epic \
  --title "Local workspace" --site local \
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

```bash
cd ~/flow/app && git switch main
singularity-flow init
git add singularity && git commit -m "Initialize Singularity Flow" && git push
```

`init` writes `singularity/workflow.yml`, `singularity/portfolio.yml`, `singularity/templates/`, `singularity/personas/`, and `singularity/prompts/`, copying only files that are missing. It does not commit.

Make any policy changes now, on the base branch, committed before `start`: `workflow.yml` and every artifact template are hash-pinned into the work item at `start`, and `governance.protectedPaths` blocks changing them on a work branch afterwards.

---

## 3. Build the repository world model

Run on the base branch, before starting work.

```bash
singularity-flow wm init
singularity-flow wm build --depth quick --local
singularity-flow wm check
```

`--local` commits `singularity/world-model/` without pushing; the commit rides the first work-item branch forked from this branch.

Flags: `--phase <id>` · `--views a,b,c|all` · `--task TEXT` · `--focus TEXT` · `--depth quick|standard|deep` · `--parallel`/`--no-parallel` · `--workers N` · `--branch B` · `--remote R` · `--runner "CMD {prompt_file}"`.

---

## 4. Manual Story intake

`start` asks three questions: intake source (skipped when manual detail flags are present), workflow template, and working lens. There is deliberately no `--type` or `--persona` flag — those selections stay with the contributor.

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
singularity-flow choices begin start WORK-123 --json     # prints the token and three choice sets
TOKEN=<uuid>
singularity-flow choices answer $TOKEN intake-source     manual        --json
singularity-flow choices answer $TOKEN workflow-template feature       --json
singularity-flow choices answer $TOKEN persona           product-owner --json
singularity-flow choices status $TOKEN --json            # ready: true
singularity-flow start WORK-123 --story-file /tmp/story.yml --selection-receipt $TOKEN
```

A receipt is a UUIDv4, single use, valid for 15 minutes, and bound to the repository HEAD — any commit between `choices begin` and the consuming command invalidates it.

`start` creates a branch named exactly the work ID, writes `singularity/work-items/WORK-123/` (`workflow.json`, `STATUS.md`, `source.json`, `USER-STORY.md`), commits `[WORK-123][init] start feature workflow`, pushes, and copies any supporting documents into `inputs/DOC-nnn/`.

### Local Epic

Epics do not require Jira either. `epic start --local` allocates the next local identifier (`SF-E-001`, `SF-E-002`, …) and reserves it atomically by pushing the reservation branch.

```bash
git switch main && git status --porcelain     # must be clean
singularity-flow epic start --local \
  --title "Invoice export epic" \
  --description "Finance needs governed invoice exports." \
  --goal "Ship a filtered, authorized invoice export"
```

All three flags are required, and `--profile` defaults to `epic-planning`. Before the first local Epic, populate `approvalAuthorities` in `singularity/portfolio.yml` — the shipped profiles declare the groups with no members, and start refuses until each referenced group has at least one local Git identity. The command then prompts for a working lens, so it needs an interactive terminal.

Continue with `epic sources`, `epic requirements`, `epic planning`, and `initiative materialize`, which seeds Story branches as `SF-S-001-001`. See [INITIATIVE-ORCHESTRATION.md](INITIATIVE-ORCHESTRATION.md).

---

## 5. Session and working lens

```bash
singularity-flow session status --json
singularity-flow session candidates --json
singularity-flow session attach WORK-123 --json
singularity-flow lens WORK-123
```

`session attach` fetches the configured remote, requires `refs/remotes/origin/<ID>` to exist, and fast-forwards only. `start` already binds a working lens, so `lens` is needed only when resuming in a new terminal or after switching work items.

---

## 6. The phase loop

The `feature` work type runs `intake → requirements → design → implementation-spec → implementation → verification → conformance`. Inspect any work type without starting work using `singularity-flow workflow simulate feature`.

For each phase:

```bash
singularity-flow wm build   --phase intake --task "Add invoice export" --local
singularity-flow wm compose --phase intake --task "Add invoice export" --dry-run
singularity-flow wm compose --phase intake --task "Add invoice export"
singularity-flow prepare intake
# author singularity/work-items/WORK-123/artifacts/intake/intake.md
singularity-flow artifact scan --phase intake
singularity-flow phase publish intake
singularity-flow phase show intake
singularity-flow submit --phase intake
singularity-flow approve WORK-123 --fetch
```

Use the same `--task` text for `wm build` and `wm compose`: the task guide is matched exactly, and a mismatch fails rather than silently grounding on the wrong guide.

Artifacts must exceed the phase's configured `minimumBytes` and contain no `TODO`, `TBD`, `{{…}}`, or `[describe …]` placeholders; `publish` and `submit` both refuse otherwise. Phases with `writeScope: artifact-only` reject any change outside `artifacts/<phase>/` — source code belongs to `implementation` and `verification`.

Approve without a terminal:

```bash
git status --porcelain                       # must be clean
singularity-flow choices begin approve WORK-123 --json
TOKEN=<uuid>
singularity-flow choices answer $TOKEN persona            product-owner --json
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
singularity-flow next [--task TEXT]             # executes exactly one action
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
```

Uploads require an active working-lens session bound to the work item, and are allowed only in the phases listed by `documents.allowedPhases` — for `feature` that is `intake`, `requirements`, `design`, and `implementation-spec`. Later uploads trigger a soft gate that must be confirmed interactively. `--label` applies to a single document; the per-file limit is `documents.maxFileBytes`.

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
2. Commit `singularity/` on the base branch before `start`; it is hash-pinned and protected afterwards.
3. Ensure a clean tree before `start`, `resume`, `session attach`, `choices begin approve`, `approve --selection-receipt`, `epic start --local`, and `finalize`.
4. Reserve a terminal for `start`, `lens`, `resume`, `approve`, `reject`, and `epic start --local`.
5. Consume selection receipts without committing in between; they expire in 15 minutes and are single use.
6. Run `wm compose` before every `phase publish` while grounding is enforced, using the same `--task` text as `wm build`.
7. Replace every template placeholder and exceed the phase's minimum byte count.
8. Keep source changes inside `implementation` and `verification`.
9. Name the branch exactly the work ID.
10. Run `singularity-flow sync` after any failed push before continuing.
