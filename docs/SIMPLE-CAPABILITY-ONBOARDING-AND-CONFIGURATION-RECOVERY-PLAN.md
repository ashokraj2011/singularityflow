# Simple capability onboarding and configuration recovery

Status: implemented

Scope: capability onboarding, `state` discovery, `sflow/config` recovery, current-v2 packaged-seed reconciliation, and workspace handoff

Non-goal: weakening Git integrity, overwriting an unrelated `state` branch, or silently discarding custom configuration

## Outcome

A contributor supplies a repository URL once. Singularity Flow returns one understandable status
and one primary action. A recognized SFlow `state` branch is enough to resume the appropriate
onboarding path on a new laptop. A missing `sflow/config` branch is recoverable from a complete
state configuration mirror or its verified retained history. Fresh setup and explicit recreation
can build the installed workflow-v2 configuration, while migration reconciles only recognized
packaged assets in an already current workflow-v2 configuration and preserves custom bytes.

Normal screens do not expose authority pins, projection commits, cache leases, or repeated Git
checks. Those details remain available under diagnostics.

## Why this is needed

Before this feature, the implementation had the necessary pieces but presented them as separate
journeys:

- Story configuration resolution already accepts a completely verified state mirror when
  `sflow/config` is absent (`resolveRemoteStoryConfigurationAuthority`).
- Capability discovery first requires `sflow/config`; a valid state mirror therefore cannot recover
  capability onboarding by itself (`readOrganisation`).
- Delivery repositories can carry a portable capability-authority locator on `state`, but the
  locator and a full configuration mirror are intentionally different records.
- Safe workspace reinitialization restores registered framework seeds, but it is workspace-registry
  dependent and deliberately excludes capability publication.
- The Map and Workspace panels re-read the same configuration identity during handoff. A transient
  Git failure can therefore stop a repository that was inspected successfully seconds earlier.

The implementation unifies these pieces behind one repository-centric onboarding operation.

## Product rule

The simple rule shown to users is:

> If the repository contains recognized SFlow state, resume from it. If `sflow/config` is missing,
> restore it from the verified mirror or retained history. If current workflow-v2 configuration is
> missing or has retired packaged seeds, offer current setup, recreation, or packaged-seed
> reconciliation as appropriate.

`--migrate` does not convert an unsupported workflow-v1 configuration to workflow v2. A v1 or
otherwise unsupported older workflow is left unchanged and can only enter the explicit
`--recreate` path, whose preview lists every path that will not be carried forward.

Internally, a branch merely named `state` is not sufficient. Singularity Flow performs one bounded
read of the observed state commit and recognizes one of these records:

1. A complete `configuration/manifest.json` mirror with matching file hashes and Git object
   identities.
2. A valid `singularity/capability-authority.json` locator bound to this delivery repository.
3. Valid SFlow lifecycle/ledger records but no capability record.
4. No recognized SFlow marker, or a corrupt marker.

This validation is automatic and is not presented as an authority choice.

## One state model

| Internal observation | User status | Meaning | Primary action |
| --- | --- | --- | --- |
| Current `sflow/config`; matching state mirror or delivery locator | **Ready** | Existing onboarding is usable | **Continue** |
| Full valid state configuration mirror; `sflow/config` absent | **Ready to restore** | This repository owns recoverable configuration | **Restore and continue** |
| Full valid state mirror or config using workflow v2 with missing or recognized retired packaged assets | **Update available** | Custom bytes are preserved while packaged seeds are reconciled | **Migrate and continue** |
| Valid delivery locator | **Linked to team configuration** | Follow the named lead; never create `sflow/config` in the delivery repository | **Continue** |
| Valid lifecycle state only | **SFlow repository · capability not mapped** | Repository history is recognized, but capability ownership is not inferred | **Map capability** |
| No state and no config | **Not set up** | New repository | **Set up SFlow** |
| State branch with no valid SFlow marker | **State branch not recognized** | It may belong to the application; do not overwrite it | **Choose another state branch** |
| Git cannot be observed | **Could not check Git** | No ownership conclusion is possible | **Retry** |
| Conflicting full mirrors, locators, or leads | **Needs a choice** | The conflict must be resolved explicitly | **Review choices** |

