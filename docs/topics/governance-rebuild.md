---
id: governance-rebuild
title: Rebuild governance onto the current model
aliases:
  - governance
  - rebuild
  - rebuild-governance
questions:
  - How do I move an onboarded repository onto the current governance model?
  - What does a governance rebuild replace, keep and archive?
  - What happens to a custom workflow that no longer compiles?
commands:
  - governance
related:
  - resets-and-cleanup
  - workflow-authoring
  - evidence-matrix
version: 1
---
A governance rebuild moves a repository onto the current Singularity Flow governance model in one
reviewed operation. Preview it first; the preview changes nothing.

## Purpose and prerequisites

Use this topic when a new release changes what governance means (how responsibilities, evidence and
completion are judged) and the repository's existing workflows and Stories were created under the
older rules. Commit or discard any edit under `singularity/` or `.github/` first: the rebuild works
from committed configuration and refuses to rebuild over uncommitted governance changes.

## Use it from each surface

- **Shell:** `sflow governance rebuild --dry-run` prints the plan; add `--json` for the complete
  record. This build previews only; it cannot activate a rebuild yet.
- **Copilot:** `/sf-governance-rebuild` runs the preview and relays it in full. It never confirms a
  plan on the contributor's behalf.
- **VS Code:** not available yet. Run the shell command from the integrated terminal.

## Guided workflow

1. Commit or discard every edit under `singularity/` and `.github/`.
2. Fetch the remote if teammates may have pushed Story branches since your last fetch; the preview
   reads remote branches as they were last fetched.
3. Run `sflow governance rebuild --dry-run` and review every replaced file, kept setting, workflow and
   Story it lists.
4. Repair any blocker, or any repository workflow you want to keep usable, then preview again.

## What the preview shows

The preview exports the approved configuration (the configuration authority branch when the
repository has one, otherwise the committed checkout) into a scratch directory and rebuilds it there:

- **Framework files replaced:** every packaged workflow, template and agent the repository has not
  taken ownership of, with its old and new digest.
- **Repository settings kept:** values the repository changed, such as its approval security
  profile, kept exactly as they are.
- **Workflows:** every workflow, packaged and repository-owned, recompiled under the current rules.
  A failing workflow shows its findings and the action that repairs it.
- **Stories to archive:** every Story on the checkout, its local branches and its remote-tracking
  branches, with the branch tips the plan binds. Remote branches are read as last fetched.
- **Blockers:** anything that prevents activation.

The plan digest (`grb-...`) binds the configuration commit, the replaced files, the workflows and
every Story branch tip. Any change to one of them produces a different digest.

## Failing workflows

Every packaged workflow must compile; a packaged workflow that does not is a blocker. A
repository-owned workflow that does not compile is never edited or deleted: it stays byte-identical
and Story start refuses it (`WORKFLOW_OBLIGATIONS_UNMET`) until it is repaired. Activation proceeds
past it only when the confirmation names it with `--accept-inactive`.

## State and safety

The preview writes only a scratch directory it removes; the checkout, its index and every ref stay
as they were. A rebuild never touches application code, tests, source documents, repository-owned
workflow and agent definitions, or Git history, and archived Stories stay readable.

## Troubleshooting

- `GOVERNANCE_REBUILD_CONFIGURATION_DIRTY`: commit or discard the listed governance edits.
- `GOVERNANCE_REBUILD_FRAMEWORK_WORKFLOW_FAILING`: a packaged workflow did not compile; upgrade the
  installed package or report it, because the rebuild cannot activate past it.
- `GOVERNANCE_REBUILD_STORY_UNREADABLE`: a Story branch holds state this build cannot read; repair or
  remove that branch before rebuilding.
- `GOVERNANCE_REBUILD_ACTIVATION_UNAVAILABLE`: this build previews only.

## Related topics

- `sflow explain resets-and-cleanup` for factory reset and safe reinitialization.
- `sflow explain workflow-authoring` for how workflows and their responsibilities are defined.
- `sflow explain evidence-matrix` for how evidence and completion are judged.
