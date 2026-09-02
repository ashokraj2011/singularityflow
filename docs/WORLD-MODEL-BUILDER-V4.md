# Governed World-Model Builder v4

WMB v4 turns an exact, approved repository scope into reusable registered facts and independently
composed views. Deterministic extractors own evidence and fact creation. A model, when a registered
view permits one, can only narrate those facts; it cannot mint evidence, raise assurance, expand
scope, or write provenance.

Implementation was validated against the exact repository baseline
`c50205ca147afc708b68cc7c43e0d1f633ff4acc`. This baseline is the review anchor required by the
WMB v4 specification; the resulting release commit and packaged artifacts are bound separately by
the signed verification-matrix receipt described below.

The v4 model belongs to the scoped repository source, not to a Story. It is published as one atomic
projection on the configured state branch and reused by every Story that resolves the same source,
scope, registries, contracts, budgets, and execution profile. Story lifecycle metadata and generated
SFlow state are excluded from the default application-source scope, so starting or advancing a Story
does not rebuild an unchanged repository model.

## Enable v4

`legacy-v3` remains the configuration default for compatibility. In VS Code, open **Singularity
Flow → Configuration Center → World model**, choose **Registered v4 — governed facts**, review the
composer, consumer, cache, and token controls, then use the normal configuration review/publication
flow. The same approved setting can be written directly in `singularity/workflow.yml`:

```yaml
worldModel:
  format: registered-v4
  views:
    - dev.impact
    - arch.contracts
  sourceRoots:
    - src
    - test
  sharedRoots:
    - packages/contracts
  excludedRoots:
    - vendor
  maximumTraversalDepth: 8
  v4:
    composer: deterministic
    consumer: developer
    cachePolicy: reuse-valid
    candidateSnapshots: allow
    totalMaximumOutputTokens: 5600
```

The built-in active view catalog is:

| View | Purpose |
|---|---|
| `dev.impact@4` | Changed structure, dependency, contract, test, and unavailable impact |
| `dev.hotspots@4` | Structural, change, and dependency concentration |
| `biz.rules@4` | Registered rules, conditions, locations, and unavailable business meaning |
| `arch.contracts@4` | Contracts, implementations, consumers, contradictions, and unavailable guarantees |

List the exact installed contracts with `sflow world-model views` and inspect one with
`sflow world-model view-contract dev.impact`.

The reviewed deterministic extractor set covers repository/language inventory, top-level symbol
skeletons, signatures and exports, imports and resolved local dependencies, bounded same-file
call/reference candidates, exact first-parent change regions, interfaces and schema contracts,
configuration objects, named rule definitions, test identities, clause-to-code tags, CODEOWNERS
maintainer records, sealed runtime observations, and sealed human-confirmed business knowledge.
The lexical structural adapters recognize JavaScript, TypeScript, C, C++, C#, Go, Java, Kotlin,
PHP, Python, Ruby, Rust, and Swift. These adapters remain within the closed `source-exact`,
`structurally-derived`, and `deterministically-derived` assurance vocabulary; the two reviewed
imports retain only their closed `runtime-observed` or `human-confirmed` assurance. Unsupported or
ambiguous syntax becomes a typed unavailable or partial fact and never a silently inferred semantic
claim.

Trusted import files have two canonical repository-relative locations:

```text
world-model-inputs/runtime-observations.json
world-model-inputs/human-confirmed-knowledge.json
```

Both documents and every nested record must match their closed versioned schemas and exact record
digests. They are ordinary scoped repository input, not generated SFlow state. When a monorepo uses
explicit `worldModel.sourceRoots`, include `world-model-inputs` (or an equally explicit shared-root
selection) to opt into them. Do not place them under `singularity/`, which remains excluded so Story
and governance metadata cannot invalidate the shared repository model.

## Plan, build, and inspect

Planning is read-only and model-free:

```bash
sflow world-model plan --views dev.impact,arch.contracts --json
```

Build only the requested registered views:

```bash
sflow world-model build --views dev.impact,arch.contracts
```

If a storyless repository is mapped to more than one approved capability, select the scope
explicitly instead of allowing the checkout name to become a new identity:

```bash
sflow wm build --format registered-v4 --capability payments-api --views all
```

