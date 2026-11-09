# Durable execution history through namespace storage

The optional SDK now exposes SGOS's existing Operational Store v1 protocol and an explicit
`namespace-runtime-v1` implementation. It persists reconstructable execution history through
application-supplied SDA record and immutable-content ports. Filesystem, SQLite and application
journals use the same implementation. Construction does not read or initialize storage.

## Ownership and compatibility

`sgos/operational-contract.mjs` owns the shared v1 value rules, state/event sealing, lineage replay,
backup validation, bounded records and structural adapter validation. Its digest capability is
explicit; it imports no host I/O. The existing `sgos/operational-store.mjs` remains the native
memory/filesystem implementation and compatibility export. Native filesystem layout, lock handling,
runtime admission and configuration recovery stay there.

Captured states, events, backups, rollback plans and errors from `65221f93e` preserve their v1
identities. The portable byte count uses the same UTF-8 semantics, including non-BMP and escaped
text. Existing profiles are not relabelled, and their backup/restore meanings remain unchanged.

The namespace implementation selects neither a Git executable nor a model provider. It writes
only `runtime` records and content. `state`, `config`, evidence publication and human decisions
retain their separate authorities. An operational record cannot approve a phase or certify a
test. The native live-runtime admission identity remains restricted to its existing implementation.

## Storage and concurrency

Each event is immutable runtime content. An immutable lineage manifest retains its ordered
content references. One small mutable runtime record binds that manifest to the project, store,
revision and full reconstructed state digest. Every read verifies the content, event chain and
head. Missing required content is corruption; unavailable storage remains an explicit port error.

Appending history prepares immutable content and conditionally replaces that one head record,
with a namespace receipt and event in the same transaction. A competing writer loses its
compare-and-swap race. Prepared content without an accepted head is not a committed event.
Separate SPI invocations have distinct transaction identities, including when their changes are
identical. Only the exact in-flight write may recover its own namespace receipt.
Large operational values do not become oversized namespace metadata. The existing 2,000-entry,
20,000-event and 8 MiB operational bounds are preserved without widening SDA transaction limits.

Restore accepts a verified fast-forward prefix and publishes one conditional head only after all
required content exists. Interruption preserves the previous head. Rollback requires the exact
current confirmation and appends history; it does not erase earlier events. These operations
restore operational data, not lifecycle authority or permission to repeat an external effect.

An uncertain metadata write is inspected by its exact operation receipt without repeating the
write or invoking an executor. If it cannot be reconciled, the error retains its original code,
message and cause plus the operation ID, request digest and intended state digest for recovery.
Ordinary permission, timeout and content-read errors propagate unchanged. Unknown outcomes are
not treated as rollback or successful execution.

## Explicit SDK use

```js
import { createNamespaceSgosOperationalStore } from
  '@singularity-flow/engine-sdk/execution/storage/namespace';

const history = createNamespaceSgosOperationalStore({
  records, content, scope: { projectId }, storeId: 'application-execution'
});
const snapshot = await history.read();
```

The pure `execution/storage` entry exposes the v1 protocol, structural validation and TypeScript
contracts without choosing storage. The namespace entry requires shared record/content bindings
that support the operational byte limit. The application owns and closes its connections. A new
host opens those same ports and reads the retained history without the original process or checkout.

## Verified replay reuse

The filesystem namespace journal previously reconstructed every accepted transaction on every
record read and receipt lookup. The three-phase fixture made 1,242 record reads and 450 receipt
lookups. Its record-reading work dominated immutable content access.

The concrete SDA journal now retains a bounded verified prefix: at most eight projects and
8 MiB of serialized state/fingerprints, with a bounded file count. Every call still checks the
store manifest, current directory and sequence, opens each relevant file and reads its complete
current bytes. Matching fingerprints reuse the previously validated replay. New suffixes use the
existing transaction validator. Changed bytes fall back to full validation; missing files,
permissions, corrupt history and unsupported versions keep their original outcomes. Returned
Maps and values are detached, and constructor bounds are captured rather than read from mutable
caller options. This is verified replay reuse, with no advisory expiry or skipped final binding
check. Filesystem layout and stored versions remain unchanged.

The [retained local measurement](../benchmarks/engine-sdk/results/namespace-replay-mac.json)
records one matched initialized fixture pair: the same 29 operations decreased from 49.1 seconds
to 9.7 seconds, with identical port-request counts. The [reproduction runner](../benchmarks/engine-sdk/namespace-io-profile.mjs)
executes the actual engine through authoring, publication, submission, independent fixture approval
and a human route choice, then proves terminal completion. It uses isolated local data and makes
no live provider or Git calls. These measurements cover this filesystem-backed SDK fixture;
full cold-start and supported-host performance qualification retain their later migration gate.

## Mac qualification

The full namespace consumer run passed 751 checks across 44 files. A subsequent 135-check run
qualified the final constructor-bound policy, detached values, current/historical views, storage
faults and replay bounds. The actual installed archive passed all 21 checks, including separate
empty-PATH hosts, exact operational history, canonical-byte rejection and NodeNext declarations.
These final runs reported no failures, cancellations or skips. The sequential archive check
completed within its unchanged 120-second parent and 60-second child-process limits.

The optional SDK retains 51 operations and builds from 135 source modules, emitting 1,355,276
JavaScript bytes. The benchmark runner proved terminal completion on both the committed baseline
and final source, retained their source digests and identical request counts, and removed its
temporary baseline checkout. All tests used isolated local data. No Windows, hosted CI, live
provider, product installation, existing-project migration, merge or push ran.

## Remaining integration

This component supplies durable operational persistence. The portable execution coordinator still
needs to bind actual SGOS attempts, live-owner checks, leases, uncertain-effect reconciliation and
retained phase-test evidence to the engine operations. Merely storing a lease or rolling back a
record does not establish that a process stopped. Complete application Story execution, remaining
native-rule/query extraction, existing-project migration/cutover and final distribution/performance
qualification retain their Phase 5, 7, 8 and 9 scope. Installed Git authority is unchanged.
