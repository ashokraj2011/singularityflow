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
