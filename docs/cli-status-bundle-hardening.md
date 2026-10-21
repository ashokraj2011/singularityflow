# CLI status bundle hardening

## Cause and change

The process-wide CLI error boundary obtained `commandResultOf` through `narration/emit.mjs`.
That module also imports continuation generation and the workflow next-step planner. Consequently,
even ordinary JSON status paid to parse those definitions before running its narrow reader.
The error boundary now imports the same function directly from `narration/command-result.mjs`.
Result attachment, error identities, stream selection, redaction and recovery guidance are unchanged.

The coarse bundle transform now compacts syntax as well as whitespace, using the existing Node 20
target and the same syntax option as the VS Code build. Rollup still owns module assignment;
identifiers, singleton ownership, live installation stamps and the 21-file limit are retained.
The monolithic benchmark control is unchanged. No size ceiling is raised or source omitted from
measurement.

The first failing status assertion had hidden a second existing phase-review closure overrun on
unchanged main. The complete CLI bundle test now reaches and passes both original limits.

## Regression guards

- The status closure must remain below 1.5 MiB and cannot contain the output boundary,
  continuation builder or workflow next-step planner, nor statically import catalog/review chunks.
- A source-runtime loader trap rejects those output/planner modules while testing a real attached
  refusal. A negative control proves the trap is active. The JSON packet, preservation projection,
  failing exit code and empty stderr remain checked.
- CLI parity includes missing-Story status, other narrow/catalog commands, hook decisions and
  source/bundle error behavior. Existing stamp, worker, cycle, module-count and byte caps remain.

## Size comparison

Baseline: fresh main `fb59ee1beeba5aec2c16961a76d4208594a02020`.
Local macOS Node 26 measurement:

| Static closure | Before bytes / modules | After bytes / modules | Unchanged byte limit |
| --- | ---: | ---: | ---: |
| CLI startup | 1,424,966 / 181 | 1,283,162 / 164 | 3,145,728 |
| Ordinary status | 1,573,990 / 205 | 1,433,232 / 189 | 1,572,864 |
| Phase-review | 7,361,567 / 683 | 7,213,638 / 683 | 7,340,032 |

Status parses 140,758 fewer bytes (8.9%), with 139,632 bytes of headroom under its unchanged
limit. Both installations still contain 21 generated module files; the status static closure
contains two. These are byte/module improvements, not a claim of equivalent complete-Story or
Copilot model latency savings.

## Native qualification

Run `39599738772` passes all four native jobs: macOS arm64 and Windows x64, each on Node 22 and
Node 26. Each job passes 124 targeted tests with zero failures or skips, the full CLI bundle parity
and closure checks, all 13 unchanged VS Code bundle budgets, typechecking, and 2,945 static checks.
The tested product/test tree matches `0f0db0b9`; only temporary CI assets differ. Those assets are
not merged into production. Local macOS also passes the 25 publication/authorship/hook regressions.

The first native run, `39598288370`, exposed a Windows Node 26 fixture teardown race after its
assertions passed: it attempted to delete a repository while its signalled worker still held the
working-directory handle. Cleanup now waits for each tracked worker to exit, removes dead PIDs
from ownership tracking, and permits bounded filesystem retries. A worker that fails to stop still
fails the test. No worker authorization check, test assertion or platform applicability is removed.

Both native hosts reproduce the size table above. Each job also compares complete ordinary-status
results across the baseline and fixed bundles, using three alternating pairs on a local fixture
with 100 files and four unrelated branches. Cold samples start a new process with an empty private
Node compile cache; warm samples start another process reusing that cache. The OS file cache is
not flushed. There are no model or public-remote operations. Timing results are mixed across
hosts/runs, so this qualification establishes the bundle fix, not a consistent latency speedup.

The final main check still resolves to the baseline commit above. This is targeted qualification,
not a complete 1.0 release certificate or a live Copilot Story journey.
