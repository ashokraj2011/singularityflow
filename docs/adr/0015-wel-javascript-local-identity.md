# ADR 0015 — Exact local Jest and Vitest identity without loading Candidate modules

- **Status:** Accepted for observe-only use
- **Date:** 2026-09-06
- **Scope:** One Node module using the Jest or Vitest JSON reporter

## Decision

Provide two explicit WEL profiles, `jest-static-v1` and `vitest-static-v1`, through one closed adapter
registry. Both profiles are optional, local observations. They cannot produce an authenticated pass,
enforcement authority, or a lifecycle decision.

The v1 source subset is intentionally narrow:

- one Git-tracked regular `*.test.*` or `*.spec.*` JavaScript/TypeScript file, or a direct file under
  `__tests__`;
- one or more top-level `// @sflow-ac:<WORK-ID>:AC-NNN` lines;
- an immediately following top-level `test("literal", () => {` or `it("literal", () => {` call;
- a unique top-level JSON-reporter occurrence whose `title` and `fullName` equal that literal and
  whose `ancestorTitles` list is empty; and
- an ordinary complete module test invocation using the matching Jest or Vitest JSON adapter.

Suite-nested tests, dynamic or template titles, `.only`, `.skip`, `.todo`, `.each`, concurrent tests,
focused commands, retries, shards, multiline lexical ambiguity, block comments, generated tests,
duplicate report identities, and nonliteral mappings remain inexact. Unsupported source removes only
the optional exact mapping proposal; the ordinary module test receipt remains authoritative exactly
as it was before this adapter existed.

## Identity and replay

The logical identity binds the credential-free repository-origin digest, source path, framework,
literal test name, and identity schema. The catalog binds the exact UTF-8 declaration range and every
qualified clause marker. The retained reporter JSON is content-addressed and replayed during Code
Delivery verification; aggregate counts must equal the normalized testcase occurrences.

The parser reads at most 256 tracked source files and 1 MiB per file through no-follow descriptors.
It never imports, transpiles, evaluates, or executes Candidate source. Report ingestion retains the
existing 16 MiB per-file, 64 MiB aggregate, and 100,000-occurrence bounds.

## Authority boundary

Every mapping is emitted as `unreviewed`. The existing phase approval form rebinds it to the current
clause body and requires an explicit human decision. Candidate, Program, durable attempt/nonce, and
independent verifier fields remain absent, so the resulting verdict is always `inconclusive` and the
assurance ceiling remains `testcase-local-observed`.

Enabling a profile requires approved repository configuration:

```yaml
codeDelivery:
  tests:
    testcaseExact:
      mode: observe
      adapter: jest-static-v1 # or vitest-static-v1
      requiredWitnessTypes: [test]
      evidenceTier: testcase-local-observed
```

This ADR does not approve CAB authentication, SGOS lifecycle enforcement, remote execution, or any
other JavaScript test shape.
