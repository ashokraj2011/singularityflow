# Clause-driven specifications

- Status: approved for phased implementation
- Decision date: 2026-08-05
- Decision owner: Singularity Flow maintainers
- Baseline: `main@56c2511`
- Normative language follows RFC-style uppercase key words inside anchored clauses.

## Decision

Singularity Flow will make approved specification prose addressable through stable clause IDs while preserving Markdown as the authoring format. [SDS:CON-001]

Phase artifacts and their exact bundle hashes remain the approval authority; clause indexes, claims, test bindings, and change-request scopes add deterministic traceability and surgical invalidation without creating a second source of truth. [SDS:CON-002]

The lifecycle branch remains operational authority, local context only selects it, and every mutation continues through the existing deterministic publication transaction. [SDS:CON-003]

This decision introduces no formal specification language, no spec-generates-code promise, and no claim that deterministic coverage proves semantic correctness. [SDS:CON-004]

## Outcomes

Each active requirement, behavior, interface, acceptance criterion, and constraint in a specification artifact MUST have a stable clause ID. [SDS:REQ-001]

Singularity Flow MUST be able to answer which clauses were planned, changed, tested, approved, rejected, deviated from, or left without evidence. [SDS:REQ-002]

Deterministic indexing, coverage, integrity, and trace assembly MUST run without a model. [SDS:REQ-003]

Semantic conformance remains a governed agent or human judgment, but that judgment MUST be recorded against individual clause IDs and exact evidence. [SDS:REQ-004]

## Clause identity and namespace allocation

A clause ID has the form `[<namespace>:<kind>-<ordinal>]`, where `kind` is `REQ`, `BEH`, `IFC`, `AC`, or `CON`, and `ordinal` is a zero-padded three-digit number. [SDS:REQ-010]

Namespaces and clause kinds MUST match `[A-Z0-9][A-Z0-9._-]*` and `REQ|BEH|IFC|AC|CON` respectively; the complete anchor therefore matches `\[[A-Z0-9][A-Z0-9._-]*:(REQ|BEH|IFC|AC|CON)-[0-9]{3}\]`. [SDS:REQ-011]

Parent Initiative or Epic clauses MUST retain their parent namespace when pinned into a Story so cross-Story lineage never rewrites identity. [SDS:REQ-012]

Story-local clauses MUST use the immutable Work ID as their namespace. [SDS:REQ-013]

Capability namespaces MAY be used only by approved reusable capability specifications whose allocator is the capability-map authority; ordinary Stories cannot allocate IDs in a capability namespace. [SDS:REQ-014]

An allocator MUST reject duplicate `(namespace, kind, ordinal)` values and MUST issue the next unused ordinal without renumbering existing clauses. [SDS:REQ-015]

Once its containing artifact is approved, a clause ID is immutable; removal changes its status to `withdrawn`, while replacement receives a fresh ID. [SDS:REQ-016]

## Markdown grammar

The extractor MUST ignore anchors inside fenced code blocks, inline code, HTML comments, and the managed metadata or managed-input blocks written by Singularity Flow. [SDS:REQ-020]

A clause is one Markdown heading, paragraph, or list-item block containing exactly one anchor at the end of its first sentence or heading. [SDS:REQ-021]

Continuation lines belong to the same clause block until the next Markdown block at the same structural level; exact start and end lines MUST be recorded. [SDS:REQ-022]

One clause block MUST NOT contain another clause anchor, and an anchor outside a recognized clause block is malformed. [SDS:REQ-023]

Unanchored explanatory prose is allowed, but normative prose containing MUST, SHOULD, or MAY MUST carry a clause anchor. [SDS:REQ-024]

Clause metadata MAY be supplied by one immediately following fenced `clause` YAML block, and no other prose may intervene. [SDS:REQ-025]

The only P1 metadata keys are `status`, `dependsOn`, and `tests`; unknown keys MUST fail validation rather than being silently discarded. [SDS:REQ-026]

