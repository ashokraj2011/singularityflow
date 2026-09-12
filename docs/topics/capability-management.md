---
id: capability-management
title: Capability mapping and activation
aliases:
  - capability
  - capability-map
commands:
  - capability
  - capabilities
  - why
questions:
  - Where is the capability map maintained?
  - How does a capability map reach a new laptop?
  - What happens when a capability already has a proposal?
related:
  - workspaces-and-sessions
  - configuration
  - workflow-authoring
version: 9
---
Capability changes are proposed, reviewed as an exact diff, and activated through the configuration authority. Collection capabilities organize; delivery capabilities name the repositories that ship.

An ordinary initialized repository needs no map: it resolves as the deterministic implicit
`repository-root`, shown as **This repository**. Use `sflow capability show [PATH]` or `sflow why
[PATH]` to see ownership, permitted scope, approvers, and the exact resolution. The first
`capability add`, `protect`, or `depend` command materializes that same root inside a review proposal;
it never changes existing Story pins. See `docs/PROGRESSIVE-CAPABILITIES.md`.

## Purpose and prerequisites

Use this topic when the current goal matches **capability management**. Start in a governed checkout unless the command explicitly operates on installation or machine-local workspace state. Run `sflow doctor` when setup, identity, credentials, or repository health is uncertain, and use `sflow status` or `sflow home` to confirm the selected work before a mutation.

## Use it from each surface

- **Shell:** `sflow capability`, `sflow capabilities`. Run `singularity-flow capability --help` for the exact forms supported by this build.
- **Copilot:** `/sf-capabilities`. The skill must preserve the CLI result and ask before any governed mutation.
- **VS Code:** open Singularity Flow **Configuration Center**. The extension renders engine results; it does not independently decide lifecycle state.

## Guided workflow

1. Begin with the exact credential-free Git URL and run `sflow capability inspect-repository <GIT-URL> --json`. This follows a verified repository state link or checks a self-hosted map; it does not fan out over the laptop cache. Add `--lead <LEAD-URL>` only when that authority was explicitly selected, `--search-known` only for an explicit compatibility search, and `--refresh` when a fresh remote check is required.
2. Branch on the lookup result before asking for capability metadata. Reuse `already-mapped`; resolve every `ambiguous` match to one explicit lead; and treat `unreachable` or partial `inconclusive` results as unknown rather than new. With no registered authority, the target is also checked for a self-hosted approved map; an ungoverned target can become the first authority only after an explicit choice. `not-onboarded` is scoped to the approved maps reported in `checkedLeads`. `known-repository-unassigned` means the repository exists in the map but is not attached to a capability. A bounded pending-proposal scan returns matching unmerged proposals for review; partial or unavailable proposal coverage blocks a new mapping.
3. Only after the contributor explicitly requests more detail, use `sflow capability add <ID> --owns <DIRECTORY>`, `capability protect <PATH>`, or `capability depend <TARGET>@<REFERENCE>`. These create governed proposals. Keep `capability map` and remote `capability edit` as expert multi-repository compatibility flows.
4. Inspect the exact branch, commit, changed files, and diff with `sflow capability proposal` or **Configuration → Review proposals**.
5. If inspection reports independent approved authorities, preview `sflow capability reconcile <DELIVERY-URL> --canonical-lead <URL> --json`. Review its exact commits, map digests, and single state-link write, then repeat with the returned `--confirm-plan` only after choosing the canonical authority. Reconciliation never deletes the competing map.
6. Use `sflow capability fsck --repository <DELIVERY-URL> --json` to verify portable discovery from a delivery repository. Add `--search-known` only when no state link exists and an explicit compatibility search is intended.
7. Activate the exact reviewed commit. A Git dry run does not execute receive hooks, so Flow never treats it as protection evidence. Merge through repository review, or explicitly add `--acknowledge-unprotected` before Flow attempts one real exact-CAS update to `sflow/config`.
8. Verify the returned target commit, state projection, and activation-ledger receipt. Refresh the organisation view afterward.

Run `singularity-flow capability fsck --lead <URL>` whenever proposal history or
the state projection looks inconsistent, or a workspace says its selected capability
does not exist. It checks every registered workspace binding against the approved map
and returns exact branches, commits, issue classifications, and remediation commands
without changing a ref. An unrelated-history proposal cannot be reviewed or merged.
Recreate it from current `sflow/config`, or
discard only the fsck-reported ref with:

```bash
singularity-flow capability discard-proposal <REVIEW-BRANCH> --lead <URL> \
  --confirm <FULL-COMMIT> --reason "configuration authority was re-created" --json
```

The remote-SHA lease refuses a branch that moved. A valid proposal is never eligible
for stale discard, and approved configuration, state, application branches, and other
proposal branches are preserved.

For a delivery in a large monorepo, **Map a capability** also records two independent boundaries. **World-model application/shared roots** decide which paths can ground this capability. **Clone strategy/sparse checkout directories** decide which bytes a new workspace materializes. Prefer `blobless-sparse` with `fallback: refuse`; Flow always includes its governed configuration and agent contracts. These settings are reviewed and activated with the rest of the capability proposal rather than stored as an ungoverned developer preference.

