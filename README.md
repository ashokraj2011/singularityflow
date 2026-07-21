# Singularity Flow

> Version 0.4 adds deterministic GitHub governance to the skills-first v0.3 workflow: authenticated role approvals, hash freshness, approval cascades, acceptance-criteria test mapping, and a merge gate.

Singularity Flow is a small, skills-first SDLC workflow for GitHub Copilot. It combines:

1. A **personal Copilot agent plugin** containing only `SKILL.md` files.
2. A **zero-dependency npm CLI** that performs deterministic Git, lifecycle, artifact, approval, and optional Jira REST operations.
3. A **Git-native work package** under `.sdlc/work-items/<WORK-ID>/` so another person can resume with only the work ID.

There is no Python runtime, MCP server, Jira IDE plugin, custom VS Code extension, or IntelliJ plugin.


## Product identifiers

| Purpose | Identifier |
|---|---|
| Product name | **Singularity Flow** |
| Private npm package | `@your-company/singularity-flow` |
| Primary CLI | `singularity-flow` |
| Short CLI alias | `sflow` |
| Copilot plugin name | `singularity-flow` |
| Skill namespace | `/singularity-flow:<skill>` |
| Jira custom-field prefix | `SINGULARITY_FLOW_JIRA_*` |

The primary executable is deliberately `singularity-flow`, not `singularity`, to reduce collisions with unrelated tools that already use the generic name.

## The operating model

```text
Copilot CLI or VS Code Chat
          │
          │ /singularity-flow:start ENG-142
          ▼
Personal Singularity Flow skill plugin
          │
          │ runs reviewed deterministic commands
          ▼
Global npm command: singularity-flow
          │
          ├── exact Git branch: ENG-142
          ├── .sdlc/work-items/ENG-142/workflow.json
          ├── phase artifacts and approval snapshots
          └── optional direct Jira Cloud REST read
```

The plugin remains in the user's Copilot profile. Only lifecycle state and deliverables are written to the application repository.

## What the solution provides

- Pull a Jira user story by key and present a normalized, Copilot-friendly view.
- Start from a unique ID, or retrieve the same ID and story details from Jira.
- Create and check out an exact Git branch named after the ID.
- Move through a configurable SDLC state machine.
- Give each phase a role-oriented Copilot skill.
- Register source code, tests, documents, and configuration as phase artifacts.
- Validate required deliverables and configurable quality commands.
- Separate submission from human approval.
- Snapshot approved artifact hashes, check results, approver identity, and Git head.
- Advance to the next phase after approval.
- Resume on another workstation from the committed work package.
- Validate lifecycle state in a pull request or CI job.
- Optionally require approvals created by authenticated `/approve <phase>` GitHub PR comments.
- Recompute approved artifact hashes and cascade-invalidate downstream approvals.
- Require every `AC-n` requirement to have a test tagged `@ac:AC-n`.

## Governed mode

After `singularity-flow init`, configure GitHub usernames by phase-owner role in `.sdlc/config.json`:

```json
{
  "governance": {
    "requireGithubApprovals": true,
    "requireAcceptanceCriteriaTags": true,
    "roles": {
      "product-owner": ["product-lead"],
      "architect": ["principal-architect"],
      "developer": ["engineering-lead"],
      "qa": ["qa-lead"],
      "reviewer": ["independent-reviewer"],
      "release-manager": ["release-manager"]
    }
  }
}
```

Copy the workflows from `examples/singularity-flow-approve.yml` and `examples/singularity-flow-validation.yml` into `.github/workflows/`, pin the package to an approved release, and require the validation job in branch protection. Approvers then comment `/approve <phase>` on the PR. The workflow writes state through GitHub's Contents API, producing GitHub-verified commits. Local `approve --by` records remain available only for non-governed repositories and are rejected by the governed CI gate.

Run the same gate locally for fast feedback:

```bash
singularity-flow gate
singularity-flow gate --terminal
```

## Default SDLC

```text
requirements
    ↓ approve
architecture & design
    ↓ approve
implementation
    ↓ approve
verification
    ↓ approve
independent review
    ↓ approve
release readiness
    ↓ approve
complete
```

| Phase ID | Skill | Default owner | Required deliverable |
|---|---|---|---|
| `requirements` | `/singularity-flow:requirements` | product owner | `requirements.md` |
| `design` | `/singularity-flow:design` | architect | `design.md` |
| `implementation` | `/singularity-flow:implement` | developer | `implementation-summary.md` plus code/tests |
| `verification` | `/singularity-flow:verify` | QA | `test-evidence.md` |
| `review` | `/singularity-flow:review` | independent reviewer | `review.md` |
| `release` | `/singularity-flow:release` | release manager | `release-plan.md` |