Clause status MUST be `active` or `withdrawn`, defaulting to `active` when omitted. [SDS:REQ-027]

Dependencies MUST be full clause IDs, MUST resolve in the pinned indexes available to the subject, and MUST form an acyclic graph. [SDS:REQ-028]

Test bindings MUST use the structured grammar shown below and MUST reference a configured command ID rather than embedding an arbitrary shell command. [SDS:REQ-029]

````markdown
The service rejects an expired order before reserving inventory. [ORDER-142:BEH-003]

```clause
status: active
dependsOn: [ORDER-142:REQ-001]
tests:
  - path: test/orders.test.mjs
    name: rejects an expired order
    command: node-unit
    expectedBefore: red
```
````

## Deterministic clause index

`sflow spec index [<artifact>]` MUST extract clauses locally and write a canonical index for the artifact's current phase generation. [SDS:REQ-030]

Story indexes MUST be stored at `singularity/work-items/<WORK-ID>/context/spec-indexes/<phase>-gen<N>.json`, and Initiative indexes MUST use the corresponding Initiative context directory. [SDS:REQ-031]

`artifactPath` MUST be a repository-relative POSIX path, so identical bytes at different governed paths intentionally produce different indexes. [SDS:REQ-032]

The index schema MUST contain `schemaVersion`, subject identity, phase, generation, `artifactPath`, `artifactSha256`, `clauses`, and `indexSha256`. [SDS:REQ-033]

Each indexed clause MUST contain `id`, `namespace`, `kind`, one-based start and end lines, nearest heading, exact text, normalized status, dependencies, test bindings, and `contentSha256`. [SDS:REQ-034]

`contentSha256` MUST hash the clause block plus its `clause` metadata block after UTF-8 decoding, CRLF-to-LF normalization, removal of trailing horizontal whitespace, and exactly one terminal LF. [SDS:REQ-035]

Canonical JSON MUST use lexicographically sorted object keys, clauses sorted by ID, arrays preserved where order is semantic, UTF-8 encoding, and no insignificant whitespace. [SDS:REQ-036]

`indexSha256` MUST hash the canonical JSON object with the `indexSha256` member omitted; the completed object is then serialized canonically. [SDS:REQ-037]

The same artifact bytes at the same governed path and subject revision MUST produce byte-identical indexes. [SDS:REQ-038]

Indexing MUST fail for malformed or duplicate anchors, invalid metadata, dangling dependencies, cyclic dependencies, missing test paths, or an artifact hash that changes during extraction. [SDS:REQ-039]

## Pinning and authority

An upstream parent, Epic, or Initiative specification supplied in a Story seed MUST be indexed and pinned when the Story starts. [SDS:REQ-040]

A Story-local implementation specification does not exist at Story start and MUST instead be indexed and pinned when its implementation-spec or fix-spec generation is approved. [SDS:REQ-041]

Every downstream generation record MUST name the exact spec artifact hash and index hash it consumed. [SDS:REQ-042]

An index is a deterministic projection of an approved artifact and MUST NOT authorize a lifecycle transition by itself. [SDS:CON-010]

Changing a specification artifact always invalidates its prior phase-bundle approval; this decision does not introduce partial phase approval. [SDS:CON-011]

## Planned and observed claim maps

Implementation-spec and fix-spec outputs MUST include a planned claim map before implementation begins. [SDS:REQ-050]

Implementation publication MUST create or update an observed claim map that records the evidence actually present in the submitted source range. [SDS:REQ-051]

Claim maps MUST be stored under the subject context directory as `claims/<phase>-gen<N>-planned.json` and `claims/<phase>-gen<N>-observed.json`. [SDS:REQ-052]

Both maps MUST contain `schemaVersion`, subject identity, phase, generation, spec artifact and index hashes, source base and target commits, timestamps, actor and agent identity, and claims sorted by clause ID. [SDS:REQ-053]

