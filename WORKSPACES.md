# Jira-Anchored Project Workspaces

A Singularity workspace is a **local isolation boundary**, not a new Jira or
SDLC hierarchy item. Its identity is an existing Jira Epic or a configured
Jira item above Epic. Jira supplies the hierarchy, Git supplies authoritative
workflow state, and the workspace supplies separate clones, staged documents,
caches, logs, and Copilot process context.

## Create from the desktop

1. Open the repository that will govern the initiative.
2. Configure and commit `singularity/portfolio.yml`, including Jira policy and
   participating repository URLs.
3. Connect Jira from **Jira workspace**. The token/PAT is encrypted for the
   operating-system account and never enters Git or `workspace.json`.
4. Open **Project workspaces**.
5. Choose a storage directory, Jira project, and an Epic or higher-level item.
6. Review the live Jira hierarchy, choose the lead repository and participating
   repositories, then preview every clone operation.
7. Type the exact Jira key to create the workspace.

The desktop discovers Jira issue-type names and numeric hierarchy levels. It
does not assume that level 2 is named “Initiative.” Jira Standard projects can
use an Epic anchor; Jira Premium/Enterprise sites may expose configured levels
above Epic.

## Local layout

```text
<workspace-base>/
  PAY-100--payments-modernization/
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

`workspace.json` is machine-local. It contains the Jira anchor, local relative
paths, clone URLs, and the lead-repository selection. It never contains Jira
credentials, approvals, lifecycle state, or authoritative evidence.

Documents added with **Stage documents** remain visibly marked
`staged-not-governed`. When the matching story branch and persona session are
active, **Import to work item** copies the selected file through the normal
document flow, hashes it, commits it, and pushes the governed version. Initiative
evidence still uses its checklist-aware evidence registration flow so assurance
and freshness cannot be bypassed.

## Safety and recovery

- Each workspace receives independent normal clones even when another
  workspace uses the same repository.
- Creation requires exact Jira-key confirmation and keeps a resumable journal.
  Repeating creation with the same Jira key and exact repository plan resumes
  every missing clone and records each attempt. Interrupted clone staging is
  removed safely before the error is returned.
- A changed repository URL, branch, path, metadata set, required flag, or lead
  repository is treated as a different materialization plan. Singularity Flow
  refuses to reuse the existing directory; open its current plan or choose a
  different workspace location.
- Existing unrelated directories are never overwritten.
- Fetch skips dirty clones and never changes their branch or working tree.
- Repair clones only missing repositories. Remote mismatches require deliberate
  manual correction. `logs/workspace-materialization.json` reports running,
  completed, and failed recovery attempts.
- Workspace aliases are resolved to one canonical location in the recent list.
  The managed `workspace.json` must be a regular file and cannot be a symlink.
- Forgetting a workspace removes only the recent-location entry; it never
  deletes repositories or documents.
- Opening another workspace or repository stops the previous Copilot backend
  and clears its pending planning handles before the new context becomes active.
- Planning Copilot receives the ready clone roots as its explicit read-only
  filesystem boundary. It is told to exclude staged documents until governance
  promotes or registers them.
- A lost local workspace can be rebuilt from its Jira anchor, lead Git branch,
  and participating remote branches.

## CLI

The Electron app is the recommended experience. The local commands are useful
for diagnostics and corporate automation:

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