The skills provide role behavior. The npm utility owns state transitions so the model does not edit lifecycle files or approve its own work directly.

# Installation

## Prerequisites

- Node.js 20 or later.
- Git.
- GitHub Copilot CLI installed and authenticated.
- For VS Code use, a version that supports Copilot agent plugins and an organization policy that enables them.

Check the local environment:

```bash
node --version
git --version
copilot --version
```

## Install from the local package produced by this project

After running `npm pack`, install the generated tarball globally:

```bash
npm install --global ./your-company-singularity-flow-0.4.0.tgz
```

Verify the executable:

```bash
singularity-flow --version
sflow --version              # short alias
singularity-flow --help
```

Install the bundled skills as a personal Copilot plugin:

```bash
singularity-flow plugin install
```

Verify it:

```bash
copilot plugin list
```

After an npm package upgrade, reinstall the cached plugin copy:

```bash
npm install --global ./your-company-singularity-flow-0.4.0.tgz
singularity-flow plugin install --force
```

## Install after publishing to a private npm registry

Change the package scope and publisher fields first, then publish through your approved registry. Developer installation becomes:

```bash
npm install --global @your-company/singularity-flow@0.4.0
singularity-flow plugin install
```

The npm package installs the executable. The second command asks Copilot CLI to copy/cache the skills-only plugin in the user's Copilot profile.

# Use in GitHub Copilot CLI

From a trusted Git repository:

```bash
copilot
```

Inside the session, inspect available skills:

```text
/skills list
```

Start a work item:

```text
/singularity-flow:start ENG-142 --title "Add payment retry policy"
```

Create the requirements artifact:

```text
/singularity-flow:requirements
```

Submit it for approval:

```text
/singularity-flow:submit
```

A human explicitly approves it:

```text
/singularity-flow:approve --by "Asha Rao"
```

The approval skill uses the durable default `singularity-flow approve --yes --commit`. It does not push, merge, deploy, or modify Jira.

Continue through the active phase:

```text
/singularity-flow:design
/singularity-flow:submit
/singularity-flow:approve

/singularity-flow:implement
/singularity-flow:submit
/singularity-flow:approve

/singularity-flow:verify
/singularity-flow:submit
/singularity-flow:approve

/singularity-flow:review
/singularity-flow:submit
/singularity-flow:approve

/singularity-flow:release
/singularity-flow:submit
/singularity-flow:approve
```

Show current state at any time:

```text
/singularity-flow:status
```

# Use in VS Code Copilot Chat

Install the npm package and plugin with the same two commands:

```bash
npm install --global @your-company/singularity-flow@0.4.0
singularity-flow plugin install
```

Then:

1. Restart or reload VS Code so its environment can see the global `singularity-flow` executable.
2. Open the **Agent Plugins - Installed** view and confirm `singularity-flow` is enabled.
3. Open Copilot Chat in a trusted Git repository.
4. Type `/` and select commands such as `/singularity-flow:start` and `/singularity-flow:status`.

VS Code prefixes plugin-provided skills with the plugin name, so a skill whose internal name is `start` appears as `/singularity-flow:start`.

# Direct CLI usage

Every lifecycle operation is also available without Copilot:

```bash
singularity-flow init
singularity-flow start ENG-142 --title "Add payment retry policy"
singularity-flow status
singularity-flow prepare requirements
singularity-flow artifact add .sdlc/work-items/ENG-142/artifacts/requirements/requirements.md --kind requirements
singularity-flow submit
singularity-flow approve --yes --commit --by "Asha Rao"
```

## Command reference

| Command | Purpose |
|---|---|
| `singularity-flow init` | Create `.sdlc/config.json` with the default phase model. |
| `singularity-flow start <ID>` | Create/switch to exact branch `<ID>` and initialize the work package. |
| `singularity-flow start <ID> --jira` | Retrieve issue context through direct Jira REST before initialization. |
| `singularity-flow resume <ID> --fetch` | Fetch, switch to the work branch, fast-forward when tracking a remote, and load state. |
| `singularity-flow status [ID]` | Show phase state and artifact counts. |
| `singularity-flow status --json` | Emit complete machine-readable lifecycle state. |
| `singularity-flow prepare [phase]` | Create the required phase document if it does not exist. |
| `singularity-flow artifact add <paths...>` | Register explicit artifacts to the active phase. |
| `singularity-flow artifact scan` | Register changed repository files to the active phase. |
| `singularity-flow submit` | Scan, run configured checks, validate, and mark the phase `awaiting_approval`. |
| `singularity-flow approve --yes --commit` | Snapshot approval, advance the workflow, and create a work-ID-prefixed commit. |
| `singularity-flow reject --reason "..."` | Return a submitted phase to `in_progress`. |
| `singularity-flow validate --strict` | Validate branch and state consistency for local use or CI. |
| `singularity-flow jira list` | List open work assigned to the authenticated Jira user. |
| `singularity-flow jira pull <ID>` | Pull and display one normalized Jira user story. |
| `singularity-flow jira show <ID>` | Backward-compatible alias for `jira pull`. |
| `singularity-flow jira fields --query <text>` | Discover Jira system/custom field IDs. |
| `singularity-flow plugin install` | Install the packaged skills into the personal Copilot plugin cache. |
| `singularity-flow plugin uninstall` | Remove the Copilot plugin. |

