# State authority and recovery contract

The lifecycle branch owns operational state; local context selects it; the state branch proves and mirrors it; every mutation passes through one deterministic publication transaction.

## Authority table

| Plane | Stored at | Role | May select work? | May authorize a mutation? | Recovery rule |
|---|---|---|---:|---:|---|
| Shared configuration | `sflow/config` in the lead repository | Approved workflows, capabilities, agents, prompts, skills, templates, policy, and repository registry for future work | No | Defines, but does not itself perform, lifecycle mutations | Fetch the reviewed branch; never infer configuration from application `main` or the proof ledger |
| Lifecycle configuration snapshot | Configuration files plus `singularity/configuration-source.json` on a Story branch | Immutable configuration used by one Story | No | Constrains every Story mutation | Verify the recorded full commit and per-file SHA-256; recreate an unstarted branch rather than silently upgrading it |
| Story lifecycle | `singularity/work-items/<ID>/workflow.json` on the Story lifecycle branch | Operational authority for Story phase, artifacts, decisions, and revision | Yes | Yes | Fetch and fast-forward the registered canonical or child branch; never reconstruct it from session state or the ledger |
| Initiative lifecycle | `singularity/initiatives/<ID>/state.json` on the Initiative lifecycle branch | Operational authority for Initiative phase, evidence, approvals, and breakdown | Yes | Yes | Fetch and fast-forward the registered lifecycle branch; append-only retry is a conflict strategy, not a second authority |
| Local context | `.git/singularity-flow/session.json` and the workspace selection under the user profile | Selects a lifecycle subject and governed agent for this checkout | Yes | No | Recreate it from a selected lifecycle branch; deleting it loses no governed state |
| Publication transaction journal | `.git/singularity-flow/publication-journal/<kind>--<ID>.json` | Machine-local write-ahead record containing the expected HEAD, live owner, event, and integrity-bound governed preimage | No | Blocks concurrent mutation while active or recoverable | Never roll back a live owner; after a dead pre-commit owner, rescue partial bytes and restore only the recorded governed roots; after HEAD advances, retain the commit and resume publication |
| Pending publication | `.git/singularity-flow/pending-publication/<kind>--<ID>.json` | Local recovery record for a commit that exists but did not reach its remote | No | Blocks new mutations until synchronized | Retry the recorded fast-forward push; never rewrite or amend the retained commit |
| Capability state branch / ledger | Configured orphan state branch | Append-only proof, binding, and the preferred organisation capability-map read mirror | Read-only mirror only | No | Reproject from approved `sflow/config`; ledger-only lifecycle subjects remain read-only until their lifecycle branch is available |
| Git-trusted SGOS Authority Store projection | `singularity/sgos/authority-stores/<store-id>/current.json` on the configured state branch | Deterministic team transport of the complete Pack authority lineage | No | No; import still requires exact approved authority and confirmation | Read only from the exact freshly observed remote state commit; install, no-op, or strict fast-forward; never fall back to local/cached state or merge divergence |
| Human and audit projections | `STATUS.md`, managed artifact metadata, approval summaries, review packets, ledger intents, reports, capability dashboard, Inbox, and revisioned VS Code snapshots | Derived presentation or exact reproducible audit material | No | No | Regenerate from authoritative lifecycle state and immutable records at one captured revision |
| Remote systems | Jira, CI, storage providers, GitHub observations | Timestamped evidence and external receipts | By explicit identity/reference | No, unless an exact reviewed write plan says otherwise | Refresh observations and record drift; never silently overwrite Git-owned state |
| Governed references | Committed `context/references/<sha256>.json` beside Story or Initiative state | Revision-bound address of approved artifact bytes | No | No | Verify the exact Git object, raw hash, renderer version, and bounded preview; an opaque handle never grants arbitrary path access |
| Harness observations | `.git/singularity-flow/harness-events/*.json` | Local, content-addressed execution and conformance evidence | No | No | Rebuild the report from valid events; unavailable host data stays explicitly unavailable and is never inferred |
| Reusable knowledge | `singularity/knowledge/records/<sha256>.json` | Governed append-only claims with approved provenance and explicit scope | No | No | Reject unapproved provenance; rebuild indexes and prompt projections from the committed records |

## Resolution contract

`RepositorySubjectIndex` reads Story `workflow.json` and Initiative `state.json` using their actual schemas. It indexes stable IDs, canonical branches, registered child branches, and declared aliases. Every surface follows the same rules:

1. An explicit Story or Initiative argument wins over local context.
2. A registered canonical or child branch resolves to its owning lifecycle subject.
3. More than one match is an error that lists candidates; the system never guesses.
4. A missing reference may be treated as a new ID only by an explicit creation command.
5. A ledger-only binding is readable evidence, not a mutable aggregate.

Workspace selection and VS Code state are therefore convenient pointers, never an alternative source of truth.

