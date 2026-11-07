# Immutable content and the namespace read host

The Engine SDK preview can now inspect retained phase documents and read their bodies from
explicit namespace/content ports. Filesystem and SQLite metadata backends use the same registered
`phase.review` and `document.read` coordinators and kernel selection rules as the native Git host.
This is a read projection. It does not provide lifecycle writers, accept the source of a projection,
produce an approval packet, or migrate an installed Git project.

## Content boundary

The [namespace contract](NAMESPACE-STORAGE-CONTRACT.md) deliberately limits one metadata value to
64 KiB. Histories and retained files can be larger. `sda-content-store/draft-1` separates immutable
bytes from conditional metadata, so increasing a Story's history does not enlarge transaction
journal values or require a different record limit. Its pure entry is `src/sda/content/contract.mjs`;
the package exports it as `@singularity-flow/engine-sdk/content`.

Each reference is exactly `{ namespace, sha256, bytes }`: a logical namespace, lowercase SHA-256
and bounded byte length. Every call supplies a project scope. The content adapter refuses `local`
in a shared store and shared namespaces in a machine-bound store. The absolute data location,
database credentials, connection lifecycle and device identity are construction-time host concerns.

| Operation | Meaning |
|---|---|
| `put(scope, namespace, bytes, { signal })` | Store immutable bytes; return their reference and whether an identical object already existed |
| `read(scope, reference, { maximumBytes, signal })` | Verify the entire object, then return a bounded detached prefix, or explicit `missing` |

The default object maximum is 128 MiB; a host may select a smaller fixed limit at store creation.
A zero-byte preview still verifies the complete object. Empty retained bytes are present, distinct
from a missing object. A reused write verifies the existing object and never overwrites corruption.
This contract does not infer a transaction spanning content and metadata. A future lifecycle writer
must store the immutable body before conditionally publishing its head/manifest references. Bytes
left unreferenced by a failed metadata transaction are not accepted lifecycle records; cleanup needs
an independently verified retention policy.

## Application-owned SQLite content

`storage/sqlite-content` binds an existing SQLite connection implementing `exec` and `prepare`.
There is no file or Git discovery, environment lookup, connection download or automatic retry.
The application owns opening/closing the connection and choosing a bounded `busy_timeout`.
The connection requires durable journaling and FULL or EXTRA synchronous writes; the adapter
checks these settings and does not change them. Its tables can coexist with unrelated application
tables. They cannot share the exclusive SQLite namespace-journal database.

The three owned STRICT tables hold one versioned manifest, immutable object metadata and 64 KiB
content chunks. Object and chunk acceptance uses one `BEGIN IMMEDIATE`/`COMMIT`. This avoids
repeated substring scans over a large SQLite BLOB and leaves metadata journal limits intact.
Reads hash every chunk in one consistent SQLite snapshot before returning the prefix. Schema
changes or owned triggers are refused before writes. Native SQLite corruption, permission and
timeout causes remain available under the shared error constructor.

A refused write rolls back only the adapter's own transaction. It never rolls back an already-open
application transaction. An uncertain commit acknowledgement returns `SDA_CONTENT_OUTCOME_UNKNOWN`
with the exact scope/reference: read that same reference before retrying. Initialization uncertainty
returns the store identity and instructions to reopen the same database. Future manifest versions
retain their upgrade diagnostics and are never reinitialized.

## Read projection

`hosts/namespace-reader` exports `createNamespaceReadEngine`. Construction requires explicit
`records`, `content`, `scope` and `workId`; an optional machine-bound `localContent` port supplies
uploaded attachments. It binds only the two registered read operations. Other engine operations
fail with `ENGINE_PORT_UNAVAILABLE`. It performs no provider, process or source-control operation.

The namespace metadata contains a conditional `state` head under the stable key returned by
`namespaceStoryReadKey(workId)`. It points to three immutable content records: the Story read view,
document read policy and document index. These records use their own frozen v1 schema families.
They do not relabel or replace native `workflow.json` records. `projectNamespaceReadState` derives
the fields required by the existing phase/document queries from an already accepted native source;
it does not save, approve or migrate that source. The host still owns binding and provenance.

The reader captures one head revision and loads its three exact references. After checking the
requested retained files it rereads that head. A changed revision returns `ENGINE_CONTEXT_CHANGED`,
so the caller can request a new snapshot without accepting mixed generations. A missing head,
missing body, invalid UTF-8, unsupported schema and unavailable storage remain separate outcomes.
There is no empty-Story fallback, old checkout search or implicit Git recovery.

Retained document references preserve the native identifier algorithm. The same kernel selects
phase/generation members and classifies matched, changed and unavailable content. Missing retained
members remain in the inventory. The existing catalog resolver retains names, aliases, detached
documents and ambiguity rules. Budgets truncate valid text at code-point boundaries after its
entire digest and encoding are checked. Binary content is integrity-checked without invented text.
Every review manifest has `reviewBinding: null`; this read projection is never fresh approval proof.

Local attachments have shared metadata/digests and machine-local bytes. A second laptop without
matching local bytes receives `DOCUMENT_REUPLOAD_REQUIRED`. Uploading the exact bytes into its
own device-bound content store makes that document readable; no shared-content fallback uploads
or leaks those bytes.

## Qualification and remaining work

Native Mac tests compare whole manifests and document results from a genuinely published Planning
Story against both metadata backends. A second process reopens the persisted read view with an empty
PATH and module hooks refusing Git, CLI and process imports. Original Git HEAD and workflow bytes
are unchanged. Long-history, missing/changed evidence, local reupload, moved-head, encoding and
real-cause tests exercise the same host.

SQLite content tests use actual file databases, physical before/after-COMMIT process interruption,
concurrent first writers, lost acknowledgements, cancellation and corruption beyond preview bounds.
The external npm-archive consumer also reopens and reads the projection in a second process; all
new public entries have installed NodeNext declaration coverage.

Combined qualification on macOS 26.7.2 / Node 26.12.0 passed 266 checks across 19 test files, with
no failures, cancellations or skips. It includes existing namespace conformance, crash/retry,
document identity and native read parity tests alongside the new backend/host and packed-consumer
checks. Source validation passed 3,679 checks; VS Code typechecking, Git ownership audit, all 13
unchanged bundle budgets, dry-run npm packaging and whitespace checks passed. The gateway has
851 modules / 6,745,163 bytes. The SDK build contains 37 registered operations, 50 owned source
modules and 304,111 runtime bytes; its 34-file local archive is 76,711 bytes compressed. These
are qualification/artifact measurements, not end-to-end command speed claims.

Portable lifecycle writes, complete cross-agent Story execution, verified export/import, authority
fencing, storage selection and distribution/performance qualification remain required by phases
7–9 of [the migration](ENGINE-SDK-MIGRATION.md). No Windows, hosted CI, real provider or installed
project mutation is part of this Mac-only delivery.