A planned claim MUST contain a clause ID, expected paths, expected test bindings, and optional approved-deviation reference. [SDS:REQ-054]

An observed claim MUST contain a clause ID, observed paths, test-result references, commit references when available, and one verdict of `matched`, `partial`, `missing`, `deviated`, or `unplanned`. [SDS:REQ-055]

Claims are authored evidence rather than verified truth, so governance MUST reconcile them against the pinned index, source range, test evidence, and current artifact hashes. [SDS:CON-012]

Flow-generated lifecycle publication commits for claim-bearing phases MUST include `Singularity-Work-ID: <id>` and one `Singularity-Spec-Clause: <id>` trailer for each claimed clause. [SDS:REQ-056]

Ordinary developer commits MAY omit clause trailers; their absence is not a failure when the observed claim map and exact review packet bind the complete source range. [SDS:CON-013]

When trailers are present, `sflow spec trace` MUST reconcile them with the observed claim map and report mismatches. [SDS:REQ-057]

## Coverage boundary and arithmetic

Every coverage calculation MUST record an immutable base commit, target commit, and governed path policy in its output. [SDS:REQ-060]

The implementation base defaults to the Story source commit recorded at start, while the target is the exact source commit in the current review packet; configuration MAY select the last approved implementation generation as a later base. [SDS:REQ-061]

The path policy MUST define included roots and explicit exclusions for generated, vendor, binary, fixture, and documentation paths. [SDS:REQ-062]

Renames MUST be evaluated as one moved path retaining both old and new names, deletions MUST remain observable evidence, and binary changes MUST be reported without pretending to provide hunk-level evidence. [SDS:REQ-063]

P1 coverage is path-granular; `path#section` references MAY enrich evidence but MUST NOT be used as a hard hunk-level completeness gate until a language adapter proves them deterministically. [SDS:CON-014]

Coverage MUST calculate `unimplemented` active `REQ|BEH|IFC|CON` clauses with no observed claim, `unclaimed` included changed paths in no observed claim, and `withdrawnButClaimed` claims against withdrawn clauses. [SDS:REQ-064]

Acceptance criteria are accounted for through bound-test and conformance evidence and MUST NOT be counted a second time as implementation-path coverage. [SDS:CON-015]

`spec.coverage` MUST support `off`, `warn`, and `enforce`, defaulting to `warn` for newly initialized repositories. [SDS:REQ-065]

Conformance MUST render every indexed clause with its claim, source and test evidence, deviation, and verdict instead of comparing an undifferentiated specification with an undifferentiated diff. [SDS:REQ-066]

## Executable acceptance

Workflow configuration MUST define an allowlisted `spec.testCommands` registry whose entries contain command argv, working-directory policy, timeout, and result adapter. [SDS:REQ-070]

Artifact-authored metadata MUST reference only command IDs from that registry and cannot add shell fragments, environment secrets, or executable arguments. [SDS:CON-020]

`expectedBefore` MUST be `missing`, `red`, `green-existing`, or `not-applicable`, with a required reason for `not-applicable`. [SDS:REQ-071]

A `red` precondition is satisfied only by an adapter-classified assertion failure; timeout, missing runtime, permission failure, infrastructure error, or an unrelated failing test MUST block as an environment failure. [SDS:REQ-072]

A `green-existing` binding MUST pass before implementation and after verification, allowing regression and refactoring work without fabricating a failing test. [SDS:REQ-073]

A `missing` binding MUST be absent before an approved scaffold or implementation generation creates it. [SDS:REQ-074]

`spec.acceptance` MUST support `off`, `presence`, `test-first`, and `verify`; `presence` validates paths and names, `test-first` validates declared preconditions, and `verify` requires all applicable bindings to pass at the exact submitted source commit. [SDS:REQ-075]

