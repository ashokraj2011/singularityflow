# Namespaced storage contract, draft 1

Phase 2 of [the engine migration](ENGINE-SDK-MIGRATION.md) defines a storage-neutral protocol and
reusable conformance suite. Its internal source entry is `src/sda/namespace/index.mjs`; its identity
is `sda-namespace-store/draft-1`. It is not a public package export or an installed authority.

Existing shared-state/lifecycle SDA v1 contracts, CLI routes, Git writes, configuration authority,
Story branches, hashes and records are unchanged. The Phase 2 reference implementation is under
`test/helpers/namespace-memory-adapter.mjs`, declares `test-only`, and is excluded from distribution.
The later [filesystem backend](FILESYSTEM-NAMESPACE-ADAPTER.md) reuses these contracts for explicitly
created stores; it does not select a backend for an existing Git project.

## Scope, namespace and binding

Every call carries `{ projectId }`. This is a stable logical identity, not a folder or Git ref.
`config`, `state`, `evidence` and `runtime` use a shared binding. `local` requires a separate
`{ kind: "machine-local", deviceId }` binding; a shared adapter refuses local reads and writes.
Two device bindings on the same project do not share local content. A namespace is not an authority
grant: approval and workflow rules remain owned by the kernel.

Identifiers use 1–128 ASCII letters, digits, dots, underscores or hyphens, beginning with a letter
or digit. Keys are case-sensitive, at most 512 characters, with nonempty slash-separated segments
using the same character vocabulary. Absolute paths, traversal, backslashes and encoded separators
are refused. A prefix can be empty or end in a slash. Adapters must encode keys safely for their
physical medium; a logical key such as `stories/CON` is not interpreted as a Windows filename.

Revisions are opaque nonempty strings without whitespace/control characters, at most 512
characters. No SHA, number, branch or path interpretation is permitted. An explicit `null`
precondition means the record must be absent. An omitted revision is invalid.

## Adapter protocol

The descriptor contains exactly `id`, `contract`, `qualification`, `binding`, `capabilities` and
`limits`. Qualifications are `test-only` or `production`; a descriptor is a declaration, not proof
of production eligibility. `validateNamespaceStore` validates the protocol shape and required
capabilities, and never selects an authority. Existing SDA authority selectors reject this draft.

All methods accept optional `{ signal }` as their last argument:

| Method | Result |
|---|---|
| `read(scope, namespace, key)` | `{ status: "present", record }` or `{ status: "missing", record: null }` |
| `list(scope, namespace, query)` | `{ snapshot, entries, complete, continuation }` |
| `transact(scope, transaction)` | `{ status: "committed", replayed, receipt }` |
| `inspectOperation(scope, operationId)` | `{ status: "committed", receipt }` or `{ status: "missing", receipt: null }` |
| `verify(scope)` | `{ valid, errors }` |

A record is `{ namespace, key, version, immutable, value }`. Stored `null` is a present value,
distinct from a missing record. Returned data and retained caller values are detached: modifying
one does not modify the backend. The reference fixture freezes its copies as an additional check.

List queries require `limit`; `prefix` defaults to empty and `continuation` to null. Each page is
bounded, ordered by the logical keys' ASCII code-point order and bound to one snapshot. Continuing
after new records, updates or deletes returns the original snapshot. Tokens are opaque and bound
to project, binding, namespace, prefix and page limit. Unissued/mismatched tokens are invalid;
expired retained snapshots have a different explicit outcome.

## Conditional transactions

```json
{
  "operationId": "publish-42",
  "preconditions": [
    { "namespace": "state", "key": "stories/STORY-42", "version": "backend:opaque/revision-7" }
  ],
  "changes": [
    {
      "op": "put", "namespace": "state", "key": "stories/STORY-42",
      "immutable": false, "value": { "phase": "verification", "generation": 1 }
    }
  ],
  "events": [
    {
      "eventId": "event-publish-42", "eventType": "phase.published",
      "namespace": "state", "payload": { "workId": "STORY-42" }
    }
  ]
}
```

