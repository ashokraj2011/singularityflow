# Portable repository commit-policy rules

The kernel now owns repository commit-policy and profile normalization, bounded pattern matching,
tracking/message checks, UTF-8 limits and policy digests. Native policy/profile entries invoke
those functions and project their errors. Pattern compilation is a direct kernel alias.

## Rule and execution boundary

The workflow compiler no longer accepts `normalizeCommitPolicyRuntime` as a policy-admission
callback. It constructs the real rule compiler and retains the original opt-in checkpoint. A
frozen `sflow-commit-policy-runtime/v1` port has exactly `profile` and `assertAvailable`; the method
receives no policy data and must complete without returning a value. A readiness object cannot
replace a normalized policy. Capturing the port does not invoke it or a function's `bind` getter.

The native availability assertion retains the actual synchronous-module runtime check and loads
the existing installed policy module, including its required normalizer export. Unsupported
runtimes, incompatible exports and genuine module-loading failures retain their errors at the
original checkpoint. The kernel then validates the complete policy;
availability grants no policy, object, ref, approval or writer authority.

The compiler has eight composition entries: host authoring metadata/ID syntax, record-byte
syntax, commit-text primitives, runtime compatibility, network-address syntax, path syntax and
UTF-8 digests. None is a caller-supplied policy normalizer. Runtime assertions run for each opted-in
definition; caches retain function bindings, not availability, policy acceptance or authority.

Git discovery, hook and formatter execution, candidate verification, signatures, plan admission,
conditional ref updates, remote receive checks and retained execution evidence keep their native
owners. This extraction does not introduce a hook bypass or change commit/publication authority.

## Records, primitives and presentation

Foundation owns the unchanged v1 policy/profile schema metadata shared with the native registry.
The original version ranges, missing-version refusals and immutable record semantics are retained.
The RCP schema stamp derives from that same metadata. Readers never rewrite historical bytes.

The frozen `sflow-text-values/utf8-sha256-v1` port supplies `byteLengthUtf8` and `sha256Utf8`.
Its native binding uses the original Buffer sizing and Node hashing calls, including native
invalid-value exceptions. Rules retain their input-domain checks; the port checks result types
without approximating UTF-8 or hiding genuine primitive failures. The existing digest and byte
port profiles keep their shapes and semantics.

Kernel policy refusals use the shared `PolicyViolation` subtype with semantic details. The subtype
retains the base error's JSON/name/code behavior and adds no command guidance. Native adapters
attach the original RCP guidance and throw the original public base error shape. The installed
configuration adapter only forwards validation and projects these errors; it does not duplicate
definition rules or rerun a failed validation. Raw pattern, schema and primitive errors pass through.
Public native function names, arity, exports and command routes remain unchanged.

## Compatibility evidence

The pre-edit baseline at `15b711b3a` records 107 policy, profile, pattern, message and digest
outcomes, including exact errors and normalized hashes. All 43 original configuration cases and
18 seeded workflow resolutions retain their hashes and mutations. Original rule bodies and
constant definitions retain syntax after the explicit size/hash and schema-reader bindings are
accounted for; native guidance retains its original body in the presentation owner.

The final Mac qualification passed 345 tests across 36 test files with no failures, cancellations
or skips. It covers real Git hooks, signing, publication and recovery in disposable repositories,
alongside the portable rule, compiler, schema and package checks. Source validation passed 3,766
checks; the Git audit retained all 2,011 registered production sites; VS Code and installed SDK
declaration checks passed. All 13 rebuilt bundle budgets passed without increasing a limit: the gateway has 851
modules, the extension 152, Help 135 and Support 111. No Windows or live-provider qualification
was run for this extraction.

Complete namespace-backed configuration and Story execution, remaining query/adapter extraction,
verified authority migration, obsolete-access removal and final distribution/performance
qualification remain required milestones. This rule extraction does not complete them.
