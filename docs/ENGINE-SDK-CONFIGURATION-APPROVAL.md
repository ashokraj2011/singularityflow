# Namespace-backed configuration approval

`configuration.approve` is a registered engine operation for an explicitly enrolled namespace
project. It establishes approved configuration using the real shared workflow compiler, immutable
content and conditional metadata transactions. The installed Git configuration path retains its
existing authority and behavior.

## Construction and review

The installable SDK exposes `createNamespaceConfigurationEngine` from
`@singularity-flow/engine-sdk/hosts/namespace-configuration`. Its constructor takes shared record
and content ports, the exact enrolled project scope and authority, an application-owned identity
port, and an application-owned UTC clock. Construction performs no enrollment or approval.

The operation requires all five inputs:

```js
await engine.run('configuration.approve', {
  operationId: 'review-configuration-1',
  source: { namespace: 'config', sha256: sourceSha256, bytes: sourceBytes },
  expectedRevision: null,
  confirm: sourceSha256,
  reason: 'Reviewed the complete workflow and its declared dependencies.'
});
```

The application uploads the source package and its resource bodies through its explicit content
port and presents the exact package for review. `expectedRevision: null` means an absent approved
head; later reviews supply the previous **head record revision**. The confirmation binds the exact
source bytes. Inputs cannot supply a principal, permission, readiness result or approval identity.

`access.current({ projectId, operation, signal })` returns current `projectId`, `principalId`,
`permissions` and `actorKind` facts. The principal needs `configuration.approve` and `actorKind:
'human'`. The host checks these facts before preparation and again after resource verification,
immediately before acceptance. A service principal cannot turn a configuration into human-reviewed
configuration. The application owns authentication and its permission grant.

## Canonical source package

The v1 source is bounded UTF-8 JSON with `schemaVersion: 1`,
`format: 'sflow-namespace-configuration-source/v1'`, and these fields:

| Field | Meaning |
|---|---|
| `definition` | The workflow definition accepted by the existing shared compiler; the compiler derives its agent catalog from the package |
| `agents` | IDs, labels, compatible/default phases, author or reviewer mode, tool declarations, body content references, skill IDs and instruction IDs |
| `skills` | IDs, body references, nested skill IDs and instruction IDs; optional eager/on-demand loading |
| `instructions` | IDs and body references |
| `templates` | Portable configuration paths, or exact `agent:<agent-id>/<template-id>` references, and their retained body references |
| `files` | Additional portable configuration paths and immutable body references |

All resource bodies use the shared `config` content namespace. Agent `skillBindings`, when
provided, preserve each skill's phase selection and usage note. Every scoped skill needs its
binding. The compiler checks unique identities and display names, author/reviewer separation,
declared skill/instruction closure, skill cycles, phase references, portable path collisions and
templates for every work type. It uses the original shared agent-mapping rule. Required
constitutions must be present; missing constitutions under `warn` remain retained advisories.
Enabled planning retains its configured prompt. The compiled package stores every fully resolved
workflow contract, so later Story creation can pin the accepted rules directly.

The host verifies every declared body using its complete byte count and SHA-256, both before
preparation and before acceptance. Text resources must be nonempty UTF-8 without NUL. File
resources can retain binary bytes. Source/compiled packages have a 4 MiB bound; individual
resources have an 8 MiB bound, their aggregate has a 64 MiB bound, and the resource inventory has
2,048 entries. These content bounds do not increase namespace metadata or transaction limits.

The canonical package is an explicit object model. Converting existing repository files and
their richer import/harness provenance into it remains part of the migration and integration work;
approval does not infer undeclared filesystem dependencies from prose.

## Persistence and recovery

The host retains a compiled package and a prepared intent, including its original reviewer,
timestamp, source, base revision and transaction digest. One conditional transaction checks the
authority revision, current configuration head, immutable version binding and absent decision
manifest. It records the immutable configuration version, advances `config:configuration/current`,
records one immutable approval manifest, and emits one configuration-approved event.

The result returns both `revision` (the head record revision for the next review) and
`transactionRevision` (the receipt's transaction revision). Its `advisories` count points at the
compiled configuration, which retains the exact advisory rows. Approval creates no Story.

Retry the same operation ID after an unknown outcome. An accepted retry acknowledges its original
receipt without another identity check or timestamp. A prepared operation requires its original
reviewer and fresh authority. Competing configuration updates cannot change its selected base.
Concurrent invocations can acknowledge one accepted intent, but the coordinator never retries a
mutation or chooses a new revision automatically. Genuine provider/storage failures, missing bytes,
corruption, cancellation and future schemas retain explicit errors. Neither enrollment nor
configuration approval can enter the internal Story lifecycle writer.

## Boundary and remaining work

Kernel rules validate the canonical object graph and use the actual workflow compiler over fixed
value/runtime primitives. Node binding owns native path, address, hashing and runtime facts. SDA
owns content and metadata persistence. The configuration host coordinates those owners through
the registered operation. Shared bounded JSON grammar now lives in foundation; existing namespace
readers retain their original limits, identities, diagnostics and exported function signatures.

The later [Story creation delivery](ENGINE-SDK-STORY-CREATION.md) consumes these immutable approvals.
Complete lifecycle ports remain required. Native configuration
adapter convergence, existing-project export/import and authority cutover, old-writer fencing,
obsolete-access removal and final distribution/performance qualification remain open milestones.

## Mac qualification

The final Node 26.12.0 run passed 605 tests across 38 files with no failures, cancellations or
skips. The tests exercise actual filesystem, SQLite and application-backed stores; source and
resource corruption; permission changes; concurrent writers; fencing; cancellation; lost
acknowledgements; immutable history; and native namespace crash/recovery and conformance checks.

Every shipped workflow was compiled from its real configuration and retained resources: all 18
workflows, drawn from 49 phase declarations, retain their original effective contracts. Agent
tools, scoped skill bindings, instruction dependencies, templates and optional-constitution
advisories are preserved. The actual packed SDK installs outside the source checkout, approves
configuration and acknowledges it in another process with an empty `PATH`. Its NodeNext
declarations reject invalid operation inputs and resolve the new host entry.

Source validation passed 3,774 checks and the Git audit retained 2,011 registered production sites.
VS Code typechecking and all 13 rebuilt bundle budgets passed without changing a ceiling:
gateway 851 modules, extension 152, Help 135, Support 111 and prewarming 23. Qualification for
this slice is Mac only; existing Git authority and installed workspaces were not changed.
