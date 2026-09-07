# Developer-experience performance

Singularity Flow treats command latency as a release property. The repository fast-path commands
are `about`, `status`, `nextsteps`, and a repository-only `snapshot` slice. The machine-state reads
used repeatedly during editor activation—`workspace list`, `workspace current`, `workspace prompt`,
and `capability leads`—also use bounded lazy modules. They do not load the legacy CLI monolith,
Jira, model, visual, or Initiative domains unless a different subcommand actually requires one.

Audited improvements that are deliberately deferred are tracked with stable IDs and exit gates in
the [pending-work roadmap](PENDING-WORK-ROADMAP.md). That backlog does not change the current
budgets or authorize implementation.

## Budgets

On the pinned CI runtime and reference fixture, warm-command p50 must be at most 150 ms for all
four commands. Every measured interactive read has an explicit p50 and p95 ceiling; repository-only
snapshot p95 must be at most 250 ms. A comparable accepted
baseline also rejects a p50 or p95 regression greater than 20 percent, even when the absolute
budget still passes.

`help`, `inbox`, `guide` and `logs` are measured too, and budgeted separately and much higher. They
are reads served by the legacy dispatcher rather than by a lazy command module, so each pays about
120 ms loading `cli.mjs` and its 264-module closure before doing anything — 166 to 231 ms in total
against the fast four's 37 to 102 ms. The budgets record that rather than wish it away. The number
to lower is the module load, and lowering it is what should lower these.

The fixture topology and runtime are declared in
`benchmarks/dx/reference-fixture.json`: Node 22, Linux x64 on `ubuntu-latest`, 500 tracked files,
four untracked files, four local branches, one Story, and no prebuilt local subject index. The
protocol discards one warm-up and measures at least 30 fresh processes. Network and model calls
are disabled.

## The growth tier

A budget on one repository size cannot say a command does not get more expensive as the repository
grows, and that is the more useful sentence. The `scale` tier in the same manifest runs `status`,
`nextsteps`, the repository-only snapshot, the repository/lifecycle/capabilities snapshot used by
VS Code, and `snapshot --json` again on 10,000 tracked files, 40 Stories and 12 branches. It gates
each on **how many subprocesses it ran relative to the reference fixture**.

A count is used rather than a clock deliberately: it is the same on a fast runner and a loaded one,
so it can carry a complexity claim. `status`, `nextsteps` and the sliced `snapshot` are pinned at
exactly 1.0 — they answer the same question on both fixtures and must not need more processes to do
it.

`snapshot --json` is pinned at 2.0. It first measured 966 subprocesses against 68 — a 14.21× growth —
because `buildRepositorySubjectIndexFromRefs` spawned two Git processes per branch × Story pair.
Reading one tree per ref instead (`src/git-ref-tree.mjs`) took that to 108, a 1.59× growth. What
remains is linear in refs and not in Stories, which is correct: twelve branches genuinely hold twelve
trees to read. Never raise it.

The VS Code snapshot is allowed 1.3×: it currently adds one bounded read for each additional branch
(37 processes against 29), while the repository grows 20× and its Story count grows 40×. That cap
keeps the real editor refresh in the scale test and refuses any return to per-file or per-Story work.

Pass `--skip-scale` to leave the tier out of a quick local run.

## The working-tree tail tier

The reference fixture's four untracked files are not representative of an active IDE checkout. The
`workingTree` tier therefore stages 64 renames, modifies 64 other tracked files, and carries 128
untracked files before repeatedly running the exact VS Code snapshot. Its p50, p95, and maximum are
reported so release runs expose tail behavior. Its enforced contract is machine-independent: the
subprocess count may grow by at most 1.2× from the clean reference, so a save or watcher burst cannot
turn refresh into one subprocess per changed path.

## Independent topology-tail fixtures

Three repository shapes are measured independently because averaging them into the reference fixture
would make a slow result impossible to diagnose:

- `ignoredBuildTree` creates 4,096 real ignored outputs under 64 directories and verifies Git exposes
  them as one ignored directory entry;
- `cleanSubmodule` adds one real, clean local Git submodule without using the network;
- `linkedWorktree` runs from a linked checkout (where `.git` is an indirection file), with 64 modified,
  64 renamed, and 128 untracked paths nested five directories deep.

Each tier records its own p50, p95, maximum, subprocess count, and growth from the clean reference.
The report maps the pre-existing scale and working-tree tiers to the many-Story/ref and rename/untracked
requirements, so coverage is explicit rather than inferred. Reports identify Node, Git, OS,
architecture, temporary-filesystem case behavior, and the absence of a VS Code host separately. No
repository path is retained. Pass `--skip-tail-fixtures` for a quick local run; accepted release
baseline candidates must include all three.

## Run the benchmark

