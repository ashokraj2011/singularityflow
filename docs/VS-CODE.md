# Singularity Flow for VS Code

The VS Code extension is the supported visual surface for business users,
product owners, architects, developers, QA, and approvers. It delegates all
governed reads and mutations to `sflow`; it does not keep a competing workflow
database.

**My Work** is the visible home. The hidden **Talk to SFlow** command is retained only for compatibility and opens My Work. See `sflow explain developer-home` and `sflow explain copilot-and-surfaces` for the shared-state and session-boundary details.

## Navigation model

The Singularity Flow activity bar contains one compact Navigator with Favorites, Inbox, Workspaces,
Lifecycle, Configuration, Help, and Logs sections.

Choose a machine-local menu persona from the Navigator header or **Configure User Profile**.
Product owner, Business analyst, Product designer, Architect, Developer, QA, Security, Delivery
manager, Operations, Admin, and General personas place their most relevant sections first and seed
first-use Favorites with useful shortcuts. Persona selection never hides a command, changes a
governed agent, or grants approval authority. Explicitly customized Favorites survive later persona
changes.

On a first visit, Favorites and the persona's highest-priority section are expanded while the
supporting sections remain collapsed. General and Developer open Lifecycle; QA and Product owner
open Inbox; Architect opens Configuration; Admin opens Workspaces. Expand or collapse any section
once and the Navigator preserves that preference.
Clickable rows have distinct hover, pressed, keyboard-focus, and last-opened states so the result
of a navigation choice remains visible after the click.

### Favorites

Favorites answers **where are the menus I use every day?**

- A new installation starts with persona-relevant Favorites. Until a persona is chosen, the General
  suggestions are My Work, Start intake, and Inbox. This is only a first-use suggestion; removing
  every favorite is remembered as an intentional empty list.
- Open **Choose favorites** from the section header or its empty state.
- Select any combination of My Work, intake, Inbox, Approvals, Workspaces, Configuration Center,
  capability mapping, visual assurance, impact, logs, prompt audit, and Help.
- Click a favorite to run the original registered command with all of its normal repository,
  lifecycle, confirmation, and authority checks.
- Use the inline unpin control to remove one. Reopen **Choose favorites** to replace the complete set.
  A short confirmation identifies newly pinned menus.

Favorites are stored in VS Code global state for this installation. They are personal navigation
preferences, not governed workflow state, and are never committed or pushed.

### Workspaces

Workspaces answers **where am I working?**

- Select a saved workspace in the current VS Code window.
- Inspect its local directory, lead repository, participating repositories,
  branches, dirty state, Jira routing, application metadata, and world-model health.
- Edit the workspace display name and choose governed capabilities already
  available within its materialized repository boundary.
- Copy a workspace when a different local directory or repository boundary is
  required; an edit never silently redirects an existing clone.
- Rename a workspace without changing governed state. Archive it only after the
  engine refreshes every repository and proves there are no active Stories;
  archived workspaces move into a separate folder and retain every checkout and
  artifact for inspection or restore.
- Open a repository explicitly only when you want VS Code to change folders.
  Selecting a workspace alone never opens another VS Code window.

The workspace registry used by the CLI is canonical. VS Code reads and updates
that registry rather than creating its own workspace records.

### Lifecycle

Lifecycle answers **what governed work is active, and what happens next?**

- Start Story or Initiative intake, with or without Jira.
- Choose the workflow/work type and its first governed agent.
- View the phase rail, current status, inputs, required outputs, checks, and gates.
- Prepare, publish, submit, approve, reject, synchronize, or run the next valid
  action through the CLI.
- Cancel active Story work only after recording a reason and confirming the exact
  Work ID. Cancellation commits and pushes an audited terminal decision; it moves
  the Story to **Archived** without deleting its branch, artifacts, approvals,
  telemetry, or Git history.
- Open generated artifacts and see exact generation, hashes, author, agent,
  approvals, and self-approval warnings.
- Hand the active phase to native Copilot with the exact composed prompt.

Lifecycle is intentionally not a configuration editor. It uses the immutable
workflow resolution pinned when the work started.

### Lifecycle analytics

Lifecycle Analytics answers **how is this Story moving, and where is time or model
usage accumulating?** It is a read-only view over the engine's deterministic
workflow report:

- approved phases and overall completion percentage;
- wall-clock elapsed, active phase time, and approval waiting time;
- the phase with the largest approval-latency bottleneck;
- generations, rework cycles, rejections, self-approvals, and sequence overrides;
- exact or partial token usage by phase and provider/model; and
- provider cost or configured model pricing, with incomplete coverage called out.

Missing provider telemetry and missing pricing are shown as **Unavailable**, never
as a misleading zero. Durations include nights and weekends and are not productivity
estimates. The view refreshes from the coherent repository snapshot and stores no
analytics state of its own.

