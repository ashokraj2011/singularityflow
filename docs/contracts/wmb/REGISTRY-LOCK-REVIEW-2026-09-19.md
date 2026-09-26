# WMB v4 extractor-registry authority review — 2026-09-19

**Review boundary:** `main@bd08c29a029f288d7b928cf3e762bf41cc3bef7e`

**Last accepted registry boundary:** `7ecdfdb033cef83b8db30baaaf94746c101b92e3`

This is the bounded authority review for the `required-fact-coverage@1.0.1` manifest and the
built-in Extractor Registry lock. It is not a bulk hash refresh. The locked values were changed
only after tracing every WMB implementation-path change since the last accepted boundary and
running the owning contract and extraction tests.

## Why the identities changed

Every built-in extractor implementation identity includes `WMB_V4_KERNEL_SOURCE_SHA256`. That
digest intentionally covers the complete packaged `src/world-model/` implementation, plus
`src/repository-facts.mjs` and the composition-candidate schema. A reviewed change anywhere in
that boundary mechanically invalidates every extractor implementation identity, its manifest,
its conformance receipt, and the aggregate Extractor Registry, even when a particular extractor's
algorithm and declared contract are unchanged. This protects cache and publication reuse from
silently crossing executable-build boundaries.

The following authority bytes are identical at both review boundaries:

| Authority | Git blob at `7ecdfdb0` and `bd08c29a` |
| --- | --- |
| `required-fact-coverage.mjs` | `063af8c31e245f2e6280680edd7693ac135e3b86` |
| `registry/extractors.mjs` | `95d2cfdecb6a4d399d6d36c42c900a9fb99287ba` |
| `registry/views.mjs` | `4933d60d5d66cabb84c69dc65915625fe8fac697` |

Therefore the extractor remains version `1.0.1`, keeps algorithm
`register-typed-unavailable-only-when-view-fact-coverage-is-absent-v2`, does not claim
`test-impact`, and the testing overview continues to treat `test-impact` as optional while requiring
an unavailable `runtime-frequency` limitation when runtime evidence is absent.

## Reviewed path changes

Only four files inside the kernel-source boundary changed after the last accepted registry:

| Commit | Path and reviewed effect | Extractor-contract effect |
| --- | --- | --- |
| `9403078342e8c0e7bf4b46d403c03370e542dcff` | `fwm/read.mjs`: paired shell/Copilot continuation presentation | None; read rendering only |
| `a753150b63a4da91a6a3384f21a9b1d2ff43acd7` | `commands.mjs`: explicit registered-v4 compatibility selection and typed recovery guidance | None; selection fails closed and does not alter extraction |
| `37f595a43355199410337b257ae2f5697ef9fca4` | `commands.mjs`: propagates the explicit format/view/phase selection to state reads and refresh | None; fixes store identity selection |
| `6a4d9854adef2a1fd4f7b3bfced79a1a54a6785d` | `source/snapshot.mjs`: removes ambient Git selectors while retaining the private Candidate index | No fact-policy change; hardens exact source capture |
| `be7a65f502de034e88323c8104bbc3f0e74b1e14` | `authority-refresh.mjs`: exact direct-ref observation and compare-and-swap deletion of a stale state tracking ref | None; hardens state authority refresh |

No WMB schema, repository-fact owner, required-fact-coverage algorithm, extractor declaration,
View Contract, fact vocabulary, or parser declaration changed in this interval.

## Accepted identity transition

| Identity | Previously accepted | Accepted at this review |
| --- | --- | --- |
| Packaged WMB kernel | `sha256:c27d146e2f3020bafe501b3c6e62b67f2e2d5e41b92b6935e66aa56594945863` | `sha256:5e5d9f2cae0b949239ce8a0af298b47d9ee085bb7f63c8af9d4ec2bbe4c98fe7` |
| Coverage implementation | `sha256:bbb03ace6d39ccca110c57bb94ecaeaedf2fbdf9d918025be58bf5d9be944653` | `sha256:39dbea87583a8a697107522afb8fa06a918f0518ca52361a6ddf9eeb4c6187bb` |
| Coverage conformance receipt | `sha256:162206e0eb561f4afa540921ab24a6090a7c827b182940637518548a2c2dac8d` | `sha256:84330af7ec899b43cefa7c54981f8ed407d0435057f25d6f747c2ca9725e5f63` |
| Coverage manifest | `sha256:3ab8c57deaf8f02d8b5a95cd7551db3e0d18f141d37c91e6d38f8794d8241460` | `sha256:518471f86ed5519266770653cf39b534227a9e95d44aeee55f85fe887ab277ce` |
| Built-in Extractor Registry | `sha256:f0809bd0c483e1ec23681b32556b379d22e36c31779f9858e0cede7147821495` | `sha256:d30ebced366e1916decc7592db0eca0ec354b6d396bd76078c43f857823073fd` |

