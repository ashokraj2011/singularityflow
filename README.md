# Singularity Flow 0.9.0

Singularity Flow runs a governed software development lifecycle out of Git
itself. Work items move through declared phases; every artifact and every
approval is a commit, so any machine can pick the work up from the repository
alone.

## Start here

```bash
singularity-flow quickstart
```

Eight seconds, entirely offline, no model invoked, and your own repository is
untouched — it builds a throwaway one, takes a work item through every governed
step, and removes it. It is the fastest way to see what the rest of this document
describes.

Before a POC demo or release candidate, run `npm run poc:release-gate`. It packages the actual VS
Code extension and proves the seeded POC workflow against a throwaway real Git remote, independent
reviewer, native Copilot handoff, and restart recovery without invoking a model. See
[the verification checklist](./VERIFICATION.md) for the evidence boundary.

Then, on a repository you care about:

| You want to | Run |
| --- | --- |
| Set up a repository you already have | `singularity-flow init` |
| Set up a new capability, with its configuration branch and ledger | `singularity-flow bootstrap <REPOSITORY-URL>` |
| Get one personalized, read-only recommendation | `singularity-flow recommend` |
| Execute or inspect the governed next step | `singularity-flow next` / `singularity-flow nextsteps WORK-123` |
| Orient yourself or return to a Story without changing state | `sflow home` / `sflow story return WORK-123` |
| See what a command does, with examples | `singularity-flow <command> --help` |

The full documentation map is in [docs/README.md](./docs/README.md).
The read-only return experience is documented in
[Developer Home and Story Return](./docs/DEVELOPER-HOME.md).
In VS Code, **My Work** is the visible home; **Talk to SFlow** is retained only as
a hidden compatibility alias. In Copilot, developers can ask ordinary questions such as “What am I
working on?”, “What is blocking this Story?”, or “Start a new bug fix.” `/sf-home` is the explicit
escape hatch. Reads may run immediately; any mutation is previewed and requires an explicit governed
selection before it runs.

## What it is

Singularity Flow is a Git-native SDLC workflow for GitHub Copilot. A
repository-owned YAML file defines work types, phase sequences, artifact
templates, governed agents, human approval authority groups, world-model views,
and publication policy. Generated artifacts and lifecycle decisions are committed
to a work-item branch and pushed after every operation, so another terminal or VS
Code session can safely resume from Git. Its preferred direct Copilot skills use
the short `sf-` prefix.

**Singularity Flow** is the product under the **Singularity** brand. The installer
creates personal aliases such as `/sf-start`, `/sf-submit`, and `/sf-about`, so
normal use has no plugin namespace. The packaged `sflow-*` skills remain available
for compatibility, including the qualified `/singularity-flow/sflow-*` form.

The optional [Capability Ledger](./CAPABILITY-LEDGER.md) records high-value Story
and Initiative lifecycle events on an unrelated `state` orphan branch.
Durable work-branch intents let another machine reconcile a missing ledger append
after partial publication.
Run `/sf-about` for the installed version and a concise capability summary. The full
`singularity-flow <action>` executable remains a compatible CLI for existing
scripts and documentation.

The package contains:

- A deterministic Node.js CLI (`singularity-flow` or `sflow`).
- Explicit model-independent operation policies, a strict `--no-model` mode, deterministic `wm light`, and governed manual artifact publication.
- A VS Code extension for workspaces, intake, workflow configuration, progress, documents, and approvals.
- A GitHub Copilot plugin with collision-safe skills and a bundled workflow runtime.
- A canonical searchable help manual shared by the CLI, Copilot, and VS Code.
- Editable feature, bugfix, chore, and Figma-export-to-mobile profiles.
- Editable governed-agent prompts and artifact templates.
- World-model grounding, approval auditing, token accounting, and a final spec-to-code conformance gate.
- Opt-in clause-driven specification indexes, claim maps, coverage, acceptance evidence, and a VS Code traceability view.
- Exact local prompt-composition caching and honest deployment validation for orphan state ledgers.
- Opt-in Harness Imports for revision-bound `sfref:v1` artifacts, deterministic bounded previews, exact engine conformance evidence, and approved scoped knowledge recall.
- Opt-in Flow Impact studies with automatic Story enrollment, revision-bound receipts, honest exposure and missing-data records, aggregate privacy floors, uncertainty intervals, and quality-gated inference labels.
- A deterministic home, repository doctor, guided run mode, portable review bundles, safe recovery, workflow simulation, assignments, and read-only watching.
- Recursive design-package inventory and a local image gallery for exported Figma/mobile evidence.
- Opt-in initiative orchestration for Epics and repository-specific stories, with separate Epic/Story Work/Jira IDs, typed evidence, interface contracts, cross-repository progress, and enterprise phase gates.
- A native Copilot handoff: VS Code renders phase-aware governed context while authoring stays in the user’s normal Copilot session; the installed `/sf-*` aliases can be used directly.
- Local multi-repository workspaces with one Epic lead repository, per-repository Jira boards and App IDs, document staging, health checks, resumable setup, and Copilot context separation.
- A structured activity log (`error` through `trace`) covering commands and hook decisions, written machine-local under `.git/` with secrets redacted and never to standard output.

Start with the [documentation map](docs/README.md) and
[glossary](docs/GLOSSARY.md). For a complete explanation of the runtime, prompt composition, world model,
phase lifecycle, Git state transfer, approvals, Epic planning, Jira, workspaces,
VS Code, telemetry, and security boundaries, read
[How Singularity Flow works](FRAMEWORK-GUIDE.md). For the implementation-level
path from `/sf-*` through the Node.js launcher, command dispatcher, prompt
composer, question bridge, and Git publication, read
[Singularity Flow under the hood](docs/UNDER-THE-HOOD.md).
For the exact model boundary, model-disabled execution, external-command policy,
and human-authored artifact flow, read
[Model independence and manual authorship](docs/MODEL-INDEPENDENCE.md).

## Conversational developer guidance

Developers do not need to memorize the lifecycle command set to find the next safe step. The shell,
Copilot, and VS Code all read the same durable workspace, repository, and work-item records and use
the same deterministic guidance planners. They do not share an in-memory conversation or global
state.

Use the surface that is already open:

| Surface | Start here | What it does |
| --- | --- | --- |
| Shell | `singularity-flow recommend` | Shows one personalized, read-only recommendation for the active developer context. |
| Shell | `singularity-flow home --request "What is blocking this Story?"` | Routes an ordinary-language request to a bounded read planner. |
| Copilot | `/sf-recommend` | Relays the same recommendation, evidence, required inputs, and disclosed effect. |
| Copilot | `/sf-home <ordinary request>` | Routes the request through Home; `/sf-home` without a request remains the explicit way back. |
| VS Code | **My Work** | Opens the shared recommendation card for the selected governed workspace. |

The conversational router recognizes six closed intents. It is deliberately not a free-form command
parser:

| Intent | Example request | Result |
| --- | --- | --- |
| Orient | “What am I working on?” or “What should I do next?” | Shows the active workspace, Story, phase, and one recommended next step. |
| Continue | “Continue my current Story.” | Offers the current legal continuation; it does not run it automatically. |
| Start | “Start a new bug fix.” | Opens governed intake with bounded Story and work-type defaults. |
| Inspect | “What is blocking this Story?” or “What changed while I was away?” | Shows readiness, blockers, progress, or return reconciliation from durable state. |
| Act | “Generate the active phase.” or “Submit this.” | Previews the governed action and requires explicit authorization before mutation. |
| Recover | “The publication push is stuck.” | Prioritizes diagnosis, synchronization, and retained-publication recovery. |

A recommendation names the active context, explains why the action is next, summarizes recorded
artifacts, checks, and approvals, and reports the workspace, repository, identity, worktree, and
remote preflight state. It also discloses what the action can change and whether confirmation is
required. New Story intake still requires the work description, definition of done, and an explicit
remote base branch; conversational wording never supplies those product decisions silently.

All conversational routes resolve to read operations first. Read-only questions may be answered
immediately, but Continue, Start, Generate, Submit, Next, pull-request creation, and every review or
approval ceremony require an explicit governed selection. Ambiguous wording asks for clarification,
the displayed command is only a preview, and raw developer prose is not retained in the routing
result. Use `singularity-flow nextsteps [WORK-ID]` when you want the full ordered `NOW`, `THEN`, and
`ALTERNATIVE` plan instead of one recommendation.

## Requirements

- Node.js 20 or newer for the CLI and VS Code extension build.
- Git with a configured identity.
- A Git remote when `git.publish: required` is configured.
- GitHub CLI authentication is recommended so lifecycle events can record the authenticated GitHub login as well as Git identity.

## Install and initialize

```bash
npm install --global ./singularity-flow-0.9.0.tgz
cd your-repository
singularity-flow init --work-id WORK-123 --base main --fetch
git add singularity
git commit -m "[WORK-123][bootstrap] Initialize Singularity Flow"
git push -u origin WORK-123
singularity-flow start WORK-123
```

This branch-local bootstrap is the recommended path when `main` is protected:
Singularity Flow creates or reuses `WORK-123`, writes configuration only on that
branch, and never pushes or modifies `main`. If the process configuration should
become the shared default for later Work IDs, raise a normal reviewed pull request
from the bootstrap branch; direct access to `main` is not required.

For the first governed repository in an organisation, use the URL-based bootstrap.
It clones the detected application branch, publishes a collision-safe
`sflow/govern/<repository>-<base-sha>` proposal, seeds the independent
`sflow/config` and `state` branches, and leaves the application branch unchanged:

```bash
singularity-flow bootstrap <REPOSITORY-URL> --capability platform --name "Platform"
# The command prints the exact pull-request command for the governance proposal.
```

Use `--direct` only as an explicit opt-out in a repository whose application
branch intentionally accepts direct configuration pushes.

Initialization installs:

```text
.github/
└── agents/
    ├── architect.agent.md
    ├── developer.agent.md
    ├── product-owner.agent.md
    └── qa.agent.md
singularity/
├── workflow.yml
├── impact.yml
├── portfolio.yml
├── capabilities.yml
├── prompts/
│   ├── worldmodel-builder.md
│   └── copilot-planning.md
└── templates/
    ├── common/
    ├── feature/
    ├── bugfix/
    └── chore/
```

These files are ordinary reviewed repository files and remain fully editable.
Agent Markdown follows GitHub Copilot's repository-agent convention under
`.github/agents/`; `singularity/agents.lock.yml` is reserved for optional
trust-pinned remote Markdown dependencies.
Initialization can be audited or safely repeated on any branch:

```bash
singularity-flow init --check
singularity-flow init --repair
```

Repair copies only missing packaged files and never overwrites repository
customizations. It therefore does **not** convert or overwrite a version-1
`workflow.yml`. Version 2 is the only supported workflow schema; this POC has no
migration path. In Copilot CLI, use `/sf-init [WORK-ID]`; `/sf-doctor`
also runs the read-only initialization inventory before its wider repository
diagnostics.

For a deliberate clean restart, factory reset replaces the complete
`singularity/` tree from the templates bundled in the **currently installed npm
package** and removes machine-local runtime state under
`.git/singularity-flow/`. Always preview first:

```bash
singularity-flow factory-reset --dry-run
# Then copy the exact confirmation string printed by the preview:
singularity-flow factory-reset --confirm "RESET <repository-folder-name> <HEAD-prefix>"
singularity-flow init --check
git status --short
```

Saved workspaces whose lead repository explicitly declares workflow version 1
are automatically forgotten when the workspace registry is read. This removes
only the machine-local registration and active selection; it never deletes the
workspace directory or repository clone. Run `singularity-flow workspace prune`
to see the discarded registrations. Recreate the workspace after resetting its
lead repository to the bundled version-2 configuration.

This discards uncommitted workflow state, generated artifacts, world-model
files, templates, prompts, sessions, locks, local telemetry, and pending
publication records in the reset scope. It preserves application source, Git
history and configuration, workspace clones, the global workspace registry,
and custom `.github/agents` files not supplied by the package. The replacement
is left uncommitted for review. In Copilot, `/sf-factory-reset` enforces the
same preview and contributor-entered confirmation sequence.

In VS Code, open the Singularity Flow **Configuration** section and select
**Reset and reinitialize workflow v2**, or run **Singularity Flow: Reset &
Reinitialize Repository (Workflow v2)** from the Command Palette. The editor
shows the same engine-generated preview, requires the same exact confirmation,
installs the bundled version-2 files, validates them, and leaves the replacement
uncommitted. It does not migrate version-1 state. If governed files have local
changes, the editor refuses the reset so they cannot be discarded accidentally.

For a complete local restart of the current repository and this machine's
Singularity Flow registry, use the short one-shot command:

```bash
sf-reset-all --yes
```

It reinstalls the installed npm package's `singularity/` defaults, removes the
current repository's `.git/singularity-flow/`, and clears
`~/.singularity-flow/` (saved workspaces, active selection, lead registry, and
local CLI setup). It does **not** delete application source, Git history, or
physical workspace and repository clones. VS Code keychain credentials are
also preserved; reset Jira or Teams credentials separately in VS Code. Run
`sf-reset-all` without `--yes` to preview the exact boundary.

To forget all Singularity Flow state and personalization on this machine while
preserving every physical workspace, repository, branch, dirty file, manifest,
and repository-local recovery record, use:

```bash
singularity-flow local-reset --forget-only --dry-run
# Review preserved workspaces and every machine-state target, then:
singularity-flow local-reset --forget-only --confirm "FORGET LOCAL"
# Short equivalent:
sf-local-reset --forget-only --confirm "FORGET LOCAL"
```

To instead remove every validated Singularity-managed workspace directory and
clear machine-local state **without uninstalling the product**, use:

```bash
singularity-flow local-reset --dry-run
# Review the exact workspace paths and preserved components, then:
singularity-flow local-reset --confirm "RESET LOCAL"
# Short equivalent:
sf-local-reset --confirm "RESET LOCAL"
```

The destructive `local-reset` mode removes only workspace roots proven by both the machine registry
and a matching regular `workspace.json`. It also clears local sessions, caches,
telemetry configuration, recovery state, Singularity-named Copilot sessions,
and the VS Code extension's Singularity credentials/settings on next activation.
It preserves the installed CLI, VS Code extension, Copilot plugin, `/sf-*`
skills, unregistered repositories, and personal skills. Run it from outside the
workspace directories listed by the preview.

