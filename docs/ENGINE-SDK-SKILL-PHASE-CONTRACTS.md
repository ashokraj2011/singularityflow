# Portable skill-phase contract compilation

The complete skill-phase lowerer and configured-policy reader now belong to
`kernel/skill-phase-contract.mjs`. Native WCA, workflow creation and configuration compilation
use the same functions over explicit path-value and UTF-8 digest capabilities. The workflow
compiler owns the reader directly; its composition has eight entries instead of nine, and a
caller cannot supply `validateConfiguredSkillPhase` as an admission callback.

## Ownership and versioning

The kernel checks candidate/catalog/contract identities, output and input bindings, read/write
scope, approved checks, artifact sets, code-delivery requirements, confirmation digests and the
complete compiled policy hash. It returns ordinary policy and reference data. Catalog provenance,
retained package bytes, genuine human plan confirmation, import/activation and execution authority
remain with WCA, package admission and lifecycle owners. Successful lowering grants none of those.

The header-only reader stays in `kernel/skill-binding-header.mjs`; phase-role inspection does
not need to construct a complete compiler. The native skill entry binds known primitives and
reexports the existing function/profile names. No skill-binding, parser or persisted record
version changes.

Path syntax v2 adds POSIX dirname/relative operations and Win32 absolute-path detection. V1 retains
its original closed field set, three POSIX methods and existing normalization behavior; extra
fields are still rejected. Complete compilation and configuration-asset rules explicitly require
v2. This changes an internal runtime capability, not a stored workflow format. The native adapter
supplies v2, and its capture does not invoke a primitive or a function's bind accessor.

`foundation/portable-paths.mjs` owns the unchanged component/identifier and portable path-value
identity rules. Configuration-asset boundaries live with the kernel's path policies. Native
transport addresses remain in the configuration read-scope owner. Existing asset exports alias
these owners, including the original frozen default policy. Deriving that asset default uses
only immutable Node string primitives, just as its original native initializer did; complete
skill-compiler construction does not execute primitives.

The foundation package declares only the portable value helper free of module-time effects.
An architecture guard verifies its deferred functions and literal initialization, and requires
every other foundation module to remain explicitly effectful for bundling purposes. Fixed Node
bindings and private immutable tables can be omitted when unused; no bundle limit was raised.

## Compatibility evidence

The pre-edit baseline at `4d460d001` captures 30 complete skill-contract outcomes, including four
accepted policies/proposals and 26 exact refusals, 50 portable-value outcomes, eight asset-policy
declarations and twelve asset-path decisions. Thirty-five rule bodies and seventeen initializer
definitions retain exact syntax fingerprints. The full skill module's former import-only proof
is superseded by these rule/identity checks; its old fingerprint remains recorded with the reason.

Remaining configuration schema, marketplace, runtime and source-control compatibility, complete
namespace-backed Story execution, verified authority migration and final distribution/performance
qualification retain their full milestone scope. This extraction does not activate alternate
authority for an existing project.

## Mac qualification

The affected suite passed 449 tests across 44 files, with no failures, skips or cancellations.
It covers the captured contract and asset results, configuration and read-scope authority,
workflow creation, SKP admission and metadata, native publication parity, portable filenames,
foundation boundaries and actual SDK/VS Code package consumers. Windows path-value cases run
as ordinary deterministic values on Mac; this does not claim native Windows qualification.

Source validation passed 3,758 checks. VS Code typechecking and the Git-boundary audit passed;
the audit retains 2,011 registered production sites. All thirteen existing bundle budgets pass:
the main extension has 152 modules and 1,286,577 bytes, prewarm has 23 modules and 104,331 bytes,
and the gateway has 851 modules and 6,822,477 bytes. Installed authority, CLI results and retained
policy identities remain unchanged. No hosted CI, live provider run or installed-project
migration is part of this slice.