## Persisted-view historical-reader isolation addendum

The WMP persisted-view work reviewed after the boundary above adds an immutable v1 renderer,
validator, exact source manifests, and append-only historical dispatch beneath `src/world-model/`.
The coverage extractor algorithm, parser, Fact declarations, permissions, and testing View Contract
remain unchanged. Because the extractor implementation deliberately binds the complete packaged
World-Model kernel, these reviewed reader additions produce one further mechanical build-identity
transition:

| Identity | Prior accepted | Accepted after persisted-view isolation |
| --- | --- | --- |
| Packaged WMB kernel | `sha256:5e5d9f2cae0b949239ce8a0af298b47d9ee085bb7f63c8af9d4ec2bbe4c98fe7` | `sha256:b2f21878f0ca48d970576a620d29233906043dd4ae6167d1358fc51f84fee9f1` |
| Coverage implementation | `sha256:39dbea87583a8a697107522afb8fa06a918f0518ca52361a6ddf9eeb4c6187bb` | `sha256:567738ea0a910a1ab7df1ad1e6a0e0d7414ef24d305efb3f78a15992e77e6a7b` |
| Coverage conformance receipt | `sha256:84330af7ec899b43cefa7c54981f8ed407d0435057f25d6f747c2ca9725e5f63` | `sha256:281dc12d6958c06848ec1622e8d70fd36b4ae28684c7e5538c4ea28ef43e99c3` |
| Coverage manifest | `sha256:518471f86ed5519266770653cf39b534227a9e95d44aeee55f85fe887ab277ce` | `sha256:d42a49dd120f9fc63600925677e68ebac6d50dba1fb5d4118bbf435807f93ca9` |
| Built-in Extractor Registry | `sha256:d30ebced366e1916decc7592db0eca0ec354b6d396bd76078c43f857823073fd` | `sha256:45432b2ad2b036f386a135396230e49f946bb8a600ca5cd40e0a81a42c035fd9` |

The owning registry test, actual v1-under-v2 replay test, exact source-closure audit, forged-receipt
replay test, and broad World-Model suite establish this transition. This addendum does not activate
Story or grounding use of persisted views **at this historical review boundary**; the later
lifecycle-activation increment described below owns that separate authority decision.

## Saved-view publication and successor-grounding addendum

**Review boundary:** working tree based on `main@99f8d886ceeb1f238adfe17ca6349d5f0d1eada3`

The next bounded WMP increment adds owned saved-view materialization to the existing single-CAS
history transaction and adds an explicitly default-off, byte-only successor grounding packet. At
that review boundary it did not activate persisted grounding at Story start. Packet composition reports
`authorityProven: false`; lifecycle-owned exact-history re-resolution, closure-to-cut proof, and
immutable Story cut pinning remained required before public activation.

Reviewed tracked kernel changes:

| Path | Reviewed effect | Extractor-contract effect |
| --- | --- | --- |
| `history/contracts.mjs` | Strict frozen grounding-packet record validation and 32 MiB runtime/schema parity | None |
| `history/paths.mjs` | Portable packet and exact Markdown payload paths | None |
| `history/publication.mjs` | Retains exact staged bytes for rendered-object graph admission | None |
| `service.mjs` | Explicit saved-view option in the existing current-plus-history one-CAS publication | None |

Reviewed new kernel files:

- `history/saved-view-publication.mjs`: owner-derived projection, rendering, validation receipt,
  binding, exact-byte measurement, and combined graph staging;
- `history/grounding-packet.mjs`: closed saved-view metadata checks, exact Model Binding capture,
  repository-domain correlation, canonical expansion-handle derivation, and byte-for-byte replay;
- `history/persisted-grounding-composer-v1.mjs`: frozen ordering/framing with incremental aggregate
  admission before allocation;
- `history/persisted-grounding-owner.mjs`,
  `history/persisted-grounding-source-manifest.mjs`, and
  `history/persisted-grounding-implementation-registry.mjs`: pinned source/contract identity and
  append-only retained-version dispatch.

The exact authority-source Git blobs remain unchanged:

