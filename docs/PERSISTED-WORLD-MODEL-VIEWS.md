# Persisted World-Model views

**Status:** W0/W1 persistence, governed repository-identity proof, exact pre-extraction
key/lookup, build-to-binding staging, exact-manifest terminal extraction outcomes, the full
pre-scope candidate roster, frozen empty extractor-configuration ownership, a pure completeness
bridge, an opt-in normal-service/single-CAS model-history path, and a bounded W2 deterministic-view
slice are implemented. Frozen renderer/validator ownership, source-derived implementation identity,
exact persisted-view graph admission, and deterministic byte-for-byte replay are also implemented.
The owned saved-view writer, byte-only measurement policy, successor grounding-packet owner, and
exact packet replay are implemented. New Stories whose accepted configuration selects
`registered-v4` now activate that history only by selecting exact, already-published Model and View
Keys at one immutable state-authority cut before WFA captures the Story policy. Existing Story
lifecycles and the operational legacy-v3 and registered-v4 World-Model paths remain compatible.

This document is the repository implementation companion to the externally supplied
`SPEC-persisted-worldmodel-views.md` draft. It records the amendments required by the current WMB
v4 code so that persistence extends the existing state-branch authority instead of creating a
second World-Model authority; the external draft is not a packaged runtime dependency.

> **Operational boundary:** This roadmap does not gate Story creation, phase progression, current
> World-Model builds, current-projection publication, or existing reuse mechanisms. The shipped default
> is `worldModel.grounding: warn`: absent intelligence is represented by a stable unavailable
> receipt with zero World-Model bytes and ordinary repository access continues. Changing grounding
> to `enforce` changes the handling of consumed-context integrity failures, not model availability;
> a separately required projection or persisted domain may have its own explicit policy. Those
> independent requirements must not be confused with WMP exact-history activation.

> **No hidden preparation:** Story activation is an exact-history read, not a build. If the required
> model or any required view is absent, Story start pins a typed `unavailable` result. It does not
> extract, render, invoke a model or AST, fill a cache, fetch, or publish, and later state changes do
> not silently replace that decision for the accepted Story.
> Pre-activation Story schemas migrate with the optional `worldModelHistoryPin` field omitted;
> migration never infers a cut from mutable state or upgrades same-named untrusted historical data
> into authority.

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
   consumer-profile, output-budget, renderer-contract, validator-contract, and
   view-validation-receipt records. Model admission also
   verifies their exact cross-record graph. A governed action-bound repository resolver and a
   pre-extraction build/lookup adapter now provide the construction boundary. A code-local opt-in
   normal-service path publishes model history with the current projection in one CAS. View admission
   now requires the exact installed renderer/validator contracts, the accepted model and its base and
   projection Fact Ledgers, a byte-identical selected ledger, candidate/scope correlation, and the
   configured byte budgets. Admission then re-runs the installed renderer and requires exact
   rendered bytes, selection, and measurement; a passed receipt cannot substitute arbitrary
   under-budget content. Renderer and validator v1 algorithms live in immutable versioned modules.
   Their pinned source manifests hash the exact TypeScript-AST-discovered local ESM closure under
   installation-independent labels. Renderer v1 is one self-contained versioned module plus
   `node:crypto`; validator v1 depends only on that renderer module. Active registries, migrations,
   configuration, platform helpers, and generic schemas are deliberately outside the historical
   executable closure. The repository check rejects missing or extra modules, unsafe loaders,
   non-literal dynamic imports, package-root escapes, and symlink traversal.
   A separate append-only registry resolves exact contract-plus-implementation pairs and dispatches
   historical replay to the retained version; changing the active writer cannot redefine v1 and an
   unknown or mixed owner pair fails closed. A non-null token accounting mode remains
   fail-closed until an applicable tokenizer owner exists.
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
   mismatched outcome coverage. The owned pre-scope candidate roster reconstructs the complete
   committed Git tree and, for every selected entry, seals the Git blob object ID together with the
   exact Source Snapshot content SHA-256 and byte count. Construction rehashes the Git blob bytes;
   completeness construction and retained-history graph admission independently require the same
   content identity. A coherently rehashed roster therefore cannot substitute selected content.
   The roster is the only authority allowed to introduce excluded-path outcomes; missing domains
   remain explicit gaps.
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
11. **Story activation pins a cut, not a moving “latest” view.** Before WFA seals a new
    `registered-v4` Story, the lifecycle owner derives every eligible governed-agent phase/agent
    selection, plans the exact
    deterministic View Keys without rendering, and reads those keys plus their Model Binding from
    one authority commit. It rechecks repository and state authority after the reads. An authority
    movement during enrollment refuses the transaction; an exact-history miss becomes the
    immutable unavailable pin described above.