The native VS Code build flow presents the same approved capability choices. A state-authority
refresh and retry retains that exact choice; it never reopens under a different capability.

An ordinary exact build still refuses dirty in-scope bytes. When those bytes are intentionally the
source under review, capture them explicitly and pass only the returned content address:

```bash
sflow world-model snapshot --json
sflow world-model plan --candidate-snapshot sha256:... --views dev.impact
sflow world-model build --candidate-snapshot sha256:... --views dev.impact --local
```

Capture reads every allowed regular file twice through no-follow descriptors, rejects links and
path traversal, and binds repository object store, base commit/tree, Scope Manifest, path, mode,
content SHA-256, byte length, and Git object identity. The exact projection is anchored by a private
immutable Git ref. Supplying no `--candidate-snapshot` never captures or consumes dirty bytes.
Set `worldModel.v4.candidateSnapshots: deny` when organization policy requires committed sources
only. Candidate references are repository-local and cannot be imported as arbitrary paths.
They are also deliberately local-only: a private object-store ref cannot be verified by another
clone, so a Candidate Snapshot build never publishes reusable state. After review, commit the source
and run a normal clean-source build to publish it for other Stories, machines, and IDE sessions.

With a `registered-v4` workflow configuration, the shorter `sflow wm ...` spelling selects the same
runtime. In a compatibility repository, `--format v4` is a one-command override: repeat it on later
versioned reads, or publish the YAML setting so every surface resolves v4 consistently. `--local`
validates without publishing. `--rebuild` deliberately bypasses exact cache reuse.

`composer: deterministic` makes no model call. `model-optional` remains deterministic when the
registered facts are sufficient; `model-required` invokes the governed provider. `--model MODEL`
selects the concrete model only after the composer requires one—it does not turn model composition
on. When a model is required and `--model` is absent, governed provider routing chooses it.

The normal inspection commands are:

```bash
sflow world-model status
sflow world-model manifest
sflow world-model show dev.impact
sflow world-model facts dev.impact
sflow world-model evidence EV-...
sflow world-model derivation DRV-...
sflow world-model validate
sflow world-model validate-view dev.impact
sflow world-model verify-cache
sflow world-model doctor
```

Every command supports `--json`. State reads use one authority definition everywhere: the ledger
remote, then an explicit World-Model remote, then the application Git remote. They resolve the
locally available remote-tracking state ref first, then the local state branch, then the current
revision only when neither state authority exists. An authoritative state tip that deliberately
removed the model never falls through to an older application-branch copy. Ordinary reads do not
fetch or mutate refs. Refresh the exact configured authority explicitly when required:

The branch is selected from explicit `worldModel.stateBranch`, then `ledger.branch`, then `state`.
Remote and branch fallback precedence is resolved before defaults are normalized, preserving the
difference between an authored endpoint and an implicit default.

```bash
sflow wm refresh-authority --format registered-v4
# Add --capability ID for a storyless multi-capability repository.
```

The refresh removes only a stale tracking ref when the reachable remote proves that its state branch
is absent, uses compare-and-swap deletion, and fails closed on authentication, TLS, ambiguous remote,
or malformed advertisement errors. An offline read may use an already verified remote-tracking
projection; an authoring boundary cannot substitute an unpublished local rewrite for remote
authority. A legacy manifest on an authoritative ref is never silently treated as v4.

## Trust boundary

The v4 pipeline is:

```text
exact Source Snapshot
  -> exact Scope Manifest
  -> closed Extractor Registry
  -> Evidence Catalog
  -> Derivation Catalog
  -> registered Fact Ledger
  -> view-scoped Fact Ledger
  -> deterministic or governed-model composition candidate
  -> 20 deterministic validation checks
  -> kernel Facts block, header, and stamp
  -> aggregate manifest
  -> one state-branch compare-and-swap publication
```

Every factual unit in a candidate must end in one or more registered references such as
`[F:FACT-0123456789abcdef]`. Required unavailable facts and material contradictions must remain
visible. Because a model-never validator cannot prove unrestricted paraphrase entailment, the
built-in contracts admit only exact canonical fact sentences (or exact unavailable reasons) followed
by their sorted Fact reference set. The model can select and organize facts but cannot attach an
unrelated valid Fact ID to invented prose. The kernel adds the canonical Facts block and provenance
only after validation. A failed view produces a typed refusal and preserves the deterministic
evidence/facts; it cannot corrupt an already valid independent view.

