# Configuration rules over explicit path syntax

Ten configuration validators now belong to the kernel instead of native filesystem modules.
The compiler binds them directly and replaces thirteen native collaborators with one immutable
path-syntax capability. Fourteen collaborators remain, including the three profile constants,
catalog/schema/runtime/graph compatibility and the syntax port. This is another prerequisite for
standalone configuration admission; it does not approve configuration or create a namespace Story.

## Boundary

The kernel defines `sflow-configuration-path-syntax/v1`. Its frozen port declares the POSIX or
Win32 native grammar and seven string operations: native absolute-path detection, normalization
and parsing, POSIX absolute-path detection, normalization and basename, and native-separator
conversion to forward slashes. Construction checks and captures methods without invoking them
or evaluating accessors. These capabilities neither inspect a filesystem nor grant file access.

The native binding supplies the Node implementation using `node:path` only. The legacy `util.posix` helper
retains its native implementation until utility cleanup in Phase 9; moving it would add the new
contract modules to every small utility consumer. The explicit port preserves that helper's separator
semantics without importing its filesystem and process dependencies. The native configuration
adapter instantiates kernel rules over that port; it contains no validators or
project lookup. Cached policy bindings preserve the same function/constant identities across
native callers and compiler construction. Separate policy factories allow unused families to be
removed from narrow bundles. The string contract lives with its kernel rules and its Node assembly
with the native binding, avoiding extra module layers in lightweight help and support commands.

The kernel owns source scopes and exclusions, Story-root normalization, artifact sets, AST policy,
fault-repair configuration, constitution paths, injection declarations, external command syntax,
test-selection paths, supplemental document policy and test-recovery configuration. Environment
identifier/secret-name declarations and risk-category data also have a shared pure owner.
Filesystem reads, YAML/Markdown parsing, process execution, credential retrieval, source-control
effects, test execution and evidence admission stay with their existing native/SGOS owners.

## Compatibility

Twenty-nine extracted rule bodies, the unchanged legacy separator helper and thirty-one constant
initializers retain their pre-extraction syntax.
This includes protected-path checks, repair budgets, absolute runtime-root requirements, reserved
environment names, document exclusions and the failed-test review prerequisites. No validator is
replaced by a readiness callback. Request data cannot supply the syntax capability or override a
kernel-owned rule.

The baseline at `ca749991b` captures 76 native outcomes for each POSIX and Win32 value grammar.
The Win32 baseline binds the original modules to Node's Win32 string primitives on this Mac; it
is not native Windows execution or filesystem qualification. Both sets retain values, input
mutations and exact errors. The native default continues to use its own platform grammar.

Build identity, the VSIX runtime manifest and both workflow-intent interpretation digests include
the kernel contract/rules and native binding owners. Existing installed Git
authority, source records, approval policy and lifecycle behavior remain unchanged. Remaining
configuration compatibility, Story initialization, full headless lifecycle execution, verified
migration and final distribution/performance qualification retain their full milestone scope.

## Mac qualification

On Node 26.12.0, the focused compiler/path/architecture run passes 64 checks without failures,
cancellations or skips. Its path corpus preserves all 152 original POSIX/Win32 value outcomes,
and the compiler corpus preserves the existing 43 cases across all 18 shipped workflows. The
native constructor now captures 14 collaborators instead of 26, including the explicit syntax
port; the removed validator callbacks cannot be reintroduced as caller overrides.

The broader run covers 481 checks across 38 files. It initially reports 476 passes, one stale
source-ownership assertion and four skipped installed-runtime checks. That assertion already
failed at the preceding commit: citation validation had moved from `state.mjs` into the native
publication owner. The corrected wiring test checks both delegation and the retained enforced
citation refusal; its complete 16-check file passes on rerun. Together these results cover 477
passing checks. The four pytest/Maven checks need explicit isolated executable/dependency-root
bindings and remain unqualified; they are not counted as passes or final release qualification.

Source validation passes 3,745 checks. VS Code typechecking, the unchanged 2,011-site Git bypass
audit and all 13 existing bundle budgets pass. The gateway is 849 modules / 6,805,402 bytes;
help and support retain their preceding 135/111 module counts, and lazy panels use 310 modules.
No budget was increased. The same fixed kernel factories serve native and compiler consumers;
unused native binding projections can be removed by the bundler without dropping external effects.

All Story repositories, remotes, machine registries and package consumers are isolated fixtures.
No Windows, hosted CI, live provider, product installation, merge, push or real-project authority
migration ran. Remaining configuration admission, portable Story execution, verified cutover and
final cleanup/distribution/performance qualification are still required.