The supplied draft repeated the `inputObjects` row and `WMP:AC-001`; those duplicates have no
additional normative meaning. Public commands use `singularity-flow`/`sflow` equivalently, while
`--format` continues to select the storage pipeline and `--output-format` selects rendered output.

## Implemented boundary

The current increment provides the exact, read-only persistence foundation and the bounded new-
Story lifecycle activation that consumes it:

- all six original draft WMP envelope families plus the successor grounding-packet family are
  registered as frozen v1 identities, have strict closed
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
- frozen v1 owns one empty extractor-configuration value, maps it to every exact extractor
  consumer, validates it alongside the unchanged frozen-v1 parse-schema identity, and refuses
  non-empty configuration refs until a successor exact-byte owner exists;
- the full committed Git candidate roster is captured before scope, reconstructs its exact Git
  tree, binds every selected/excluded classification to the Source Snapshot and Scope Manifest,
  and binds each selected Git blob object ID to the exact Source Snapshot content SHA-256 and byte
  count; completeness and retained-graph validation enforce that cross-record equality;
- extractor registries are bounded to 1,024 manifests and graph admission uses indexed identity
  and manifest lookups;
- current executable registered-v4 adapters expose an explicit deterministic terminal-execution capture against their
  exact installed manifest and implementation identity, including successful zero-fact paths and
  explicit unsupported, partial, and failed outcomes. The exact-history miss path enables capture
  only for its base build; ordinary registration leaves it off to avoid an unused extractor-by-path
  allocation;
- a pure completeness bridge verifies every selected source path and digest, exact extractor
  identity, global extractor outcome, and required subject outcome before constructing the frozen
  completeness record; a sealed execution receipt binds its source, scope, registry, extractor
  executions, View Contracts, and View Fact Ledgers. Excluded outcomes require the owned roster
  that reconstructs the full committed Git tree before scope;
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
  conflicting winner instead of staging redundant authority;
- a pure projection overlay adds only view-dependent required-fact coverage to an accepted base
  registration, preserves every base fact and derivation byte, and reproduces the normal active-view
  registration without repository, model, or AST access;
- the existing state writer checks the pinned combined closure, including model/view binding graph
  validation, and already supports committing a compatible current projection and immutable
  history in one CAS without dropping existing exact-blob checks. The opt-in normal-service path
  now uses that transaction for compatible current projection plus immutable model history;
- publication recovery now binds and verifies the history additions as well as the replaceable
  projection, including byte-identical concurrent winners and unrelated-state-change refusal;
- exact historical source reads use locally available Git objects at an explicit full revision,
  disable lazy fetching and credential prompts, and never switch the checkout;
- migration readiness inventories keyed model, view, and handoff bindings from the exact locally
  materialized state-authority ref, without fetching or substituting an unpublished local branch;
  content-addressed objects remain the responsibility of their binding's semantic closure reader;
- five model-free overview contracts and pure full/brief Markdown or JSON rendering are available;
- frozen renderer and validator contracts now own immutable versioned deterministic overview
  implementations through an append-only exact-hash registry, and
  persisted-view graph admission independently recomputes the projection and verifies model, base
  ledger, projection ledger, selected ledger, scope, candidate digest, receipt, and byte budgets;
- admission hashes each installed renderer/validator's exact reviewed local dependency closure,
  then dispatches the retained contract to that exact historical implementation and
  deterministically replays it, requiring exact retained bytes, selected/omitted Fact IDs, and byte
  measurement. The immutable v1 renderer consumes the exact retained View Contract rather than the
  mutable active registry. V1 remains registered when a future active writer is added; a behavior
  change requires a new version, source manifest, implementation identity, and contract hash;
