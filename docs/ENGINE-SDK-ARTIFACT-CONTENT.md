# Portable artifact-content rules

The kernel now owns the authored-text boundary, managed metadata placement, Markdown structure,
placeholder and required-heading checks, prepared-template comparison, byte-size findings and
bounded metadata repair proposals. `kernel/artifact-content.mjs` contains these rules without
filesystem, crypto, source-control, process or model dependencies. The shared exact clause-identity
grammar lives in `foundation/traceability-ids.mjs` and preserves its existing public exports.

Native publication, in-place/manual authoring, recovery, secondary review members and draft checks
use the same rules. Existing public parser/grammar paths remain compatibility aliases. No phase
names are hardcoded: the phase's pinned artifact contract supplies headings, byte limits and
forbidden placeholders. Deterministic Convergence keeps its existing native projection exemption.

## Observations and integrity

`artifactContentObservation` captures authored text, its structural view, UTF-8 size and the exact
normalized text used for the fingerprint. Native code hashes that normalized text and passes the
digest to `inspectArtifactContentObservation`. The kernel checks the contract and returns the
original finding/result shapes. Hash facts come from a trusted adapter, never operation arguments;
the kernel does not claim that a supplied digest independently verifies the observed file.

The normalization retains the existing repeated managed-block removal, checkout newline handling,
trailing-space folding and final trimming. Whitespace padding cannot satisfy an unchanged prepared
template. Managed approved-input blocks do not become author-owned content or make a later phase
fail because its upstream evidence contains a placeholder. Markdown masking preserves source
offsets and line numbers, including comments, fences and inline code.

The native reader still owns descriptor/path identity, path-race protection, exact byte reads,
raw snapshot checks, binary classification and SHA-256. Binary size rules consume an observed
non-negative count; a binary artifact cannot satisfy a text-heading contract. Neither text nor
binary inspection writes files, replaces a publication, executes tests or grants approval.

The same pure UTF-8 counter now serves document-body result validation and authored-text sizing.
It matches native UTF-8 replacement behavior for lone UTF-16 surrogates and avoids allocating an
extra encoded byte array merely to count it.

## Compatibility and remaining scope

The fixture was captured from `029c38cae` before production edits. It binds 37 complete serialized
native inspections, metadata states and repair proposals, and fingerprints the original bodies of
26 parser/grammar/rule functions. Additional tests check compatibility identities, byte counting
across every UTF-16 code unit, malformed observations, binary contracts and real execution with
all infrastructure imports and executable discovery refused.

This advances Phase 5 policy extraction and supplies a prerequisite for portable publication.
It does not implement namespace lifecycle authority or a portable publication writer. Registered
operations still use the existing native admission, required-test, identity, persistence and
recovery owners. Namespace-backed writers and complete headless Story execution remain Phase 7
gates; existing projects keep their current Git authority.

Mac qualification on Node 26.12.0 passed 333 checks across 24 files, without failures, skips or
cancellations. It includes real source/bundled CLI publication, draft/prepublish and document-read
parity; submission/approval; native authoring/recovery and generation tests; specification and
conformance parsing; the externally installed SDK archive; and dependency guards. A regression
also checks multi-member finding priority before path and line ordering.

Source validation passed 3,706 checks, VS Code typechecking passed, and the Git ownership audit
found no new bypasses among 2,011 sites. All 13 unchanged bundle budgets passed; the gateway is
852 modules / 6,786,461 bytes. The standalone artifact-rule bundle has five owned inputs, zero
external imports and 26,184 runtime bytes; this is a component-boundary measurement, not a claim
about complete-command latency. No Windows, hosted CI, provider, installation, push, merge or real
Story mutation ran.