Source bodies are denied by the built-in contracts. Evidence descriptors are reference-first and
bounded. Exact expansion is a separate, scoped read and must match the pinned source hash.

## Cache, staleness, and reuse

The machine-local cache is content-addressed beneath the repository Git common directory. A hit
requires all twelve registered identities: source, scope, view/version/contract, view Fact Ledger,
consumer profile, pinned composer core, candidate schema, validator, output budget, and execution
profile. Cache records and objects are revalidated on every read. Corrupt or incomplete entries are
misses and cannot publish.

Each entry also retains an immutable canonical key object. `verify-cache` can therefore recheck the
original execution-profile identity of model-composed entries even when the laptop's current
provider or model selection has changed; it never reruns a model to reconstruct that identity.

An exact hit performs no model call and reuses the original validated bytes and kernel stamp. A
later selective build adds the previously published active views to the current request as optional
independent executions. Unchanged views are exact cache hits; a changed profile, budget, source,
scope, registry, or Fact Ledger regenerates the affected view under the current request instead of
copying an orphaned old receipt. Status compares the published source, scope, policy snapshot, view
selection/contracts, extractor registry, consumer profile, and output budget with the currently
approved configuration. Any changed identity marks the previous model stale; regenerate the
smallest view or the complete current configured view set explicitly:

```bash
sflow world-model regenerate dev.impact
sflow world-model regenerate --stale
```

View identity is exact. Configuration may use a stable logical ID such as `dev.impact`, but planning,
checkpoints, prompts, execution receipts, and manifests pin the installed contract such as
`dev.impact@4`. When `worldModel.views` is omitted under registered v4, the active installed catalog
is the approved selection; `all` is expanded before worker names, checkpoints, diagnostics, or
manifests are created and the literal sentinel is never persisted.

An optional L2 Derived-Memory directory can share exact validated view bundles between checkouts:

```bash
sflow world-model build --views dev.impact --shared-cache /approved/derived-memory
# Or configure the same absolute path for terminal and native VS Code builds:
export SINGULARITY_FLOW_WMB_SHARED_CACHE=/approved/derived-memory
```

L2 is warmed automatically after successful L1 validation and is consulted only on an L1 miss.
Every bundle is content-addressed, schema/self-hash checked, bounded, and then installed through the
ordinary L1 validator; corrupt or conflicting shared bytes are ignored diagnostically and cannot
publish. The path must be an explicit real absolute directory and is never discovered by searching
the home folder.

Each completed build also writes a rebuildable machine-local query index keyed by the aggregate
manifest. It indexes bounded view, Fact, and Evidence descriptors for exact ID/type/path lookup and
contains no source bodies. Index loss or corruption is repaired from the verified published graph
and does not change governing evidence.

A typed failed-view refusal can also carry the closed `failed-view-only` retry authority used by
the in-process `retryFailedWorldModelV4View` service API. This path reuses the exact prior Source
Snapshot, Scope Manifest, View Contract, view Fact Ledger, context, budget, and execution profile;
it does not plan, extract, register facts, retry a sibling, or publish. Each terminal retry writes
an immutable machine-local receipt containing the complete previous typed refusal and either the
exact child execution or the next typed refusal. The installed policy permits at most three total
attempts, including the original. Binding drift and exhausted attempts fail before provider work.
There is intentionally no CLI spelling until a durable command can recover the complete preserved
runtime authority rather than reconstructing it from mutable options.

## State publication and recovery

Successful builds stage every dependency, receipt, context manifest, view, usage observation, and
the aggregate manifest under `singularity/world-model/`. The entire directory is replaced in one
state-branch Git transaction. Application branches remain unchanged.

Every state-backed read enumerates that committed directory and compares it with the exact
schema-derived allowlist. Missing records fail as a partial publication; ambient views, receipts,
or other unexpected files fail as an unexpected publication path. A migration receipt is allowed
only at its content-addressed path and only when it binds the current source, scope, facts, evidence,
and a current available view.