In an interactive terminal either mode displays its complete preview and prompts
for the exact mode-bound phrase in the same invocation. Cancellation, EOF, or a
mismatch changes nothing. Non-interactive and `--json` callers must use
`--dry-run`, followed by `--confirm`. `FORGET LOCAL` never authorizes workspace
deletion, and `RESET LOCAL` never authorizes `--forget-only`.

To replace only the locally installed Singularity Flow product while keeping all
repositories, workspaces, lifecycle state, credentials, and user configuration,
use the fingerprint-bound clean reinstall:

```bash
sf-reinstall --checkout /absolute/path/to/singularityflow --dry-run
# Copy the exact fingerprint confirmation printed by the preview:
sf-reinstall --checkout /absolute/path/to/singularityflow \
  --confirm "REINSTALL SINGULARITY FLOW <fingerprint>"
```

The preview first builds and tests an isolated copy of the selected checkout,
creates and hashes the npm tarball and VSIX, and only then offers a confirmation.
Applying it replaces the global `singularity-flow` npm package, both historical
Copilot plugin identities, marker-owned direct `/sf-*` skills, the VS Code
extension, and the installer-managed telemetry wrapper. It never runs Git and
never scans for or changes repository `singularity/`, `.singularity/`,
`.git/singularity-flow/`, branches, worktrees, artifacts, world models, workspace
clones, `~/.singularity-flow` workspace selection, VS Code state, SecretStorage,
Jira credentials, or personal skills. A receipt is written under
`~/.singularity-flow/installations/`.

### Replace copied identity values safely

To replace an old login, display name, or email across the current files in a copied
workspace or checkout, preview the exact files first:

```bash
npm run identities:replace -- \
  --root /absolute/path/to/copied-workspace \
  --replace "old-login=new-login" \
  --replace "Old Display Name=New Display Name"
```

The preview prints a fingerprint-bound confirmation. Apply only after reviewing it:

```bash
npm run identities:replace -- \
  --root /absolute/path/to/copied-workspace \
  --replace "old-login=new-login" \
  --replace "Old Display Name=New Display Name" \
  --apply --confirm "REPLACE IDENTITIES <fingerprint>"
```

The utility skips `.git`, dependencies, build output, symlinks, binary files, invalid
UTF-8, and files larger than 5 MiB. It changes current text files only; it never
rewrites Git history. Do not use it to alter identity-bound approvals in active
governed work—start a fresh Story or record a new governed decision instead.

For a company registry, add `--registry <URL>`; credentials stay in `.npmrc`.
If Copilot is unavailable, `--cli-only` replaces just the Node package and command
shims. A missing `code` executable is reported and the already-built VSIX is
retained for later installation.

For a genuinely fresh Singularity installation across the machine, run the
installer from a clean Singularity Flow source checkout. Preview first:

```bash
singularity-flow fresh-install --checkout /path/to/singularityflow
# Review every path. Then perform the deletion and reinstall:
singularity-flow fresh-install --checkout /path/to/singularityflow --yes
```

From inside the product checkout, `--checkout` may be omitted. The equivalent
low-level entry point remains `./install.sh --factory-reset [--yes]`.

This broader mode deletes **every registered workspace directory**, including
its managed repository clones, documents, generated artifacts, and local caches.
It also clears `~/.singularity-flow`, Singularity-named Copilot session state,
managed `/sf-*` aliases, old plugin copies, the old global npm package, and the
installed VS Code extension before installing fresh copies from this checkout.
Untracked `singularity/`, `.singularity/`, and `.github/agents/` directories
created inside the installer checkout are included in the preview and removed;
any other checkout change still stops the reset.
An existing directory is deleted only when its regular `workspace.json`
validates and exactly matches its registry entry; an ambiguous entry stops the
whole reset. Unregistered application directories, personal Copilot skills, and
the installer checkout are preserved. The reinstall leaves a one-time reset
marker; when the new VS Code extension first activates it clears Singularity
Flow Jira, Teams, indexed provider secrets, onboarding profile, and extension
global state.

Initialization also installs `singularity/portfolio.yml`. It is inert until an initiative is started and provides editable `initiative-lite` and `enterprise-delivery` profiles. See [INITIATIVE-ORCHESTRATION.md](INITIATIVE-ORCHESTRATION.md) for the complete multi-repository guide.

The governed Epic and Story pages do not start or embed a Copilot planning session. Requirements
and Planning show the exact `/sf-*` command to run from the open repository,
with one-click copy controls. The installed skill composes the selected phase,
governed agent, repository world model, approved inputs, agent skills, requirements,
and templates inside the user’s normal Copilot CLI session. Refresh the VS Code
Lifecycle view after the skill commits and pushes its result. Epic planning uses pinned Jira and
uploaded source evidence; it does not require a world model. After Story intake
creates the canonical Story branch, repository world-model generation becomes
an explicit CLI or Copilot-skill operation, and its commit is pushed on that Story
branch before phase work begins.

## Capabilities, and the workspaces made of them

What an organisation builds is a forest of one or more **capability trees**. Capability `kind` is a
closed pair: a **collection** groups related capabilities and names no repository;
a **delivery** ships from one or more repositories. Either kind may contain child
capabilities. A capability may be top-level or linked under another capability, and each tree may go to any depth. Jira projects
and team names belong to a capability, not to a repository or workspace. Optional
`type: tech|business` is a separate domain classification; it is not capability kind.

The approved map lives at `singularity/capabilities.yml` on the lead repository's
dedicated **`sflow/config` configuration branch**, with the repositories it refers
to declared in `singularity/portfolio.yml` on that same branch. Editing checks
nothing out permanently: Flow clones `sflow/config` into a temporary directory,
pushes a `sflow/config-change/capability/...` review branch, and discards the
checkout. It never writes the lead repository's application default branch.

```
singularity-flow capability map payments-api --lead https://git.example.corp/acme/platform.git \
  --name "Payments API" --kind delivery --parent payments --repository https://git.example.corp/acme/api.git \
  --metadata applicationId=APP-1001 --metadata costCenter=PAYMENTS

# Review the exact proposal, then activate it with its full commit SHA:
singularity-flow capability proposals --lead https://git.example.corp/acme/platform.git
singularity-flow capability proposal <REVIEW-BRANCH> --lead https://git.example.corp/acme/platform.git
singularity-flow capability activate <REVIEW-BRANCH> \
  --lead https://git.example.corp/acme/platform.git --confirm <FULL-PROPOSAL-COMMIT> \
  --acknowledge-unprotected # only when the remote permits a direct update
```

In VS Code, open **Configuration → Review proposals**. The dashboard lists pending
changes across all registered lead repositories and works without an active
workspace. Select a row to inspect the exact diff and activate the reviewed commit.

The first capability mapped into a repository creates `sflow/config` if needed,
imports any existing reusable configuration as its seed, declares the repository,
and names the orphan `state` proof branch. Existing configuration files are
preserved; runtime state, evidence, telemetry, and world-model output are not
imported into shared configuration.

Capabilities may carry any number of organisation-defined text attributes under
`metadata`, for example application IDs, cost centres, owner codes, or service tiers.
The CLI accepts repeatable `--metadata KEY=VALUE`; the VS Code capability screens
provide matching key/value rows. These values are stored with the capability in
`singularity/capabilities.yml`—the approved authority is the lead repository's
`sflow/config` branch, and the reviewed map is projected to the orphan state branch.
Use `--metadata KEY=` with remote `capability edit` to remove one key. Local
`capability add`, `set`, and `remove` edit only the checkout; they never publish
governed configuration or move the state branch. Use `capability map` or remote
`capability edit --lead <URL>` to create a governed proposal.

When a Story starts, Flow copies one exact approved `sflow/config` revision onto
the new Story branch and commits `singularity/configuration-source.json`. That
record pins the source repository, full configuration commit, and SHA-256 of every
copied configuration asset. Later phases therefore cannot silently change when
shared configuration advances. Application `main` remains application code and
never receives capability, workflow, agent, prompt, skill, or template edits from
this path.
In VS Code, creating, editing, deleting, or initially mapping a capability automatically
opens **Review capability proposal**. That screen
shows the exact source and target commits, changed files, and diff. **Merge and
acknowledge** performs a normal non-force merge into `sflow/config`, publishes the
orphan state projection, records an append-only activation event, and refreshes any
retained Workspace form. Flow first dry-runs the exact target push. If the remote
permits a direct update, the actor must explicitly acknowledge that protection is
not enforced for them. If the remote rejects it, the proposal remains intact for
the repository's normal pull-request controls; the application default branch is
never changed.

After an external review merge, run the proposal's same exact-hash
`capability activate ... --confirm <FULL-PROPOSAL-COMMIT>` action; it detects that the
commit is already present and publishes the orphan state projection. `capability publish`
remains a projection-repair command, not a substitute for exact proposal activation.
Unreviewed configuration is never copied to an application branch or the state
proof branch.

Organisation reads use the capability mirror on the orphan state branch when it is
available and fall back to the approved `sflow/config` copy during bootstrap or
repair. A validated machine-local cache is keyed by the configuration branch commit,
so unchanged reads avoid another clone. If the remote is temporarily unreachable,
the CLI and VS Code show the last validated map with an explicit stale warning.
Use `capability organisation <LEAD-URL> --refresh` or the VS Code refresh action to
bypass the cache and contact the remote.

When a Story or Initiative starts, Flow resolves the owning capability from the
active workspace (or accepts `--capability <ID>` when a repository participates in
more than one). It snapshots the capability path, map SHA-256, inherited policy,
active leases, and sibling-repository world models into the lifecycle branch.
That immutable snapshot then tightens phase availability, write scope, checks,
approval identities and thresholds, self-approval, document/token budgets, and
required world-model views. Prompt composition reads only the pinned, hash-verified
views required by the active phase; later capability-map or sibling-model changes
cannot silently rewrite work already in progress.

Use one diagnostic from the terminal, Copilot, or the VS Code **Diagnostics**
command:

```bash
singularity-flow capabilities doctor
# Copilot: /sf-capability-doctor
```

A **workspace** is a set of capabilities and a local working directory. The
repositories it clones are what those capabilities ship from, derived rather than
listed again. One chosen capability is the **lead capability**; the repository it
ships from is where the orphan `state` branch is created when the workspace is
initialised.

```bash
singularity-flow workspace prepare https://git.example.corp/acme/platform.git \
  --id commerce-work \
  --capability commerce --lead-capability payments-api \
  --base ~/work --initialize

# After reviewing the returned preflight and exact target:
singularity-flow workspace bootstrap resume <BOOTSTRAP-ID> \
  --confirm commerce-work
```

Choosing a capability includes everything beneath it, the way choosing a
directory includes its contents — and the selection is recorded rather than its
expansion, so a capability added to the map later is picked up by a workspace
that asked for its parent. No two workspaces may occupy the same directory.
Workspace setup does not require Jira. `prepare` creates no workspace destination: it records an
integrity-checked session and classifies runtime, path, disk, registry, authentication, network, and
branch failures. `resume` rechecks before using the existing staged clone transaction, so interrupted
setups continue by bootstrap ID instead of starting over. Use `workspace doctor --network` for an
explicit remote diagnostic. See [WORKSPACES.md](WORKSPACES.md).

The editor extension exposes both actions from one **Workspaces** view. A saved
workspace is its local directory plus its mapped capability scope; the selected
workspace shows both together beneath the workspace list. **Work here** makes it
the context used by Lifecycle and Configuration. If the extension activated
before any workspace was selected, VS Code reloads that same window once to bind
those views to the lead repository; it never creates another window. **Open lead
repository** remains a separate, explicit action for editing code and is not
required just to select a workspace.

Workspace display names can be changed locally. Before archiving, Singularity
Flow refreshes every participating repository and proves that every governed
Story is `complete` or `cancelled`; inaccessible repositories and active Stories
block the action. Archived workspaces move into a separate VS Code folder while
their checkouts, branches, generated artifacts, approvals, and history remain
available for inspection and restore.

The VS Code sidebar deliberately separates work from setup. **Favorites** stays at the top and lets
each developer pin the menus they use most through **Choose favorites**; those selections are stored
only in personal VS Code state and never enter governed repository configuration. First-time users
start with My Work, Start intake, and Inbox pinned. Favorites and Lifecycle open by default while the
supporting sections remain collapsed; the sidebar remembers later choices. **Lifecycle** is the
intake and delivery view: start Initiative, Epic, or Story intake, choose the
workflow for that work, inspect the selected workflow's phases and artifacts,
run the next action, and make approval decisions. Workflow choices disappear
from Lifecycle after intake because that choice is then pinned to the active
work. **Configuration** is where the machinery is created and edited: workflow
and phase design, gates, world-model rules, `workflow.yml`, `portfolio.yml`,
artifact templates, governed Agent Markdown and its prompts, skills and prompt
packs, remote agent resources, mappings, and approval policy. Capabilities are
not a fourth lifecycle/configuration concept; they are shown as part of the
selected Workspace scope.

From Copilot, `/sf-workspaces` lists saved contexts and `/sf-workspace`
selects one. From a terminal, `singularity-flow workspace copilot <WORKSPACE>`
starts Copilot in the selected repository and names the session for the
workspace; a governed Story branch adds the Story ID. Singularity renders labels
such as `Payments / MOB-123 >` as a context banner because Copilot does not
provide a supported way to replace its own native `>` input marker.

Once selected, the workspace repository is also the explicit fallback for
repository-scoped CLI and `/sf-*` commands launched outside a Git checkout. A
current Git checkout always wins, and setup, reset, installation, and workspace
administration commands are deliberately never redirected.

If Copilot or VS Code is already open in the wrong checkout, run
`singularity-flow session workspace <WORKSPACE> [--repository ID] [--story ID]`
from any directory, invoke `/sf-workspace-session`, or choose **Singularity Flow:
Attach Copilot Session to Workspace** from the VS Code command palette. The
command records the machine-local workspace context and identifies the exact
governed repository. VS Code replaces the current window with that repository
and opens a fresh chat; a terminal receives the exact `workspace copilot`
command because a child process cannot change its parent process's directory.

Before a Story or Epic exists, **Lifecycle → Explore workspace impact** can call
Copilot over revision-pinned, disposable copies of every selected workspace
repository. It needs no Work ID and creates no branch. The local report records the
repository commits, world-model hashes, staged documents, prompt, summary, and
freshness. Changes to a captured repository HEAD or to the saved prompt/summary
make the report stale. A useful result can be copied into the workspace document
inbox and then explicitly selected as governed intake evidence; advisory output is
never silently treated as approved lifecycle state. The terminal equivalent is
`singularity-flow workspace impact analyze <WORKSPACE-DIRECTORY> --description
"..."`; `/sf-workspace-impact` provides the guided Copilot CLI flow.

