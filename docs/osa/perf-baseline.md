# OSA Stage 0 — performance baseline

**Specification:** [SPEC-OSA v1.1](../SPEC-OSA-ONE-STEP-AUTHOR-v1.1.md): AC-022, REQ-041, and plan §2 item 7.

**Data:** `benchmarks/osa/perf-baseline.json`, written by `scripts/osa-perf-baseline.mjs`.

This is the comparison point for Stages 1, 3 and 5. They measure the same requests with the same script, and no existing ceiling is raised to pass.

## Method

The run is reproducible from a checkout with its `node_modules`:

```
node scripts/osa-perf-baseline.mjs --root=<a new folder outside your home> --samples=7 --modes=source,bundle \
  --output=benchmarks/osa/perf-baseline.json
```

**Isolation.** The fixture is the journey tests' own, `journeyRepository` from `test/helpers/route-follower.mjs`. It gives one folder holding:
- the repository and a local bare remote;
- a HOME and a global Git configuration;
- every machine-wide SFlow location in `MACHINE_STATE_LOCATIONS`.

The environment switches are the journeys' own: `NODE_ENV=test`, `SINGULARITY_FLOW_NO_MODEL=1` and `ISOLATED_RUN_SWITCHES`. `TMPDIR` points inside the harness. The script refuses to start if:
- `--root` is inside the real home, or not empty;
- HOME, the Git configuration or any machine-state location would be outside the harness.

No person's Story, home, `~/.singularity-flow` or `~/.copilot` is read.

**Engine.** The requests run from a copy of this checkout's engine inside the harness. The cold bundle reads its live sources (`src/build-info.mjs`, `src/version.mjs`, …) from the folder beside it, so it needs the copy. `node_modules` is linked, not copied.

**Story states.** One quick-fix Story is measured in two states:

| State | How it is reached |
|---|---|
| `document-v1-being-written` | After `start` and `prepare intake` |
| `code-v1-open` | The intake is written, published, reviewed, submitted and approved; then `phase enter` and `phase begin implement` |

**Requests.** Each is measured in both states:

| Request | What runs |
|---|---|
| guard | The Copilot pre-tool hook (`plugin/hook-launcher.mjs boundary-guard`, as `test/cli-bundle.test.mjs` runs it), after a `boundary-turn` prompt of the step's work command (`/sf-phase` or `/sf-code`), for an edit of the step's own file: the intake document, or `src/value.mjs` |
| guard-other-file | The same hook for a file the step may not edit: application code in the document step, or the approved intake in the code step |
| entry | `phase enter --compose --for-agent --json` |
| next | `nextsteps --json` |

**Engine layouts.**

| Layout | Meaning |
|---|---|
| source | `SINGULARITY_FLOW_BUNDLE=off` |
| bundle | The cold coarse-ESM bundle (`scripts/build-cli-bundle.mjs`, layout `cold`), built in the harness and forced with `SINGULARITY_FLOW_BUNDLE_DIR`, as an installed build runs |

**Cold and warm.** These follow `scripts/cold-start-benchmark.mjs`:
- **Cold:** a process with an empty V8 compile cache (`NODE_COMPILE_CACHE`, a new folder for each sample).
- **Warm:** later processes that reuse the cache a priming run wrote.

SFlow's own caches are whatever the Story's earlier commands left, in both cases. Timed samples run without instrumentation; the median, minimum and maximum are kept.

**Counts.** One cold and one warm run per row repeat the request with a counting preload (`--import`):
- **Modules:** `file:` URLs loaded, through a `module.register` load hook (Node 22.14 has no `registerHooks`), split into engine sources, bundle chunks and dependencies.
- **Processes:** Git and other child processes started, by wrapping `node:child_process`. Git calls are also counted by verb.
- **Reads:** file reads (`readFile*`, read opens, `createReadStream`), directory reads and stat-type calls (`stat`, `lstat`, `exists`, `access`), by wrapping `node:fs` and `node:fs/promises`. A call made inside another counted call is counted once.

Children are counted, not instrumented.

## Results

Node 22.14.0 on darwin arm64 with 10 CPUs. Seven timed samples per row, cold and warm. The counts come from the counted cold run; where the warm run differed, the table shows cold / warm.

