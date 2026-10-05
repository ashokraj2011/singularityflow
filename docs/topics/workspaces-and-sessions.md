---
id: workspaces-and-sessions
title: Workspaces, sessions, and current selection
aliases:
  - workspace
  - session
  - choices
  - switch-workspace
commands:
  - workspace
  - session
  - choices
  - push
related:
  - developer-home
  - capability-management
  - repository-state-and-snapshots
version: 10
---
A workspace is the machine-local collection of capability repositories used for one delivery context. Sessions bind a contributor and selected work item without replacing governed repository state.

## Purpose and prerequisites

Use this topic when the current goal matches **workspaces and sessions**. Start in a governed checkout unless the command explicitly operates on installation or machine-local workspace state. Run `sflow doctor` when setup, identity, credentials, or repository health is uncertain, and use `sflow status` or `sflow home` to confirm the selected work before a mutation.

## Use it from each surface

- **Shell:** `sflow workspace`, `sflow session`, `sflow choices`. Run `singularity-flow workspace --help` for the exact forms supported by this build.
- **Copilot:** `/sf-workspaces` lists saved workspaces; `/sf-workspace` asks which workspace and repository to select. `/sf-stories` lists Stories and their progress, then asks which exact Story to make active through `/sf-session`. The skills preserve the CLI result and wait for explicit choices.
- **VS Code:** open Singularity Flow **My Work and Workspaces**. The extension renders engine results; it does not independently decide lifecycle state.

## Guided workflow

1. Read the current state with `sflow home`, `sflow status`, or the relevant list/status form.
2. Review the repository, workspace, Work ID, phase, actor, and any warnings before selecting an action.
3. Preview or prepare the operation when the command offers a dry-run, plan, packet, or exact confirmation.
4. Run the smallest applicable command from this topic. Do not substitute an undocumented subcommand.
5. Re-read state after completion. In Copilot, return to `/sf-home`; in VS Code, refresh the relevant view if it has not already refreshed.

For a large delivery repository, configure its clone strategy while mapping the capability. `blobless` keeps the full checkout but fetches historical file bytes on demand. `blobless-sparse` also materializes only the declared cone directories; Singularity Flow automatically includes `singularity/` and `.github/agents/`. The default fallback is `refuse`: a server that ignores `filter=blob:none` cannot silently turn a planned partial clone into a full monorepo download. Choose the explicit `full` fallback only when that cost is acceptable.

Before any workspace exists, use `sflow workspace prepare <REMOTE> --id <ID> --base <DIRECTORY>` to record and preflight a resumable setup. It creates no destination. Continue only with the returned `workspace bootstrap resume` command and exact workspace-ID confirmation. An interrupted setup remains addressable by its `bst_…` ID.

### Workspace selection and the editor

Workspace and Story discovery use deterministic CLI tables, not a Home summary:

```bash
singularity-flow workspace list --table
singularity-flow session candidates --table --workspace <WORKSPACE> --repository <REPOSITORY-ID>
```

The complete workspace roster includes inactive rows and active context. In Copilot,
`/sf-workspaces` only displays it; singular `/sf-workspace` uses that table to ask for an
exact workspace ID or row, then any required repository choice before switching. An
active marker is not a selection answer. Neither listing nor selecting a workspace
implicitly selects a new Story.

Use `/sf-stories` to see the complete Story table with the progress available from
durable state. Choose an exact Story ID or row from that table; it is never assumed
from the first row or a current binding. Only the chosen Story is passed to
`/sf-session` with the same workspace/repository selectors. Invoking `/sf-session`
without an ID also shows this chooser before session status or attachment. Explicit
discovery/selection skills are not replaced by Home headings, and setup ends without
starting or advancing Story work.

The Story table shows title, status, current phase, phase status, generation, and
approved phases / total phases retained by that Story. For example, `2/7` means
two of seven phases are approved; it is not a coding-completion estimate. Missing
historical progress remains unavailable. In IntelliJ, invoke the same chooser as
`/skill:sf-stories`; use `/skill:sf-workspace` to choose a workspace first.