| Authority | Git blob at `99f8d886` and this review |
| --- | --- |
| `required-fact-coverage.mjs` | `063af8c31e245f2e6280680edd7693ac135e3b86` |
| `registry/extractors.mjs` | `95d2cfdecb6a4d399d6d36c42c900a9fb99287ba` |
| `registry/views.mjs` | `4933d60d5d66cabb84c69dc65915625fe8fac697` |

No required-fact-coverage algorithm, declared fact type, parser declaration, permission, Fact
vocabulary, or View Contract changes in this increment. The identity movement is therefore the
intended mechanical consequence of binding extractors to the complete packaged WMB kernel:

| Identity | Prior accepted | Accepted by this review |
| --- | --- | --- |
| Packaged WMB kernel | `sha256:b2f21878f0ca48d970576a620d29233906043dd4ae6167d1358fc51f84fee9f1` | `sha256:eee353719a12ed6f4aeab43c4d77dcfb6cf21c660f3f1f6c8cfbf36ba565917d` |
| Coverage implementation | `sha256:567738ea0a910a1ab7df1ad1e6a0e0d7414ef24d305efb3f78a15992e77e6a7b` | `sha256:8e06e97befe226218bfd2e98916721cb8e2ef7b42dd55c6992e7979d81d04e0c` |
| Coverage conformance receipt | `sha256:281dc12d6958c06848ec1622e8d70fd36b4ae28684c7e5538c4ea28ef43e99c3` | `sha256:eea393a76dcaba37ab41f4576b0bb1bd3e5fe51cea4f049227671bc1738a8d14` |
| Coverage manifest | `sha256:d42a49dd120f9fc63600925677e68ebac6d50dba1fb5d4118bbf435807f93ca9` | `sha256:328699f7d8f34b0226225d335292f941cadf3773d761c8a856dd4281a8e0741c` |
| Built-in Extractor Registry | `sha256:45432b2ad2b036f386a135396230e49f946bb8a600ca5cd40e0a81a42c035fd9` | `sha256:b666190ca6e5edba596438fb54440a4f111dd49524eb76219f35a3880ef29f53` |

Pre-lock validation covered 28 focused persisted-view/grounding contract tests and 66 focused WMP
service/runtime tests. Before reconciliation, the broad World-Model sweep reached 450/451 and its
sole failure was this deliberately frozen registry identity assertion. After the reviewed lock was
updated, the complete World-Model sweep passed 453/453 tests. This review therefore accepts the
reconciled identities above.

## Lifecycle activation addendum

The later automatic Story-activation increment closes the lifecycle-ownership gap without changing
the low-level packet composer's authority contract. For a newly created Story whose accepted
configuration selects `registered-v4`, the lifecycle owner now:

1. derives the complete phase/agent selection and deterministic exact Model/View Keys;
2. reads only already-published history at one state-authority commit and rechecks repository and
   state authority before WFA captures the Story policy;
3. stores a closed self-hashed active pin, or a typed unavailable pin on an exact model/view miss;
4. re-resolves the pinned bytes on every eligible governed-agent phase, recomputes the complete
   closure, and proves the pinned commit remains reachable from the same authority endpoint; and
5. changes the packet result to `authorityProven: true` only after those lifecycle proofs, then
   requires the exact packet bytes to occur once in the composed prompt and receipt.

Story activation performs no extraction, rendering, model or AST invocation, cache fill, fetch, or
publication. A later fast-forward is accepted only while the pinned commit remains an ancestor;
rewind, unrelated replacement, endpoint or repository-identity drift, tampering, missing objects,
and closure mismatch fail closed. An unavailable pin does not silently activate when newer history
appears.

This addendum records the product boundary, not a new registry-lock acceptance digest. Any changed
file covered by `WMB_V4_KERNEL_SOURCE_SHA256` still requires the sanctioned reconciliation below
and its own exact commit plus validation evidence; the historical accepted hashes above are not
silently rewritten.

## Automatic Story grounding activation registry acceptance

**Review boundary:** working tree based on `main@b6d059cfd6ffceff90c36454a173cace32efd9fe`

This bounded review accepts the kernel-identity transition caused by the lifecycle activation named
above. The reviewed kernel changes are limited to:

- `history/saved-view-publication.mjs`, which exposes the canonical saved-view planner used by the
  lifecycle owner without changing extraction, parser, Fact, View Contract, or publication rules;
- `history/story-grounding-activation.mjs`, which resolves already-published exact history, seals a
  Story-owned pin, replays the complete pinned closure, and never extracts, renders, publishes,
  invokes a model, or grants packet authority by itself.

The required-fact-coverage algorithm, declared inputs and outputs, parser identity, permissions,
Fact vocabulary, View Contracts, cache semantics, and state publication authority are unchanged.
The resulting movement is the intended mechanical consequence of binding extractor identities to
the complete packaged WMB kernel:

| Identity | Prior accepted | Accepted by this review |
| --- | --- | --- |
| Packaged WMB kernel | `sha256:eee353719a12ed6f4aeab43c4d77dcfb6cf21c660f3f1f6c8cfbf36ba565917d` | `sha256:6a7b4e5418e79f77a48b2de4bc338c7374c6514992c0ba2c1198a340c8ea870f` |
| Coverage implementation | `sha256:8e06e97befe226218bfd2e98916721cb8e2ef7b42dd55c6992e7979d81d04e0c` | `sha256:fab502f0470ff664e5e1c20bca51def3a60ea90a92843302a6f63f061a1f4a4f` |
| Coverage conformance receipt | `sha256:eea393a76dcaba37ab41f4576b0bb1bd3e5fe51cea4f049227671bc1738a8d14` | `sha256:1ae7923394a0cf22c8692afac504c4e384148bcc913081d574ed28e6de189bc3` |
| Coverage manifest | `sha256:328699f7d8f34b0226225d335292f941cadf3773d761c8a856dd4281a8e0741c` | `sha256:7f89aaf03bbaf5a79329f887732ede598a7d0906cd5cfb6ebd3bc867a4e7b83d` |
| Built-in Extractor Registry | `sha256:b666190ca6e5edba596438fb54440a4f111dd49524eb76219f35a3880ef29f53` | `sha256:1652d0a2c6b04b56e656c0975669f30beb159f0c3a628127ac4a1963b7bbd312` |

The activation, exact-history replay, source-digest, registry, extractor-conformance, persisted-view,
authority-refresh, prompt-integrity, lifecycle, and broad World-Model tests own this transition.
The final repository validation evidence is recorded with the commit that accepts these bytes.

## Post-review activation hardening acceptance

The final product-entry review found that pre-accept Story creation must reuse its privately
verified approved-configuration snapshot, that a configuration-only Story-start commit must not
replace the immutable application source revision, and that phases with no configured saved view
must retain an explicit no-grounding result instead of borrowing another phase or agent plan. The
activation owner was hardened accordingly. The same review added last-moment authority checks for
fresh, reused, and render-only prompt delivery and made the accepted Story agent catalog—not later
live configuration—the verification authority.

These changes remain read-only consumers of already-published history. They do not change an
extractor algorithm, declared input/output, parser identity, permission, Fact vocabulary, View
Contract, cache policy, or publication authority. Because the frozen extractor identity covers the
complete packaged World-Model kernel, the reviewed hardening produces this final mechanical
transition:

| Identity | Prior accepted | Accepted after product-entry hardening |
| --- | --- | --- |
| Packaged WMB kernel | `sha256:6a7b4e5418e79f77a48b2de4bc338c7374c6514992c0ba2c1198a340c8ea870f` | `sha256:d0164edc9b553ce98dfbc143c55d2298428e20901e8b8475dcad6ba9fa0ee516` |
| Coverage implementation | `sha256:fab502f0470ff664e5e1c20bca51def3a60ea90a92843302a6f63f061a1f4a4f` | `sha256:8f728c3e73a266e84e5e57d5435d031be6b3c9cd938cf178f960c4406d274b77` |
| Coverage conformance receipt | `sha256:1ae7923394a0cf22c8692afac504c4e384148bcc913081d574ed28e6de189bc3` | `sha256:2d990a9ed546c48615ac56b6be5c92e54ea6faf9fbcccd6f6262ca0bd8433851` |
| Coverage manifest | `sha256:7f89aaf03bbaf5a79329f887732ede598a7d0906cd5cfb6ebd3bc867a4e7b83d` | `sha256:9ff31e66e22d46fae6b6a689cf5bd54cededa95c158471a575e595c8fe0e1c46` |
| Built-in Extractor Registry | `sha256:1652d0a2c6b04b56e656c0975669f30beb159f0c3a628127ac4a1963b7bbd312` | `sha256:672a8937cbd9310ffe7fa7c91c2b158c4618b14663b8c13d2bdf0f3b1f554d10` |

Focused activation, approved-configuration, progressive-capability, prompt-integrity, Auto, WFA
migration, and governed-publication tests establish the product paths behind this transition. The
repository-wide check, complete World-Model suite, and aggregate suite remain required before the
accepting commit is pushed.

## Package-root isolation acceptance

