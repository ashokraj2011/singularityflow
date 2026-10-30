# Singularity Flow Storage Independent Workflow Architecture

Specification ID: `SDA-v1`

Version: `1.1` (draft)

Status: Proposed

Date: 2026-10-29

Supersedes: the SDA v1.0 draft of 2026-10-21, which was never added to this repository

Reviewed against: singularity-flow `main` at `41ffdcbe2`

## 0 Changes from v1.0

v1.0 was reviewed against the code. Every claim below was checked on `main`. The main corrections:

1. **Authority model (§6, §10).** v1.0 treated the shared ledger as accepted workflow state. Today the Story's own `<WORK-ID>` branch owns lifecycle state. The `state` branch is a proof and projection plane that "does not authorize lifecycle mutations" (`docs/GIT-BRANCH-STORAGE.md`). Lifecycle commits and source commits share one history. Splitting a shared-state adapter from a source-control adapter is therefore a change of authority, not a wrapper. v1.1 makes it a separate decision (§6.2, Stage 4) and keeps M0–M2 read-only with respect to authority.
2. **Name collisions (§8, §12, §14).**
   - The top-level `storage:` key already configures document byte providers (`src/config.mjs`), and older builds drop unknown sub-keys rather than refuse them.
   - `sync <WORK-ID>` already publishes a Story. Work IDs match `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`, so `sync status` would name a Story.
   - `/sf-check` already exists as an explicit local refresh that never fetches.
   - `.sflow/` is disposable per-checkout output (`.sflow/out`, `.sflow/results`).
   - A 30-minute advisory interval already exists as the repository-check settings.

   v1.1 uses none of these names for new meanings.
3. **World Model (§13).** The shared, registered World Model, its Story pins and the CALM projection were removed (`src/removed-features.mjs`). What remains is a machine-local knowledge cache that is never authority. §13 is rewritten.
4. **SQLite runtime (§6.3).**
   - The only SQLite in use is `sql.js`, an in-memory, whole-file projection rewritten atomically (`src/configuration-state-service.mjs`).
   - `node:sqlite` is not available under the declared Node 20 floor.
   - v1.1 keeps durable authored data in the existing fsynced journals and allows SQLite only for rebuildable indexes.
5. **Existing mechanisms (§7).** Most v1.0 adapter semantics already exist under other names: compare-and-swap refusals, operation-ID reuse refusals, indeterminate push outcomes, the publication journal, transport and ledger outboxes, and an atomic branch-plus-ledger-plus-pin push. v1.1 maps the v1.0 names onto them instead of inventing parallel ones. It also names the real semantic gaps.
6. **Scope (§20).** The verified gaps become the M0–M2 scope:
   - reads that block on the network;
   - payload-blind ledger idempotency;
   - configuration reads that clone;
   - identity leaks;
   - outcome dialects;
   - scattered local Git.

## 1 Purpose and decision

Make Git an infrastructure adapter rather than the programming model for Singularity Flow. Stories, phases, configuration, evidence and decisions must have domain identities and operations that do not depend on branches, worktrees or Git command output.

v1.1 proceeds in two phases with different risk:

- **Phase A (M0–M2): reads and identity.**
  - Ordinary listings, sessions, catalogs and advisory next actions are served from verified local state without starting Git.
  - Identity leaks are removed.
  - Existing semantics get one vocabulary.

  Phase A changes no authority: the Story branch, the `sflow/config` authority and the `state` ledger keep their present roles.
- **Phase B (Stage 3 onward): writes and authority.**
  - Drafts and typed configuration intent move to transactional local storage.
  - Separately reviewed, Phase B decides whether lifecycle authority moves off the Story branch (§6.2).

  Phase B needs its own architecture decision record (ADR) before any build. ADR 0018, accepted on 2026-10-30, chose option A: the Story branch stays lifecycle authority.

There must be one configured authority for each domain namespace. Local saved work, cached accepted state and remotely accepted state are distinct. A local write cannot silently become a shared approval.

## 2 Problem and existing foundations

Git performs several jobs at once:

- application source control;
- workflow-state persistence;
- configuration transport;
- evidence retention;
- discovery;
- synchronization;
- concurrency control.

These jobs have different latency and consistency requirements but are often reached through the same command paths. This coupling creates avoidable work:

- An advisory listing whose cache has expired waits for a remote fetch.
- A failed refresh refuses instead of showing what is known.
- Configuration inspection clones the authority into a temporary directory.
- Branch names and local paths still leak into some identities.

### What already exists

v1.1 builds on these, and does not create a second engine beside any of them:

| Area | Existing mechanism | Notes |
|---|---|---|
| Lifecycle authority | The Story's `<WORK-ID>` branch | It owns operational Story state. `docs/GIT-BRANCH-STORAGE.md` |
| Proof and projection | The `state` ledger (`src/ledger.mjs`, `src/ledger-config.mjs`) | The seeded template enables it; the code default is off. Trust tiers T2 and T3 require commit signing. |
| Atomic multi-ref publication | `publishBranchWithLedgerEntry` (`src/ledger.mjs`) | The Story branch, ledger entry and pin advance in one `--atomic` push under exact leases. |
| Recoverable publication | `src/publication-journal.mjs`, `src/publication-unit-of-work.mjs`, `src/publication-pending.mjs` | Staged journal with indeterminate and rejected push branches. Concurrent writers are refused with `PUBLICATION_JOURNAL_CONFLICT`. |
| Pending pushes | `src/transport-intents.mjs` (transport outbox under `~/.singularity-flow`) and the ledger outbox | Statuses include `outcome-unknown` and `remote-diverged`. Identical requests are deduplicated. |
| Other journals | `story-start-journal`, `phase-repair-journal`, `phase-continuation-journal`, the configuration journal | Each remains authoritative for its own operation type. |
| Remote Git boundary | `src/git-execution.mjs`, enforced by `test/git-remote-boundary.test.mjs` | "One boundary for Git commands that contact a remote". Local Git is not centralized. |
| Configuration service | `src/configuration-state-service.mjs`, `-contract.mjs`, `-git.mjs` | Indexed proposal projection (`sql.js`), journals on the SGOS operational store, never authority. |
| Non-authoritative store SPI | `src/sgos/operational-store.mjs` | Capabilities must equal a frozen constant, and an `authorityEligible` adapter is refused (`SGOS_OPERATIONAL_ADAPTER_INVALID`). |
| Authority store with compare-and-swap | `src/sgos/platform/authority-store.mjs`, `src/sgos/authority-git-transport.mjs` | Filesystem store separated from its Git transport, with cutover and rollback receipts. It is a precedent for §7. |
| Execution context | `src/story-execution-context.mjs`, `src/workflow-snapshots.mjs` | Verifies retained workflow, agent, skill and instruction snapshots. Older Stories run as `legacy-live` with an unproven closure. |
| Story locator | `src/story-index.mjs` | Machine-wide index: one checkout per Story, verified on read. |
| Advisory freshness | `src/repository-check-settings.mjs`, `src/repository-check-cache.mjs`, `src/session-listing-cache.mjs` | Modes `always`, `cached` and `manual`; default `cached` / 30 minutes. Machine-local; never Story policy. |
| Takeover | `session takeover` (`src/commands/session-takeover.mjs`), `src/document-runtime.mjs` | Attaches with an isolated worktree. Missing laptop-local documents raise `DOCUMENT_REUPLOAD_REQUIRED`, and restore accepts only matching bytes. |
| Writer fence | `product.yml` `minimumBuild` (`src/product-requirement.mjs`) | Read from approved configuration and enforced before a command proceeds. |
| Record migration | `src/schema-migrations.mjs` | Migration at read time. A newer record is refused with `SCHEMA_VERSION_FUTURE`. |
| Shared result contract | `sflow-result` v2 (`src/gateway/result.mjs`), `src/safe-command-guidance.mjs` | Statuses `succeeded`, `refused`, `failed` and `noop`; next actions in Copilot, Shell and VS Code forms. |

