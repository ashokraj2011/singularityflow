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
four commands. Repository-only snapshot p95 must be at most 250 ms. A comparable accepted
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
protocol, fixture topology, and passing outcome. A developer laptop cannot accidentally replace a
Linux/Node-22 accepted baseline.

Do not update the baseline merely to make a regression pass. Review topology, runner load,
dependency changes, and the lazy import graph first.

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