The final release audit added a source-level guard that forbids an ambiguous lower-camel
`packageRoot` binding in dynamically loaded package code. The public `packageRoot` option remains
compatible, but `source-digest.mjs` immediately aliases it to the explicit local name
`implementationPackageDirectory`. This is a naming-only isolation hardening: extractor behavior,
parser identity, Fact and View Contract vocabularies, permissions, and publication authority do not
change.

The frozen extractor identity covers the exact packaged kernel bytes, so that required safety edit
produces one final reviewed mechanical transition:

| Identity | Prior accepted | Accepted after package-root isolation |
| --- | --- | --- |
| Packaged WMB kernel | `sha256:d0164edc9b553ce98dfbc143c55d2298428e20901e8b8475dcad6ba9fa0ee516` | `sha256:b042f23949f063775180dfc97053afd9150f1aaa836ab77efdde76b5bb1b5fbe` |
| Coverage implementation | `sha256:8f728c3e73a266e84e5e57d5435d031be6b3c9cd938cf178f960c4406d274b77` | `sha256:6785462065946f2637d86290092fff8aaafb091ad85cc7fd1fd09184b27a440f` |
| Coverage conformance receipt | `sha256:2d990a9ed546c48615ac56b6be5c92e54ea6faf9fbcccd6f6262ca0bd8433851` | `sha256:a75a4540d89438146341153fce72ca8de685474d77a4d31d1d498f1ba8beb3c0` |
| Coverage manifest | `sha256:9ff31e66e22d46fae6b6a689cf5bd54cededa95c158471a575e595c8fe0e1c46` | `sha256:a7978d77bee6ad0639d9449e86f9fe0511ce6202ac99f1f2fd680a79425a7a93` |
| Built-in Extractor Registry | `sha256:672a8937cbd9310ffe7fa7c91c2b158c4618b14663b8c13d2bdf0f3b1f554d10` | `sha256:0ddd7ed4a60f4da2b276e1569f2e5163320242d3156da7c8cb999a1ca2616c8d` |

The package-root isolation regression, registry and extractor-conformance suites, exact-history
replay tests, and aggregate release suite own this transition.

## CALM refusal-preservation acceptance

The governed v4/CALM repair at `d3412f5304008dc41f441bc94146357b2a85c75c` preserves typed
optional-projection refusals in the public build result and reports their projection identity in
the completion error. The change is presentation and evidence retention only: it does not change
an extractor algorithm, parser declaration, Fact or View Contract vocabulary, permission, cache
policy, or publication authority. Because extractor identities deliberately bind the complete
packaged World-Model kernel, the reviewed `service.mjs` change still causes a mechanical identity
transition:

| Identity | Prior accepted | Accepted after CALM refusal preservation |
| --- | --- | --- |
| Packaged WMB kernel | `sha256:b042f23949f063775180dfc97053afd9150f1aaa836ab77efdde76b5bb1b5fbe` | `sha256:83f7260677dbcb7a127825b6e06be16e7ad7e3f8c17e34aa3ee81440449e557d` |
| Coverage implementation | `sha256:6785462065946f2637d86290092fff8aaafb091ad85cc7fd1fd09184b27a440f` | `sha256:40795f43ba5a8a474d8b05be7b6fabf52dcc6e23f2cbcc65f15f3b34c1bdc745` |
| Coverage conformance receipt | `sha256:a75a4540d89438146341153fce72ca8de685474d77a4d31d1d498f1ba8beb3c0` | `sha256:9dcf1ab5a80b85bfc0fda3e237109e6e7a02be1a39f8d8477bf4857e7c0ccfab` |
| Coverage manifest | `sha256:a7978d77bee6ad0639d9449e86f9fe0511ce6202ac99f1f2fd680a79425a7a93` | `sha256:71f1680b9cc520b1248fe7172250443d701b0e8e461168bfe2578f712ab93262` |
| Built-in Extractor Registry | `sha256:0ddd7ed4a60f4da2b276e1569f2e5163320242d3156da7c8cb999a1ca2616c8d` | `sha256:f5ddab132c91bd76cb1b51354fc5744b8fa4718a4ef99ac1df57ea0e03bb1e38` |

The CALM publication, v4 registry, extractor-conformance, exact-history replay, and full
World-Model suites own this transition. The accepted identities were derived from the reviewed
source closure; they were not copied from a failed publication.

## Bounded registered-view selection acceptance

The registered-v4 repair on 2026-09-21 corrects a mismatch between the View Contract and the
selector. A required Fact type means that a bounded view must retain at least one registered Fact
of that type; it does not make every repository occurrence individually mandatory. The complete
Fact Ledger remains unchanged and content-addressed. Selection policy v2 now retains one canonical
coverage anchor per required type, every material contradiction, and a deterministic type-balanced
remainder up to the view ceiling. Historical policy-v1 ledgers remain valid and the frozen WMP
overview renderer continues to request policy v1 explicitly.

