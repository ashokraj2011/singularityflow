# Checked namespace publication and submission

The explicit namespace Engine can publish and submit a primary document with its actual retained
phase checks. This connects `phase.checks.run` to the existing `phase.publish`, `phase.submit` and
human `phase.approve` operations. Installed Git projects retain their existing authority and paths.

## Ownership and immutable versions

| Owner | Responsibility |
|---|---|
| Kernel | Existing check verdict, authored artifact and approval rules |
| Engine coordination | Resolve the exact draft evidence, revalidate its sources and coordinate registered operations |
| SDA | Conditional acceptance of the Story, configuration and extra observed record revisions |
| SGOS | Execute once, retain raw outcomes and confirm process quiescence |
| Host | Bind physical executables, source units, authenticated identities and storage |

The operation vocabulary stays at 52 operations. There is no new publish command, replacement
test argv, caller-supplied passing verdict or approval shortcut.

| Record | Preserved meaning | Added profile |
|---|---|---|
| Lifecycle prepared intent and operation manifest | v1 bytes, request digests and receipts | v2 adds a nonempty bounded `readBindings` set |
| Publication manifest | v1 primary document without checks | v2 names accepted check evidence |
| Submission packet | v1 without routing; v2 with routing | v3 binds the same check evidence, with explicit routing or `null` |
| Check evidence binding | New family | v1 names the exact result, index and accepted revisions |
| Lifecycle head and Execution Unit ABI | Existing v1 | Unchanged |

Old writers without additional read bindings still produce v1 lifecycle operation records. Readers
dispatch through the registered record profiles; they do not restamp historical data or silently
add fields. Independently captured v1 packets remain the byte-compatibility oracle.

## Publication and repair

The publication owner resolves the check index for the exact project, Story, phase, generation,
canonical basis and private draft identity. It verifies the accepted intent and result receipts,
the pinned command/repository set, retained source snapshots and actual report bytes. Parsed test
counts are reconstructed rather than trusted from a summary. A complete passing check set must
refer to this artifact, configuration and draft.

Before preparation and final acceptance, explicit source units must still observe the tested
bytes. Both the selected mutable check index and immutable result metadata revisions become
conditions in the same SDA transaction that advances the Story head. A later failed run cannot
race a checked publication into acceptance. The checked manifest and result content are retained
in the operation's evidence set.

Missing or failing checks return `ENGINE_CHECK_EVIDENCE_REQUIRED` or `PHASE_CHECKS_NOT_PASSED`,
with `operation: phase.checks.run`. Source drift retains `ENGINE_SOURCE_CHANGED`; changed record
revisions retain their context/conflict diagnostics. The authored draft and actual run remain
preserved. A repaired run selects a fresh publication candidate without overwriting an earlier
prepared intent or asking for a new Story.

## Submission, review and another host

Submission verifies the accepted checked publication and conditionally retains the same check
binding in its v3 review packet. Human approval reads that immutable packet and applies the
existing actor, authority, independence and threshold rules. Test success never becomes approval
or establishes acceptance-clause coverage by itself.

The proof reader is separate from execution. It imports no filesystem or process implementation,
and uses explicit SDA content/record ports. SGOS manifest/task validation has a data-only Node
owner; existing execution imports remain compatibility exports of the same functions. Another
host can read the packet and acknowledge accepted publication or check receipts without the old
private draft, physical checkout or executor. Missing blobs, permissions and genuine storage
deadlines retain their actual errors rather than triggering a replacement test run.

## Stop and completion

The durable execution owner reconciles the final event suffix after positive quiescence before
accepting an outcome. This covers an observation batch that closes before a concurrent stop has
settled. The exact event chain, handle, task and terminal receipt must still match. Negative
quiescence, changed event bytes and unknown effects remain explicit failures. A failed waiter
cannot discard a newer completion attempt's promise.

Recording checks cannot use the canonical lifecycle writer. Its accepted effects stay in runtime
and evidence namespaces until a separately admitted lifecycle operation binds them.

## Qualification and remaining gates

The Mac fixtures exercise real processes and all three namespace record backends, checked
publication/submission, independent human approval, routing, source/draft drift, failed rerun
races, original receipt recovery and missing raw reports. The installed archive completes the
same checked journey and reopens its evidence in a separate empty-PATH process. These are isolated
test identities and stores, not changes to a real Story.

The final core qualification passed all 195 checks across nine files, with no failures,
cancellations or skipped tests. The installed archive passed all 24 checks. Source validation
passed 3,900 checks across 191 skills; VS Code typechecking and the unchanged 2,011-site
process/Git ownership audit passed. All 13 bundle budgets passed without increasing any ceiling:
gateway 852 modules, extension 152, Help 135, support 111 and prewarm 23. The gateway contains
6,864,543 JavaScript bytes. The optional SDK retains 52 operations and builds from 151 modules,
emitting 1,518,245 JavaScript bytes.

This profile supports the phase-check executor's existing structured test-command contract. Code
delivery and artifact sets, clarification/claim/constitution policies and other unbound owners
remain explicit integration gates. It does not complete full application Story execution,
existing-project migration or final distribution/performance qualification. Phases 5, 7, 8 and 9
remain open. No Windows, hosted CI, live provider, product installation, migration, push or merge
is part of this qualification.