### Visual Assurance

Visual Assurance answers **does the implementation match the approved design
evidence?** Open it from Lifecycle, Inbox, Configuration Center, or the command
palette with **Singularity Flow: Visual Assurance**. The page joins:

- the approved design-source set, candidate source records, and deterministic
  design inventory;
- required viewport/profile coverage and the exact implementation captures that
  satisfy it;
- expected, actual, and diff artifacts for every deterministic comparison;
- MCP server readiness and tool-call provenance; and
- blocking errors, warnings, and passes from the same local read model used by
  the governance engine.

Opening and refreshing the page is always local and read-only. A network doctor,
MCP warm-up, or remote evidence download runs only after the user selects that
specific action and confirms it. The page never turns an MCP result into an
approval: design-source approval still occurs through the normal hash-bound
lifecycle decision.

Recorded PNG comparisons render directly in the editor. Reviewers can switch
between side-by-side, overlay-slider, and deterministic diff views while the
approved and implementation hashes remain visible. The preview resolves only
files inside the active Story artifact directory; missing, non-PNG, or escaping
paths remain unavailable and can never broaden the webview's file access.

Candidate design versions are listed separately from the approved version. MCP
cards explain why a host is not ready and expose an exact-server-name
attestation flow after the contributor has trusted, started, and authenticated
that host. Attestation is machine-local readiness evidence, not design approval.

### Inbox

Inbox answers **what needs attention?**

- Review generated Markdown, JSON, YAML, images, and registered evidence.
- Filter submissions and approvals by workspace, capability, repository, work ID,
  phase, status, and age.
- Inspect source-to-requirement-to-Story-to-implementation lineage.
- Open an exact artifact or review packet without changing repository state.
- Approve or reject against the exact submitted hash when authority permits.

The capability portfolio dashboard sits above the operational inbox. It summarizes
capabilities, delivery capabilities, repositories, Jira routes, open governed work,
pending approvals, diagnostics, and world-model health. Root capability cards let
business users enter a portfolio without navigating repository internals first.

### Configuration

Configuration answers **how should future work run?** It contains visual editors
for repository-owned configuration:

- **Configuration Center** — one guided overview of all major areas, including
  first-class People & approvals and MCP policy screens. It distinguishes human
  identities, governed AI agents, and host-owned tool processes instead of
  presenting them as one kind of user.

- **Workflow Designer** — create or edit work types, phase order, inputs, gates,
  checks, approvals, and world-model routing.
- **Artifact Designer** — compose Markdown artifact templates from ordered
  sections, required fields, traceability tables, instructions, and optional
  remote template URLs.
- **Agent Delivery & Instruction Designer** — create and edit
  `.github/agents/*.agent.md`, including phase scope, instructions, tool policy,
  world-model views, remote skills, remote artifact templates, generated outputs,
  native Copilot-to-Flow mappings, and hash-lock/cache status.
- **Prompt, Skill, and Prompt Pack Designer** — inspect and edit reusable Markdown,
  assemble ordered packs, and preview the final composition.
- **Capability Designer** — add or edit collection and delivery
  capabilities, connect repositories and Jira routes, and view inherited policy.
- **Integrations and policy** — secure Jira and Teams actions, approval
  authorities, governed MCP policy and host readiness, remote-agent locks, and
  world-model rules.

Configuration changes affect new work unless a lifecycle explicitly regenerates a
new version. Active work continues from its pinned resolution.

## Native Copilot handoff

The extension does not host a separate model process. **Open Governed Context in
Copilot** asks `sflow` to compose the current phase and then hands the result to
native Copilot Chat. The same composition can be inspected first:

```bash
sflow wm show-prompt --phase <PHASE>
# Copilot skill: /sf-show-prompt
```

The preview identifies every included agent, prompt, world-model view, phase
input, template, and hash. Copilot may author an artifact, but only the CLI can
change lifecycle state or publish it.

## Credentials

Jira and storage secrets are held in VS Code `SecretStorage`, backed by the
operating-system credential store. They are passed only to the relevant CLI child
process and are never written to workflow YAML, workspace manifests, artifacts,
logs, or Git.

## Refresh and concurrent terminals

Git is the shared state-transfer mechanism. The extension refreshes from revisioned
CLI snapshots and watches governed files so a terminal or another user can change
the branch without leaving the visual state permanently stale. Normal Git
fast-forward rules prevent one terminal from overwriting another decision.

## Installation

Build and install the extension from the repository:

```bash
npm run vscode:build
npm run vscode:package
code --install-extension apps/vscode/singularity-flow-vscode-0.9.0.vsix --force
```

Then run **Developer: Reload Window**. Open the Singularity Flow activity-bar icon,
select a workspace, and use Lifecycle to start or resume governed work.
