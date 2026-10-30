# SDA M3: transactional drafts, typed intent, lazy cloning, lease-proven locks

Specification: `docs/SPEC-SDA-STORAGE-INDEPENDENT-WORKFLOW-v1.md` (§6.3, §9, §11, §20 M3).
Authority: ADR 0018 option A. The Story branch stays lifecycle authority, so nothing here moves
authority.
Engine: `main@bce954290` plus this change.

M3's exit condition:

- crash and duplicate-operation tests pass;
- ordinary configuration editing needs no checkout.

Both hold for the paths listed below. The exceptions are listed under "Open after M3".

## What landed

| Deliverable | Where | Checked by |
|---|---|---|
| Transactional drafts | `src/configuration-drafts.mjs` (store v2) | `test/configuration-drafts-store.test.mjs`, `test/configuration-drafts.test.mjs` |
| Typed configuration intent, edited with no clone | `src/configuration-projection.mjs`; `proposeConfigurationChange` and `publishCurrentIdentityToConfiguration` | `test/configuration-proposal.test.mjs` |
| Capability edits and activation with no textual merge | `src/capability-value-replay.mjs`, `src/git-configuration-objects.mjs`, `src/organisation.mjs` | `test/capability-value-activation.test.mjs` |
| Lazy workspace cloning | `src/workspace.mjs` (`deferred` state), `src/workspace-story-checkout.mjs` and the commands that read a workspace | `test/workspace-deferred.test.mjs` |
| Lease-proven lock recovery | `src/lease-liveness.mjs`; `src/subject-lock.mjs`, `src/file-lease.mjs`, `src/publication-pending.mjs`, `src/sgos/platform/authority-store.mjs`; `lock show/release` (`src/commands/lock.mjs`) | `test/lease-liveness.test.mjs` |

## Transactional drafts (SDA-AC-003, SDA-AC-005)

**Storage.**
- **Before:** every configuration draft lived in one `drafts.json`, rewritten with no fsync, lock or
  compare-and-set. Proposing and settling drafts could silently drop a draft saved meanwhile.
- **Now:** `configuration-drafts/v2/` holds one immutable file per draft (`cdr-<24 hex>.json`). Each
  file is written create-only and fsynced together with its directory, so a draft is either absent or
  complete. A crash leaves at most a temporary file, which the next save sweeps.

**Changing drafts.** Every save, discard, proposal and settle runs under one lock; reads take none.
- A proposal records the exact draft IDs it consumed, and settling removes only those.
- Discarding works by draft ID. A list number is checked against the listing it came from.

**Idempotency.** A save carries an operation ID: `--operation-id`, or by default the digest of the
change.
- The same ID with the same content returns the same draft.
- The same ID with other content is refused with `CONFIGURATION_DRAFT_OPERATION_REUSED`, outcome class
  `OPERATION_ID_REUSE`.

**Migration.** The old `drafts.json` is migrated explicitly, once, and kept as
`drafts.json.migrated-v2`. An interrupted migration resumes without duplicates.

**Remote access.** Once a repository's approved configuration is recorded, a save makes no remote
contact. It still starts local Git processes to read the local configuration it checks against. The
§17 target of zero processes per draft save is not met.

**Tests.** They cover:
- a save killed mid-write;
- three processes saving at once;
- a draft saved during a proposal surviving it;
- a repeated operation ID, including two processes racing;
- migration, including an interrupted one;
- `index rebuild` leaving every draft byte-identical.

## Configuration editing with no clone, and its typed intent (SDA-AC-013)

**Before:** every proposal cloned `sflow/config` into a temporary directory.

**Now** (`src/configuration-projection.mjs`):
1. One fetch brings the branch's tip and its objects into the application repository's own object
   store, kept by `refs/sflow/configuration-projection/base`.
2. The edit runs in a temporary repository that borrows those objects (Git alternates) and holds the
   exact commit's files.
3. Staging, the reviewed-tree check, the commit and retention run there as before.

The application checkout and its branches are never touched, and the next edit transfers only what
changed.

The change covers:
- Studio apply;
- `config save --propose`;
- proposing drafts;
- workflow package submission;
- SGOS authority proposals;
- approval-group enrollment (`configuration add-current-identity`).

