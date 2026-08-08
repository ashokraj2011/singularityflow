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

The fixture topology and runtime are declared in
`benchmarks/dx/reference-fixture.json`: Node 22, Linux x64 on `ubuntu-latest`, 500 tracked files,
four untracked files, four local branches, one Story, and no prebuilt local subject index. The
protocol discards one warm-up and measures at least 30 fresh processes. Network and model calls
are disabled.

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
After reviewing a stable pinned-runner result, establish it with:

```bash
node scripts/dx-benchmark.mjs --write-baseline --json
```

Do not update the baseline merely to make a regression pass. Review topology, runner load,
dependency changes, and the lazy import graph first.

## Diagnose a slow command

Pass `--timings` to see root-dispatch, module-load, and execution stages:

```bash
singularity-flow status WORK-123 --timings
```

Commands also append machine-local timing events under
`.git/singularity-flow/performance/commands.jsonl`. This file is never committed. The VS Code
extension writes each CLI duration to its Singularity Flow Output channel.

The test suite locks the lazy boundary: fast commands may not statically import unrelated Jira,
model, provider, visual, workspace, Initiative, or remote-agent modules.