Every changed record has exactly one precondition. Extra preconditions can bind read dependencies,
such as the approved configuration pointer. Duplicate addresses and event IDs are invalid. A delete
requires an existing revision. Event-only transactions are permitted; empty transactions are not.

All preconditions are checked at the atomic publication point. A failed condition, immutable
overwrite/delete, event collision or pre-commit error changes no record, event or receipt.
Immutability is retained metadata and cannot be downgraded by a later put. Configuration/evidence
owners mark version records immutable; mutable pointers are separate records.

A receipt contains `operationId`, `scope`, an opaque transaction `revision`, `requestDigest`,
the changed record addresses/versions and `eventIds`. Deleted record versions are null.
`requestDigest` is the lowercase SHA-256 of the UTF-8 bytes returned by
`namespaceTransactionIdentity`. Hashing is an adapter operation, outside the pure contract.

The identity includes scope, operation ID, preconditions, values, immutability and events. Object
keys and independent precondition/change order are normalized; event order is significant. A
repeat returns the original receipt with `replayed: true`, even after later transactions have
changed the record. It neither rechecks the old precondition nor replays its effects. A reused
operation ID with different valid intent is refused. Event IDs are unique within a project/binding.

This atomic scope is one project in one configured backend. The protocol does not promise a
transaction across source-code pushes, model invocations or another storage system. The future
engine's operation journal coordinates those external effects.

## Data and resource bounds

Inputs are closed plain data objects. Unknown fields, accessors, functions, undefined values,
non-finite numbers, symbols, cycles, dates, maps and sparse/extended arrays are refused. JSON values
are copied and frozen. Negative zero normalizes to JSON zero. Prototype-named data keys are kept
as own properties without changing object prototypes. Existing canonical record encodings remain
untouched; draft identity JSON is a separate compact, sorted encoding without a trailing newline.

| Limit | Contract maximum |
|---|---|
| Page entries | 1,000 |
| Record changes | 128 |
| Preconditions | 256 |
| Events per transaction | 128 |
| Value/event payload | 65,536 UTF-8 JSON bytes |
| Normalized transaction body | 262,144 UTF-8 JSON bytes |
| JSON depth | 24, with the root at depth zero |
| JSON nodes | 20,000 per normalized value/body |

An adapter may lower these bounds and must enforce what it declares. The stable scope binding is
included in identity bytes in addition to the bounded transaction body. Limits bound requests;
result pages remain bounded by count and per-record payload size. Export/restore, durable record
schema registration and production qualification are subsequent deliveries.

## Failure and recovery

- `REVISION_CONFLICT`: return the changed address and expected/current revision, without overwriting.
- `OPERATION_ID_REUSE`: an operation/event identity has different content or another owner.
- `OUTCOME_UNKNOWN`: acceptance may have happened; inspect the exact operation before retrying.
- `unavailable` and `corrupt`: neither can be represented as missing or an empty successful page.
- `invalid`, `limit-invalid`, `immutable`, `unsupported`, `continuation-invalid` and
  `continuation-expired` preserve their distinct meanings.
- Native causes and timeout/stage details survive wrapping. A timeout does not establish DNS failure.

Cancellation before acceptance changes nothing. Once the transaction is accepted it cannot be
reported as cancelled/rolled back solely because its caller disconnected. A confirmed commit
returns its receipt; a lost acknowledgement has unknown outcome and is reconciled through
`inspectOperation`. Missing inspection is meaningful only after a successful authoritative read.

## Qualification

`test/helpers/namespace-conformance.mjs` registers the same behavioral tests for each future
adapter. Its fixture controls inject faults, race writers, corrupt storage, expire snapshots and
inspect retained receipts/events. These are test controls, not production adapter methods. They
can return promises so a future filesystem/database implementation can reuse the suite.

The Phase 2 fixture uses an in-process conditional publication point and tests retry, lost-response,
atomicity, isolation and snapshot behavior. Passing it does not qualify a filesystem for crash
durability or a database for production authority. Those implementations must pass this suite plus
their physical failure/durability checks in their own delivery phase.
