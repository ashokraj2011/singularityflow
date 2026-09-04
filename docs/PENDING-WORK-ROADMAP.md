# Singularity Flow pending-work roadmap

**Status:** master tracker; Candidate and office-Git implementation landed, release evidence remains active

**Baseline:** `main@cb278ca6`

**Last reviewed:** 2026-09-01

This is the one-page control plane for deliberately deferred product work. It does not replace the
detailed domain roadmaps and it does not authorize implementation. It names the current boundary,
the next eligible increment, and the source document that owns each acceptance contract.

The first performance remediation checkpoint landed on 2026-08-30 at `main@96bb55f8`. Universal
Candidate publication and the next office-Git hardening slice landed on 2026-09-01 at
`main@cb278ca6`. Their local regressions, npm dry-run, and VSIX package are verified. Items remain
`[~]`, not complete, wherever their contract still requires a pinned release baseline, real VS Code
hosts, signed platform receipts, office-network proof, or live Windows/macOS process and
credential-helper evidence.

## Status rules

- `[ ]` means parked. There is no active implementation Story or branch.
- `[~]` means active work has an owner plus a Story or branch, but has not met every exit gate.
- `[x]` means the code, migrations, adversarial tests, documentation, npm/VSIX packaging, and
  release evidence have landed on `main`.
- Changing an item to `[~]` must add its owner, Story or branch, start date, dependencies, and
  intended release.
- Changing an item to `[x]` must add the exact landing commit and verification evidence.
- A prototype, a local happy path, or a faster developer laptop is not completion.
- New scope gets a new stable ID. Existing acceptance gates must not be silently weakened.

## Portfolio dashboard

| Track | Current boundary | Next eligible increment | Detailed authority |
|---|---|---|---|
| Developer-experience performance | Hot paths and the office-Git code-local slice are implemented; pinned relative baseline and cross-platform host evidence are not established | Finish `DXP-P0-001`, then close each `[~]` platform gate | This document and [DX performance](DX-PERFORMANCE.md) |
| SGOS | Universal Candidate publication and portable authority transport are code-complete; signed cross-platform release proof remains open | Finish the `SGOS-P0-001` and `SGOS-P0-003` signed platform matrices | [SGOS pending work](SGOS-PENDING-WORK.md) |
| World Model Builder v4 | Release receipt generation and enforcement exist; no reviewed six-cell supported-platform aggregate is recorded | `WMB-REL-001` | [WMB v4](WORLD-MODEL-BUILDER-V4.md) |
| Witnessed Engineering Loop | Observe-only baseline shipped; exact/authenticated testcase claims and enforcement are unavailable | `WEL-P0-001` | [WEL pending work](WEL-PENDING-WORK.md) |
| Code Assurance Bridge | Corrected design only; implementation is not authorized | `CAB-R0` design alignment | [CAB roadmap](CAB-ROADMAP.md) |
| Governed Delivery and Proof | M0 contract freeze landed at `cb46359c`; no GDP runtime or durable writer is enabled | `GDP-M1` compatibility inventory and pure projections | [GDP milestone roadmap](GDP-DELIVERY-ROADMAP.md) |

Completed work is not repeated in this tracker. In particular, the
[VS Code UI remediation contract](UI-REMEDIATION-PLAN.md) is implemented and regression-backed; a
new responsiveness defect belongs in the DXP track below, not in that closed remediation plan.

## Dependency order

The remaining performance acceptance work should be completed in this order:

1. establish trustworthy measurements (`DXP-P0-001`);
2. remove activation, refresh, and enterprise-Git correctness hazards (`DXP-P0-002` through
   `DXP-P0-006`);
3. reduce steady-state payload, process, and remote-operation cost (`DXP-P1-*`);
4. improve diagnostics and packaging only after the critical paths are bounded (`DXP-P2-*`).

Parallel work is allowed only where the detailed items do not share the same activation, Git
transport, or benchmark contracts.

## Developer-experience performance work

### 2026-09-01 Candidate and office-Git checkpoint

This checkpoint is implemented at `main@cb278ca6` and remains `[~]` until its external release
evidence is recorded.

- **Owner:** Codex reliability and Candidate remediation
- **Branch:** `main`
- **Started:** 2026-09-01
- **Implementation commit:** `cb278ca6`
- **Target:** next `0.9.x` release after the supported-platform gates pass

