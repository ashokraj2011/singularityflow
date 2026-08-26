# Developer-experience performance

Singularity Flow treats command latency as a release property. The fast-path commands are
`about`, `status`, `nextsteps`, and a repository-only `snapshot` slice. They use lazy command
modules and do not load Jira, external storage, model, visual, workspace, or Initiative domains
unless the requested state actually requires one of them.

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
`nextsteps`, `snapshot` and `snapshot --json` again on 10,000 tracked files, 40 Stories and 12
branches, and gates each on **how many subprocesses it ran relative to the reference fixture**.

A count is used rather than a clock deliberately: it is the same on a fast runner and a loaded one,
so it can carry a complexity claim. `status`, `nextsteps` and the sliced `snapshot` are pinned at
exactly 1.0 — they answer the same question on both fixtures and must not need more processes to do
it. `snapshot --json` is pinned at 15, which records what is true rather than what would be nice: it
runs 966 subprocesses against 68, because `buildRepositorySubjectIndex` spawns two Git processes per
branch × Story pair. Lower that number when the index reads one tree per ref; never raise it.

Pass `--skip-scale` to leave the tier out of a quick local run.

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

Commands also append machine-local timing events under
`.git/singularity-flow/dx/timings.jsonl`. This file is never committed, contains no command
arguments, rotates at 5 MiB, and retains rotated logs for 90 days by default. The limits can be
changed with `SINGULARITY_FLOW_DX_TIMING_MAX_BYTES` and
`SINGULARITY_FLOW_DX_TIMING_RETENTION_DAYS`. The VS Code extension writes the same versioned,
privacy-safe duration envelope to its Singularity Flow Output channel, including successful,
failed, timed-out, and cancelled commands.

The test suite locks the lazy boundary: fast commands may not statically import unrelated Jira,
model, provider, visual, workspace, Initiative, or remote-agent modules.