Before the state compare-and-swap begins, WMB v4 retains one immutable machine-local recovery
record containing the complete validated projection, request/Plan identities, expected remote head,
guarded source refs, commit message, and hashed publication endpoint. A transport failure therefore
does not require extraction, composition, or another model call. Inspect and resume only that exact
projection:

```bash
sflow wm recovery list
sflow wm recovery inspect <ID>
sflow wm recovery publish <ID> --confirm <ID>
```

Recovery first reconciles an exact commit that may already have landed after an ambiguous push. It
accepts only the reviewed parent, message, complete replacement-root bytes, source guards, endpoint,
and stable remote tip. Unrelated advances and same-byte impostor commits remain blocked. The marker
is removed only after exact reconciliation/publication succeeds; a cleanup failure leaves an
idempotent marker for the next attempt.

## Lifecycle grounding

Phase preparation, manual `next`, Developer Auto, Story planning, Initiative composition, capability
context, and evidence packets all use the same format-aware resolver. A fresh repository model is
shared across Stories; Story metadata is not part of its source identity. A phase that needs an
additional registered view can extend a valid same-source projection without changing the existing
view bytes. Automatic extension is permitted only by an approved `on-demand` + `automatic` +
`light` policy with the deterministic composer; v4 maps that policy to `quick`, makes zero model
calls, and still publishes through the exact state transaction. Stale, corrupt, source-mismatched,
or intentionally removed authority is never auto-repaired. The unattended action carries the exact
inspected state commit and manifest digest into the child build; an advance, deletion, or replacement
before execution refuses prior to extraction or composition.

Grounding mode controls the failure boundary. `enforce` stops before authoring when the exact model
is unavailable. `warn` continues with ordinary bounded repository access and writes a versioned
prompt-injection receipt whose `groundingAvailability` contains only a stable reason code—never a
path, provider diagnostic, or invented manifest identity. Older receipts migrate as
`legacy-unverified`; migration does not retroactively claim that missing grounding was approved.

## Migration from v3

V1-v3 prose is unregistered narrative. It must be rebuilt or migrated explicitly. Migration is a
fresh v4 rebuild from the current local checkout plus a migration receipt; it does not convert legacy
prose into trusted facts in place. Use `--local` first when you want to validate the rebuilt projection
without publishing:

```bash
sflow world-model migrate singularity/world-model/legacy-view.md \
  --view dev.impact --local
# Repeat without --local only after reviewing the result.
```

Migration maps a legacy claim only when it resolves to an exact fact in the freshly built registered
catalog. Unproven claims remain `unavailable`; their text never becomes evidence and never inherits
assurance from the old document. The durable receipt records every legacy claim index, its exact
registered Fact ID and Fact hash when mapped, or its typed unavailable reason and candidate
locators when unresolved; aggregate counts are recomputed from those rows during publication and
state-backed reads. The reviewed `legacy-migration-resolution` producer receives only the source
view hash plus claim indexes and hashes—not the legacy prose—and registers exactly one typed
`unavailable` Fact for each unresolved claim. Composition runs only after that augmented Fact
Ledger exists, so the regenerated target view must expose those gaps through registered Fact
references. The state writer reproduces the same augmentation from the receipt before accepting
the bytes. A successful governed migration atomically replaces the complete
`singularity/world-model/` projection on the state branch and includes the receipt. A
model-required composer may invoke its governed provider during that rebuild.

## VS Code and gateway behavior

The World-Model Explorer requests an on-demand leased `worldModel` slice. The ordinary extension
snapshot contains no Fact Ledger or Evidence Catalog. Its initial projection contains only the
manifest summary, bounded view previews, counts, cache state, staleness, and content-addressed
expansion references. **Open exact view** reads the referenced bytes from the verified state-backed
store rather than looking for a copy on the application branch. Facts, Evidence, Derivations,
Manifest, Unavailable analysis, Contradictions, Staleness receipts, and Cache & economics buttons
perform the same explicit bounded read; complete catalogs and derived analyses never join the
retained snapshot. Closing the last consumer releases the slice and drops the heavy projection
while retaining the local content-addressed cache.

