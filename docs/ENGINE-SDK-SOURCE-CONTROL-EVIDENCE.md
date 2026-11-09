# Accepted source-control evidence

`phase.source-control.retain` conditionally accepts actual origin observations for an already-retained
authored generation. It uses the same Engine registry as the existing operations. The optional
`hosts/namespace-source-control` factory and main `hosts/namespace-engine` composition expose that
one operation; neither selects a checkout, Git binary, storage implementation or approval identity.

```js
const result = await engine.run('phase.source-control.retain', {
  operationId: 'retain-current-origins', workId, phaseId
});
```

New collection requires the machine-private draft and explicit `sourceControlReaders`. The existing
`phase.source.retain` authority grants this evidence write. Reader capabilities and permissions are
constructor bindings; operation inputs cannot supply observations, paths, commands or readiness.

## Evidence and authority

The current generation must first have an accepted `phase.source.retain` result for the exact
draft, artifact, configuration and canonical Story revision. If missing, the error names that
registered operation, its known Story/phase inputs and the required new operation identity. An
independent read-only reviewer cannot act as the configured phase author.

Each observation binds its Story, phase, generation, immutable generation-intent identity, selected
repository, source descriptor and actual source-control reader descriptor. The kernel verifies
baseline application content against the accepted source binding and current source against the
retained file snapshot. It also checks change-set/entry identities, complete application-content
path coverage, regular-file contents, endpoints, ordering and committed/index/worktree/untracked
coverage. Filesystem executable bits and repository file modes remain distinct observations.

The initial verifier supports `git-selected-worktree-change-set/v1`. Its ordinary baseline file
contents must match the accepted baseline's raw application bytes. A checkout that applies content
conversion needs a separately specified normalization/profile owner; this verifier does not silently
rewrite those bytes or claim support for such a profile. Unknown profiles need their own verifier.

Preparation retains immutable observation metadata and an intent. Final acceptance conditionally
checks the authority epoch, Story/configuration revisions, exact accepted source result and source
index, and the evidence index's prior revision. Source-control facts, draft identity, author identity
and permissions are rechecked before acceptance. A changed source receipt or capture cannot be
silently attached to the earlier intent. The caller preserves it and selects a new explicit operation
for changed intent; restoring the original state or a transient permission/storage repair can resume
the original operation in the same phase.

The record contains hashes and relative source metadata, without uploading local document/image
contents. Actual changed source bytes stay in the separately accepted source archive. Observations
are retained as evidence metadata; this operation does not create a source commit, publish a phase,
run tests, satisfy an acceptance criterion or record human approval. Native installed Git behavior,
record formats, code-delivery requirements and lifecycle authority remain unchanged.

## Retry and takeover

The shared proof reader verifies original conditional receipts, the complete accepted source and
generation chain, observation bytes/digests and result/index bindings. A raw JSON body or a matching
blob hash alone is insufficient. Another laptop can acknowledge the original accepted receipt under
the original authenticated person without the old checkout, local draft, Git reader or a new clock
value. A different person cannot adopt that acknowledgement by supplying the old operation ID.

Unknown write outcomes preserve their actual error. Retrying first reconciles the operation receipt;
it does not recapture or restamp an already accepted result. Concurrent identical requests converge
on one accepted record. Fencing blocks new writes while permitting verification of historical
accepted receipts. Missing evidence, unsupported records and real storage errors remain explicit.

This closes the conditional source-control evidence slice. Publication still requires the complete
code, claims, constitution, artifact-set and other applicable policy owners; the primary-document
publisher continues to refuse those unsupported obligations. The complete application Story and
remaining Phase 5, 7, 8 and 9 gates retain their original scope.

## Mac qualification

Node 26.12.0 passed 92 affected regression cases, including all 18 new control-acceptance cases,
the existing source/baseline archives and delivery inspection, real Git captures and the independent
native change-record oracles. All 69 architecture cases and 27 installed offline SDK-package checks
passed. The final suites had no failures, cancellations or skips. Coverage includes all three
metadata backends, two selected repositories, real renames, local-upload privacy, revoked author
permissions, reader/source/Git drift, concurrent requests, fencing, lost acknowledgements and
checkout-free takeover. The installed consumer uses only exported SDK entries and an
application-owned SQLite connection; it has an empty `PATH` and no original checkout.

The first fixture reused one field for authorization state and capture counters; separating those
fields made the authority fault cases exercise the actual access binding. The first installed
consumer also requested an internal SQLite helper; it now constructs its own host connection.
Neither correction relaxed a production gate. Shared change-set version admission now uses one
foundation metadata owner, with unchanged native family metadata, path ownership and v1 errors.

Source validation passed 3,943 checks across 191 skills. VS Code typechecking, the unchanged
2,011-site Git ownership audit and all 13 unchanged bundle budgets passed. Gateway/extension/Help/
support/prewarm remain 852/152/135/111/23 modules. The optional SDK has 57 registered operations,
183 owned modules and 1,793,717 JavaScript bytes. No Windows, hosted CI, live provider, product
installation, real Story mutation, merge or push was performed. These are component results;
full application execution, existing-project migration and final qualification remain required.