```bash
npm run benchmark:dx
npm run benchmark:dx:enforce
node scripts/dx-benchmark.mjs --json
```

The report includes runtime, topology, sample count, p50, p95, minimum, maximum, and coefficient
of variation. `--enforce` exits non-zero on a budget or comparable-baseline regression.

The checked-in baseline starts as `unestablished`. The first release run is therefore explicit:
it evaluates absolute budgets and prints a warning, but does not claim a relative comparison.
After reviewing a stable pinned-runner result, establish it on the pinned runner with:

```bash
node scripts/dx-benchmark.mjs --write-baseline --json
```

Or save the pinned runner's complete JSON report and import it on another host:

```bash
node scripts/dx-benchmark.mjs --json > /tmp/sflow-dx-report.json
node scripts/dx-benchmark.mjs --accept-report=/tmp/sflow-dx-report.json
```

Both paths validate the exact Node major, platform, architecture, sample count, disabled-network
protocol, fixture topology, reviewed runner label, and passing outcome. The pinned hosted runner
must set `SINGULARITY_FLOW_DX_RUNNER_LABEL=ubuntu-latest`; that label is admitted only when the
process also reports a GitHub-hosted Actions environment with the reviewed Linux/x64 runner OS and
architecture. Any other label is reduced to `runner: local` rather than retained. Local and
container reports cannot replace the Linux/Node-22 accepted baseline.

Do not update the baseline merely to make a regression pass. Review topology, runner load,
dependency changes, and the lazy import graph first.

The connected-ledger fixture and production ledger initialization do not require the newer
`git worktree add --orphan` option. They construct the same isolated empty root through a detached
`--no-checkout` worktree, worktree-local symbolic `HEAD`, and an empty index, preserving compatibility
with the enterprise Git floor while still proving that the state branch shares no application
history.

The compatibility replay at `main@35b30fa0` used Node 22.23.2 and Git 2.39.5 in a clean Linux x64
container. The connected fixture created the orphan ledger, resolved 24 durable intents across four
remote branches, and reported zero network calls and zero repository writes on the read path. Its
wall-clock values are not an accepted baseline because the x64 process was emulated on an arm64
laptop; this receipt proves the Git-floor behavior only.

## Real VS Code extension-host benchmark

The CLI benchmark cannot prove that VS Code remains responsive. The repository therefore also
ships a runner that launches the supplied VS Code application itself through
`--extensionDevelopmentPath` and `--extensionTestsPath`. It measures a cold and warm host process,
activation, cached and confirmed sidebar paints, unchanged and changed refreshes, a 100-event
governed-file storm, a heavyweight Help webview open, event-loop delay, CLI process concurrency,
CPU, extension-host RSS, and Linux `/proc` child RSS. It never substitutes the Node stub host.

```bash
# Fast, non-enforcing smoke run against the current `code` installation.
npm run vscode:host-benchmark -- --profile=current --samples=1

# Accepted current-host exercise.
npm run vscode:host-benchmark -- --profile=current --samples=30 --enforce \
  --out=/tmp/sflow-vscode-current.json

# Run separately with an exact VS Code 1.90.x installation.
npm run vscode:host-benchmark -- --profile=minimum --samples=30 --enforce \
  --vscode=/absolute/path/to/code --out=/tmp/sflow-vscode-minimum.json
```

The reviewed limits live in `benchmarks/dx/vscode-host-budgets.json`. `minimum` refuses anything
other than VS Code 1.90.x; `current` refuses versions older than 1.90. Network and model access are
disabled, every fixture is disposable, and reports contain no repository path, Work ID, identity,
question, artifact, command output, or source bytes. Linux records peak child RSS from `/proc`;
other platforms report that measurement as unavailable instead of inventing it. Platform-specific
budgets declare their applicability in the reviewed budget file; an enforced report records the
host platform and every not-applicable metric. An unavailable Linux-only child-RSS measurement is
therefore accepted on macOS and Windows, but remains a hard failure on Linux.

On macOS the launcher resolves the real extension-host executable from the app bundle's
`CFBundleExecutable`, with bounded `Code`/`Electron` compatibility fallbacks. This is required
because VS Code 1.90.x used `Electron` while current releases use `Code`; the CLI path alone does
not reveal that difference.

A non-enforcing run reports `incomplete` when any required cell is absent or any measured CLI child
fails. Fast process failure is never accepted as good latency. The warm projection is retained in a
bounded, repository-hashed, atomic file below VS Code's machine-local global storage, with Memento
only as an upgrade fallback; this survives disposable cold/warm host processes without syncing
repository content. `--enforce` requires every cell, at least 30 cold/warm pairs, and every profile
budget. Do not relabel a projection-ready timestamp as a paint or a stub-host result as VS Code.

