# Developer-experience performance

Singularity Flow treats command latency as a release property. The repository fast-path commands
are `about`, `status`, `nextsteps`, and a repository-only `snapshot` slice. The machine-state reads
used repeatedly during editor activation—`workspace list`, `workspace current`, `workspace prompt`,
and `capability leads`—also use bounded lazy modules. They do not load the legacy CLI monolith,
Jira, model, visual, or Initiative domains unless a different subcommand actually requires one.

Audited improvements that are deliberately deferred are tracked with stable IDs and exit gates in
the [pending-work roadmap](PENDING-WORK-ROADMAP.md). That backlog does not change the current
budgets or authorize implementation.

## Git-heavy onboarding journeys

Capability mapping, workspace creation, and Story intake are model-free, AST-free, and
world-model-free. Their timing counters include root/dispatch probes as well as handler work, and
every physical Git process is counted once. `git.requests` describes logical requests,
`git.spawns` physical one-shot processes, and `git.child-spawns` retained Git children such as the
FOS object service. `SINGULARITY_FLOW_SUBPROCESS_PROBE=1` remains the independent process-level
cross-check.

The optimized paths preserve exact-ref authority and mutation preflights:

- normal workspace creation registers a manifest and planned checkouts; it does not clone
  application repositories. Start Work materializes the repositories required for the selected
  Story capability when unambiguous; explicit materialization can clone one repository when its files are needed. An explicit
  `--clone` request retains immediate materialization;
- fresh repository setup builds `sflow/config` from installed defaults and publishes it with an
  exact create lease. It does not need a setup-review branch unless remote branch policy rejects
  the direct write. Capability-map proposals retain their separate review boundary;
- repeated capability inspection reobserves the governing remote refs and reuses a locally
  verified authority snapshot only when the exact commits still match. Creating a capability
  review proposal still needs a temporary configuration checkout to form its Git commit;
- delivery-locator previews and capability-based workspace preparation may reuse that same
  exact-ref-validated lead snapshot. Explicit refresh and mutation still reread authority; an
  unreachable remote never turns a stale cached map into workspace-creation authority;
- deferred workspace bootstrap skips delivery-repository probes when the branch is declared;
  it still verifies the selected capability configuration authority. Explicit cloning and branch
  inference retain remote checks, and preflight retains its durable configuration object proof;
- register-only workspace creation uses readiness status instead of scanning World Model and
  document details. Guided Start Work prepares its selected checkout before one window reload;
- delivery-repository capability links use a bounded, machine-private bare object cache keyed by
  credential-free repository identity and observed state-branch commit. The remote ref is still
  observed on every operation; a warm cache never authorizes offline work. Set
  `SINGULARITY_FLOW_AUTHORITY_CACHE=off` to disable it or
  `SINGULARITY_FLOW_AUTHORITY_CACHE_MAX_BYTES` to a value from 1 MiB through 2 GiB to bound each
  derived object store (the default is 256 MiB);
- capability proposals that need full validation read the approved and proposed workflow,
  portfolio, and capability map in one bounded `git cat-file --batch` operation. Repository-specific discovery first
  screens a complete, exact base-to-tip claim delta and skips full definition/worktree validation
  only for proposals proven unrelated; incomplete or ambiguous deltas stay in the fail-closed path;
- publication secret admission and SGOS Candidate reconstruction batch exact retained blob IDs,
  while retaining both independent admission scans and verify-time reconstruction;
- an explicit Story base skips the broad branch advertisement, but the mutation preflight still
  prune-fetches and proves the selected branch and dry-run push in every required repository;
- VS Code Story intake lists remote branch choices once. After a base is selected, its preflight
  skips repeating that list but still performs the fresh fetch and dry-run publication checks;
- selected Story materialization reuses the repair status instead of scanning every workspace
  repository before and after the repair a second time;
- automatic identity enrollment uses the hash-verified configuration snapshot to prove a no-op and
  opens a push checkout only when a change is actually required;
- `workspace current` asks for readiness rather than a full dirty-path inventory and bounds
  repository fan-out;
- the VS Code client briefly coalesces identical read-only requests and invalidates that memory on
  every repository switch or mutation, preventing parallel panels from spawning the same CLI read;
- capability-driven workspace preparation accepts the advanced `--clone-mode`, repeated or
  comma-separated `--sparse-cone`, and `--clone-fallback` override. The resulting plan records
  whether clone policy was `portfolio-declared` or `workspace-override` without rewriting the
  organisation policy.

The focused local fixtures make the avoided work explicit. These are Git-call counts, not claims
about an office network's wall-clock latency:

| Journey | Avoided work | Still checked before a write |
| --- | --- | --- |
| Fresh `Set up SFlow` | Four remote calls across preview and apply instead of eight, plus no empty `state` publication | Fresh confirmation, exact `sflow/config` create lease, and post-push reconciliation |
| Mapping with two pending proposals, one unrelated | One full proposal definition/worktree materialization instead of two | Exact base proof and claim-delta inspection for both; matching or unclear proposals retain full validation |
| Deferred workspace with two explicit delivery branches | Zero delivery `ls-remote` probes instead of two | Approved capability-map authority; selected branch at first checkout |
| VS Code Story preflight after selecting a base | One fewer all-heads advertisement per selected repository | Fresh selected-ref fetch, publication dry run, and Story-start validation |
| Start Work on a selected capability | One readiness scan when already present, or two when materializing instead of four | Checkout identity and readiness for the selected closure |

Protected configuration branches still require their server's review path. A pending capability
proposal is still checked before proposing a potentially duplicate mapping; incomplete coverage
never means the repository is safe to map.

Short-lived configuration clones now fetch the one required shallow commit completely whenever a
working tree is consumed, rather than advertising `blob:none` and immediately negotiating the same
blobs lazily. Read-only proposal inventories use `--no-checkout`. Application workspace clone mode
remains an explicit approved policy and retains the centralized partial-clone fallback classifier.

Capability Story preflight also refreshes each registered-v4 sibling state authority before the
Story transaction. Materialization reuses only the exact observed tracking-ref commit; a moved,
deleted, unavailable, or unmaterialized authority becomes an advisory World-Model gap without a
second network attempt or stale-cache fallback inside Story creation. Initiative materialization
keeps its independent refresh boundary.

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
other than VS Code 1.90.x; `current` refuses versions older than 1.90. Model access is disabled.
The fixture selects a governed workspace backed by a temporary local bare Git remote. Its host
allows only Git's `file` transport and points HTTP(S) proxy clients at a loopback-refusal endpoint;
the report calls this `restricted-local-git`. This is not a process-wide network sandbox, so do not
use the benchmark as evidence that arbitrary direct sockets are denied. Every fixture is disposable.
Reports contain no repository path, Work ID, identity, question, artifact, command output, or source
bytes. Linux records peak child RSS from `/proc`;
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

The Git authority and bounded-transport hardening adds reviewed modules to the shared CLI closure
used by the extension. Its eight-entry build measures 28,573,333 JavaScript bytes; the revised
28,900,000-byte total ceiling leaves under 1.2% headroom, with similarly narrow per-entry limits.
This is an intentional shipping-graph change, not an exemption: missing entries, new entries,
and further growth beyond those ceilings still fail the gate.

The reviewed TKR-preview closure contains 31,288,784 JavaScript bytes in an isolated clean build at
`main@f8278a42` plus the candidate change. Against the same clean pre-change dependency closure,
the dynamic composer selector and fail-closed production guard add 7,984 bytes and zero source
modules. The five affected entries measure 7,275,482 bytes (`gateway-runtime.cjs`), 7,328,707 bytes
(`gateway-status-worker.cjs`), 3,385,879 bytes (`help-runtime.cjs`), 3,217,817 bytes
(`support-runtime.cjs`), and 7,289,929 bytes (`world-model-build.cjs`). The three entries that cross
their prior ceiling and the aggregate ceiling are rounded only to the next 5,000-byte boundary;
the existing Help, Support, and module ceilings remain unchanged. A dirty `+local` build measures
31,296,512 bytes because that identity is embedded in the bundles and remains inside the same
reviewed 31,300,000-byte ceiling; the clean release closure remains lower.

At `main@5fca9fc2`, later feature growth had lifted the eight-entry closure to 34,427,816
bytes and the 2026-09-15 per-entry ceilings no longer described the shipped source. The status
worker was carrying a second copy of the gateway kernel (8,133,529 bytes, 583 modules). It now
loads the separately packaged sibling `gateway-runtime.cjs`; an IPC smoke test and VSIX packaging
test verify that relationship. The measured worker is 109,009 bytes and 15 modules, and the entire
closure is 26,403,405 bytes, a reduction of 8,024,411 bytes. The reviewed aggregate ceiling is
therefore **lowered** from 33,200,000 to 27,000,000 bytes, and the status-worker ceiling from
7,810,000/570 to 200,000/30. The other entry ceilings are rebaselined narrowly to the measured
post-dedup module/byte closures with approximately 1–3% headroom; these entries contain later
product code rather than an additional copy of the status kernel. This is a new packaging
layout baseline, not a claim that extension-host latency or memory improved by the same ratio.

