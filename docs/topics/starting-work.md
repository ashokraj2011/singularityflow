---
id: starting-work
title: Starting work
aliases:
  - start
  - intake
  - jira-intake
  - story-file
commands:
  - start
  - story
related:
  - epics-and-planning
  - pins
  - work-intervals
version: 6
---
Three intake doors, one result: Jira, a manual description, or a Story released from an Epic breakdown. For every new Jira or manual Story, first run `sflow workspace branches --json` and explicitly choose a branch published by every required repository. `sflow start PAY-1234 --jira --from-branch main` then refreshes that remote base, verifies that the configured remote can accept `PAY-1234`, creates the canonical branch, pins its exact base commit, and pushes only `refs/heads/PAY-1234`. The selected base ref is never changed. Existing and Epic-materialized Stories keep their already-pinned lineage instead of choosing a second base.

VS Code starts every Story in a dedicated linked Git worktree and opens that folder after the governed start commit lands. The checkout used to launch Start Work is never switched or cleaned, so a cancelled or unfinished Story can keep its uncommitted files while another Work ID starts independently. The CLI automatically uses the same isolation whenever its launch checkout is dirty; pass `--isolated-worktree` to request it from a clean checkout too. A failure before a durable Story exists removes only the disposable worktree and temporary branch. If a governed commit already exists, recovery retains the worktree and reports its exact path instead of deleting evidence.

## Built-in Story-start readiness

Story start includes one shared, read-only readiness check in the CLI, Copilot flow, and VS Code preview. Workflow choices come from the exact selected base (or the approved shared configuration), not from whichever branch happened to launch the form. Selecting another base refreshes the workflow catalog; a workflow absent from that base is cleared and must be chosen again. After the operator selects a base and workflow, readiness proves all of the following before a Story branch, approval-membership change, checkout, commit, or push is allowed:

- the approved configuration is pinned to one exact authority revision, or the selected base carries a validated legacy configuration;
- the chosen workflow resolves, its planned-claim policy is operational, and every phase has one installed default governed agent;
- every required repository has an exact base commit and Story destination ref, and the configured Git publication authority passed its preflight;
- optional intelligence remains optional: a missing World Model, AST pack, model provider, telemetry span, or Copilot plugin does not block Story creation.

The preview is provisional. `sflow start` recomputes it immediately before mutation so a configuration or remote change between preview and Start cannot reuse stale evidence. The successful result includes the readiness checks and a digest-bound receipt for the selected configuration commit, base commits, and destination refs.

Use this explicit preview when scripting or diagnosing Start:

- **Shell:** `singularity-flow workspace branches --json --intake --preflight-story PAY-1234 --from-branch main --work-type feature`
- **Copilot:** `/sf-start` runs and presents the same preflight after you choose the base and workflow.

Schema-compatible historical records are migrated in memory when they are read. Singularity Flow does not silently rewrite the shared configuration or state branches during Story start. When a persistent upgrade is required, readiness returns a user-reviewed route instead of partially creating the Story:

- **Shell:** `singularity-flow workspace reinitialize --dry-run --json`
- **Copilot:** `/sf-admin`

Review the returned plan and apply only its exact confirmation command. Re-run Start afterward; it will recompute readiness against the upgraded authority. This separation keeps upgrades recoverable and prevents a Story mutation from unexpectedly changing organization policy.

## Purpose and prerequisites

Use this topic when the current goal matches **starting work**. Start in a governed checkout unless the command explicitly operates on installation or machine-local workspace state. Run `sflow doctor` when setup, identity, credentials, or repository health is uncertain, and use `sflow status` or `sflow home` to confirm the selected work before a mutation.

## Use it from each surface

- **Shell:** `sflow start`, `sflow story`. Run `singularity-flow start --help` for the exact forms supported by this build.
- **Copilot:** `/sf-start`. The skill must preserve the CLI result and ask before any governed mutation.
- **VS Code:** open Singularity Flow **My Work and Workspaces**. The extension renders engine results; it does not independently decide lifecycle state.

## Guided workflow

1. Read the current state with `sflow home`, `sflow status`, or the relevant list/status form.
2. Review the repository, workspace, Work ID, configured remote, remote base branches, and workflow. Remote access is mandatory and no branch is preselected.
3. Run or review the Story-start readiness preview. Treat warnings about optional intelligence as advisory; resolve every workflow, agent, configuration-authority, and Git-publication blocker before continuing.
4. Preview or prepare the operation when the command offers a dry-run, plan, packet, or exact confirmation.
5. Run the smallest applicable command from this topic. Do not substitute an undocumented subcommand.
6. Re-read state after completion. In Copilot, return to `/sf-home`; in VS Code, refresh the relevant view if it has not already refreshed.

## State and safety

These commands can mutate governed or machine-local state: `start`, `story`. They remain subject to identity, authority, sequence, freshness, branch, worktree, and exact-confirmation checks. Signed handles are session-bound and are never shared between the shell, Copilot, and VS Code. Durable repository and workspace records are the shared source of truth.

## Troubleshooting

- If the selected Story or branch is wrong, stop and use `sflow home`, `sflow session`, or `sflow workspace branches --json` before retrying.
- If remote branch discovery or publication preflight fails, fix the configured Git remote before retrying. No Story branch or state has been created yet.
- If readiness reports a persistent configuration upgrade, preview it with `singularity-flow workspace reinitialize --dry-run --json` or `/sf-admin`. Do not hand-edit protected configuration in a Story branch.
- If only World Model, AST, model-provider, telemetry, or Copilot readiness is unavailable, continue: those facilities are non-blocking for Story creation.
- If a command refuses because state moved, refresh and use the newly rendered action instead of replaying an old handle or confirmation.
- If publication or synchronization is pending, follow the exact recovery command in the refusal and verify with `sflow doctor`.
- If a Copilot or VS Code action is unavailable, use the displayed CLI fallback; do not guess a command from the label.

## Related topics

Continue with `sflow explain epics-and-planning`, `sflow explain pins`, `sflow explain work-intervals`.
