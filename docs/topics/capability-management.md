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
version: 11
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

Activation is staged, so a failure after the configuration ref advances is reported as partial
completion rather than rolled back or called complete:

| Reported status or code | Durable state | Safe next action |
| --- | --- | --- |
| `activation-pending` | Proposal retained; approved configuration unchanged | Repair the reported Git failure and retry the exact activation |
| `CAPABILITY_ACTIVATION_AUDIT_PENDING` | Configuration active; activation audit absent | Re-run the returned activation command so SFlow proves and records the original accepted target |
| `activation-complete-projection-pending` | Configuration and audit active; state mirror incomplete | Run the returned `capability publish` command |
| `activation-complete-portability-pending` | Configuration, audit, and map projection active; one or more delivery links incomplete | Run the returned `capability publish` command and verify delivery links |
| `activated` | Configuration, audit, projection, and required portability links complete | Refresh the organisation view |

Recovery binds the original proposal and accepted target commits. It never substitutes a newer
`sflow/config` head, invents an approver, duplicates the audit after an uncertain push, or overwrites
a newer state projection. `activated: true` means configuration authority advanced; inspect
`status`, `audit`, `projection`, and `portability` before treating the whole operation as complete.

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

Capability proposal publication is an exact Git transaction. SFlow captures an explicitly
Git-configured author name and email before entering its isolated enterprise transport, creates one
immutable proposal commit, pushes with create-only and approved-base leases, and then observes the
exact remote ref. A lost
response after the server accepted the push therefore becomes recovered success, not a duplicate
proposal. A different remote commit is a conflict; a proven-absent ref is safe to retry; and an
unreachable ref is reported as an unknown outcome with the exact local commit, guarded refs, and
structured inspection/retry argv retained. Recovery never rebuilds a partial mutation from a
displayed error or edited form. Confirmed remote success is not reversed by failure to update the
machine-local lead shortcut or delete a temporary checkout. The full state machine and failure
contract are documented in
[Capability-map Git robustness](../CAPABILITY-MAP-GIT-ROBUSTNESS-PLAN.md).

Pending-proposal inspection is bounded at every layer. Merged history is paged without consuming
the 64 active/unreadable-proposal budget. Each explicit Git fetch stops at either 64 refspecs or
24 KiB of conservatively encoded Windows UTF-16 argv, so long names produce smaller pages. Finally,
4,096 advertised proposal refs is an absolute resource ceiling. The current approved-base suffix is
prioritized before that ceiling is applied. If the whole authority cannot be covered, the result is
`partial` and Map remains disabled; the ceiling is never treated as proof that no proposal exists.

VS Code persists the exact validated Map argv before it launches Git. **Cancel safely**, closing the
panel, or an interrupted CLI result moves the operation to **Inspect remote outcome**. That read can
open the existing same-ID proposal, recognize an already-approved capability, or enable **Retry
exact request** only after neither is found. A late authority change remains an engine-level
conflict; the UI does not overwrite it.

Organisation reads prefer the state mirror, fall back to `sflow/config`, and keep a derived cache keyed to the exact observed configuration commit. Read-only screens may reuse that cache; operations that clone, attach, detach, or otherwise mutate state force a fresh authoritative Git read. When the remote is unavailable, a cached result is marked `stale` and carries its age and remote error. `--refresh` bypasses a current cache entry; it cannot manufacture connectivity.

## Troubleshooting

- If repository inspection returns `already-mapped`, use the returned capability rather than creating a duplicate. If it returns `ambiguous`, select one exact lead and inspect again.
- If `pendingMatches` is non-empty, review or activate the named proposal instead of creating another one. If `proposalCoverage` is not `complete`, repair authority access or reduce the pending proposal backlog and inspect again.
- If repository inspection is `unreachable` or `inconclusive`, repair access and retry with `--refresh`; a failed lookup is not evidence that the repository is new.
- If `not-onboarded` has no checked leads, select or register a lead before deciding whether to create a mapping.
- If the selected Story or branch is wrong, stop and use `sflow home`, `sflow session`, or `sflow workspace list` before retrying.
- If a command refuses because state moved, refresh and use the newly rendered action instead of replaying an old handle or confirmation.
- If publication or synchronization is pending, follow the exact recovery command in the refusal and verify with `sflow doctor`.
- If activation reports `CAPABILITY_ACTIVATION_AUDIT_PENDING`, do not recreate the proposal. Correct the named commit-identity or signing problem and rerun its exact activation command; SFlow reuses only the proven original activation event.
- If activation is complete but projection or portability is pending, run the returned `capability publish` action. Do not merge or reset `sflow/config` again.
- If recovery reports `CAPABILITY_ACTIVATION_RECOVERY_CONFLICT`, fetch or restore the exact authority/ledger history named in the diagnostic. A newer branch head is not evidence of the original approval.
- If a push is reported as `outcome-unknown`, run the returned exact proposal inspection before retrying. Do not delete or recreate the branch based only on a timeout.
- If Map reports `CAPABILITY_AUTHOR_IDENTITY_REQUIRED`, configure both values explicitly with `git config --global user.name "Your Name"` and `git config --global user.email you@example.com`, then retry. The operating-system account name is not governed Git authorship.
- If proposal coverage is `partial`, review/retire the remote proposal backlog or raise the issue with the capability-map owner. Do not bypass the 4,096-ref safety ceiling or assume an uninspected proposal is absent.
- If Git reports `REMOTE_POLICY_REJECTED`, review the named repository rule or server hook. SFlow does not bypass signed-commit, naming, review, or protected-branch policy.
- If Git reports `REMOTE_ATOMIC_PUSH_UNSUPPORTED`, use the returned reviewed recovery path or an authority provider that supports the required atomic update; SFlow does not silently downgrade a multi-ref safety boundary.
- When Git prints an explicit TLS, repository-policy, or atomic-capability refusal before a later timeout or disconnect, SFlow keeps the timeout in diagnostic evidence but presents the explicit actionable cause and recovery guidance.
- If activation reports an unprotected authority, either configure remote protection or deliberately repeat it with `--acknowledge-unprotected`; never treat that flag as a generic retry switch.
- If an organisation result is stale, its choices remain usable for inspection, but refresh before proposing or activating a change.
- If a Copilot or VS Code action is unavailable, use the displayed CLI fallback; do not guess a command from the label.
- If fsck reports unrelated proposal history, never force-merge or rebase it into `sflow/config`. Use **Discard stale proposal** only after reviewing its exact commit, or create a fresh map proposal from the current authority.
- If removal is refused because the capability still contains children, choose a replacement parent in VS Code or pass `--reparent-children-to`; descendants of the removed capability are intentionally unavailable because they would create a cycle.

The deterministic suites exercise these behaviors on local Git providers and extension-host
fixtures. Final release proof on a new office laptop still includes its real Git for Windows,
Credential Manager/SSO, proxy/CA, antivirus/file locks, VS Code build, and server-side policy text.

## Related topics

Continue with `sflow explain workspaces-and-sessions`, `sflow explain configuration`, `sflow explain workflow-authoring`.