| Scope | Code-local outcome at `cb278ca6` | Remaining evidence before `[x]` |
|---|---|---|
| `DXP-P0-004` | One reusable sanitized enterprise Git environment preserves reviewed proxy, CA, TLS backend, and credential-helper behavior; endpoint binding and diagnostics remain credential-free | Live Windows GCM/Git Bash, macOS helper, and office proxy/CA exercises |
| `DXP-P0-005` | Interactive onboarding and configuration refresh use the bounded async process-tree supervisor and stable failure taxonomy | Migrate the remaining legacy synchronous recovery/ledger/configuration remote helpers; collect live POSIX and Windows descendant-cleanup receipts |
| `DXP-P0-006` | One partial-clone classifier retries only explicit filter rejection, recognizes ignored filters, and prevents double clone | Live provider exercises for filter rejection and filter ignored, with stage and transfer evidence |
| `SGOS-P0-001` | Supported lifecycle publishers route through exact retained Candidate verification, commit binding, and recoverable publication | Signed supported-platform aggregate and artifact binding for the final release commit |

Local development evidence for this checkpoint:

- full suite: 3,974 tests passed;
- affected-regression suite: 149 tests passed, in addition to the 435-test Candidate/Git focused run;
- model-free boundary: 7 tests passed;
- repository conformance: 1,215 checks passed;
- VS Code TypeScript compilation passed;
- npm dry package: 1,018 files, 3.2 MB packed, 12.5 MB unpacked;
- VSIX: 2,075 files, 6.77 MB.

These are local macOS arm64/Node 25 development results. They are not signed release-matrix cells.

### 2026-08-30 implementation checkpoint

All `[~]` DXP entries below share this tracked delivery metadata:

- **Owner:** Codex performance remediation
- **Branch:** `main`
- **Started:** 2026-08-30
- **Implementation commit:** `96bb55f8`
- **Target:** next `0.9.x` release after the remaining acceptance gates pass
- **Dependency status:** code dependencies are landed; platform/release evidence listed below is
  deliberately still open

| Scope | Landed in `96bb55f8` | Remaining evidence before `[x]` |
|---|---|---|
| `DXP-P0-001` | `doctor --performance` measures its explicit invoking checkout; scale and dirty-tree fixtures cover the VS Code snapshot | 30 samples on pinned Node 22/Linux x64; minimum/current VS Code host p50/p95, event-loop and RSS; office-network arm |
| `DXP-P0-002`–`003` | cache-first activation, confirmed-snapshot auxiliary reads, latest-only refresh/validation, one sidebar paint, hidden-panel deferral | 10-second real extension-host storms with CPU/RSS/process budgets on minimum and current VS Code |
| `DXP-P0-004`–`006` | reviewed enterprise proxy/CA/helper parity, bounded process-tree supervisor, and centralized partial-clone fallback | live Windows GCM, Git Bash, macOS helper, office proxy/CA, provider filter, and descendant-cleanup exercises |
| `DXP-P1-001`–`002` | leased heavy slices, linear bounded output, JSON stdout isolation, and lazy workspace/capability startup readers | accepted peak-RSS and module-load release budgets on the pinned hosts |
| `DXP-P1-003`, `DXP-P2-001` | one operation-scoped remote session, broad inventory reuse, mutation invalidation, and exact revalidation | audit and migrate the remaining indirect synchronous configuration/ledger remote helpers |
| `DXP-P1-004` | async/batched local validation, origin-first streaming remote pool, canonical cache identity, repository epochs, and immediate A→B cancellation | live high-ref and A→B→A extension-host runs on Windows plus both supported VS Code versions |
| `DXP-P1-005` | 10,000-file `snapshotUi` subprocess growth and heavily dirty working-tree tiers | ignored build tree, submodule, many-Story, rename-storm, and nested-worktree platform reports |
| `DXP-P2-002`–`003` | privacy-safe enterprise source diagnostics, lazy gateway imports, SFlow-only activation markers, npm and VSIX packaging | reviewed bundle/module budgets and complete event-loop/peak-memory stage reporting |

Local verification attached to the checkpoint:

- repository conformance: 1,041 checks passed;
- VS Code suite: 612 tests passed;
- focused Git/configuration suite: 63 tests passed;
- VSIX: 1,944 files, 5.99 MB, with the bundled CLI loading without source-tree access;
- npm package dry-run: 886 files, 2.74 MB packed, 10.60 MB unpacked;
- five-sample macOS arm64/Node 25 post-change diagnostic: `status` p50 78.7 ms,
  `snapshotUi` p50/p95 320.3/328.2 ms, `snapshotFull` p50/p95 534.8/551.9 ms, and dirty
  `snapshotUi` p50/p95 377.9/462.9 ms with subprocess growth 1.00x.

The last line is useful local evidence, not an accepted reference baseline.

## Cross-platform release evidence

### [~] WMB-REL-001 — Signed supported-platform release matrix

- **Owner:** release engineering
- **Branch:** `main`
- **Started:** 2026-09-01
- **Implementation anchor:** `main@89ee3a4f`
- **Target:** the release that promotes WMB v4

The receipt generator, merger, artifact binding, and release refusal gate are implemented. Completion
requires clean-checkout signed receipts for macOS, Linux, and Windows on Node 20 and Node 22, one
reviewed aggregate over the same final commit and tree, and one selected npm/VSIX artifact receipt.
Local Node 25 runs and simulated platform tests satisfy none of those six cells.

### Pre-remediation audit baseline

The 2026-08-30 read-only audit established the following facts:

- the checkout was clean with 1,418 tracked files;
- warm `git status` was about 14 ms, so enabling repository-wide Git performance settings such as
  FSMonitor or untracked cache is not justified by this checkout;
- the five-sample macOS arm64/Node 25 fixture passed every current absolute budget, including
  `status` p50 78.6 ms, `snapshot` p50 103.8 ms, `snapshotUi` p50/p95 312.6/319.6 ms, and
  `snapshotFull` p50/p95 514.1/541.5 ms;
- those samples are not comparable to the declared Node 22/Linux x64 reference runtime;
- the accepted reference baseline is still `unestablished`, so the documented 20-percent relative
  regression gate is inactive;
- local timing records show frequent `workspace list`, `workspace current`, and capability reads
  paying roughly 140–200 ms of legacy module loading even when execution itself is small;
- activation can start readiness and log reads before the initial snapshot finishes, and current
  unchanged snapshots still perform substantial derivation work;
- existing Git batching, operation-scoped sessions, narrow watcher scope, snapshot single-flight,
  and bounded async remote commands are safeguards to preserve.

These are diagnostic observations, not an accepted release baseline.

### P0 — establish and protect the interactive critical path

#### [~] DXP-P0-001 — Accepted measurement and extension-host contract

Establish measurements before changing implementations or accepting a claimed improvement.

Acceptance gates:

- record and review at least 30 samples on the pinned Node 22/Linux x64 fixture;
- change the accepted baseline from `unestablished` only through the existing reviewed import path;
- prove a synthetic regression greater than 20 percent fails the local release gate;
- add a real VS Code extension-host benchmark for activation, cached first paint, confirmed first
  paint, unchanged refresh, changed refresh, webview opening, event-loop delay, and peak child RSS;
- bind p50 and p95 budgets to both the minimum and current supported VS Code versions;
- keep model and network access disabled in the deterministic tier and add a separate office-network
  exercise for proxy-dependent Git behavior;
- fix `doctor --performance` target selection so it measures the invoking checkout or requires and
  displays an explicit target, even when that checkout lacks `singularity/workflow.yml`.

No later DXP item may raise a budget merely to make its implementation pass.

#### [~] DXP-P0-002 — VS Code activation critical path

Make cached content interactive first and prevent background work from competing with repository
confirmation.

Acceptance gates:

- cached sidebar content becomes interactive without awaiting fresh workspace enumeration;
- at most one foreground CLI child runs during activation;
- capability readiness and workspace-log reads start only after the first confirmed snapshot, or are
  consolidated into a bounded read;
- repository resolution does not repeat an equivalent `workspace list` or `workspace current` read;
- unchanged snapshots have a separate enforced latency, subprocess, payload, and RSS budget and are
  materially cheaper than full derivation;
- activation p95 is at most 750 ms on the pinned reference fixture without showing an incorrect
  repository or Story.

#### [~] DXP-P0-003 — Refresh, validation, and rendering single-flight

Bound the work caused by save bursts and repository events.

Acceptance gates:

- one snapshot is active with at most one trailing refresh queued, and completed coherent results are
  not repeatedly discarded during a sustained event stream;
- a 10-second governed-file event storm has bounded process count and publishes one final fresh state
  after quiescence;
- configuration validation is single-flight per repository with one trailing request and stale
  validation results cannot overwrite newer diagnostics;
- one successful store publication produces at most one sidebar render;
- loading states do not rebuild all tree models or replace the full webview document repeatedly;
- hidden panels render only when revealed or when a relevant leased slice changed;
- tests record process count, render count, event-loop delay, CPU, and RSS for save and watcher storms.

#### [~] DXP-P0-004 — Enterprise Git configuration parity

Make preview and confirmed apply use the same required office transport configuration without
reintroducing unsafe ambient repository state.

Acceptance gates:

- configuration-refresh preview and confirmed apply both work when access requires global or system
  proxy, custom CA, and credential-helper settings;
- a reviewed allowlist preserves effective transport/authentication configuration while continuing
  to neutralize hostile `GIT_DIR`, hooks, replacement objects, alternates, unsafe command-scoped
  configuration, and repository-local overrides;
- a cache miss followed by a fresh clone receives exactly the same approved transport settings;
- tests cover Windows Git Credential Manager, Git Bash, macOS credential helpers, lower- and
  uppercase proxy variables, custom CA paths, authentication refusal, and cancellation;
- diagnostics never expose proxy URLs, credentials, certificate paths, or helper output.

#### [~] DXP-P0-005 — Hard remote Git process-tree deadlines

Replace mixed synchronous and immediate-child timeout handling with one bounded asynchronous Git
supervisor.

Acceptance gates:

- all remote Git operations keep the extension and CLI event loop responsive;
- timeout and cancellation terminate POSIX process groups and Windows descendant trees, escalate
  from graceful termination to forced termination, and settle within `deadline + grace`;
- a fake Git process that ignores termination and leaves a pipe-holding child cannot outlive the
  command;
- no credential, SSH, proxy, or Git helper descendant remains after quiescence;
- existing privacy-safe timing counters, error classes, exact-SHA checks, and recovery receipts remain
  unchanged.

#### [~] DXP-P0-006 — Correct partial-clone fallback

Centralize fallback classification so an office failure does not trigger a second unrelated clone
and a server that ignores filters does not download a monorepo twice.

Acceptance gates:

- proxy, authentication, TLS, generic network, cancellation, and timeout failures cause exactly one
  attempt;
- explicit server filter rejection retries once only when the approved policy permits full fallback;
- a successful clone that ignored the filter is verified, normalized, and retained without another
  transfer;
- `fallback: refuse` cannot leave or accept an accidental full stage;
- workspace materialization, capability-catalog loading, and capability proposals use the same
  classifier;
- tests assert invocation counts, bytes/stages retained, actual clone mode, cleanup, and user-facing
  diagnosis.

### P1 — reduce steady-state work

#### [~] DXP-P1-001 — Lease heavy slices and bound structured-output memory

Acceptance gates:

- Configuration Center, Capabilities, Approvals, Dashboard, Designer, and future heavy panels acquire
  a slice lease and release it on disposal;
- after all heavy panels close, snapshot arguments return to the three core slices;
- slice revisions prevent rebuilding unchanged heavy views;
- structured JSON stdout is not copied into the Output channel; only progress, timings, and stderr
  diagnostics are shown;
- output chunks are buffered without repeated string concatenation, ordinary JSON commands use a
  tighter cap, and a large-payload test enforces peak-memory and Output-channel budgets.

#### [~] DXP-P1-002 — Lazy workspace/capability reads and cheap unchanged snapshots

Acceptance gates:

- frequent `workspace list`, `workspace current`, capability-lead, and other activation reads do not
  load the legacy CLI monolith;
- the lazy import graph has a test-enforced module ceiling and cannot pull in model, Jira, visual,
  Initiative, or unrelated mutation domains;
- unchanged snapshots reuse exact revision-bound derivations rather than recomputing the full read
  model;
- CLI, VS Code, and packaged VSIX return byte-compatible bounded results;
- accepted p50/p95 and module-load budgets improve without weakening authority or cache freshness.

#### [~] DXP-P1-003 — Capability and workspace remote-operation graph

Acceptance gates:

- capability readiness uses one operation-scoped session and asynchronous observations inside its
  bounded worker pool;
