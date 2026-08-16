---
id: capability-management
title: Capability mapping and activation
aliases:
  - capability
  - capability-map
commands:
  - capability
  - capabilities
related:
  - workspaces-and-sessions
  - configuration
  - workflow-authoring
version: 2
---
Capability changes are proposed, reviewed as an exact diff, and activated through the configuration authority. Collection capabilities organize; delivery capabilities name the repositories that ship.

## Purpose and prerequisites

Use this topic when the current goal matches **capability management**. Start in a governed checkout unless the command explicitly operates on installation or machine-local workspace state. Run `sflow doctor` when setup, identity, credentials, or repository health is uncertain, and use `sflow status` or `sflow home` to confirm the selected work before a mutation.

## Use it from each surface

- **Shell:** `sflow capability`, `sflow capabilities`. Run `singularity-flow capability --help` for the exact forms supported by this build.
- **Copilot:** `/sf-capabilities`. The skill must preserve the CLI result and ask before any governed mutation.
- **VS Code:** open Singularity Flow **Configuration Center**. The extension renders engine results; it does not independently decide lifecycle state.

## Guided workflow

1. Read the current map with `sflow capability organisation <LEAD-URL>`. Add `--refresh` when an explicit remote recheck is required.
2. Create a governed proposal with `sflow capability map` or `sflow capability edit --lead <LEAD-URL>`. Local `capability add`, `set`, and `remove` author only the checkout and never publish governed state.
3. Inspect the exact branch, commit, changed files, and diff with `sflow capability proposal` or **Configuration → Review proposals**.
4. Activate the exact reviewed commit. Flow dry-runs the push to `sflow/config`; if the remote permits the direct update, CLI callers must add `--acknowledge-unprotected` after reviewing that fact.
5. Verify the returned target commit, state projection, and activation-ledger receipt. Refresh the organisation view afterward.

## State and safety

The approved map lives on `sflow/config`; its orphan state-branch copy is a read mirror, not an independent write authority. Governed changes use proposal branches and exact activation. Activation uses a normal non-force push and appends a tamper-evident event containing proposer, approver, proposal and target commits, changed files, and the protection result. A provider rejection leaves the proposal available for its normal pull-request path.

Organisation reads prefer the state mirror, fall back to `sflow/config`, and cache validated results by the exact configuration commit. When the remote is unavailable, a cached result is marked `stale` and carries its age and remote error. `--refresh` bypasses a current cache entry; it cannot manufacture connectivity.

## Troubleshooting

- If the selected Story or branch is wrong, stop and use `sflow home`, `sflow session`, or `sflow workspace list` before retrying.
- If a command refuses because state moved, refresh and use the newly rendered action instead of replaying an old handle or confirmation.
- If publication or synchronization is pending, follow the exact recovery command in the refusal and verify with `sflow doctor`.
- If activation reports an unprotected authority, either configure remote protection or deliberately repeat it with `--acknowledge-unprotected`; never treat that flag as a generic retry switch.
- If an organisation result is stale, its choices remain usable for inspection, but refresh before proposing or activating a change.
- If a Copilot or VS Code action is unavailable, use the displayed CLI fallback; do not guess a command from the label.

## Related topics

Continue with `sflow explain workspaces-and-sessions`, `sflow explain configuration`, `sflow explain workflow-authoring`.
