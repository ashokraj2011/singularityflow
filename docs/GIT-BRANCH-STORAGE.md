# Git branches and stored state

Singularity Flow separates application code, shared configuration, lifecycle state,
and audit proof so that changing one plane cannot silently rewrite another. This guide
explains every normal branch family created or managed by the product, what it stores,
who is allowed to write it, and whether it can be removed or rebuilt.

Not every repository has every branch. Branches are created only when the related
feature is used.

## Mental model

```text
application default branch     released or baseline product code
             |
             +---- <WORK-ID>    one Story's code and lifecycle authority

sflow/config                   reviewed configuration for future work
             |
             +---- sflow/config-change/*   review proposals
             +---- sflow/config-refresh/*  upgrade proposals

state                          orphan proof, mirror, and reusable-intelligence plane
```

The short version is:

| Branch | Question it answers |
|---|---|
| Application default, normally `main` | What product code is the repository based on? |
| `sflow/config` | What rules must newly started work follow? |
| `<WORK-ID>` | What is this Story doing, and what is its current governed state? |
| Configured state branch, normally `state` | What shared proof, mirror, and reusable repository state has been published? |

The lifecycle branch owns operational Story or Initiative state. The state branch is
a proof and projection plane; it does not authorize lifecycle mutations.

## Durable application and lifecycle branches

### Application default branch

Typical names are `main`, `master`, or an organisation-defined default.

It stores normal product source, tests, build files, and released configuration that
the repository owner intentionally keeps with the application. Capability mapping,
workflow editing, and configuration refresh do not directly write this branch.

Singularity Flow does not create the application default branch.

### Story branch: `<WORK-ID>`

Examples:

```text
CFA-STORY
WRK-234
ANU-STORY
```

A Story branch is created from the selected application or capability base. It stores:

- application source and test changes for the Story;
- `singularity/work-items/<WORK-ID>/workflow.json`, the Story's operational authority;
- phase artifacts, briefs, approvals, evidence, receipts, and review material;
- an immutable copy of the configuration selected when the Story started;
- `singularity/configuration-source.json`, which binds that copy to the exact
  `sflow/config` commit and per-file hashes.

Later updates to `sflow/config` affect future Stories only. They cannot silently change
an active Story's pinned workflow.

The Story branch is normally the source branch for the application's pull request. It
must not be reconstructed from the state ledger or from a local session file.

### Initiative or Epic branch: `<INITIATIVE-ID>`

The Initiative or Epic ID is its canonical lifecycle branch. It stores
`singularity/initiatives/<ID>/state.json` plus approved source records, decomposition,
evidence, approvals, contracts, and orchestration state.

### Registered child development branches

A developer may explicitly register a custom branch beneath a Story. The name is
chosen by the developer rather than generated from an SFlow prefix. These branches
contain application changes and lineage linking them back to the canonical Story.

## Shared configuration branches

### `sflow/config`

`sflow/config` is the approved configuration authority. It is created as an orphan
branch, independent of application history, and stores configuration only:

- `singularity/workflow.yml`;
- `singularity/capabilities.yml`;
- `singularity/portfolio.yml`;
- governed phase, policy, model-tier, and integration configuration;
- `.github/agents/*.agent.md`;
- prompts, skills, templates, and other approved configuration assets.

The lead repository's `sflow/config` owns the organisation capability map. Each
governed repository can also have its own approved configuration authority.

It does **not** store application source, Story runtime state, Story artifacts,
telemetry, or World-Model output. A new Story copies one exact approved revision from
this branch and records its provenance.

Do not merge `sflow/config` into `main`. Configuration changes are reviewed and
activated on this branch directly.

### `sflow/config-history/<CONFIGURATION-COMMIT>`

Each history branch is an immutable pointer to one exact approved `sflow/config`
commit. The full commit SHA is part of the branch name.

