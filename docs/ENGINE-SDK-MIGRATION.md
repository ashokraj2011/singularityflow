# Engine SDK and namespaced storage migration

The target is a portable Node runtime with an embeddable engine. CLI, VS Code, MCP and Copilot
adapters consume the same versioned operation vocabulary. An application can persist SFlow's
logical data through Git, files or its own database implementation.

This migration starts from `main@229441d9b`. The first three deliveries establish a component
baseline, extract shared errors/outcomes, define the namespace-store draft, and add an internal Git
compatibility bridge. The SDK package and alternate backends follow in later deliveries. These
foundations do not expose a new public SDK or change installed storage authority.

## Ownership

| Component | Owns |
|---|---|
| Shared foundation | Error identity, serialization and existing outcome classifications |
| Kernel | Workflow transitions, requirements, evidence rules and authority evaluation |
| Engine SDK | Registered operation dispatch, coordination, context manifests and recovery planning |
| SDA | Namespaced records, revisions, transactions, receipts, integrity and storage implementations |
| SGOS | Execution attempts, processes, leases and operational recovery |
| World Model | Knowledge and AST retrieval behind an engine port |
| Source-control adapter | Source commits, branches, pushes and worktrees |
| Host adapters | UI, CLI flags, JSON compatibility projections, safe command guidance and model prompts |

The shared foundation is a dependency of both engine and SDA; SDA does not import an engine
package to acquire common errors. The foundation lives in `src/foundation/`, which already ships
with the existing Node package. Package extraction follows once the operation boundary is proven.

## Namespace contract draft

A record is identified by a stable project scope, namespace and logical key. Laptop paths, Git
branch names, SQL tables and credentials belong to adapter configuration. A project can contain
several repositories; a Story records its repository participants and their source bindings.

| Namespace | Contents and owner |
|---|---|
| `config` | Immutable approved configuration versions and the approved pointer |
| `state` | Lifecycle aggregates, human decisions, events and operation receipts |
| `evidence` | Artifact manifests, integrity metadata and retained evidence references |
| `runtime` | SGOS attempts, leases and recoverable execution checkpoints |
| `local` | Machine-private drafts, caches and uploaded input document content |

`local` has a separate machine binding. Selecting shared storage does not upload local documents.
Stories pin the configuration closure they started with. Updating approved configuration affects
future Stories; an active Story changes its binding only through an explicit recorded operation.

The initial [namespace-store draft](NAMESPACE-STORAGE-CONTRACT.md) implements `read`, bounded
snapshot `list`, `transact`, operation inspection and integrity verification contracts. Snapshot
export/restore is a subsequent extension. This draft is exercised by conformance fixtures and
remains separate from installed production authority. It preserves:

- opaque revisions and explicit absent-record preconditions;
- conditional acceptance, without overwriting a moved revision;
- same operation ID and payload returning the original outcome;
- the same ID with different bytes being refused;
- atomic records, events and receipts within an explicitly declared transaction scope;
- distinct missing, unavailable, corrupt, conflict and unknown outcomes;
- immutable configuration and evidence bindings;
- namespace and project isolation, with no implicit cross-backend transaction.

An unknown external effect is reconciled by operation identity before retrying. A database
transaction cannot also atomically push application code to Git. Engine operations retain intent,
external-effect acknowledgements and their final receipt so they can resume after interruption.

Existing SDA `v1` contracts keep their names, capabilities, outcomes and production-adapter admission
rules. New namespace contracts and compatibility adapters must not silently modify those versions.

## Delivery phases

