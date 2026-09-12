# Persisted World-Model views

**Status:** W0/W1 persistence preview and a bounded W2 deterministic-view slice implemented; the
full WMP release remains staged

This document is the implementation companion to `SPEC-persisted-worldmodel-views.md`. It records
the amendments required by the current WMB v4 code so that persistence extends the existing
state-branch authority instead of creating a second World-Model authority.

## Target product outcome

An exact registered-v4 World Model is built once, retained on the configured state branch, and
reused by later Stories, worktrees, and clones. Saved deterministic views are readable without a
model call, extraction, AST query, Git fetch, cache fill, or source checkout. The current
`singularity/world-model` projection remains available for compatible readers.

## Accepted amendments

1. **One authority and one CAS.** Atomic publication means one state-branch commit followed by one
   revision-checked ref update. The current projection is replaceable; immutable history is
   additive in the same commit. Guarded source refs are observations, not a multi-ref transaction.
2. **Disjoint roots.** The current projection defaults to `singularity/world-model`; history
   defaults to `singularity/world-model-history`. Equal, ancestor, descendant, traversal, absolute,
   backslash, case-colliding, and unsafe portable forms are refused.
3. **Frozen identities.** WMP content-addressed record families start at v1 and use frozen identity.
   A future incompatible shape creates a new identity/version contract; migration never silently
   changes a self-hashed historical object.
4. **Strict bytes and owners.** New history readers require bounded UTF-8, canonical JSON, exact
   raw-byte length/digest, closed fields, semantic self-hash validation, and the installed owning
   record validator. MIG readability is not semantic admission. Model/view admission currently
   fails closed when repository-domain, extraction-policy, extractor-registry, completeness-record,
   consumer-profile, output-budget, view-validation-receipt, renderer-contract,
   validator-contract, or an applicable tokenizer owner is unavailable. Deferred
   grounding/handoff/adoption paths additionally require publication-receipt, admission-proof,
   source-authority, origin-authority, target-authority, and adoption-authorization owners. This
   boundary also rejects duplicate JSON keys because duplicate-key JSON cannot equal the canonical
   re-encoding.
5. **Portable repository subject.** WMP history is admitted only when the build has an exact
   governed capability/repository subject. A checkout basename or credential-bearing remote URL is
   not portable authority. Standalone local-repository domain enrollment remains a prerequisite,
   not an inferred identity.
6. **No fabricated completeness.** Existing v4 facts, ledgers, source/scope snapshots, and
   validation receipts are retained exactly. Aggregate path outcomes are published only when an
   extractor-owned completeness record proves them; missing domains remain explicit gaps.
7. **Stable payload versus compatibility envelope.** Deterministic view payload bytes exclude
   clocks, actor labels, machine paths, and invocation IDs. The existing timestamped v4 Markdown
   envelope remains separately verified for compatibility.
8. **Scoped aliases.** `business`, `architecture`, `development`, `security`, and `testing` are WMP
   presentation aliases only. Existing registered-v4 IDs and workflow configuration are not
   reinterpreted.
9. **Reads never prepare.** History/show/replay reads do not fetch, build, render a missing view,
   invoke a model, run AST, execute tests, write a cache, or publish. A typed miss returns the
   explicit preparation action.
10. **Recovery preserves intent.** A lost response may prove either the exact candidate commit or
    an independently published byte-identical winner. An unrelated authority advance requires a
    new successor plan; the old recovery record is never blindly replayed.

The supplied draft repeated the `inputObjects` row and `WMP:AC-001`; those duplicates have no
additional normative meaning. Public commands use `singularity-flow`/`sflow` equivalently, while
`--format` continues to select the storage pipeline and `--output-format` selects rendered output.

## Implemented boundary

The current increment is deliberately usable as an exact, read-only persistence foundation rather
than being wired into every Story path prematurely:

- all six draft WMP envelope families are registered as frozen v1 identities, have strict closed
  structural/self-hash validators and schemas, and use migration-registry schema versions;
- exact model/view keys, canonical raw-byte ingestion, portable disjoint paths, bounded retained
  closures, and create-if-absent staging are implemented;
- the existing state writer can commit the compatible current projection and immutable history in
  one CAS without dropping existing exact-blob checks;
- publication recovery now binds and verifies the history additions as well as the replaceable
  projection, including byte-identical concurrent winners and unrelated-state-change refusal;
- exact historical source reads use locally available Git objects at an explicit full revision,
  disable lazy fetching and credential prompts, and never switch the checkout;
- migration readiness inventories keyed model, view, and handoff bindings from the exact locally
  materialized state-authority ref, without fetching or substituting an unpublished local branch;
  content-addressed objects remain the responsibility of their binding's semantic closure reader;
- five model-free overview contracts and pure full/brief Markdown or JSON rendering are available;
- `wm history list --authority-commit <full-commit>` pages exact key paths with a continuation
  cursor bound to the authority cut, kind selection, history root, and page size, while `show`
  verifies the selected binding and complete semantically owned closure. Both prove that the cut is
  reachable from the configured state-authority ref and never fetch, build, invoke a model/AST,
  write a cache, or change Git. A configured remote never falls back to an unpublished local state
  branch.

