# Application and SQLite namespace storage

This delivery adds a real database implementation and a versioned application persistence port.
Both use the namespace protocol already exercised by the filesystem backend. They remain explicit
bindings for new stores; neither selects an authority for an installed Git project.

## SQLite binding

```js
import { createSqliteNamespaceStore } from '../src/sda/sqlite-namespace-adapter.mjs';

const storage = await createSqliteNamespaceStore({
  filename: '/workspace/storage/project-state.sqlite',
  binding: { kind: 'shared' },
  create: true,
  busyTimeoutMs: 1000
});
try {
  const answer = await storage.read({ projectId: 'project-a' }, 'state', 'stories/STORY-1');
} finally {
  storage.close();
}
```

SQLite is loaded only when selected. The adapter uses the managed Node 26 runtime or a host with
the required native SQLite features; no global runtime or external database package is installed.
The binding requires an absolute regular filename. New files are reserved without truncation and
with private permissions. An ordinary open refuses an absent or uninitialized database. Explicit
creation can resume an empty interrupted initialization; unrelated files, application tables,
symlinks and incompatible bindings are refused without replacing their content.

The backend owns three strict tables: store metadata, immutable journal entries and accepted
project heads. Initialization is transactional. WAL and `synchronous=FULL` are required; native
connection construction and runtime capability checks have their own small adapter. The store's
record/transaction limits are immutable; page size can vary per handle. Machine-local bindings use
separate databases and device identities, as with the filesystem backend.

## Conditional commit, recovery and corruption

One SQL transaction compares the observed project head, inserts the normalized transaction and
advances that head. Records, events and the original operation receipt are reconstructed through
the shared pure reducer from that one accepted entry. A moved head retries observation before
rechecking the original record preconditions. Conflicting intent under an operation/event ID,
immutable replacement and stale read dependencies retain their namespace outcomes.

No asynchronous callback runs while the native SQL write transaction is held. The configurable
busy deadline bounds local lock waiting; `SQLITE_BUSY` remains the actual cause rather than being
described as network or DNS failure. A refused write rolls back. Once COMMIT has been attempted,
a lost acknowledgement reports `OUTCOME_UNKNOWN`; inspection and same-intent retry reconcile the
original operation without duplicate records or events. Durability confirmation checks the
accepted prefix and completes a full WAL checkpoint, refusing a busy/incomplete confirmation.

Concurrent opening can return `SQLITE_BUSY` while negotiating WAL mode before SQLite invokes its
busy handler. Opening alone retries that specific native contention within the configured
`busyTimeoutMs` budget, closing the failed handle and rechecking the same file identity. It keeps
an already initialized manifest and never retries an application transaction or another error.
If the budget is exhausted, the original SQLite cause and `database-open` stage remain visible.

A crashed process needs no stale SFlow lock removal: SQLite recovers its own transaction. A kill
before COMMIT leaves no accepted entry/head/receipt; a kill after COMMIT retains the original one.
These are native process-crash checks, not claims about hardware failure or network filesystems.

Reads take a consistent database snapshot and verify store/project bindings, the digest chain,
entry sequence, conditional history and accepted head. A deleted suffix or an entirely deleted
project journal still conflicts with its retained head and is corrupt, rather than missing. Native
read/access failures preserve their cause. Future durable versions remain unsupported with their
upgrade diagnostic and are never rewritten by an older reader. Moving, replacing or closing an
active database cannot turn accepted work into a successful empty read.

## Application-owned persistence

```js
import { createApplicationNamespaceStore } from '../src/sda/application-namespace-adapter.mjs';

const storage = createApplicationNamespaceStore({
  id: 'application-storage',
  qualification: 'production',
  binding: { kind: 'shared' }
}, { journal: applicationJournal });
```

`applicationJournal` implements `sflow-namespace-journal/v1`. It is a trusted host dependency,
never model JSON. Its manifest binds a stable store ID, storage binding and private cursor key.
It provides:

| Method | Required guarantee |
|---|---|
| `read(scope, {through?})` | One integrity-checked prefix, its exact scope/head and record/event/operation maps |
| `append(scope, observed, transaction, {signal?})` | Atomic conditional acceptance; a moved prefix returns `accepted: false`; confirmed acceptance includes the original receipt |
| `confirm(scope)` | Reconcile and confirm durability of an already-observed accepted prefix |

The host can implement these operations over its database or another transactional service. The
port contract and `applyNamespaceTransaction` are pure; no concrete database, filesystem or Git
dependency enters the kernel. Declaring `production` is a capability declaration, not proof: the
implementation must pass the shared conformance suite and the native failure/durability tests
appropriate to its backend before adoption. The SQLite implementation supplies that concrete
example. Remote-service credentials stay in host composition, outside persisted records.

The shared coordinator validates observed scope and prefix metadata, binds receipts to the exact
intent, and provides detached results, namespace isolation and signed snapshot pagination. Invalid
observations fail closed; an invalid receipt after possible acceptance is unknown and inspectable.
Native application errors keep their original identity, cause and stage. It never retries an
uncertain effect or silently falls back to another store. The filesystem binding preserves its
existing descriptor, journal bytes, revisions, cursor format and error/recovery semantics.

Application records must be bounded plain JSON with exact namespace/key/version bindings.
Non-JSON values, mismatched namespace-map keys, malformed observations and wrong-operation
receipts are explicit port errors. They cannot become successful empty results or false commit
acknowledgements. The port definitions and validators remain independent of host I/O.

This storage port does not authenticate a person, approve a phase, run tests or perform source
control. Those remain engine/kernel/SGOS responsibilities. Selecting a shared store does not
upload the `local` namespace. A source-code push and a database commit are separate effects and
need the engine's operation journal and reconciliation; this port promises no cross-system commit.

## Remaining migration work

The public package, namespace-backed domain operations, complete cross-agent Story execution,
remaining native-policy extraction and verified migration/cutover are still required by the
[migration plan](ENGINE-SDK-MIGRATION.md). This delivery proves application/database persistence;
it does not claim that all legacy lifecycle logic is already independent of Git.

## Mac qualification

On macOS 26.7.2 with Node 26.12.0, the final 10-suite protocol/native/storage run passed 192 tests
with no failures, cancellations or skips. It covers both new adapters, shared namespace conformance,
filesystem compatibility/crash checks, schema goldens and boundary guards. The broader 20-suite
run also passed the SDK, startup, shared-error and native Git/configuration regression checks.

The SQLite native suite covers 19 tests, including kills before/after COMMIT, lost acknowledgements,
definite write refusals, independent competing writers, concurrent initialization, a real held
write lock, missing journal suffixes, future versions, unrelated files, moved/closed databases and
execution in a fresh process with an empty PATH. Synthetic protocol faults are fixture controls;
the crash/lock probes use actual native SQLite connections and temporary databases.

Source validation passed 3,654 checks. VS Code typechecking, all 13 unchanged bundle budgets,
the Git ownership audit, npm dry-run packaging and whitespace checks passed. The gateway remains
851 modules. All adapter/contract files and this document are packaged; test helpers are excluded.
Machine state and repositories are isolated. No Windows, hosted CI, provider run, installation or
real Story/workspace operation was performed. These checks qualify this storage delivery, not the
remaining full-runtime and migration milestones.
