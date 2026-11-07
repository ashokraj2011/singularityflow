# Publication records and aggregate updates

The kernel's `lifecycle-transitions` module now owns publication receipt construction and the
corresponding in-memory aggregate updates. This includes generation ownership and authorship,
live delivery bindings, retained AST receipts, clarification summaries, open markers, telemetry
summaries, downstream briefs, typed artifact sets and generation-publication retention.

These functions receive explicit observations and timestamps. They do not inspect a checkout,
sample a clock, authenticate an actor, execute tests, write a receipt or select storage. They
update a proposed aggregate only after their caller has completed admission. They are internal
rules, rather than a new public mutation operation or an alternative approval authority.

The installed Git publication adapter retains its original ordering:

1. Admit the actor, current phase, configured producer, required evidence and generation.
2. Run the existing publication checks, including code delivery, dependencies, AST and budgets.
3. Set generation ownership, sample the native publication clock, then append authorship.
4. For code delivery, clear only live submission bindings, write the change set, observe the
   source and test-input trees, build the delivery receipt, await its write and then attach live
   delivery evidence. Failed writes do not acquire a live receipt binding through the helper.
5. Persist native AST, clarification, telemetry, metadata, sidecar and downstream projections at
   their existing checkpoints. Apply their returned aggregate records through the shared rules.
6. Catalog and validate the artifact set, disclose surgical-reopen changes, consume the reopen,
   finish validation and consume the generation intent. Retain the generation publication before
   its native persistence fills the accepted record reference.
7. Update usage/history and save through the unchanged native transaction and recovery path.

Receipt fields, property order, optional observations and cloning/reference behavior are retained.
The receipt schema version comes from the native schema owner as an explicit fact. Code delivery
still starts at `pending-tests`, with no test execution or commit invented by construction.
Existing planned claims, previous publication generations, human decisions and history remain
untouched. Numeric/string generation comparison remains specific to publication retention; other
record families retain their previous equality and sorting rules.

Sixteen fixtures captured from `78ba9c774` compare complete serialized record/aggregate hashes.
Four original object expressions are also fingerprinted. Additional tests cover reference
identity, historical records, surgical reopen, infrastructure-free execution and native admission,
clock, write and persistence ordering. These checks complement actual CLI/SDK publication and
native evidence journeys; fixtures alone do not prove transaction safety or authority.

This is a Phase 5 prerequisite for portable lifecycle writers. The remaining native policy,
source-control observations, transaction writer and external-effect reconciliation still need
their own boundaries. A namespace document projection is not lifecycle authority, and these
helpers do not migrate existing projects or permit dual writers. Phase 7's portable lifecycle
writer and Phase 8's verified authority cutover remain unfinished.

Mac qualification on Node 26.12.0 passed 315 checks across 24 files, with no failures, skips or
cancellations. This includes source/bundled CLI and SDK publication, submission, approval and
rejection, code delivery, AST, clarification, artifact-set retention and the installed SDK archive.
One stale source-location guard was updated to inspect the extracted publication/approval owners
while keeping its bundle-binding and ordering assertions; the final full run passed.
Source validation passed 3,708 checks; VS Code typechecking, all 13 unchanged bundle budgets,
the Git ownership audit (2,011 sites) and whitespace checks passed. The gateway remains at
852 modules / 6,788,425 bytes. All test repositories, remotes and machine state are isolated.
No Windows, hosted CI, live provider, install, merge, push or real-project mutation ran.
