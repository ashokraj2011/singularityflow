# Singularity Flow 0.9.0

The optional [Capability Ledger](./CAPABILITY-LEDGER.md) records high-value Story
and Initiative lifecycle events on an unrelated `state` orphan branch.
Durable work-branch intents let another machine reconcile a missing ledger append
after partial publication.

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
Run `/sf-about` for the installed version and a concise capability summary. The full
`singularity-flow <action>` executable remains a compatible CLI for existing
scripts and documentation.

The package contains:

- A deterministic Node.js CLI (`singularity-flow` or `sflow`).
- A VS Code extension for workspaces, intake, workflow configuration, progress, documents, and approvals.
- A GitHub Copilot plugin with collision-safe skills and a bundled workflow runtime.
- A canonical searchable help manual shared by the CLI, Copilot, and VS Code.
- Editable feature, bugfix, chore, and Figma-export-to-mobile profiles.
- Editable governed-agent prompts and artifact templates.
- World-model grounding, approval auditing, token accounting, and a final spec-to-code conformance gate.
- A no-argument cockpit, repository doctor, guided run mode, portable review bundles, safe recovery, workflow simulation, assignments, and read-only watching.
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
migration path. In Copilot CLI, use `/sflow-init [WORK-ID]`; `/sflow-doctor`
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
and Planning show the exact `/sflow-*` command to run from the open repository,
with one-click copy controls. The installed skill composes the selected phase,
governed agent, repository world model, approved inputs, agent skills, requirements,
and templates inside the user’s normal Copilot CLI session. Refresh the VS Code
Lifecycle view after the skill commits and pushes its result. Epic planning uses pinned Jira and
uploaded source evidence; it does not require a world model. After Story intake
creates the canonical Story branch, repository world-model generation becomes
an explicit CLI or Copilot-skill operation, and its commit is pushed on that Story
branch before phase work begins.

## Capabilities, and the workspaces made of them

What an organisation builds is a tree of **capabilities**. A capability that
names a repository is a leaf that **ships**; one that names no repository
**groups** the capabilities beneath it. The tree has exactly one root and may go
to any depth. Jira projects and team names belong to a capability, not to a
repository and not to a workspace.

The map lives in `singularity/capabilities.yml` in the **lead repository**, with
the repositories it refers to declared in that repository's
`singularity/portfolio.yml`. Editing it checks nothing out: the lead is cloned to
a temporary directory, edited, pushed and discarded.

```
singularity-flow capability map payments-api --lead https://github.com/acme/platform.git \
  --name "Payments API" --kind service --parent payments --repository https://github.com/acme/api.git
```

The first capability mapped into a repository governs it — `singularity/` is
written, the repository is declared in its own portfolio, and the orphan `state`
branch is named, all in the same operation. There is no separate setup step, and
no order in which you need a map before you can make one.

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

```
singularity-flow workspace create --local --id commerce-work \
  --organisation https://github.com/acme/platform.git \
  --capability commerce --lead-capability payments-api \
  --base ~/work --confirm commerce-work
```

Choosing a capability includes everything beneath it, the way choosing a
directory includes its contents — and the selection is recorded rather than its
expansion, so a capability added to the map later is picked up by a workspace
that asked for its parent. No two workspaces may occupy the same directory.
Workspace setup does not require Jira. See [WORKSPACES.md](WORKSPACES.md).

The editor extension exposes both actions from one **Workspaces** view. A saved
workspace is its local directory plus its mapped capability scope; the selected
workspace shows both together beneath the workspace list. **Work here** makes it
the context used by Lifecycle and Configuration. If the extension activated
before any workspace was selected, VS Code reloads that same window once to bind
those views to the lead repository; it never creates another window. **Open lead
repository** remains a separate, explicit action for editing code and is not
required just to select a workspace.

The VS Code sidebar deliberately separates work from setup. **Lifecycle** is the
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

