# Token Reduction candidate and non-blocking shadow evidence

**Status:** code-local `tkr-v1` candidate evaluation only; `legacy-v1` is the only production
prompt composer and `observe` remains the default token-economy mode

This document is the implementation companion to `SPEC-token-reduction.md`. It describes only the
code-local boundary that exists in this repository. It does not claim that Singularity Flow has
replaced the context sent by every host, completed the persisted World-Model lifecycle, or proved a
token saving.

## Current safety boundary

The packaged workflow continues to use:

```yaml
tokenEconomy:
  enabled: true
  mode: observe
  composer: legacy-v1
```

`observe` measures the existing legacy path without changing the context delivered to an agent.
`legacy-v1` preserves the current byte-compatible composer for new and existing Stories. The
`tkr-v1` name remains in the configuration vocabulary so candidate contracts can be reviewed and a
future governed migration can retain the intended choice. It is not currently a production Story
composer: any enabled production prompt compilation that selects it refuses with
`TKR_CONTRACT_UNSUPPORTED` and directs the operator back to `legacy-v1` until M2 is complete.

Every newly composed Story prompt in the default `observe`/`legacy-v1` path also evaluates the
deterministic `tkr-v1` candidate in shadow. The exact legacy bytes remain the only selected and
delivered prompt. The prompt-generation record retains one registered, immutable, content-free
`tkr/composition-receipt` binding the Story, workflow snapshot, phase/generation, repository,
policy, source, input owners, composer, candidate segments, and exact selected prompt digest. The
receipt honestly records the current one-byte transport-framing difference instead of treating a
legacy final LF as TKR content. Its summary reports `shadow-not-delivered`; a missing, unsupported,
or corrupt shadow receipt degrades the optimization observation to unavailable and never blocks
reuse of an otherwise verified legacy prompt. No second model request or hidden Git publication is
performed.

Developers may exercise `tkr-v1` directly through the code-local token-reduction prompt adapter.
That API preserves section bytes and returns a candidate composition/report in memory; it does not
replace phase prompt bytes, publish an active TKR packet, or dispatch a model request. It requires a
synchronous owner resolver that returns a closed, self-hashed binding; the
caller remains responsible for proving that resolver itself performed no I/O or model work. Tests
use preconstructed in-memory bindings. There is no automatic migration or hidden fallback from a
configured enabled `tkr-v1` selection.

The lower-level pure composer accepts only already-resolved offers. Its closed field sets,
qualified-coverage comparisons, protected-source continuity, and deterministic hashes detect
inconsistent inputs, but they do not turn caller-authored reference strings into durable authority.
Resolver-issued immutable subject/reference formats and their retained owner records are part of
M2; production activation stays refused until that exact owner binding exists.

The packaged contract parsers, selection, rendering, cache, and evaluation functions are
deterministic and import no provider. The prompt adapter invokes the explicitly supplied synchronous
owner resolver, so its caller must enforce the same boundary; a callback cannot be assumed pure
merely because it is synchronous. A future delivery adapter must prove both the owner-resolution
boundary and what bytes the host actually received.
Every M1 composer renderer also resolves exactly once through a closed, self-hashed, code-local
runtime registration. Those registrations prevent ambient or invented renderer selection in the
preview; they are not durable WMP authority. Persisted renderer registration, migration, and
cross-laptop replay binding remain part of M2.

## Milestone status

| Milestone | Status in this repository | Boundary |
|---|---|---|
| M0 — contracts and baseline | **Code-local foundation implemented; baseline evidence pending** | Six frozen v1 contract families, closed schemas, canonical-byte parsing, exact owner/version/digest references, finite limits, and the `legacy-v1`/`tkr-v1` policy vocabulary exist. The evaluation kernel can assess declared observations, but no representative paired baseline has been run or accepted. |
| M1 — bounded composer optimization | **Pure deterministic candidate composer implemented** | The pure composer validates slot, role, ordering, dependencies, required applicability, protected UTF-8, representations, coverage-backed deduplication, aliases, omissions, budgets, and exact output hashes. The adapter can produce an in-memory candidate and section report. No Story phase prompt, grounding record, packet, or model request consumes it. |
| M2 — WMP lifecycle integration | **First shadow receipt slice implemented; active delivery remains gated** | A frozen composition schema/family and exact Story prompt-generation receipt now bind the deterministic candidate to the selected legacy bytes, subject, policy, source, inputs, and composer. Production use still requires an active successor grounding/packet binding, exact outbound delivery evidence, expansion succession, in-flight freshness checks, handoff closure, and restart/cross-machine replay coverage. The missing semantic-owner and lifecycle work is tracked in [Persisted World-Model views](PERSISTED-WORLD-MODEL-VIEWS.md). |
| M3 — compact rendering and local reuse | **Cache and generated-framing foundation implemented; compact input renderers pending** | Alias/omission framing is exact and the composer validates caller-supplied representation bytes. No packaged excerpt, deterministic-brief, reference-only, or lossless-encoded input renderer is enabled yet. Derived segment memoization has a complete dependency key, exact integrity checks, conflict refusal, atomic writers, and finite entry/disk ceilings. Production composition integration and AC-009/010/022/023 renderer evidence remain pending. |
| M4 — representative evaluation and defaults | **Diagnostic evaluation kernel implemented; qualification pending** | The evaluator requires an exact self-hashed provider-usage mapping, deduplicates cumulative snapshots, preserves immutable outcome facts, excludes explicitly linked child observations from inclusive aggregate totals, retains unknown and failed/repaired observations, and computes paired-cohort/quality diagnostics. Results are deeply frozen after sealing. `benchmarkEligible`, `candidateClaimEligible`, and `claimAllowed` remain false at this code-local boundary even when `measurementEligible` and the diagnostic target are true. The required representative paired benchmark, owner-bound execution receipts, adapter/platform qualification, independent review, and any default change have not happened. |

