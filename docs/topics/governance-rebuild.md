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
version: 2
---
A governance rebuild moves a repository onto the current Singularity Flow governance model in one
reviewed operation. Preview it first; the preview changes nothing.

## Purpose and prerequisites

Use this topic when a new release changes what governance means (how responsibilities, evidence and
completion are judged) and the repository's existing workflows and Stories were created under the
older rules. Commit or discard any edit under `singularity/` or `.github/` first: the rebuild works
from committed configuration and refuses to rebuild over uncommitted governance changes.

## Use it from each surface

- **Shell:** `sflow governance rebuild --dry-run` prints the plan; `--confirm-plan grb-...` activates
  exactly that plan; `sflow governance restore --plan grb-... --dry-run` previews undoing it. Add
  `--json` for the complete record.
- **Copilot:** `/sf-governance-rebuild` runs the preview and relays it in full. It confirms a plan
  only after the contributor gives the exact plan digest, never on its own.
- **VS Code:** not available yet. Run the shell command from the integrated terminal.

## Guided workflow

1. Commit or discard every edit under `singularity/` and `.github/`.
2. Fetch the remote if teammates may have pushed Story branches since your last fetch; the preview
   reads remote branches as they were last fetched.
3. Run `sflow governance rebuild --dry-run` and review every replaced file, kept setting, workflow and
   Story it lists.
4. Repair any blocker, or any repository workflow you want to keep usable, then preview again.
5. Confirm the exact plan: `sflow governance rebuild --confirm-plan grb-...`, adding
   `--accept-inactive` with every failing repository workflow the preview named.
6. Push the branch so teammates receive the rebuilt configuration and the archive registry.

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
as they were.

Activation re-checks the plan, then:

- backs up the checked-out branch, the configuration authority and every Story branch to a verified
  Git bundle with a manifest under `.git/singularity-flow/governance-backups/<plan>/`;
- writes the rebuilt framework files, the archive registry `singularity/governance/archive.json` and
  the receipt `singularity/governance/rebuilds/<plan>.json` as one commit on the checked-out branch,
  through a private index, so other staged work is untouched;
- proves the commit changed nothing else, moved no other ref and kept every repository-owned
  definition, and refuses (`GOVERNANCE_REBUILD_INVARIANT_BROKEN`) otherwise.

A rebuild never touches application code, tests, source documents, repository-owned workflow and
agent definitions, or Git history. Every archived Story stays readable; any command that would change
one refuses with `STORY_ARCHIVED_BY_REBUILD`, because a Story cut before the rebuild still finds the
registry on the branch it was cut from. `sflow governance restore` puts back every file a rebuild
changed as one new commit, which makes its Stories changeable again.

This build activates a rebuild when the configuration lives in the checkout. A repository whose
configuration lives on a configuration authority branch can preview but not yet activate one.

## Troubleshooting

- `GOVERNANCE_REBUILD_CONFIGURATION_DIRTY`: commit or discard the listed governance edits.
- `GOVERNANCE_REBUILD_FRAMEWORK_WORKFLOW_FAILING`: a packaged workflow did not compile; upgrade the
  installed package or report it, because the rebuild cannot activate past it.
- `GOVERNANCE_REBUILD_STORY_UNREADABLE`: a Story branch holds state this build cannot read; repair or
  remove that branch before rebuilding.
- `GOVERNANCE_REBUILD_PLAN_STALE`: something moved since the preview; preview again.
- `GOVERNANCE_REBUILD_INACTIVE_UNCONFIRMED`: name exactly the failing repository workflows the preview
  listed with `--accept-inactive`, or repair them.
- `GOVERNANCE_REBUILD_AUTHORITY_UNSUPPORTED`: the configuration lives on a configuration authority
  branch; this build cannot activate a rebuild there yet.
- `STORY_ARCHIVED_BY_REBUILD`: the Story was archived; start a new Story.

## Related topics

- `sflow explain resets-and-cleanup` for factory reset and safe reinitialization.
- `sflow explain workflow-authoring` for how workflows and their responsibilities are defined.
- `sflow explain evidence-matrix` for how evidence and completion are judged.