| Phase | Delivery and gate | Current status |
|---|---|---|
| 0 | Baseline the first extraction and identify existing ownership and compatibility contracts | First component baseline captured; the operation inventory grows with each later slice |
| 1 | Pure shared errors/outcomes, compatibility exports and transitive import guards | Implemented; qualification recorded below |
| 2 | Namespace identities, record/transaction contracts and shared conformance fixtures | Implemented as draft-1; 147 focused Mac tests passed, including unchanged Git conformance |
| 3 | Git compatibility adapter over the existing lifecycle/configuration authorities | Implemented as an internal native-port bridge; 214 focused Mac tests passed |
| 4 | Publication through the registry and SDK, with explicit CLI result projection parity | Planned; one chosen transport per surface operation |
| 5 | Submit, decisions, approve, advance, phase manifests and queries, one operation per slice | Planned; extract each operation's rules alongside its orchestration |
| 6 | Filesystem adapter for new projects, including crash/retry and concurrency qualification | Planned; declared access guarantees must pass conformance |
| 7 | Database/application adapter and installable headless Node runtime | Planned; a workflow must resume on another agent |
| 8 | Verified migration of existing projects and an explicit authority cutover | Planned; export, verification, old-writer fencing and reconciliation required |
| 9 | Remove obsolete direct accesses, qualify distribution and compare performance | Planned; preserve existing skill and CLI contracts during migration |

Each extraction includes relevant regression tests, typed results, error preservation and a smaller
legacy dependency boundary. Static and literal dynamic imports, re-exports, computed imports and
ambient host access are checked for components admitted as pure. Guard tests include a local
`require` binding because that spelling is a data parameter in the frozen SDA contract.

For the future public API, `engine.run(operation, inputs)` is the canonical entry. Typed helpers
derive from the same registry. MCP/model exposure is explicitly declared, and human authorization
remains enforced inside the operation. SDK actions are semantic data; host adapters render Shell,
Copilot and model-free guidance through the shared safe renderer.

## Existing authority and migration

[ADR 0018](adr/0018-sda-lifecycle-authority-options.md) keeps the Story branch as lifecycle authority,
the state branch as proof/projection and `sflow/config` as configuration authority. The Git
compatibility adapter preserves that layout. An alternate backend for an existing project requires
a superseding authority decision and a controlled migration:

1. Reconcile pending operations and establish a stable source boundary.
2. Fence old-authority writes and export records, configuration closures and evidence bindings.
3. Import and verify hashes, lineage, decisions, operation receipts and dependency closure.
4. Activate the new authority generation and prevent older clients from writing to the old one.
5. Retain the old authority as a read-only snapshot. After new writes, rollback needs verified
   reconciliation or reverse migration, rather than merely changing a connection setting.

No dual-write authority or silent fallback is introduced. SGOS operational state remains separate
from lifecycle authority even if both use one physical database.

## Foundation baseline and measurements

Before extraction, 28 focused tests passed on the unmodified implementation, including the newly
captured error serialization contract and existing utility/SDA-v1/architecture tests. Fresh imports
of the SDA contracts loaded utility infrastructure solely to acquire an error constructor.

Reproduce the component measurement with:

```sh
node scripts/engine-foundation-benchmark.mjs --samples=11
```

The first measurement used macOS and Node 26.12.0, with 11 fresh processes per entry and the Node
compile cache disabled. The OS file cache was not cleared. Module and byte counts are the static
bundle input closure; timings measure component imports, excluding process startup.

| Contract | Modules before / after | Input bytes before / after | Fresh-process median before / after |
|---|---|---|---|
| Shared state | 13 / 2 | 193,534 / 8,114 | 6.115 ms / 0.545 ms |
| Lifecycle authority | 14 / 3 | 197,440 / 12,020 | 6.276 ms / 0.664 ms |

Both contract closures now have zero Node builtin dependencies, previously eleven each. Existing
`util.mjs` and `outcome-classes.mjs` imports expose the same constructor, classifier and frozen
mapping objects as the foundation. The SGOS contract's direct error dependency also uses the
foundation; other SGOS transitive dependencies are intentionally not claimed as isolated yet.

These measurements do not establish Windows, cold-machine or complete-command latency gains.
Windows CI and live model qualification run only when requested. All lifecycle tests use isolated
machine state and fixture repositories; no real Story or installation is migrated by this phase.

The failure constructor and outcome vocabulary share one small module. Keeping them together
preserves the existing runtime module ceilings; no bundle limit is raised. The benchmark's one
bounded Node probe uses the existing central process boundary and has an explicit reviewed site
in `scripts/git-bypass-baseline.json`.