What the outcome column means:
- **allow:** the guard returned no decision, so the edit is allowed.
- **deny:** the guard refused, with its code.
- **act:** the entry's act, with its status.
- **now:** the first "now" action in next steps.

| State | Layout | Request | Outcome | Cold ms median [min–max] | Warm ms median [min–max] | Modules (source / bundle chunks / deps) | Git processes (by verb) | Other processes | File reads | Directory reads | Stats |
|---|---|---|---|---|---|---|---|---|---|---|---|
| document v1 being written | source | guard | allow | 121.4 [115.3–131.4] | 83.3 [80.7–85.6] | 83 (80 / 0 / 1) | 0 | 0 | 99 / 100 | 0 | 59 / 60 |
| document v1 being written | source | guard-other-file | deny PHASE_MUTATION_PATH_DENIED | 117.5 [112.6–131.2] | 76.6 [75.4–80.2] | 86 (83 / 0 / 1) | 0 | 0 | 85 | 0 | 36 |
| document v1 being written | source | entry | act author (authoring-entry) | 923.8 [848.8–1171.9] | 691.7 [682.9–843.5] | 606 (524 / 0 / 80) | 26 (cat-file 5, config 2, rev-parse 3, diff-tree 1, status 5, diff 5, ls-files 2, ls-tree 3) | 1 | 199 | 37 | 3143 / 3147 |
| document v1 being written | source | next | now prepare intake /sf-phase | 373.9 [357.6–468.4] | 266.1 [243.2–300.8] | 397 (315 / 0 / 80) | 3 (remote 2, for-each-ref 1) | 1 | 110 | 10 | 378 |
| document v1 being written | bundle | guard | allow | 81.5 [80.1–104.2] | 59.4 [56.8–74.6] | 10 (4 / 4 / 0) | 0 | 0 | 29 / 30 | 1 | 59 / 60 |
| document v1 being written | bundle | guard-other-file | deny PHASE_MUTATION_PATH_DENIED | 89.5 [83.1–95.9] | 63.5 [53.7–79.3] | 9 (3 / 4 / 0) | 0 | 0 | 15 | 1 | 36 |
| document v1 being written | bundle | entry | act author (authoring-entry) | 946 [746.3–1050.9] | 606.4 [572.8–824.2] | 19 (3 / 14 / 0) | 26 (cat-file 5, config 2, rev-parse 3, diff-tree 1, status 5, diff 5, ls-files 2, ls-tree 3) | 1 | 145 | 38 | 3262 / 3266 |
| document v1 being written | bundle | next | now prepare intake /sf-phase | 525.5 [477.9–589.1] | 291.2 [273.9–311] | 244 (148 / 14 / 80) | 3 (remote 2, for-each-ref 1) | 1 | 122 | 11 | 381 |
| code v1 open | source | guard | allow | 137.9 [128.3–156.3] | 82.6 [78.5–86] | 83 (80 / 0 / 1) | 0 | 0 | 99 / 100 | 0 | 55 / 56 |
| code v1 open | source | guard-other-file | deny PHASE_MUTATION_PATH_DENIED | 117.8 [113.9–225] | 93.4 [81.3–109.1] | 86 (83 / 0 / 1) | 0 | 0 | 85 | 0 | 40 |
| code v1 open | source | entry | act author (authoring-entry) | 1067.8 [1021–1207.8] | 1009.7 [894.4–1307.8] | 632 (550 / 0 / 80) | 34 (cat-file 6, config 3, status 5, diff 7, ls-files 4, rev-parse 4, diff-tree 1, show 1, ls-tree 3) | 1 | 276 | 87 | 6344 / 6346 |
| code v1 open | source | next | now prepare implement /sf-code | 619.2 [492.5–697.6] | 335.6 [329.8–370.8] | 564 (482 / 0 / 80) | 3 (remote 2, for-each-ref 1) | 1 | 128 | 14 | 421 |
| code v1 open | bundle | guard | allow | 84.4 [81.3–88.6] | 59.3 [56.9–101.7] | 10 (4 / 4 / 0) | 0 | 0 | 29 / 30 | 1 | 55 / 56 |
| code v1 open | bundle | guard-other-file | deny PHASE_MUTATION_PATH_DENIED | 84.8 [81.8–117.4] | 70.5 [65.2–86.6] | 9 (3 / 4 / 0) | 0 | 0 | 15 | 1 | 40 |
| code v1 open | bundle | entry | act author (authoring-entry) | 1286.1 [1082–1464] | 1074.8 [772.7–2073.1] | 93 (74 / 16 / 1) | 37 (cat-file 6, config 3, status 5, diff 7, ls-files 4, rev-parse 6, diff-tree 1, show 1, ls-tree 4) | 1 | 295 | 90 | 6450 / 6452 |
| code v1 open | bundle | next | now prepare implement /sf-code | 613.3 [596.2–1267.6] | 2219.9 [2067.2–2307.1] | 244 (148 / 14 / 80) | 3 (remote 2, for-each-ref 1) | 1 | 140 | 15 | 424 |