**Typed intent.** Each proposal records its intent's kind and the canonical digest of its operations.
- **Where:** as commit trailers (`Sflow-Intent-Kind`, `Sflow-Intent-Sha256`), in its push record and in
  its result.
- **Kinds today:**
  - `studio-change-set`: the Studio operations;
  - `configuration-file`: a whole-file save, with its path and byte digest;
  - `approval-membership`: the members added and the policy fields changed.
- Existing `cfp-` and `cft-` IDs keep their derivation.

**Capabilities** (`src/capability-value-replay.mjs`):
- **Activation and its mergeability check** no longer run `git merge` or `merge-tree`.
  - The proposal's own changes are re-applied value by value onto the current authority:
    - a file only the proposal changed is taken as it is;
    - a YAML or JSON file both sides changed is merged field by field;
    - anything else both sides changed is a conflict, `CAPABILITY_PROPOSAL_VALUE_CONFLICT`.
  - The activation commit is built from exact objects (`commit-tree`) and pushed with the existing
    lease.
- **Capability edits** build in a private object store, with no clone.

**What a value-level merge changes.**
- Two maps that add different capabilities to one file used to be "unmergeable" and needed a rebase.
  They now merge and activate directly, so `rebase-proposal` answers
  `CAPABILITY_PROPOSAL_REBASE_NOT_REQUIRED`. Seven tests of the old rebase mechanics were removed.
- Two cases a textual merge resolved silently are now refused:
  - a list edited at both ends (a list is one value);
  - an agent Markdown file edited on both sides.

## Lazy workspace cloning (§11)

**What a new workspace saves.** Only its manifest, its materialization journal and its registry
entry. The approved catalog is checked once at creation, and its proof is kept in the bootstrap
receipt.

**The `deferred` state.** Each repository is `deferred` until work needs it. A deferred repository
counts as healthy; status lists it with the command that clones it. `missing` stays for a clone that
existed or was claimed and is gone.

**What each kind of command does with a deferred repository:**
- **Mutating commands:** clone only the repository they need, as Story start and `session attach`
  already did.
- **`workspace copilot`:** clones on launch.
- **Reads:** answer without a clone, or say plainly that the repository is not cloned yet and give the
  command.
  - `inbox` reads Stories from the remote.
  - `home`, `recommend` and the gateway never get a path that does not exist.
  - `session current`, `goal`, `journal` and `env files` answer as described in
    `test/workspace-deferred.test.mjs`.
- **VS Code:** says "not cloned yet" and offers "Clone all now".

**Defaults.** `createWorkspace` and `saveWorkspaceConfiguration` now default to no clone.
`prepareWorkspaceBootstrap` clones only when it initializes state, which needs a checkout. Existing
workspaces are unchanged.

## Lease-proven lock recovery (§9)

**Before:** a lock was taken over when its heartbeat aged past a lifetime. That was 3 hours for
subject locks and 15 minutes for registry leases, so a laptop that slept through a long push lost its
lock to a second writer. The observer's own lifetime decided another process's lease.

**Now:** one predicate (`src/lease-liveness.mjs`) answers whether an owner is alive, dead or unknown.
Age never decides. It is used by subject locks, registry leases, publication journals and the SGOS
authority store.

**On this machine**, judged by machine ID rather than hostname, so a hostname change does not matter:
- **dead:** the owner's process is gone, or its process ID now belongs to a process that started
  later (ID reuse, read through `ps` or PowerShell);
- **alive:** the process exists, including when its start time cannot be read (fail closed).

**On another machine**, the owner is always `unknown` and never taken over automatically.

**What a waiting command does.** A lease whose owner is unknown, or alive but no longer renewing, is
never taken over. The waiting command's refusal names the owner, its machine and last heartbeat, and
the route a person takes:
- `singularity-flow lock show <KIND> <ID>` reads the lease;
- `singularity-flow lock release <KIND> <ID> --confirm <LOCK-TOKEN>` removes exactly the generation
  the person reviewed, and records the release in `locks/released-leases.jsonl`.
- Releasing is an own-terminal step: every Copilot turn refuses it.