At clean `main@dc2146c9`, an isolated build measured 27,783,865 bytes: the committed baseline
already exceeded the then-current 27,485,000-byte ceiling by 298,865 bytes before the candidate
changes were applied. The final candidate measures 27,888,908 bytes, 105,043 bytes above that
clean baseline after the approved-runner and revision publication paths became part of the
gateway and world-model runtime closures. The failing entries measure 1,337,520 bytes/156 modules
(`extension.cjs`), 8,517,634/601 (`gateway-runtime.cjs`), 3,844,532/423 (`help-runtime.cjs`),
1,848,127/181 (`lazy-panels-runtime.cjs`), 3,652,936/405 (`support-runtime.cjs`), and
8,571,925/607 (`world-model-build.cjs`). This rebaseline moves only those failing byte ceilings to
the next 5,000-byte boundary and only the exceeded module ceilings to the exact observed count;
already-sufficient context-runtime, status-worker, extension-module, and support-module ceilings
remain unchanged. The aggregate ceiling is 27,890,000 bytes, leaving 1,092 bytes of measured
headroom rather than admitting an unrelated increase.

The Environment Bindings candidate initially raised the gateway and world-model closures by two
modules: the public declaration policy and the private binding store. Binding resolution is an
execution-time concern, so `state.mjs` now loads the staged private runtime only when an
environment-bound quality command reaches that gate. This removes `environment-bindings.mjs` from
both long-lived bundles. The remaining single module increase is the names-only declaration policy
required by Git publication, source-snapshot, and quality-command admission. The isolated candidate,
including stable configuration reads, portable path identity, and the final exact worktree/index/HEAD
policy-union hardening, measures 28,046,165 bytes. The affected entries are 8,561,477/602
(`gateway-runtime.cjs`), 3,879,012/424 (`help-runtime.cjs`), 3,686,931/406
(`support-runtime.cjs`), and 8,615,804/608 (`world-model-build.cjs`). The immutable-index repair adds
no source modules. Only those four entry ceilings and the aggregate ceiling move to the next 5,000-byte
boundary; all other byte and module ceilings remain unchanged.

The SKP M2 candidate adds reviewed Story skill-version adoption and exact approved-package
checks to the shared CLI closure. The final isolated build on 2026-09-26 measures 28,894,109
JavaScript bytes in eight entries, below the existing 28,900,000-byte aggregate ceiling. The
four entries that crossed their prior limits measure 8,922,464 (`gateway-runtime.cjs`),
4,027,757 (`help-runtime.cjs`), 3,834,639 (`support-runtime.cjs`), and 8,977,916 bytes
(`world-model-build.cjs`). Only these four byte ceilings move to the next 5,000-byte boundary;
the aggregate and every source-module ceiling remain unchanged. The 5,891-byte aggregate
headroom means unrelated bundle growth still fails the gate.

## Bounded aggregate verification

`npm test` and `npm run test:cli` no longer start one unbounded all-files process. They create eight
deterministic, largest-first shards for the selected suite, run at most two shards concurrently with
one Node test file per shard, and give each shard a 30-minute wall-clock deadline. The process-tree
supervisor terminates the Node runner and its CLI, Git, extension-host, and model-provider
descendants after a deadline or bounded output overflow. The unusually expensive Auto fixture is
assigned a dedicated scheduling weight so its measured 17-minute local runtime is not hidden behind
another hundred test files.

Every shard writes a machine-local receipt under `.git/singularity-flow/test-runs/`. A receipt binds
the exact commit, tree, selected-test content digest, platform, architecture, Node version, shard
layout, completion counters, and strict-skip policy. A retry on the same clean checkout reuses only
exact passing receipts and runs only incomplete shards. Dirty checkouts always rerun because their
uncommitted implementation bytes are not represented by the Git tree.

```bash
# Normal resumable aggregate.
npm test

# CLI-only resumable aggregate; this uses the same coverage and per-shard bounds.
npm run test:cli

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

An isolated new Story can reuse the launch checkout's all-heads fetch in its linked worktree only
after a fresh exact-ref observation proves the same base and Story destination, Git common directory,
transport, and remote identity. Any mismatch or failed probe takes the normal fetch path. When
automatic identity enrollment is already a no-op, Story start checks the live `sflow/config` tip
against its pinned commit without cloning that branch again; an actual enrollment edit still uses
the normal clone-and-publish transaction. Initial document bytes are captured once and rehashed
against the final intake policy before any shared enrollment mutation.

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

Story start also reports `start.*` spans for authority selection, approved configuration loading,
destination observation, Git fetch, repository preflight, readiness, documents, enrollment,
local worktree creation, and publication when those steps apply. These spans sit inside `execute`
and must not be added to it; they identify which part of a slow start deserves investigation.

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