# Repository state

Starting `ENG-142` creates:

```text
.sdlc/
├── config.json
└── work-items/
    └── ENG-142/
        ├── README.md
        ├── STATUS.md
        ├── source.json
        ├── USER-STORY.md        # present when started with --jira
        ├── workflow.json
        ├── approvals/
        │   ├── requirements.json
        │   ├── design.json
        │   └── ...
        └── artifacts/
            ├── requirements/
            │   └── requirements.md
            ├── design/
            │   └── design.md
            ├── implementation/
            │   └── implementation-summary.md
            ├── verification/
            │   └── test-evidence.md
            ├── review/
            │   └── review.md
            └── release/
                └── release-plan.md
```

`workflow.json` is authoritative machine state. `STATUS.md` is a generated human-readable view. Neither should be edited manually.

## Workflow state example

```json
{
  "workItem": {
    "id": "ENG-142",
    "branch": "ENG-142",
    "baseBranch": "main",
    "source": { "type": "manual", "key": null, "url": null }
  },
  "status": "in_progress",
  "currentPhase": "design",
  "phaseOrder": [
    "requirements",
    "design",
    "implementation",
    "verification",
    "review",
    "release"
  ],
  "phases": {
    "requirements": { "status": "approved" },
    "design": { "status": "in_progress" }
  }
}
```

# Artifact and approval semantics

## Registration

Copilot may generate source code, tests, documents, and configuration. `singularity-flow artifact scan` records each changed path with:

- Artifact kind.
- Existence and size.
- SHA-256 hash for files.
- Registration and update timestamps.
- Active SDLC phase.

## Submission

`singularity-flow submit`:

1. Scans changed files.
2. Runs the current phase's configured quality commands.
3. Ensures the required phase deliverable exists.
4. Rejects very short deliverables and template placeholders such as `TODO` or `TBD`.
5. Confirms registered artifact hashes still match the working tree.
6. Changes the phase to `awaiting_approval`.

## Approval

`singularity-flow approve` requires a submitted phase. It:

1. Revalidates artifact snapshots.
2. Records the approver and timestamp.
3. Marks phase artifacts approved.
4. Writes `approvals/<phase>.json` containing artifact hashes, check outcomes, and `headBeforeApproval`.
5. Advances exactly one phase, or marks the workflow complete.
6. Optionally commits all durable work with a message such as `ENG-142 approve design`.

The Git commit is the historical artifact snapshot. Later phase changes remain traceable through later commits and approval records.

# Handoff between people

Person A:

```text
/singularity-flow:implement
/singularity-flow:submit
/singularity-flow:approve
```

Then push through the team's normal Git process:

```bash
git push -u origin ENG-142
```

Person B, in another clone:

```bash
singularity-flow resume ENG-142 --fetch
copilot
```

Inside Copilot:

```text
/singularity-flow:status
/singularity-flow:verify
```

The second person does not need the first person's Copilot conversation. They recover context from the branch, approved artifacts, workflow history, and approval snapshots.

# Optional Jira read integration

Jira is an input option, not a required plugin or infrastructure layer. Singularity Flow calls Jira Cloud REST directly only when requested.

Set credentials outside Git:

```bash
export JIRA_BASE_URL="https://company.atlassian.net"
export JIRA_EMAIL="developer@company.com"
export JIRA_API_TOKEN="..."
```

Optional acceptance-criteria field:

```bash
export SINGULARITY_FLOW_JIRA_ACCEPTANCE_FIELD="customfield_12345"
```

Optional story-points, sprint, and additional custom fields:

```bash
export SINGULARITY_FLOW_JIRA_STORY_POINTS_FIELD="customfield_10016"
export SINGULARITY_FLOW_JIRA_SPRINT_FIELD="customfield_10020"
export SINGULARITY_FLOW_JIRA_EXTRA_FIELDS="customfield_10001,customfield_10002"
```

Find the IDs used by your Jira site:

```bash
singularity-flow jira fields --query "acceptance"
singularity-flow jira fields --query "story points"
singularity-flow jira fields --query "sprint"
```