- the owned saved-view service accepts only a verified complete Model Binding closure, constructs
  every projection/input/render/receipt/binding itself, and submits the combined model-plus-view
  closure to the existing absent-or-identical publication admission boundary. The normal v4 service
  exposes it only through explicit `persistedHistory.savedViews`; current projection, model history,
  and view history still land in the existing single-CAS state transaction. Persisted overview v1
  is explicitly exact-byte measured: non-null tokenizer input fails closed rather than estimating;
- `world-model-grounding-packet` is a new frozen successor identity; the structural grounding
  reference v1 is unchanged. Its exact composer has a pinned source manifest and binds ordered View
  Keys, expansion handles, separator/framing/implementation identity, rendered packet bytes, byte
  budget, repository domain, and a caller-pinned authority assertion.
  `preparePersistedStoryGrounding` is a packet-composition primitive, not lifecycle authority
  proof: it returns before inspecting history when disabled, refuses missing views rather than
  building them, and reports `authorityProven: false`. Replay uses only the retained exact closure
  and reproduces the original bytes after mutable source changes. The lifecycle activation owner
  now derives exact keys at Story creation, stores a closed self-hashed pin inside
  `workflow.resolution` before WFA capture, and on every eligible governed-agent phase re-resolves
  the Model/View closure at that cut before changing the packet result to `authorityProven: true`;
- an active Story pin accepts a later fast-forward only when the pinned authority commit remains an
  ancestor of the configured state ref. Rewind, unrelated replacement, endpoint/identity drift,
  missing or changed bytes, and closure mismatch fail closed. The phase prompt receives the exact
  packet bytes once and records their binding in the prompt receipt; it never falls back to the
  mutable current projection;
- `wm history list --authority-commit <full-commit>` pages exact key paths with a continuation
  cursor bound to the authority cut, kind selection, history root, and page size, while `show`
  verifies the selected binding and complete semantically owned closure. Both prove that the cut is
  reachable from the configured state-authority ref and never fetch, build, invoke a model/AST,
  write a cache, or change Git. A configured remote never falls back to an unpublished local state
  branch.

The existing builder and current-projection reuse behavior continues. Its code-local normal-service
option proves the complete lookup/miss/build/single-CAS publication integration and still requires
an explicit producer action to create history. Story activation is a separate consumer: it never
turns a typed miss into a build, never infers a current or newest model/view, and never accepts
direct caller-supplied persisted facts. It activates only the exact lifecycle-selected cut and
keys, or pins unavailability.
Exact-manifest terminal extraction outcomes and pure completeness construction cover every selected
path, including successful zero-fact extraction. Excluded paths are admitted only from the owned
roster that reconstructs the complete committed Git tree before scope.

The retained Repository Domain remains only a portable semantic identity. The implemented
resolver compares it with current approved or lifecycle-pinned repository authority immediately
before lookup and construction; its ephemeral proof is not added to `ModelInputs` and cannot turn
an old configuration cut into current permission.

WMP exact-history saved-view **emission** remains available only through the explicit service
option; neither configuration refresh nor Story start emits missing history. New registered-v4
Stories do automatically select and reuse exact history that already exists. Token measurement
remains unavailable and fails closed; the installed v1 contract is byte-only. This does not disable
the existing WMB v4 current projection or its validated cache. Deferred handoff and adoption still require their
publication-receipt, admission-proof, source-authority, origin-authority, target-authority, and
adoption-authorization owners as applicable. Reusing an unrelated record under a convenient role
would create a syntactically valid but false proof. The lifecycle pin never guesses the newest
state entry: it derives complete keys, reads one cut, and rechecks that cut.

## Delivery boundary