In a real editor host, activation no longer awaits the machine-wide workspace inventory or the
fresh repository snapshot. All commands and providers are registered first; a retained cache can
paint when VS Code resolves the view, then one background read confirms it. Capability readiness
and workspace logs remain behind that confirmed snapshot and are skipped when their approved scope
does not exist. First-run health also waits until after confirmed paint. Explicit Refresh hashes the
small machine selection record and invokes `workspace current` only when those bytes changed or the
record cannot be observed safely. Stub-host contract tests retain the awaited path so their
assertions do not race fire-and-forget work.

The accepted current-profile exercise at `main@06e73c40` ran 30 cold/warm pairs (60 real VS Code
1.136.1 host processes) on macOS arm64. It passed with zero failures: load plus activation p95
248.2 ms, activation p95 193.4 ms, cached first paint p95 201.4 ms, confirmed first paint p95
670.2 ms, unchanged refresh p95 384.7 ms, changed refresh p95 543.6 ms, Help webview opening p95
273.0 ms, and cache persistence p95 11.9 ms. A 100-event watcher burst used one CLI child and one
sidebar render in every sample, and every measured CLI child exited successfully. The content-free
report SHA-256 is `0a4aa4cb9613ac51cde365b64da9613d4670eb20ca9c3b92cb09a391916fc718`.
Moving status derivation to a bounded
off-host worker, keeping the planner and panel graphs in explicit lazy bundles, and writing the
retained snapshot through the atomic machine-local cache reduced activation event-loop p95 to
26.4 ms. The explicit shared context entry also ensures lazy panels cannot erase or inherit the
wrong repository selection.

A continuous steady-state observer now spans preflights and the transitions between narrower
surface probes; the aggregate no longer hides a pause merely because a stage-local observer was
reset. Content-free transition attribution localized the previous 55.3 ms diagnostic tail to the
turn immediately after Help. Help had loaded the complete multi-panel graph, so the first request
paid delayed garbage collection for unrelated configuration, organisation, SGOS, and lifecycle
panels. A dedicated Help runtime loaded in 24.5 ms p95 and kept the accepted aggregate and
continuous steady-state event-loop p95 at 45.3 ms without raising the 50 ms ceiling.

The same report now records this process's peak RSS independently for activation, unchanged and
changed refresh, watcher storm, Help, and cache persistence. The accepted p95 values were 167 MB,
170 MB, 177 MB, 182 MB, 203 MB, and 215 MB respectively; the per-process peak is judged once per
host sample rather than flattening six stages and allowing a common high stage to hide below p95.
Child-process RSS remains a separate Linux `/proc` measurement and stays explicitly unavailable on
macOS and Windows.

The minimum-profile exercise at `main@5b48b559` ran another 30 cold/warm pairs (60 real VS Code
1.90.2 host processes) on macOS arm64 and also passed with zero failures. Load plus activation was
239.7 ms p95, activation 183.2 ms p95, cached paint 190.0 ms p95, confirmed paint 618.0 ms p95,
unchanged refresh 423.4 ms p95, changed refresh 601.7 ms p95, event-loop delay 48.3 ms p95, and
extension-host peak RSS 149.5 MB p95. The content-free report SHA-256 is
`4c46cd2938b5dba6086a20bf200502e54fda74f3328645cbd6bd012ebc0c7042`.

This closes both editor-profile 30-pair cells on macOS. It does not replace the pinned Node 22/Linux
relative baseline, Linux child-process RSS, Windows, office-network evidence, or signed
platform/package receipts; those distinct cells remain open.

### Bundle and module-closure budget

Every emitted CommonJS entry has a reviewed byte and source-module ceiling in
`benchmarks/dx/vscode-bundle-budgets.json`. The gate builds the extension, reads only `.cjs` sizes
and unique source counts from its source maps, refuses a missing or unbudgeted entry, and emits no
path or source content. The total JavaScript ceiling is separate from per-entry ceilings so adding a
new lazy bundle cannot evade the package cost contract by keeping each individual file small.

```bash
npm run vscode:bundle-budget
node scripts/vscode-bundle-budget.mjs --json --out=/tmp/sflow-vscode-bundles.json
```

At `main@a745a505`, eight entries contain 27,901,673 JavaScript bytes and all byte/module ceilings
pass. The release script runs this gate even when local tests are skipped in favor of an exact
signed verification receipt. Bundle and module ceilings may be lowered after accepted evidence;
they must not be raised merely to admit a regression.

## Bounded aggregate verification

`npm test` no longer starts one unbounded all-files process. It creates eight deterministic,
largest-first shards, runs at most two shards concurrently with one Node test file per shard, and
gives each shard a 30-minute wall-clock deadline. The process-tree supervisor terminates the Node
runner and its CLI, Git, extension-host, and model-provider descendants after a deadline or bounded
output overflow. The unusually expensive Auto fixture is assigned a dedicated scheduling weight so
its measured 17-minute local runtime is not hidden behind another hundred test files.