## 3 Goals and non-goals

### Goals

1. Keep branches, refs and local paths out of workflow entity identity.
2. Serve ordinary listings, search, dashboards and advisory next actions from verified local state. With a usable local snapshot they start no Git, remote or model process, and they never block on the network.
3. Share one domain service and result contract across CLI, VS Code, Copilot, workers and hooks.
4. Give existing write semantics one vocabulary: revision conflict, operation-ID reuse, unknown outcome.
5. Preserve exact source, artifact, test, configuration and approval bindings.
6. Support offline reading and drafting without claiming shared acceptance.
7. Keep Story takeover on another laptop free of branch scans and history walks.
8. Introduce replaceable read and source-inspection interfaces, with executable conformance tests.
9. Preserve legacy Stories and running recovery operations during an incremental rollout.

### Non-goals

- Replacing Git as the application's source-control tool.
- Moving lifecycle authority off the Story branch in Phase A.
- Eliminating the cost of application cloning, dependency installation, tests or model calls.
- Making Git pushes, local database commits and third-party side effects one atomic transaction.
- Implementing an authenticated hosted database service.
- Treating database plugins or executable adapters supplied through workflow YAML as trusted.
- Weakening human approval, evidence verification, source binding or phase mutation policies.
- Uploading laptop-local attachments merely because workflow state is synchronized.
- Renaming existing refusal codes, commands, configuration keys or paths that scripts and older clients depend on.
- Rewriting or deleting historical evidence, signatures, branches or unpushed work.

## 4 Architectural boundaries

Every surface calls application services. Application services enforce lifecycle and authorization rules using domain contracts. Infrastructure adapters provide persistence, synchronization, artifacts and source control.

| Boundary | Responsibility | Must not do |
|---|---|---|
| Surface adapters | Parse user actions and render common results | Implement phase transitions, infer approvals or construct repository paths independently |
| Workflow application service | Execute commands, validate bindings, authorize transitions and coordinate recovery | Parse Git output or assume a particular database |
| Domain model | Define Stories, phases, requirements, decisions, generations and invariants | Know branch names, storage locations or transport commands |
| Local read index | Serve verified projections, with their freshness | Become authority, or hold the only copy of anything |
| Local authored store | Save drafts and pending operations (Phase A: the existing journals) | Turn projected or pending state into shared authority |
| Lifecycle authority adapter | Read and conditionally advance accepted Story state (today, the Story branch plus its ledger entry) | Bypass domain validation, or treat transport credentials as review authority |
| Source-control adapter | Inspect source, prepare checkouts and publish selected source changes | Decide a Story's phase, approval or configuration authority |
| Synchronization coordinator | Transfer missing records and reconcile pending operations | Treat a timeout as proof that an operation failed remotely |

### Git today

- **Remote Git** is already behind one tested boundary: `src/git-execution.mjs` and `test/git-remote-boundary.test.mjs`.
- **Local Git** is not. About 140 source files outside the `git*.mjs` modules start Git directly, and many define their own wrapper.

Phase A introduces a **source inspection facade** for local reads, the calls that read refs, objects and status. Migration to it is enforced by a ratchet test in the style of the remote boundary: the count of direct local-Git call sites may only fall. Write paths keep their current modules until Phase B.

**M1:** the facade is `src/source-inspection.mjs`. Every read answers `present`, `absent` or `unavailable`. `test/source-inspection.test.mjs` holds each module's own local Git reads to `localReads` in `benchmarks/sda/inventory.json`, and fails on a rise or an unrecorded fall.

The domain must not expose methods named `checkoutBranch`, `mergeRef`, `lsTree` or `readGitBlob`. Appropriate operations are `listStories`, `loadPhaseSnapshot`, `saveDraft`, `submitGeneration` and `recordDecision`.

## 5 Identity and data model

### Stable identities

Use stable identifiers for the organization or authority scope, capability, repository, workspace definition, Story, workflow definition, phase, generation, proposal, decision and operation. Human-readable Story names and branch names are mutable labels or bindings.

A Story's identity is its Work ID. The branch is chosen once and recorded (`workItem.branch`, `lineage.canonicalBranch`). These identity leaks remain and are Phase A work (M2):

| Leak | Today | Required |
|---|---|---|
| Discovery and the branch | Discovery refuses a Story whose recorded branch differs from the ledger pointer's branch | Resolve by Work ID; report the mismatch as a binding finding |
| Branch as a lookup alias | The Story index accepts a branch name for a Work ID | Keep for compatibility, but only as a recorded alias, never inferred |
| Branch name equals the Work ID | The Auto start path still assumes it | Use the recorded branch binding |
| Epic and Initiative IDs | `scanLocalIdentities` (`src/local-identity.mjs`) lists every local and remote branch | Allocate from the authority's identity records |
| Repository without a remote | Keyed by a `gitdir:` path | Assign a stable repository ID at registration; the path is a local binding |
| Push intents | Store the absolute checkout path | Store the repository and checkout IDs; resolve the path locally |

**M2:** each row is closed, with two exceptions:

- `session attach` still refuses a Story listed with a binding finding.
- Auto refuses a recorded branch other than the Work ID until Story start can take one.

The details are in `benchmarks/sda/m2-read-index.md`.

Git remotes remain credential-free source locators. `gitRepositoryComparisonKey` (`src/git-repository-identity.mjs`) treats GitHub's SSH and HTTPS spellings of one repository as the same repository; GitHub documents that equivalence. v1.1 keeps it, recorded as a built-in equivalence rule. Any other alias needs the approved mapping or a reviewed equivalence record.

### Decisions and findings

Decisions must use canonical finding or obligation identity rather than a displayed sentence. Two places violate this today:

- **Code-delivery disputes** store and match the problem sentences the gate printed (`src/phase-finding-dispute-schema.mjs`), so a rewording breaks a dispute.
- **The finding fingerprint** falls back to message text (`src/finding-escalation.mjs`).

M2 introduces canonical finding IDs for gate problems. Existing records stay readable through a sentence-to-ID alias recorded at migration.

**M2:** the ID is `FND-` plus the digest of `{code, path, value}` (`src/finding-identity.mjs`).

- New disputes store `<ID> <sentence>` entries and match by ID.
- Disputes are append-only and hash-bound, so the alias for an older record is resolved when it is read: its exact sentences still match. Repeated commands must not produce duplicate decisions. An amendment records a new event linked to the earlier one; it does not overwrite it.

### Revisions and source identity

`DomainRevision` is an opaque token scoped to one accepted aggregate or namespace. Adapters map it to a physical revision. Today every expected revision is a Git object ID, which stays valid as the Git adapter's physical revision.

Configuration identities are derived from Git:

- A proposal ID is `cfp-<digest(remoteFingerprint, logicalKey)>`, and the logical key comes from the proposal branch name (`configurationProposalKey`).
- A transaction ID is `cft-<digest(proposalId, proposalRevision, expectedAuthorityCommit, actor, changes)>`, and two of those fields are Git OIDs.

A storage change must not change the meaning of an existing hash. So existing `cfp-` and `cft-` IDs keep their derivation forever. New proposals created after a storage change get new IDs, linked to any predecessor through an alias record.

`ContentDigest` identifies exact bytes using a versioned algorithm. `SourceSnapshot` identifies exact application source and records the SCM locator, commit identity and relevant worktree or change-set identity separately. Exact Git SHAs remain valid source provenance when Git is the SCM.

### Core records

| Record | Required domain content |
|---|---|
| Story | Stable ID, display name, capability and repository bindings, accepted workflow snapshot, lifecycle state and revision |
| Phase generation | Story and phase IDs, generation, immutable inputs, authored artifacts, source snapshot, check receipts and publication binding |
| Configuration proposal | Stable proposal ID, base configuration revision, typed changes, dependency closure, review state and proposal revision |
| Decision | Canonical finding or obligation ID, owner phase, disposition, reason, actor, reviewed packet and accepted decision revision |
| Artifact manifest | Content digest, byte length, media type, logical purpose, availability policy and provenance |
| Pending operation | Operation ID, immutable payload digest, expected revisions, recovery state and confirmed outcome if known |
| Local attachment binding | Shared logical attachment ID and digest where permitted, plus a separate laptop-local path and availability observation |

The v1.0 event envelope remains illustrative. Authenticated actor evidence, signatures where required, lineage and ordering reuse the existing contracts. A hash proves byte identity, not actor identity, authorization or truth. Client timestamps are advisory.

## 6 Storage and authority model

### 6.1 Authority today

| Namespace | Question it answers | Authority |
|---|---|---|
| Application default branch, normally `main` | What product code is the repository based on? | Source control |
| `sflow/config` | What rules must newly started work follow? | Configuration authority (reviewed proposals) |
| `<WORK-ID>` | What is this Story doing, and what is its current governed state? | **Lifecycle authority**, sharing history with the Story's source |
| Configured state branch, normally `state` | What shared proof, mirror and reusable repository state has been published? | Proof and projection only |

Story discovery already reads the ledger, not application branches. With the ledger disabled, remote discovery refuses rather than scanning. When a ledger summary is missing, discovery reads Story-branch commits by object ID.

### 6.2 Authority in v1.1

**Phase A changes no authority.** Local indexes are projections of the namespaces above. Every final governed check reads the authority it reads today:

- final publication;
- submission;
- source-review acceptance;
- approval;
- configuration activation.

**Phase B decision (ADR required before Stage 4).** Whether lifecycle state moves from the Story branch to a lifecycle namespace separate from source. Options:

- **Keep the Story branch as lifecycle authority** and make reads storage-independent only. This is the lowest risk, but source and lifecycle history stay coupled.
- **Promote the ledger to lifecycle authority.** It already advances atomically with the branch and its pin. This changes what "proof and projection" means, and needs writer fencing through `minimumBuild`, migration of every existing Story, and a rollback plan.
- **A service-backed lifecycle authority.** This is SDA Stage 5, with its own specification.

The ADR must state the treatment of:

- Stories created before the change;
- the atomic push contract;
- signing and trust tiers;
- takeover;
- what an old client does after cutover.

**Decided (2026-10-30): keep the Story branch as lifecycle authority** (ADR 0018, option A).

- **Unchanged:**
  - Stories created before the decision keep their exact meaning.
  - The atomic push, signing and trust tiers, and takeover.
- **No cutover.** There is no migration, so no old client needs fencing.
- **The ledger** remains proof and projection.
- **M4** puts the existing Story-branch authority behind the lifecycle authority adapter.
- **The other two options** stay recorded in the ADR. Choosing either needs a new record that
  supersedes it.

### 6.3 Local data

There are three kinds of local data.

1. **Local authored data:** drafts, local attachments and unsynchronized operations. It can be the only copy.
   - In Phase A it stays in its existing homes:
     - configuration drafts in the Git directory;
     - phase artifacts in the Story worktree;
     - pending pushes in the transport outbox;
     - publication and other journals in `.git/singularity-flow`.
   - These are fsynced, recoverable and protected by retention cleanup.
2. **Rebuildable projections:** indexes and materialized accepted state derived from verified records. They can be rebuilt without creating events or approvals.
3. **Verified object cache:** immutable bytes retained by digest. Deletion requires reachability and retention checks.

**Index engine and runtime.** The engine for type 2 is chosen in the M0 ADR against these constraints:

- The package declares Node `>=20`. The installer bundles Node 26.12.0. The VS Code extension loads its gateway runtime inside the editor's extension host; M0 must measure which Node version that is.
- `node:sqlite` needs Node 22.5 or later.
- `sql.js` (pure JavaScript, already a dependency, kept out of CLI startup) holds a database in memory and writes the whole file. That suits a rebuildable index of bounded size. It suits neither a concurrent multi-process writer nor durable authored data.
- Whatever engine is chosen, the index is optional. A missing, corrupt or version-mismatched index is rebuilt; it is never a reason to refuse a read or to touch authored data.
- No SQL index may become a second journal. Phase B may move authored data into a transactional store only after qualifying locking and durability on native macOS and Windows filesystems. At that point the existing journal formats migrate explicitly.

**Projection updates.** Applying verified changes updates the affected rows and the synchronization cursor together. Cursors bind the authority, schema and accepted revision. An interrupted page cannot advance the cursor without its records. A multi-record view identifies one coherent accepted snapshot.

### 6.4 Transactions across namespaces

- The Story branch, ledger entry and pin already advance atomically.
- Configuration (`sflow/config`) is a separate namespace and is not updated atomically with Story state.