Test execution MUST run with configured timeouts and bounded output, record command ID and source SHA, redact configured secrets, and never run automatically from read-only status or review rendering. [SDS:REQ-076]

`sflow spec acceptance scaffold` MAY create reviewable test skeletons, but generated source remains ordinary code subject to the normal lifecycle and publication policy. [SDS:CON-021]

## Clause-scoped composition

The phase-input schema MUST gain an explicit clause selector rather than implying that the current whole-artifact input mechanism already supports sections. [SDS:REQ-080]

The selector MUST identify a source phase, pinned index, claim-map source, dependency traversal policy, and a `whole|error` fallback. [SDS:REQ-081]

```yaml
inputs:
  - phase: implementation-spec
    selector:
      kind: clauses
      claims: planned
      includeDependencies: true
      fallback: whole
```

Implementation composition SHOULD inject planned claimed clauses, their transitive dependencies, and the minimum approved design evidence referenced by those clauses. [SDS:REQ-082]

When no valid planned claim map exists, the safe default MUST be whole-spec injection rather than an inferred code-graph blast radius. [SDS:CON-022]

Every composed prompt record MUST list selected and omitted clause IDs, source index hashes, fallback decisions, and rendered-block hash. [SDS:REQ-083]

Verification and conformance composition MUST use observed claims and must retain the complete evidence ledger required to detect unplanned changes. [SDS:REQ-084]

## Governed change requests and scoped rework

The existing append-only `CR-nnn` record MAY carry `clauseIds`; absence means the entire rejected target phase is in scope. [SDS:REQ-090]

Every requested clause ID MUST exist in a pinned index available to the rejected subject revision. [SDS:REQ-091]

Targeted regeneration MUST address each selected `CR-nnn` and clause ID explicitly, while non-target clause content hashes remain unchanged. [SDS:REQ-092]

Unanchored explanatory prose outside protected clause blocks MAY change during targeted regeneration, but the review MUST disclose those changes. [SDS:CON-023]

Resolving a change request MUST record the replacement artifact and index hashes, regenerated clause IDs, untouched clause hashes, actor, agent, and resolution timestamp. [SDS:REQ-093]

Changing or withdrawing a clause MUST invalidate downstream phases only where planned or observed claims transitively depend on that clause; the changed producer artifact still requires a fresh exact-bundle approval. [SDS:REQ-094]

## Lifecycle, ledger, and offline trace

Lifecycle events for indexed specifications, claims, acceptance results, change requests, and conformance MUST carry explicit typed payloads rather than deriving type from commit-message text. [SDS:REQ-100]

`verify-transition` MUST reject a claim whose clause ID is absent from the exact pinned index or whose index no longer matches the approved artifact. [SDS:REQ-101]

The operational lifecycle state remains authoritative, while the state branch and ledger remain proof and cross-repository mirrors. [SDS:CON-030]

`sflow spec trace [<clause-id>]` MUST assemble parent specification, design evidence, planned and observed claims, source commits, tests, approvals, change requests, and ledger events. [SDS:REQ-102]

Offline trace from a fresh clone MUST succeed after fetching the subject lifecycle branch and any explicitly recorded parent or capability specification refs; remote Jira, CI, or storage observations are optional evidence and cannot replace missing Git authority. [SDS:REQ-103]

Trace output MUST support human, JSON, and CSV formats and identify missing or stale evidence rather than silently omitting it. [SDS:REQ-104]

## Jira synchronization

Repository clause indexes remain authoritative when Jira acceptance criteria differ from governed Git artifacts. [SDS:CON-040]

Jira synchronization MUST use an exact reviewed write plan that lists clause IDs, target issues and fields, source artifact and index hashes, and expected remote versions. [SDS:REQ-110]

Jira drift MUST be recorded as an observation and require an explicit choice to adopt it into a new artifact generation or restore Git-owned fields through a new reviewed write plan. [SDS:REQ-111]

