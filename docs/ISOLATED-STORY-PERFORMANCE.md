# Isolated Story creation performance

For the later fresh-request Git batching, shared configuration and VS Code preparation work, see
[First-request isolated Story performance](FIRST-REQUEST-STORY-PERFORMANCE.md). The measurements
below remain the earlier parallel-checkout comparison.

This follow-up profiles the isolated `start --isolated-worktree` transaction used by VS Code.
The control is `main` at `35fb9efaf046acf8dcd52401b6a0932ab7fb44cf`; the implementation is
`4b98d7309b9af48bdf983b8530d9ea1a49d58b8c`. No workflow gates or approval policies change.

## Bottlenecks and changes

The initial 10,000-file profile spent about 700 ms in `git worktree add` and 780 ms in the
publication transaction. Switching branches and the final index update each cost about 75 ms.
These are measured spans, not estimates of a Windows office laptop.

1. **Bounded parallel checkout.** When `checkout.workers` is positively absent, worktree creation
   asks Git to use at most four checkout workers, capped by available CPU parallelism. An explicit
   worker setting (including `0` or `1`) wins. Git keeps checkouts below 2,000 eligible entries
   serial by default; an explicit `checkout.thresholdForParallelism` is retained. Unreadable,
   malformed, timed-out or failed optional
   configuration probes use the ordinary Git path. The setting is command-local, never written to
   repository, global or approved SFlow configuration. Normal hooks, filters, sparse checkout,
   line-ending conversion, file modes and Git's own error handling remain in place.
2. **Retain verified stat metadata in the owned checkout.** The isolated start's clean-tree check
   can let Git save freshly verified timestamps in its private index. It changes no staged object
   IDs or file contents. Ordinary UI/read snapshots remain non-locking; explicit host
   `GIT_OPTIONAL_LOCKS` policy is preserved. A busy optional index lock is not a new readiness gate.
   This is filesystem metadata reuse, not a cached readiness, permission or test verdict.
3. **Scope the publication index update.** `commitIsolated` still synchronizes exactly the owned
   index entries after advancing the ref, but uses `reset --no-refresh` to avoid statting the whole
   application again. Candidate admission, secret scanning, stability checks, compare-and-swap,
   checkout-race detection, unrelated staged edits and deferred-index recovery remain enforced.

The detailed timing now includes `start.worktree.checkout`. The existing top-level worktree
progress event remains unchanged. The optimization deliberately adds one bounded configuration
read and up to four short-lived Git workers: it reduces elapsed I/O time, not physical process
count. No background push, implicit baseline test, dependency install or model invocation is added.

To explicitly choose serial checkout, an operator can set their normal Git policy:

```sh
git config --local checkout.workers 1
```

## Qualification

The [paired results](../benchmarks/story-creation/isolated-macos.json) record macOS arm64,
Node v25.5.0 and Git 2.54.0. Both variants use the same installed coarse bundle layout, stock
feature workflow and local bare remote. Candidate/control order alternates. Compile caches are
separate and initially empty; the OS file cache is not flushed. No test jobs ran alongside the
qualification. Every created Story's exact local and published remote tips matched. Temporary
fixtures and private compile caches are removed in `finally`.

| 10,000 files, five samples per variant | Control median | Candidate median |
| --- | ---: | ---: |
| Complete isolated creation and publication | 2,523 ms | 2,402 ms |
| Worktree preparation | 646.5 ms | 439.2 ms |

Complete creation improves about 4.8%; worktree preparation improves about 32%. Individual
complete-creation samples range from 2,457–2,877 ms for the control and 2,313–2,904 ms for the
candidate. The first measured sample was slower: 2,904 ms candidate versus 2,523 ms control.
This is not a latency guarantee or a demonstrated first-request speedup. Publication,
configuration loading, authority checks and the physical checkout still account for substantial
time. These results supersede neither the earlier ordinary-creation nor cold-start measurements.

The 1,000-file fixture (also five samples per variant) remains serial and is approximately
unchanged end-to-end: 1,970 ms control median versus 1,934 ms candidate. Its ranges overlap
substantially (control 1,732–2,151 ms; candidate 1,788–2,123 ms). Worktree preparation itself is
135.9 ms versus 148.2 ms, including the extra policy probe. Treat this as noise-level total change,
not a demonstrated small-repository speedup. An earlier unconditional-worker trial showed small
checkout overhead; that is why the final implementation includes the 2,000-entry threshold.
The retained trace confirms four workers per large checkout and none per small checkout.

Reproduce the large-repository comparison with:

```sh
node scripts/story-creation-benchmark.mjs --mode=isolated --samples=5 --files=10000 --control-ref=35fb9efaf046acf8dcd52401b6a0932ab7fb44cf
```

Use `--files=1000` for the smaller comparison.

`--mode=working` selects ordinary checkout creation; the default `--mode=both` retains the previous
benchmark behavior. `SINGULARITY_FLOW_SUBPROCESS_PROBE=1` adds detailed process diagnostics.

## Safety and limits

Regression coverage includes serial/parallel byte parity, CRLF conversion, binary bytes, executable
modes, symlinks, normal checkout hooks, sparse checkout, Windows-style path identity, dirty source
and resumed Stories, moved refs, authority retargeting, publication failures, index-lock contention,
unrelated staged/unstaged work, branch-switch races and recovery after durable commits. Source and
bundled CLI parity, installed VS Code staging and the unchanged bundle limits are checked too.

The benchmark exercises the CLI transaction backing VS Code, not native Copilot/UI round trips.
Native Windows was not qualified in this earlier parallel-checkout comparison. The later
[first-request study](FIRST-REQUEST-STORY-PERFORMANCE.md) includes a hosted Windows 1,000-file
qualification; antivirus/OneDrive, enterprise transport and spinning/network-disk behavior remain
unqualified. Parallel checkout can have different results on those hosts; explicit Git
worker policy is retained. Do not claim that this proves a reported six-minute Windows start is
fixed without capturing that laptop's `--timings` and subprocess profile.
