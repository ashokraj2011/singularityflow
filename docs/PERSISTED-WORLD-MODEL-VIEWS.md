# Persisted World-Model views

**Status:** W0/W1 persistence, governed repository-identity proof, exact pre-extraction
key/lookup, build-to-binding staging, exact-manifest terminal extraction outcomes, a pure
completeness bridge, and a bounded W2 deterministic-view slice are implemented; production
model/view emission and reuse remain disabled pending service/state-transaction integration and
the remaining proof owners

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
   raw-byte length/digest, closed fields, semantic self-hash validation, and the installed
   historical-shape owner for that frozen family. Current-runtime admission remains a separate
   check before an extractor can execute; upgrading an installed extractor cannot invalidate
   already admitted history. Registered-v4 execution now has an explicit exact-manifest terminal
   outcome capture path, but that opt-in observation is not yet a production publication authority
   and ordinary registration does not allocate it. MIG readability is not
   semantic admission. Frozen v1 owners now
   exist for repository-domain, extraction-policy, extractor-registry, completeness-record,
   consumer-profile, output-budget, and view-validation-receipt records. Model admission also
   verifies their exact cross-record graph. A governed action-bound repository resolver and a
   pre-extraction build/lookup adapter now provide the code-local construction boundary, but they
   are not wired into production WMB publication. View admission
   additionally remains fail-closed without retained renderer/validator contracts, an applicable
   tokenizer owner, model-to-view/selected-ledger correlation, and rendered-budget validation.
   Deferred grounding/handoff/adoption paths additionally require publication-receipt,
   admission-proof, source-authority, origin-authority, target-authority, and
   adoption-authorization owners. This boundary also rejects duplicate JSON keys because
   duplicate-key JSON cannot equal the canonical re-encoding.
5. **Portable repository subject is a production invariant.** The repository-domain record is a
   portable semantic identity, while authorization is proved separately at each action boundary.
   The implemented resolver derives the subject from the explicit lifecycle Capability and its
   approved configuration or the Story's immutable accepted WFA policy snapshot, proves that the
   selected delivery Capability owns the checkout repository, verifies the approved portfolio and
   exact checkout origin, and returns only portable digest identities. Its sealed proof is
   deliberately short-lived and is re-resolved offline before a lookup or staged construction; it
   never fetches policy and is never retained as reusable permission. A checkout basename or
   credential-bearing remote URL is not authority.
   Standalone local-repository domain enrollment remains explicit, not inferred.
6. **No fabricated completeness is a production invariant.** The registered-v4 extraction capture
   path records a truthful terminal outcome for every path in the exact selected source snapshot,
   including a successful zero-fact extraction, and the pure completeness bridge refuses missing or
   mismatched outcome coverage. It currently reports zero excluded paths because the selected
   snapshot cannot prove which discovered candidates policy excluded. Excluded-path accounting
   remains disabled until an owned full candidate roster exists; missing domains remain explicit
   gaps.
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
- frozen v1 semantic owners are installed for repository-domain, extraction-policy,
  extractor-registry, completeness-record, consumer-profile, output-budget, and
  view-validation-receipt records;
- model-binding admission validates the exact repository/source/scope/policy/registry/profile,
  completeness/evidence/fact/derivation graph, including exact source-path and content-digest
  accounting, before a retained graph may be staged;
- extraction profiles reconstruct their parse-schema identity from the complete retained extractor
  tuple and use a frozen exact-byte/path normalization contract; opaque substitute digests are not
  admitted;
- extractor registries are bounded to 1,024 manifests and graph admission uses indexed identity
  and manifest lookups;
- current executable registered-v4 adapters expose an explicit deterministic terminal-execution capture against their
  exact installed manifest and implementation identity, including successful zero-fact paths and
  explicit unsupported, partial, and failed outcomes; ordinary registration defaults this capture
  off, and future production integration must enable it explicitly, to avoid an unused
  extractor-by-path allocation;
- a pure completeness bridge verifies every selected source path and digest, exact extractor
  identity, global extractor outcome, and required subject outcome before constructing the frozen
  completeness record; a sealed execution receipt binds its source, scope, registry, extractor
  executions, View Contracts, and View Fact Ledgers; the bridge emits no excluded outcomes, so
  `counts.excludedPaths` is zero;
- exact model/view keys, canonical raw-byte ingestion, portable disjoint paths, bounded retained
  closures, and create-if-absent staging are implemented;
- the action-bound repository-identity resolver proves one explicit governed Capability against
  the exact approved Capability map, approved portfolio entry, configuration cut, and checkout
  origin; it emits a credential-free portable Repository Domain plus an ephemeral authority proof,
  independently derives the same Scope Manifest as the normal WMB command from approved policy or
  the immutable accepted Story WFA snapshot, and re-proves both authority and scope before any
  lookup or staged construction;
- model preparation verifies the exact committed Source Snapshot, binds its subject to the
  Capability rather than the checkout directory name, admits the exact registry/policy/profile
  and retained input roster, and derives the complete Model Key before extraction. Frozen v1
  accepts only the product-owned 15-extractor default execution roster and derives the complete
  Extraction Policy from that exact installed roster plus the governed Scope Manifest; callers
  cannot reuse the scope-policy digest while weakening Fact semantics or selecting a reduced
  roster. Organisation-authored extraction policy remains unavailable pending its successor
  owner;
