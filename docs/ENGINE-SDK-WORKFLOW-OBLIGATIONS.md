# Shared workflow obligations and record identities

The workflow route compiler and phase-responsibility rules now belong to the kernel. Native
configuration, workflow creation, evidence and SDK composition use these same functions. A
primitive digest capability replaces the compiler's native `compileObligationGraph` callback;
request data cannot replace the rules with a readiness result.

## Boundaries

`kernel/workflow-obligations.mjs` owns route construction, forward/backward responsibility
analysis, omissions, endpoint findings, startability and the graph/shape records. It binds one
frozen UTF-8 SHA-256 capability, without invoking it during construction. Binding caches only
the function; each input graph is recomputed. No graph, authority or evidence result is cached.

`kernel/phase-responsibilities.mjs` owns the structural scope, planning, implementation,
verification and review roles. Existing names remain native compatibility exports. The native
obligation binding supplies the real Node digest primitive and contains no workflow validator,
project lookup, filesystem, process or provider operation.

The shared record foundation owns canonical formatting alongside durable-record version/format
admission. Its historical pretty form sorts object keys recursively, uses two-space indentation
and ends in a newline. Its compact form keeps the same key ordering and trailing newline. This
is the installed serialization contract, including its existing legacy values and exceptions;
it is not replaced by another canonicalization scheme. Native `recordSha256` and discrepancy
identity functions retain their bodies, and existing formatter exports alias the pure owner.

`sflow-text-digests/sha256-utf8-v1` describes a synchronous primitive over text. Its closed frozen
port has only `profile` and `sha256Utf8`. Admission captures data properties without invoking
the method or its bind accessor. Calls require a string and exactly 64 lowercase hexadecimal
characters; native failures propagate unchanged. The port does not establish record validity,
authorization, approval or persistence. Higher-level readers retain those responsibilities.

## Compatibility evidence

The baseline at `5e2d5771a` captures 22 complete graph outcomes, including findings, endpoints,
both content digests and pinned records. Another 27 cases capture both record formats, native
hashes and historical exceptions. Eighteen moved/retained function bodies and eight constant
initializers have exact syntax fingerprints. The 220 callers changed only by import redirection
retain their complete non-import syntax; their original files were captured with one batched
Git object read. The interpretation-catalog inventory changes separately to name the real rule
and identity owners.

Build identity, VSIX source admission and both workflow-intent interpretation hashes include
the shared graph/responsibility rules, native binding, record foundation and native digest owner.
Installed Git authority, record versions, human approvals, source publication and recovery keep
their existing paths and rules.

This is a prerequisite for portable configuration admission. The remaining schema, skill-package,
marketplace, runtime and source-control compatibility, complete namespace-backed Story execution,
verified migration and final distribution/performance qualification still need their deliveries.

## Mac qualification

On Node 26.12.0, 688 checks across 39 files pass with no failures, cancellations or skips.
They cover the unchanged graph/record corpus and caller syntax, all 43 original configuration
cases across 18 workflows, family/version admission, ledger verification, filesystem and SQLite
namespace conformance/durability, application-journal transactions, cross-process namespace reads,
lifecycle commit/replay and terminal v1/v2 records, project enrollment, SGOS persistence/runtime
fan-out, native skill compilation, WCA finalization, workflow intent, packed SDK consumers and
CLI/SDK publication/decision parity. The initial focused eight-file run passes 89 checks.

A final nine-check run also passes after adding an explicit semantic-independence regression:
even a syntactically valid digest result and caller-provided readiness fields cannot suppress
missing route responsibilities. This tests rule ownership, not the trustworthiness of an arbitrary
application-supplied digest implementation; the native port is independently checked against
known SHA-256/UTF-8 vectors and the preserved original record hashes.

Source validation passes 3,754 checks. VS Code typechecking, the unchanged 2,011-site Git audit
and all thirteen existing bundle budgets pass. The gateway retains 851 modules and measures
6,806,985 bytes; neither its module ceiling nor any other budget was increased.

All machine registries, Story repositories, Git remotes, database/filesystem stores and package
consumers are isolated fixtures. No Windows, hosted CI, live provider, product installation,
merge, push or real-project authority migration ran. Complete portable configuration/lifecycle
execution, verified authority cutover and final distribution/performance qualification remain open.
