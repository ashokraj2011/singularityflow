# Retained outputs and validated database reads

The namespace engine registers `phase.output.retain`. A host supplies one exact logical Story
evidence path, a unique operation ID and an explicit immutable content reference. The SDK never
discovers an output on a laptop or treats a local input attachment as a published deliverable.
The default native Git host does not bind this new operation; its installed behavior is unchanged.

```js
const uploaded = await localContent.put(scope, 'local', capturedBytes);
const result = await engine.run('phase.output.retain', {
  operationId,
  workId,
  phaseId,
  path: approvedEvidencePath,
  content: uploaded.reference
});
```

The path comes from the actual approved contract. Retention alone is also available for supporting
outputs, but does not add a clause, supply a missing test, grant a visual pass or approve a phase.
The operation requires the current open authoring generation and its actual eligible author.
Code outputs additionally require an accepted source archive for the exact authored generation.
Protected paths and other Stories' evidence directories remain outside this operation's scope.

Input documents and images stay in their separate local store. Only this explicit output operation
copies its supplied bytes to project evidence. The bounded profile permits 32 files per generation,
16 MiB per file and 64 MiB in the selected generation. Paths must be portable, with no duplicate
names that differ only in case. These are implementation bounds, not acceptance exceptions.

## Ownership and compatibility

The kernel owns path, generation and source-role selection. The SDK owns the single registered
stage sequence. SDA owns the conditional intent, immutable bytes/result, generation index and
receipts. Actual source observations remain behind their explicit source ports. Host capture,
application execution and wording remain outside these rules.

Output retention uses separate version-1 plan, intent, result, manifest, index and binding families.
It changes evidence/runtime records only. In particular it does not change the Story lifecycle
revision, private draft or source files. Adding a screenshot after a test run therefore does not
invalidate otherwise unchanged test evidence.

Code preflight/report profiles 12 and 13 carry the exact accepted output selection. Profile 13
retains mixed test/visual/inspection acceptance; a separate authorized human witness is still
required. Optional rework and preceding Code proofs reflect their actual presence. Original Code
profiles 1–11 keep their fields and meaning. Their historical replay never infers a subsequently
created mutable output index.

A published output is included in the actual phase artifact inventory, review resources, downstream
input documents and witness context. A successor generation needs its own retained output and
human sign-off. An old image or a passing implementation test cannot stand in for those records.
Shared-only replay reads the immutable evidence and original receipts without the original checkout
or local upload, preserving the original author and timestamp.

Publication conditionally fences the selected index and immutable results. An output replacement
during publication refuses the old candidate and preserves its intent. The next publication selects
the replacement under a different candidate identity; it does not require artificial code edits or
repeating an unchanged test run. Tests, authority and final source observations retain their existing
checks. A database transaction is not represented as a lock over an application editor.

## Database and proof reuse

Qualification exposed a repeated full journal replay on SQLite record reads. The SQLite journal
now keeps bounded private copies of successfully verified views, guarded by the live database
identity, head and SQLite change token. Its own writes invalidate reuse; external commits, including
historical-row corruption without a head change, force verification again. An external commit
between token and snapshot reads cannot turn a stale view into an accepted append. Raw transaction
bytes, opaque revisions, schema versions, WAL confirmation and crash-recovery behavior are unchanged.
The application adapter using this journal receives the same improvement through its existing port.

Twelve repeated record reads now replay one journal prefix while still reading the head on all
twelve requests and checking the change token before and after each snapshot. The regression uses
real SQLite statements, independent connections and actual corruption, not a successful-read flag.
Oversized views remain uncached; bounded retained views are detached on insertion and retrieval.

Completed immutable Code proofs can also be reused within one live engine invocation. Genuine
captured reader methods retain their invocation domain; arbitrary copies and substituted ports
cannot register themselves. Errors, mutable heads and unfinished recursive traversals are not
reused. Every transaction invalidates this reuse, and it never survives the public operation.
Current source, human authority and conditional acceptance remain outside the immutable memo.

## Mac qualification

Qualification passes 379 distinct affected Mac checks without failures, skipped or cancelled tests.
Repeated runs are counted once; interrupted development attempts are not qualification.

| Coverage | Checks |
| --- | ---: |
| Existing Code, source retention, output paths, witnesses and read regressions | 59 |
| All registered native compatibility qualifiers | 79 |
| SQLite/application conformance, crash recovery and validated-view reuse | 76 |
| Invocation-local read/proof boundaries | 14 |
| Output publication races, review and write ownership | 3 |
| Two-generation Code/Release journeys across the three backends | 3 |
| New offline consumer, NodeNext types, inventory, host bindings and schemas | 18 |
| Architecture boundaries | 93 |
| Original unchanged installed-package qualifier | 34 |

The original 34-check package qualifier runs alone in 47.2 seconds under its unchanged 120-second
parent and 60-second child bounds. Source validation, VS Code types, the unchanged 2,011-site Git
audit and all 13 original bundle ceilings pass. Gateway remains 6,914,296 bytes and 852/852 modules.

The three real storage backends exercise source changes, actual Node tests, two Code generations,
separate fixture reviewer identities, fresh outputs, final Release and checkout-free replay.
These are isolated acceptance fixtures, not production application screenshots or real Story approvals.

The initial large SQLite case exceeded its existing deadline. After fixing repeated replay, both
SQLite and application journeys pass in about 22 seconds within the original limit. This is a
fixture measurement, not a claim about end-user Story latency. No timeout or bundle ceiling was raised.

Artifact-only publication/acceptance, repository-qualified evidence corrections, late plan
revalidation, live application review, risk/test decisions, forward amendments and other required
policy/execution owners remain in the [completion ledger](ENGINE-SDK-PHASE-5-7-CLOSURE.md).
Neither Phase 5 nor Phase 7 is declared complete by this extension. No Windows, hosted CI, provider,
installed integration, real Story or main-branch mutation was performed.
