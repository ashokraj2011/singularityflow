# Project Workspaces

A Singularity workspace is a **local isolation boundary**, not a new Jira or
SDLC hierarchy item. It supplies separate clones, staged documents, caches,
logs, and Copilot process context. Exactly one repository is the lead and
stores Epic-level artifacts; every participating repository has its own Jira
board routing, App ID, display name, and optional metadata.

## Create from the desktop

1. Open any initialized Singularity repository.
2. Open **Advanced → Workspace configuration**.
3. Enter the workspace name and portable ID, then choose a local working
   directory.
4. Add repositories from local Git checkouts or enter clone URLs manually.
5. For each repository, enter its Jira board/project key, Application ID,
   display name, and any additional key/value metadata.
6. Select exactly one lead repository and preview every clone operation.
7. Type the exact workspace ID to create the workspace.

Jira authentication is not required to configure a workspace. Credentials
remain an OS-protected integration concern when the Epic flow actually reads or
writes Jira. They never enter `workspace.json`.

## Manage an existing workspace

Open **Engineer tools → Workspace configuration** for the active workspace:

- **Jira connection** opens the workspace-scoped sign-in screen. The repository
  project keys are reused automatically; only the Jira HTTPS URL, account, and
  token are requested. Tokens remain in the operating-system keychain.
- **Edit workspace** changes the display name, lead designation, Jira project
  routing, App IDs, display names, metadata, and can add repositories. Existing
  materialized repository IDs, clone URLs, branches, and paths stay immutable
  so an edit cannot silently redirect a clone.
- **Archive** requires the exact workspace ID. It hides the workspace from
  normal selection without deleting its folder, repositories, documents, or Git
  history. Archived workspaces remain visible in the recoverable list and can be
  restored.

Epic intake accepts a Jira key such as `KAN-8`, a Jira browse URL, or the
numeric Jira issue ID. The returned issue must be an Epic and must belong to one
of the project keys configured on the workspace repositories.

## Local layout

```text
<workspace-base>/
  payments-modernization/
    workspace.json
    repos/
      platform/
      mobile/
      api/
    documents/
      inbox/
      jira/
      imports/
      exports/
    cache/
      jira/
      copilot/
      previews/
    logs/
      workspace-materialization.json
```

`workspace.json` is machine-local. It contains the workspace identity, local
relative paths, clone URLs, repository Jira routing, application metadata, and
the lead-repository selection. It never contains Jira credentials, approvals,
lifecycle state, or authoritative evidence.

Documents added with **Stage documents** remain visibly marked
`staged-not-governed`. When the matching story branch and persona session are
active, **Import to work item** copies the selected file through the normal
document flow, hashes it, commits it, and pushes the governed version. Initiative
evidence still uses its checklist-aware evidence registration flow so assurance
and freshness cannot be bypassed.

## Safety and recovery

- Each workspace receives independent normal clones even when another
  workspace uses the same repository.
- Creation requires exact workspace-ID confirmation and keeps a resumable journal.
  Repeating creation with the same workspace ID and exact repository plan resumes
  every missing clone and records each attempt. Interrupted clone staging is
  removed safely before the error is returned.
- Existing clone identity fields—repository ID, URL, branch, and path—cannot be
  changed through workspace editing. Jira routing, metadata, App IDs, display
  names, the lead selection, and new repositories are updated through a
  validated save plan.
- Existing unrelated directories are never overwritten.
- Fetch skips dirty clones and never changes their branch or working tree.
- Repair clones only missing repositories. Remote mismatches require deliberate
  manual correction. `logs/workspace-materialization.json` reports running,
  completed, and failed recovery attempts.
- Workspace aliases are resolved to one canonical location in the recent list.
  The managed `workspace.json` must be a regular file and cannot be a symlink.
- Archiving or forgetting a workspace never deletes repositories or documents.
  Archive is recoverable from the desktop; Forget removes only the local recent
  pointer.
- Opening another workspace or repository stops the previous Copilot backend
  and clears its pending planning handles before the new context becomes active.
- Planning Copilot receives the ready clone roots as its explicit read-only
  filesystem boundary. It is told to exclude staged documents until governance
  promotes or registers them.
- A lost local workspace can be rebuilt from its saved configuration, lead Git
  branch, and participating remote branches.
- Existing Jira-anchored `workspace.json` files remain readable and resumable.

## CLI

The Electron app is the recommended experience for the unified workspace
configuration. Existing Jira-anchored CLI commands remain available for
backward compatibility and corporate automation:

```bash
singularity-flow workspace create \
  --jira PAY-100 \
  --base "$PWD/workspaces" \
  --lead platform \
  --repository platform=git@github.com:company/platform.git \
  --repository mobile=git@github.com:company/mobile.git \
  --repository api=git@github.com:company/api.git \
  --confirm PAY-100

singularity-flow workspace list
singularity-flow workspace open ./workspaces/PAY-100--payments-modernization
singularity-flow workspace status ./workspaces/PAY-100--payments-modernization
singularity-flow workspace sync ./workspaces/PAY-100--payments-modernization
singularity-flow workspace repair ./workspaces/PAY-100--payments-modernization
singularity-flow workspace documents import ./workspaces/PAY-100--payments-modernization ./requirements.pdf
singularity-flow workspace forget ./workspaces/PAY-100--payments-modernization
```

`workspace create` reads Jira using the existing Jira environment connection.
For an approved offline provisioning script, supply `--site`,
`--hierarchy-level`, `--issue-type`, `--title`, and optionally `--jira-url`.
Offline values are still validated and hierarchy levels below Epic are refused.

The workspace registry defaults to
`~/.singularity-flow/workspaces.json`. Corporate launchers can override it with
`SINGULARITY_FLOW_WORKSPACE_REGISTRY` and can set the default storage root with
`SINGULARITY_FLOW_WORKSPACE_ROOT`.