## What the baseline shows

1. **The guard starts no Git process.** This holds cold and warm, for an allowed and for a denied edit, in both states and both layouts. That is the REQ-041 baseline, and Stage 1 keeps it: the kernel's snapshot reaches the guard without Git.

   | Guard | Modules | File reads | Stat calls |
   |---|---|---|---|
   | From sources | 83–86 | 85–100 | 36–60 |
   | Bundled | 9–10 (within the cli-bundle ceiling of 16) | 15–30 | 36–60 |

   **Not measured:** the reviewer-start fallback (`publishedReviewerStart`, decision inventory a12), which loads the Story with Git inside the pre-tool path. Stage 1 adds a guard request for it.
2. **Phase entry is the expensive request.**

   | Entry | Git processes | Stat-type calls | File reads | Modules from sources |
   |---|---|---|---|---|
   | Document step | 26 | about 3,100–3,300 | 199 | 606 |
   | Code step | 34–37 | about 6,300–6,800 | 276–295 | 632 |

   Bundled, the entry loads 19–93 module files. Stage 1 moves the entry onto the kernel and compares these counts. The plan does not ask Stage 1 to reduce them, but it must not raise them.
3. **Next steps starts 3 Git processes** (`remote` twice, `for-each-ref` once). It loads 397–564 modules from sources.
4. **Two computed-path imports escape the bundle.**

   | Bundled request | Source modules loaded | Import | Why it is outside the chunk graph |
   |---|---|---|---|
   | `nextsteps` | 148 (244 modules in all) | `src/decision-list-reads.mjs:254` imports `convergence-adjudications.mjs` | It builds the path at run time with `pathToFileURL(path.join(PACKAGE_ROOT, 'src', …))` |
   | The code step's entry | 74 | `src/story-lineage.mjs:49` imports `story-review-artifact-read.mjs` | The same construction |

   These are existing costs, not OSA's, and not fixed here. Stage 1 records them so the kernel migration is not blamed for them, nor credited with removing them.
5. **The counts are stable; the timings are not.**

   | Measure | Across Stage 0's three runs |
   |---|---|
   | Module counts and Git process counts | Identical |
   | File reads, directory reads and stat calls | Vary by a few, and by up to about 6% for the code entry's stat calls, as the Story's own records accumulate |
   | Timings | Move with machine load |

   This run's load average went from 11.2 to 21.2, because other suites were running. One warm sample set (bundled `next` in the code step) was inflated by a load spike to a median of 2,220 ms against a cold median of 613 ms. **Use the timings only as an order of magnitude.**

## How later stages compare

- **Run the same script against this commit and the candidate** on the same machine, with the engines interleaved, as `scripts/phase-next-paired-benchmark.mjs` does for its two engines. Never compare to absolute times taken on another day or under another load.
- **Module and Git process counts must not grow** for guard, guard-other-file, entry and next in either layout. The guard's Git count must stay at 0.
- **File, directory and stat counts are reported with their spread.** A rise beyond the spread above is a regression to explain.
- **No ceiling moves to make a measurement pass** (AC-022). The ceilings are listed in [baseline.md](baseline.md) §4.

## Run record

| Field | Value |
|---|---|
| Measured commit | `d2dc3b9c8`, the Stage 0 records commit (`source.commit` in the data). `source.dirty` is true because one documentation file was edited after that commit; no source file differed. |
| Machine | darwin arm64, 10 CPUs, 24 GiB |
| Node | 22.14.0 |
| Samples | 7 cold and 7 warm per row, plus one counted cold and one counted warm run |
| Start | 2026-11-16 15:57 UTC |
| Duration | 2 min 46 s, after the fixture and the bundle build |
