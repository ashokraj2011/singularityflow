# Singularity Flow for VS Code

The VS Code extension is the supported visual surface for business users,
product owners, architects, developers, QA, and approvers. It delegates all
governed reads and mutations to `sflow`; it does not keep a competing workflow
database.

## Navigation model

The Singularity Flow activity bar contains four primary views.

### Workspaces

Workspaces answers **where am I working?**

- Select a saved workspace in the current VS Code window.
- Inspect its local directory, lead repository, participating repositories,
  branches, dirty state, Jira routing, application metadata, and world-model health.
- Edit the workspace display name and choose governed capabilities already
  available within its materialized repository boundary.
- Copy a workspace when a different local directory or repository boundary is
  required; an edit never silently redirects an existing clone.
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

- **Workflow Designer** — create or edit work types, phase order, inputs, gates,
  checks, approvals, and world-model routing.
- **Artifact Designer** — compose Markdown artifact templates from ordered
  sections, required fields, traceability tables, instructions, and optional
  remote template URLs.
- **Agent Designer** — create and edit `.github/agents/*.agent.md`, including
  phase scope, instructions, tool policy, and added world-model views.
- **Prompt, Skill, and Prompt Pack Designer** — inspect and edit reusable Markdown,
  assemble ordered packs, and preview the final composition.
- **Capability Designer** — add or edit collection and delivery
  capabilities, connect repositories and Jira routes, and view inherited policy.
- **Integrations and policy** — Jira, storage, Teams notifications, approval
  authorities, remote-agent locks, and world-model rules.

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