Normal inspection requires a live Git observation. `--reset-local` is the only onboarding mode that
works offline because it neither observes nor mutates remote refs.

## User experience

### Map a capability

Keep the Git URL first. Replace the current authority-oriented result with a single **Repository
setup** card:

- Status and one sentence explaining it.
- One primary button from the state model above.
- A **More options** menu containing **Migrate configuration**, **Recreate configuration**,
  **Reset local registration**, and **Diagnostics** only when applicable.
- The capability form appears after setup is resolved; it is not mixed with Git recovery choices.

Do not show normal users configuration SHA values, authority/pin terminology, cache ages, bootstrap
IDs, or separate “verify”, “refresh pin”, and “offline pin” actions.

### Workspace creation

The successful onboarding result carries a bounded repository-setup receipt into workspace
creation. Workspace selection uses that receipt and does not run another complete organisation read.
It checks only that the relevant remote ref has not changed before applying the workspace plan.

If the ref changed, refresh the card and regenerate the plan. Report **Repository setup changed;
review the refreshed result** instead of a generic authority failure.

### Maintenance entry point

Add **Singularity Flow: Repair or upgrade repository setup** to the Command Palette and the
Configuration Center. It accepts a Git URL or an existing clone and opens the same Repository setup
card. It does not require an already registered workspace.

## CLI contract

Introduce one idempotent front door:

```text
singularity-flow capability onboard <REPOSITORY-URL> --dry-run --json
singularity-flow capability onboard <REPOSITORY-URL> --confirm-plan <PLAN-ID> --json
```

Optional explicit modes:

```text
singularity-flow capability onboard <REPOSITORY-URL> --migrate --dry-run --json
singularity-flow capability onboard <REPOSITORY-URL> --recreate --dry-run --json
singularity-flow capability onboard <REPOSITORY-URL> --reset-local --dry-run --json
```

Copilot route: `/sf-capability-map`. The skill relays the plan and asks for confirmation; it does not
invent a recovery mode.

The preview returns `repository-onboarding-plan/v1` containing:

- repository identity and observed refs;
- recognized state kind: `configuration-mirror`, `delivery-locator`, `lifecycle-only`, `none`, or
  `invalid`;
- current/configured schema versions;
- exact proposed effects and preserved data;
- one `planId` bound to the observed refs and selected mode;
- the next Shell and Copilot commands.

Existing inspection, FOS, and reinitialization commands remain compatible for one release but route
their normal UI entry points through this operation.

## Engine design

### 1. One bounded discovery

Use one `GitRemoteSession` advertisement for the relevant refs: `sflow/config`, configured/canonical
`state`, portable locator refs, and proposal prefixes when required. Fetch only the selected state or
configuration snapshot. Reuse the resulting observation through inspection, rendering, and
workspace handoff.

Do not repeat `capability organisation --refresh` merely because the user moved from Map to
Workspaces.

### 2. State classifier

Create one shared state classifier used by capability onboarding, Story startup, repository repair,
and workspace creation. Precedence is:

1. Complete configuration mirror.
2. Delivery capability locator.
3. Lifecycle state only.
4. Unrecognized or invalid state.

The classifier validates repository binding, schema version, manifest/file hashes, Git object IDs,
and required workflow parseability. It returns structured findings; UI code does not re-derive
trust from prose.

Known legacy state-marker formats enter the same classifier through registered read-only adapters.
An unknown newer format is never rewritten by an older client; it reports **A newer SFlow version
is required**.

### 3. Restore missing `sflow/config`

For a valid full configuration mirror:

1. Prefer the immutable `sflow/config-history/<SOURCE-COMMIT>` ref and restore the exact retained
   commit when available.
2. Otherwise reconstruct the exact canonical files from the verified mirror in an isolated
   checkout and record the mirror commit and source digest in a recovery receipt.
3. Validate the reconstructed configuration before publishing anything.
4. Create `sflow/config` only if it is still absent and the state ref still equals the plan.
5. Never force-update an existing `sflow/config` branch.

Restoration preserves custom workflows, agents, templates, capability definitions, and portfolio
data contained in the verified snapshot.

Existing `sflow/config-change/*` refs do not block an exact state restoration. After the base is
restored, re-evaluate each proposal against that base and leave incompatible proposals untouched for
manual review. If there is no recoverable base, **Start fresh** must explicitly say that retained
proposal refs cannot be interpreted; it never deletes them.

