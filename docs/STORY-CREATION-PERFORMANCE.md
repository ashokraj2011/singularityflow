# Story creation performance

For the subsequent isolated-checkout and index-I/O improvements used by VS Code, see
[Isolated Story creation performance](ISOLATED-STORY-PERFORMANCE.md). The results below describe
the earlier optimization stage.

This change optimizes creation, not just the intake catalog or CLI startup. It applies to the
CLI used by Copilot and VS Code's isolated Story-start path. It does not change phase policies,
automatically run tests, defer publication, or claim that readiness means tests passed.

## Measured costs and fixes

The initial local profile used 131 Git launches for a normal start and 158 for an isolated start.
Much of the transaction was Git work, configuration loading, workflow snapshot creation and
publication. The readiness projection itself took less than 1 ms in this fixture; there were no
dependency-install or baseline-test commands to remove.

- Configuration loading repeatedly checked shared templates for different workflows. It now
  validates each unique path once per load, with at most four independent filesystem reads in
  flight. All readers settle before refusal and failures retain catalog order. The fixture avoids
  162 repeated template checks per normal creation and 216 per isolated creation. Paths are checked
  again on the next load: no positive result survives a write, checkout or CLI invocation.
- Checkout used separate Git processes for the local destination, tracked destination, remote base
  and local base. One fresh bounded ref batch replaces these probes. Exact names, refreshed-remote
  preference, existing-branch handling, packed refs and exact-commit refusals are retained.
- A clean ordinary launch performed the same complete working-tree scan twice, with no intervening
  asynchronous work. It now performs it once. An isolated child still checks its own checkout;
  publication still independently validates the candidate and unrelated changes.
- The legacy base path re-read governance after loading and validating that exact immutable
  configuration. It now consumes the verified result, while retaining the later live-fetch/base
  comparison. A changed base still refuses. Shared approved configuration keeps precedence.

No mutation approval or remote authority is cached to get these savings. Fetch, push preflight,
create-only publication, durable recovery journals, secret scanning and final push remain intact.

## Reproduce a before/after comparison

```sh
node scripts/story-creation-benchmark.mjs --samples=5 --files=10000 --control-ref=9610a654b72477977d8dd90d71da4147dd89c89c
```

Both variants use the same coarse installed packaging, stock feature workflow, repository fixture
and local bare remote. The control replaces only the changed runtime modules with their bytes
from the named commit before building its bundle. The script records that exact list, alternates
candidate/control order, uses separate initially empty compile caches, and verifies that each
created Story's local tip exactly matches its published remote tip. It exercises ordinary creation
and the isolated-worktree path used by VS Code. Temporary repositories and caches are removed in
`finally`. There are no model calls or public-remote pushes.

Use `--layout=source` without `--control-ref` for a source-only diagnostic. The existing
`SINGULARITY_FLOW_SUBPROCESS_PROBE=1` and `SINGULARITY_FLOW_SUBPROCESS_TRACE` switches expose
per-command counts and call sites. Their raw diagnostics may contain fixture paths; the JSON
report retains only operation names. `counters.git.spawns` includes the complete instrumented Git
boundary; `localTraceGitProcesses` is only the subset visible in Git's local trace environment.
Timing spans overlap and must not be added together.

## Local results (2026-10-16)

[Raw paired results](../benchmarks/story-creation/local-macos.json): macOS arm64, Node v25.5.0,
10,000 small tracked source files, five samples per variant per mode. The OS cache was not flushed.

| Complete creation, including publication | Control median | Candidate median |
| --- | ---: | ---: |
| Working checkout | 1,433 ms | 1,353 ms |
| Isolated worktree (VS Code path) | 2,647 ms | 2,666 ms |
| Git launches, working checkout | 131 | 121 |
| Git launches, isolated worktree | 158 | 149 |

Ordinary creation improves about 5.6% on this host. Isolated creation is effectively unchanged
(0.7% slower in these samples), despite fewer launches and template checks; materializing the
checkout and the synchronous publication still dominate. These are not complete-Story or token
savings. An earlier run overlapped the test suite and was discarded, rather than reporting its
inflated apparent gains. The raw results above come from the subsequent quiet run.

For a real slow Story start, add `--timings` to the same reviewed start command. The existing
VS Code progress stream is retained, so long work is distinct from an unresponsive UI.

## Qualification limits

Measurements are local macOS results, not native Windows qualification. The same portable fixes
remove expensive Git process launches and repeated file opens on Windows, but antivirus,
PowerShell/tool startup, enterprise Git authentication and network transfer remain host-dependent.
Do not translate the removed launch count into a promised number of seconds or claim that a
six-minute Windows start is resolved without inspecting that host's timing record.

The test coverage includes moved bases and seed refs, remote retargeting, missing/malformed
approved configuration, dirty worktrees, receipt fallbacks, sparse checkout, publication failures,
and durable recovery. Template deletion or symlink replacement after a successful load is refused
on the next load. The CLI and VS Code bundle budgets remain enforced without increasing them.