- four delayed probes with four workers complete in one delay wave and never exceed four active Git
  processes;
- workspace creation performs one preflight inventory per unique remote, one lead-authority catalog
  transfer, one explicit last-moment freshness revalidation, and one materialization clone per
  repository;
- equivalent observations are reused only inside the operation and invalidated after mutation;
- exact-SHA, stale-plan, authority-race, remote-ref-change, and failed-push tests remain green.

#### [~] DXP-P1-004 — Repository validation, switching, and cache identity

Acceptance gates:

- VS Code activation and repository switching contain no synchronous child process;
- local ref/object validation uses a constant or tightly bounded subprocess count as refs grow;
- remote inventory prioritizes `origin` and probes additional remotes through a cancellable bounded
  pool instead of serial timeout windows;
- snapshot cache keys derive from the current canonical repository, not the repository selected at
  activation;
- A-to-B-to-A switching proves cached snapshots, subject revisions, status chrome, and readiness do
  not cross repository boundaries;
- a high-ref-count fixture keeps extension-host event-loop stalls below 50 ms.

#### [~] DXP-P1-005 — Complete performance fixtures and tail budgets

Acceptance gates:

- the 10,000-file scale tier includes `snapshotUi` and enforces subprocess-growth limits;
- fixtures cover a large ignored build tree, many untracked files, rename bursts, nested working-tree
  changes, submodules, many refs, multiple Stories, and a heavily dirty checkout;
- every interactive command has reviewed p50 and p95 absolute and relative budgets;
- refresh-storm fixtures verify the 750 ms debounce, one trailing refresh, and visible freshness
  within debounce plus the accepted `snapshotUi` p95;
- platform reports distinguish filesystem, Git, Node, and VS Code variance rather than merging them
  into one unexplained latency number.

### P2 — diagnostics and packaging

#### [~] DXP-P2-001 — Superset-aware remote observation reuse

Acceptance gates:

- one fresh `HEAD + refs/heads/*` observation can satisfy later HEAD and named-head subsets inside the
  same operation;
- concurrent overlapping queries coalesce without weakening exact pattern/ref validation;
- mutation invalidation prevents stale in-flight results from repopulating the cache;
- tests prove reduced network-process counts and unchanged authority results.

#### [~] DXP-P2-002 — Accurate enterprise and performance diagnostics

Acceptance gates:

- enterprise Git diagnostics reflect effective system/global configuration and both upper- and
  lowercase proxy variables;
- diagnostics expose source category names only, never values, URLs, identities, paths, or
  credentials;
- the displayed configuration matches the environment actually supplied to the Git supervisor;
- performance reports separate dispatch, module load, local Git, remote Git, parse, publish, render,
  event-loop delay, and peak-memory stages while retaining privacy-safe closed vocabularies.

#### [~] DXP-P2-003 — Extension bundle and activation scope

Acceptance gates:

- gateway-heavy functionality is dynamically imported only when its surface opens;
- extension module-load p50/p95 and bundle size have reviewed release budgets;
- the generic `workspaceContains:workspace.json` activation marker is replaced with an SFlow-specific
  signal or proven not to activate in unrelated workspaces;
- npm and VSIX packaging tests prove every lazy dependency is included without source-tree access.

## Pickup checklist

For each remaining performance acceptance gate:

1. select one open evidence row from the checkpoint table;
2. capture measurements on its approved runtime and topology without changing budgets;
3. record the host, Git, Node, VS Code, proxy/provider, and fixture identity in the evidence;
4. fix a reproduced defect only through the smallest bounded change and rerun the same arm;
5. keep the item `[~]` while any other acceptance bullet remains open;
6. mark `[x]` only after the exact landing commit and release evidence are recorded here.

## Master-roadmap maintenance

- Review this file whenever `SGOS-PENDING-WORK.md`, `WEL-PENDING-WORK.md`, `CAB-ROADMAP.md`, or the
  accepted DX baseline changes.
- Keep the portfolio dashboard a summary; detailed domain acceptance gates remain authoritative in
  their linked documents.
- Remove no history. When a track finishes, record its landing commit and move it to a completed
  section or link its shipped contract.
- Update `Last reviewed` and `Baseline` in the same commit as any status change.
- A roadmap entry must never turn on a feature, weaken a gate, or change a default by itself.