### 4. Reconcile current workflow-v2 packaged configuration

Migration is the current-v2 packaged-seed reconciliation path, not a workflow schema migration:

- Require a valid workflow-v2 configuration from `sflow/config` or a repository-bound verified
  state mirror.
- Upgrade only exact registered historical packaged assets by provenance/hash.
- Add missing current framework seeds.
- Preserve user-created or byte-modified workflows, agents, artifacts, templates, prompts, and
  supported custom fields.
- Validate the resulting current workflow-v2 definition before publication.
- Refuse workflow v1, an unknown future schema, or an invalid configuration without writing. The
  explicit **Recreate** preview remains available when safe and lists exact omissions.

For an existing `sflow/config`, migration uses the normal review proposal/PR path. For a missing
branch, **Restore and migrate** may be one user action but remains two recoverable internal stages:
restore the exact base, then apply the registered migration.

An active Story keeps its pinned configuration snapshot. Migration changes the default for future
Stories and unpinned repository operations; it never rewrites a Story already in progress.

### 5. Recreate current configuration

Recreate is explicit and different from migrate:

- Build current framework configuration from installed seeds.
- When `sflow/config` is absent, source portable data from a repository-bound verified state mirror
  or its retained history; when it exists, source portable data from that current branch.
- Recover stable portable organisation data from the verified snapshot: capability/repository IDs,
  repository URLs and branches, hierarchy, ownership, and people/team identifiers.
- Do not guess how an unknown custom workflow or agent should translate.
- Show every custom path that will not be carried forward before confirmation.
- Preserve the old configuration through its existing Git history and an immutable recovery ref.
- Commit the replacement on top of the current configuration history or create a recovery-rooted
  branch when the original branch is absent; never rewrite application branches.

“Always recreatable” therefore means a current, valid configuration can always be produced without
deleting application code or state history. It does not mean silently interpreting corrupt or
future-version bytes.

### 6. Publish and resume safely

Apply performs only one final ref comparison for the refs named in the plan. If unchanged:

- publish/restore `sflow/config`;
- refresh only the state branch's configuration projection;
- preserve lifecycle events and all non-configuration state paths;
- update the local lead registry/cache;
- continue directly to capability mapping or workspace selection.

Use atomic push when the provider supports it. Otherwise store a resumable operation receipt. If
configuration succeeds and the state refresh fails, report **Ready · state refresh pending** and
offer one retry; do not roll back or repeat configuration publication.

Apply can also finish safely but incompletely:

| Result status | Durable state | Resume action |
| --- | --- | --- |
| `configuration-review-required` | A leased review proposal exists; `sflow/config` is not ready | Review/merge the named proposal, then preview onboarding again |
| `local-registration-pending` | Completed remote writes are preserved; the matching lead was not recorded on this machine | Follow the returned preview/confirmation without republishing configuration; also honor any nested state-refresh retry |
| `ready-state-refresh-pending` | `sflow/config` is ready; the portable state projection is pending | Run the returned `capability publish` retry without repeating configuration publication |

`--reset-local` clears only matching entries from the capability lead registry and organisation
cache, including equivalent URL spellings. It does not clear workspace registrations, the active
workspace/session, FOS observation pins, clones, or any remote ref. Repeating it is an exact no-op.

## Minimum hidden checks

The normal journey has only these checks:

1. **Recognize once:** live observation plus validation of the selected SFlow state/config snapshot.
2. **Apply once:** compare the relevant remote refs with the plan immediately before mutation.

Credential/TLS/proxy diagnosis, complete fsck, and historical audits run only when discovery fails
or when the user opens Diagnostics. This removes redundant checks without allowing a stale plan to
overwrite someone else's concurrent change.

Every selected state/configuration snapshot is a depth-one, no-tags, blobless partial clone. Because
a server may ignore the filter, onboarding deletes and refuses a snapshot above 16,384 local files
or 128 MiB before checkout or parsing. A state configuration mirror is bounded further to 512
declared assets, 64 KiB of aggregate declared path bytes, and 64 MiB of asset content.