Every shard writes a machine-local receipt under `.git/singularity-flow/test-runs/`. A receipt binds
the exact commit, tree, selected-test content digest, platform, architecture, Node version, shard
layout, completion counters, and strict-skip policy. A retry on the same clean checkout reuses only
exact passing receipts and runs only incomplete shards. Dirty checkouts always rerun because their
uncommitted implementation bytes are not represented by the Git tree.

```bash
# Normal resumable aggregate.
npm test

# Strict clean-checkout aggregate used before release evidence is signed.
npm run test:release:aggregate

# Tune execution without removing its bounds.
node scripts/run-test-aggregate.mjs all --shards=8 --workers=2 --deadline-ms=1800000

# Inspect or retry one exact shard.
node scripts/run-test-suite.mjs all --shard=3/8 --list
node scripts/run-test-suite.mjs all --shard=3/8 --deadline-ms=1800000
```

The aggregate prints a standard Node test summary, so existing verification-receipt parsing remains
compatible. Sharding changes scheduling only: deterministic disjoint file-set digests prove that
every discovered test file appears exactly once.

The current liveness hardening at `main@03825387` also routes `SIGINT` and `SIGTERM` through the
same bounded process-tree shutdown used for timeouts. The aggregate waits for detached descendants
to quiesce and prints an exact retry command. Exact authority-state hashing no longer streams bytes
to a Git child waiting on stdin EOF; it uses a bounded private temporary file and the same Git
deadline instead. A strict Node 20.20.2/macOS arm64 replay (`658a7530de082ce517cf5042`) selected 469
files and passed 4,708/4,708 tests with no failures, cancellations, skips, or todo.

## Git-heavy workflow operations

Capability onboarding, workspace creation/repair, configuration refresh, and Story start use one
operation-scoped remote session. Identical `ls-remote` questions are coalesced within that operation,
then invalidated immediately after a successful mutation. The cache never crosses CLI invocations
and keys the exact credential-free remote rather than its display-redacted label.

Independent repositories are cloned, fetched, and inspected with a bounded worker pool. Clone waves
stage into privately owned directories and claim targets only after every required repository has
succeeded; every unclaimed stage is removed even when a claim callback or journal write fails.
Configuration-refresh object caches are machine-local, ownership-checked, integrity-verified, and
never treated as authority: the exact remote refs are revalidated before publication.

VS Code gives workspace mutations a 30-minute host timeout while each Git subprocess retains its
shorter operation deadline. A Start Work host timeout renders the exact CLI command so the same
operation can be resumed in a terminal without restarting completed journal steps.

At `main@bb162a7c`, a definitely new non-interactive Story that omits its required base refuses
before approved-configuration resolution and remote inventory. The refusal provides a read-only
base-preflight command and a separate `resume <WORK-ID> --fetch` route for an existing remote Story.
Local durable Stories still resume without network access, while a cached remote-tracking Story is
still fetched and resumed. The regression test enables the subprocess probe and requires zero
`git ls-remote` and fetch calls on the missing-base path, so office latency cannot be paid before
this deterministic input refusal.

`npm run release`, `npm run release:dry`, and `npm run poc:release-gate` run the enforcing form
automatically. This repository intentionally carries no hosted workflow; the local release gate is
the authoritative enforcement path and always checks absolute budgets. The relative 20-percent
comparison additionally applies when the release host matches the accepted baseline runtime and
topology.

## Diagnose a slow command

Pass `--timings` to see root-dispatch, module-load, and execution stages:

```bash
singularity-flow status WORK-123 --timings
```

The timing line also names the resolved operation and counts remote Git work by closed-vocabulary
category (`probe`, `configuration`, `push`, and Git verb). It never records arguments, repository
URLs, paths, refs, identities, or file content. This makes capability, workspace, and Story-start
regressions enforceable by operation count even when office proxy latency varies between runs.

Commands also append machine-local timing events under
`.git/singularity-flow/dx/timings.jsonl`. This file is never committed, contains no command
arguments, rotates at 5 MiB, and retains rotated logs for 90 days by default. The limits can be
changed with `SINGULARITY_FLOW_DX_TIMING_MAX_BYTES` and
`SINGULARITY_FLOW_DX_TIMING_RETENTION_DAYS`. The VS Code extension writes the same versioned,
privacy-safe duration envelope to its Singularity Flow Output channel, including successful,
failed, timed-out, and cancelled commands.

The test suite locks the lazy boundary: fast commands may not statically import unrelated Jira,
model, provider, visual, workspace, Initiative, or remote-agent modules. The activation reads also
have explicit static-closure ceilings (25 modules for workspace reads and 10 for capability leads),
and byte-for-byte parity tests compare their human and JSON output with the legacy implementation.
