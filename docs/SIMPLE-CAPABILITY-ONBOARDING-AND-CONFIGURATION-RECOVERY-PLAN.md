# Simple capability onboarding and configuration recovery

Status: proposed implementation plan  
Scope: capability onboarding, `state` discovery, `sflow/config` recovery and migration, workspace handoff  
Non-goal: weakening Git integrity, overwriting an unrelated `state` branch, or silently discarding custom configuration

## Outcome

A contributor supplies a repository URL once. Singularity Flow returns one understandable status
and one primary action. A recognized SFlow `state` branch is enough to resume the appropriate
onboarding path on a new laptop. A missing `sflow/config` branch is recoverable from a complete
state configuration mirror, and an older supported configuration can be migrated to the installed
version.

Normal screens do not expose authority pins, projection commits, cache leases, or repeated Git
checks. Those details remain available under diagnostics.

## Why this is needed

The current implementation has the necessary pieces but presents them as separate journeys:

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

The new design unifies these pieces behind one repository-centric onboarding operation.

## Product rule

The simple rule shown to users is:

> If the repository contains recognized SFlow state, resume from it. If configuration is missing or
> old, offer to recreate or migrate it with the installed version. Otherwise offer new setup.

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
| Full valid state mirror or config using a supported older schema | **Update available** | Existing data can be preserved and upgraded | **Migrate and continue** |
| Valid delivery locator | **Linked to team configuration** | Follow the named lead; never create `sflow/config` in the delivery repository | **Continue** |
| Valid lifecycle state only | **SFlow repository · capability not mapped** | Repository history is recognized, but capability ownership is not inferred | **Map capability** |
| No state and no config | **Not set up** | New repository | **Set up SFlow** |
| State branch with no valid SFlow marker | **State branch not recognized** | It may belong to the application; do not overwrite it | **Choose another state branch** |
| Git cannot be observed and no validated cache exists | **Could not check Git** | No ownership conclusion is possible | **Retry** |
| Conflicting full mirrors, locators, or leads | **Needs a choice** | The conflict must be resolved explicitly | **Review choices** |

A validated cache may support a read-only/offline **Ready** status. Remote mutation still requires a
live compare-and-swap check.

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

### 4. Migrate to the installed version

Migration is a registered, version-to-version transformation:

- Run schema migrations in memory/in an isolated checkout.
- Upgrade only known prior packaged assets by registered provenance/hash.
- Add missing current framework seeds.
- Preserve user-created workflows, agents, artifacts, and supported custom fields.
- Validate workflow phases, artifact templates, agent phase assignments, MCP declarations, test
  adapters, and all current schemas before publication.
- On an unknown future schema or customization conflict, write nothing and offer **Recreate** with
  an exact impact preview.

For an existing `sflow/config`, migration uses the normal review proposal/PR path. For a missing
branch, **Restore and migrate** may be one user action but remains two recoverable internal stages:
restore the exact base, then apply the registered migration.

An active Story keeps its pinned configuration snapshot. Migration changes the default for future
Stories and unpinned repository operations; it never rewrites a Story already in progress.

### 5. Recreate current configuration

Recreate is explicit and different from migrate:

- Build current framework configuration from installed seeds.
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

## Minimum hidden checks

The normal journey has only these checks:

1. **Recognize once:** live observation plus validation of the selected SFlow state/config snapshot.
2. **Apply once:** compare the relevant remote refs with the plan immediately before mutation.

Credential/TLS/proxy diagnosis, complete fsck, and historical audits run only when discovery fails
or when the user opens Diagnostics. This removes redundant checks without allowing a stale plan to
overwrite someone else's concurrent change.

## Delivery milestones

### M0 — Contract and shared classifier

- Define `repository-onboarding-plan/v1` and result schemas.
- Extract the state classifier from existing state-mirror and locator readers.
- Add fixtures for full mirror, delivery locator, lifecycle-only state, ordinary `state`, corrupt
  state, and no state.

### M1 — State-first capability reads

- Make capability discovery use a verified full state mirror when `sflow/config` is absent, as Story
  configuration already does.
- Follow a delivery locator to its lead without treating the locator as authority.
- Return the simple setup status and one next action.
- Remove the second organisation read from Map-to-Workspace handoff; carry the plan receipt.

### M2 — Restore and migration engine

- Implement exact restore from retained history or complete mirror.
- Implement registered configuration migrations and packaged-seed reconciliation.
- Add plan-first CAS publication, resumable receipts, and state-projection refresh.

### M3 — Recreate and local reset

- Implement current-version recreation with a complete preservation/omission preview.
- Implement machine-local reset that removes only registry/cache/session bindings.
- Leave remote branches, repository content, application history, and lifecycle state untouched.

### M4 — VS Code and Copilot simplification

- Add the Repository setup card and Command Palette entry.
- Reduce normal setup to one primary action and hide diagnostics under **More options**.
- Update `/sf-capability-map` and help documentation with matching Shell/Copilot commands.

### M5 — Rollout and compatibility

- Keep old commands as deprecated aliases for one release.
- Migrate existing local registry/cache records lazily after a successful live observation.
- Add telemetry counters for status, recovery mode, duration, retries, and refusal code; never record
  repository URLs or configuration contents.

## Required test matrix

- New laptop with full valid state mirror and missing `sflow/config`.
- New laptop with delivery locator pointing to a lead repository.
- Lifecycle-only state, arbitrary application `state`, corrupt state, and no state.
- Current, old-supported, unknown-future, missing, and concurrently-created `sflow/config`.
- Existing custom workflows/agents/templates preserved by migration.
- Recreation preview names every custom item not carried forward.
- Pending proposal refs with a restorable source; no proposal is deleted or silently adopted.
- Protected configuration branch: PR/review fallback.
- Push succeeds but state projection fails: exact resumable recovery.
- Repeat onboarding is a no-op.
- Cached/offline read followed by live apply requirement.
- HTTPS, SSH, enterprise proxy/CA/credential helper, macOS, Linux, and Windows.
- Windows path casing, slash normalization, long arguments, and non-interactive credential behavior.
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
6. Migration preserves supported custom assets; conflicts cause zero remote writes.
7. Recreation reports omissions before confirmation and preserves recoverable history.
8. Every mutating operation is idempotent, CAS-bound, resumable, and safe to retry.

## Estimated effort

Approximately 12–16 engineering days:

- M0–M1: 4–5 days.
- M2: 4–5 days.
- M3: 2–3 days.
- M4–M5: 2–3 days.

The first useful cut is M0–M1: it removes the common false blocker and repeated authority read even
before restore/migrate/recreate mutations are delivered.
