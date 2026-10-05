---
id: configuration
title: Configuration, capabilities, and the policy fold
aliases:
  - workflow-yml
  - sflow-config
  - capabilities
  - policy-fold
related:
  - pins
  - quick-fix
  - escalation
version: 3
commands:
  - configuration
  - workflow
---
`main` holds application code; `sflow/config` holds approved configuration; a story branch receives an exact copy at creation. Configuration changes ride review branches with PR discipline — including capability-tree edits. The effective policy for a story is a fold: workflow defaults → work-type overrides → capability constraints (root to leaf), where later layers may tighten but never weaken — protected paths union, approval floors hold, a capability's self-approval ban cannot be re-allowed downstream. The fold runs once at start and pins; everything downstream reads the folded result.

## Purpose and prerequisites

Use this topic when the current goal matches **configuration**. Start in a governed checkout unless the command explicitly operates on installation or machine-local workspace state. Run `sflow doctor` when setup, identity, credentials, or repository health is uncertain, and use `sflow status` or `sflow home` to confirm the selected work before a mutation.

## Use it from each surface

- **Shell:** `sflow configuration`, `sflow workflow`. Run `singularity-flow configuration --help` for the exact forms supported by this build.
- **Copilot:** `/sf-help` followed by the documented CLI fallback. The skill must preserve the CLI result and ask before any governed mutation.
- **VS Code:** open Singularity Flow **Configuration Center**. The extension renders engine results; it does not independently decide lifecycle state.

## Guided workflow

1. Read the current state with `sflow home`, `sflow status`, or the relevant list/status form.
2. Review the repository, workspace, Work ID, phase, actor, and any warnings before selecting an action.
3. Preview or prepare the operation when the command offers a dry-run, plan, packet, or exact confirmation.
4. Run the smallest applicable command from this topic. Do not substitute an undocumented subcommand.
5. Re-read state after completion. In Copilot, return to `/sf-home`; in VS Code, refresh the relevant view if it has not already refreshed.

## State and safety

### Test setup

Open **Capabilities → Test setup**, **Configuration Center → Test setup**, or the command palette's
**Singularity Flow: Capability Test Setup**. Inspect exact module directories, then explicitly choose
the workflow and phase. Review inferred commands before adding them to the draft, or enter an exact
argv array, module directory, result adapter/report path, affected directories and timeout.
Saving uses the ordinary reviewed `sflow/config` proposal; non-test commands and other workflows
are preserved. Shared-phase edits affect every workflow that inherits that phase.

Copilot `/sf-test-setup` reads bounded repository manifests and reporter configuration, explains
the evidence behind its suggestions, and asks before configuration changes or test execution.
Shell `singularity-flow capability test-setup --source-root apps/client --json` provides deterministic
suggestions without executing tests, cloning, or scanning a monorepo recursively. Without a scope
it inspects only the repository root. Missing detection remains pending, not a test failure.

Existing Stories retain their configuration pin. An approved command-only revision can be reviewed
for adoption in the **current code phase** through `singularity-flow story test-policy amend <WORK-ID>
--phase <PHASE> --reason "Configure the previously undetected test runner" --json` and `/sf-recover`.
Authored code/documents are preserved; fresh execution evidence is required. Inspection alone
does not establish the pre-code failure baseline, accept failures, or alter intake's test-scope choice.

These commands can mutate governed or machine-local state: `configuration`, `workflow`. They remain subject to identity, authority, sequence, freshness, branch, worktree, and exact-confirmation checks. Signed handles are session-bound and are never shared between the shell, Copilot, and VS Code. Durable repository and workspace records are the shared source of truth.

## Troubleshooting

- If the selected Story or branch is wrong, stop and use `sflow home`, `sflow session`, or `sflow workspace list` before retrying.
- If a command refuses because state moved, refresh and use the newly rendered action instead of replaying an old handle or confirmation.
- If publication or synchronization is pending, follow the exact recovery command in the refusal and verify with `sflow doctor`.
- If a Copilot or VS Code action is unavailable, use the displayed CLI fallback; do not guess a command from the label.

## Related topics

Continue with `sflow explain pins`, `sflow explain quick-fix`, `sflow explain escalation`.