Without explicit selectors, these Copilot Story choosers read `workspace current --json`
and carry its exact workspace path and repository ID into discovery and setup. This
keeps an older IntelliJ or terminal cwd from silently choosing a different repository.
With no active workspace, an opened Git root remains a valid discovery scope; an
unresolved scope requires workspace selection, not repository guessing.

In VS Code, **Select workspace** opens the selected ready repository in the **same window**.
For a deferred checkout, it opens the existing workspace folder without cloning application
code; **Start Work**, explicit Story attachment, or repair materializes the required repositories.
Selection does not check out a branch, discard changes in the previous repository, or implicitly
select a Story. VS Code's normal unsaved-editor handling applies to the folder switch.

The folder alignment prevents subsequent session discovery in a new, correctly scoped Copilot
chat from listing the previously open repository's Stories. Existing chats and terminal history
are not retargeted. Start a new terminal in the ready repository and a new Copilot chat for that
context; a planned checkout path is not a working directory.
Use **Open** on the selected workspace row to reopen its folder if an older installation or a
terminal selection left a different native folder open.

The shell command `workspace use` records the machine-local selection but cannot change its
parent terminal's directory. CLI session commands still prefer a governed current directory;
use exact workspace/repository selectors to inspect another workspace from there. Background
selection updates do not force other VS Code windows to switch folders.

Workspace registration normally records the approved capability bindings and planned repository
paths without cloning application code. `workspace use` can select that workspace and reports the
repository as `missing` until files are needed. Starting work materializes the repositories
required by an unambiguous Story capability; attaching an existing Story can materialize its
selected deferred repository and safely select its branch. Generic intake
prepares the required workspace set when no exact binding is known. If files are needed earlier, run
`sflow workspace repair <WORKSPACE-DIRECTORY> --repository <REPOSITORY-ID>`.
From inside a saved workspace or one of its subdirectories, `sflow workspace status` and
`sflow workspace repair --repository <REPOSITORY-ID>` infer that workspace. Outside it, pass
the exact workspace directory; the last selected workspace is never repaired implicitly.
`workspace prepare --initialize` explicitly requests an immediate checkout and state
initialization; `--no-clone --initialize` is contradictory and refused. Mapping a capability reads
governed configuration, not application source.

If Windows or macOS briefly locks a new checkout, repair retries the final staging-to-target
move and rechecks ownership and target occupancy before every retry. A failed move preserves its original
error even if private staging cleanup is also locked; a completed move stays completed and reports
any retained staging path as a cleanup warning. Check `workspace status` before retrying a
failed clone; its target should be reported as `missing` or `empty`. Do not manually move or delete a
`.sflow-clone-*` directory, which may contain a partially cleaned private clone. A persistent
lock requires inspection of the process or filesystem policy holding that exact path. Repair
does not resume an abandoned staging directory and refuses a target observed as occupied.
The occupancy check is not an atomic no-replace directory move on macOS/Linux; keep external
processes from creating the same checkout path during the final claim.

New or changed repository checkout paths must work on both Windows and macOS: reserved device
names, noncanonical spellings, and paths that overlap another repository after case or Unicode
folding are refused. Older workspace manifests remain readable; an ambiguous legacy path appears
as `invalid-path` in workspace status and cannot be selected for Story work or materialized until
the conflicting checkout layout is corrected.

To attach an existing Story, first select the exact workspace/repository or pass the explicit
selectors to both commands:

```bash
singularity-flow session candidates --workspace <WORKSPACE> --repository <REPOSITORY-ID> --table
singularity-flow session open-local <WORK-ID> --workspace <WORKSPACE> --repository <REPOSITORY-ID> --json
singularity-flow session attach <WORK-ID> --workspace <WORKSPACE> --repository <REPOSITORY-ID> --json
```