The system MUST NOT perform silent bidirectional overwrite or treat Jira text as a competing lifecycle state store. [SDS:CON-041]

## VS Code experience

VS Code SHOULD show a clause review table with kind, status, text, dependencies, claims, tests, verdict, change requests, and exact approval state. [SDS:REQ-120]

Reviewers SHOULD be able to select clauses when sending a phase back, while retaining a clear whole-phase option. [SDS:REQ-121]

The review surface MUST distinguish exact phase-bundle approval from clause-scoped review and invalidation so it never presents partial review as an independently approved artifact. [SDS:REQ-122]

Completed-work views SHOULD preserve the per-clause trace, approval history, self-approval warnings, and source/test evidence. [SDS:REQ-123]

## Security and limits

Clause extraction MUST impose configurable artifact, clause-count, metadata, dependency-depth, and rendered-context limits with bounded defaults. [SDS:REQ-130]

Injected clause prose is untrusted evidence and MUST remain subordinate to the active phase contract, governed agent instructions, and repository safety policy. [SDS:CON-050]

Paths from metadata MUST pass the existing repository-containment guard and cannot escape the governed repository. [SDS:REQ-131]

Indexes and claim maps MUST be integrity-checked before publication and governance, and a mismatch MUST block in enforce mode. [SDS:REQ-132]

## Delivery plan

P1 MUST deliver grammar, namespace allocation, templates, index schema, `sflow spec index`, deterministic quality gates, and fixtures without changing lifecycle-state schemas. [SDS:REQ-140]

P2 MUST deliver planned and observed claim maps, exact coverage boundaries, warning-mode coverage, typed lifecycle payloads, per-clause conformance, and trace v1. [SDS:REQ-141]

P3 MUST deliver the allowlisted acceptance runner, precondition adapters, result evidence, scaffold command, and enforceable acceptance modes. [SDS:REQ-142]

P4 MUST deliver clause selectors, prompt audit records, token measurements, `CR-nnn` clause scopes, and targeted regeneration integrity. [SDS:REQ-143]

P5 MAY deliver dependency-cone invalidation after the earlier phases are stable, but it MUST use a deliberate schema break with factory reset and fresh Stories rather than a migration framework that this development line does not have. [SDS:REQ-144]

P1 is estimated at three to five focused engineering days, P2 at one to two weeks, P3 at one week, P4 at one to two weeks, and P5 at one to two weeks. [SDS:CON-051]

## Acceptance criteria

The P1 extractor double-indexes this document and every synthetic kind fixture to byte-identical canonical output, rejects every invalid grammar fixture, and reports no duplicate live anchors. [SDS:AC-001]

A feature Story can produce a planned map before implementation, an observed map at submission, zero unexplained governed source paths, and an offline end-to-end trace from a fresh clone. [SDS:AC-002]

Executable acceptance distinguishes expected red tests from infrastructure failure and verifies applicable tests against the exact submitted commit. [SDS:AC-003]

Clause-scoped composition records a lower measured input-token count than whole-spec composition on the same fixture without omitting dependencies or evidence needed by verification. [SDS:AC-004]

A `CR-nnn` targeting one clause regenerates that clause, preserves every untouched clause content hash, obtains fresh bundle approval, and reopens only downstream phases whose claims intersect the invalidated dependency cone. [SDS:AC-005]

The VS Code review experience never labels clause selection or a self-approval as independent exact-bundle approval. [SDS:AC-006]

## Deferred decisions

Language-aware hunk and symbol coverage is deferred until a deterministic adapter demonstrates stable identities across refactors. [SDS:CON-060]

Independent clause approval is deferred; this decision intentionally keeps exact phase-bundle approval as the only approval that advances lifecycle state. [SDS:CON-061]

Automatic code-graph fallback for composition is deferred because whole-spec fallback is safer until graph freshness and completeness are governed. [SDS:CON-062]