Interrupted workspace creation is resumable: selecting the same workspace ID and
exact repository plan retries missing clones and updates the local
materialization journal. Singularity Flow rejects configuration drift at an
existing target, canonicalizes recent workspace aliases, and refuses linked
workspace manifests rather than crossing a local storage boundary.

`singularity/portfolio.yml` remains an advanced editable runtime contract for
teams that use initiative orchestration, but it is not a separate workspace
database and is not required to create or open a workspace.

Each participating repository can carry application identity and arbitrary scalar key/value metadata. Use **Initiatives → Portfolio designer → Add repository**, or edit the same governed YAML directly:

```yaml
repositories:
  mobile:
    url: git@git.example.corp:company/mobile.git
    defaultBranch: main
    required: true
    metadata:
      appId: APP-1001
      name: Mobile application
      owner: Digital Channels
      costCenter: CC-42
```

This metadata stays in `singularity/portfolio.yml`, is pinned into initiative state, copied into local workspace manifests, included in planning context, and passed to materialized story seeds.

The leading dot was intentionally removed: repository-owned configuration, prompts, templates, artifacts, and workflow state now live in the visible `singularity/` folder. Private machine/session data remains under `.git/singularity-flow/` and `~/.singularity-flow/`.

Start an initiative from GitHub Copilot:

```text
/sf-initiative-start INIT-2026-001
/sf-initiative-phase
/sf-initiative-next
/sf-initiative-status
```

Starting uses `main` (or the configured default branch) only as the source baseline for the new initiative branch. It does not merge anything into `main`; completed code still follows the repository's normal pull-request and merge process.

### Epic planning is the streamlined default

For a Jira Epic that should end with reviewed Stories, an approved high-level
specification, canonical repository branches, and Product Owner validation,
use the four-phase `epic-planning` profile:

```text
/sf-epic-start MOB-100
/sf-epic-sources
/sf-epic-requirements
/sf-epic-story-draft
/sf-epic-publish
/sf-epic-status
/sf-epic-next
/sf-epic-sync
/sf-epic-drift
/sf-epic-review
/sf-epic-review-decision
/sf-epic-merge-plan
/sf-stack
/sf-refresh-branch
/sf-regression-investigate
/sf-story-start
/sf-story-fetch
/sf-story-checks
/sf-worldmodel
/sf-agents
/sf-telemetry
```

Stories in the Epic's own repository are branched from the **Epic branch**, which
is the only branch carrying the approved Epic artifacts their seeds cite by hash:

```text
main
└── MOB-100          Epic branch: requirements, Story plan, specification
      ├── MOB-123    Story branches, cut from the Epic branch
      └── MOB-124
```

Story pull requests target the Epic branch and merge in a dependency-safe stack.
`singularity-flow stack sync --epic MOB-100` publishes the current order to the
orphan `state` branch in every participating repository; `singularity-flow pr`
reads it and refuses out-of-order work. After every blocking Story has merged,
preview and open the final Epic pull request with:

```bash
singularity-flow epic pr --epic MOB-100
singularity-flow epic pr --epic MOB-100 --create
```

The detected application branch—not a hard-coded `main`—is the base. Stories in other
repositories keep branching from that repository's own default branch — an Epic
branch is never created where one does not already exist. See
[INITIATIVE-ORCHESTRATION.md](INITIATIVE-ORCHESTRATION.md) for the full topology.

The VS Code extension presents **one navigation for every role**. An `Epic planning`
section carries the journey — `Epics`, `Requirements`, `Planning`,
`Create Stories`, `Copilot CLI handoff`, and `Artifact templates` — alongside
`Delivery`, `Decisions`, `Configuration`, and `Learn` in the same collapsible
sidebar (⌘/Ctrl+B). The role chosen during onboarding suggests an initial
planning governed agent; it does not route to a different shell, and there is no
experience to switch between. The active workspace remains visible in the top
bar, while each phase page shows the exact command for the normal Copilot CLI.

Planning combines Story decomposition and the high-level specification without
hiding either governed phase. Generated Stories and their `REQ-nnn`/`AC-nnn`
allocation are reviewed before the publication screen creates or attaches each
Jira Story, uses the returned Jira key as its stable Work ID, and creates the
corresponding canonical Git branch with governed seed and receipt commits.
Copilot explicitly stops after drafting so business reviewers can use the UI to
edit, split, add tasks and key/value metadata, or adopt a Jira Story that is not
linked to the Epic. Direct adoption preserves the Story's existing Jira parent.
Successful Jira/Git publication completes planning and opens the delivery
dashboard. Developers use **Delivery → Story intake** to choose an assigned
Jira Story or enter its exact key, inspect the parent Epic and acceptance
criteria, confirm repository routing, and select the workflow; its phase agent is automatic. The
Story can be started directly without first creating or selecting an Epic in
Singularity Flow; any Jira parent is retained as optional lineage. The
same entry point is available through `/sf-story-start`; a Story published
by a governed Epic can still be fetched with `/sf-story-fetch`. Intake pins
the Jira snapshot, creates or resumes the canonical Jira-key branch, commits,
and pushes before phase work begins. Developers finalize independently, and the Product Owner closes the Epic only after the
exact parent specification and every blocking Story's spec-to-code evidence
match. Each stage keeps completed work available for audit.

Artifact templates include a visual drag-and-drop builder with a reusable
section library, reorderable canvas, in-place guidance editing, live Markdown
preview, and exact Source mode. Templates may also be loaded from a public HTTPS
Markdown URL after a bounded, credential-free fetch and a SHA-256/content
preview. The selected bytes are copied into the repository and become the
governed local template; generation never depends on the URL remaining
available.

An Epic can be imported from Jira or created without Jira. Local Epics reserve
collision-safe IDs such as `SF-E-001` through an atomic branch push; their
Stories retain immutable `STORY-nnn` plan IDs and receive scoped Work IDs such
as `SF-S-001-001`. The prefixes and padding are configurable in
`singularity/portfolio.yml`, and the selected identity authority is pinned for
the life of the Epic. The
same lifecycle is available as `singularity-flow epic ...`. Pinned source
files stay in Jira attachments, Artifactory, SharePoint, S3, or an approved
HTTPS location; Git carries immutable source records and lineage rather than
large source bytes. SharePoint delegated OAuth in VS Code remains unsupported until the documented
corporate redirect-flow and proxy spike succeeds; credentials must remain in approved secure
stores. Requirements trace `SRC-* → REQ-nnn → AC-nnn`; plan version
2 then traces these to `STORY-nnn → returned Jira key/numeric ID → canonical
branch → optional Developer child branch → review packet → GitHub Actions/PR
evidence → conformance → exact-hash decision`.

Developers register custom branches explicitly:

```bash
singularity-flow story branch create feature/login-ui --parent MOB-123
singularity-flow story submit
```