- exact pre-extraction lookup is an explicit read: a verified hit returns the accepted binding
  without registration, extraction, AST, model, cache, network, or publication work; only the
  typed `WMP_MODEL_MISSING` outcome becomes a miss, while integrity and authority failures remain
  failures rather than hidden rebuilds. The history cut is derived from approved state authority:
  shorthand branches require the configured remote-tracking ref and bind that remote's
  credential-free fetch fingerprint to the approved Repository Domain; local authority requires
  an explicitly approved full ref. Caller ref/commit values are assertions only, and source,
  Capability/configuration authority, scope, and the state tip are rechecked after the history
  read. Reused closures expose immutable canonical JSON text and recursively frozen records rather
  than mutable Buffer views;
- a code-local build-to-binding adapter can consume an explicitly requested registered-v4
  execution with exact-manifest terminal capture, construct completeness and the Model Binding,
  validate the complete retained closure, and stage immutable history additions. It rechecks the
  typed miss at the same admitted authority cut immediately before the single extraction, so a
  fabricated or already-satisfied miss cannot authorize work. It checks the exact key again after
  registration, adopts only a byte-identical concurrent winner, and refuses an advanced cut or
  conflicting winner instead of staging redundant authority. This is a staging boundary, not
  production publication authority;
- the existing state writer checks the pinned combined closure, including model/view binding graph
  validation, and already supports committing a compatible current projection and immutable
  history in one CAS without dropping existing exact-blob checks. The new build-to-binding path is
  not yet connected to that production transaction;
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

The increment does **not** make a current WMB build emit or reuse a production WMP model/view
binding yet. The governed repository-identity resolver, exact pre-extraction lookup, and
build-to-binding staging adapter now exist as isolated code-local foundations. They are not yet
wired through the normal WMB service so that a miss builds once and publishes the compatible
current projection plus immutable history in the same revision-checked state-branch CAS.
Exact-manifest terminal extraction outcomes and pure completeness construction are available for
every path in the selected source snapshot, including successful zero-fact extraction. Excluded
paths remain zero and cannot be admitted until an owned full candidate roster proves they existed
and were excluded by policy.

The retained Repository Domain remains only a portable semantic identity. The implemented
resolver compares it with current approved or lifecycle-pinned repository authority immediately
before lookup and construction; its ephemeral proof is not added to `ModelInputs` and cannot turn
an old configuration cut into current permission.

View emission and reuse remain disabled until retained renderer/validator implementation
contracts, an exact tokenizer owner whenever token measurement is asserted, model-to-view and
selected-ledger correlation, validation-receipt candidate/scope binding, and rendered-budget
validation are implemented. Deferred grounding, handoff, and adoption still require their
publication-receipt, admission-proof, source-authority, origin-authority, target-authority, and
adoption-authorization owners as applicable. Reusing an unrelated record under a convenient role
would create a syntactically valid but false proof. The next rollout step is therefore integrating
the staged lookup/build boundary with the current-plus-history state transaction, followed by
owned candidate-roster and extraction-configuration accounting; it is not activation of saved
views before their proof owners exist.

## Delivery boundary

| Increment | Current status | Included behavior |
|---|---|---|
| W0 | Persistence and semantic-owner foundation implemented | Strict identities, object references, six registered envelope contracts, portable paths, canonical-byte tests, and frozen v1 owners for repository domain, extraction policy, registry, completeness, consumer profile, output budget, and validation receipt. Production construction is not enabled. |
| W1 | Persistence and model-integrity foundation implemented | Direct exact-key state-history reads; create-if-absent publication expectations; additive history plus compatible current projection in one CAS; history-bound recovery; exact model-graph validation and pinned state-writer checks; governed action-bound repository identity; exact pre-extraction key/lookup; build-to-binding staging; exact-manifest terminal extraction outcomes; and pure completeness construction over the selected source snapshot. Production emission/reuse remains fail-closed pending normal-service and atomic state-transaction integration, owned excluded-path/configuration accounting, and the remaining view/grounding proof owners. |
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

- Add an owned full discovered-candidate roster before permitting excluded-path claims. The
  implemented extraction outcomes and pure completeness bridge cover only exact selected snapshot
  paths and intentionally report zero exclusions.
- Define an owned extraction-configuration contract that maps exact retained configuration bytes
  to the extractor that consumes them. Frozen v1 can prove only its registered empty
  configuration; configured profiles therefore remain fail-closed.
- Integrate the governed repository-identity resolver, exact pre-extraction lookup, and
  build-to-binding staging adapter into the normal WMB service. An exact hit must remain a
  zero-execution read; an explicit typed miss may build once. Publish the validated compatible
  current projection and immutable history additions together through the existing
  revision-checked state-branch CAS before wiring reuse into Story start or grounding preparation.
- Before enabling saved-view publication or reads, cryptographically connect each view binding's
  model-payload and selected-ledger identity to one accepted model binding and its retained source
  Fact Ledger; individual valid closures are not sufficient proof that the two graphs belong
  together. The same gate must correlate scope and prove that the validation receipt's candidate
  digest is the exact rendered object. Retained renderer/validator contracts, applicable tokenizer
  ownership, and rendered-budget validation are also required. Publication must apply these
  cross-record checks to the combined existing-plus-staged authority graph, not validate records
  only in isolation.
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
