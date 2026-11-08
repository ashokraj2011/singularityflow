# Shared configuration declarations

The workflow compiler now calls sixteen more configuration rules directly from
`src/kernel/configuration-declarations.mjs`. Its native collaborator count falls from 42 to 26.
Callers cannot replace these rules with alternate validators or readiness callbacks. The existing
configuration adapter still supplies all remaining packaged collaborators; request data cannot
construct a compiler or confer configuration approval.

The shared rules normalize analysis bounds, source boundaries, logging preferences, ledger and
external-document storage declarations, branch patterns, agent-template references, token-reporting
preferences and retired settings. They also interpret code-delivery output/task declarations and
retain the prohibition on autonomous convergence loops. Ledger branch/remote and storage-provider
names are configuration data. Actual ref selection, backend selection, execution and persistence
remain outside this module.

## Ownership and compatibility

Twenty-five function bodies move unchanged from eleven native modules. Native compatibility
exports retain their function and constant identities. In particular, retired-setting diagnostics
share one WeakMap with the compiler; a native `removedSettings` query reads the same observations
that validation produced. Six internal bindings keep remaining native helpers on the original
shared declarations rather than copying constants or private helpers back into those modules.

Nineteen constant initializers retain their original syntax. The private analysis-key list becomes
an equivalent frozen literal so kernel initialization has no computed calls. Its exact order and
membership are checked against both the native baseline and the shared default declaration.
Every extracted function body retains its pre-extraction syntax fingerprint.

Native modules retain filesystem discovery, environment overrides, log redaction and sinks,
rotation, storage-provider delivery, branch rendering, document/asset parsing, convergence
execution, record migration and command guidance. The authoring-skill catalog and backend-specific
state-authority lookup remain explicit compatibility collaborators. No source-control authority,
identity, approval threshold, record version, error code or workflow outcome changes.

Production named imports use the shared owner; native reexports preserve existing API consumers.
The CLI build identity, VSIX runtime manifest and both workflow-intent interpretation digests name
the new owner, so later policy changes cannot bypass installation or invalidate the wrong catalog.

## Scope

These rules are a prerequisite for portable configuration validation. They do not yet make the
whole compiler independent of its remaining path/runtime/schema/asset collaborators, approve a
namespace configuration or create a Story. Production configuration admission, Story initialization
and the complete namespace lifecycle still belong to Phase 7. Verified migration and final
distribution/performance qualification retain their full Phase 8–9 scope.

## Qualification

Mac qualification on Node 26.12.0 passed 378 tests across 27 files, with no failures,
cancellations or skips. The native baseline at `9374138c5` records 67 declaration outcomes,
including 27 refusals, their input mutations and the complete native export inventories.
All 25 extracted function bodies retain their original syntax fingerprints. Nineteen constant
initializers retain theirs; the analysis-key literal has an explicit value/order check against
its original defaults. Compatibility tests also verify shared identities and diagnostic state.

The full workflow-compilation baseline, all eighteen configured workflows, existing policy
baselines, native ledger behavior, convergence, logging, branch naming, readiness configuration,
workflow intent, native Story journeys, CLI/SDK publication parity, actual SDK archive installation
and VS Code packaging passed. Compiler construction refuses replacement of all sixteen newly
shared validators. One new test initially used a generic `code` artifact where the existing legacy
rule requires `implementation-summary`; the test fixture was corrected, without changing the rule.

Source validation passed 3,741 checks. VS Code typechecking, the Git ownership audit (2,011
sites), all thirteen existing bundle budgets and whitespace checks passed. The gateway is 848
modules and 6,801,134 bytes; no budget was raised. Repositories, remotes, machine state and package
consumers are isolated. No Windows, hosted CI, live provider, installed-project migration, product
installation, push or merge was performed.