Organisation capability discovery follows the same split. It reads the state-branch
mirror first, falling back to the approved `sflow/config` copy when the mirror has not
yet been projected. A durable machine-local cache is accepted only when it was
validated for the current configuration-branch commit. If the remote is unreachable,
the last validated entry may be returned as explicitly stale, including its age and
remote error; it never becomes mutation authority.

Capability configuration activation is the only governed write path. It binds the
full proposal commit, performs a dry-run of the exact normal push to `sflow/config`,
requires an explicit acknowledgement when that direct update is permitted, and
appends an activation ledger event after the target is established. Local capability
authoring commands do not publish the map or move the state branch.

SGOS `git-trusted` transport uses the state branch as a distribution authority, not as an
alternative mutable Store. `authority-store publish` verifies the complete local Store and Pack
graph, previews an exact compare-and-swap, and writes only the selected Store projection through an
isolated state worktree. `authority-store sync` reads only the exact current remote commit in an
isolated object store and performs an atomic local cutover after confirmation. The projection is
path-neutral and has no outer Authority transport signer, signature, or private key; it still
carries signed Pack records and their mandatory publisher signatures. A new clone
therefore trusts the Git host and branch controls against rollback, while an existing Store also
refuses older or divergent lineages. This profile requires an approved reachable remote and state
branch; offline root-commit repository binding is supported only by signed-v2 transport. The Git
identity confirming sync must belong to `architecture-reviewers`, and an approved v3
`minimumAuthority` checkpoint prevents both sync and rollback from moving below that exact
revision/state/projection. The checkpoint is optional only for bootstrap and should be advanced in
approved configuration after the first successful publish as defense in depth.

Runtime Pack and Process admission reads Pack lineage only from the installed Git-common Store; it
never fetches the state branch or auto-syncs Store authority. The surrounding command may still
refresh approved `sflow/config` policy under its normal configuration-authority rules. Store
freshness changes only through explicit `authority-store sync`: preview freshly reads the approved
remote state commit and confirmation rechecks the plan before local cutover.
Adding an approved Pack publisher key changes signature verification authority but imports no Pack;
removing a key makes all historical Pack records signed by it unverifiable. Revoke or supersede
those Packs to stop their use while retaining the public key needed to verify immutable history.

## Publication contract

A lifecycle mutation must verify its branch, current HEAD, aggregate, and absence of a pending publication; acquire its subject lock; persist an integrity-bound preimage before the first governed write; write state and projections; validate invariants; stage only allowed paths; create one commit; and push without force. A normal pre-commit failure restores the same preimage before returning. After hard process death, `sync` reclaims the dead lock, preserves the interrupted bytes under `.git/singularity-flow/publication-rescues/`, restores only the journal's governed roots, verifies the restored digest, and then clears the journal. Unrelated source and staged changes are not reset. Once HEAD advances, rollback is forbidden: a failed push leaves the commit intact and writes only the local pending-publication record under `.git`. Cross-machine concurrency remains governed by Git fast-forward rejection.

Repositories that failed publication before the local recovery plane was introduced
may contain `publication-pending.json` beside Story or Initiative state. Reading that
subject atomically copies the record under `.git` and removes the legacy control file;
the unpublished commit remains blocked until the normal `sync` succeeds. `doctor`
fails when it finds an orphaned legacy marker that could not be associated and
migrated. This narrow recovery-marker bridge does not migrate lifecycle schemas.

Story and Initiative publication both delegate this algorithm to `GitPublicationUnitOfWork`. Sequence evaluation and reduction are pure; confirmation is a surface port. A subject-local lock prevents same-checkout read/modify/write races, while Git fast-forward rejection remains the cross-machine arbiter.

Projection repair never invents lifecycle facts. It may only regenerate a declared
projection from the currently loaded authoritative aggregate. It cannot recreate a
missing approval, artifact, lifecycle event, or remote receipt, and it cannot use
the ledger or local session as a substitute for a missing lifecycle branch.

Governed reference handles follow the same rule. A handle resolves only through its
committed reference record and exact Git revision. Deterministic expansion may
project a Markdown section, JSON Pointer, or explicit range, but cannot accept an
arbitrary repository path. Harness reports and search indexes are local projections;
neither may authorize lifecycle work or substitute for approved artifact bytes.

`singularity-flow state reconcile <ID> --check` reports every declared projector and
its expected and current hash without writing. `--repair-projections` replaces only
the managed bytes produced by `projectStatusMarkdown`, `ArtifactMetadata`,
`ApprovalSummary`, `ReviewPacket`, and `LedgerIntent`. Review-packet and ledger-intent
recipes are captured in lifecycle state when they are created; authored artifact
content is preserved while only its managed metadata block is replaced.

This development line has no lifecycle-schema migration layer. Only the current Story and
Initiative schemas are accepted; disposable development state must be recreated
with `singularity-flow factory-reset` and a fresh start.