**Factory reset** keeps the machine-identity file, so this machine's older leases never read as
another machine's.

**Tests.** They cover:
- a live owner with a stale heartbeat, never taken over;
- process ID reuse, taken over;
- a dead owner, taken over;
- another machine's lease, never taken over, and its reviewed release;
- a hostname change on the same machine;
- the same rule in publication journals and the SGOS store.

## Budgets

Raised with measured values. Most of the growth is the lease owner proof, which every closure that
takes a lock now reads.

| Budget | Ceiling | Measured |
|---|---|---|
| `commands/start.mjs` eager source | 9,305,000 | 9,302,341 |
| `commands/start.mjs` modules | 460 | 460 |
| Session current | 3,980,000 | 3,979,930 |
| Submit files | 465 | 465 |
| Copilot edit guard modules | 63 | 63 |
| Review read closure modules | < 265 | 264 |
| Narrow-reads chunk | 4,555,000 | 4,552,616 |
| Hook-context chunk | 7,605,000 | 7,600,938 |
| Catalog chunk | 5,390,000 | 5,388,142 |
| VS Code `extension.cjs` modules | 151 | 151 |
| VS Code `gateway-runtime.cjs` modules | 788 | 788 |

## Fixed on the way: refresh coalescing under load (SDA-AC-014)

M3's full suite made M2's cross-process coalescing test observe twice under load. A read could miss
another process's refresh in two ways:
- that refresh finished between this read's look at the record and its own lease;
- this read began waiting after that refresh had already observed the authority.

Both paths now apply one rule. A record newer than the one this read judged, with the same authority
and the same dependencies, is the answer. An explicit refresh still makes its own observation.
`test/sda-read-index.test.mjs` covers the late-waiter case deterministically.

## New names (SDA-AC-023)

`test/sda-names.test.mjs` lists them all with their owning modules. It allows exactly one new machine
location, `SINGULARITY_FLOW_MACHINE_ID_FILE` (`machine-id`), which is registered in
`scripts/test-machine-state.mjs`.

- **Commands:** `lock show|release|release-file`, own-terminal step `lock-release`.
- **Refusal codes:**
  - Drafts: `CONFIGURATION_DRAFT_OPERATION_REUSED`, `CONFIGURATION_DRAFTS_CHANGED`,
    `CONFIGURATION_DRAFT_OPERATION_INVALID`.
  - Proposals: `CONFIGURATION_PROPOSAL_INTENT_INVALID`, `CONFIGURATION_PROJECTION_BASE_UNAVAILABLE`.
  - Capabilities: `CAPABILITY_PROPOSAL_VALUE_CONFLICT`, `CAPABILITY_CONFIGURATION_OBJECTS_UNAVAILABLE`.
  - Lease release: `SUBJECT_LOCK_RELEASE_*`, `WORKSPACE_REGISTRY_RELEASE_*`, `SGOS_AUTHORITY_LOCK_RELEASE_*`.
  - Lock command: `LOCK_COMMAND_INVALID`.
  - Deferred repositories: `ACTIVE_WORKSPACE_REPOSITORY_DEFERRED`, `GOAL_REPOSITORY_DEFERRED`,
    `ENV_FILES_REPOSITORY_DEFERRED`.
- **Paths:**
  - `configuration-drafts/v2/`;
  - `refs/sflow/configuration-projection/base`;
  - `locks/released-leases.jsonl`;
  - `~/.singularity-flow/machine-id`.
- **Commit trailers:** `Sflow-Intent-Kind`, `Sflow-Intent-Sha256`.

## Open after M3

- **A draft save still starts local Git processes,** short of the zero-process target in §17.
- **Clones that remain outside ordinary editing:**
  - workflow proposal inspection and activation (the configuration object pool, with a blobless
    clone fallback);
  - capability activation's review checkout, where the ledger audit and cleanup run;
  - capability map, team, repository, adoption, policy and rebase edits;
  - recreate-and-sync.
- **Containers that share one home directory share one machine ID,** so one container could take over
  another's live lease.
- **`intake` on a deferred repository** still answers `workspace-repair-required`, as the `/sf-start`
  skill expects.
- **M0's Windows baselines and M2's Windows zero-Git measurements** remain open.