Reviewers use **Epic workspace → Review** or
`singularity-flow epic review MOB-123`. Exact-SHA checks read GitHub evidence
through `gh` and do not run repository code on the reviewer’s machine. See
[HELP.md](HELP.md#epic-to-story-planning-and-lifecycle-lineage) for the complete
workflow and corporate credential/storage behavior.

When publishing, the user explicitly selects which approved requirements and
specification outputs Jira receives. Those files and hashes are part of the
reviewed write plan and are uploaded with hash-stamped filenames to the Epic,
every Story, or both. After all blocking Stories are complete and their exact
review packets, GitHub checks, and conformance tree hashes match, the Product
Owner runs `singularity-flow epic complete <EPIC-KEY>` or uses the wizard to
create and push the immutable Epic completion report.

## Built-in help

The canonical product manual is [HELP.md](HELP.md). For an end-to-end diagram and operational walkthrough, use [HOW-TO.md](HOW-TO.md). To run the complete lifecycle without a Jira connection, use [LOCAL-RUNBOOK.md](LOCAL-RUNBOOK.md). Load all help or one focused topic from the terminal:

```bash
singularity-flow help
singularity-flow help quick-start
singularity-flow help jira-intake
singularity-flow help troubleshooting
singularity-flow help --json
```

For a safe first experience, run the complete two-phase quick-fix rehearsal:

```bash
singularity-flow guide --first-run
# Preserve the isolated toy repository for inspection:
singularity-flow guide --first-run --keep
```

The guide creates a temporary Git repository, runs the real `start → prepare →
publish → submit` lifecycle through deterministic **Implement** and **Verify**
phases, prints the sandbox boundary before execution, and removes it after
success unless `--keep` is supplied. It makes no network request and invokes no
model. A failure is retained with `failure.json` so it can be reproduced.

Low-risk repository work can select the built-in `quick-fix` work type. Its
two-phase rail uses deterministic evidence, no human approval for Implement,
and a hash-bound verification policy waiver only when every declared predicate
passes. Unknown risk, protected paths, semantic boundary changes, failed checks,
multiple repositories, or an oversized change fall back to normal human review.

Source-writing phases also use governed work intervals. The committed baseline
pins the phase's starting source/configuration state; optional local checkpoints
store only hashes under `.git`; and submission atomically records a final
specification-to-change reconciliation. Protected or oversized quick fixes are
blocked with a non-destructive escalation plan. No CI provider or Git-host
workflow file is required. See
[Governed work intervals](docs/GOVERNED-WORK-INTERVALS.md).

Developer-experience diagnostics are opt-in and bounded:

```bash
singularity-flow snapshot WORK-123 --include lifecycle --timings --json
singularity-flow snapshot WORK-123 --include lifecycle --if-revision <HASH> --json
singularity-flow report WORK-123 --timings
singularity-flow pr describe WORK-123 --format markdown
```

`--if-revision` returns a `notModified` envelope without repeating snapshot
payload. `pr describe` generates deterministic Markdown locally; it may copy the
text to the clipboard or update an existing PR only when those actions are
explicitly requested. It never creates a PR implicitly.

In Copilot, `/sf-help` loads the manual for general questions; `/sf-help WORK-123` loads the selected work item's immutable workflow guide. VS Code includes the same manual in the always-available **Help** view and searchable **Help Center**, bundled for offline use. It has focused entries for capabilities, workspaces, Story intake, workflow state, agents, prompts, world-model composition, troubleshooting, every `/sf-*` skill, and every top-level CLI command.

Copilot start, resume, approval, rejection, and governed-agent flows use its
interactive question facility to show the YAML-configured choices. Choose a
label instead of typing a governed-agent or workflow ID. During start or approval, a shell
without persistent stdin uses a short-lived one-time selection receipt, so the
contributor or reviewer can stay in Copilot. If interactive questions themselves are disabled, Singularity
Flow stops rather than choosing a default.

Use `/sf-nextsteps [WORK-ID]` whenever you need a compact ordered plan. Its CLI equivalent, `singularity-flow nextsteps [WORK-ID]`, works before initialization, without an active work item, during pending publication recovery, throughout every phase, and after completion. It is read-only and marks actions as `NOW`, `THEN`, or `ALTERNATIVE`.

For an executable, revision-bound plan use `/sf-continue` or **Lifecycle → Continue safely** in VS
Code. The underlying commands are `singularity-flow action plan --json` and
`singularity-flow action authorize <PLAN-ID> --action <ACTION-ID> --confirm <ACTION-ID>` followed by
`singularity-flow action execute <PLAN-ID> --action <ACTION-ID> --authorization <ONE-TIME-TOKEN>`.
The local authorization is bound to that exact plan/action and is consumed once. The plan expires
and becomes stale whenever the branch, HEAD, staged/unstaged file bytes, or lifecycle snapshot changes. See
[Governed execution](docs/GOVERNED-EXECUTION.md) for the action protocol, isolated Git publication,
review-packet binding, and its explicit containment boundary.

### One-command local update and installation

From a clean clone, update the tracked branch, create the distribution tarball, install it globally, remove any previous Copilot plugin identities, and install one current marketplace plugin:

```bash
./install.sh
```

`npm run install:local` is an alias for the same script.

On Windows, open **Git Bash** in the Singularity Flow checkout and use the Windows wrapper. It
checks Node.js 20+, updates the checkout safely, confirms that the CRLF Agent Markdown fix is
present, and delegates to the same validated installer:

```bash
bash ./install-windows-git-bash.sh

# With a corporate npm registry / Artifactory
bash ./install-windows-git-bash.sh \
  --registry "https://artifacts.company.com/artifactory/api/npm/npm-virtual/"
```

It does not change global or repository `core.autocrlf`, run `dos2unix`, or rewrite tracked files.
Keep registry credentials in the user's `.npmrc`.

Before dependency installation, the script asks you to choose:

1. The registry currently returned by `npm config get registry`.
2. The public npm registry.
3. A custom company registry or Artifactory URL.

For a non-interactive or repeatable company setup, pass the registry explicitly:

```bash
./install.sh \
  --registry "https://artifacts.company.com/artifactory/api/npm/npm-virtual/"
```

You can provide the same override through an environment variable:

```bash
SINGULARITY_FLOW_NPM_REGISTRY="https://artifacts.company.com/artifactory/api/npm/npm-virtual/" \
  ./install.sh
```

The standard npm environment variable works as well, which is useful when an
enterprise launcher already provides it:

```bash
NPM_CONFIG_REGISTRY="https://artifacts.company.com/artifactory/api/npm/npm-virtual/" \
  ./install.sh
```

Registry precedence is `--registry`, `SINGULARITY_FLOW_NPM_REGISTRY`,
`NPM_CONFIG_REGISTRY`, then `npm config get registry` (including user and project
`.npmrc` files).

For an interactive installation, run `./install.sh`, choose **Custom company registry / Artifactory**, and enter the registry URL. The `--registry` option takes precedence over the environment variable and interactive selection.

Keep Artifactory authentication in your user or company `.npmrc`; do not put credentials in the registry URL. For example:

```ini
registry=https://artifacts.company.com/artifactory/api/npm/npm-virtual/
always-auth=true
//artifacts.company.com/artifactory/api/npm/npm-virtual/:_authToken=${NPM_TOKEN}
```

Export the token only in the shell or CI secret store, then run the installer:

```bash
export NPM_TOKEN="your-artifactory-token"
./install.sh \
  --registry "https://artifacts.company.com/artifactory/api/npm/npm-virtual/"
```

The selected registry is exported as `NPM_CONFIG_REGISTRY` for the complete installer
process. It therefore reaches every `npm ci`, `npm run`, lifecycle subprocess,
packaging helper, and global installation—not only the first dependency install.
The script rejects credentials embedded in a URL, never prints tokens, and does not
modify persistent npm configuration.

To reinstall the currently checked-out product without pulling or changing any
repository, use the same shared planner through the installer:

```bash
./install.sh --clean-reinstall --dry-run
./install.sh --clean-reinstall \
  --registry "https://artifacts.company.com/artifactory/api/npm/npm-virtual/" \
  --confirm "REINSTALL SINGULARITY FLOW <fingerprint>"
```

This path delegates to `singularity-flow reinstall` before the normal installer
performs any Git check. All build and package validation completes before the first
installed surface is removed.

By default, the installer loads the Copilot plugin bundled inside the installed
package. To use a company-managed Copilot marketplace instead, provide its
approved source:

```bash
SINGULARITY_FLOW_MARKETPLACE_SOURCE="company/singularity-flow" \
  ./install.sh --registry "https://artifacts.company.com/artifactory/api/npm/npm-virtual/"
```

The installer also enables GitHub Copilot CLI's metadata-only OpenTelemetry file exporter for future model, token, timing, and cost collection. Its shell wrapper explicitly selects the file exporter, selects the active repository dynamically, and keeps raw traces at `<git-dir>/singularity-flow/copilot-otel.jsonl`; prompt and response content capture remains disabled. Phase publication commits only a sanitized summary to `singularity/work-items/<WORK-ID>/telemetry/<phase>-gen<N>.json`, so model/token/cost state follows the work-item branch to another laptop without committing raw traces or conversation identifiers. Existing Copilot OTel environment configuration is preserved. Use `./install.sh --no-copilot-telemetry` or `SINGULARITY_FLOW_COPILOT_TELEMETRY=off ./install.sh` when an organization manages telemetry separately.

The single self-contained `install.sh` performs:

```text
git pull --ff-only
choose configured, public, or custom npm registry
npm ci --registry=<selected-registry>
npm run vscode:build
npm test
npm run check
npm pack --json
npm uninstall --global singularity-flow
npm install --global <generated-tarball> --registry=<selected-registry>
npm run vscode:package
code --install-extension <generated-vsix> --force
singularity-flow plugin install
configure metadata-only Copilot OpenTelemetry
```

The script refuses a checkout with uncommitted changes and never resets, rebases, or force-pushes. It keeps the generated `singularity-flow-<version>.tgz` in the repository root for distribution and prints the installed CLI and Copilot plugin versions. Fully exit any running Copilot CLI process, then open a new terminal and start Copilot from the repository after installation; environment variables cannot be injected into a process that was already running.

`--factory-reset` is the deliberate exception to the installer's normal
non-destructive behavior. Without `--yes` it is preview-only. With `--yes`, it
applies the validated machine-wide deletion boundary described above before the
normal build and installation steps begin.

## Configuration

In VS Code, open **Configuration → Open Configuration Center** for the guided
overview. **People & approvals** manages real human Git identities and authority
groups; **MCP tools** manages agent/phase/tool policy and reports whether the
matching VS Code or Copilot host server is configured. These are deliberately
separate from governed AI agents. All visual saves are validated by the CLI and
preserve unrelated YAML content. After a save, **Configuration → Unpublished
configuration** lists every changed file and provides **Review & publish
configuration**. That action previews the exact scope, creates one commit, and
pushes the current governed configuration-review branch; unrelated working-tree
changes block it, and the engine never publishes configuration from the protected
application branch. See
[`docs/CONFIGURATION-CENTER.md`](docs/CONFIGURATION-CENTER.md).

`singularity/workflow.yml` is the definition for new work items. It contains:

- `workTypes`: profile-specific phase sequences, template overrides, and optional `phaseOverrides` for checks, world-model, comparison, artifact, input, and approval policy.
- `inputsMode`: backward-compatible `off`, audit-oriented `record`, or blocking `enforce` phase dataflow.
- `phases`: default templates, approved upstream inputs, artifact paths, write scope, world-model views, clarification checkpoints, quality commands, and approval rules.
- `agents`: prompt-only governed agents, suggested phases, and additional world-model views.
- `approvalAuthorities`: real-human approval groups matched by Git email or authenticated GitHub login.
- `documents`: allowed upload phases, maximum file size, and text-preview limit; work types may override this policy.
- `git`: remote name and whether publication is required.
- `governance`: protected paths and traceability rules.

Template resolution is deterministic: a work-type override wins, then the phase default is used, and initialization fails when neither exists. At `start`, the resolved profile, configuration hash, and template hashes are stored in `workflow.json`. The selected work type is then immutable for that work item.

The bundled profiles are:

| Work type | Phase sequence |
|---|---|
| Feature | intake → requirements → design → implementation-spec → implementation → verification → conformance |
| Bugfix | intake → reproduction → fix-design → fix-spec → implementation → verification → conformance |
| Chore | intake → implementation → verification → conformance |
| Figma export to mobile app | design-intake → design-inventory → component-mapping → mobile-spec → implementation → visual-verification → conformance |
| POC workflow | POC intent → impact analysis → UI exploration → Playwright generation → bounded validation/repair → publication review |

Agent mappings connect native Copilot agents to governed Agent Markdown. Each phase activates its configured default agent automatically; `/sf-agent` is an explicit, audited override. An agent changes instruction context only and can never grant approval permission. Phase approvals reference `approvalAuthorities`; every decision records the human identity, matched authority group, identity-assurance level, and active agent separately.

For `figma-mobile`, committed PNG exports are the canonical approval baseline. VS Code and the generated local gallery provide verified thumbnails, full-size previews, and local PDF viewing; visual-verification evidence registers the pinned design, implementation screenshot, and diff image under the governed Story. Live Figma links open externally over HTTPS and are explicitly labeled as mutable convenience context.

## Start and resume

```bash
singularity-flow workspace branches --json
singularity-flow start ENG-142 --title "Add invoice export" --from-branch main --fetch
singularity-flow resume ENG-142 --fetch
```

Every new Story first requires an explicit branch published by every required repository; no branch is preselected, even when only one is available. With no source flags, `start` then asks whether intake comes from a Jira story or a manual description and documents. Manual mode asks for the title, audience, problem, outcome, acceptance criteria, and supporting file paths or HTTPS URLs. After source intake is complete, `start` asks for a workflow template (`feature`, `bugfix`, `chore`, `figma-mobile`, `poc-workflow`, or another configured work type). The POC workflow requires a hash-bound Playwright host attestation and live browser smoke receipt, governed accessibility/runtime/visual evidence, real TypeScript and Playwright execution, at most two kernel-enforced human-authorized repair generations, and separate quality and engineering decisions at publication. The kernel restricts its generation and repair phases to recognized test-automation paths, so an instruction cannot authorize product-source edits. It never runs an autonomous healing loop or writes the selected base branch. Its phases use separate least-privilege analyst, explorer, test-developer, and validator agents. The first phase activates its default agent; resume activates the current phase's default. The active agent is stored locally in `.git/singularity-flow/session.json`; opening a session does not create a repository commit. It is prompt context, not a real identity or approval credential.

The receipt flow is local and auditable: `singularity-flow choices begin start <WORK-ID> --json` returns the live remote-base, YAML-derived intake, and workflow options; Copilot presents them through `ask_user`; and each exact answer is recorded with `singularity-flow choices answer`. Approval receipts bind to the submitted phase, generation, artifact hashes, and exact phase confirmation. The phase agent is recorded as audit context; approval authority is recalculated from the reviewer’s identity and the pinned authority registry.

Receipt answers use a short-lived filesystem mutation lock, so Copilot can
submit different answers concurrently from separate CLI processes without
losing one. Every read verifies the receipt schema, filename token, repository
HEAD shape, and bounded expiry timestamps before accepting it. Shared CLI JSON
and text replacement also uses collision-resistant temporary files and cleans
them after either success or failure.

New repositories keep session selection explicit but nonblocking in
`singularity/workflow.yml`:

```yaml
session:
  workItemSelection: prompt # off | reuse | prompt
  requireBeforeTools: false
```

The bundled Copilot plugin registers only a nonblocking `subagentStart` command
hook. It maps an exact Copilot custom-agent name to the same Singularity Flow
agent ID for the local session. It never injects a startup model prompt and never
denies Bash, edit, search, or view tools; deterministic CLI lifecycle checks remain
the enforcement boundary. The retained `session-start` and `agent-guard` CLI hook
handlers are available only for teams that deliberately install a custom
command-hook policy.

The skill catalog is governed by [`plugin/skills/registry.yml`](plugin/skills/registry.yml):
only help, next steps, and status may be selected automatically; all other skills
are explicit `/sf-*` operations. Body budgets, output contracts, utility-agent
routing, and measurement guidance are documented in
[`docs/SKILL-EFFICIENCY.md`](docs/SKILL-EFFICIENCY.md). Run `npm run audit:skills`
to verify the catalog.

New repositories also rotate Copilot context after an approved phase:

```yaml
contextPolicy:
  onApproval: new       # keep | compact | new
  onRejection: keep
  phaseOverrides:
    implementation: compact
```

The boundary is advisory because a child process cannot clear its parent Copilot CLI conversation. After the approval commit and push succeed, the CLI prints the exact next actions. `new` prints `/clear` followed by `/sf-next`, `compact` prints `/compact` followed by `/sf-next`, and `keep` continues directly. The next skill reconstructs its phase prompt from approved Git artifacts, pinned inputs, the selected governed agent, templates, agent Markdown, and required world-model views. Clearing therefore removes conversation history without losing governed state. It reduces tokens sent in later phases but does not refund tokens already consumed. Rejections default to `keep` so the correction conversation retains review feedback. The normalized policy is pinned in work-item and initiative state; configurations without it retain the earlier `keep` behavior.

`/sf-session` applies this policy in order. For each new Copilot session it uses an exact work ID or Jira ID explicitly supplied by the contributor, or asks for one when it is absent; lists committed work-item branches from the configured Git remote; fetches the remote; checks out a missing local tracking branch; and fast-forwards to the exact remote head. It then activates the current phase's default agent. `/sf-agent` explicitly overrides that prompt context without changing the human identity or its approval authority.

The attach path is deliberately conservative: missing, malformed, ahead, or diverged branches stop with a clear message, as does a dirty tree when attachment would require a checkout or fast-forward. If the requested Story branch is already checked out and its HEAD exactly matches the freshly fetched remote HEAD, attachment may bind the new Copilot session in place while preserving unpublished phase edits. It never creates a work branch, merges, rebases, resets, stashes, force-checks out, or discards local work. Run it directly with `singularity-flow session candidates` and `singularity-flow session attach ENG-142`. Copilot must already be open inside a clone of the application repository so `singularity/workflow.yml` and its configured remote are known; when the selected branch is absent locally, Git materializes it from the remote rather than cloning a duplicate repository.

Reviewers can open `/sf-inbox` or run `singularity-flow inbox` to fetch a repository-wide queue of committed phases awaiting approval. The inbox reads workflow state directly from remote work-item branches without checking each one out. It shows the work/Jira ID, title, phase, generation, approval threshold, waiting time, human authority groups, artifact path, self-approval warning, and exact remote commit. Selecting an item uses the same conservative session-attachment flow before displaying the complete phase documents; it never approves automatically.

No ID or governed agent is inferred, and the active agent never replaces the authenticated Git identity in audit records. Existing repositories without `session` behave exactly as before (`off`). The resolved policy is pinned into each work item so a base-branch YAML edit cannot weaken an active item silently.

On another terminal, `resume --fetch` fetches and fast-forwards the work-item branch. Committed branch state is the handoff protocol; the local session file is not part of it.

### Jira intake

Jira access uses Atlassian REST directly. Jira Cloud needs only the Jira URL, Atlassian username/email, and PAT/API token. The VS Code connection command presents exactly those credential fields, stores the token in `SecretStorage`, and sends the standard Basic-auth value `base64(username:PAT)`; it never requests an Atlassian password:

```bash
export JIRA_BASE_URL="https://company.atlassian.net"
export JIRA_USERNAME="person@company.com"
export JIRA_PAT="<api-token-from-atlassian>"
```

`JIRA_EMAIL` and `JIRA_API_TOKEN` remain accepted aliases. The CLI does not load `.env` files. Set these values for the current shell, inject them from a password manager, or configure them as protected CI secrets. Discover optional custom-field IDs and then export the fields used by your Jira site:

```bash
singularity-flow jira fields --query "Acceptance Criteria"
singularity-flow jira fields --query "Story Points"
singularity-flow jira fields --query "Sprint"

export SINGULARITY_FLOW_JIRA_ACCEPTANCE_FIELD="customfield_12345"
export SINGULARITY_FLOW_JIRA_STORY_POINTS_FIELD="customfield_10016"
export SINGULARITY_FLOW_JIRA_SPRINT_FIELD="customfield_10020"
# Optional comma-separated additional fields:
export SINGULARITY_FLOW_JIRA_EXTRA_FIELDS="customfield_10001,customfield_10002"
```

Verify access before starting work:

```bash
singularity-flow jira status
singularity-flow jira doctor
singularity-flow jira pull ENG-142
singularity-flow jira assigned --project ENG
singularity-flow start ENG-142 --jira --from-branch main
```

Jira Cloud and Jira Data Center are both supported. Data Center uses `JIRA_DEPLOYMENT=data-center` and a Bearer `JIRA_PAT`; the Cloud path uses username plus PAT/API token with Basic authentication. `singularity-flow jira status`, `projects`, `epics --project`, `children`, and `permissions --project` provide read-only discovery. The Copilot CLI exposes the same operations as collision-safe skills:

- `/sf-jira-status` checks the connection and authenticated Jira identity.
- `/sf-jira-doctor` checks the active workspace, repository Jira policy, CLI credential availability, identity, configured projects, permissions, boards, and Epic visibility, then prints corrective actions.
- `/sf-jira-assigned` lists incomplete Stories assigned to that identity.
- `/sf-jira-board` lists Stories grouped under active/future sprints and never queries the backlog.
- `/sf-jira-update` changes one Story only after displaying its current state and receiving exact Story-key confirmation.

Discover boards and retrieve sprint work without backlog:

```bash
singularity-flow jira boards --project ENG
singularity-flow jira board 42 --state active,future --type Story
```

Explicit direct updates use Jira's available transitions and dedicated assignee, priority, sprint, and comment APIs. Every mutating command requires the exact Jira key:

```bash
singularity-flow jira transitions ENG-142
singularity-flow jira transition ENG-142 --to "In Progress" --confirm ENG-142
singularity-flow jira assign ENG-142 --to me --confirm ENG-142
singularity-flow jira priority ENG-142 --to High --confirm ENG-142
singularity-flow jira sprint ENG-142 --to 81 --confirm ENG-142
singularity-flow jira comment ENG-142 --text "Ready for review" --confirm ENG-142
```

The CLI does not infer a transition or silently skip transition screens that require additional fields.

For corporate use, enable and constrain the connector in `singularity/portfolio.yml`, then run **Singularity Flow: Connect Jira Securely** in VS Code. The token is validated before VS Code stores it through `SecretStorage`; it never enters Git, prompts, logs, or workspace files. The extension exposes it only to the short-lived CLI child process. Host/project allowlists, deployment/auth mode, permitted writes, and owned fields remain repository policy. Use `singularity-flow jira doctor` for the complete read-only diagnostic.

When `singularity/portfolio.yml` is absent, initialize or configure the repository from **Configuration** before starting governed Jira intake.

Initiative-planning Jira writes are never immediate UI mutations. `initiative jira-plan` produces and pushes an exact reviewed diff; `initiative jira-apply --plan <sha256>` additionally requires an approved Plan/Elaboration phase, Jira permission preflight, exact initiative confirmation, unchanged Jira `updatedAt` values, and a plan that still matches the pinned connection, deployment, and project policy. Applied operations produce committed receipts, and retries accept only receipts that match the exact reviewed plan. That governed planner excludes status, assignee, sprint, priority, and resolution. A separately invoked `/sf-jira-update` is an operator action against one exact Story and is not part of the governed initiative write plan.

### Manual story intake without Jira

Manual intake has the same durable state-transfer behavior as Jira intake. Put the supplied story details in YAML or JSON; Markdown and plain-text briefs are also accepted. The structured format can capture the user, problem, desired outcome, scope, stakeholders, urgency, constraints, dependencies, acceptance criteria, risks, notes, and supporting documents. See `examples/manual-story.yml` for a complete example.

In VS Code, choose **Lifecycle → Start intake** and leave **Create without
Jira** selected. Enter a Work ID and title, optionally add Story context,
source files, an exported folder, or reference URLs, then choose the workflow
template and session governed agent. **Create Story branch** creates and publishes the
same durable state as the CLI command below. If that Work-ID branch already
exists, VS Code fetches and resumes it instead of creating a duplicate.

```bash
singularity-flow start WORK-123 \
  --from-branch main \
  --story-file ./manual-story.yml \
  --document ./additional-context.pdf \
  --document-url https://www.figma.com/design/example
```

`--document` and `--document-url` may be repeated. A story file may also declare a `documents` list containing paths, URLs, optional labels, and kinds. Relative document paths are resolved from the story file's directory. The command creates and pushes `source.json`, a readable `USER-STORY.md`, the workflow state, and each copied document with a stable `DOC-nnn` identifier. It still asks the contributor to choose the workflow template; the phase agent is automatic interactively.

For a short manual request without a story file:

```bash
singularity-flow start WORK-123 \
  --from-branch main \
  --title "Add invoice export" \
  --description "Finance needs a repeatable export of filtered invoices." \
  --acceptance-criteria "An authorized user can export the filtered invoice set."
```

### Help for the selected workflow template

At any time after starting work, show the chosen template, its complete phase sequence, artifacts, suggested governed agents, human approval authority groups, approval thresholds, current position, and exact next action:

```bash
singularity-flow guide WORK-123
```

From Copilot, use:

```text
/sf-help WORK-123
```

The guide is read-only. Depending on state, it recommends `/sf-phase`, `/sf-submit`, `/sf-approve` or `/sf-reject`, and `/sf-progress` after completion.

For the complete sequence of immediate, subsequent, and alternative actions instead of the full template explanation:

```bash
singularity-flow nextsteps WORK-123
```

From Copilot, use `/sf-nextsteps WORK-123`.

To execute one next action instead of only displaying the plan, use either form:

```text
/sf-next
```

```bash
sflow-next --task "Current objective"
# equivalent: singularity-flow next --task "Current objective"
```

The command performs exactly one lifecycle action. It recovers a pending push, prepares and grounds the active generation, submits an already-published generation, opens the normal interactive approval flow, or runs the terminal gate after completion. Copilot completes and publishes a prepared artifact; it does not silently chain that publication into submission. Approval verifies the real reviewer identity and authority group, activates the phase agent, then requires exact phase confirmation; every approval gets its own commit and push.

## Progress

```bash
singularity-flow progress ENG-142
singularity-flow progress ENG-142 --json
```

Progress is based on approved phases, so it is deterministic: `approved phases / total phases`. The command shows an arrow-based workflow map in addition to the progress bar and detailed phase table. Completed (`✓`), current (`▶`), awaiting-approval (`◆`), and pending (`○`) phases are visually distinct. It also shows percentage, current position, generation count, approvals received/required, uploaded-document count, and token usage. It never guesses partial completion inside an unapproved phase.

## Workflow performance reports

Generate a report from the committed work-item history without changing lifecycle state:

```bash
singularity-flow report ENG-142
singularity-flow report ENG-142 --format json
singularity-flow report ENG-142 --format html --out workflow-report.html
```

From Copilot, use `/sf-report ENG-142`. Markdown is the default; JSON exposes the derived data and HTML includes script-free inline charts. Reports show total and per-phase wall-clock duration, approval waiting, active time, generation/rework count, rejections, self-approvals, provider/model identity, exact token usage with per-model totals, quality-check duration, and the largest approval-latency bottleneck. An open approval request accumulates waiting time through report generation.

CLI responsiveness is governed separately from workflow duration. Run `npm run benchmark:dx`
to measure the pinned reference fixture, or add `--timings` to a command to see dispatch, module
load, and execution stages. See [Developer-experience performance](docs/DX-PERFORMANCE.md).

Durations include nights and weekends; they are not business-hours or developer-productivity estimates. Reports are derived views, not authoritative workflow state. Standard output is read-only, while `--out` writes only the requested report file and does not commit or push it automatically.

## Supporting documents and designs

Supporting inputs are managed under `singularity/work-items/<WORK-ID>/inputs/` and cataloged in `documents.json`. Uploads are allowed only in the initial phases configured by `documents.allowedPhases`; the starter profile allows intake, requirements/design/specification, and the corresponding bugfix phases.

In VS Code, open **Singularity Flow → Lifecycle → Attach evidence & designs**. The same action works for the selected Story or Epic and offers:

- Multiple files, including images, PDFs, Markdown, Office documents, and design assets.
- A complete Figma export folder. Story uploads preserve it as one governed package; Epic intake pins its regular files in deterministic order.
- A Figma design URL or another HTTPS reference. Links are recorded without following them and no Figma credential is stored.

The target is always shown before the write. Singularity Flow then uses the existing CLI transaction to validate the phase, copy or catalog the evidence, calculate hashes, commit, and push. The new stable document/source IDs appear immediately under Lifecycle after refresh. The equivalent Copilot command is `/sf-upload`.

GitHub Copilot CLI can also load the bundled experimental Documents extension. Enable experimental features with `/experimental on`, start a fresh session, then use `/documents` for a searchable canvas or `/documents view PHASE-DESIGN` to open a specific artifact. The extension embeds a fresh document snapshot directly in the canvas; run `/documents` again after generating or uploading files to reload it. Hosts without canvas rendering automatically fall back to terminal output. Copilot currently does not allow plugins to add another built-in home tab, so the canvas is the supported tab-like document browser.

```bash
# Local documents, screenshots, PDFs, .fig files, or other binary files
singularity-flow documents upload ./brief.pdf ./checkout-wireframe.png

# Complete exported design package; imported recursively in stable path order
singularity-flow documents upload ./figma-export --kind figma-export

# External Figma or design link (recorded, not downloaded)
singularity-flow documents upload \
  --url https://www.figma.com/design/example \
  --label "Checkout design"

singularity-flow documents list
singularity-flow documents view DOC-001

# Stop future prompts from using evidence without deleting its audited bytes
singularity-flow documents detach DOC-001 --reason "Superseded by the approved design"
singularity-flow documents detach DOC-002 --scope package --reason "Replace the complete Figma export"
singularity-flow documents list --all

# Epic evidence uses the same governed detachment model
singularity-flow epic sources detach SRC-001 --epic MOB-100 --reason "Source withdrawn by Product"
singularity-flow epic sources list --epic MOB-100 --all
```

Every uploaded file receives a stable `DOC-nnn` identifier, content hash, MIME type, original filename, phase, human actor, and governed agent. Directory imports preserve the package name and relative source path for every discovered regular file; symbolic links are rejected. Upload creates and pushes one atomic work-item commit. Text evidence is embedded in governed Copilot prompts up to the pinned preview-byte limit. Images, PDFs, `.fig`, and other binaries contribute a verified repository path, MIME type, byte count, and SHA-256 so Copilot can inspect them with its file/image tools without base64 token inflation. Live Figma links remain external references and are never fetched automatically.

Detachment is also an atomic commit/push decision. It requires a reason, retains the governed bytes and an append-only hash-addressed decision record, excludes the evidence from later prompts, and reopens only phases whose recorded compositions depended on it. Default catalogs show active evidence; `--all` includes detached history, actor, and reason. VS Code exposes the same operations under **Lifecycle → Manage evidence & designs**, including file-level and complete-package Figma detachment.

## Generate a phase

Copilot users normally invoke the appropriate skill, for example:

```text
/sf-phase
```

The skill combines its phase contract with the active governed agent and verified repository grounding. The equivalent deterministic CLI sequence is:

```bash
singularity-flow wm compose --phase intake --task "Capture the requested change"
# If instructed, first build with the same phase and exact task text.
singularity-flow prepare intake
# Fill the generated template.
singularity-flow phase publish intake
singularity-flow submit
```

`phase publish` validates phase write scope and the required artifact, adds managed metadata, updates state, commits `[WORK-ID][phase:<id>][generated:<n>]`, and pushes the work-item branch. After publication succeeds, it displays every published document with its path, hash, and text content so the generated result can be reviewed immediately. Source-code formats such as Java, JavaScript, TypeScript, Python, Go, and shell scripts are rendered as text. Because Copilot can collapse Shell output, the bundled lifecycle skills reload the phase as JSON and reproduce each exact text artifact between visible `BEGIN`/`END` markers in the assistant response. Submission and every later decision are separate atomic commit-and-push operations.

Artifacts live under:

```text
singularity/work-items/<WORK-ID>/artifacts/<phase>/
singularity/work-items/<WORK-ID>/inputs/DOC-nnn/<filename>
```

Managed metadata records the work type, phase, generation, human actor, governed agent, source/config/template hashes, token usage, commit information, and approval history. Do not edit `workflow.json`, `STATUS.md`, approval records, or the managed metadata block manually.

Lifecycle commands normally follow `prepare/edit → publish → submit → approve/reject`. Named sequence gates in `singularity/workflow.yml` are independently configurable as `hard` or `soft`, globally and per work type. Hard gates exit with code `2` before mutation. Soft gates show the same state, reason, and exact next command, then require a human to type `continue`; non-interactive use stops safely. Confirmed exceptions are attributed to the authenticated identity and selected governed agent, recorded in workflow history and artifact metadata, and exposed in status, reports, and governance warnings. Missing gate configuration defaults to hard, and the resolved policy is immutable for each work item. See `singularity-flow help sequencing` for all gate IDs and an example.

## Approved phase inputs

Starter repositories use `inputsMode: enforce` and connect the full feature, bugfix, chore, and Figma-mobile phase chains. Existing repositories with no key resolve to `off`. Each work item pins its mode and normalized input declarations at creation. In the feature profile, implementation receives both the approved design and approved implementation specification directly; either being missing, unapproved, or hash-mismatched blocks preparation and publication.

```yaml
inputsMode: enforce
phases:
  design:
    inputs:
      - requirements
      - phase: intake
        optional: true
        maxBytes: 16384
```

Use `singularity-flow inputs design --dry-run` to inspect provenance without writing, or `/sf-inputs` in Copilot. Normal preparation writes a managed artifact block and `context/inputs-design-gen<n>.json`; publication recollects inputs and the gate verifies approved hashes and rendered-block freshness.

## Human clarification checkpoints

Copilot clarification is configured per phase and is pinned with the work item. It is part of the exact prompt produced by `wm compose`, after the active phase contract and before agent/world-model evidence:

```yaml
phases:
  requirements:
    clarification:
      mode: required       # off | when-needed | required
      maxQuestions: 5
      topics: [scope, acceptance criteria, dependencies, constraints, risks]
```

- `off` adds no interactive checkpoint.
- `when-needed` asks only when governed sources, approved inputs, and the world model leave a material ambiguity.
- `required` always pauses for at least one human response. If the evidence appears complete, Copilot asks the contributor to confirm its concise interpretation instead of silently continuing.

The starter workflows use `required` from initial intake through Design and specification creation (including bug-fix and mobile-design equivalents), then `when-needed` during implementation, verification, and conformance. Copilot asks one concise batch through `ask_user`, waits, and records the human response against the exact prompt and prospective generation before it authors. It incorporates confirmed answers as artifact decisions and leaves only explicitly deferred, non-blocking items under Open questions. If questions cannot be asked or recorded, the skill prints them and stops. The CLI never guesses an answer.

```bash
singularity-flow clarification record requirements \
  --question "Is this outcome and scope correct?" \
  --answer "Yes; exclude historical migration."
singularity-flow clarification status requirements
```

For a batch, pass `--response-file responses.json`. A model-assisted publication in a `required` phase fails when the response record is missing, bound to an older prompt/generation, or contains a material unresolved decision. Explicit `--authored human` work remains the intentional manual path and does not claim that Copilot asked questions.

## Token usage

With installer-managed Copilot telemetry, `prepare` opens a generation capture window. Copilot exports a chat span only after the response finishes, so `phase publish` may initially mark the current generation `pending`. The next `submit` or `/sf-next` invocation automatically reconciles the completed span in its own commit and push before submission. The sanitized record is committed under the work item:

```text
singularity/work-items/<WORK-ID>/telemetry/<phase>-gen<N>.json
```

For another provider, or when supplying a trusted external usage record, pass it explicitly:

```bash
singularity-flow phase publish implementation --usage-json usage.json
```

The JSON may contain provider, model, input, output, cached-input, total tokens, start/end timestamps, provider cost, and collection source. When Copilot does not expose exact values, the committed record is explicitly marked `unavailable`; the CLI never estimates silently. Reports identify the provider/model for every phase and aggregate token records by model as well as phase and governed agent.

Workflow reports prefer the exact provider cost emitted by Copilot telemetry. When provider cost is absent, they can calculate cost from exact usage and optional prices configured by exact model name. Rates are currency units per million tokens; no fallback prices are bundled because provider pricing changes over time:

```yaml
tokens:
  mode: exact-or-unavailable
  pricing:
    provider-model-name:
      input: 3
      output: 15
      cachedInput: 0.3
```

Missing usage or pricing remains visibly `unavailable`; a mixture of priced and unpriced records is labeled `partial`.

Diagnose the local exporter or explicitly retry a delayed generation with:

```bash
singularity-flow telemetry status
singularity-flow telemetry reconcile implementation
```

`telemetry status` shows whether this Copilot process inherited the file exporter, the repository trace path and byte count, completed chat spans, and pending generations. Reconciliation never commits raw traces—only the sanitized phase record.

## Approval and governed change requests

From a terminal:

```bash
singularity-flow approvals ENG-142
singularity-flow approve design --work-id ENG-142 --fetch
singularity-flow reject design --work-id ENG-142 --fetch --to requirements --reason "Failure behavior is missing"
singularity-flow reopen ENG-142 --fetch --to implementation --reason "Production feedback requires a safer rollback"
```

`approvals` is read-only. It shows each phase beside the governed document or artifact-set members
being approved, the pinned authority groups and threshold, the current approvers, and what remains.
The `approval-chain` alias returns the same view. Add `--json` to inspect invalidated earlier
decisions without counting them as current approvals.

Approval first verifies the reviewer’s Git/GitHub identity against the phase authority groups, activates the phase agent, shows artifact hashes, checks, token usage, prior approvals, and any self-approval warning, and requires the phase name as confirmation. When Copilot lacks persistent shell stdin, `/sf-approve` collects that exact confirmation with a one-time receipt and runs the same approval itself; it never uses `--yes`. Multi-approval thresholds require distinct human identities. A phase may additionally declare `requiredAuthorities`; in that case the threshold is not reached until every named functional group has supplied a matching decision.

Every individual approval is an atomic lifecycle decision: it updates the decision ledger and workflow state, creates its own `[WORK-ID][phase:<id>][approve] <authority-group>` commit, and pushes that commit before reporting success. This also applies to approvals that do not yet satisfy a multi-approval threshold. A failed push retains the local commit and blocks further decisions until `singularity-flow sync` succeeds.

Only a Git/GitHub identity matched to one of the phase's configured `approvalAuthorities` may decide a phase. The active governed agent is recorded as prompt/audit context but never grants permission. If the authenticated generator and approver are the same person, the approval is allowed when policy permits but is visibly recorded as `selfApproval: true`; it is never represented as independent review.

Requesting changes may target only a phase listed in the deciding phase's `rejectTo` policy. While a phase is awaiting approval, `reject` reopens that target. After a Story is complete, `reopen` uses the final phase's same policy. Both create a structured `CR-nnn` record containing the exact comment, requester identity, authority group, governed agent, source artifact hashes, target phase, timestamp, and invalidated approval cone. Prior artifacts and decisions remain in Git history.

Open requests appear in `STATUS.md`, the VS Code Lifecycle tree, and the next governed Copilot prompt for the reopened phase. A new generation does not silently close the request: it becomes resolved only when the reopened phase is approved, with the resolving generation and artifact hashes recorded.

The behavior is configurable per phase:

```yaml
approval:
  authorities: [product-approvers]
  minimum: 1
  rejectTo: [requirements, design, implementation]
  changeRequests:
    commentRequired: true
    reopenCompleted: true
```

## Publication and recovery

With `git.publish: required`, generation and lifecycle commands are successful only after a normal fast-forward push. If a push fails, the local commit is retained and an untracked work-item publication sidecar is marked pending. Further transitions are blocked until:

```bash
singularity-flow sync
```

`sync` retries the existing commit without rewriting history. Optimistic branch-head checks prevent concurrent decisions from silently overwriting each other.

For isolated tests only, `git.publish: off` disables remote publication. Do not use it when Git is the state-transfer channel.

## Implementation specification and conformance

Feature work includes an `implementation-spec` after design. It uses stable `SPEC-nnn` identifiers mapped to approved `AC-n` acceptance criteria and captures APIs, schemas, affected files/components, security, observability, migration, and test expectations. Bugfixes use the smaller `fix-spec` template with the same identifiers.

The final `conformance` artifact compares every approved `AC-n` and `SPEC-nnn` with exact source/test file-and-line evidence. Each item must be classified as `matched`, `partial`, `missing`, `deviated`, or `unplanned`. Approved deviations and all self-approvals are disclosed. The report stores a source/test tree hash; later code changes make it stale and fail the gate.

```bash
singularity-flow gate --terminal
```

The deterministic gate checks profile/template snapshots, remote publication, artifact integrity, governed agents, human identities, authority groups, approval thresholds, rejection cascades, AC/SPEC traceability, conformance freshness, and protected workflow/template/agent/skill files.

## World model

Large monorepos do not need a repository-wide world model. In **Configuration
Center → World model**, or in `singularity/workflow.yml`, set repository-relative
`sourceRoots` plus any `sharedRoots`. A capability may pin a narrower scope;
child application roots replace the parent scope while shared roots accumulate.
New lifecycle state pins that resolution so an active Story does not drift when
the capability map changes.

For new workspaces, **Map a capability** can select a `blobless` or
`blobless-sparse` clone. Sparse mode always retains `singularity/` and
`.github/agents/`, and its default `refuse` fallback prevents a Git server that
ignores filtering from silently downloading the full monorepo. Scope and clone
policy are separate: scope decides what the model sees; sparse checkout decides
what is materialized locally.

```bash
singularity-flow doctor --performance --offline
singularity-flow doctor --performance --json
```

This explicit read-only benchmark reports total versus scoped files, warm Git
status and fingerprint timings, sparse/partial-clone state, and recommendations.
It never changes Git configuration. Ordinary Home and doctor reads do not run
the benchmark.

## Fault intake and governed repair

Anything may report that it is broken; only pinned policy decides what happens
next. Fault intake stores sanitized, content-hashed evidence below the
repository Git directory, so reporting a test, build, IDE, CI, staging, or
production failure never dirties application source.

```bash
# Wrap a local command and record any non-zero result.
singularity-flow run --repair-on-fault -- npm test

# Or record an external build failure.
singularity-flow fault report --source ci --environment ci --type unit-test \
  --build 1842 --commit 81ac012 --command "npm test" --exit-code 1 \
  --log artifacts/test.log --idempotency-key payment-build-1842

singularity-flow fix FLT-... --diagnose-only
singularity-flow fix FLT-... --plan-only --allow-path src/payment \
  --verify-argv '["npm","test","--","payment"]'
```

Node integrations use the same kernel without parsing terminal output:

```js
import { createSflow } from 'singularity-flow/src/api.mjs';
const sflow = createSflow({ root: process.cwd() });
const fault = await sflow.fault.report(envelope);
const repair = await sflow.repair.request({ faultId: fault.faultId, mode: 'policy-decides' });
```

Local and IDE execution defaults to guided repair, while CI and staging execution defaults to proposal only.
An authorized local review of a CI proposal creates a new immutable plan generation rather than editing the CI plan.
Production and security faults remain diagnosis-only. Requirement, policy, and architecture faults
remain `challenge-required` until a separate governed ceremony creates a durable challenge or
amendment record; selecting Fix again joins the same unresolved repair.
`--auto` cannot raise that ceiling. A guided repair
creates a local isolated `sflow/repair/*` branch only after the human confirms
the exact plan hash. Diagnostic path observations never become mutation authority; at least one
explicit bounded `--allow-path` is required. Candidate patches enter through `repair attempt`; the
kernel checks every path before applying them and runs the complete pinned
verification set as exact argv without a shell in a disposable verification worktree with a scrubbed
environment. Direct publication, remote Git, shell, deployment, and destructive verifier commands are
refused. macOS sandboxing or Linux Bubblewrap also denies network and external writes when a real
probe succeeds. Runtime and library files on the host remain readable, so plans state
`host-read-permitted` and require maintainer-reviewed verifiers rather than claiming full host
isolation. The result records the boundary used. It never pushes, approves, merges,
releases, deploys, or edits production.

In Copilot use `/sf-fault` and `/sf-fix`. In VS Code unresolved faults appear in
**My Work** with **Fix this** and **Diagnose**. All surfaces call the same records
and kernel functions. See `singularity-flow explain fault-intake-and-repair`.

For the smallest and lowest-token validated model, run this from the
application repository:

```bash
sflow-wm-minimal
# Use only the views required by one phase
sflow-wm-minimal --phase design
# Build another existing branch and publish normally
sflow-wm-minimal --branch WORK-123 --publish
```

The minimum wrapper uses deterministic `light` mode, one `development` view
when no phase is supplied, and `--local` by default. It calls no AI model and
therefore consumes **zero model tokens**. The result still has the validated
world-model structure, source-tree hash, freshness checks, Git commit, and
normal prompt-injection routing. Its content is intentionally limited to a
compact path/build-manifest inventory; it does not claim source behavior,
architecture, security, or impact analysis. Add `--publish` for the configured
publication policy. From a source checkout the equivalent command is
`npm run wm:minimal`, which works on Windows as well as macOS and Linux. (The
underlying `scripts/worldmodel-minimal.sh` needs a POSIX shell; the wrapper finds
one, including a Git for Windows install, and says so plainly when it cannot.)

```bash
singularity-flow wm light --local
singularity-flow wm light --phase design --local
singularity-flow wm light --branch WORK-123 --phase implementation --local
# Equivalent spelling for configuration and automation
singularity-flow wm build --depth light --phase design --local
```

Use `--parallel --workers 2` with `sflow-wm-minimal` only when you deliberately
want to upgrade to a semantic `quick` build with independently checkpointed
model calls.

```bash
singularity-flow wm build --phase design --task "Design invoice export"
singularity-flow wm build --branch release/2026.07 --phase design --task "Ground the release branch"
singularity-flow wm build --phase verification --workers 4
# After an interruption, rerun the identical command; completed views are reused
singularity-flow wm build --phase verification --workers 4 --resume
singularity-flow wm status --phase design --task "Design invoice export"
singularity-flow wm availability --phase design --task "Design invoice export"
singularity-flow wm ensure --phase design --task "Design invoice export"
singularity-flow wm check --branch release/2026.07
singularity-flow wm compose --phase design --task "Design invoice export" --dry-run
singularity-flow wm compose --phase design --task "Design invoice export"
singularity-flow wm show-prompt
singularity-flow wm check
# Remove worktrees left by a killed semantic build; --force also removes unowned legacy worktrees
singularity-flow wm cleanup
singularity-flow wm cleanup --force
```

`wm status` and its `wm availability` alias are read-only: they resolve the exact core/view tiers for the phase and report ready, missing, stale, conflicting selections, governed state-branch authority, resolved ref/commit/tree, and refresh status without invoking a model. `wm ensure` is the explicit materialization boundary. It reuses every valid selection from the same repository source snapshot, generates only missing selections, validates the merged v3 manifest, and publishes the completed model to the configured governed state branch before prompt composition can use it. A changed source snapshot never reuses older semantic output.

`wm light` deterministically reads Git paths plus bounded package-manifest metadata and never launches Copilot. `wm build` with `quick`, `standard`, or `deep` runs the semantic model generator in a detached analysis worktree, rejects writes outside its isolated output, validates every manifest entry, records a repository source-tree hash, commits the model, and follows the configured Git publication policy. When a semantic phase requests multiple views, view-scoped read-only discovery workers run concurrently (four by default), write private bounded packets, and feed one final synthesizer. Each completed packet is checkpointed immediately under `singularity/world-model/.checkpoints/`. If the command fails or is stopped, rerun the same command (or add the explicit `--resume` flag): exact source/prompt/options matches are reused and only pending or invalid views run again. `--no-resume` discards the matching checkpoint and rebuilds every view. A successful validated installation removes the checkpoint automatically. Packet ordering, validation, installation, commit, and push remain single-owner operations. Use `--workers N`, `--no-parallel`, or the `worldModel.generation` YAML policy to tune semantic generation. Work-item lifecycle commits, checkpoints, and the model commit itself do not make the model stale; repository source/configuration changes do.

To remove the separate `wm light` step from a Story, configure the lifecycle in
`singularity/workflow.yml`:

```yaml
worldModel:
  materialization:
    mode: on-demand
    depth: light
    confirmation: automatic
    publish: governed
    lookahead: none
```

When `singularity-flow next` reaches a missing or stale model, this runs the deterministic equivalent of `singularity-flow wm light --phase <current-phase>`, publishes it, composes the phase grounding, and continues. It invokes no model provider and records zero model tokens. Set `confirmation: prompt` to ask first. Set `depth: phase` to generate the phase's exact semantic depth; that mode may invoke a provider and therefore cannot use `confirmation: automatic`. Use `mode: explicit` to retain the manual command or `mode: disabled` to prohibit materialization. Read-only status, availability, reporting, and VS Code refresh operations never materialize a model under any mode. The resolved policy is pinned into the Story at start.

Semantic world-model runners are trusted local command execution, not an OS sandbox. The detached worktree isolates Git output, but the configured runner still executes through the user's shell and inherits that user's environment, filesystem, network, and process permissions. Configure semantic runners only from trusted repository configuration and trusted executables. Use `wm light` when deterministic, zero-agent inventory is sufficient or when arbitrary local runner execution is not allowed.

Every semantic build records an owner/PID beside its isolated worktree. The next build automatically removes worktrees whose owning process is no longer alive. `wm cleanup` performs the same recovery explicitly; it preserves active and unowned legacy worktrees, while `wm cleanup --force` removes those too after you have confirmed no build is running.

`wm light`, `wm build`, `wm availability`, `wm ensure`, `wm check`, and `wm context` are repository operations and never
require an Epic, Story, or work ID. Add `--branch <name>` to target any existing
local or remote branch. Singularity Flow fetches the selected remote, opens the
branch in an isolated worktree, and leaves the active checkout unchanged. It
refuses divergent branches or branches already checked out elsewhere rather
than overwriting work. Use `--remote <name>` when the branch is not on `origin`.

`wm compose` is the single phase entry point. It combines the active governed Agent Markdown, mandatory phase and agent-added views, the exact task guide, applicable evidence, rule-selected files, and locked remote agent skills. `wm inject` remains an alias for compatibility. Rules can match the governed `agent` ID, phase, immutable work type, committed or pending changed paths, and source labels.

Use `/sf-show-prompt` at any active Story phase to display the complete
`/sf-phase` `SKILL.md` followed by the exact rendered governed phase prompt.
The inspection uses `--render-only`: it does not create a grounding record,
prepare an artifact, edit workflow state, commit, or push. Pass
`--skill sflow-design` (or another installed Flow skill ID) to inspect that
skill contract with the same current-phase prompt.

For an opt-in, workspace-local history of the governed prompts actually composed for Copilot, use
`/sf-prompt-log on` (or `singularity-flow prompt-log on`). Review records in VS Code under
**Configuration → Prompt audit**, or run `singularity-flow prompt-log list` and
`singularity-flow prompt-log view latest`. Capture is off by default and never includes Copilot's
hidden system prompt or chat history.

Non-dry-run composition writes both a JSON provenance record and the exact rendered prompt under the work item's `context/` directory. With `worldModel.grounding: enforce` (the starter setting), generation cannot publish until the committed model, source hash, required views, file hashes, manifest, agent, and prompt snapshot verify. The selected mode is pinned when the work item starts. Use `warn` for an adoption period or `off` to disable the grounding gate. This development release accepts only current state schemas; recreate old work with `factory-reset`.

## Remote Markdown agents

agents under `.github/agents` or the plugin's `agents/` directory may declare public HTTPS Markdown skills, templates, and generated outputs in exact dependency tables. Singularity Flow presents these files as agents because they are context, not people, agents, or approval authorities.

### Configure a repository agent

Create an agent Markdown file in the lead repository at
`.github/agents/<agent-id>.agent.md`. Agent and dependency IDs must use
lower-case kebab-case.

For example, create `.github/agents/architecture.agent.md`:

```markdown
---
name: architecture
description: Architecture agent with governed remote Markdown dependencies.
---

# Architecture agent

Review requirements, architecture, security, operability, and implementation
boundaries.

## Remote skills

| ID | URL | Phases | Optional | Max bytes |
|---|---|---|---|---|
| secure-design | https://example.com/agents/secure-design.md | design,implementation-spec | false | 262144 |
| api-review | https://example.com/agents/api-review.md | design | true | 262144 |

## Remote artifact templates

| ID | URL | Phases | Optional | Max bytes |
|---|---|---|---|---|
| design-template | https://example.com/templates/design.md | design | false | 262144 |

## Remote generated artifacts

| ID | URL template | Phase | Target | Optional | Max bytes |
|---|---|---|---|---|---|
| threat-model | https://example.com/output/{workId}/{generation}/threat-model.md | design | artifacts/design/threat-model.md | true | 1048576 |
```

The headings, column names, and column order are exact. Use comma-separated
phase IDs; `*`, `-`, or an empty value means all. The enclosing agent already
defines the agent scope. `Optional` accepts
`true` or `false`. The default size limit is 1 MiB and the hard ceiling is
10 MiB.

Remote resources must be non-empty UTF-8 Markdown available through public
HTTPS without embedded credentials, cookies, or authorization headers.
Generated-output URLs may use only the URL-encoded `{workId}`, `{workType}`,
`{phase}`, and `{generation}` variables. Their targets must be Markdown paths
under the declared phase's `artifacts/<phase>/` directory. Links outside these
three dependency tables are treated as ordinary prose and never fetched.

### Trust and activate the agent

Run these commands from the repository root:

```bash
singularity-flow agents list
singularity-flow agents lock architecture
singularity-flow agents sync architecture
singularity-flow agents status architecture
```

The first lock operation displays the pack source and dependency hashes and
requires typing the exact pack name. It writes `singularity/agents.lock.yml`.
Review, commit, and push that file so every contributor uses the same trusted
content.

`agents sync` never changes trust. It verifies the committed lock, caches the
Markdown atomically under `.git/singularity-flow/`, and makes the pack active
for the local session without changing the selected governed agent. Matching remote
skills are then added to the normal prompt composition:

```text
phase contract and template
+ selected governed-agent prompt
+ repository world model
+ active agent skill Markdown
+ approved phase inputs
```

Remote skills are pack-scoped prompt context; they do not become global slash commands and cannot approve.

### Automatic Copilot-agent mapping

When Copilot starts a custom agent, its `subagentStart` event includes the
selected agent name. Singularity Flow first checks the committed optional
mapping file `singularity/agent-mappings.yml`, then falls back to an exact ID
match against repository agents in `.github/agents` and the bundled plugin
agents:

```yaml
version: 1
mappings:
  enterprise-architect: architecture
  mobile-delivery-agent: mobile-delivery
```

The YAML keys are Copilot custom-agent IDs and the values are discovered
Singularity Flow agent IDs. Inspect the effective routing with:

```bash
singularity-flow agents mappings
```

A resolved
local-only agent, or a resolved
locked pack whose bytes are already verified in the local cache, becomes the
active session agent automatically. The current work-item binding and
governed agent are preserved.

The hook never downloads content or establishes trust. An unlocked, changed, or
uncached remote pack remains inactive and Copilot receives the exact
`agents lock`, `lock --update`, or `sync` command to show the contributor.
An unrelated Copilot agent has no effect. Invalid mappings and unknown target
packs fail validation instead of silently selecting another pack. agents
remain instructions and context—not a human identity, governed agent, or approval
authority. Edit the mapping visually in VS Code **Configuration → Agents &
delivery** or commit the YAML normally so every contributor receives the same
routing.

### Use a remote artifact template

A remote template replaces a workflow template only through an explicit
reference in `singularity/workflow.yml`:

```yaml
workTypes:
  feature:
    templateOverrides:
      design: agent:architecture/design-template
```

When a work item uses the template, Singularity Flow copies it into committed
work-item context and pins its hash in workflow resolution. Later URL changes
therefore cannot silently alter active work.

### Update or refresh remote content

Agent-file or dependency changes require a deliberate lock update:

```bash
singularity-flow agents lock architecture --update
singularity-flow agents sync architecture
singularity-flow agents status architecture
```

Inspect the old and new hashes, type the exact agent name, and commit and push
the updated `singularity/agents.lock.yml`.

Dynamic generated output is fetched once for the prospective generation and
then reused. Refresh it deliberately when its remote result changes:

```bash
singularity-flow agents refresh-output threat-model
# Use --replace only when intentionally discarding local edits.
singularity-flow agents refresh-output threat-model --replace
```

VS Code **Configuration → Agents & delivery** provides the same lifecycle visually:
edit the three structured resource tables, map native Copilot agent names, inspect
per-resource hashes and cache state, open the exact trust/update confirmation in an
integrated terminal, and sync locked content. Authenticated private Git,
Artifactory, cookie, and bearer
token downloads are not supported in this delivery. See
[HELP.md](HELP.md#remote-agent-markdown) for lifecycle and integrity details.

### Where remote skills and templates are managed

Remote Markdown has two storage planes so trust is shared while downloaded bytes
remain local until a work item actually uses them:

| Item | Managed in | Lifecycle |
|---|---|---|
| Dependency declarations | `.github/agents/<agent-id>.agent.md` | Edited and reviewed like repository code. Only the three exact Markdown tables are active. |
| Trusted hashes | `singularity/agents.lock.yml` | Created or changed only by `agents lock`; commit and push it for the team. |
| Verified download cache | `.git/singularity-flow/agents/` | Created by `agents sync`; machine-local, disposable, and never authoritative. |
| Skill snapshot used by one generation | `singularity/work-items/<WORK-ID>/context/agent-snapshots/` | Copied and committed with the generated phase so later remote changes cannot rewrite history. |
| Skill audit record | `singularity/work-items/<WORK-ID>/context/agents-<phase>-gen<N>.json` | Records agent, URL, hash, size, phase, and generation. |
| Template snapshot used by a work item | `singularity/work-items/<WORK-ID>/context/agent-templates/` | Copied when the work item starts and pinned in `workflow.json`; active work never follows a changed URL. |

The safe operating sequence is therefore **declare → lock → review and commit →
sync → start work**. `sync` cannot update a trusted hash. A changed remote file
stops with a stale-lock error until a contributor runs `agents lock <id>
--update`, reviews the hash change, confirms the exact agent ID, and commits the
new lock. Remote templates are inert unless a workflow explicitly names
`agent:<agent-id>/<template-id>`.

### Governed MCP tools such as Playwright

MCP servers are host capabilities, not remote Markdown. VS Code or Copilot CLI
owns their process, transport, trust prompts, and credentials. Singularity Flow
adds the governed layer: `mcpServers` in `singularity/workflow.yml` assigns a host
server to explicit agents, phases, and tool names; the Agent Markdown `tools`
field permits the corresponding `server/tool` or `server/*` namespace; phase
prompt composition includes the resulting policy.

```bash
singularity-flow mcp scaffold playwright  # merge-safe, exact package version
singularity-flow mcp scaffold figma       # remote Figma MCP; add --local for desktop
singularity-flow mcp status
singularity-flow mcp doctor
singularity-flow mcp attest figma --confirm figma
```

VS Code exposes a complete policy editor, joined host status, and the same safe
scaffold under **Configuration → MCP tools**.
The **Visual Assurance** dashboard is available from Lifecycle, Inbox, and the
Configuration Center. It presents approved design-source versions, deterministic
design inventory, viewport coverage, implementation captures, comparison/diff
evidence, and MCP provenance in one review surface. Opening or refreshing the
dashboard performs no network access; network diagnostics, server warm-up, and
remote evidence capture are separate, explicitly confirmed actions.
Recorded PNG comparisons can be inspected inline as side-by-side, overlay-slider,
or deterministic diff views. The cards retain the exact approved, implementation,
and diff hashes. Candidate versions never replace the approved source silently,
and host readiness can be attested only after exact server-name confirmation.
When a reviewed candidate should become the new baseline, use the explicit
**Promote** action in Visual Assurance or run `singularity-flow mcp
design-sources promote <record-id> --confirm <record-id>`. Promotion is an audited
publication: it reopens design intake, invalidates that phase and its downstream
approvals, and pins the chosen record for the next capture generation.
Corporate npm registry, proxy, and CA configuration continue to come from
`.npmrc`, environment variables, and the host. Durable screenshots or reports can
be hash-recorded with `singularity-flow mcp record` and are revalidated by the
governance gate. For `figma-mobile`, design-intake publication creates a deterministic
source set and approval binds that exact set; downstream prompts receive its verified
metadata and hashes rather than silently following the live file. See
[Governed MCP tools](docs/MCP-INTEGRATION.md) and
[Mobile model intake](docs/MOBILE-MODEL-INTAKE.md) for the complete security and
evidence workflow.

## Useful commands

| Command | Purpose |
|---|---|
| `sflow-about` | Describe the Singularity Flow product, version, capabilities, and `sflow-` namespace. |
| `singularity-flow init` | Install editable YAML, templates, agent prompts, and world-model builder prompt. |
| `singularity-flow factory-reset --dry-run` | Preview a destructive reset of repository Singularity state and local runtime data before reinstalling current npm-package defaults. |
| `singularity-flow local-reset --forget-only --dry-run` | Preview clearing this machine's Singularity registrations, caches, sessions, credentials, and personalization while preserving every workspace and repository byte. |
| `singularity-flow local-reset --dry-run` | Preview destructive removal of every validated local workspace and machine state while preserving installed product surfaces. |
| `singularity-flow start <ID> --from-branch BRANCH [--jira \| --story-file FILE] [--work-type ID] [--ref BRANCH]` | Require an explicit published remote base, verify the configured remote before mutation, and create/push only the canonical Story branch. Non-interactive callers must also pass `--work-type`; `--base` remains a standalone-repository compatibility alias. The Story branch defaults to the Work ID; `--ref` decouples its name. |
| `singularity-flow choices begin\|answer\|status` | Bridge explicit Copilot start and approval choices through a short-lived one-time receipt when persistent terminal stdin is unavailable. |
| `singularity-flow resume <ID\|BRANCH> --fetch` | Resolve the Work ID/canonical-branch binding, fast-forward it, and activate the current phase agent. |
| `sflow-agent [ID]` | Select or change the prompt-only governed agent for the current local work-item session. |
| `singularity-flow session candidates` | Fetch and list committed remote work-item branches available for session attachment. |
| `singularity-flow session workspace <WORKSPACE> [--repository ID] [--story ID]` | Attach session context to a saved workspace from any directory and return the exact governed repository/host handoff. |
| `singularity-flow session attach <ID>` | Safely fast-forward to the exact remote work-item head and activate the current phase agent. |
| `singularity-flow session status` | Inspect work-item and agent binding readiness for the current Copilot session. |
| `sflow-inbox [--offline] [--json]` | Fetch and list committed remote phases awaiting approval; equivalent to `singularity-flow inbox`. |
| `singularity-flow status [ID]` | Show phase, governed agent, artifacts, human approvals, usage, and warnings. |
| `singularity-flow approvals [ID]` | Show the ordered phase approval chain with governed document names, authority groups, thresholds, and recorded approvers. Use `--json` to include invalidated decision history. |
| `singularity-flow progress [ID]` | Show deterministic completion percentage and phase/approval progress. |
| `singularity-flow report [ID] [--format md\|html\|json]` | Derive wall-clock timing, approval latency, rework, token, cost, and bottleneck metrics. |
| `singularity-flow guide [ID]` | Explain the selected workflow template and show the exact next valid skill and CLI command. |
| `singularity-flow guide --first-run [--keep]` | Run a disposable, zero-model, zero-network quick-fix lifecycle and clean it up after success. |
| `singularity-flow nextsteps [ID]` | Show ordered `NOW`, `THEN`, and `ALTERNATIVE` actions without changing state. |
| `singularity-flow action plan [STORY-OR-INITIATIVE]` | Create a short-lived action plan bound to subject kind, branch, HEAD, index, working-tree, and lifecycle hashes. |
| `singularity-flow action authorize <PLAN-ID> --action <ACTION-ID> --confirm <ACTION-ID>` | Record one short-lived, machine-local authorization after reviewing that exact action. |
| `singularity-flow action execute <PLAN-ID> --action <ACTION-ID> --authorization <TOKEN>` | Revalidate and run one reviewed action directly through the engine. The token is consumed once; read-only actions omit it. |
| `sflow-next [--task TEXT] [--yes]` | Execute exactly one next valid action; alias for `singularity-flow next`. If a semantic world model is missing, interactive use asks before starting its model agent and non-interactive use requires explicit `--yes`. |
| `singularity-flow inputs [PHASE] [--dry-run]` | Inspect or render approved phase-input dataflow. |
| `singularity-flow agents list\|mappings\|lock\|sync\|status\|refresh-output` | Resolve Copilot-agent mappings and trust, materialize, inspect, or refresh remote Markdown agents. |
| `singularity-flow mcp list\|status\|doctor` | Join governed MCP assignments to host server names and report static readiness without exposing host secrets or making network calls. |
| `singularity-flow mcp scaffold figma\|playwright [--local] [--replace-server]` | Merge one reviewable, exact-version host entry while preserving unrelated `.vscode/mcp.json` servers. |
| `singularity-flow mcp attest <SERVER> --confirm <SERVER>` | Record a machine-local statement that the reviewed host entry was trusted, started, and authenticated. |
| `singularity-flow mcp record <SERVER> --tool <TOOL> [--kind KIND] [--phase PHASE] [--output PATH]` | Copy and hash a declared MCP result into the active work item; Figma design sources also require file key and version. |
| `singularity-flow mcp design-sources status` | Verify and display the exact approved design-source set used by downstream prompts. |
| `singularity-flow mcp design-sources promote <RECORD-ID> --confirm <RECORD-ID>` | Explicitly promote a reviewed candidate, reopen capture, invalidate downstream approvals, and pin it for the next generation. |
| `singularity-flow capabilities doctor [ID] [--offline]` | Verify capability ownership, inherited lifecycle policy, orphan-state publication, ledger integrity, lifecycle pinning, and cross-repository world-model snapshots. |
| `singularity-flow documents list [ID] [--active\|--all]` | List active uploaded inputs and generated documents, or include detached evidence history. |
| `singularity-flow documents view <ID> [--all]` | Display active text content or return the path/URL for a binary/external document; `--all` permits audited detached evidence. |
| `singularity-flow documents upload <FILE-OR-DIRECTORY...>` | Recursively copy, hash, catalog, commit, and push supporting evidence during configured initial phases. |
| `singularity-flow documents detach <ID> [--scope file\|package] --reason TEXT` | Preserve Story evidence bytes, audit the decision, exclude future prompts, and invalidate only dependent phases. |
| `singularity-flow epic sources list --epic <ID> [--active\|--all]` | List active Epic sources or include detached history. |
| `singularity-flow epic sources detach <ID> --epic <ID> --reason TEXT` | Govern and publish an Epic-source detachment with dependency-scoped invalidation. |
| `singularity-flow jira pull <ID>` | Read and normalize one Jira issue using configured REST credentials. |
| `singularity-flow jira assigned` | List incomplete Jira work assigned to the connected Jira user; `jira list` remains an alias. |
| `singularity-flow jira boards\|board` | Discover Jira Software boards and list Stories in active/future sprints with backlog excluded. |
| `singularity-flow jira fields --query <TEXT>` | Discover Jira custom-field IDs for acceptance criteria, points, sprint, or other metadata. |
| `singularity-flow jira status\|projects\|epics\|children\|permissions` | Discover connection, visible hierarchy, and effective project permissions. |
| `singularity-flow jira doctor [--json]` | Diagnose workspace policy, CLI credentials, identity, project access, permissions, boards, and Epic visibility without changing anything. |
| `singularity-flow jira transitions\|transition\|assign\|priority\|sprint\|comment` | Inspect transitions or update one exact Jira Story with mandatory `--confirm <STORY-KEY>`. |
| `singularity-flow initiative jira-adopt <EPIC>` | Preview or adopt a Jira Epic and its children into a Git initiative with repository mappings. |
| `singularity-flow initiative jira-plan` | Create, commit, and push a hash-pinned outbound Jira change plan. |
| `singularity-flow initiative jira-apply --plan <SHA>` | Apply one approved, unchanged plan and commit/push per-operation receipts. |
| `singularity-flow initiative phase [PHASE]` | Compose the governed prompt and prepare text outputs; report exact upload paths for template-less binary bundles. |
| `singularity-flow prepare [PHASE]` | Materialize the resolved artifact template. |
| `singularity-flow phase show [PHASE]` | Display every generated phase document, its review metadata, and text content. |
| `singularity-flow phase publish [PHASE]` | Validate, annotate, commit, and push one generation. |
| `singularity-flow submit [PHASE]` | Run checks and publish an approval request. |
| `singularity-flow approve [PHASE] --work-id ID --fetch` | Verify human authority, activate the phase agent, and record/push the exact-hash decision. Omit `--work-id` for the active Story. |
| `singularity-flow reject [PHASE] --work-id ID --fetch --to PHASE --reason TEXT` | Record a governed change request, reopen an awaiting-approval Story, invalidate downstream state, commit, and push. Omit `--work-id` for the active Story. |
| `singularity-flow reopen [ID] --fetch --to PHASE --reason TEXT` | Return a completed Story to an allowed phase with a governed comment, commit, and push. |
| `singularity-flow cancel [ID] --fetch --reason TEXT --confirm ID` | Stop active work without claiming completion; preserve all artifacts and approvals, commit and push the decision, and show the Story under Archived. |
| `singularity-flow sync` | Retry a pending publication without rewriting the commit. |
| `singularity-flow gate --terminal` | Run the final deterministic/remote-state gate. |
| `singularity-flow pr [ID] [--create]` | Preview the story pull request built from committed governed state; `--create` opens it after typed confirmation. |
| `singularity-flow epic merge-plan [--epic ID]` | Show the dependency-ordered story merge sequence, each story's status, and the next story to merge. |
| `singularity-flow stack status\|sync [--epic ID]` | Inspect or replicate the enforced Story/PR order to each repository's orphan state branch. |
| `singularity-flow refresh-branch [--remote origin]` | Fetch and fast-forward only the checked-out clean branch; stop safely when it diverges. |
| `singularity-flow regression analyze [--good REF] [--bad REF] [--path PATH]` | Rank likely regression commits and merge history without changing the repository. |
| `singularity-flow wm light [--phase PHASE] [--branch BRANCH] [--local]` | Build a compact deterministic repository inventory with zero model tokens, then validate and commit it like any other world model. |
| `singularity-flow wm build [--depth light\|quick\|standard\|deep] [--branch BRANCH] [--local] [--parallel\|--no-parallel] [--workers N] [--resume\|--no-resume]` | Build the repository world model on the current or selected branch; light is deterministic and zero-token, while semantic depths support parallel discovery and exact-match checkpoint resume. |
| `singularity-flow wm cleanup [--force]` | Prune stale owned worktrees left by interrupted world-model builds; `--force` also removes unowned legacy temporary worktrees after operator review. |
| `sflow-wm-minimal [--phase PHASE] [--branch BRANCH] [--publish]` | Build the smallest deterministic zero-token validated model; defaults to one development view and a local commit. |
| `singularity-flow documents browse --provider <ID> [--path FOLDER]` | List items in a configured OneDrive/SharePoint, Artifactory, S3, or HTTPS provider. |
| `singularity-flow documents fetch --provider <ID> --ref <ITEM>` | Materialize provider bytes into the work item's inputs, then commit and publish them. |
| `singularity-flow logs [--level L] [--event P] [--tail N]` | Read the machine-local activity log: commands, hook decisions, and world-model progress, with secrets redacted. |
| `singularity-flow logs path\|level` | Show the log file location, or the effective file and console levels. |
| `singularity-flow logs workspace [--source all\|activity\|prompt\|telemetry\|workspace] [filters]` | Read a newest-first, read-only timeline across only the active workspace's declared repositories. Use `--json` for the versioned envelope. |

An initiative output with `kind: binary-bundle` may omit a text template. Phase preparation reports its exact repository target as `awaiting upload` without fabricating an empty file. Copy the ZIP, image collection, signed evidence package, or other bundle to that path and run the initiative phase command again to hash and register it. Required missing bundles block publication with their expected paths. Downstream Copilot prompts record binary paths, sizes, and SHA-256 values without decoding or injecting the raw bytes.

Initiative repository synchronization reads child workflow state from the exact
fetched commit. Malformed, unsupported, or identity-mismatched child state is
isolated as stale and blocked instead of aborting every repository. Both
profiles enforce the same delivery semantics: Build/Construction requires
blocking stories through verification, and Release/Delivery requires
conformance. Phase approval remains bound to the exact current bundle hash;
dependency invalidation rewinds to the earliest affected phase while preserving
unrelated approved work. Initiative reports combine initiative and child
model/token/cost data without upgrading partial coverage to exact.

## Clean development reset

This development release accepts only the current workflow and state schemas. It does not migrate older repositories or in-flight work. Use `singularity-flow factory-reset` to recreate current configuration and lifecycle state.

## Development and packaging

```bash
npm install
npm test
npm run check
npm pack --dry-run
```

### VS Code extension

The supported visual surface is the VS Code extension:

- **Workspaces** selects local project context and shows the directory, lead
  repository, repository health, Jira routing, metadata, and capability scope.
  Selecting a row stays in the current VS Code window; opening a repository is a
  separate explicit action. The workspace editor changes its display name and
  selects governed capabilities already available in its materialized repository
  boundary. Use Copy workspace when that boundary must change.
- **Lifecycle** owns Story/Initiative intake, workflow selection, the phase rail,
  generated artifacts, progress, checks, submissions, and approvals.
- **Inbox** brings generated Markdown, JSON, YAML, registered evidence, review
  packets, and pending decisions into one business-friendly view. Its portfolio
  dashboard summarizes capabilities, repositories, Jira routes, open work,
  approvals, diagnostics, and world-model health.
- **Lifecycle Analytics** turns the committed Story report into a phase rail and
  business-readable dashboards for completion, elapsed/active/waiting time,
  approval bottlenecks, generations and rework, models, exact-or-unavailable token
  usage, and provider/configured cost. It is a read-only projection, not another
  state store.
- **Configuration** contains the Workflow and Artifact Designers; governed Agent,
  Prompt, Skill, and Prompt Pack Designers; capability mapping; integrations;
  approval policy; and world-model rules. Configuration affects future work;
  active work follows its immutable pinned resolution.

```bash
npm run vscode:typecheck
npm run vscode:build
npm run vscode:package
code --install-extension apps/vscode/singularity-flow-vscode-0.9.0.vsix --force
```

The first-run walkthrough configures the local name and menu persona, Jira through
VS Code `SecretStorage`, a workspace, and intake. The menu persona only reorders
the complete Navigator and seeds first-use Favorites; it never hides commands,
grants authority, or selects an agent. Workflow phases select governed agents. **Open Governed Context in
Copilot** renders the effective skill, agent instructions, prompt pack, world model,
approved inputs, artifact template, and phase contract into native Copilot chat.
Use `/sf-show-prompt` or `sflow wm show-prompt --phase <PHASE>` to inspect the same
composition before authoring.

To summon a reviewer who is not keeping VS Code open, add `teams-webhook` to
`collaboration.notifications` in `singularity/workflow.yml`, then run
**Singularity Flow: Configure Teams Notifications**. VS Code stores the incoming
webhook in `SecretStorage`; terminal-only users may set
`SINGULARITY_FLOW_TEAMS_WEBHOOK_URL`. The URL never enters Git, prompts, telemetry,
or lifecycle records. A notification is sent only after the corresponding commit
and push, and delivery failure is a warning rather than lifecycle authority.

The CLI workspace registry remains canonical. The extension never creates another
workflow or workspace database. See the complete [VS Code guide](docs/VS-CODE.md).
The former Electron application is retired and preserved at
`desktop-final-v0.9.0`; see [ADR 0004](docs/adr/0004-retire-electron-desktop.md).
See [DISTRIBUTION.md](DISTRIBUTION.md) for CLI and VSIX packaging.

Install the personal Copilot plugin with:

```bash
singularity-flow plugin install
copilot plugins list --kind skill
```

The installer removes both the direct installation (`singularity-flow`) and any
existing marketplace installation (`singularity-flow@singularity-flow`), then
installs the plugin bundled with the CLI package. It also creates a complete,
managed copy of every skill under the personal Copilot skills directory using
the shorter `sf-*` names. Personal skills can be invoked directly, so this removes
the plugin namespace from day-to-day commands. Running the command again safely
replaces managed aliases; it refuses to overwrite an unrelated personal `sf-*`
skill.

The default alias directory is `~/.copilot/skills`. Corporate installations may
choose another approved directory, provided Copilot is also configured to scan
that directory through `COPILOT_SKILLS_DIRS` or its `skillDirectories` setting:

```bash
COPILOT_SKILLS_DIRS="/approved/copilot/skills" \
SINGULARITY_FLOW_COPILOT_SKILLS_DIR="/approved/copilot/skills" \
  singularity-flow plugin install
```

Fully exit and restart Copilot CLI after installation so it discovers the new
personal skills.

An organization can publish the same plugin through its own Copilot marketplace:

```bash
SINGULARITY_FLOW_MARKETPLACE_SOURCE="company/singularity-flow" \
  singularity-flow plugin install
```

`SINGULARITY_FLOW_MARKETPLACE_SOURCE` accepts the repository or marketplace
source approved by the organization. When it is absent, installation remains
local and does not contact a personal source repository.

The plugin package remains named `singularity-flow`, while the preferred direct
commands are:

```text
/sf-about
/sf-start ENG-142 --title "Add invoice export"
/sf-agent
/sf-phase
/sf-progress
/sf-nextsteps
/sf-next
/sf-report
/sf-help
/sf-factory-reset
/sf-upload ./requirements.pdf --epic MOB-100
/sf-documents list
/sf-status
/sf-submit
/sf-approve
/sf-reject
/sf-resume ENG-142
```

The `sf-` prefix prevents collisions with generic skills such as `/start`,
`/status`, and `/approve`. Existing `/sf-*` and qualified
`/singularity-flow/sflow-*` invocations remain compatible. After upgrading, run
`singularity-flow plugin install`, close existing Copilot sessions, and confirm
that `copilot plugins list --kind skill` reports `sf-*` personal skills.

See [ARCHITECTURE.md](ARCHITECTURE.md) for invariants and [VERIFICATION.md](VERIFICATION.md) for the release checklist.