In VS Code, select a capability to navigate its direct parent and children. **Add child** opens the mapping form with the selected parent prefilled. To move an existing capability, change **Linked under** and save; the engine stores one canonical parent link and derives the parent's child list from it, so both views update together.

To remove a capability that still has children, choose where those direct children should move. The relink and removal are validated as one proposal. From the shell, use `--reparent-children-to <ID>` or pass an empty value to move the direct children to the top level. Removal updates the current approved map but does not erase older reviewed revisions from Git history.

## State and safety

The approved map lives on `sflow/config`; its orphan state-branch copy is a read mirror, not an independent write authority. Governed changes use proposal branches and exact activation. Activation uses an exact leased update and appends a tamper-evident event containing proposer, approver, proposal and target commits, changed files, and the protection result. A provider rejection leaves the proposal available for its normal pull-request path; only explicit pull-request, review, or protection evidence is classified as review-required.

The same information appears in several places for different reasons:

| Location | Purpose | Authority |
| --- | --- | --- |
| Lead repository `sflow/config:singularity/capabilities.yml` | Reviewed capability and repository membership | **Authoritative** |
| Lead repository `state` configuration mirror | Exact, manifest-bound read copy of the approved configuration | Verified projection only |
| Delivery repository `state:singularity/capability-authority.json` | Tells a new laptop which lead and capability IDs to verify | Routing link only |
| Story branch `singularity/capabilities.yml` | Immutable configuration pinned when that Story started | Authority for that Story only |
| Workspace manifest, lead registry, and organisation cache | Navigation and performance | Disposable local projection |

Reading a map therefore does not copy a new YAML file onto an application `main` branch. The
reader follows the delivery link, observes the lead's exact `sflow/config` commit, verifies the
catalog, and mounts those bytes as a request-local configuration overlay. Story start is the point
at which that exact approved YAML is materialized and committed for the Story. This prevents a
machine-local shadow file from silently becoming organisation policy.

After upgrading SFlow, use `singularity-flow workspace reinitialize --dry-run` to preview a safe
configuration reconciliation. Apply only the returned exact plan with
`singularity-flow workspace reinitialize --confirm-plan <PLAN-ID>`. It refreshes packaged workflow,
templates, prompts, and agents through the existing three-way merge, verifies schema readability,
republishes the state projection and delivery routing links, and rebuilds only derived caches.
Repository overrides are preserved unless the reviewed plan explicitly resolves a conflict to the
bundled value. Immutable evidence is never rewritten; registered older schemas are migrated in
memory when read, while an unsupported future schema requires a newer SFlow build. Factory reset
remains a separate destructive recovery and is not the normal upgrade path. In Copilot, use
`/sf-admin reinitialize` for the same plan-first flow.

Organisation reads prefer the state mirror, fall back to `sflow/config`, and keep a derived cache keyed to the exact observed configuration commit. Read-only screens may reuse that cache; operations that clone, attach, detach, or otherwise mutate state force a fresh authoritative Git read. When the remote is unavailable, a cached result is marked `stale` and carries its age and remote error. `--refresh` bypasses a current cache entry; it cannot manufacture connectivity.

## Troubleshooting

- If repository inspection returns `already-mapped`, use the returned capability rather than creating a duplicate. If it returns `ambiguous`, select one exact lead and inspect again.
- If `pendingMatches` is non-empty, review or activate the named proposal instead of creating another one. If `proposalCoverage` is not `complete`, repair authority access or reduce the pending proposal backlog and inspect again.
- If repository inspection is `unreachable` or `inconclusive`, repair access and retry with `--refresh`; a failed lookup is not evidence that the repository is new.
- If `not-onboarded` has no checked leads, select or register a lead before deciding whether to create a mapping.
- If the selected Story or branch is wrong, stop and use `sflow home`, `sflow session`, or `sflow workspace list` before retrying.
- If a command refuses because state moved, refresh and use the newly rendered action instead of replaying an old handle or confirmation.
- If publication or synchronization is pending, follow the exact recovery command in the refusal and verify with `sflow doctor`.
- If activation reports an unprotected authority, either configure remote protection or deliberately repeat it with `--acknowledge-unprotected`; never treat that flag as a generic retry switch.
- If an organisation result is stale, its choices remain usable for inspection, but refresh before proposing or activating a change.
- If a Copilot or VS Code action is unavailable, use the displayed CLI fallback; do not guess a command from the label.
- If fsck reports unrelated proposal history, never force-merge or rebase it into `sflow/config`. Use **Discard stale proposal** only after reviewing its exact commit, or create a fresh map proposal from the current authority.
- If removal is refused because the capability still contains children, choose a replacement parent in VS Code or pass `--reparent-children-to`; descendants of the removed capability are intentionally unavailable because they would create a cycle.

## Related topics

Continue with `sflow explain workspaces-and-sessions`, `sflow explain configuration`, `sflow explain workflow-authoring`.