The deterministic candidate renderer now narrates every coverage anchor and contradiction, then
admits optional selected Facts only while the exact registered section, total-word, and output-token
budgets remain valid. Scope validation also distinguishes registered source-file basenames and
path-qualified symbols from invented compound symbols. No extractor inputs, emitted Fact
vocabulary, parser grammar, permissions, source-body boundary, model policy, or publication
authority changed.

Because extractor identities intentionally bind the complete packaged World-Model kernel, these
reviewed selector, renderer, runtime, and validator changes produce one mechanical transition:

| Identity | Prior accepted | Accepted after bounded selection |
| --- | --- | --- |
| Packaged WMB kernel | `sha256:83f7260677dbcb7a127825b6e06be16e7ad7e3f8c17e34aa3ee81440449e557d` | `sha256:55fe41694090b06cf190fac97047108f7ed689a25f72ce84731a169d78ac97fe` |
| Coverage implementation | `sha256:40795f43ba5a8a474d8b05be7b6fabf52dcc6e23f2cbcc65f15f3b34c1bdc745` | `sha256:c95eacbbcfdc84fca5431e77449e0260fb13ccd51a311c59b9d257e9dbc43382` |
| Coverage conformance receipt | `sha256:9dcf1ab5a80b85bfc0fda3e237109e6e7a02be1a39f8d8477bf4857e7c0ccfab` | `sha256:cc4df68578217f5c232ade54a0fd0551e451b3b18a25b18d6fd46a7d5bc9fae9` |
| Coverage manifest | `sha256:71f1680b9cc520b1248fe7172250443d701b0e8e461168bfe2578f712ab93262` | `sha256:37da766120e488459457e061b4f1e6e1a35e6f93bd4a83e5c8646a4b3ebfdf6b` |
| Built-in Extractor Registry | `sha256:f5ddab132c91bd76cb1b51354fc5744b8fa4718a4ef99ac1df57ea0e03bb1e38` | `sha256:3a4e1e9a031721eddfb101ff154884fe8de36956b0b64996cdbece12266cee55` |

The accepted identities were computed after reviewing the complete changed WMB source closure and
running the large-view, contradiction-preservation, candidate-budget, historical-policy,
persisted-overview replay, extractor, registry, runtime, cache, and live RuleEngineUI validations.

## Bounded composition-input acceptance

The follow-up registered-v4 repair on 2026-09-21 closes the remaining difference between a
count-bounded View Fact Ledger and its serialized model input. A valid `arch.contracts` selection
could contain 60 Facts yet serialize to about 15,634 estimated input tokens, exceeding the
contract's 8,000-token ceiling before the provider was started.

The complete View Fact Ledger remains immutable, content-addressed publication authority. Model
composition now receives a transient deterministic Composition Fact Packet that is bound to that
ledger's SHA-256. The packet always retains every required coverage anchor, required-unavailable
anchor, and material contradiction, then admits optional Facts in deterministic type-balanced
order only while the exact complete prompt remains within the registered input ceiling. Evidence
descriptors are reduced to the admitted Facts. Model candidates are validated against that exact
admitted set at execution, cache replay, publication, and persisted-store read boundaries; an
omitted Fact cannot be cited later. A mandatory-only overflow remains a typed
`WMB_INPUT_BUDGET_EXCEEDED` refusal before provider invocation.

The deterministic renderer continues to use the complete View Fact Ledger and makes zero model
calls. Its execution identity is exact. A model-routed execution identity is recomputed from the
closed installed provider and requested-model profile encoded canonically in the kernel stamp;
unknown providers, malformed profiles, and mismatched digests are refused. The stamp separately
preserves the provider-observed model and invocation ID. The sealed execution receipt is checked
against that stamp, and a deterministic candidate must reproduce the registered renderer
byte-for-byte. Re-labeling or coherently rehashing Markdown therefore cannot bypass the
admitted-Fact boundary.

Reviewed kernel changes are limited to:

- `compose/pinned-core.mjs` and `templates/world-model/pinned-core-v4.md`: deterministic bounded
  packet construction, exact prompt admission, and explicit packet semantics;
- `validate/candidate.mjs`: mandatory-set and admitted-reference enforcement;
- `runtime.mjs`: typed input-budget admission and admitted-set propagation;
- `execution-profile.mjs`, `publish/transaction.mjs`, and `store.mjs`: sealed execution-route
  agreement and admitted-set replay at authority boundaries.