A command needing several namespaces binds their exact revisions. It extends the existing publication journal rather than adding a second completion protocol. Readers do not interpret intermediate states as completed transitions. An uncertain outcome enters recovery.

## 7 Adapter contracts

The interfaces of v1.0 §7 stay as behavioral specifications: `SharedStateAdapter`, `WorkspaceStore`, `ArtifactStore` and `SourceControlAdapter`. Final names and schemas need a versioned contract review in M1.

### 7.1 One vocabulary over existing codes

Existing refusal codes and statuses keep their names, because scripts, tests and older clients read them. M1 adds a shared outcome class to their details. New code uses the class.

| Outcome class | Existing codes and statuses that map to it | Required behavior |
|---|---|---|
| `REVISION_CONFLICT` | `SGOS_OPERATIONAL_CAS_MISMATCH`, `SGOS_AUTHORITY_CAS_MISMATCH`, `WCA_DRAFT_CONFLICT`, `PUBLICATION_JOURNAL_CONFLICT`, a rejected leased push (`remote-diverged` for a transport intent; a refused lease in a ledger append) | Return the current revision; never overwrite |
| `OPERATION_ID_REUSE` | `WCA_OPERATION_ID_REUSED`, `IDEMPOTENCY_CONFLICT`; new in M1: `LEDGER_EVENT_PAYLOAD_CONFLICT`, `TRANSPORT_OPERATION_ID_REUSED` | Same ID and bytes returns the first outcome; different bytes refuse |
| `OUTCOME_UNKNOWN` | `transport-indeterminate` (`publicationPushOutcome`), `PUBLICATION_REF_OUTCOME_UNKNOWN`, `PUBLICATION_OUTCOME_UNVERIFIED`, `outcome-unknown` (transport intents, configuration journal), `WCA_DRAFT_WRITE_UNACKNOWLEDGED`, any other failed ledger append push | Retain; reconcile by exact operation and digest before any retry or new approval |

**M1:** the table is `src/outcome-classes.mjs`. A `SingularityFlowError` with a mapped code carries the class as `outcomeClass`, beside `code` and outside `details`, so existing details keep their shape. The CLI refusal envelope (`sflow-refusal-plan`) shows it as `error.outcomeClass`. Saved statuses map through `outcomeClassOf({ status })`. The `sflow-result` v2 contract is unchanged until the consistency-block review (Appendix A, question 2).

### 7.2 Semantic gaps to close (M1)

1. **Ledger idempotency ignores the payload.** `ledgerIdempotencyKey` hashes Work ID, event type, phase, generation and source commit. A duplicate is reported as recorded without comparing payload bytes. Add the payload digest to the recorded event. A same-key, different-payload append is refused under `OPERATION_ID_REUSE`. Events recorded before this change compare by key only, and are marked as such.
2. **One push path can drop the lease.** `pushCommitToBranchAsync` omits `--force-with-lease` when no expected remote SHA is passed, which leaves only fast-forward protection. Every caller that publishes governed state must pass an expected revision. A ratchet test lists the callers allowed to omit one.
3. **Reconciliation uses commits, not operations.** Pending pushes reconcile by exact remote match on commit and ref. Add the operation ID and payload digest to the record, so a retry after an unknown outcome is matched to its original operation.
4. **Reads are not snapshot-bound.** Ledger event reads already report completeness. Paginated reads need continuation tokens bound to namespace and snapshot revision.

**M1 results** (`benchmarks/sda/m1-contracts.md` has the detail):

1. Each new ledger entry and its idempotency index carry `payloadDigest`: the event without its per-attempt ID and time. A repeat returns the first outcome with `idempotency: 'key-and-payload'`, and an older entry returns `'key-only'`. Different bytes are refused with `LEDGER_EVENT_PAYLOAD_CONFLICT`. `ledger verify` reports a digest that does not match its entry. Capability-activation recovery now replays the recorded audit byte for byte.
2. `pushCommitToBranchAsync` refuses with `PUSH_EXPECTED_REVISION_REQUIRED` unless the caller names `expectedRemoteSha` or states `unleased` with a reason. The publication unit of work refuses the same way, before writing anything, and the combined branch-and-ledger push needs an expected branch revision. No source states an `unleased` reason for the unit of work. Ledger pins, pin restoration, Auto Candidate refs and the configuration bootstrap push are create-only. `test/governed-push-lease.test.mjs` lists the three sites that keep fast-forward protection alone, with their reasons.
3. Each transport intent records `operation: { id, payloadDigest }`. A caller with its own operation ID gets its first intent back, whatever became of it, and that ID with other bytes is refused with `TRANSPORT_OPERATION_ID_REUSED`. An exact-remote reconciliation names the operation and digest it settles.
4. `ledgerPage` reads one snapshot commit per listing. Its continuation names the namespace and that commit; one from another namespace refuses with `LEDGER_CONTINUATION_INVALID`, and one for a snapshot no longer held here refuses with `LEDGER_CONTINUATION_UNAVAILABLE`.

### 7.3 Required semantics (unchanged from v1.0)

- Every write has a stable operation ID, expected revision and immutable payload digest.
- Missing, empty, inaccessible, corrupt and unsupported are distinct outcomes.
- Cancellation and deadlines propagate to the real underlying operation.
- Adapters advertise qualified capabilities; unsupported ones are refused, not simulated.
- No domain command escapes to direct Git or filesystem persistence because an adapter returned an error.

## 8 Read consistency and freshness

Every read declares one of these policies:

| Policy | Usage | Remote work | Existing equivalent |
|---|---|---|---|
| `local` | Search, lists, dashboards, local drafts, historical documents | None | `manual` mode |
| `refresh-if-stale` | Sessions, status, readiness preview, next actions | Coalesced refresh when missing or expired | `cached` mode |
| `confirmed` | Final publication, submission, approval, configuration activation | Required authority confirmation | Existing final checks; `always` mode for advisory reads |

### Freshness settings: one source

The advisory interval is the existing repository-check setting:

- modes `always`, `cached` and `manual`;
- an integer interval from 1 to 10,080 minutes, default 30;
- machine-local, in `~/.singularity-flow/repository-checks.json`;
- overridden by `SINGULARITY_FLOW_REPOSITORY_CHECK_*` environment variables;
- mirrored from VS Code's `singularityFlow.repositoryCheckIntervalMinutes`.

It is never Story policy. v1.1 adds no `advisoryFreshnessMinutes` key and no per-command lifetimes. The lifetimes hard-coded in individual modules are inventoried in M0 and either derive from this setting or are documented as cache-validity bounds rather than freshness.

### Serve last-known (M2)

This is the main behavior change. Today an expired `cached` record makes the read recompute and wait on the remote. Only the very first read in a scope serves local data. A failed refresh refuses with `SESSION_STATE_REFRESH_UNAVAILABLE`.

In v1.1:

- An advisory read with a verified local snapshot returns it immediately, with its accepted revision, `checkedAt`, freshness (`fresh`, `stale` or `refresh-failed`) and completeness.
- A refresh is coalesced across processes, not only within one. It runs in a short-lived worker, or in the foreground when requested.
- A failed refresh preserves its real error beside the last-known state. It does not replace that state with a refusal.
- With no local snapshot, the result says first synchronization is required and offers the explicit action. Never synchronized is distinct from an empty verified inventory, as it is today.
- Final governed checks are unchanged: a fresh advisory cache never authorizes a mutation.
- Known successful writes update or invalidate the affected projections immediately.
- Clock rollback, an authority change, a schema change or an integrity failure ends freshness eligibility. A negative cache age is already a miss.

**M2:** the Story list and the intake catalog serve last-known state (`LAST_KNOWN_KINDS` in `src/repository-check-cache.mjs`).

- **Past the interval:** the record is served at once as `stale`, and a replay of its read (`src/index-refresh-launcher.mjs`) refreshes it in the background.
- **When the authority cannot be reached:** the record is served as `refresh-failed`, with the real error.
- **Coalescing:** refreshes share one observation across processes through a lease beside each record.
- **Verification records** (phase entry, next steps, readiness preview) are unchanged.
- **Results:** `benchmarks/sda/m2-read-index.md`.

### Configuration

**M2 (SDA-AC-013):** the CLI's configuration inspection commands (`workflow list`, `config read`, `config validate`, `config snapshot`) read exact authority objects and create no temporary clone.

- They use the machine-wide bare cache.
- Where that cache declines (Windows), the authority commit's objects are transferred into the application repository instead.
- Typed editing without a checkout remains M3.

There is no top-level `storage:` block; that key belongs to document providers. Phase A needs no governed storage setting. If Phase B needs one, it uses a new top-level key, such as `lifecycleStorage`:

- The key refuses unknown sub-keys with `CONFIGURATION_UNKNOWN_FIELD`.
- It is introduced together with a `minimumBuild` raise, so older builds stop rather than ignore it.
- Legacy ledger, transport and privacy settings map through one documented precedence rule:
  - `ledger.*`;
  - `git.remote` and `git.publish`;
  - the `SINGULARITY_FLOW_GIT_*_TIMEOUT_MS` environment variables;
  - retention.

## 9 Write and synchronization protocol

### Local drafts

Saving a draft requires no remote access. In Phase A:

- **Configuration drafts** already save in the Git directory without committing.
- **Phase artifacts** are files in the Story worktree until publication.
- **Collaborative workflow drafts** (`src/wca-git-drafts.mjs`) are shared through a remote Git ref. They are shared state with conditional writes, not local drafts, and stay out of the zero-Git draft budget.

Drafts show `saved-local`, never `published`, `submitted` or `approved`.

### Shared operations

1. Resolve the common workspace and Story context.
2. Persist an immutable operation intent with its operation ID, payload digest and expected revisions, through the publication journal or transport outbox that owns the operation type.
3. Load exact required inputs and verify artifact availability, identity, current policy and actor authority.
4. Prepare external side effects through the existing publication coordinator.
5. Conditionally advance the authority, as today's atomic branch, ledger and pin push does, and confirm its outcome.
6. Retain the acceptance receipt and update local projections. If the projection update fails, report shared acceptance with a refresh pending; do not repeat the shared action.

If connectivity fails after the remote may have accepted the action, the operation stays `outcome-unknown`. Recovery first queries the exact operation ID and digest (§7.2 item 3). It never creates a replacement operation or asks for another approval before the original outcome is known.

### Conflicts

- Changed refs return a concurrency outcome. There is no pull, merge and push loop; ledger appends retry a bounded number of times, as today.
- Changes to the same requirement, workflow route, approval policy, reviewed generation, disposition or source binding require explicit resolution and fresh validation.
- Never use last-writer-wins for accepted workflow state.

### Background execution and locks

CLI correctness must not require a permanent daemon. It can start a short-lived worker, join one, or run in the foreground. Workers use bounded queues, batches, retries and idle lifetimes.

Subject locks today are reclaimed on process liveness plus a heartbeat lifetime (`src/subject-lock.mjs`), so age can still decide. M3 replaces age-based reclaim with proven lease liveness. An expired foreground deadline never justifies a second concurrent writer.

## 10 Git adapter behavior

The Git adapter reads only configured authority refs and declared compatibility refs. It must not discover Stories by listing application branches, walking history or searching local directories.

| Requirement | Today | Phase A action |
|---|---|---|
| Discover Stories from authority refs | Already true for session and start discovery (ledger) | None |
| No branch inventory for identity | Epic and Initiative ID allocation, Initiative resume and goals list branches | M2: allocate and resume from identity records |
| Ordinary reads create no worktree or clone | Listing and status create none. Configuration inspection clones the authority into a temporary directory (`inspectApprovedConfiguration`, `src/configuration-branch.mjs`). | M2: read configuration objects through the source inspection facade, with no clone |
| Batched ref observation and object reads | Git fact cache (15 minutes) and fact store; a fetch per authority | M0: measure; M2: one observation per authority per scope |
| Conditional commits map to exact ref observations | Leased and atomic pushes | §7.2 item 2 |

A typed configuration change expresses entity-level intent; text merges of YAML do not decide semantics. YAML and JSON exports remain portable representations. Source branches, worktrees and pins remain supported through the source-control adapter, and final source checks are unchanged.

## 11 Workspace creation and Story lifecycle

### Workspace creation

`createWorkspace` clones every declared repository by default. The required behavior:

1. Save the local workspace registry and approved authority locator.
2. Synchronize the bounded capability, repository and configuration catalog once.
3. Materialize indexed projections and verified immutable dependencies.
4. Clone application source only when the selected onboarding or work operation needs it.

Changing the default is Phase B (M3), because it changes what an existing workspace contains.

### Story intake

Intake already caches its catalog and readiness preview at the repository-check interval, and seals intake receipts to the machine. Story creation uses a create-only lease and a start journal. v1.1 adds:

- serve-last-known for the catalog (§8);
- honest partial preparation: if the Story was accepted but the checkout failed, the same operation resumes.

### Phase work

`sf-phase`, `sf-code`, `sf-next`, `sf-session`, publication, review and decision commands consume one Story snapshot contract through the central lifecycle dispatcher. This covers every seeded, custom, imported, duplicated, amended and future workflow.

A storage adapter never grants code-writing, test-running or application-starting permission.

Before final publication, review acceptance or approval, the exact bindings are refreshed. A stale advisory next action is revalidated and replaced; it never executes against another Story or generation.

### Takeover on another laptop

`session takeover <WORK-ID>` already:

- attaches through an isolated worktree;
- fetches only that Story's branch;
- verifies the configuration pin;
- synchronizes secondary repositories;
- raises `DOCUMENT_REUPLOAD_REQUIRED` for missing laptop-local documents.

