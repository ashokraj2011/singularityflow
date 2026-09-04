# GDP M4 — intent, testability, impact, and environment observations

GDP M4 adds bounded proof inputs without changing any lifecycle, approval, gate, or publisher.
`singularity-flow proof status <WORK-ID> --json` now includes an `observations` projection when an
exact Candidate exists.

The projection reports:

- exact clause body digests extracted from governed specification artifacts;
- the reviewer checklist decisions that actually exist, leaving unanswered articles as
  `human-review-required`;
- an impact should-set tied to the current Proof Subject and World Model binding;
- an allowlisted environment profile containing platform, architecture, runtime and optional
  toolchain/dependency digests—never hostname, paths, environment variables, or credentials;
- a JUnit 5/Surefire observation for the reviewed Java subset;
- nondeterminism status from exact immediate rerun results when they exist.

## Exact JUnit subset

The local binder reports an exact witness only when all of these are true:

1. The test is in one regular `.java` source file with one unambiguous class identity.
2. It is a zero-argument JUnit 5 `@Test` method in the supported lexical subset.
3. The exact fully-qualified class and method match one Surefire testcase occurrence.
4. The method body contains a recognized failure-producing assertion or verifier call.
5. No parameterized/dynamic/nested test, lifecycle hook, declaration collision, skip, failure, or
   unmatched report occurrence is present.

Anything outside that subset is `unavailable`; it is never guessed from a filename, `@ac:` tag,
line number, or display name. Existing WEL and Code Delivery receipts remain authoritative for
their current assurance levels.

## Availability law

World Model and AST absence never blocks M4. The Proof Subject retains the existing explicit
World Model status, and the observation adds `WORLD_MODEL_UNAVAILABLE_NON_BLOCKING`. Unsupported
languages and test frameworks add capability gaps. Ordinary governed work continues.

All M4 records are immutable v1 identities in the migration registry. They remain observation
inputs only; no M4 module is imported by Story lifecycle, approval, gate, recovery, or publication
code.
