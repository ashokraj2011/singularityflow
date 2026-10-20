# Shared-read performance

This change removes duplicate work from session read projections. It introduces no persistent
authorization cache and does not change the existing advisory-cache interval or mutation gates.

## Findings and changes

- `session current` loaded the complete configuration twice: once for accounting and once for
  discovery. This repeated secured source reads, YAML parsing, agent scans, template checks and
  definition validation. Closed current/status/context reads now share one invocation scope;
  accounting projects only its logging/harness preferences from the same secured source.
- A pinned/amended current session uses the accepted Story loader rather than today's unrelated
  live agent catalog. The context broker preserves its guidance-only read contract and retains
  the exact verified interpretation when amended/custom phases require it. Legacy live policy
  is still fully validated; malformed retained closures are not accepted as current configuration.
- The current-session response already contained its verified checkout and revision, but building
  its execution-context projection independently rediscovered root, paths, object format, bare
  status, HEAD and branch. The projection now receives the revision that its owner just captured.
  It remains advisory and cannot authorize a write.
- Session file readers repeatedly asked for the private Git directory after root discovery had
  already proved it. Only explicit read scopes reuse that directory. Outside them, the original
  fresh Git query and error fallback remain unchanged.
- Read-only session discovery imported the full state-store gateway just for a configuration
  alias and pure Work ID validation. Those now use their canonical read/pure owners, retaining the
  old exports. Configuration location declarations live with the existing asset policy rather
  than importing bootstrap/clone code to obtain two strings.
- The current-session projection is moved, not reimplemented, into a narrow handler. Closed forms
  load it directly; unknown/effectful options retain the existing adapter and refusal handling.
  Its source closure fell from 429 local files / 8,513,597 bytes to 208 / 3,767,730 bytes. This static
  reduction alone is not an elapsed-time claim. Existing root and bundle ceilings remain enforced.

Phase authoring, publication, approval, session attachment/takeover and explicit refresh do not
inherit this new reuse policy. Failed reads do not become empty successes, later invocations see
edits, and separate/concurrent read scopes do not share their mutable observations.

## Measurement protocol

```sh
node scripts/shared-read-paired-benchmark.mjs --baseline-engine=/absolute/baseline --samples=4 --output=/absolute/results.json
```

Both engines are built into the installed cold-layout bundle. Paired A/B and B/A requests use
independent local clones and compile-cache directories. Each first request has no prior private
provenance/advisory receipt; its immediate repeat uses a new Node process with the same caches.
The OS file cache is not flushed. This is not a persistent-worker benchmark.

The legacy corpus has 20 source files. Pinned and amended corpora have 1,000 source files,
50 additional history commits and eight artifacts. Successful pairs check returned binding parity.
The baseline refuses current/context reads for the amended fixture with `AGENT_PHASE_UNKNOWN`;
that exact refusal is retained, and the successful candidate's Story identity is checked. Those
rows are correctness repairs, not speed comparisons, and have no percentage gain.
Setup, builds and cloning are untimed. Measured reads use no model or remote network operations;
the results do not estimate complete Story or native Copilot round-trip savings.

Reports retain every sample, physical Git spawns, command stages, secured configuration source
reads and catalog counters. Those file counters cover their instrumented boundaries, not all
filesystem access. Native Windows claims require a report whose platform is `win32`.

## Qualification

Native paired results and the final latest-main regression results will be recorded here after
qualification. No unmeasured platform gain or full-suite/release qualification is implied.