From Copilot, `/sflow-workspaces` lists saved contexts and `/sflow-workspace`
selects one. From a terminal, `singularity-flow workspace copilot <WORKSPACE>`
starts Copilot in the selected repository and names the session for the
workspace; a governed Story branch adds the Story ID. Singularity renders labels
such as `Payments / MOB-123 >` as a context banner because Copilot does not
provide a supported way to replace its own native `>` input marker.

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
    url: git@github.com:company/mobile.git
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
/sflow-initiative-start INIT-2026-001
/sflow-initiative-phase
/sflow-initiative-next
/sflow-initiative-status
```

Starting uses `main` (or the configured default branch) only as the source baseline for the new initiative branch. It does not merge anything into `main`; completed code still follows the repository's normal pull-request and merge process.

### Epic planning is the streamlined default

For a Jira Epic that should end with reviewed Stories, an approved high-level
specification, canonical repository branches, and Product Owner validation,
use the four-phase `epic-planning` profile:

```text
/sflow-epic-start MOB-100
/sflow-epic-sources
/sflow-epic-requirements
/sflow-epic-story-draft
/sflow-epic-publish
/sflow-epic-status
/sflow-epic-next
/sflow-epic-sync
/sflow-epic-drift
/sflow-epic-review
/sflow-epic-review-decision
/sflow-epic-merge-plan
/sf-stack
/sf-refresh-branch
/sf-regression-investigate
/sflow-story-start
/sflow-story-fetch
/sflow-story-checks
/sflow-worldmodel
/sflow-agents
/sflow-telemetry
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
reads it and refuses out-of-order work. One final pull request `MOB-100 → main`
lands the Epic once every blocking Story has merged. Stories in other
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
same entry point is available through `/sflow-story-start`; a Story published
by a governed Epic can still be fetched with `/sflow-story-fetch`. Intake pins
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

In Copilot, `/sf-help` loads the manual for general questions; `/sf-help WORK-123` loads the selected work item's immutable workflow guide. VS Code includes the same manual in the always-available **Help** view and searchable **Help Center**, bundled for offline use. It has focused entries for capabilities, workspaces, Story intake, workflow state, agents, prompts, world-model composition, troubleshooting, every `/sf-*` skill, and every top-level CLI command.

Copilot start, resume, approval, rejection, and governed-agent flows use its
interactive question facility to show the YAML-configured choices. Choose a
label instead of typing a governed-agent or workflow ID. During start or approval, a shell
without persistent stdin uses a short-lived one-time selection receipt, so the
contributor or reviewer can stay in Copilot. If interactive questions themselves are disabled, Singularity
Flow stops rather than choosing a default.

Use `/sflow-nextsteps [WORK-ID]` whenever you need a compact ordered plan. Its CLI equivalent, `singularity-flow nextsteps [WORK-ID]`, works before initialization, without an active work item, during pending publication recovery, throughout every phase, and after completion. It is read-only and marks actions as `NOW`, `THEN`, or `ALTERNATIVE`.

### One-command local update and installation

From a clean clone, update the tracked branch, create the distribution tarball, install it globally, remove any previous Copilot plugin identities, and install one current marketplace plugin:

```bash
./install.sh
```

`npm run install:local` is an alias for the same script.

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

The selected registry is used for both `npm ci` and the global tarball installation. The script rejects credentials embedded in a URL, never prints tokens, and does not modify npm configuration.

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

`singularity/workflow.yml` is the definition for new work items. It contains:

- `workTypes`: profile-specific phase sequences, template overrides, and optional `phaseOverrides` for checks, world-model, comparison, artifact, input, and approval policy.
- `inputsMode`: backward-compatible `off`, audit-oriented `record`, or blocking `enforce` phase dataflow.
- `phases`: default templates, approved upstream inputs, artifact paths, write scope, world-model views, quality commands, and approval rules.
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

Agent mappings connect native Copilot agents to governed Agent Markdown. Each phase activates its configured default agent automatically; `/sflow-agent` is an explicit, audited override. An agent changes instruction context only and can never grant approval permission. Phase approvals reference `approvalAuthorities`; every decision records the human identity, matched authority group, identity-assurance level, and active agent separately.

For `figma-mobile`, committed PNG exports are the canonical approval baseline. VS Code and the generated local gallery provide verified thumbnails, full-size previews, and local PDF viewing; visual-verification evidence registers the pinned design, implementation screenshot, and diff image under the governed Story. Live Figma links open externally over HTTPS and are explicitly labeled as mutable convenience context.

## Start and resume

