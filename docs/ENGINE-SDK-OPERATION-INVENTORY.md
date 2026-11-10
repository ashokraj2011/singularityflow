# Registered operation and compatibility audit

Run `node scripts/engine-operation-inventory.mjs --json` to inspect the actual versioned registry
and the default native/namespace host compositions. Construction uses refusing storage, identity,
clock and execution capabilities. The audit opens no checkout or store and makes no network call.
It is a development inventory, not a readiness check or permission grant.

Every row names its version, effect, accepted inputs, required fields, port and execution stages.
Each operation bound by the default native host names its existing compatibility qualification
files. The inventory test fails if that mapping is missing or a named qualifier disappears.
Results are detached from the immutable registry. This command does not run those qualifiers;
their successful execution must be recorded separately.

The current vocabulary has 76 operations. `createGitEngine` binds 41 of them. A namespace host
with explicit private working stores binds 59 before optional execution is supplied. These are
composition-specific counts: a separate narrow factory may connect another operation, and a
configured publication may still require additional policy/evidence owners. In particular,
`phase.checks.run` needs the actual execution capability. A bound `phase.publish` is never proof
that every possible policy configuration is supported.

Native-only terminal plan review remains distinct from the namespace's exact human correction
context/record contract. They cannot be advertised as interchangeable ceremonies. Native JSON,
records and authority are still qualified by their original adapters; new namespace meanings use
their own explicit records and profiles.

This audit does not claim that utilities outside the registry have migrated, that all namespace
policy owners are finished, or that production authority has moved. The remaining work stays in
the [Phase 5/7 ledger](ENGINE-SDK-PHASE-5-7-CLOSURE.md).

The current Mac audit executes 81 checks across the declared compatibility files, including the
real source/bundled CLI projections, actual native mutations, human authority and failure recovery.
All pass without skips or cancellations. This result is qualification evidence for the registered
paths, not a claim that every utility outside the registry has been extracted.
