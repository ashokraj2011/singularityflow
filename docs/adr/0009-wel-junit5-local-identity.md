# ADR 0009 — Exact local JUnit 5 identity without executing Candidate code

- **Status:** Accepted for the observe-only pilot
- **Date:** 2026-09-05
- **Scope:** One Maven module, JUnit Jupiter, and Maven Surefire XML

## Decision

Use the JDK compiler tree API as the production parser for the first WEL exact-identity pilot. The
packaged Java source-file helper parses syntax with `JavaCompiler`, `JavacTask`, `Trees`, and
`SourcePositions`. It does not compile, load, initialize, reflect on, or execute Candidate classes.

The initial exact subset is intentionally narrow:

- one repository-tracked regular `src/test/java/**/*.java` file;
- one package declaration and one top-level class identity;
- a zero-argument, `void` JUnit Jupiter `@Test` method;
- an exact literal `@Tag("sflow-ac:<qualified-clause-id>")`;
- annotations resolved through explicit imports, same-package declarations, or fully qualified
  names; wildcard or ambiguous resolution is unsupported;
- one unique Surefire occurrence matching the exact `package.class#method` identity.

Parameterized, repeated, dynamic, template, factory, nested, overloaded, inherited, generated, and
ambiguous tests remain inexact. Lifecycle methods are not test declarations. A display name is
never sufficient identity.

## Identity and bounds

The logical identity binds the normalized origin digest, repository-relative source path, package,
top-level class, method, signature, and identity schema. The declaration binding hashes the exact
UTF-8 byte range reported by the parser. The catalog additionally binds every declaration,
diagnostic, parser manifest, tracked-source list, and content digest.

The adapter permits at most 256 source files, 1 MiB per file, 10,000 declarations, 30 seconds, and
4 MiB of helper output. It rejects symlinks, path traversal, malformed NDJSON, duplicate source
paths, invalid ranges, invalid digests, and mutated source bytes. The Java process receives only a
minimal environment and repository paths through stdin, not argv.

## Reconciliation

Surefire XML remains hostile Candidate-controlled input. The existing hardened XML reader performs
containment, no-follow, hard-link, size, entity, suite, result, and mutation checks. The WEL adapter
then joins a qualifying report occurrence to exactly one static declaration. Missing, duplicate,
parameterized, or ambiguous joins are inconclusive.

The adapter emits an unreviewed mapping proposal. The Story submission snapshot rebinds that
proposal to the current approved clause body; a human must decide it in the existing phase approval
form. Neither the parser nor a model can approve semantic adequacy.

## Portability and fallback

The helper uses Java 11-compatible source APIs. A JRE-only machine, missing compiler, incompatible
JDK, timeout, parser failure, unsupported source, or missing origin produces an explicit diagnostic
with `exact: false`. It cannot fail module-level Code Delivery publication and cannot enable WEL
enforcement.

