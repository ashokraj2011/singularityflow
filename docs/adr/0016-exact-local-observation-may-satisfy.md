# ADR 0016 — Exact local observations may satisfy verification contracts

- **Status:** Accepted (SPEC-E2G M3, decision D1)
- **Date:** 2026-10-03
- **Supersedes:** ADR 0008 (WEL authority and two-plane storage) and ADR 0015 (exact local Jest and
  Vitest identity) where they make exact local observations permanently non-gating. ADR 0009 is
  superseded where it ties criteria to tests with `@Tag("sflow-ac:…")`.

## Context

ADR 0008 and 0015 admitted exact local test identities only as observe-only diagnostics: a
verdict of `inconclusive`, never `passed`, with the module test receipt as the sole authority. That
left a criterion "verified" whenever an `@ac` comment appeared anywhere in a changed test file and
the module's test command exited 0, so a skipped, filtered, missing or unrelated test still counted
(SPEC-E2G §12 criteria 7 and 8 failed). The evidence evaluator needs a criterion's own test result.

## Decision

1. **One tag vocabulary.** A criterion is tied to a test by an `@ac:<NAMESPACE>:AC-NNN` marker in a
   comment directly above the test's declaration. `@sflow-ac` and JUnit `@Tag("sflow-ac:…")` are
   retired and bind nothing. A marker that is not directly above a declaration binds nothing exact.
2. **Exact identity by adapter profile.** `jest-static-v2`, `vitest-static-v2`, `junit5-surefire-v2`
   and `junit5-gradle-v2` read declarations as data (`src/verification/`): Jest/Vitest by file,
   literal `describe` path and literal title (single, double or substitution-free template
   quotes), revision = the whole call including its body; JUnit 5 by `package.Outer$Nested#method`
   and signature through the JDK compiler tree API, with lifecycle hooks allowed and folded into a
   support digest. Parameterized declarations (literal `.each` tables, `@ValueSource`,
   `@CsvSource`, `@RepeatedTest`) have declaration-level identity: every instance must pass and the
   count must match; dynamic sets are inconclusive (D14). Every other result adapter only counts
   tests and is capped at module-observed. Gaps are reported per declaration, never per module.
3. **Immutable attempts.** Each run of a required test command is a `test-execution` v5 attempt:
   attempt ID and nonce, parent attempt, purpose (preflight, submission, epoch), candidate commit
   and tree, command, selection and environment digests, how the process ended, counts, every
   occurrence and content-addressed raw reports. Failed and preflight runs are recorded; nothing is
   overwritten. The latest terminal eligible attempt is authoritative (D15).
4. **Exact local observations may satisfy contracts (D1).** The evaluator joins each exact witness
   to exactly one occurrence of its own identity in the authoritative attempt of the published
   candidate. Its outcome is one of missing, ambiguous, unverified-skipped, flaky, failed or passed;
   only passed satisfies, inside a run that completed and succeeded. Such a pass is labelled
   **exact-local-observed** and may satisfy a criterion's verification contract and gate decisions.
   Assurance has two facets: identity (declared or source-bound) and execution (none,
   module-observed, exact-local-observed, exact-authenticated).
5. **Required assurance (D2).** A criterion requires the strongest assurance its tests' module runner
   can reach, and never less than module-observed. A pass below that is an assurance shortfall, not a
   pass: repair the test configuration, approve another witness, or accept the risk with the
   `assurance-shortfall` category.
6. **No promotion.** Exact-local-observed is a local observation of candidate-controlled tests. It is
   never relabelled as authenticated by approval or configuration. Exact-authenticated stays
   unreachable until qualified execution (M4) exists.

## Consequences

- An unrelated passing test in the same file, module or run no longer verifies a criterion whose
  module has an exact adapter; neither do skipped, filtered, missing or duplicate tests.
- The observe-only WEL receipt projection (`testcaseObservation`, mapping proposals in test
  receipts, `codeDelivery.tests.testcaseExact`) is retired; configuring `testcaseExact` is refused.
  Witness adequacy review (E2G-014) is a separate decision over these exact witnesses.
- Exact-local evidence is only as honest as the test code it observes, so semantic adequacy review
  of each witness remains a human decision (E2G-014).
- `test-execution` v1–v4 records belong to archived pilot Stories and are not read (clean break).
