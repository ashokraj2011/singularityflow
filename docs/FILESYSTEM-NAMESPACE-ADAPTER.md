# Filesystem namespace storage

`createFilesystemNamespaceStore` implements the namespace draft for explicitly created projects.
The concrete adapter lives outside the pure contract directory. Conditional record, event and
receipt rules live in `sda/namespace/state-transition.mjs`; filesystem publication and integrity
belong to the journal adapter. No CLI, prompt, Git or approval owner is imported by this backend.

```js
import { createFilesystemNamespaceStore } from '../src/sda/filesystem-namespace-adapter.mjs';

const storage = await createFilesystemNamespaceStore({
  root: '/workspace/storage/project-data',
  binding: { kind: 'shared' },
  create: true
});
const scope = { projectId: 'project-a' };
const answer = await storage.read(scope, 'state', 'stories/STORY-1');
```

Creation is explicit. An ordinary open does not create a missing store. Initialization refuses
unrelated existing files; it does not infer a backend from a checkout or register itself as either
installed SDA v1 authority. An existing Git project still uses its Story branch, state projection
and approved configuration. Adopting this backend for that project requires the later verified
migration and authority cutover, never an implicit fallback or dual write.

## Files, binding and limits

The root has an immutable `store.json` identity, a cursor-signing key and record/transaction limits.
Each project gets a directory named by the hash of its logical scope. Its `commits` directory has
immutable sequence files; `staging` holds candidates that are not accepted transactions. A complete
project directory is published by directory rename so another first writer cannot observe half an
initialized layout. Logical record keys, including case variants and Windows reserved names, are
JSON values and never physical file names.

`config`, `state`, `evidence` and `runtime` use a shared root binding. Machine-private content needs
another root with `{kind: 'machine-local', deviceId}`. Opening a root under another binding is
refused. The adapter cannot silently route a `local` record into the shared store. The namespace
protocol itself grants no actor authority; the kernel/application still evaluates identity,
approvals and workflow rules.

Record and transaction limits are fixed at store creation. An incompatible reopen is refused,
instead of misclassifying valid historical entries as corrupt. Page size can be reduced per handle
without rewriting the store. The optional clock is a trusted host dependency used only for cursor
expiry; it does not grant approval or change lifecycle rules.

## Atomic publication and recovery

Each candidate contains one normalized transaction, its project/store binding, an opaque revision,
the preceding entry digest and its own digest. The adapter:

1. Replays and validates the accepted journal, including conditional revisions and immutable data.
2. Stages the next candidate under a unique name, writes all bytes and fsyncs that file.
3. Links it to the next sequence slot without overwriting an existing entry.
4. Fsyncs the journal directory before acknowledging commitment.

The link is the single visibility point for records, events and the original operation receipt.
The receipt is deterministically reconstructed from that accepted transaction. Competing writers
cannot replace a winning slot. A loser reads the new state and rechecks the original conditions;
bounded contention reports unavailable with the operation ID, rather than changing intent.

There is no stale writer lock to steal. A process killed before the link leaves only an unaccepted
candidate; the same operation can be retried. A process killed after the link can be reconciled
through `inspectOperation`, which verifies and flushes the observed entry's directory. The same
operation and intent return the original receipt; different intent under that ID is refused.

A flush failure after linking reports `OUTCOME_UNKNOWN`, preserving the native cause and stage.
The caller inspects that operation before retrying. Cancellation checked before linking accepts
nothing. Once the link may have happened, cancellation cannot claim the transaction was undone.
Accepted logs and receipts are retained; orphan candidates do not become authority or block retry.

The durability boundary requires a local filesystem with atomic hard links, atomic directory
rename and working file/directory fsync. Unsupported storage returns its real error. Synced/cloud
folders and network filesystems are not qualified by this implementation. Native process-crash
tests do not prove behavior during hardware failure or loss of a host's disk cache.

## Reads and integrity

Reads reconstruct one journal prefix and return detached data. Entries have strict formats, bounded
sizes, matching scope/store identities, a continuous digest chain and unique accepted revisions.
Unrecognized entries, gaps, truncation, symlinks, altered bytes or invalid transactions are corrupt.
Missing store identity and native access failures are unavailable, with their cause preserved;
neither becomes an empty successful answer.

Manifest and entry versions share frozen family definitions with the durable migration registry.
Version admission is extracted into the pure shared foundation, so this adapter does not import
the legacy migration table or Git infrastructure. A future version is unsupported with its original
upgrade diagnostic; it is neither corrupt nor missing, and an older reader never rewrites it.

The shared schema metadata also supplies the unchanged v6 command-timing stamp. CLI startup no
longer imports the whole historical migration table just to create that stamp. Durable readers
still use the same migrations and legacy diagnostics; timing records keep their existing shape.

Snapshot pages bind the project, namespace, prefix, page limit and immutable journal boundary.
Signed opaque continuations work after reopening the store on another process. Their configured
retention defaults to 30 minutes; an expired token is distinct from a fabricated/mismatched token.
The journal history remains retained, so later insertions, updates and deletes cannot change an
already-issued snapshot. A live integrity failure still prevents a successful listing.

Checksums detect corruption; they are not an external authenticity anchor against an actor who can
rewrite or delete the entire store. Verified export/migration must bind an independently retained
snapshot and fence older writers. Full journal replay is the initial implementation; indexed
checkpoints and final cold/warm performance qualification remain explicit later work.

## Qualification boundary

The shared namespace conformance suite runs against the real filesystem adapter. Test-only fixture
wrappers inject protocol faults; a separate native suite kills child processes around publication,
injects a failed directory flush and races independent writers. Those controls are excluded from
distribution and are not production adapter methods. Current qualification is Mac only.

The application/database adapter, headless package, cross-agent journey, verified export/cutover,
remaining Phase 5 queries and final cleanup/performance gates are still required by the full
[migration plan](ENGINE-SDK-MIGRATION.md).

## Mac qualification

On macOS 26.7.2 with Node 26.12.0, 276 tests across 25 affected suites passed with zero failures,
cancellations or skips. This includes shared namespace conformance, 20 native filesystem cases,
the existing Git/configuration conformance, all schema migration goldens and diagnostics,
source/bundled preparation parity, timing/performance contracts, dependency/startup guards and
a complete specification-through-release Story. The golden corpus retains every previous family;
the two new frozen filesystem families are additive.

Source validation passed 3,643 checks. VS Code typechecking, all 13 unchanged bundle budgets,
the Git ownership audit, dry-run packaging and whitespace checks passed. The gateway retains 851
modules. Test helpers are excluded from the package, which includes the concrete adapter, pure
contracts and documentation. Fixtures use isolated machine state and local remotes; the no-Git
case runs in a separate process with an empty `PATH`.

Compared with `bb05d682f`, CLI startup's static source closure went from 39 modules / 858,297 bytes
to 37 / 661,817, by moving the unchanged timing stamp out of the legacy migration table. The
performance-report bundle went from 12 modules / 147,223 JavaScript bytes to 6 / 140,516. These
are dependency/code-size measurements, not an end-to-end latency claim. Full runtime performance
qualification remains a later milestone. No Windows, hosted CI, live provider, installation or
real Story/workspace changes were performed.