The first delivery's local qualification passed:

- 107 focused tests, with zero failures or skips, covering the shared contract, compatibility,
  dependency guards, SDA Git/memory conformance, cancellation and lost-response recovery, name
  ownership, SGOS records/public admission, utility behavior and startup closure parity;
- `npm run check`: 3,510 checks across the current 191 skills;
- `npm run vscode:typecheck`;
- all 13 VS Code runtime bundle budgets, without changing their limits;
- `npm pack --dry-run --ignore-scripts --json`: the extracted foundation and compatibility paths
  are included in the distributable package.

This is component qualification rather than the full product suite or an alternate-backend rollout.

## Phase 2 qualification

The namespace contract is implemented independently in `src/sda/namespace/`. Its reference adapter
is test-only, lives under `test/helpers/`, and is excluded from the npm distribution. It has no
production registration, no CLI entry and no installed authority selection path. Existing
production modules, SDA v1 contracts, Git/configuration stores and dependency locks are unchanged.

Mac qualification on Node 26.12.0 passed 147 focused tests with zero failures or skips. This includes
39 namespace contract/conformance tests, the existing Git ledger and lifecycle conformance cases,
and the Phase 1 regression set. Architecture guards now check the namespace contracts' complete
dependency closure and prevent production consumers from wiring this draft in prematurely.

Additional checks passed: `npm run check` (3,518 checks), `npm run vscode:typecheck`, all 13 unchanged
VS Code bundle budgets, and npm dry-run package inclusion/exclusion. The runtime bundles have the
same bytes and module counts as Phase 1. No Windows, hosted CI or live model runs were started.

Fast contract-only reproduction from the repository root:

```sh
node --test test/sda-namespace-contract.test.mjs test/sda-namespace-conformance.test.mjs
```

Production admission and any future authority cutover remain explicitly separate from this draft
and its in-process reference tests.

## Phase 3 compatibility boundary

The [Git compatibility adapter](GIT-COMPATIBILITY-ADAPTER.md) binds an explicit checkout and stable
project scope to the installed lifecycle, proof and configuration owners. Its pure descriptor names
those roles; the concrete adapter loads only the requested owner. Existing production routing stays
unchanged until the publication vertical slice in Phase 4.

This compatibility profile delegates native protocols, rather than claiming generic record-store
transactions over incompatible current authorities. Raw writes and cross-namespace atomicity are
not advertised. Existing SDA v1 descriptors, bytes, approval/identity checks, leases, journals and
recovery outcomes remain the owners' responsibility. The original Git conformance fixtures are
shared with the new adapter tests so that both paths exercise the same concurrent-writer,
lost-response, cancellation, pagination and integrity cases.

Phase 3 qualification passed on macOS 26.7.2 with Node 26.12.0:

- 214 focused tests, with zero failures, cancellations or skips (152.2 seconds). These cover the
  compatibility ports and unchanged namespace, foundation, SDA v1, lifecycle/proof, configuration
  proposal/service/activation, SGOS, dependency, name-ownership and startup regression suites.
- `npm run check`: 3,525 checks across 191 skills.
- `npm run vscode:typecheck` and all 13 existing VS Code runtime bundle budgets.
- npm dry-run packaging: both compatibility modules and their documentation are included; test
  adapters and fixtures are excluded.
- Staged diff whitespace validation.

Reviewed configuration activation preserved dirty application bytes and the index, required exact
review confirmation and protection acknowledgement, and retained the original Story configuration
commit. The native lifecycle/proof descriptors and refusal/recovery meanings are unchanged. The
compatibility descriptor consumes their protocol constants; native adapter IDs remain owned by
their original modules, with no additional name-ownership exception.

This is component qualification, rather than a full product or alternate-backend release. All Git
integration runs used isolated machine state and local fixture remotes. No Windows, hosted CI or
live provider qualification ran. Phase 4 is the publication SDK/registry vertical slice with explicit
CLI result parity.