Local recovery records are sealed to the machine that wrote them.

v1.0 said to restore manifests before preparing the source checkout. While the Story branch is lifecycle authority, the configuration closure travels on that branch, so takeover fetches the Story branch first. That ordering stays until the Phase B ADR.

The required additions:

- Takeover discloses that unsynchronized drafts on the original laptop are not recoverable unless they were exported or shared.
- Takeover never reuses another laptop's paths, session handles, locks, cache receipts or temporary files.

## 12 Storage layout and cleanup

v1.1 uses the existing layout and adds no `.sflow/` tree. `.sflow/` stays disposable per-checkout output.

| Location | Holds |
|---|---|
| `~/.singularity-flow/` | Machine state: workspace registry, active workspace, Story index, transport outbox, repository-check settings, caches |
| `<workspace>/` | `workspace.json`, `repos/`, `documents/`, `cache/`, `logs/` |
| `<workspace>/.singularity-flow/story-worktrees/.w-<24 hex>` | Story worktrees (compact form; the long legacy form stays readable) |
| `<clone>/.git/singularity-flow/` | Journals, pending publication, local documents, configuration service, SGOS stores |
| *New:* the read index | Under `~/.singularity-flow/` or `<workspace>/.singularity-flow/`, decided in the M0 ADR |

Rules for any new location:

- It is registered in `scripts/test-machine-state.mjs` (`MACHINE_STATE_LOCATIONS`), so tests never write the developer's real state.
- It is added to the retention allow-list (`src/workspace-retention.mjs`), which fails closed on unknown entries and protects recovery, pending, outbox and journal directories.
- The synced-folder guard (`WORKSPACE_SYNCED_FOLDER`) applies: an index never lives in a cloud-placeholder or network location.
- Cleanup uses reference manifests and verified ownership. It protects:
  - unsynchronized operations and local-only attachments;
  - dirty or unpushed source and active checkouts;
  - unresolved recovery;
  - evidence under retention hold.
- Projection cleanup deletes only rebuildable indexes. Corruption never justifies deleting drafts, the outbox or recovery.

## 13 Artifacts and knowledge

The registered World Model, its state-branch publication, the Story World Model pins and the CALM projection were removed (`src/removed-features.mjs`). Configurations that still carry their settings load unchanged, and the settings are dropped at validation.

What remains is a machine-local knowledge cache (`src/knowledge/store.mjs`). It is keyed by source content and analyzer identity, never shared, and never authority. v1.1 makes no shared World Model requirement. A future shared knowledge store would be specified separately.

### Artifacts