```bash
singularity-flow start ENG-142 --title "Add invoice export" --fetch
singularity-flow resume ENG-142 --fetch
```

With no source flags, `start` first asks whether intake comes from a Jira story or a manual description and documents. Manual mode asks for the title, audience, problem, outcome, acceptance criteria, and supporting file paths or HTTPS URLs. After source intake is complete, `start` asks only for a workflow template (`feature`, `bugfix`, `chore`, `figma-mobile`, or another configured work type). The first phase activates its default agent; resume activates the current phase's default. The active agent is stored locally in `.git/singularity-flow/session.json`; opening a session does not create a repository commit. It is prompt context, not a real identity or approval credential.

The receipt flow is local and auditable: `singularity-flow choices begin start <WORK-ID> --json` returns the live YAML-derived intake and workflow options; Copilot presents them through `ask_user`; and each exact answer is recorded with `singularity-flow choices answer`. Approval receipts bind to the submitted phase, generation, artifact hashes, and exact phase confirmation. The phase agent is recorded as audit context; approval authority is recalculated from the reviewer’s identity and the pinned authority registry.

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

The bundled Copilot plugin registers an advisory `sessionStart` prompt and one
nonblocking `subagentStart` command hook. The first may remind the contributor
to use `/sflow-session` or `/sflow-start`; it never invokes either skill. The
second maps an exact Copilot custom-agent name to the same Singularity Flow
agent ID for the local session. Neither hook denies Bash, edit, search, or
view tools, and deterministic CLI lifecycle checks remain the enforcement
boundary. The retained `session-start` and `agent-guard` CLI hook handlers are
available only for teams that deliberately install a custom command-hook policy.

New repositories also rotate Copilot context after an approved phase:

```yaml
contextPolicy:
  onApproval: new       # keep | compact | new
  onRejection: keep
  phaseOverrides:
    implementation: compact
```

The boundary is advisory because a child process cannot clear its parent Copilot CLI conversation. After the approval commit and push succeed, the CLI prints the exact next actions. `new` prints `/clear` followed by `/sflow-next`, `compact` prints `/compact` followed by `/sflow-next`, and `keep` continues directly. The next skill reconstructs its phase prompt from approved Git artifacts, pinned inputs, the selected governed agent, templates, agent Markdown, and required world-model views. Clearing therefore removes conversation history without losing governed state. It reduces tokens sent in later phases but does not refund tokens already consumed. Rejections default to `keep` so the correction conversation retains review feedback. The normalized policy is pinned in work-item and initiative state; configurations without it retain the earlier `keep` behavior.

`/sflow-session` applies this policy in order. For each new Copilot session it uses an exact work ID or Jira ID explicitly supplied by the contributor, or asks for one when it is absent; lists committed work-item branches from the configured Git remote; fetches the remote; checks out a missing local tracking branch; and fast-forwards to the exact remote head. It then activates the current phase's default agent. `/sflow-agent` explicitly overrides that prompt context without changing the human identity or its approval authority.

The attach path is deliberately conservative: missing, malformed, ahead, or diverged branches stop with a clear message, as does a dirty tree when attachment would require a checkout or fast-forward. If the requested Story branch is already checked out and its HEAD exactly matches the freshly fetched remote HEAD, attachment may bind the new Copilot session in place while preserving unpublished phase edits. It never creates a work branch, merges, rebases, resets, stashes, force-checks out, or discards local work. Run it directly with `singularity-flow session candidates` and `singularity-flow session attach ENG-142`. Copilot must already be open inside a clone of the application repository so `singularity/workflow.yml` and its configured remote are known; when the selected branch is absent locally, Git materializes it from the remote rather than cloning a duplicate repository.