No extractor algorithm, declared Fact type, parser grammar, permission, View Contract, selection
ceiling, deterministic rendering rule, or Git publication authority changed. Because extractor
identities intentionally bind the complete packaged World-Model kernel, the reviewed changes
produce this mechanical transition:

| Identity | Prior accepted | Accepted after bounded composition input |
| --- | --- | --- |
| Packaged WMB kernel | `sha256:55fe41694090b06cf190fac97047108f7ed689a25f72ce84731a169d78ac97fe` | `sha256:fcb6379667299b0f6aadadd7d38881d1734059243b81daca28703e45531e2db5` |
| Coverage implementation | `sha256:c95eacbbcfdc84fca5431e77449e0260fb13ccd51a311c59b9d257e9dbc43382` | `sha256:00d8df6af3fb38e83ab2bec6cf9617c576da513d7fe8921430d437f4c00ce9c1` |
| Coverage conformance receipt | `sha256:cc4df68578217f5c232ade54a0fd0551e451b3b18a25b18d6fd46a7d5bc9fae9` | `sha256:3e494753ecf4352cce00ccb62e115561efa917269d5f525d4aee43f09bc4a109` |
| Coverage manifest | `sha256:37da766120e488459457e061b4f1e6e1a35e6f93bd4a83e5c8646a4b3ebfdf6b` | `sha256:a8c4eeac47f27e0a2305a99a7e6dc2ea300801ea585e13534efd34ab0062ae72` |
| Built-in Extractor Registry | `sha256:3a4e1e9a031721eddfb101ff154884fe8de36956b0b64996cdbece12266cee55` | `sha256:83aaacb514ad8af54819d2aa16b7fd9f3d3b79ddc744c1ab6ae53333ebda0531` |

The large-view regression records 781 complete Facts, 60 selected Facts, 27 model-admitted Facts,
33 omitted optional Facts, and a complete prompt of 7,989 estimated tokens. The composition,
mandatory-overflow, omitted-reference, execution-route, cache, publication, persisted-store,
registry, extractor-conformance, and complete World-Model suites own this transition.

## Portable environment-exclusion identity acceptance

The 2026-09-22 environment-binding review found that configured World-Model exclusions were exact
Git spellings in both the in-memory scope matcher and the scoped-commit pathspec. On default Windows
and macOS filesystems, a case alias, Unicode compatibility alias, or Win32 trailing-dot/space alias
could therefore refer to the same checkout path while escaping an exclusion intended to keep local
environment material out of the model.

The bounded repair changes only these identity-bearing inputs:

- `scope/matcher.mjs` applies the strict portable filesystem identity to exclusions while retaining
  exact Git spelling for allowed and shared authority;
- `source/snapshot.mjs` adds Git's `icase` pathspec constraint for the subset Git can exclude, with
  final NFKC and trailing-dot/space admission still owned by the matcher;
- `source-digest.mjs` includes `src/configuration-assets.mjs`, whose shared
  `portableFilesystemPathIdentity` function is now a transitive executable dependency of the WMB
  scope matcher. This closes the source-identity boundary rather than accepting an unbound helper.

No extractor algorithm, parser grammar, declared Fact type, evidence kind, permission, View
Contract, renderer, composition budget, or publication authority changed. Exact source admission did
change fail-closed, so every extractor implementation identity and the closed registry must move as
one reviewed mechanical transition:

| Identity | Prior accepted | Accepted after portable exclusion repair |
| --- | --- | --- |
| Packaged WMB kernel | `sha256:fcb6379667299b0f6aadadd7d38881d1734059243b81daca28703e45531e2db5` | `sha256:b2e1bfeb1211a022b8e68dd92648087b613fe21b7c79cf33dc4a8763c927f30c` |
| Coverage implementation | `sha256:00d8df6af3fb38e83ab2bec6cf9617c576da513d7fe8921430d437f4c00ce9c1` | `sha256:62f40aecfb586773debdc1c9648bafce6857ec25ad389e24eb943a73c9e4b4cc` |
| Coverage conformance receipt | `sha256:3e494753ecf4352cce00ccb62e115561efa917269d5f525d4aee43f09bc4a109` | `sha256:f46ec45e996dc9e9933829d19dd2e206ad4a22d21a9eb7c545a8a08ac499b7a7` |
| Coverage manifest | `sha256:a8c4eeac47f27e0a2305a99a7e6dc2ea300801ea585e13534efd34ab0062ae72` | `sha256:7ec77d325d22d33e16b60f5a0034f1e3b13e2a94ec893fedcf7bdaf91a6f6624` |
| Built-in Extractor Registry | `sha256:83aaacb514ad8af54819d2aa16b7fd9f3d3b79ddc744c1ab6ae53333ebda0531` | `sha256:95968338f449e6a1628fccf167233e986bde1cd0619724c4e048c0aff6531503` |