| Increment | Current status | Included behavior |
|---|---|---|
| W0 | Persistence and semantic-owner foundation implemented | Strict identities, object references, seven registered envelope contracts (six original plus the grounding-packet successor), portable paths, canonical-byte tests, and frozen v1 owners for repository domain, extraction policy, registry, completeness, consumer profile, output budget, and validation receipt. Automatic WMP exact-history construction is not enabled. |
| W1 | Persistence and model-integrity foundation implemented | Direct exact-key state-history reads; owned pre-scope candidate roster and frozen empty configuration; create-if-absent publication expectations; history-bound recovery; exact model-graph validation; governed repository identity; explicit miss build; projection-only coverage derivation; and an opt-in service path proving compatible current projection plus immutable model history in one CAS and exact-key reuse. Existing WMB v3/v4 operation is unaffected. |
| W2 | Owners and automatic new-Story activation implemented | Five model-free overview contracts, stable full/brief renderers, owned saved-view materialization in the one-CAS service, exact-byte measurement, pinned renderer/validator/composer identities, exact view-graph admission, successor grounding packet composition/replay, immutable Story cut selection, and eligible governed-agent phase/agent exact-history re-resolution are implemented. The low-level composition primitive remains non-authoritative by itself; only the lifecycle owner can return `authorityProven: true`. IDE/FWM consumers remain deferred. |
| W3 | Deferred | Incremental parse/derivation reuse and verified private-candidate handoff/adoption. |
| W4 | Deferred | Legacy inventory/cutover, supported-platform evidence, capacity benchmarks, UI explorer, and release qualification. |

Only behavior backed by its runtime tests is advertised. W0-W2 do not claim foreign-candidate
continuation, complete incremental extraction, physical Windows/macOS/Linux qualification, or all
36 release criteria. World-Model or AST absence remains non-blocking under the shipped `warn`
grounding policy; `enforce` changes consumed-context integrity handling, not absence. A separately
required intelligence product may retain its own explicit policy.

## Related operational documentation

- [Governed World-Model Builder v4](WORLD-MODEL-BUILDER-V4.md) documents the operational v4
  current-projection and cache path.
- [Architecture Review Board document](ARB-document-plain.html) shows the system and activation
  boundary in context.
- [Pending-work roadmap](PENDING-WORK-ROADMAP.md) owns the cross-product rollout status.

## Storage contract

```text
singularity/world-model/                         compatible current projection
singularity/world-model-history/models/<64>.json immutable model bindings
singularity/world-model-history/views/<64>.json  immutable view bindings
singularity/world-model-history/objects/sha256/<2>/<64>
singularity/world-model-history/handoffs/<64>.json
singularity/work-items/<id>/context/grounding/wmp/<64>.packet.json
singularity/work-items/<id>/context/grounding/wmp/<64>.md
```

Every history path uses the complete lowercase SHA-256 hex value. Existing identical bytes are a
reuse winner. Existing different bytes at the same path are `WMP_IDENTITY_CONFLICT`; they are never
overwritten. History paths cannot be placed in a replacement or deletion root.

The first foundation release caps each record/object at 32 MiB, one staged history addition set at
64 MiB, and the complete projection-plus-history recovery payload at 96 MiB inside the existing
128 MiB immutable recovery sidecar. These stricter owner limits intentionally win over the draft's
proposed 256 MiB closure ceiling until a streaming/reference recovery format is reviewed.

## Release evidence still required

- Preserve the implemented candidate-roster and frozen empty-configuration owners when defining a
  successor contract for genuinely configured extractors; configured profiles remain fail-closed.
- Qualify the implemented Story-start/phase replay boundary on the supported physical-platform and
  fresh-clone matrix, including enrollment races, post-pin fast-forward, rewind/replacement,
  tampering, missing objects, and exact-once prompt inclusion. A typed miss must continue to pin
  unavailability and must never trigger a hidden build.
- Add an exact tokenizer owner only if a future saved-view or grounding variant claims tokens. V1
  is intentionally byte-only and rejects tokenizer input.
- Add the persisted-view IDE/FWM adapters over the same read-only replay service; do not duplicate
  packet composition in the UI.
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
- Cross-platform/fresh-clone evidence for exact Story grounding replay after current source,
  policy, renderer, and reports change (the code-local source-change fixture is implemented).
- Foreign Candidate source adoption and incomplete handoff refusal.
- Real Windows long-path/case behavior, macOS, Linux, archive capacity, and performance evidence.