List assigned work:

```bash
singularity-flow jira list --project PAY --type Story
```

Pull one user story without changing Git:

```bash
singularity-flow jira pull PAY-142
singularity-flow jira pull PAY-142 --json
```

From Copilot CLI or Copilot Chat, use:

```text
/singularity-flow:jira-story PAY-142
```

The normalized result includes the summary, project, issue type, status and category, priority, assignee, reporter, creator, parent, story points, sprint, dates, labels, components, fix versions, description, acceptance criteria, environment, subtasks, issue links, and attachment metadata when those fields are available.

Start from a Jira item:

```bash
singularity-flow start PAY-142 --jira
```

Starting from Jira creates the exact branch `PAY-142`, writes the machine-readable snapshot to `source.json`, and writes a human-readable `USER-STORY.md` beside the workflow. Attachment metadata can be included, but attachment contents and comments are not downloaded. The adapter never accepts an Atlassian password and does not write credentials to the repository.

For organization-wide production distribution, use an authentication approach approved by your Atlassian administrators. The included API-token mode is deliberately small and suited to controlled internal use or proof-of-concept testing.

# Configure phases and quality gates

Run:

```bash
singularity-flow init
```

Then edit `.sdlc/config.json` before starting work. A complete example is included at `examples/config-with-quality-gates.json`.

Example implementation phase:

```json
{
  "id": "implementation",
  "label": "Implementation",
  "owner": "developer",
  "requiredArtifact": {
    "path": "artifacts/implementation/implementation-summary.md",
    "kind": "implementation-summary",
    "minimumBytes": 250
  },
  "qualityCommands": [
    "npm run lint",
    "npm test"
  ]
}
```

Quality commands execute from the repository root. Treat `.sdlc/config.json` as reviewed repository code because these commands are shell commands.

# Pull-request validation

A minimal optional GitHub Actions example is included at `examples/singularity-flow-validation.yml`. It runs:

```bash
singularity-flow validate --strict
```

For a private registry, add the organization's normal npm authentication before installation. Pin an approved package version rather than using `latest` in CI.

# Security boundaries

Singularity Flow deliberately does not:

- Auto-install an unreviewed npm package from a skill.
- Put credentials in skill files or repository state.
- Use MCP.
- Auto-approve model output.
- Push a branch.
- Open or merge a pull request.
- Deploy.
- Update Jira.
- Bypass Git or Copilot permission prompts.

The approval skill has `disable-model-invocation: true`; it is intended for explicit user invocation. The skills do not pre-authorize shell execution with `allowed-tools`, so normal Copilot tool permission controls remain active.

# Package development

Run all tests:

```bash
npm test
```

Run static/package checks:

```bash
npm run check
npm run pack:dry
```

Create the npm tarball:

```bash
npm pack
```

Inspect its contents before publishing:

```bash
tar -tzf your-company-singularity-flow-0.4.0.tgz
```

# Publishing checklist

1. Replace `@your-company/singularity-flow` with the real npm scope.
2. Replace the author metadata in `plugin/plugin.json`.
3. Add repository and homepage fields if desired.
4. Review every skill and command.
5. Run `npm test`, `npm run check`, and `npm pack --dry-run`.
6. Publish to the approved private registry.
7. Pin the tested version for the pilot group.
8. Re-run `singularity-flow plugin install --force` after every npm upgrade.

# Uninstall

Remove the personal Copilot plugin first:

```bash
singularity-flow plugin uninstall
```

Then remove the npm CLI:

```bash
npm uninstall --global @your-company/singularity-flow
```

This does not delete `.sdlc/` state from repositories; that state is part of the committed work product.

# Troubleshooting

## `singularity-flow: command not found`

Confirm the package is installed globally and the npm global binary directory is on `PATH`. Restart VS Code after changing `PATH`.

## Skills do not appear

```bash
copilot plugin list
singularity-flow plugin install --force
```

In a CLI session, inspect `/skills list`. In VS Code, confirm agent plugins are enabled by organizational policy and the Singularity Flow plugin is enabled.

## Approval fails

A phase must first be submitted. Run:

```bash
singularity-flow status
singularity-flow submit
singularity-flow approve --yes --commit
```

If an artifact changed after submission, run `singularity-flow artifact scan`, submit again, and then approve.

## Resume cannot find a branch

Fetch the remote branch:

```bash
singularity-flow resume ENG-142 --fetch
```

The remote branch must already have been pushed by the previous contributor.

## Jira returns 401 or 403

Verify the base URL, account email, API token, and the user's Jira permissions. Do not substitute the user's Atlassian password.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for design details and [VERIFICATION.md](./VERIFICATION.md) for the tests performed on this package.