The registry, source-digest, and environment-exclusion regressions own this transition. They prove
the frozen identities, installation-independent hashing, case/compatibility exclusion behavior,
and legacy-v3/registered-v4 exclusion boundary together.

## Frozen view-contract schema constant acceptance

**Review boundary:** `main@ab9f5623fa3616d921f7159211c69f126d7e3df7`

Since the last accepted lock at `0ea49942c84f69651f565c71c53903d20cbc951e`, exactly two
packaged kernel paths changed: `registry/views.mjs` now reads the view-contract schema version
from `view-contract-schema-version.mjs`, and that new file fixes the version at `1`. The former
`currentSchemaVersion('world-model-view-contract')` also returned `1`; the migration family remains
immutable with `frozen-identity` policy. Executing the previous and current constructors yielded
identical built-in and persisted-overview View Registry hashes. Contract fields, View policy, and
sealed View identities are unchanged. The coverage extractor and Extractor Registry source blobs
remain respectively `063af8c31e245f2e6280680edd7693ac135e3b86` and
`95d2cfdecb6a4d399d6d36c42c900a9fb99287ba`. No extractor algorithm, fact vocabulary,
parser declaration, permission, cache policy, or publication authority changed.

An independent replay of the source-digest algorithm over Git's packaged bytes reproduced the
previous kernel digest from 109 files and the current digest from 110 files. The extra file and
changed import move every built-in extractor identity mechanically:

| Identity | Previously accepted | Accepted at this review |
| --- | --- | --- |
| Packaged WMB kernel | `sha256:b2e1bfeb1211a022b8e68dd92648087b613fe21b7c79cf33dc4a8763c927f30c` | `sha256:c7fb97c6492ade4be5ac53811ce610faf3fa873f62aea96d5b93f3604d987cde` |
| Coverage implementation | `sha256:62f40aecfb586773debdc1c9648bafce6857ec25ad389e24eb943a73c9e4b4cc` | `sha256:f9325983f02aefdca22556f6945fa7df7fa7aea71c50408dc082ede8cd8f9923` |
| Coverage conformance receipt | `sha256:f46ec45e996dc9e9933829d19dd2e206ad4a22d21a9eb7c545a8a08ac499b7a7` | `sha256:f5b3243bd82794b40e9e8b797eeaf1f40f59d8bf56e70d72508830c0bcf5e33c` |
| Coverage manifest | `sha256:7ec77d325d22d33e16b60f5a0034f1e3b13e2a94ec893fedcf7bdaf91a6f6624` | `sha256:c0848f266a5db5cf27ad59d3058f12f21578be9cab624078fb52ae14060aed56` |
| Built-in Extractor Registry | `sha256:95968338f449e6a1628fccf167233e986bde1cd0619724c4e048c0aff6531503` | `sha256:559285187f036990893a6b062df871b70339be4bed7ee94e8896b21c3e163542` |

The registry, source-digest, persisted-overview, and view-projection owner tests passed (18/18).
The broader 14-file owner run also passed, covering extraction, retained adapters, authority
refresh, runtime, materialization, cache, publication, commands, and View policy. These checks
include the frozen schema version, testing overview's optional `test-impact`, and required
`runtime-frequency` limitation assertions.

## Sanctioned reconciliation rule

1. Never copy a new digest from a failing assertion.
2. Locate the last accepted boundary and enumerate every changed path covered by
   `WMB_V4_KERNEL_SOURCE_SHA256`.
3. Review each path change against the extractor algorithm, declared inputs/outputs, fact
   vocabulary, parser declaration, permissions, View Contracts, cache identity, and publication
   authority.
4. Confirm the extractor, registry, and View Contract source blobs that are claimed unchanged.
5. Run the registry, source-digest, extractor execution/completeness, view-projection, retained-owner,
   source-snapshot, authority-refresh, runtime, materialization, cache, publication, and command
   owner suites. A product failure is never repaired by changing this lock.
6. Update only the reviewed exact identities and add a new review record naming its exact commit
   boundary and validation evidence.

Any future executable WMB change remains fail-closed at this lock until another bounded authority
review establishes whether the change is a semantic contract revision or a mechanical build-identity
transition.