Local repository locators are frozen to an absolute path before any temporary clone changes the
working directory. Returned recovery commands are rendered from structured argv with the shared
POSIX/PowerShell renderer; repository names are never interpolated as shell text.

## Delivered milestones

### M0 — Contract and shared classifier — implemented

- Define `repository-onboarding-plan/v1` and result schemas.
- Extract the state classifier from existing state-mirror and locator readers.
- Add fixtures for full mirror, delivery locator, lifecycle-only state, ordinary `state`, corrupt
  state, and no state.

### M1 — State-first capability reads — implemented

- Make capability discovery use a verified full state mirror when `sflow/config` is absent, as Story
  configuration already does.
- Follow a delivery locator to its lead without treating the locator as authority.
- Return the simple setup status and one next action.
- Remove the second organisation read from Map-to-Workspace handoff; carry the plan receipt.

### M2 — Restore and current-v2 reconciliation engine — implemented

- Implement exact restore from retained history or complete mirror.
- Implement current workflow-v2 packaged-seed reconciliation. Unsupported workflow v1 is not a
  migration source.
- Add plan-first CAS publication, resumable receipts, and state-projection refresh.

### M3 — Recreate and local reset — implemented

- Implement current-version recreation with a complete preservation/omission preview.
- Implement machine-local reset that removes only matching capability lead-registry and
  organisation-cache entries.
- Preserve workspace/session registrations and FOS pins.
- Leave remote branches, repository content, application history, and lifecycle state untouched.

### M4 — VS Code and Copilot simplification — implemented

- Add the Repository setup card and Command Palette entry.
- Reduce normal setup to one primary action and hide diagnostics under **More options**.
- Update `/sf-capability-map` and help documentation with matching Shell/Copilot commands.

### M5 — Rollout and compatibility — implemented

- Keep old commands as deprecated aliases for one release.
- Refresh local registration/cache state only after a verified result; `--reset-local` remains an
  offline, local-only exception.
- Enforce bounded snapshots and keep the older inspection surface available for one release.

## Required test matrix

- New laptop with full valid state mirror and missing `sflow/config`.
- New laptop with delivery locator pointing to a lead repository.
- Lifecycle-only state, arbitrary application `state`, corrupt state, and no state.
- Current v2, current v2 with stale/missing packaged seeds, unsupported v1, unknown-future,
  missing, and concurrently-created `sflow/config`.
- Existing custom workflows/agents/templates preserved by current-v2 reconciliation.
- Recreation preview names every custom item not carried forward.
- Pending proposal refs with a restorable source; no proposal is deleted or silently adopted.
- Protected configuration branch: PR/review fallback.
- Push succeeds but state projection fails: exact resumable recovery.
- Repeat onboarding is a no-op.
- Offline `--reset-local`; every remote setup path requires live observation and live apply check.
- Partial-clone servers that ignore filtering; snapshots over the file/byte quotas are deleted and
  refused before parsing.
- HTTPS, SSH, enterprise proxy/CA/credential helper, macOS, Linux, and Windows.
- Windows path casing, slash normalization, long arguments, and non-interactive credential behavior.
- Relative local/bare repositories and repository paths containing apostrophes or shell characters.
- Concurrent ref movement refuses without overwriting.
- Application HEAD, working tree, application branches, lifecycle events, and non-configuration state
  files remain byte-for-byte unchanged.

## Acceptance criteria

1. A valid full state mirror with no `sflow/config` reaches **Restore and continue** in one repository
   check and can recreate a current configuration through one confirmed plan.
2. A valid delivery locator reaches its lead and never creates configuration in the delivery repo.
3. A random branch named `state` is never overwritten or treated as capability proof.
4. Map-to-Workspace performs no redundant full authority read.
5. Normal UI contains no authority/pin/cache terminology and shows one primary action.
6. Current-v2 reconciliation preserves custom assets; workflow v1 and conflicts cause zero remote
   writes and are never described as migrated.
7. Recreation reports omissions before confirmation and preserves recoverable history.
8. Every mutating operation is idempotent, CAS-bound, resumable, and safe to retry.

## Implementation boundary

The delivered feature intentionally stops at current workflow-v2 packaged-seed reconciliation.
Supporting a future governed workflow-v1-to-v2 transformation would require a separate registered
migration contract and tests; this command does not infer or perform one.