Reviewers can open `/sflow-inbox` or run `singularity-flow inbox` to fetch a repository-wide queue of committed phases awaiting approval. The inbox reads workflow state directly from remote work-item branches without checking each one out. It shows the work/Jira ID, title, phase, generation, approval threshold, waiting time, human authority groups, artifact path, self-approval warning, and exact remote commit. Selecting an item uses the same conservative session-attachment flow before displaying the complete phase documents; it never approves automatically.

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
singularity-flow start ENG-142 --jira
```

Jira Cloud and Jira Data Center are both supported. Data Center uses `JIRA_DEPLOYMENT=data-center` and a Bearer `JIRA_PAT`; the Cloud path uses username plus PAT/API token with Basic authentication. `singularity-flow jira status`, `projects`, `epics --project`, `children`, and `permissions --project` provide read-only discovery. The Copilot CLI exposes the same operations as collision-safe skills:

- `/sflow-jira-status` checks the connection and authenticated Jira identity.
- `/sflow-jira-doctor` checks the active workspace, repository Jira policy, CLI credential availability, identity, configured projects, permissions, boards, and Epic visibility, then prints corrective actions.
- `/sflow-jira-assigned` lists incomplete Stories assigned to that identity.
- `/sflow-jira-board` lists Stories grouped under active/future sprints and never queries the backlog.
- `/sflow-jira-update` changes one Story only after displaying its current state and receiving exact Story-key confirmation.

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

Initiative-planning Jira writes are never immediate UI mutations. `initiative jira-plan` produces and pushes an exact reviewed diff; `initiative jira-apply --plan <sha256>` additionally requires an approved Plan/Elaboration phase, Jira permission preflight, exact initiative confirmation, unchanged Jira `updatedAt` values, and a plan that still matches the pinned connection, deployment, and project policy. Applied operations produce committed receipts, and retries accept only receipts that match the exact reviewed plan. That governed planner excludes status, assignee, sprint, priority, and resolution. A separately invoked `/sflow-jira-update` is an operator action against one exact Story and is not part of the governed initiative write plan.

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
  --story-file ./manual-story.yml \
  --document ./additional-context.pdf \
  --document-url https://www.figma.com/design/example
```

`--document` and `--document-url` may be repeated. A story file may also declare a `documents` list containing paths, URLs, optional labels, and kinds. Relative document paths are resolved from the story file's directory. The command creates and pushes `source.json`, a readable `USER-STORY.md`, the workflow state, and each copied document with a stable `DOC-nnn` identifier. It still asks the contributor to choose the workflow template; the phase agent is automatic interactively.

For a short manual request without a story file:

```bash
singularity-flow start WORK-123 \
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
/sflow-help WORK-123
```

The guide is read-only. Depending on state, it recommends `/sflow-phase`, `/sflow-submit`, `/sflow-approve` or `/sflow-reject`, and `/sflow-progress` after completion.

For the complete sequence of immediate, subsequent, and alternative actions instead of the full template explanation:

```bash
singularity-flow nextsteps WORK-123
```

From Copilot, use `/sflow-nextsteps WORK-123`.

To execute one next action instead of only displaying the plan, use either form:

```text
/sflow-next
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

From Copilot, use `/sflow-report ENG-142`. Markdown is the default; JSON exposes the derived data and HTML includes script-free inline charts. Reports show total and per-phase wall-clock duration, approval waiting, active time, generation/rework count, rejections, self-approvals, provider/model identity, exact token usage with per-model totals, quality-check duration, and the largest approval-latency bottleneck. An open approval request accumulates waiting time through report generation.

Durations include nights and weekends; they are not business-hours or developer-productivity estimates. Reports are derived views, not authoritative workflow state. Standard output is read-only, while `--out` writes only the requested report file and does not commit or push it automatically.

## Supporting documents and designs

Supporting inputs are managed under `singularity/work-items/<WORK-ID>/inputs/` and cataloged in `documents.json`. Uploads are allowed only in the initial phases configured by `documents.allowedPhases`; the starter profile allows intake, requirements/design/specification, and the corresponding bugfix phases.

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
```

Every uploaded file receives a stable `DOC-nnn` identifier, content hash, MIME type, original filename, phase, human actor, and governed agent. Directory imports preserve the package name and relative source path for every discovered regular file; symbolic links are rejected. Upload creates and pushes one atomic work-item commit. Text formats can be displayed directly; images, PDFs, `.fig`, and other binary files return an absolute path for the appropriate viewer. The catalog also lists generated phase artifacts, status, source context, and Jira user-story documents.

## Generate a phase

Copilot users normally invoke the appropriate skill, for example:

```text
/sflow-phase
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

Starter repositories use `inputsMode: record` and connect the full feature, bugfix, chore, and Figma-mobile phase chains. Existing repositories with no key resolve to `off`. Each work item pins its mode and normalized input declarations at creation.

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

Use `singularity-flow inputs design --dry-run` to inspect provenance without writing, or `/sflow-inputs` in Copilot. Normal preparation writes a managed artifact block and `context/inputs-design-gen<n>.json`; publication recollects inputs and the gate verifies approved hashes and rendered-block freshness.

## Token usage

With installer-managed Copilot telemetry, `prepare` opens a generation capture window. Copilot exports a chat span only after the response finishes, so `phase publish` may initially mark the current generation `pending`. The next `submit` or `/sflow-next` invocation automatically reconciles the completed span in its own commit and push before submission. The sanitized record is committed under the work item:

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

## Approval and rejection

From a terminal:

```bash
singularity-flow approve ENG-142 --fetch
singularity-flow reject ENG-142 --fetch --to requirements --reason "Failure behavior is missing"
```

Approval first verifies the reviewer’s Git/GitHub identity against the phase authority groups, activates the phase agent, shows artifact hashes, checks, token usage, prior approvals, and any self-approval warning, and requires the phase name as confirmation. When Copilot lacks persistent shell stdin, `/sflow-approve` collects that exact confirmation with a one-time receipt and runs the same approval itself; it never uses `--yes`. Multi-approval thresholds require distinct human identities.

Every individual approval is an atomic lifecycle decision: it updates the decision ledger and workflow state, creates its own `[WORK-ID][phase:<id>][approve] <authority-group>` commit, and pushes that commit before reporting success. This also applies to approvals that do not yet satisfy a multi-approval threshold. A failed push retains the local commit and blocks further decisions until `singularity-flow sync` succeeds.

Only a Git/GitHub identity matched to one of the phase's configured `approvalAuthorities` may decide a phase. The active governed agent is recorded as prompt/audit context but never grants permission. If the authenticated generator and approver are the same person, the approval is allowed when policy permits but is visibly recorded as `selfApproval: true`; it is never represented as independent review.

GitHub PR comments are also supported by installing `examples/singularity-flow-approve.yml`:

```text
/approve design
/reject design --to requirements --reason "Missing failure behavior"
```

Rejection may target only a phase allowed by that phase's YAML policy. It reopens the target and invalidates target/downstream approvals while preserving old artifacts in Git history.

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

For the smallest and lowest-token validated model, run this from the
application repository:

```bash
sflow-wm-minimal
# Use only the views required by one phase
sflow-wm-minimal --phase design
# Build another existing branch and publish normally
sflow-wm-minimal --branch WORK-123 --publish
```

The minimum wrapper uses `--depth quick`, one `development` view when no phase
is supplied, no parallel discovery, and `--local` by default. The result is
still validated and committed; `--local` only prevents an unexpected push. Add
`--publish` for the configured publication policy, or `--parallel --workers 2`
when multiple configured views should be checkpointed independently and
resumed after interruption. From a source checkout the equivalent command is
`./scripts/worldmodel-minimal.sh`.

```bash
singularity-flow wm build --phase design --task "Design invoice export"
singularity-flow wm build --branch release/2026.07 --phase design --task "Ground the release branch"
singularity-flow wm build --phase verification --workers 4
# After an interruption, rerun the identical command; completed views are reused
singularity-flow wm build --phase verification --workers 4 --resume
singularity-flow wm check --branch release/2026.07
singularity-flow wm compose --phase design --task "Design invoice export" --dry-run
singularity-flow wm compose --phase design --task "Design invoice export"
singularity-flow wm show-prompt
singularity-flow wm check
```

`wm build` runs the model generator in a detached analysis worktree, rejects writes outside its isolated output, validates every manifest entry, records a repository source-tree hash, commits the model, and follows the configured Git publication policy. When a phase requests multiple views, view-scoped read-only discovery workers run concurrently (four by default), write private bounded packets, and feed one final synthesizer. Each completed packet is checkpointed immediately under `singularity/world-model/.checkpoints/`. If the command fails or is stopped, rerun the same command (or add the explicit `--resume` flag): exact source/prompt/options matches are reused and only pending or invalid views run again. `--no-resume` discards the matching checkpoint and rebuilds every view. A successful validated installation removes the checkpoint automatically. Packet ordering, validation, installation, commit, and push remain single-owner operations. Use `--workers N`, `--no-parallel`, or the `worldModel.generation` YAML policy to tune it. Work-item lifecycle commits, checkpoints, and the model commit itself do not make the model stale; repository source/configuration changes do.

`wm build`, `wm check`, and `wm context` are repository operations and never
require an Epic, Story, or work ID. Add `--branch <name>` to target any existing
local or remote branch. Singularity Flow fetches the selected remote, opens the
branch in an isolated worktree, and leaves the active checkout unchanged. It
refuses divergent branches or branches already checked out elsewhere rather
than overwriting work. Use `--remote <name>` when the branch is not on `origin`.

`wm compose` is the single phase entry point. It combines the active governed Agent Markdown, mandatory phase and agent-added views, the exact task guide, applicable evidence, rule-selected files, and locked remote agent skills. `wm inject` remains an alias for compatibility. Rules can match the governed `agent` ID, phase, immutable work type, committed or pending changed paths, and source labels.

Use `/sflow-show-prompt` at any active Story phase to display the complete
`/sflow-phase` `SKILL.md` followed by the exact rendered governed phase prompt.
The inspection uses `--render-only`: it does not create a grounding record,
prepare an artifact, edit workflow state, commit, or push. Pass
`--skill sflow-design` (or another installed Flow skill ID) to inspect that
skill contract with the same current-phase prompt.

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

| ID | URL | Phases | Agents | Optional | Max bytes |
|---|---|---|---|---|---|
| secure-design | https://example.com/agents/secure-design.md | design,implementation-spec | architect | false | 262144 |
| api-review | https://example.com/agents/api-review.md | design | architect,developer | true | 262144 |

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
phase and governed-agent IDs; `*`, `-`, or an empty value means all. `Optional` accepts
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
authority. Edit the mapping YAML in VS Code **Configuration → Agents** or commit
it normally so every contributor receives the same routing.

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

VS Code **Configuration → Agents** can edit repository agent Markdown and display
lock status. Lock creation and updates remain explicit CLI
trust operations. Authenticated private Git, Artifactory, cookie, and bearer
token downloads are not supported in this delivery. See
[HELP.md](HELP.md#remote-agent-markdown) for lifecycle and integrity details.

## Useful commands

| Command | Purpose |
|---|---|
| `sflow-about` | Describe the Singularity Flow product, version, capabilities, and `sflow-` namespace. |
| `singularity-flow init` | Install editable YAML, templates, agent prompts, and world-model builder prompt. |
| `singularity-flow factory-reset --dry-run` | Preview a destructive reset of repository Singularity state and local runtime data before reinstalling current npm-package defaults. |
| `singularity-flow start <ID> [--jira \| --story-file FILE] [--ref BRANCH]` | Import Jira or manual story details, attach optional documents, choose a workflow; its phase agent is automatic, and create/push the canonical branch. The branch defaults to the Work ID; `--ref` decouples its name. |
| `singularity-flow choices begin\|answer\|status` | Bridge explicit Copilot start and approval choices through a short-lived one-time receipt when persistent terminal stdin is unavailable. |
| `singularity-flow resume <ID\|BRANCH> --fetch` | Resolve the Work ID/canonical-branch binding, fast-forward it, and activate the current phase agent. |
| `sflow-agent [ID]` | Select or change the prompt-only governed agent for the current local work-item session. |
| `singularity-flow session candidates` | Fetch and list committed remote work-item branches available for session attachment. |
| `singularity-flow session attach <ID>` | Safely fast-forward to the exact remote work-item head and activate the current phase agent. |
| `singularity-flow session status` | Inspect work-item and agent binding readiness for the current Copilot session. |
| `sflow-inbox [--offline] [--json]` | Fetch and list committed remote phases awaiting approval; equivalent to `singularity-flow inbox`. |
| `singularity-flow status [ID]` | Show phase, governed agent, artifacts, human approvals, usage, and warnings. |
| `singularity-flow progress [ID]` | Show deterministic completion percentage and phase/approval progress. |
| `singularity-flow report [ID] [--format md\|html\|json]` | Derive wall-clock timing, approval latency, rework, token, cost, and bottleneck metrics. |
| `singularity-flow guide [ID]` | Explain the selected workflow template and show the exact next valid skill and CLI command. |
| `singularity-flow nextsteps [ID]` | Show ordered `NOW`, `THEN`, and `ALTERNATIVE` actions without changing state. |
| `sflow-next [--task TEXT]` | Execute exactly one next valid action; alias for `singularity-flow next`. |
| `singularity-flow inputs [PHASE] [--dry-run]` | Inspect or render approved phase-input dataflow. |
| `singularity-flow agents list\|mappings\|lock\|sync\|status\|refresh-output` | Resolve Copilot-agent mappings and trust, materialize, inspect, or refresh remote Markdown agents. |
| `singularity-flow capabilities doctor [ID] [--offline]` | Verify capability ownership, inherited lifecycle policy, orphan-state publication, ledger integrity, lifecycle pinning, and cross-repository world-model snapshots. |
| `singularity-flow documents list [ID]` | List uploaded inputs and generated workflow documents. |
| `singularity-flow documents view <ID>` | Display text content or return the path/URL for a binary/external document. |
| `singularity-flow documents upload <FILE-OR-DIRECTORY...>` | Recursively copy, hash, catalog, commit, and push supporting evidence during configured initial phases. |
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
| `singularity-flow submit` | Run checks and publish an approval request. |
| `singularity-flow approve [ID] --fetch` | Verify human authority, activate the phase agent, and record/push the exact-hash decision. |
| `singularity-flow reject [ID] --fetch --to PHASE --reason TEXT` | Reject, reopen, invalidate downstream state, commit, and push. |
| `singularity-flow sync` | Retry a pending publication without rewriting the commit. |
| `singularity-flow gate --terminal` | Run the final deterministic/remote-state gate. |
| `singularity-flow pr [ID] [--create]` | Preview the story pull request built from committed governed state; `--create` opens it after typed confirmation. |
| `singularity-flow epic merge-plan [--epic ID]` | Show the dependency-ordered story merge sequence, each story's status, and the next story to merge. |
| `singularity-flow stack status\|sync [--epic ID]` | Inspect or replicate the enforced Story/PR order to each repository's orphan state branch. |
| `singularity-flow refresh-branch [--remote origin]` | Fetch and fast-forward only the checked-out clean branch; stop safely when it diverges. |
| `singularity-flow regression analyze [--good REF] [--bad REF] [--path PATH]` | Rank likely regression commits and merge history without changing the repository. |
| `singularity-flow wm build [--branch BRANCH] [--local] [--parallel\|--no-parallel] [--workers N] [--resume\|--no-resume]` | Build the repository world model on the current or selected branch; parallel view discovery is enabled by default, interrupted builds reuse exact-match checkpoints, and `--local` commits without pushing. |
| `sflow-wm-minimal [--phase PHASE] [--branch BRANCH] [--publish]` | Build the smallest quick validated model; defaults to one development view and a local commit. |
| `singularity-flow documents browse --provider <ID> [--path FOLDER]` | List items in a configured OneDrive/SharePoint, Artifactory, S3, or HTTPS provider. |
| `singularity-flow documents fetch --provider <ID> --ref <ITEM>` | Materialize provider bytes into the work item's inputs, then commit and publish them. |
| `singularity-flow logs [--level L] [--event P] [--tail N]` | Read the machine-local activity log: commands, hook decisions, and world-model progress, with secrets redacted. |
| `singularity-flow logs path\|level` | Show the log file location, or the effective file and console levels. |

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

The first-run walkthrough configures the local name and guidance role, Jira through
VS Code `SecretStorage`, a workspace, and intake. The guidance role only filters
the interface; workflow phases select governed agents. **Open Governed Context in
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
`/status`, and `/approve`. Existing `/sflow-*` and qualified
`/singularity-flow/sflow-*` invocations remain compatible. After upgrading, run
`singularity-flow plugin install`, close existing Copilot sessions, and confirm
that `copilot plugins list --kind skill` reports `sf-*` personal skills.

See [ARCHITECTURE.md](ARCHITECTURE.md) for invariants and [VERIFICATION.md](VERIFICATION.md) for the release checklist.