M2 is deliberately not inferred from M0/M1/M3. A smaller deterministic block does not prove that
the block was delivered, that a persisted WMP selection can be replayed, or that another laptop can
continue the same Story.

## Derived segment cache

The M3 cache is below the repository's common Git directory:

```text
<git-common-dir>/singularity-flow/cache/token-reduction/segments/v1/
```

It is disposable derived data, not workflow authority, publication proof, retained packet history,
or provider-usage evidence. A lookup is read-only. Only an admitted preparation may render, write,
quarantine corrupt cache bytes, or apply bounded eviction. Entries bind:

- repository/private-candidate domain and access scope;
- effective input references;
- renderer, selection, normalization, and serializer references;
- output format and segment kind;
- exact content SHA-256 and byte length.

Corrupt or missing entries are misses. A permitted preparation may recompute them. Two validated
bodies for one exact key fail with `TKR_RENDER_CONFLICT`; the cache never chooses the newest body.
Atomic storage, quota maintenance, or cache-full failure cannot invalidate an otherwise valid
uncached composition. Cache status and clear operate only on disposable entry/quarantine files and
never traverse a retained-history sibling.

Deleting this cache may make the next admitted preparation slower, but must not remove an accepted
packet or make historical replay impossible. No authorization or current proof may be reconstructed
from it.

## Measurement and claims

The preview makes **no token-savings claim**. Packet byte or estimated-token reduction is not the
same as observed complete-request or complete-Story savings. A release claim requires the paired
benchmark defined by the specification, including:

- matched baseline and treatment Stories;
- complete provider-token accounting, with unknown usage left unknown;
- retries, expansions, repairs, failures, and cached-input semantics counted once; a provider
  request ID that arrives after an attempt begins is joined to that attempt, while conflicting
  identities, duplicate indices, decreasing cumulative counters, and terminal-state reversal are
  refused;
- a pinned provider usage-accounting contract declaring exclusive requests or a reciprocal
  parent/aggregate graph; missing, ambiguous, cross-cohort, or cyclic linkage is refused;
- unchanged required coverage and no decrease in first-pass or final acceptance quality;
- supported adapter/platform evidence and independent review.

Until that evidence exists, `legacy-v1` remains the only production composer and `tkr-v1` remains
a candidate API only. A smaller initial packet that causes later retrieval or repair is not a
proven net saving.

## Maintainer validation

Run the implemented TKR slice exactly with:

```bash
node --test --test-concurrency=2 \
  test/token-reduction-contracts.test.mjs \
  test/token-reduction-default-contract.test.mjs \
  test/token-reduction-generated-renderer.test.mjs \
  test/token-reduction-composer.test.mjs \
  test/token-reduction-prompt-adapter.test.mjs \
  test/token-reduction-composition-contract.test.mjs \
  test/token-reduction-segment-cache.test.mjs \
  test/token-reduction-evaluation.test.mjs \
  test/prompt-budget.test.mjs \
  test/token-economy.test.mjs

node scripts/schema-migration-lint.mjs
node scripts/vocabulary-lint.mjs
npm run audit:model-boundary
```

Before release, also run the complete repository checks:

```bash
npm run operation-catalog:check
npm run check
npm test
```

The focused command currently covers contract/schema closure, deterministic composition,
protected bytes, required coverage, bounded alternatives, corruption, concurrent cache writers,
cache-full/write-failure behavior, retained-history protection, cumulative-usage deduplication,
parent/aggregate overlap accounting, provider cached-input semantics, paired-quality classification,
configuration compatibility, and model-free cache hits. It is not a
substitute for physical Windows/Linux/macOS, host-adapter, cross-laptop restart, or representative
paired-benchmark evidence.

## Next eligible work

1. Complete the missing persisted-WMP semantic owners and active successor grounding/packet
   contract; the immutable shadow composition receipt is now implemented.
2. Bind the composer contract closure to that active successor and retained packet owner
   while preserving exact legacy replay.
3. Bind expansion and final outbound-delivery evidence to the exact successor composition.
4. Add owner-registered compact input renderers and lossless decoding, with golden, round-trip,
   limitations-overflow, clarification-state, and stable-segment assembly evidence.
5. Bind alias scope to the durable packet/composition owner; the preview currently enforces only
   the caller-supplied expected composition scope.
6. Run the declared paired benchmark and quality gates on representative Stories.
7. Consider changing a default only through governed configuration after the evidence is accepted.
