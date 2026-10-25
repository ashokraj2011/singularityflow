# Completed fixes and validation

Consolidated delivery and qualification records. Each entry retains its original feature scope, measurements, validation and limitations; these records do not establish a new release certificate or change current product defaults.

Use the [documentation map](../DOCUMENTATION-MAP.md) for current guides and the [pending-work roadmap](../PENDING-WORK-ROADMAP.md) for outstanding work.

## Contents

- [VS Code UI Remediation Plan](#vs-code-ui-remediation-plan)
- [Simple capability onboarding and configuration recovery](#simple-capability-onboarding-and-configuration-recovery)
- [Windows Git Bash installation compatibility](#windows-git-bash-installation-compatibility)
- [Automatic installation-receipt upgrade qualification](#automatic-installation-receipt-upgrade-qualification)
- [CLI status bundle hardening](#cli-status-bundle-hardening)
- [Native Auto submission and bundle hardening](#native-auto-submission-and-bundle-hardening)
- [Source-review packet repair](#source-review-packet-repair)
- [Residual branch reconciliation](#residual-branch-reconciliation)

## VS Code UI Remediation Plan

Status: implemented and regression-backed on `main`.

### ui remediation plan — Outcome

The VS Code UI must keep the contributor oriented when several Stories exist, remain usable in a
narrow editor column, and expose a safe recovery action when a long-running command outlives the
extension request. The UI is a projection of the CLI state; it does not create a second lifecycle
or infer that a timed-out mutation failed.

### ui remediation plan — Remediation work

#### ui remediation plan — 1. Story context and navigation

- Show every active Story in Lifecycle and Inbox, with the selected checkout explicitly marked.
- Switch Stories through `session attach`, then open the exact checkout returned by the CLI.
- Keep generated artifacts scoped to their owning Work ID so sibling Stories never share a phase
  or artifact row accidentally.
- Fail visibly when a stored Story selection is stale instead of falling back to another checkout.

#### ui remediation plan — 2. Timeout and recovery states

- Keep the exact, repository-bound terminal command when a Start operation times out.
- Offer **Check and open created Story** so a terminal retry that completed after the timeout is
  adopted without starting the Story again.
- Render errors as alerts, recovery results as polite status updates, and busy forms with
  `aria-busy`.

#### ui remediation plan — 3. Responsive layout

- Prevent cards, form fields, help search, action rows, and Story selectors from imposing a fixed
  minimum width on the editor.
- Stack dense forms and actions at narrow widths while keeping tables horizontally scrollable.
- Preserve keyboard focus, reduced-motion behavior, high-contrast borders, and theme-owned colors.

#### ui remediation plan — 4. Visual and automated assurance

- Exercise light, dark, and high-contrast fixtures at 320, 640, 1024, 1200, and 1440 pixels.
- Include active-Story selection and timed-out Start recovery in the deterministic fixture.
- Test semantic status icons, single-primary-action hierarchy, explicit recovery controls, active
  Story ordering, responsive breakpoints, and the shared viewport contract.

### ui remediation plan — Acceptance criteria

- A sibling Story is reachable from both Lifecycle and Inbox without manually locating a worktree.
- Selecting it opens the repository path proven by `session attach`.
- A timed-out start cannot silently disappear and can be checked without issuing a second start.
- No card, field, or action group forces horizontal page overflow at 320 pixels; intentionally wide
  evidence tables remain inside their own scroll container.
- All status and recovery changes are announced to assistive technology and all animation respects
  reduced-motion settings.
- The extension typecheck, visual fixture generation, and VS Code UI tests pass before publication.

### ui remediation plan — Ongoing rule

New full-page surfaces must use the shared `page()` and `STYLE` helpers. New stateful UI must add a
deterministic model test and, when it introduces a new layout pattern, extend the visual fixture.
This keeps later features inside the same navigation, accessibility, and responsive contracts.

## Simple capability onboarding and configuration recovery

Status: implemented

Scope: capability onboarding, `state` discovery, `sflow/config` recovery, current-v2 packaged-seed reconciliation, and workspace handoff

Non-goal: weakening Git integrity, overwriting an unrelated `state` branch, or silently discarding custom configuration

### simple capability onboarding and configuration recovery plan — Outcome

A contributor supplies a repository URL once. Singularity Flow returns one understandable status
and one primary action. A recognized SFlow `state` branch is enough to resume the appropriate
onboarding path on a new laptop. A missing `sflow/config` branch is recoverable from a complete
state configuration mirror or its verified retained history. Fresh setup and explicit recreation
can build the installed workflow-v2 configuration, while migration reconciles only recognized
packaged assets in an already current workflow-v2 configuration and preserves custom bytes.

Normal screens do not expose authority pins, projection commits, cache leases, or repeated Git
checks. Those details remain available under diagnostics.

### simple capability onboarding and configuration recovery plan — Why this is needed

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

### simple capability onboarding and configuration recovery plan — Product rule

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

### simple capability onboarding and configuration recovery plan — One state model

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

### simple capability onboarding and configuration recovery plan — User experience

#### simple capability onboarding and configuration recovery plan — Map a capability

Keep the Git URL first. Replace the current authority-oriented result with a single **Repository
setup** card:

- Status and one sentence explaining it.
- One primary button from the state model above.
- A **More options** menu containing **Migrate configuration**, **Recreate configuration**,
  **Reset local registration**, and **Diagnostics** only when applicable.
- The capability form appears after setup is resolved; it is not mixed with Git recovery choices.

Do not show normal users configuration SHA values, authority/pin terminology, cache ages, bootstrap
IDs, or separate “verify”, “refresh pin”, and “offline pin” actions.

#### simple capability onboarding and configuration recovery plan — Workspace creation

The successful onboarding result carries a bounded repository-setup receipt into workspace
creation. Workspace selection uses that receipt and does not run another complete organisation read.
It checks only that the relevant remote ref has not changed before applying the workspace plan.

If the ref changed, refresh the card and regenerate the plan. Report **Repository setup changed;
review the refreshed result** instead of a generic authority failure.

#### simple capability onboarding and configuration recovery plan — Maintenance entry point

Add **Singularity Flow: Repair or upgrade repository setup** to the Command Palette and the
Configuration Center. It accepts a Git URL or an existing clone and opens the same Repository setup
card. It does not require an already registered workspace.

### simple capability onboarding and configuration recovery plan — CLI contract

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

### simple capability onboarding and configuration recovery plan — Engine design

#### simple capability onboarding and configuration recovery plan — 1. One bounded discovery

Use one `GitRemoteSession` advertisement for the relevant refs: `sflow/config`, configured/canonical
`state`, portable locator refs, and proposal prefixes when required. Fetch only the selected state or
configuration snapshot. Reuse the resulting observation through inspection, rendering, and
workspace handoff.

Do not repeat `capability organisation --refresh` merely because the user moved from Map to
Workspaces.

#### simple capability onboarding and configuration recovery plan — 2. State classifier

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

#### simple capability onboarding and configuration recovery plan — 3. Restore missing `sflow/config`

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

#### simple capability onboarding and configuration recovery plan — 4. Reconcile current workflow-v2 packaged configuration

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

#### simple capability onboarding and configuration recovery plan — 5. Recreate current configuration

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

#### simple capability onboarding and configuration recovery plan — 6. Publish and resume safely

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

### simple capability onboarding and configuration recovery plan — Minimum hidden checks

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

### simple capability onboarding and configuration recovery plan — Delivered milestones

#### simple capability onboarding and configuration recovery plan — M0 — Contract and shared classifier — implemented

- Define `repository-onboarding-plan/v1` and result schemas.
- Extract the state classifier from existing state-mirror and locator readers.
- Add fixtures for full mirror, delivery locator, lifecycle-only state, ordinary `state`, corrupt
  state, and no state.

#### simple capability onboarding and configuration recovery plan — M1 — State-first capability reads — implemented

- Make capability discovery use a verified full state mirror when `sflow/config` is absent, as Story
  configuration already does.
- Follow a delivery locator to its lead without treating the locator as authority.
- Return the simple setup status and one next action.
- Remove the second organisation read from Map-to-Workspace handoff; carry the plan receipt.

#### simple capability onboarding and configuration recovery plan — M2 — Restore and current-v2 reconciliation engine — implemented

- Implement exact restore from retained history or complete mirror.
- Implement current workflow-v2 packaged-seed reconciliation. Unsupported workflow v1 is not a
  migration source.
- Add plan-first CAS publication, resumable receipts, and state-projection refresh.

#### simple capability onboarding and configuration recovery plan — M3 — Recreate and local reset — implemented

- Implement current-version recreation with a complete preservation/omission preview.
- Implement machine-local reset that removes only matching capability lead-registry and
  organisation-cache entries.
- Preserve workspace/session registrations and FOS pins.
- Leave remote branches, repository content, application history, and lifecycle state untouched.

#### simple capability onboarding and configuration recovery plan — M4 — VS Code and Copilot simplification — implemented

- Add the Repository setup card and Command Palette entry.
- Reduce normal setup to one primary action and hide diagnostics under **More options**.
- Update `/sf-capability-map` and help documentation with matching Shell/Copilot commands.

#### simple capability onboarding and configuration recovery plan — M5 — Rollout and compatibility — implemented

- Keep old commands as deprecated aliases for one release.
- Refresh local registration/cache state only after a verified result; `--reset-local` remains an
  offline, local-only exception.
- Enforce bounded snapshots and keep the older inspection surface available for one release.

### simple capability onboarding and configuration recovery plan — Required test matrix

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

### simple capability onboarding and configuration recovery plan — Acceptance criteria

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

### simple capability onboarding and configuration recovery plan — Implementation boundary

The delivered feature intentionally stops at current workflow-v2 packaged-seed reconciliation.
Supporting a future governed workflow-v1-to-v2 transformation would require a separate registered
migration contract and tests; this command does not infer or perform one.

## Windows Git Bash installation compatibility

Status: implemented

Release line: `0.9.0`

Implementation commits: `4498852`, `2856241`

Merged to `main`: `958f37d`, `9120245`

### windows git bash install fix — Problem

Installing Singularity Flow from Git Bash on Windows produced hundreds of test failures. The first useful failures reported that governed agents such as `sflow-utility` had no description even though their Markdown files contained one.

The defect was caused by line-ending assumptions in the Markdown frontmatter parsers. Git for Windows commonly checks text files out with CRLF (`\r\n`) line endings, while the parsers required LF (`\n`) at exact delimiter positions. Some Windows editors may also add a UTF-8 byte-order mark (BOM).

When parsing failed, the agent frontmatter was treated as absent. Required fields such as `description` were therefore missing, causing agent discovery, agent mapping, hooks, direct skills, and dependent tests to fail. The npm registry and Artifactory were not the cause of these failures.

### windows git bash install fix — Corrective changes

#### windows git bash install fix — Agent Markdown parser

`src/agents.mjs` now:

- Accepts both LF and CRLF around YAML frontmatter delimiters.
- Accepts and removes an optional UTF-8 BOM before parsing.
- Locates the closing delimiter without assuming a specific operating-system newline.
- Preserves the prompt body after the frontmatter.
- Continues to reject unclosed or non-object YAML frontmatter.

This makes agent discovery independent of the user's `core.autocrlf` setting.

#### windows git bash install fix — Direct skill renderer

`src/direct-skills.mjs` now:

- Reads and replaces `name:` fields ending in LF or CRLF.
- Accepts an optional UTF-8 BOM.
- Finds YAML frontmatter delimiters with either newline convention.
- Preserves the source newline convention when inserting the Singularity-managed marker.
- Continues to verify that a skill declares the same name as its directory.

#### windows git bash install fix — Guarded Windows installer

The new `install-windows-git-bash.sh` wrapper provides one supported source-install command for Git Bash. It:

1. Resolves the Singularity Flow checkout from the script location.
2. Checks for Git Bash and verifies `bash`, `git`, `node`, and `npm`.
3. Requires Node.js 20 or newer.
4. Requires Copilot CLI only for modes that install standalone Copilot assets; `--cli-only`,
   `--vscode-only`, and `--skip-copilot` do not require it.
5. Refuses to install from a dirty checkout.
6. Updates the checkout using `git pull --ff-only`.
7. Verifies that the CRLF-safe agent parser is present before the long build and test stages.
8. Delegates installation to the canonical `install.sh`.
9. Passes through the selected npm registry, bounded install mode, update choice, and telemetry
   choice. The wrapper makes the update decision once and tells the canonical installer not to
   repeat the pull.

The wrapper can be run from any directory because it resolves its own checkout path.

### windows git bash install fix — Safety boundaries

The fix deliberately does not:

- Change global or repository `core.autocrlf` settings.
- Run `dos2unix` or rewrite tracked Markdown files.
- Store registry credentials in command-line URLs.
- Bypass the canonical installer validation or test suite.
- Reset, clean, force-update, or otherwise rewrite Git history.

Registry credentials remain in the user's `.npmrc` or the organization's approved npm credential mechanism.

### windows git bash install fix — Public usage

From Git Bash in a clean checkout:

```bash
git switch main
git pull --ff-only
bash ./install-windows-git-bash.sh
```

With a corporate npm registry or Artifactory:

```bash
bash ./install-windows-git-bash.sh \
  --registry "https://artifactory.company.example/api/npm/npm-virtual/"
```

CLI-only installation:

```bash
bash ./install-windows-git-bash.sh --cli-only
```

Install the VS Code extension only, without changing the global CLI or Copilot assets:

```bash
bash ./install-windows-git-bash.sh --vscode-only
```

Install the CLI and VS Code extension when the standalone Copilot CLI is unavailable or managed by
the organization:

```bash
bash ./install-windows-git-bash.sh --skip-copilot
```

Build the exact current clean checkout without another Git network operation:

```bash
bash ./install-windows-git-bash.sh --no-update
```

If activation stops after artifacts were packaged, use only the exact command printed by the
installer:

```bash
bash ./install-windows-git-bash.sh --from-staged-artifacts
```

This delegates immediately to the canonical exact-artifact recovery. It does not inspect or update
Git, reinstall source dependencies, rerun tests, rebuild, or repackage. Before any mutation, the
activation journal revalidates both the candidate artifacts and the exact prior retained tarball or
VSIX needed to restore each previously managed surface. Those archives are content-addressed copies
under `~/.singularity-flow/installations/versions/sha256/<digest>/`, not mutable files in the source
checkout. If `current.json` says a managed prior surface exists but its rollback artifact is absent,
escaped, symlinked, or digest-mismatched, activation fails closed before changing the machine. Do not
add registry or mode flags; the reviewed values come from the journal.

Only one activation can run at a time. The journal lease is owned by the installer shell's native
Windows PID (resolved by Node rather than trusting Git Bash's MSYS `$$` pseudo-PID), stale
dead-owner leases are reclaimed through an atomic rename, and each journal write must match both
the recorded operation ID and current revision. The isolated CLI prefix is rebuilt from the exact
retained candidate tarball on every normal or recovery activation, so a modified digest-named cache
is not run. This private candidate CLI installs the Copilot plugin; the previously working global CLI
is not used as an activation helper.

The canonical installer applies and verifies selected surfaces in this order: VSIX, Copilot
plugin/skills, managed telemetry, then the global CLI last. This keeps the old global CLI available
until the other requested surfaces are known good. If the shell receives `ERR`, `INT`, `TERM`, or
`HUP` after mutation begins, it automatically compensates in reverse order, starting with the
installation receipt if its replacement began. Exact prior artifacts restore previously present
surfaces, and previously absent surfaces are removed. The journal reports `rolled-back` only after
every touched surface is verified in its prior state. It reports `rollback-failed`, with the failed
surface details and recovery command, if any restoration cannot be completed or proved; it never
presents that state as a successful install. A normal install also refuses to replace an incomplete
journal: the exact printed recovery must finish first.

Workspace configuration refresh is not part of this cross-product transaction. It runs only after
the CLI, extension, plugin, and telemetry activation is committed. If refresh is blocked or fails,
the product installation remains active and the installer reports the refresh as a separate pending
operation with its retry command.

The npm alias is:

```bash
npm run install:windows
```

### windows git bash install fix — Failure behavior

The wrapper stops before the expensive installer stages when:

- A required executable is unavailable.
- Node.js is older than version 20.
- Copilot CLI is absent in a mode that requested standalone Copilot assets.
- The checkout contains uncommitted changes.
- The current branch cannot be updated by fast-forward.
- The checkout predates the Windows CRLF parser fix.

Each refusal identifies the corrective action. It does not attempt an automatic destructive repair.
Once admitted product activation has mutated a surface, however, process errors and termination
signals use the bounded compensating rollback described above. Repository and workspace Git state is
never used as rollback material.

### windows git bash install fix — Regression coverage

Automated tests cover:

- Agent frontmatter using Windows CRLF.
- Agent frontmatter containing a UTF-8 BOM.
- Direct skills using CRLF and a BOM.
- Preservation of CRLF when inserting the managed direct-skill marker.
- Installer executability and Node.js version guard.
- Fast-forward-only checkout update.
- CRLF-fix detection before canonical installation.
- Corporate registry, CLI-only, VS Code-only, skip-Copilot, no-update, and telemetry arguments.
- Fail-closed admission when an existing managed surface lacks its exact retained rollback artifact.
- VSIX/plugin/telemetry/global-CLI-last activation and reverse compensation after injected failures
  or termination signals.
- Distinct, verified `rolled-back` and actionable `rollback-failed` journal outcomes.
- Workspace refresh beginning only after product activation commits.
- Rejection of global Git line-ending changes and file-rewriting utilities.

Validation at delivery completed with deterministic checks passing and 1,433 Node tests passing with zero failures.

### windows git bash install fix — Acceptance criteria

The correction is accepted when:

- The same tracked agent and skill Markdown files parse on macOS, Linux, and Windows Git Bash checkouts.
- Agent descriptions and mappings remain available under CRLF.
- A Windows source installation uses the canonical validated installation path.
- Corporate registry selection reaches npm without embedding credentials in the URL.
- Existing managed surfaces are not changed unless their exact prior restoration material passes
  admission.
- A failed or interrupted activation either restores and verifies every touched surface or remains
  explicitly `rollback-failed` with an exact recovery path.
- Workspace refresh cannot turn a committed product activation into a cross-product rollback.
- No Git line-ending policy or repository content is rewritten by the wrapper.
- Existing LF behavior and validation errors remain unchanged.

## Automatic installation-receipt upgrade qualification

Qualified on 2026-10-21. Runtime/source implementation: `26d30b3642d2360e33b5d4ceaea086157cd31539`.
Fresh-main baseline: `c7ba93760bbc5f028d7339a07e83144136f7b0e8`.
Native qualification run: `39561410451`; its temporary workflow is not a production asset.

### installation receipt upgrade qualification — Native results

| Host | Node | Passed | Failed | Platform skips |
| --- | --- | ---: | ---: | ---: |
| macOS | 22.23.3 | 253 | 0 | 3 |
| macOS | 26.12.0 | 253 | 0 | 3 |
| Windows | 22.23.3 | 255 | 0 | 1 |
| Windows | 26.12.0 | 255 | 0 | 1 |

Each job also passed all 2,942 product checks, VS Code typechecking and the VS Code build.
The three macOS skips are the existing Windows-native bootstrap argv, timeout/descendant-tree,
and exclusive-file-lock cases, which execute on Windows. Windows skips the existing POSIX fake
npm harness, which executes on macOS. No new receipt-upgrade case is skipped on either platform.
These are scoped regression results, not a zero-skip 1.0 release qualification.

The local Mac additionally passed the existing POSIX source-installer suite: the combined
13-file run reported 269 passes, zero failures and the same three Windows-only skips (272 tests).
Product checks, typechecking and build also passed locally. An initial Windows qualification
exposed test-fixture PATH initialization, not a production Git failure; the corrected fixture
prepends its fake managers inside Git Bash before executing the installer. The final run above
includes that correction and both subsequent safety fences.

### installation receipt upgrade qualification — Safety and compatibility coverage

- Full normal source install detects v1 before cleanup/dependency work and upgrades automatically,
  with and without an explicit test opt-out; the non-opted-out installer still runs its full suite.
- Exact old receipt bytes, including formatting, are retained once at their digest-addressed path.
  The v2 receipt and audit bind that archive; old artifact claims never become rollback authority.
- Replacement package/build identity, CLI, VSIX and Copilot verification precede the v2 commit.
  Current-receipt and archive integrity are rechecked at that commit boundary.
- Failed builds/activation retain old metadata and the exact candidate for roll-forward recovery.
  Exact-plan retries preserve lineage; rejected commits do not leave a false successful audit.
- Workspace registrations, Story/repository files and completed recovery journals stay unchanged.
  Live leases and pending activation, distribution-install or uninstall recovery remain authoritative.
- Receipt drift during build/activation, archive tampering/conflicts, linked directories, malformed
  or future records refuse safely. Partial-surface install requests are never silently expanded.
- A missing old CLI can be repaired without trusting its receipt as proof of installed bytes.
  Existing v2 installation, rollback, storage-cleanup and product-alignment regressions pass.
- About/alignment diagnostics point to the full automatic source-install route rather than a generic
  archival-reader dead end. Reading those diagnostics never mutates the old receipt.

Native test runs cover real local filesystem, hashing, archive and Git Bash behavior in disposable
homes. Product manager commands are injected/non-mutating; they do not replace the operator's
actual CLI, editor or Copilot installation. This is not an attestation about office network policy,
antivirus behavior, or a real power-loss interruption. Managed-runtime and promoted-distribution
regressions are covered, but their separate receipt/rollback policies are not weakened by this fix.

The focused upgrade/service cases are in `test/installation-receipt-upgrade.test.mjs` and
`test/reinstall.test.mjs`, and are included in `npm run test:reinstall`. The native regression also
runs staged-artifact recovery, installation storage, distribution bootstrap/bundle/install,
uninstall, direct-skill, plugin, product-alignment and About suites. Node 22's About UI tests use
`--experimental-strip-types`. No hosted workflow is merged into the product checkout.

## CLI status bundle hardening

### cli status bundle hardening — Cause and change

The process-wide CLI error boundary obtained `commandResultOf` through `narration/emit.mjs`.
That module also imports continuation generation and the workflow next-step planner. Consequently,
even ordinary JSON status paid to parse those definitions before running its narrow reader.
The error boundary now imports the same function directly from `narration/command-result.mjs`.
Result attachment, error identities, stream selection, redaction and recovery guidance are unchanged.

The coarse bundle transform now compacts syntax as well as whitespace, using the existing Node 20
target and the same syntax option as the VS Code build. Rollup still owns module assignment;
identifiers, singleton ownership, live installation stamps and the 21-file limit are retained.
The monolithic benchmark control is unchanged. No size ceiling is raised or source omitted from
measurement.

The first failing status assertion had hidden a second existing phase-review closure overrun on
unchanged main. The complete CLI bundle test now reaches and passes both original limits.

### cli status bundle hardening — Regression guards

- The status closure must remain below 1.5 MiB and cannot contain the output boundary,
  continuation builder or workflow next-step planner, nor statically import catalog/review chunks.
- A source-runtime loader trap rejects those output/planner modules while testing a real attached
  refusal. A negative control proves the trap is active. The JSON packet, preservation projection,
  failing exit code and empty stderr remain checked.
- CLI parity includes missing-Story status, other narrow/catalog commands, hook decisions and
  source/bundle error behavior. Existing stamp, worker, cycle, module-count and byte caps remain.

### cli status bundle hardening — Size comparison

Baseline: fresh main `fb59ee1beeba5aec2c16961a76d4208594a02020`.
Local macOS Node 26 measurement:

| Static closure | Before bytes / modules | After bytes / modules | Unchanged byte limit |
| --- | ---: | ---: | ---: |
| CLI startup | 1,424,966 / 181 | 1,283,162 / 164 | 3,145,728 |
| Ordinary status | 1,573,990 / 205 | 1,433,232 / 189 | 1,572,864 |
| Phase-review | 7,361,567 / 683 | 7,213,638 / 683 | 7,340,032 |

Status parses 140,758 fewer bytes (8.9%), with 139,632 bytes of headroom under its unchanged
limit. Both installations still contain 21 generated module files; the status static closure
contains two. These are byte/module improvements, not a claim of equivalent complete-Story or
Copilot model latency savings.

### cli status bundle hardening — Native qualification

Run `39599738772` passes all four native jobs: macOS arm64 and Windows x64, each on Node 22 and
Node 26. Each job passes 124 targeted tests with zero failures or skips, the full CLI bundle parity
and closure checks, all 13 unchanged VS Code bundle budgets, typechecking, and 2,945 static checks.
The tested product/test tree matches `0f0db0b9`; only temporary CI assets differ. Those assets are
not merged into production. Local macOS also passes the 25 publication/authorship/hook regressions.

The first native run, `39598288370`, exposed a Windows Node 26 fixture teardown race after its
assertions passed: it attempted to delete a repository while its signalled worker still held the
working-directory handle. Cleanup now waits for each tracked worker to exit, removes dead PIDs
from ownership tracking, and permits bounded filesystem retries. A worker that fails to stop still
fails the test. No worker authorization check, test assertion or platform applicability is removed.

Both native hosts reproduce the size table above. Each job also compares complete ordinary-status
results across the baseline and fixed bundles, using three alternating pairs on a local fixture
with 100 files and four unrelated branches. Cold samples start a new process with an empty private
Node compile cache; warm samples start another process reusing that cache. The OS file cache is
not flushed. There are no model or public-remote operations. Timing results are mixed across
hosts/runs, so this qualification establishes the bundle fix, not a consistent latency speedup.

The final main check still resolves to the baseline commit above. This is targeted qualification,
not a complete 1.0 release certificate or a live Copilot Story journey.

## Native Auto submission and bundle hardening

### native auto bundle hardening — Failure and fix

The Ad Hoc-to-Auto Candidate could publish successfully on Windows and then refuse submission
with a stale code/test-input binding. Dirty files were hashed as raw worktree bytes, while clean
files used committed Git object IDs. Git's CRLF conversion made publication invalidate its own
receipt. Windows also needs the index's tracked executable mode, not a synthesized filesystem bit.

Source and separately hashed test inputs now use one read-only Git object-hash batch for dirty
regular files. Git applies its built-in EOL/encoding conversion; external clean/process filters
are disabled from one fresh policy snapshot. No object writes, staging, history scan, network call
or per-file Git child is introduced. Real code/test-input changes still invalidate the binding.
Binary and explicit `-text` bytes remain significant. Existing clean receipt identities stay intact.
Previously retained stale receipts are not rewritten or retroactively attested: existing blocked
flights still use their governed recovery/revalidation route to obtain fresh evidence.

The end-to-end adoption regression enables `core.autocrlf=true` on every host. Focused cases cover
SHA-1/SHA-256 repositories, executable mode, Unicode paths, UTF-16, binary bytes, independent test
inputs and non-execution of repository filters. Tests verify that hashing changes neither the
index nor the object store.

The wider native cohort also checks Candidate isolation. Windows `fs.cp` can turn a dependency
junction into a normal directory containing excluded working-tree bytes. Isolation now discovers
and validates links in the original tree, skips those paths during copying, then creates links
only into the candidate. This avoids copying excluded dependency content before rebinding and
keeps the original checkout untouched. The native test executes both copies and mutates the
candidate dependency to prove it cannot write back into the original.

Portable fixtures set executable modes in the Git index, enable long refs only on their own
disposable test server, and use an unhashable tracked path instead of POSIX permission bits.
Byte-exact Candidate/approval fixtures explicitly declare LF. They do not qualify arbitrary
CRLF-rewritten managed Markdown; the separate source-binding and Auto adoption tests retain
native CRLF conversion.

### native auto bundle hardening — Bundle fixes

All original byte/module ceilings remain unchanged. No source maps or modules are hidden from
measurement, and no dependency is added.

- The existing tiny process-wide context entry owns one managed-engine resolver. Activation and
  lazy panels reuse it, but each lookup still freshly reads the current installed runtime/CLI pair.
  Invalid installation selections remain errors, not a fallback to a stale engine.
- The ACP SDK loads only when a model session starts, resolved from SFlow's locked package. It is
  no longer embedded in the gateway used for read-only cards. A packaged CommonJS regression
  executes the actual SDK protocol and rejects an unrelated application-cwd dependency.
- UI consumers project the trusted, frozen built-in authoring catalog without embedding its
  untrusted-input parser. The audit and tests validate that literal and require exact equivalence;
  imported/user declarations still pass the full parser.

### native auto bundle hardening — Qualification

Baseline: fresh main `f0abdbc783dfd233b5ed379392cd762e8ae3374a`.
The final pre-merge fetch still resolves main to that same commit; no upstream integration is
omitted. Product changes are in `5c6df7fa` and `b07a50e7`; native fixture corrections are in
`7ff1d34d` and `2176f040`.

The 54-case Auto lifecycle corpus passes on this Mac and on native Windows Node 26. Windows run
`39589790891` partitions only registration into four jobs (14 + 14 + 13 + 13); the retained selection
manifests prove an exact union of all 54 unique names/indices with zero failures or skips. Its first
broader Windows cohort exposed the portability/isolation issues described above; those failures
are not reported as a clean initial run. Native junction diagnosis is run `39590575970`.

The final source/Candidate/provider/authoring cohort in run `39591814615` passes 128 tests on each
Mac Node version and 125 on each Windows Node version. Windows retains three pre-existing
platform exclusions: two POSIX file-symlink permission probes and the POSIX SIGTERM-ignore probe.
Its Windows editor cohort then exposed three test-only imports using bare drive-letter paths.
Those imports now use file URLs; no product assertion is removed.

The final editor/adoption/budget recheck, run `39592571647`, passes all four native jobs:

| Host | Node | Editor/client/gateway tests | Exact adoption publish + submit | VS Code budgets |
|---|---|---:|---:|---:|
| macOS | 22 | 344 passed | 1 passed | 13/13 passed |
| macOS | 26 | 344 passed | 1 passed | 13/13 passed |
| Windows | 22 | 344 passed | 1 passed | 13/13 passed |
| Windows | 26 | 344 passed | 1 passed | 13/13 passed |

All these final editor/adoption cases have zero failures or skips. Local macOS also passes the
54-case Auto corpus, 203 packaged extension-host fixture tests, the focused source/evidence
regressions, VS Code typechecking, and 2,945 static checks. No live model quota, human approval or
real workspace is used by this qualification. The temporary CI assets are not merged into main.

Local clean VS Code measurement (build stamps can change a few bytes):

| Runtime | Baseline bytes / modules | Fixed bytes / modules | Unchanged limits |
|---|---:|---:|---:|
| extension | 1,449,651 / 148 | 1,444,863 / 147 | 1,446,000 / 147 |
| gateway | 7,761,776 / 735 | 7,643,010 / 725 | 7,730,000 / 733 |
| lazy panels | 3,472,632 / 277 | 3,467,957 / 276 | 3,470,000 / 276 |

All 13 VS Code entries pass, including the small shared context entry at 6,458 bytes / 2 modules
against its existing 8,192-byte / 4-module ceiling. Packaging admits exactly the same entry list.

This is targeted bug/bundle qualification, not a full 1.0 release certificate. The broader CLI
bundle test independently fails its existing ordinary-JSON-status closure-size assertion on both
unchanged baseline main and this branch. That separate CLI budget is not raised or claimed fixed.
The existing platform-only symlink and POSIX SIGTERM test exclusions are also not release waivers.

## Source-review packet repair

### source review citation repair — Failure and correction

A published specification could reach independent review with a structurally valid packet,
rejected line/quote citations, and an unmapped scenario such as S2. The reviewer had been told
to repair format only and then stop on a non-retainable packet. Small sources remained escaped
JSON strings; the check did not provide exact field/line proposals or its next staging route.
The strict check agent-output flag was also refused, and stage/retain errors discarded repair detail.

The correction keeps the exact evidence validator and changes the packet/continuation contract:

- Pinned source text, including short sources, is available once as native-readable Git-private
  text files in the bounded Copilot view. Their 1-based lines are the citation domain; bytes and
  source hashes are unchanged. Ordinary JSON context remains compatible.
- The citation guide lists every specification scenario and clause, including clarified scenarios.
  A clarification is acknowledged separately, not invented as a readable source ID.
- Checks identify exact row/finding field paths. An unchanged quote appearing on one pinned line
  gets a proposed line-number edit. Multiple or absent matches require independent reading;
  there is no automatic choice, fuzzy quote substitution, or source edit.
- The reviewer repairs private packet errors in the same turn, with at most two changed-packet
  attempts. Unchanged retries are forbidden. Stage/retain refusals preserve bounded repair hints.
- Missing mappings are independently assessed before an author handoff. Add genuinely supported
  rows; retain real unsupported scope as blocking findings. A valid correction-required review is
  retainable evidence, not phase approval. A reviewer omission does not require re-authoring a spec.
- Read-only `review-source check` supports output-only `--for-agent --json` and returns exact check
  and retain routes. Source-review context and mutation authority boundaries remain enforced.

The logic follows the published review kind and phase responsibilities, not built-in phase names.
Seeded, copied, renamed and future custom scope/planning steps use the same contract. Other steps
do not acquire a new review gate.

### source review citation repair — Qualification

Native qualification run `39134899906`, source/test revision `5bebebe5`, passed on Node 22:

| Host | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: |
| macOS | 249 | 0 | 0 |
| Windows | 249 | 0 | 0 |

Windows ran 232 contract/host cases and 17 review CLI cases in three disjoint groups (10, 4, 3).
All 11 top-level CLI tests were checked to belong to exactly one group; none were omitted.
The CI revision `264df56320db2c7212f5dee290195d89552b2d8b` differed only by its temporary workflow.
Both hosts also passed VS Code typechecking, building and unchanged bundle budgets.

Coverage includes LF/CRLF sources, wrong lines, paraphrases, duplicate/multiline quotes, S2 and
clarifications, stale bindings, malformed reports, bounded hints, genuine retained gaps, reviewer
independence, human dispositions, read-only guards, linked worktrees, and copied phase contracts.
Windows fixtures explicitly declare their Git identity, canonical line endings and long-path
support; path assertions compare normalized paths. The blank-machine smoke remains bounded and
must complete and clean its sandbox. The first qualification exposed these pre-existing fixture
assumptions; no Windows cases were skipped to obtain a passing run.

Local checks additionally passed the packaged CLI source/bundle parity and cold-closure tests.
No prompt or bundle limit was increased. Repair uses already-loaded pinned inputs, not network
lookups or branch/history scans.

Latest main was checked again and its unrelated VS Code symlink change `f9510971` integrated without
conflicts. No CLI, plugin or schema source changed in that integration. Follow-up native run
`39135679846` passed 22 targeted integration checks per host (19 citation/refresh cases and three
built-extension host cases), with zero failures or skips, plus typechecking, build and unchanged
bundle limits. It exercised source/test revision `0cb0c429`; CI revision
`bdbc641c4af4d762d03df2be1ac46168f7963ea7` differed only by the temporary workflow. The upstream
refresh test's raw-path dynamic import was made portable with `pathToFileURL` before that run.

### source review citation repair — Upgrade and retained work

Update the CLI and Copilot/VS Code integration, then run the current phase's source review again.
Published Story sources, artifacts, clarifications, prior reviews and approvals are not rewritten.
This change does not itself retain the user's rejected packet, approve a phase or decide a human
exception. A new Story or author generation is unnecessary for packet-only citation/mapping repair.

## Residual branch reconciliation

This port starts from main `9160a763`, not either older branch. Source tips reviewed:
`64ba9890` (native release-hardening follow-ups) and `4c5e29a8` (optimization).
It is a selective port, not a merge of historical configuration, generated files or release claims.

### residual branch port — Retained from newer main

- State-index Story discovery, scoped Git snapshots and final fresh mutation checks.
- Local-only attachments, Auto candidate isolation and exact test-execution provenance.
- Managed runtime/distribution, automatic installation-receipt upgrade and recovery storage.
- Environment-packet cleanup workers, not the older IPC worker lifecycle.
- Current CLI/VS Code bundle ceilings and strict release qualification, including skip policy.

### residual branch port — Ported residuals

- Admit installer recovery before pulling its source; the Windows wrapper delegates that update.
  Interrupted recovery still names its retained journal, checkout and exact command.
- Hide stale/error approval actions and repaint availability on an unchanged fresh receipt.
- Verify submitted/approved checkout representations without rewriting immutable hashes.
  LF/CRLF equivalence never permits content, whitespace, mixed-ending, encoding or symlink changes.
  Bind sidecar provenance after managed metadata reaches its final generation bytes.
- Bounded Windows sharing-error retries replace the same complete atomic temporary file.
  Never remove an existing destination or replace active recovery with a fresh installation.
- ESM-URL portability in qualification/UI fixtures, and process quiescence/scratch retention in
  release diagnostics. Diagnostic continuation remains a failing gate.
- Native installer fixtures use the MSYS interpreter, not Git's PATH/argv-rewriting launcher.
  Recovery commands remain opaque at the native helper boundary, and partial-stream failure
  injection still exercises the pinned immutable installer path.
- UI/cache qualification follows main's Windows per-user cache and native absolute-path rules.
  Private encrypted checkpoint replacement retries transient sharing failures without deleting
  the previous seal. Readers retry a raced unlinked stat but never admit it as a trusted path.
- Content-addressed syntax facts, a dependency graph, bounded discovery/task and quality-command
  pools, corner-case signals, assertion diagnostics and a consolidated remediation projection.

### residual branch port — Verification boundaries

Syntax caches never store test outcomes, approvals, identity or authorization. Memory and optional
common-Git storage are bounded; persistent facts are recomputed before first use. Linked Story
worktrees use common Git storage, not a directory below their `.git` pointer.
Read-only draft checks do not write disk caches.

Corner-case diagnostics are advisory by default. New approved definitions may explicitly pin
`codeDelivery.cornerCaseObligations` and/or `codeDelivery.assertionAdequacy` to
`off`, `advisory` or `enforce`; omissions leave existing pinned policy unchanged.
Explicit enforcement refuses unavailable or over-budget inspection rather than silently passing.
The static matrix requires related source imports and symbol calls; it is not runtime coverage.
Scaffolds remain skipped candidates requiring real contract-specific assertions, never generated
passing evidence. Human decisions and native structured execution remain separately governed.

The bounded quality-runner API preserves original native result objects and opaque execution
receipts. Discovery overlaps independent reads. Governed quality execution keeps main's sequencing
and isolation; the older branch's broad publication rewrite is not restored over newer Auto,
report-capture, risk and mutation-binding fixes.

The dependency graph is an advisory/helper projection, not authority to omit required tests.
Remediation summaries list locations without rendering source or scaffold bodies.

### residual branch port — Qualification

Qualification uses native macOS and Windows hosts on Node 22 and 26, not a simulated platform.
Selected successful cohorts cover 133 verification/cache/transport/provenance tests, 61 installer
and release-harness tests, nine cache-authority tests, 45 UI/storage tests, 36 worktree-drop tests
and three approval-host tests. Each selected cohort completes without failures or skips.
The earlier broader publication cohort also passes its 142 generation, review, lineage and
delivery-evidence tests on both operating systems.

Native records: `39606050998` (broader exploratory qualification), `39612327702` (successful
diagnostic/cache/drop/approval cohorts), and `39613590501` (corrected installer/UI qualification).
Exploratory failures were retained and the affected suites re-run after corrections; a successful
cohort in a mixed-result run is not represented as a successful whole run.
All 13 VS Code bundle ceilings remain unchanged, CLI bundle parity tests pass, typechecking
passes, and `npm run check` passes 2963 checks.

This is not a 1.0 release certificate. The broader Windows workspace cohort still contains three
existing platform-skipped POSIX-only cases; these were not waived, reclassified or reported as
passing. Strict full-release qualification, genuine human approvals and complete native Copilot
Story qualification remain separate requirements.
