# Swift support: implementation and qualification boundary

Reviewed baseline: `main@eae00f9d`; implementation branch: `codex/swift-readiness-traceability`.
Date: 2026-10-05. Existing Stories and approved repository configuration were not modified.

## Implemented increment

- Deterministic manifest-only SwiftPM detection. `Package.swift` is captured but never evaluated
  during inspection; `Package.resolved` and `.swift-version` join the readiness source hash.
- Root SwiftPM structured test inference, including a colocated Node tooling build. A Swift
  repository cannot qualify for the automatic zero-command receipt.
- `swift test --parallel --xunit-output .sflow/results/swift-tests/tests.xml`; directory-based
  JUnit parsing collects both `tests.xml` and `tests-swift-testing.xml`. XCTest-only and Swift
  Testing-only output remain usable. No XML means unavailable evidence; zero cases cannot pass.
- Readiness creates the secured report directory and clears the known pair before execution.
  Only those exact untracked generated paths are exempted from source drift. Tracked reports,
  unknown XML, links, hard links and nested output are preserved and refused when clearing.
  Publication retains its existing transient staging, freshness and candidate-isolation protocol.
- Counts retain companion failures and skips. Readiness's existing policy allows disclosed skips
  if at least one test passed and none failed; it does not convert skipped cases into passed tests.
- Xcode project/workspace manifests produce an explicit target-selection gap, not an empty
  receipt or guessed simulator. Nested-only SwiftPM roots produce a structured-contract gap.

The current Swift profile remains `module-counts-v1`, ceiling `module-observed`. Report identity
text alone does not prove which source declaration ran or that an acceptance criterion is met.
This increment does not install the extension, migrate Stories or approve any evidence.

## Local validation

206 distinct targeted regressions passed across Swift readiness, shared manifests, readiness
runtime, smart initialization, verification adapters, code-generation assurance, candidate
isolation and publication preflight. The Swift suite uses fixture reports and injected execution;
it does not stand in for a native Swift runner. `npm run check` passed 2,325 checks, and both
`npm run vscode:typecheck` and `npm run vscode:build` passed. Native Swift qualification remains
blocked as described below. This is not a whole-repository release-suite or installed-host result.

## Native qualification blocker

On this Mac, `swift --version` and `swift test --help` returned exit 69 because the Xcode license
has not been accepted. The user must review any license themselves. SDK-independent JavaScript
regressions are not native Swift compilation, runner or installed-UI qualification.

SwiftPM has historically differed in XCTest XML generation in nonparallel mode and in how it
names the Swift Testing companion output. The inferred command addresses known reporting shapes,
but unsupported toolchains must fail as missing/invalid evidence, never fall back to exit-code
success or advertise exact proof. Qualification must record the actual toolchain and raw reports.

## Next implementation increments

1. **SwiftSyntax catalog.** Use a source-accurate SwiftParser/SwiftSyntax visitor over captured,
   bounded test source. Do not execute candidate modules, macros or package manifests to discover
   declarations. Bind helper/toolchain identity, source file/span and support-code hashes.
   Preserve `@ac` comment attachment before attributes; report unattached and duplicate tags.
2. **Separate exact profiles.** Qualify XCTest class/method identities independently from Swift
   Testing suite/function identities. Join only exact retained runner identities. Display names
   alone, unsupported parameter instances, conditional declarations, dynamic enablement and
   missing/ambiguous results must remain gaps. Skips cannot satisfy exact clause evidence.
3. **Swift-specific annotation qualification.** The shared producer repair loop now exposes
   approved clause/path mappings and file-bound progress for CLI, Copilot and IDE handoff, without
   a separate per-tag approval. It requires the producer to verify the existing behavior/assertion,
   and leaves ambiguous mappings to clarification. Swift-specific declaration attachment and
   exact runner matching still need the catalog/profiles above; routine tag repair cannot elevate
   Swift's current module-observed ceiling or turn tags into proof of test execution.
4. **Xcode and platform qualification.** Add an explicitly selected scheme/destination route
   with retained result-bundle parsing separately from SwiftPM. Qualify native macOS and supported
   Linux/Windows SwiftPM cells and installed CLI/IDE behavior. Do not treat simulator destinations
   or Apple-only SDK availability as portable defaults.

These are pending work, not enabled or completed functionality.

## Reference material

Consult the SwiftPM test CLI documentation, SwiftSyntax parser documentation, Swift Testing
documentation and XCTest reporting notes for the approved toolchain. Retain native toolchain
and report evidence during qualification; documentation alone is not execution qualification.