The first command may discover a published Story using bounded remote metadata even before the
application checkout exists. Its `repositoryPath`, if present, is only the discovery source and
may be another checkout; it is **not** the Story destination. Attach verifies the exact selected
Story and materializes only the selected missing repository if needed. It reuses an existing
managed Story worktree, creates one to avoid switching another Story worktree, or may switch a
clean canonical checkout; an exact already-current branch can bind in place. Its returned `repositoryPath`
is the checkout to open. In a terminal, `cd` to that path; a child command cannot change the
terminal's current directory. Copilot `/sf-session` runs subsequent commands with that path as
cwd, and VS Code opens it after successful attachment. A remote-only URL candidate does not
authorize cloning by itself: an exact workspace/repository selection is required.

Session setup tries `open-local` first so an already managed local Story can be opened
without remote synchronization. Only `SESSION_LOCAL_STORY_UNAVAILABLE` or
`SESSION_LOCAL_REPOSITORY_UNAVAILABLE` permits the remote-attach fallback; other
refusals stop setup. For missing candidate evidence, use the same explicit selectors
with `session candidates --json --diagnostics`. Progress absent from durable evidence
is reported as unavailable, not estimated by chat.

To use a clone already on the machine, run `sflow workspace adopt <DIRECTORY> --id <ID> --base <DIRECTORY> --dry-run --json`. Review its canonical path, origin, branch, worktrees, submodules, SFlow configuration, changed paths, and preservation list. A dirty clone requires the exact content-aware hash returned by the preview in `--confirm-dirty`; changing file bytes invalidates it. Adoption creates a separate workspace shell and never fetches, checks out, stashes, commits, resets, cleans, or edits the clone remote.

Once a repository is in place, creation, adoption and repair queue a background index of its application code when that code fits the AST budget, so `sflow explain code --repository` can explain the whole repository from the start; the JSON result reports it as `codeIndex`. A larger repository is explained one folder at a time on request. The index never delays or fails the workspace operation.

`sflow workspace doctor` checks local prerequisites and unfinished setup records without contacting remotes. `--network` explicitly enables remote checks. Enterprise proxy and CA diagnostics expose configuration source names only, never URLs, paths, or credential material. If pre-Story initialization creates a local commit whose push is interrupted, inspect it with `sflow push status` and retry with `sflow push retry <INTENT-ID>`; retry first reads the destination ref and never force-pushes.

## State and safety

These commands can mutate governed or machine-local state: `workspace`, `session`. They remain subject to identity, authority, sequence, freshness, branch, worktree, and exact-confirmation checks. Signed handles are session-bound and are never shared between the shell, Copilot, and VS Code. Durable repository and workspace records are the shared source of truth.

## Troubleshooting

- If the selected Story or branch is wrong, stop and use `sflow home`, `sflow session`, or `sflow workspace list` before retrying.
- If `/sf-session` lists the previous repository's Stories, compare the open folder and terminal cwd with `workspace current --json`. Select the workspace in VS Code and start a new, correctly scoped chat or terminal; alternatively pass the exact workspace/repository selectors. A registry selection alone does not retarget an existing host session.
- If a Story appears in candidates but attach refuses it, use `session candidates --json --diagnostics` with the same exact workspace/repository selectors and follow its unavailable-object or Git-access diagnosis. Do not create a duplicate Story or switch another Story's checkout by hand.
- If a command refuses because state moved, refresh and use the newly rendered action instead of replaying an old handle or confirmation.
- If publication or synchronization is pending, follow the exact recovery command in the refusal and verify with `sflow doctor`.
- If a partial clone is refused, confirm the Git server supports upload-pack filtering or deliberately change the capability's clone fallback. Existing workspace clones are not silently rewritten.
- If setup fails, continue the same bootstrap ID rather than creating a second destination. Use `sflow workspace doctor --network` only when a network probe is intended.
- If a push outcome is unknown, use `sflow push status`; do not run a second ad-hoc push. SFlow recognizes an already-succeeded exact commit before retrying.
- If application files are absent, compare the capability source roots with its sparse cone. Source scope controls modelling; sparse cone controls which bytes are materialized.
- If a Copilot or VS Code action is unavailable, use the displayed CLI fallback; do not guess a command from the label.

## Related topics

Continue with `sflow explain developer-home`, `sflow explain capability-management`, `sflow explain repository-state-and-snapshots`.