- Content-addressed storage exists in places, such as FOS evidence objects stored by SHA-256 (`src/fos-evidence-ingestion.mjs`) and installer artifacts. There is no general artifact store.
- Availability is separate from semantic validity and publication state. The states are `available-local`, `available-shared`, `missing`, `local-only`, `reupload-required` (today's `DOCUMENT_REUPLOAD_REQUIRED`), `integrity-failed` and `access-denied`.
- Deduplication is scoped by authority and access policy.
- Credentials, transient absolute paths and temporary prompt files never become shared artifact identity.
- CLI-issued staging, context and output paths remain exact machine-local outputs. Surfaces and skills consume the returned paths and never reconstruct them.

## 14 User experience and command contracts

All surfaces display the selected workspace, repository, Story, phase, local changes and synchronization status consistently. An ordinary local read returns a useful result even when an optional refresh is unavailable, and it keeps the real refresh error.

### Outcomes inside the existing result contract

`sflow-result` v2 keeps its four statuses. The seven v1.0 outcomes map onto status plus a consistency block:

| v1.0 outcome | `status` | Consistency detail |
|---|---|---|
| `saved-local` | `succeeded` | `scope: local`, no shared acceptance |
| `pending-sync` | `succeeded` | `pendingOperations[]` |
| `accepted` | `succeeded` | `confirmed: true`, accepted revision |
| `conflict` | `refused` | `REVISION_CONFLICT`, current revision, preserved work |
| `outcome-unknown` | `failed` | `OUTCOME_UNKNOWN`, operation ID, reconcile next action |
| `refresh-failed` | `succeeded` (read) | `freshness: refresh-failed`, last-known revision, preserved error |
| `recovery-required` | `refused` | Recovery next action |

The consistency block holds `policy`, `freshness`, `checkedAt`, `acceptedRevision`, `completeness` and `pendingOperations[]`. The M1 contract review decides whether it is an additive optional field of v2, or whether it needs v3, which the contract's own rule about one meaning per version may require. Saved push records keep their statuses (`pending`, `pushing`, `succeeded`, `outcome-unknown`, `remote-diverged`, `needs-user`, `attempt-budget-exhausted`).

Every actionable result provides a canonical next action in Copilot, Shell and model-free VS Code forms where supported, generated from the command registry.

### Commands

| Need | v1.1 command | Why not v1.0's |
|---|---|---|
| Show freshness, pending operations and index state | `index status` | `sync status` would publish a Story named "status" |
| Refresh the current scope now | Existing explicit refresh forms, plus `index refresh` | `/sf-check` is local-only by design and keeps that meaning |
| Rebuild projections | `index rebuild` (local), beside the existing `state reconcile --repair-projections` (shared) | — |
| Verify the index against authority | `index verify` | Top-level `verify` already exists |
| Reconcile unknown outcomes | Existing `sync <INTENT-ID>` and `ledger`/`state reconcile` | — |

`index` is not a command today. Before M2, the names are checked against the command registry, help pages, skills and narration migration lists.

**M2:** `index status|refresh|rebuild|verify` is `src/commands/read-index.mjs`, and `test/sda-names.test.mjs` holds every SDA name to the modules that own it. Existing `session`, `status`, `nextsteps`, `phase`, `decision`, `check` and `sync` forms keep their meanings and delegate to the services.

Errors preserve the failed stage, operation ID, scope, elapsed time, deadline, retryability and a bounded, redacted underlying cause. Missing authority is not an empty Story list. A confirmed shared write followed by a local read failure is not a failed shared write.

## 15 Migration and compatibility

Migration is per authority and namespace, never inferred from the installed build version.

- **Stage 0, Establish the boundary (M0).**
  - Inventory every local-Git, ref-tree, YAML-read and persistence call site, and classify each as shared state, source control, local draft, artifact, projection or installation.
  - Inventory the hard-coded lifetimes.
  - Record baselines (§17).
  - Write the two ADRs: index engine and runtime (§6.3), and the Phase B authority options (§6.2), the latter as a decision to make, not one already made.
- **Stage 1, Contracts and projections (M1).**
  - Add the outcome classes (§7.1) and close the gaps in §7.2.
  - Wrap the existing reads in the source inspection facade.
  - Build projections from the existing accepted records, and run shadow comparisons without authorizing anything from them.
- **Stage 2, Advisory reads (M2).**
  - Move to the index: Story lists, session candidates, configuration catalogs, dashboards, and advisory phase and next-action reads.
  - Serve last-known (§8).
  - Read configuration without a clone.
  - Fix the identity leaks (§5).
  - Existing Stories stay on their existing authority.
- **Stage 3, Drafts and typed configuration intent (M3).** This is Phase B. It needed the authority ADR, which was accepted with option A on 2026-10-30.
- **Stage 4, Lifecycle persistence behind adapters (M4).** Phase B. It follows the authority ADR's decision and preserves existing packets, signing and publication recovery.
- **Stage 5, Alternate shared storage.** It needs a separate specification.

### Safety rules

- Preserve legacy Story IDs, generation numbers, content hashes, source commits, signatures and the `cfp-` and `cft-` derivations. New IDs use explicit aliases.
- Records without provenance stay legacy or unverified. Import never manufactures approval or execution evidence.
- A namespace has one writer profile; dual writes are not allowed.
- Authority cutover uses the existing `minimumBuild` writer fence through the configuration review. A client upgrade alone never enacts it.
- Schema changes use `src/schema-migrations.mjs`. New record families need the companion lock review.
- An "adapter epoch" does not exist today. If Phase B needs one, it is defined in the authority ADR.
- Rollback never deletes accepted events.
- Staged installation and product-installation recovery stay outside workspace-store cleanup and migration.

## 16 Security and governance

- Adapter implementations ship with Singularity Flow and are qualified with it. Workflow documents, imported JSON and model output can select only allowed profiles. They cannot inject executables, SQL, transport arguments or trust providers.
- Use parameterized queries, versioned schemas, bounded records, normalized portable identities, private local permissions and symlink protection.
- Existing trust tiers are preserved, with T2 and T3 requiring commit signing. Changing transport never lowers a tier.
- Artifact and input bytes remain untrusted.
- Transport identity is separate from human approval identity. A Git username or a successful credential lookup is not proof of independent review.
- Queued operations keep their reviewed policy and packet bindings, but execution revalidates authority, expiry and revocation. A stale confirmation cannot be replayed against another generation.

## 17 Performance and observability

### Existing instrumentation

- Git process counters (`git.spawns`, `git.requests`, `git.remote.*`) live in `src/git-query.mjs` and `src/git-execution.mjs`, with traces in `src/performance-trace-store.mjs`.
- `benchmarks/` holds session-listing, warm-read, Story-creation and cold-start benchmarks.
- `benchmarks/session-listing/qualification.json` records the 30-minute reuse with a Windows run.
- `benchmarks/dx/accepted-baseline.json` has status `unestablished`, and warm-read qualification covers macOS only. M0 must close both gaps.

### Architectural budgets (design targets, not measured gains)

- An initialized `local` Story list, session candidate list or catalog read with a verified snapshot starts zero Git, remote or model processes.
- A local draft save starts zero Git, remote or model processes. This excludes collaborative workflow drafts (§9).
- An expired advisory read returns last-known state without waiting on the network.
- Concurrent refreshes share one authority observation per scope, across processes.
- No ordinary listing creates a checkout or temporary clone, walks source history or reads every artifact body.

### Bundle budgets

New code lands under the existing size tests:

- the eager closure of `commands/start.mjs`, about 9.26 MB against its ceiling (`test/lazy-command-handlers.test.mjs`);
- the cold hook context and catalog closures, with only a few kilobytes left (`test/cli-bundle.test.mjs`);
- the VS Code gateway runtime (`benchmarks/dx/vscode-bundle-budgets.json`).

Index and synchronization code loads lazily. An index engine must not load at CLI startup, as `sql.js` does not today (`test/lazy-startup-reads.test.mjs`).

### Measurement

Separate process startup, module loading, index work, filesystem work, local Git, network transfer, provider lookup, validation, artifact verification and model time. Record call counts, bytes, queue time, lock wait and recovery work without private content.

Benchmark native macOS and Windows with:

- small and 10,000-file repositories;
- short and long ledger histories;
- legacy, pinned and amended Stories;
- seeded, custom and imported workflows;
- offline, slow-network and expired-cache cases.

Report process-cold, first-worker, warm-worker, first-synchronization and repeated-read runs separately, as median and p95 over matched fixtures.

## 18 Acceptance criteria

| ID | Required behavior and verification |
|---|---|
| SDA-AC-001 | Storage-neutral domain and application modules contain no direct Git commands, ref parsing, `.git` path assumptions or SQL. A ratchet test on direct local-Git call sites, in the style of `test/git-remote-boundary.test.mjs`, only lets the count fall. |
| SDA-AC-002 | After initialization, local Story and session listings succeed with Git and network deliberately unavailable, start zero Git or network processes, and show freshness and completeness. |
| SDA-AC-003 | A draft save survives a crash. An index rebuild preserves every draft, journal and pending operation. |
| SDA-AC-004 | An offline or timed-out shared approval cannot return accepted. A timeout after actual remote acceptance reconciles to exactly one accepted decision. |
| SDA-AC-005 | Repeating an operation with identical ID and payload returns the same outcome. A changed payload under that ID is refused, including ledger appends (§7.2 item 1). |
| SDA-AC-006 | Two laptops changing the same aggregate cannot silently overwrite each other. Independent aggregates proceed without semantic conflicts. |
| SDA-AC-007 | A reader never interprets a partial multi-system publication as a completed transition. |
| SDA-AC-008 | CLI, VS Code, Copilot, workers and hooks resolve identical Story, phase, revision, mutation-capability and next-action semantics from the same fixtures. |
| SDA-AC-009 | Legacy, pinned and amended Stories keep exact source, workflow closure, artifacts, decisions and evidence hashes through import, index rebuild and export. Existing `cfp-` and `cft-` IDs are unchanged. |
| SDA-AC-010 | Every seeded workflow and representative custom, duplicated, imported, looped and future-phase definition runs through the central service without phase-specific storage exceptions. |
| SDA-AC-011 | Final publication, submission, source-review acceptance and approval reject changed reviewed bindings even when the advisory cache is fresh. |
| SDA-AC-012 | Takeover restores the correct Story and checkout without scanning application branches or history. Missing laptop-local inputs request exact reupload, and lost unsynchronized drafts are disclosed. |
| SDA-AC-013 | Configuration inspection and typed editing need no application checkout or temporary clone, and no textual Git merge decides semantics. |
| SDA-AC-014 | The repository-check settings are the only advisory interval. Explicit refresh bypasses it. Overlapping refreshes coalesce across processes. Known mutations invalidate affected projections. |
| SDA-AC-015 | Access denial, empty inventory, absent authority, corrupt data, timeout, cancellation and unknown write outcome remain distinguishable, with accurate recovery guidance. |
| SDA-AC-016 | Cleanup preserves unpushed source, local-only attachments, pending operations, evidence holds and active recovery. New locations appear in the machine-state list and the retention allow-list. |
| SDA-AC-017 | Adapter conformance verifies conditional acceptance, snapshot pagination, idempotency, integrity, boundedness and cancellation against Git and a deterministic test adapter, which can never be selected as production authority. |
| SDA-AC-018 | Native macOS and Windows reports measure cold and warm scenarios and call counts, meet the budgets in §17, and disclose remaining bottlenecks. |
| SDA-AC-019 | Authority migration (Phase B only) fences old writers through `minimumBuild` and cannot create two authorities. Not applicable under ADR 0018 option A, which migrates no authority. |
| SDA-AC-020 | No installer, migration or cache repair rewrites original signed evidence or clears active staged-installation recovery. |
| SDA-AC-021 | An expired or failed advisory refresh returns last-known verified state with `stale` or `refresh-failed` freshness and the real error, never `SESSION_STATE_REFRESH_UNAVAILABLE`, while final checks still refuse on stale bindings. |
| SDA-AC-022 | Gate-problem disputes and finding escalation match by canonical finding ID. Existing sentence-keyed disputes keep matching through their migration alias. |
| SDA-AC-023 | No new command, configuration key, refusal code or path reuses an existing name with a different meaning. A test checks the SDA names against the command registry, configuration normalizers and machine-state list. |
| SDA-AC-024 | Epic and Initiative identity allocation, Initiative resume and goals read identity records, not branch inventories. |
| SDA-AC-025 | Every governed push passes an expected revision. Callers allowed to omit one are listed in a ratchet test. |

## 19 Failure injection and qualification

Qualification covers at least:

1. A crash before and after operation-intent persistence.
2. A crash during artifact staging, and after a source-side effect but before shared acceptance.
3. A remote that accepts a transaction but whose response is lost.
4. Shared acceptance that succeeds while the local projection write fails.
5. An authority ref that moves, or permissions revoked, between an advisory read and the final commit.
6. Simultaneous refresh, draft save, approval and cleanup from several processes.
7. A prior worker still alive after the foreground caller times out.
8. A corrupt index, a missing object, a forged digest, a duplicate event ID and a malformed change page.
9. A full disk, Windows file-handle contention, antivirus delay and unsupported filesystem locking.
10. Cloud placeholders, symlinks, portable path collisions and moved workspace roots.
11. Clock rollback, stale lifetime state and old installed clients.
12. A local-only image required on the original laptop and missing on takeover.
13. Two configuration proposals touching separate assets, then competing changes to one approval rule.
14. A backup restored while the shared authority has advanced.
15. A refresh that fails while a last-known snapshot exists.
16. A ledger append repeated with a changed payload.

Existing lifecycle, source-review, publication, signing, installation-recovery and retention tests run in addition to adapter suites. A faster read path does not qualify a changed write protocol.

## 20 Delivery milestones

| Milestone | Deliverable | Exit condition |
|---|---|---|
| M0 | Call-site and lifetime inventory; macOS and Windows baselines (DX baseline established, warm-read on Windows); measured VS Code host Node version; two ADRs (index engine and runtime; Phase B authority options) | Every persistence path classified. Current authority and recovery semantics recorded. Baselines accepted. |
| M1 | Outcome classes over existing codes; ledger payload digest; operation-matched reconciliation; leased governed pushes; source inspection facade for reads; conformance harness; consistency block in the result contract | Existing behavior wrapped with no lifecycle change. Test adapter proven non-authoritative. SDA-AC-005, 017 and 025. |
| M2 | Read index; serve-last-known; cross-process refresh coalescing; configuration reads without clone; identity leaks closed; canonical finding IDs; `index status/refresh/rebuild/verify` | Lists, catalogs and advisory sessions meet the zero-Git budgets on macOS and Windows. SDA-AC-002, 013, 014, 021–024. |
| M3 | (Phase B; ADR 0018 accepted option A) Transactional drafts, typed configuration intent, lazy workspace cloning, lease-proven lock recovery | Crash and duplicate-operation tests pass. No checkout for ordinary configuration editing. |
| M4 | (Phase B) Lifecycle persistence behind adapters. Under ADR 0018 option A, this means the Story-branch authority behind the lifecycle authority adapter, with no new namespace. | All workflow families keep final fresh binding and existing governance tests. |
| M5 | Takeover, cleanup, backup and migration tooling | Multi-laptop, retention, legacy import and writer-fencing cases pass. |
| M6 | Performance qualification and staged rollout | Matched native reports, compatibility evidence and operator recovery documentation approved. |

The first production profile remains Git-backed. A server-backed authority is a later specification.

## 21 Release definition

SDA v1 Phase A is complete when:

- ordinary Singularity Flow reads are served from verified local state without Git or waiting on the network;
- identity no longer leaks branches or paths;
- existing write semantics share one vocabulary with the ledger's idempotency gap closed;
- native macOS and Windows qualification demonstrates the reduction in redundant work.

Phase B is complete when its ADR's decision is implemented with every governance and recovery contract preserved.

The product never describes pending local work as globally published or approved. Git becomes replaceable persistence and source-control infrastructure, while Singularity Flow remains responsible for workflow meaning, evidence and authorized decisions.

## Appendix A Open questions for M0

1. Which Node version does the VS Code extension host provide on the supported VS Code range (`^1.90.0`)? This decides whether `node:sqlite` can serve VS Code reads directly, or whether they go through a CLI worker.
   - **M0:** VS Code 1.143.1 measured at Node 24.21.0 with `node:sqlite`. The 1.90.0 floor is Node 20.9 per its release notes, which has none. ADR 0017 needs no SQL engine in Phase A, so the floor stays.
2. Can the consistency block be an additive optional field of `sflow-result` v2, or does the one-meaning-per-version rule require v3?
   - Open: an M1 contract review. M1 changed no `sflow-result` field.
3. Where does the read index live: machine-wide under `~/.singularity-flow/`, or per workspace?
   - **M0 (ADR 0017):** in the existing JSON projections, where they live today, extended with freshness and last-known retention.
4. For Phase B: which authority option (§6.2) does the team prefer, and what is the migration story for Stories already in flight?
   - **Decided (2026-10-30):** option A, keep the Story branch as lifecycle authority. No Story is migrated (ADR 0018).

M0 results: `benchmarks/sda/m0-qualification.md` (inventory, macOS read baselines, VS Code runtime). Windows baselines and the CI-established DX baseline remain open.

M2 results: `benchmarks/sda/m2-read-index.md` (read index, serve-last-known, cross-process coalescing, configuration reads without a clone, identity leaks, canonical finding IDs, `index` commands). Windows measurements and the consistency block remain open.

M1 results: `benchmarks/sda/m1-contracts.md` (outcome classes, ledger payload digest, operation-matched reconciliation, leased pushes, source inspection facade, conformance harness). The consistency block and the versioned contract review remain open.