The increment does **not** make a current WMB build emit a reusable WMP model binding yet. Model
admission requires truthful semantic owners for the repository-domain, extraction-policy,
extractor-registry, and completeness-record roles. View admission additionally requires
consumer-profile, output-budget, and view-validation-receipt adapters, retained renderer/validator
implementation contracts, and an exact tokenizer owner whenever token measurement is asserted.
Deferred grounding, handoff, and adoption require their publication-receipt, admission-proof,
source-authority, origin-authority, target-authority, and adoption-authorization owners as
applicable. The source specification references these roles
but does not define every durable family or a valid mapping to an existing owner. Reusing an unrelated
record under a convenient role would create a syntactically valid but false proof. This document
therefore amends the rollout: add or explicitly extend those owner contracts first, then connect the
build, lookup, Story grounding, handoff, and UI paths.

## Delivery boundary

| Increment | Current status | Included behavior |
|---|---|---|
| W0 | Persistence preview implemented | Strict identities, object references, six registered record contracts, portable paths, and canonical-byte tests. Semantic owner contracts named above remain a prerequisite to production binding emission. |
| W1 | Persistence foundation implemented | Direct exact-key state-history reads; create-if-absent publication expectations; additive history plus compatible current projection in one CAS; history-bound recovery. Full model/view admission remains fail-closed until every semantic owner is installed. |
| W2 | Partial | Five model-free overview contracts, stable full/brief renderers, and exact history inspection are implemented. The structural grounding preview exists, but its frozen v1 shape cannot represent the full composition identity; a compatible successor contract, lifecycle emission, and exact packet replay are not yet enabled. |
| W3 | Deferred | Incremental parse/derivation reuse and verified private-candidate handoff/adoption. |
| W4 | Deferred | Legacy inventory/cutover, supported-platform evidence, capacity benchmarks, UI explorer, and release qualification. |

Only behavior backed by its runtime tests is advertised. W0-W2 do not claim foreign-candidate
continuation, complete incremental extraction, physical Windows/macOS/Linux qualification, or all
36 release criteria. World-Model or AST absence remains non-blocking for workflows whose policy does
not explicitly require a persisted domain.

## Storage contract

```text
singularity/world-model/                         compatible current projection
singularity/world-model-history/models/<64>.json immutable model bindings
singularity/world-model-history/views/<64>.json  immutable view bindings
singularity/world-model-history/objects/sha256/<2>/<64>
singularity/world-model-history/handoffs/<64>.json
```

Every history path uses the complete lowercase SHA-256 hex value. Existing identical bytes are a
reuse winner. Existing different bytes at the same path are `WMP_IDENTITY_CONFLICT`; they are never
overwritten. History paths cannot be placed in a replacement or deletion root.

The first foundation release caps each record/object at 32 MiB, one staged history addition set at
64 MiB, and the complete projection-plus-history recovery payload at 96 MiB inside the existing
128 MiB immutable recovery sidecar. These stricter owner limits intentionally win over the draft's
proposed 256 MiB closure ceiling until a streaming/reference recovery format is reviewed.

## Release evidence still required

- Production build-to-binding construction after the missing repository-domain, extraction-policy,
  extractor-registry, completeness-record, consumer-profile, output-budget,
  view-validation-receipt, renderer-contract, validator-contract, and applicable tokenizer owner
  contracts are resolved; grounding/handoff/adoption also require publication-receipt,
  admission-proof, source-authority, origin-authority, target-authority, and
  adoption-authorization owners.
- Exact-key lookup before extraction and reuse from Story start/grounding preparation.
- Before enabling saved-view publication or reads, cryptographically connect each view binding's
  model-payload and selected-ledger identity to one accepted model binding and its retained source
  Fact Ledger; individual valid closures are not sufficient proof that the two graphs belong
  together. The same gate must correlate scope and prove that the validation receipt's candidate
  digest is the exact rendered object. Publication must apply these cross-record checks to the
  combined existing-plus-staged authority graph, not validate records only in isolation.
- Define a compatible grounding contract that binds expansion handles, ordering/separators, and
  packet-composer identity; then add Story grounding-record emission, packet replay, and the
  persisted-view IDE/FWM adapters. The frozen structural v1 preview is not sufficient for this.
- Handoff/source-adoption services, approval path, and cross-machine continuation.
  Candidate continuation must also prove the candidate snapshot revision and authority scope are
  the exact revision and scope named by its Source Binding. The adoption service must derive its
  object-closure digest from verified transferred objects rather than trust a supplied digest.
- Incremental parse/derivation reuse and its invalidation matrix.
- A native VS Code history/view explorer over the same read-only service.
- Concurrent same-key and different-key builders across independent clones.
- Cross-platform fault-matrix qualification of lost-response and restart recovery for transactions
  containing history additions.
- Fresh-clone, empty-cache saved reads with network/model/AST/write tripwires.
- Exact Story grounding replay after current source, policy, renderer, and reports change.
- Foreign Candidate source adoption and incomplete handoff refusal.
- Real Windows long-path/case behavior, macOS, Linux, archive capacity, and performance evidence.