These refs keep older approved configuration fetchable after `sflow/config` advances
and protect it from remote object garbage collection. A history branch for SHA A may
only point to SHA A. It is not a new configuration proposal and should not be merged.

## Review and onboarding branches

### `sflow/govern/<repository>-<base-sha>`

This is the first-governance proposal for an existing application repository. It is
based on the application branch and contains the initial `singularity/**` and
`.github/agents/**` files for normal repository review. During bootstrap, SFlow also
creates the independent `sflow/config` and state branches without changing the
application default branch.

After the proposal is reviewed, it may be merged through the repository's normal
pull-request controls. It is not the shared configuration authority itself.

### `sflow/config-change/capability/*`

These branches contain one reviewed capability or organisation-map proposal. They
are based on an exact `sflow/config` commit and are created with a lease so movement
of the approved authority is detected.

They may contain approved configuration paths only. Activation either advances
`sflow/config` normally or recognizes an external review merge, records the exact
proposal commit, and updates the state projection. They never modify `main`.

### `sflow/config-change/workflow/*`

These branches contain proposed workflow, phase, artifact-template, prompt, agent,
or related configuration changes. They target `sflow/config`, not a selected Story's
pinned copy and not the application default branch.

### `sflow/config-refresh/*`

Configuration refresh normally publishes an approved three-way merge directly to
`sflow/config` when policy allows it. If protection, review policy, or a concurrent
authority change prevents that update, SFlow retains the exact candidate on a branch
with this prefix.

Merge the reported refresh branch into `sflow/config` through normal controls and
rerun `singularity-flow workspace refresh-configuration`. The rerun verifies the
winning configuration and completes the state mirror; it does not regenerate a
different candidate silently.

## Configured state branch

The default state branch is `state`. A repository may select another name through
`ledger.branch`; World-Model configuration can retain a compatibility override.

The state branch is an orphan branch with no application ancestry. It is written
through isolated temporary worktrees and must never be merged into `main`, a Story,
or an Initiative branch.

Depending on enabled features, it can contain:

| Path or area | Stored material | Authority status |
|---|---|---|
| `ledger/**` | Append-only lifecycle, activation, binding, and evidence events | Durable proof, not lifecycle mutation authority |
| Canonical configuration paths plus `configuration/manifest.json` | Exact mirror of approved `sflow/config`, source revision, hashes, and product revision | Read mirror; `sflow/config` remains configuration authority |
| `singularity/capability-authority.json` | Credential-free routing link from a delivery repository to its approved capability authority | Routing hint, not the capability authority itself |
| `singularity/world-model/**` | Reusable repository World Model, facts, views, evidence, manifests, and publication receipts | Shared repository intelligence for the exact source snapshot |
| `orchestration/stacks/<EPIC-ID>.json` | Deterministic cross-repository Story and pull-request merge order | Derived orchestration projection |
| `singularity/sgos/authority-stores/<STORE-ID>/**` | Git-trusted SGOS Capability Pack authority projection | Distribution projection; import still requires exact verification and confirmation |

The state branch combines two kinds of data:

1. **Rebuildable projections** — configuration mirrors, capability routing links,
   World Models, indexes, and Story-stack projections can be recreated from their
   authoritative inputs.
2. **Durable history** — append-only ledger and SGOS lineage must not be assumed
   reconstructable after deletion.

For that reason, deleting `state` is not a harmless cache clear.

## Optional Git pin refs

Ledger events can publish exact commit anchors under:

```text
refs/singularity/pins/<capability>/<event>
```

This is the default and is a Git ref namespace, not a normal branch. When
`ledger.pinTransport: branches` is explicitly configured, the equivalent anchors are
published under:

```text
refs/heads/singularity/pins/<capability>/<event>
```

These anchors support audit and retention. They do not contain an independent copy
of lifecycle state.

## Temporary local branches and refs

The runtime may create short-lived refs inside isolated local clones, including:

- `sflow-cache-state`, used while preparing a configuration refresh candidate;
- `sflow-fresh-install-source`, used to pin the exact installer source in a private
  detached clone.

They are implementation details, are removed with their temporary checkout, and
must never be pushed as shared product branches. World-Model analysis normally uses
a detached worktree rather than a durable named branch.

## Machine-local state is not a branch

The following files are deliberately local and are not shared through Git branches:

| Location | Purpose |
|---|---|
| `.git/singularity-flow/session.json` | Selects the current Story and governed agent for this checkout |
| `.git/singularity-flow/publication-journal/**` | Write-ahead recovery record before a governed commit is completed |
| `.git/singularity-flow/pending-publication/**` | Exact commit and push recovery after local commit succeeds but remote publication does not |
| `.git/singularity-flow/publication-rescues/**` | Preserved interrupted bytes recovered after a dead transaction owner |
| User-profile workspace registry | Workspace membership, clone locations, recent selection, and cached authority discovery |

Deleting a session selection loses no governed lifecycle state. Deleting publication
or recovery records while work is interrupted can remove the safe recovery path and
must not be used as a way to bypass a blocker.

## What may be deleted?

| Branch family | Normal deletion rule |
|---|---|
| `sflow/govern/*` | Remove only after the proposal is merged, intentionally declined, or superseded. |
| `sflow/config-change/*` | Remove only after activation/merge is complete or after the guarded discard command proves the exact stale proposal commit. |
| `sflow/config-refresh/*` | Remove after the reviewed configuration is merged and refresh reports the repository current. |
| Story or Initiative branches | Follow normal repository retention after completion/merge. Until then, the branch is the lifecycle authority. |
| `sflow/config-history/*` | Retain. These refs preserve exact configuration revisions used by historical work. |
| `sflow/config` | Do not delete casually. Re-creating it creates a new authority history and can make existing proposals unrelated. |
| Configured state branch | Do not treat it as a cache. Some projections can be rebuilt, but append-only proof and authority lineage may not be recoverable. |

Use `singularity-flow capability fsck`, `singularity-flow doctor --json`, and the
exact remediation command returned by a refusal before deleting any SFlow-managed
remote ref. SFlow does not force-reset or force-merge these authorities to hide an
inconsistent history.

## Inspect branches safely

List the common branch families without checking them out:

```bash
git ls-remote --heads origin \
  'main' \
  'state' \
  'sflow/config' \
  'sflow/config-history/*' \
  'sflow/config-change/*' \
  'sflow/config-refresh/*' \
  'sflow/govern/*'
```

Inspect an exact path directly from a ref:

```bash
git show origin/sflow/config:singularity/workflow.yml
git show origin/state:configuration/manifest.json
git show origin/CFA-STORY:singularity/work-items/CFA-STORY/workflow.json
```

Inspect SFlow's interpretation as well as raw Git:

```bash
singularity-flow doctor --json
singularity-flow capability fsck --lead <LEAD-REPOSITORY-URL> --json
singularity-flow workspace refresh-configuration --dry-run --json
singularity-flow wm status --json
```

Raw Git shows which refs exist. The SFlow commands additionally verify ancestry,
schema, hashes, authority bindings, pending publication, and recovery state.

## Authority summary

```text
sflow/config
  defines future policy
        |
        +-- exact snapshot copied to <WORK-ID>
              owns that Story's lifecycle and product change

state
  proves events and carries verified mirrors/projections
  never replaces the lifecycle branch or sflow/config authority

local .git/singularity-flow
  selects and safely recovers work
  never grants shared authority
```

See also:

- [State authority and recovery contract](STATE-AUTHORITY.md)
- [Existing-workspace configuration refresh](../README-REFRESH-EXISTING-WORKSPACES.md)
- [Capability-map Git robustness plan](CAPABILITY-MAP-GIT-ROBUSTNESS-PLAN.md)
- [World-Model Builder v4](WORLD-MODEL-BUILDER-V4.md)

