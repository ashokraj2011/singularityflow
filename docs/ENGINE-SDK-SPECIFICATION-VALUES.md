# Shared specification and verification values

The clause parser, verification contract and intent rules, specification-index identity and bounded
draft diagnostics now have shared kernel owners. This removes their dependency on the installed
Git/filesystem aggregate and makes the same rules usable by an application embedding the SDK.
The native file reader still observes the actual artifact and retains its existing access checks.

## Ownership

`kernel/specification-values.mjs` owns author-visible regions, clause statements and references,
dependency validation, approved verification intent on clauses, body hashes and the native v1 index
value. Hashing uses an explicit frozen UTF-8 primitive. `kernel/verification-policy.mjs` owns exact
test/inspection/visual slots, required assurance, primary/supporting roles, all/any combinations,
planned verification duties and witness mapping identities. Its contract factory captures explicit
path and hash syntax; it accepts no readiness, exception or approval callback.

`kernel/draft-diagnostics.mjs` owns the bounded collector and its single overflow ledger. All old
imports delegate to that same instance. The native value adapter binds only existing path/hash
primitives. Native `verification/contracts.mjs`, `verification/intent.mjs` and `draft-diagnostics.mjs`
are compatibility facades. The old specification exports remain aliases to the shared rules.
Runtime consumers import the explicit owners directly; the old facades remain available to existing
callers without adding three compatibility modules to the shipped gateway closure.

The optional SDK `specifications` entry exposes the pure factories and helpers. The separate
`specifications/node` entry supplies Node value bindings, without reading a repository, discovering
a checkout or invoking Git. These are value utilities; business execution continues through the
versioned operation registry. No new lifecycle operation or second publication route is introduced.

## Compatibility

The native index builder still normalizes policy before resolving a safe repository path, reads
Markdown before observing its file snapshot, extracts clauses and then constructs the index. Its
optional write still uses the same canonical serialization. The source digest and byte count come
from the actual file observation, including a file whose native UTF-8 decoding replaces invalid
bytes. They are not recomputed from the decoded text.

Specification-index v1 keeps its fields, readable range, immutable flag and existing migration
classification. There is no new timestamp or kind field. Clause identities, source line numbers,
body boundaries, dependency order, verification decisions and hash serialization are unchanged.
Real missing-file, unsafe-path and filesystem errors remain native failures.

Before production edits, native commit `60002eefe` produced the 89 value outcomes and four actual
file indexes in `test/fixtures/specification-values/native-v1.json`. The fixture records original
function fingerprints. It includes 42 successful outcomes and 47 refusals, covering clause forms,
managed/example regions, cycles, external definitions, verification methods, exact paths, assurance,
retained evidence, normalization, hashes and diagnostic bounds. Both shared and native facades must
reproduce those independent outcomes. Separate filesystem tests check writes, unsafe symlinks and
policy/error ordering. Architecture tests enforce one rule owner and the native observation order.

## Integration still required

An index value is candidate data. A caller providing a digest does not prove file ownership, source
provenance, authority, immutable retention or publication readiness. Namespace application publication
must still verify approved specification/claim records against their accepted receipts and supply
every required code-delivery, coverage, exception, constitution and artifact-set policy owner.
Those publication requirements remain enforced.

Claim-map normalization is not moved by this change. Its native clock call occurs after validation
and contributes to the serialized byte limit; changing that order would change its behavior.
The remaining Phase 5, 7, 8 and 9 milestones stay open. Qualification is Mac-only; this change does
not merge, push, install, invoke a model or modify any real user Story.

## Qualification

The Mac runs passed 177 specification/delivery/clarification/amendment regressions, 60 review,
decision and lineage cases, 72 architecture checks and 28 installed-package checks: 337 distinct
tests, with no failures, cancellations or skips. The two opt-in specification/continuation cases
ran in the slow lane. A final 28-case witness/continuation rerun passed after the last lazy-import
replacement. The installed consumer uses no SFlow checkout and an empty PATH; it blocks implicit
infrastructure imports from the pure entry, reproduces native indexes, uses the optional Node
binding and typechecks the actual packed declarations.

Source validation passed 3,956 checks across 191 skills. VS Code typechecking and the unchanged Git
ownership audit passed. All 13 existing bundle budgets passed without increasing a ceiling; the
gateway has 852 modules against its 852-module limit. The optional SDK retains 57 operations across
190 owned modules and 1,844,296 JavaScript bytes. These results qualify the shared values and native
compatibility, not complete namespace application publication or installed authority migration.
