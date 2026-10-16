# Cold-start and native intake performance

The installed CLI uses coarse ESM bundles instead of parsing the entire legacy engine on every
request. There are at most 20 generated module files, including six private worker/CLI entries.
Static dependency closures are assigned once in priority order. Shared error classes, operation
contexts, read scopes and mutable caches keep one identity. New inter-chunk static cycles fail
the build. Worker programs with top-level listeners are never merged into shared chunks.

The CLI's initial static closure is about 1.33 MB rather than the monolithic control's 16.49 MB.
Tiny common helpers matter: the deferred-index completion check is a core dependency, not a route
through the compatibility/admin chunk. Status, session, intake, hooks and maintenance have explicit
families; unrelated domains stay deferred. Esbuild strips whitespace after Rollup assigns modules;
it does not re-bundle or duplicate them. The old monolithic layout remains an explicit control.

Bundle format 2 retains live build-stamp validation and source fallback. One directory roster
checks the generated regular files, rather than one stat per chunk. Missing files, unsupported
formats and unsafe names use the source runtime. Format 1 installations remain compatible.

## One native Copilot intake entry

`/sf-start` begins with:

```sh
singularity-flow workspace branches --entry --intake --work-id YOUR-ID --for-agent --json
```

Pause precedes Git. The packet combines the refreshed selected workspace, installed build,
personalized reply name, clean-tree check, existing-ID check and canonical branch/workflow
catalog. It asks for explicit choices; it does not authorize creation. Missing selections, dirty
work and existing IDs remain distinct conditions. The ordinary selected-base preflight and its
private receipt stay separate. Creation revalidates live authority and repository deltas.

The branch-preview implementation is shared by the thin workspace command and the legacy route,
not copied into a second readiness engine. No global workspace-health scan or duplicate CLI
lookup is required just to obtain the same intake facts. `act` differentiates asking for choices
from continuing after a passing selected-base preview, avoiding a new preview loop.

## Optional bytecode preparation

Hooks now enable Node's compile cache where its APIs are available, as the CLI already did.
The installer and reinstall transaction run `singularity-flow --warm-runtime` after verifying the
final installed build. This imports an allowlist of pure startup-definition chunks; it does not
dispatch repository commands, worker programs, tests, models, approvals or publication.

An unsupported runtime, disabled/unwritable cache or failed preparation falls back to normal
execution and does not fail installation. Installation cancellation is still honored. A different
Node/runtime/source/path invalidates the bytecode cache normally. No authority or permission
decision is cached. Verified hook executable discovery remains unchanged; this work does not
trade executable validation for a blind PATH cache.

## Local qualification

Run the portable paired fixture with:

```sh
node scripts/cold-start-benchmark.mjs --samples=5 --files=1000
```

[Machine-readable results](../benchmarks/cold-start/local-macos.json) record the runtime, complete
manifests, protocol and distributions. The recorded run used macOS arm64, Node v25.5.0, five samples,
1,000 source files, 20 unrelated branches and a local bare remote. CLI/intake samples alternate
layouts. Each cold sample has a fresh private compile-cache directory; a subsequent child process
uses that directory again. The OS file cache is not flushed. There are no model calls or public
remote operations, and each created Story's exact published remote tip is checked. Fixtures are
removed in `finally`.

| Measured stage | Monolithic control | Coarse bundles / composed intake |
| --- | ---: | ---: |
| Version, empty compile cache | 263 ms | 82 ms |
| Pause, empty compile cache | 267 ms | 105 ms |
| Repository slice, empty compile cache | 317 ms | 156 ms |
| Status, empty compile cache | 285 ms | 189 ms |
| Next steps, empty compile cache | 343 ms | 267 ms |
| Empty guard hook, empty compile cache | 155 ms | 84 ms |
| Initial intake lookup sequence | 895 ms | 391 ms |
| Story creation and publication after that lookup | 1,412 ms | 1,493 ms |
| Current-session lookup, empty compile cache | 538 ms | 547 ms |

These are medians, not guarantees. Initial intake lookup improves about 56%, but creation alone
is about 6% slower in this fixture and current-session lookup is essentially unchanged. Do not
describe this as a universal speedup or a measured complete-Story/model-token saving. The intake
comparison includes eliminating four separate CLI launches plus a Git-status lookup; the other
comparisons isolate packaging on the same source. The monolithic control already contains the
new canonical branch-preview extraction, so this is not a claim to measure every change against
the previous release.

Native Windows timing, PowerShell startup, antivirus/OneDrive effects, native Copilot round trips,
enterprise network latency and full repository histories remain unqualified. The Windows path-ID
mapping and portable code paths have regression tests, but are not a substitute for running this
fixture and a real intake on Windows. Fresh publication, identity, authority, review and test
semantics are unchanged. Author and independent-reviewer execution are not combined.

## Regression coverage

Tests cover source/bundle CLI output and refusal parity, edit denials, private worker isolation,
shared module identity, Windows-style module IDs, complete deployment/stamp selection, missing
chunks, packaged resource paths, optional prewarming without worktree changes, pause before Git,
canonical intake choices and draft preservation. Installed VS Code staging is exercised as well;
new runtime files must be committed before its tracked-payload staging can qualify them.

Existing generation, publication, submission, approval-authority and independent source-review
tests were also run with the bundled CLI selected. The repository checker validates the locked
dependency closure, revision producer hash, generated skills/help catalogs and reviewed Git sites.
