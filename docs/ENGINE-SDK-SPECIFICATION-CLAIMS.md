# Shared specification claim values

Planned evidence parsing, supporting-file classification, fulfillment duties, observed delivery
projection and native v2 claim-map normalization now use shared kernel rules. Native readers retain
their synchronous API and their actual record/file/authority owners. This is a prerequisite for
verified namespace application publication, not a new publication route.

## Values and effects

`kernel/specification-values.mjs` owns the claim rules alongside the existing clause/index value
family. Its claim factory captures frozen path and UTF-8 syntax. It composes the actual shared
verification and source-classification rules; a caller cannot replace them with a readiness callback.
The same planned source/test/supporting-file path rules also serve code-delivery replay and preflight.
Their single owner is `plannedClaimPathPolicies` in `kernel/source-path-policies.mjs`.

The four shared replays are `normalizeClaimMapReplay`, `inspectPlannedClaimMapReplay`,
`derivePlannedClaimMapReplay` and `deriveObservedClaimMapReplay`. Their only effect request is the
frozen v1 `SPECIFICATION_CLAIM_TIMESTAMP_REQUEST`. The engine supplies the timestamp at that exact
checkpoint. The kernel never reads an ambient clock or invokes a file, process, Git or provider.

The native compatibility driver in `specifications.mjs` handles that request with its existing
`nowIso` and returns clock errors to the generator. Direct normalization preserves the real error;
planning inspection keeps the same row/final-map diagnostics. The old public functions remain
synchronous. The optional SDK exposes the replays through its existing `specifications` and
`specifications/node` entries, without adding another registry operation.

## Preserved native behavior

Normalization validates policy, clause identity, paths, dispositions, fulfillment, supporting files
and verification contracts before asking for time. The canonical UTF-8 size check still happens
after the timestamp has been added. Planning inspection still normalizes individual valid rows
and its final map. Observed derivation still normalizes the plan before examining delivery evidence,
then normalizes its observed result. A validation failure therefore does not move a clock call
earlier or erase an earlier normalization call.

Native claim-map v2 fields, migration from v1, reader range, diagnostics, sorting and serialization
remain unchanged. Its `commits` field still means full Git SHAs, including the supported SHA-1 and
SHA-256 forms. Empty commits are not invented source-control proof. This extraction does not
silently reinterpret that field as a generic source revision.

Authoring validation and legacy record interpretation keep their different duties: typed Markdown
paths and evidence roles are checked at authoring, while normalization retains the existing stored
record rules. Tests alone do not become source evidence, supporting files cannot silently claim
product behavior, non-test verification remains exact proof rather than a waiver, and a retained
evidence projection still requires the recorded exact hash and state.

Before production edits, native commit `ce8f198f0` produced the independent 111-case fixture at
`test/fixtures/specification-claims/native-v2.json`: 57 successful outcomes, 54 refusals and 89 clock
calls. It records original function fingerprints. Shared and compatibility paths must reproduce the
wire outcomes and clock counts; separate assertions retain in-memory diagnostic keys, canonical
record hashes, real clock failures, nested diagnostics and the exact clock/byte-limit order.
The captured oracle uses explicit POSIX syntax. Host parity compares native behavior with the same
host's syntax, and a separate value test exercises Win32 normalization on Mac. Strict authored paths
remain strict under either grammar; this does not claim native Windows qualification.

## Remaining integration

A normalized map and its digest are candidate values. They do not establish that a plan was
approved, its source was retained, its delivery was executed or its clauses were accepted. Namespace
application publication must verify the actual approved specification/claim bytes and original
receipts, bind them to current source and checks, and supply all required policy owners. Those
requirements are unchanged. Reproducing a retained timestamp does not permit restamping an accepted
record or claiming new authority. Phases 5, 7, 8 and 9 remain open.

Qualification for this extraction is Mac-only, with isolated machine state and fixtures. It does
not merge, push, install, invoke a live model or modify a real user Story.

## Qualification

The broad Mac regression run passed all 249 cases across specification, verification, code-delivery
replay/preflight, planned path roles, amendments, candidate isolation, configuration, review, lineage
and fulfillment. It includes the opt-in mixed-fulfillment Story and verification continuation cases.
The final 17-case value run rechecks the changed oracle/host comparison and adds the explicit
POSIX/Win32 case. Together with 73 architecture checks and 28 installed-package checks, qualification
covers 351 distinct tests with no failures, cancellations or skips.

The actual SDK archive runs without the source checkout and with an empty PATH. Its pure entry
replays original claim bytes while rejecting implicit infrastructure imports, and its optional Node
entry uses the same rules. The installed declarations typecheck. Fixture data is copied into the
isolated consumer program rather than passed through oversized command-line arguments.

Source validation passed 3,958 checks across 191 skills. VS Code typechecking, the unchanged Git
ownership audit and all 13 unchanged bundle budgets passed. The gateway remains at 852 modules
under its existing 852-module ceiling. The SDK retains 57 operations across 190 owned modules and
1,890,964 JavaScript bytes. These results qualify shared values and native compatibility; accepted
namespace specification/claim proofs and full application publication remain required.