Gateway inspection reuses the existing five-tool surface through `resolve` followed by `read` of the
read-only `world-model.inspect`, `world-model.next`, and `world-model.explain` operations. `next`
computes the smallest legal plan, validation, diagnosis, or regeneration command from verified
authority; `explain` traces a fact, evidence item, derivation, view, refusal, or manifest without a
model. The same five-tool surface registers `world-model.build`: `resolve` creates a provider-free
exact Plan, the host separately displays and confirms its request/Plan/source/scope/view identities
and state-branch CAS target, and `sflow_run` accepts only the opaque one-time Plan handle. The receipt
never enters tool arguments or model context. Source, policy, endpoint, or remote-head drift refuses
execution before provider work or publication.

In VS Code use **Configuration Center → World model → Build / refresh**. The native picker selects
only approved registered views, depth, and composer, shows the exact modal review, and creates a
short-lived writable gateway only for the confirmed run. Cancelling the modal creates no receipt and
performs no mutation. The activation-long gateway and ordinary Copilot/IDE reads remain read-only;
no surface adds an approval bypass or broadens the five-tool catalog.

On Windows the Copilot provider is launched through the shared platform-safe command resolver and
ACP stdio session boundary. Arguments are passed as an argv vector rather than shell text, prompts
do not enter process arguments or environment variables, and cancellation/timeout terminates the
process tree. The same launcher is used by discovery and composition, avoiding a VS Code-only or
shell-only transport path.

## Release matrix

Ordinary development remains a one-machine workflow. Release promotion is stricter: it requires
individually signed clean-checkout receipts for macOS, Linux, and Windows on Node 20 and Node 22,
merged and reviewed into one signed aggregate for the exact commit. One explicitly selected
artifact receipt binds the npm/VSIX bytes promoted by the release.

**Evidence status — pending as of 2026-09-01.** The receipt generator, merger, verifier, and release
gate are implemented, but no reviewed six-cell aggregate is recorded for the current final release
commit. Local Node 25 validation and simulated platform tests satisfy none of the required Node
20/22 cells.

```bash
npm run verification:receipt -- --signing-key runner.pem --out darwin-node20.json
# Repeat on each required host/runtime, then on the release verifier machine:
npm run verification:receipt:merge -- \
  --receipt darwin-node20.json --receipt darwin-node22.json \
  --receipt linux-node20.json --receipt linux-node22.json \
  --receipt windows-node20.json --receipt windows-node22.json \
  --artifact-receipt linux-node22.json \
  --signing-key release.pem --identity release-reviewer@example.com \
  --out verification-matrix-receipt.json
```

The merge refuses mixed commits or trees and records the original signed payload behind every cell.
The real release command refuses a single-host or incomplete aggregate and verifies its packaged
bytes against the selected artifact receipt; `release:dry` and normal test/check commands do not
require it.

## Troubleshooting

- `WMB_MANIFEST_MISSING`: run an explicit v4 build for at least one registered view.
- `WMB_MIGRATION_REQUIRED`: rebuild or run the explicit migration command; do not rename a v3 file.
- `WMB_SOURCE_SNAPSHOT_REQUIRED`: commit or stash the in-scope application bytes, then rerun the
  plan/build against a clean exact source snapshot. If those bytes are the intentional reviewed
  candidate and policy permits it, run `wm snapshot`, review its source hash, and pass that exact
  hash with `--candidate-snapshot`. Out-of-scope Story metadata does not block a scoped build.
- `WMB_SOURCE_SNAPSHOT_STALE`: inspect the new source revision, then regenerate only the needed view.
- `WMB_VIEW_UNKNOWN` or `WMB_VIEW_REVOKED`: inspect the closed registry and use an active exact view.
- `WMB_CACHE_ENTRY_CORRUPT`: rebuild the affected view; the corrupt cache entry cannot publish.
- `WMB_REQUIRED_VIEW_UNAVAILABLE`: inspect the refusal and its smallest next action. Valid sibling
  views and registered facts remain preserved.
- `WMB_STATE_AUTHORITY_REFRESH_REQUIRED`: run
  `sflow wm refresh-authority --format registered-v4`, preserving `--capability ID` when shown, then
  review a new exact Plan. Do not fetch or rewrite refs manually to bypass the comparison.

Use `sflow world-model doctor --json` to distinguish missing, legacy, stale, corrupt, and current
state before changing anything.
