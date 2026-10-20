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
  Its source closure fell from 429 local files / about 8.51 MB to 208 / about 3.77 MB. This static
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
Summaries use the upper observed median (sorted sample at index `floor(n / 2)`), without
interpolation. Four-pair gains are directional measurements, not confidence bounds or guarantees.

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

The local Apple Silicon Mac comparison uses clean baseline `322e75e3` and candidate `112b954f`,
Node 22.14.0 and four alternating pairs per row. Values are elapsed milliseconds; positive gains
mean faster. These are installed CLI requests, not native Copilot or complete-Story latency.

| Story / request | Cold before → after | Cold gain | Warm before → after | Warm gain |
| --- | ---: | ---: | ---: | ---: |
| Legacy / session current | 343.74 → 316.78 | 7.8% | 205.19 → 174.52 | 14.9% |
| Legacy / session status | 319.29 → 309.17 | 3.2% | 178.75 → 168.40 | 5.8% |
| Legacy / session context | 314.83 → 302.38 | 4.0% | 174.75 → 163.38 | 6.5% |
| Pinned / session current | 436.89 → 389.61 | 10.8% | 223.50 → 177.59 | 20.5% |
| Pinned / session status | 397.91 → 381.54 | 4.1% | 186.29 → 169.81 | 8.8% |
| Pinned / session context | 324.92 → 293.91 | 9.5% | 185.58 → 153.48 | 17.3% |
| Amended / session status | 560.71 → 543.67 | 3.0% | 232.49 → 216.31 | 7.0% |

For `session current`, physical Git children fell from 12 to 6 on legacy and warm pinned reads,
and from 25 to 19 on cold pinned reads. Status dropped one Git child. Context retained four Git
children on the ordinary pinned/legacy fixtures; its gains are from reduced loading/validation,
not fewer Git commands. Legacy source reads/parses fell from two to one for current and three to
one for status/context. Full legacy catalog scans fell from two/three to one; pinned current
uses its accepted closure instead of scanning the unrelated live agent catalog.

The `phase enter` and `nextsteps` controls were largely flat: ordinary legacy/pinned measurements
varied by less than 1%. Amended cold phase entry was 6% slower in this small local sample, with
identical Git counts and a 0.4% warm difference; no phase-entry speedup is claimed. Amended
current/context changed from the known baseline refusal to successful, correctly bound responses
and are intentionally excluded from percentage comparisons.

The native Windows x64 comparison uses the same clean revisions, Node 22.23.3 and four pairs.

| Story / request | Cold before → after | Cold gain | Warm before → after | Warm gain |
| --- | ---: | ---: | ---: | ---: |
| Legacy / session current | 1636.53 → 1265.94 | 22.6% | 996.90 → 774.79 | 22.3% |
| Legacy / session status | 948.70 → 818.02 | 13.8% | 624.75 → 557.69 | 10.7% |
| Legacy / session context | 903.57 → 809.74 | 10.4% | 602.11 → 606.85 | -0.8% |
| Pinned / session current | 1893.45 → 1534.02 | 19.0% | 1016.72 → 706.94 | 30.5% |
| Pinned / session status | 1407.79 → 1279.90 | 9.1% | 697.89 → 600.60 | 13.9% |
| Pinned / session context | 920.81 → 733.56 | 20.3% | 681.46 → 549.52 | 19.4% |
| Amended / session status | 2757.54 → 2655.30 | 3.7% | 1092.36 → 1004.70 | 8.0% |

Windows Git-spawn counts match the Mac counts above. The Windows `phase enter` controls varied
from -3.5% to +2.3%, while `nextsteps` varied from -6.3% to +14.5%, with unchanged Git counts.
Those controls and the one flat/slightly slower warm context row do not support a universal
command-speed claim. The earlier Windows baseline/candidate run also improved pinned current by
15.9% cold and 29.6% warm, before the latest-main integration. None of the runs are an OS cold-boot
or native Copilot round-trip measurement.

Qualification also repaired portable test fixtures: module-name assertions normalize native path
separators, exact-byte sync/drift fixtures pin LF checkout bytes, and the unsafe-cache-ancestor
case exercises a Windows junction rather than skipping. The workspace-attach rail now runs on
Windows as well. Only its unavailable-cloud-file observation/download failure is injected there;
the actual detector, CLI, Git attachment and recovery execute. This is not live OneDrive-provider
qualification. The existing release reporter still refuses skipped, cancelled and todo tests.

The paired runtime reports were frozen at `112b954f` after integrating `322e75e3`; subsequent
commits change portable test fixtures and this report, not production modules or bundle logic.
Native benchmark run `39438231290` retains the raw samples; its preliminary validation failures
are not a passing qualification. The corrected full-Story run `39441659750` passes on both hosts
with checkout conversion enabled, one test and zero skips per host. The final targeted native
regression run `39443693511` passes 100 tests on each host with zero failures, cancellations, skips
or todo cases, and passes product validation, VS Code typechecking and the VS Code build on both.
Local extended session/configuration tests also pass 99 cases without skips. Source/bundle budget
and parity guards remain enabled. No full-suite or 1.0 release qualification is implied by these
scoped results.
