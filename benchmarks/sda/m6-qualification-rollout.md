# SDA M6: performance qualification and staged rollout

Specification: `docs/SPEC-SDA-STORAGE-INDEPENDENT-WORKFLOW-v1.md` (§17, §18, §20 M6, §21).
Authority: ADR 0018 option A. Read index: ADR 0017. Engine: `main@e34fb6dbf` plus this change.

M6's exit condition: matched native reports, compatibility evidence and operator recovery
documentation approved. Windows was parked by decision of the repository owner (2026-10-30) and
measured on 2026-10-31, under Matched reports (Windows).

## What landed

| Deliverable | Where | Checked by |
|---|---|---|
| Read and write baseline: expired-cache conditions, draft save, takeover, another build through the same harness | `scripts/sda-read-baseline.mjs` (report schema 2) | the matched runs below |
| Matched macOS reports, the build before SDA and this one | `benchmarks/sda/m6-read-baseline-darwin-arm64-*.json` | this report |
| Compatibility: Stories the build before SDA wrote, used by this one | `scripts/sda-legacy-check.mjs`, `benchmarks/sda/m6-legacy-check-darwin-arm64.json` | 18 checks, all pass |
| SDA-AC-009: pinned and amended Stories, `cfp-` and `cft-` derivations | `test/sda-acceptance-009.test.mjs` | the test |
| Operator recovery documentation | `docs/SDA-OPERATOR-RECOVERY.md` | approved by the repository owner, 2026-10-31 |
| The two SDA contracts move to `v1` | `src/sda/shared-state-contract.mjs`, `src/sda/lifecycle-authority-contract.mjs` | `test/sda-contract-v1.test.mjs` |
| A composed step's processes count in the subprocess probe | `src/cli-steps.mjs` | `test/cli-steps.test.mjs` |

## Finished before M6

The other half of finishing SDA was done in batches, on `main` before this change:

| Commit | What it finished |
|---|---|
| `2b75c3910` (B4) | Cancellation through the publication unit of work (SDA §7.3); GDP review SDA-LIFECYCLE-CANCELLATION |
| `acae8337b` (B1) | Lease identity for shared and restored homes (PID namespace, hardware record); the mixed-build drafts test |
| `c9cf696db` (B5) | The consistency block in `sflow-result` v2; intake clones a deferred member; SDA-AC-008 and SDA-AC-015 |
| `7303327b5` (B6) | Capability edits and workflow proposal reads by exact objects; every remaining clone listed |
| `21c3414dd` (B3) | SDA-AC-007, 010 and 020 tests; `status` says when its last transition is unpublished |
| `66d819745` (B2) | Takeover ready after a first publication; a lost approval answer stays unknown; SDA-AC-004 and 006 |
| `1445e4653` (B6b) | More exact-object reads; a draft save measures 9 local Git processes in its test's fixture (11 in this report's, 6 after the fix under open items) |

## Matched reports (macOS)

**Method.** One harness, one fixture and one machine, run back to back, for two builds:
- **before:** `main@c6a65e33b`, the commit that proposed SDA v1.1, with no SDA code;
- **after:** this change.

`node scripts/sda-read-baseline.mjs --cli-root=<worktree of c6a65e33b>` runs the older build's CLI
under this harness. Both builds get the same fixture: a local bare remote, the ledger on, Stories
created by the build's own `start`. Each sample is a fresh CLI process, and OS caches are not flushed.
Every process runs with an isolated machine state and home, with no model and no real network.

**Conditions.**
- *Fresh cache:* the repository-check record was filled just before the read.
- *Expired:* every repository-check record was aged 31 minutes, past the fixture's 30-minute
  interval, before each sample. The background refresh an expired read starts is off, as in tests.
- *Forced refresh:* repository-check mode `always`, which recomputes whatever the cache holds.
- *Offline:* the remote repository is moved away.

**Writes.**
- *Draft save:* `instruction create` from the Story checkout. Each sample saves a new draft, after one
  unmeasured save.
- *Takeover:* another laptop takes the first Story over. Each sample is its own clone, with its own
  machine state and home, made before any Story existed, so every takeover fetches the Story.

Run on macOS arm64 (Apple M4), Node 22.14.0, Git 2.54.0, at load averages between 4 and 8 with no
other tests running. Medians, in milliseconds; Git and remote counts are the range over the samples.
`stale` and `refresh-failed` are the freshness the read reported. Every read answered unless it says
**refuses**.

**100 files, 3 Stories, 5 samples** (`m6-read-baseline-darwin-arm64-before-100.json`, `-after-100.json`).

**Fresh cache**

| Read | Before | After |
|---|---|---|
| Story list (`session candidates`) | 253 ms, 0 Git | 253 ms, 0 Git |
| `status` | 113 ms, 0 Git | 118 ms, 0 Git |
| `nextsteps` | 237 ms, 2 Git | 246 ms, 2 Git |
| Intake catalog (`workspace branches --intake`) | 76 ms, 0 Git | 81 ms, 0 Git |
| Repository snapshot | 99 ms, 3 Git | 107 ms, 3 Git |
| `check` | 583 ms, 43 Git | 641 ms, 43 Git |

**Expired**

| Read | Before | After |
|---|---|---|
| Story list (`session candidates`) | 435 ms, 15–16 Git, 1 remote | 267 ms, 0 Git, stale |
| `status` | 112 ms, 0 Git | 115 ms, 0 Git |
| `nextsteps` | 237 ms, 2 Git | 238 ms, 2 Git |
| Intake catalog (`workspace branches --intake`) | 749 ms, 20 Git, 1 remote | 77 ms, 0 Git, stale |
| Repository snapshot | 100 ms, 3 Git | 102 ms, 3 Git |
| `check` | 577 ms, 43 Git | 608 ms, 43 Git |

**Forced refresh**

| Read | Before | After |
|---|---|---|
| Story list (`session candidates`) | 448 ms, 15 Git, 1 remote | 458 ms, 15 Git, 1 remote |
| `status` | 115 ms, 0 Git | 114 ms, 0 Git |
| `nextsteps` | 303 ms, 8 Git | 310 ms, 8 Git |
| Intake catalog (`workspace branches --intake`) | 734 ms, 20 Git, 1 remote | 745 ms, 20 Git, 1 remote |
| Repository snapshot | 106 ms, 3 Git | 106 ms, 3 Git |
| `check` | 610 ms, 43 Git | 607 ms, 43 Git |

**Offline, fresh cache**

| Read | Before | After |
|---|---|---|
| Story list (`session candidates`) | 252 ms, 0 Git | 250 ms, 0 Git |
| `status` | 112 ms, 0 Git | 113 ms, 0 Git |
| `nextsteps` | 239 ms, 2 Git | 239 ms, 2 Git |
| Intake catalog (`workspace branches --intake`) | 76 ms, 0 Git | 79 ms, 0 Git |
| Repository snapshot | 103 ms, 3 Git | 103 ms, 3 Git |
| `check` | 594 ms, 43 Git | 591 ms, 43 Git |

**Offline, expired**

| Read | Before | After |
|---|---|---|
| Story list (`session candidates`) | **refuses** `SESSION_STATE_REFRESH_UNAVAILABLE` | 254 ms, 0 Git, stale |
| `status` | 114 ms, 0 Git | 113 ms, 0 Git |
| `nextsteps` | 240 ms, 2 Git | 242 ms, 2 Git |
| Intake catalog (`workspace branches --intake`) | **refuses** `REMOTE_REMOTE_NOT_FOUND` | 78 ms, 0 Git, stale |
| Repository snapshot | 102 ms, 3 Git | 105 ms, 3 Git |
| `check` | 572 ms, 43 Git | 601 ms, 43 Git |

**Offline, forced refresh**

| Read | Before | After |
|---|---|---|
| Story list (`session candidates`) | **refuses** `SESSION_STATE_REFRESH_UNAVAILABLE` | 410 ms, 11 Git, 1 remote, refresh-failed |
| `status` | 115 ms, 0 Git | 117 ms, 0 Git |
| `nextsteps` | 309 ms, 8 Git | 304 ms, 8 Git |
| Intake catalog (`workspace branches --intake`) | **refuses** `REMOTE_REMOTE_NOT_FOUND` | 283 ms, 6 Git, 2 remote, refresh-failed |
| Repository snapshot | 100 ms, 3 Git | 103 ms, 3 Git |
| `check` | 586 ms, 43 Git | 567 ms, 43 Git |

**Writes**

| Write | Before | After |
|---|---|---|
| Draft save | 1086 ms, 19 Git, 1 remote | 787 ms, 11 Git, 0 remote |
| Draft save, offline | **refuses** `REMOTE_REMOTE_NOT_FOUND`, 378 ms, 5 Git, 1 remote | 792 ms, 11 Git, 0 remote |
| Takeover on another laptop | 2068 ms; not comparable: that build's probe misses its composed steps (28 Git seen) | 2085 ms, 104 Git, 3 other, 3 remote |

**Takeover's processes (this build):**
- 104 Git processes, 3 of them remote: 2 fetches and an `ls-remote`;
- the two steps it runs as their own CLI processes (`session attach`, `documents list`);
- `gh api user` in the attach step, which on a real laptop asks GitHub who the person is.

**10,000 files** (3 samples), and **30 Stories** (this build, 3 samples). The counts match the
100-file run in every row. The times:

| Row | Before, 10,000 files | After, 10,000 files | After, 30 Stories |
|---|---|---|---|
| Story list, expired | 428 ms, 15–16 Git, 1 remote | 256 ms, 0 Git, stale | 249 ms, 0 Git, stale |
| Intake catalog, expired | 722 ms, 20 Git, 1 remote | 78 ms, 0 Git, stale | 78 ms, 0 Git, stale |
| Story list, offline after expiry | **refuses** | 254 ms, stale | 257 ms, stale |
| Intake catalog, offline after expiry | **refuses** | 78 ms, stale | 78 ms, stale |
| Repository snapshot, fresh | 170 ms, 4 Git | 164 ms, 4 Git | — |
| `check`, fresh | 681 ms, 43 Git | 642 ms, 43 Git | — |
| Draft save | 1,086 ms, 19 Git, 1 remote | 783 ms, 11 Git, 0 remote | 788 ms, 11 Git, 0 remote |
| Takeover | 2,841 ms | 2,738 ms, 104 Git, 3 remote | 2,202 ms, 104 Git, 3 remote |

The repository snapshot is the only read that grows with the repository: one more Git process and
about 65 ms. Nothing grows with the number of Stories.

**What changed between the builds.**
- **An expired cache no longer waits on the remote.** The Story list and the intake catalog answer
  from their last verified record as `stale`, with 0 Git and 0 remote, where the build before SDA
  recomputed: 15–20 Git processes and one remote round trip each. The catalog falls from about 730 ms
  to under 80 ms.
- **Offline after expiry, both answer** where the build before SDA refused
  (`SESSION_STATE_REFRESH_UNAVAILABLE`, `REMOTE_REMOTE_NOT_FOUND`). The same holds for a forced
  refresh offline: they answer `refresh-failed`, with the real error.
- **A draft save no longer contacts the remote and works offline.** It takes 11 local Git processes
  where the build before SDA took 19 and a remote round trip, and refused offline.
- **Everything else is unchanged.** `status`, `nextsteps`, the repository snapshot and `check` have
  the same counts and times within a few percent, fresh or forced, online or offline. A forced refresh
  online costs the same as before: it is an explicit recomputation.

**How to reproduce.**

```
git worktree add --detach ../sf-before c6a65e33b && ln -s ../<this checkout>/node_modules ../sf-before/node_modules
node scripts/sda-read-baseline.mjs --samples=5 --files=100 --cli-root=../sf-before --output=before-100.json
node scripts/sda-read-baseline.mjs --samples=5 --files=100 --output=after-100.json
node scripts/sda-read-baseline.mjs --samples=3 --files=10000 [--cli-root=../sf-before]
node scripts/sda-read-baseline.mjs --samples=3 --stories=30
node scripts/sda-legacy-check.mjs --legacy-cli-root=../sf-before --output=legacy.json
```

## Matched reports (Windows)

**Method.** The macOS harness, fixture and builds, on native Windows (2026-10-31; Windows had been
parked). The temporary workflow `.github/workflows/sda-windows-qualification.yml` on the branch
`ci/sda-windows-20261031` (not on `main`), run 41165394303:
- **before:** `main@c6a65e33b`; **after:** `main@2d29d7473`. The reports name the branch head
  `1f8e11839`, which adds only the workflow and the harness's refusal message to that commit.
- GitHub's `windows-latest`: Windows Server 2025 (build 26100), AMD EPYC 9V45, Node 26.12.0, Git
  2.56.0 for Windows. Each before/after pair ran in one job, on one machine; the 100-file and
  10,000-file pairs ran on two machines.
- Reports: `m6-read-baseline-win32-x64-{before,after}-{100,10000}.json`,
  `m6-read-baseline-win32-x64-after-30-stories-100.json` and `m6-legacy-check-win32-x64.json`.

Hosted machines are noisier than the Mac: compare counts, and times only within a pair. Medians;
Git and remote counts are the range over the samples (5 at 100 files, 3 at 10,000 and 30 Stories).

**What changed between the builds:**

| Row | Before, 100 files | After, 100 files | Before, 10,000 files | After, 10,000 files | After, 30 Stories |
|---|---|---|---|---|---|
| Story list, expired | 1,232 ms, 15–17 Git, 1 remote | 658 ms, 0 Git, stale | 1,024 ms, 15–17 Git, 1 remote | 506 ms, 0 Git, stale | 658 ms, 0 Git, stale |
| Intake catalog, expired | 2,233 ms, 26 Git, 1 remote | 198 ms, 0 Git, stale | 1,781 ms, 26 Git, 1 remote | 158 ms, 0 Git, stale | 192 ms, 0 Git, stale |
| Story list, offline after expiry | **refuses** `SESSION_STATE_REFRESH_UNAVAILABLE` | 674 ms, 0 Git, stale | **refuses** `SESSION_STATE_REFRESH_UNAVAILABLE` | 490 ms, 0 Git, stale | 662 ms, 0 Git, stale |
| Intake catalog, offline after expiry | **refuses** `REMOTE_REMOTE_NOT_FOUND` | 191 ms, 0 Git, stale | **refuses** `REMOTE_REMOTE_NOT_FOUND` | 210 ms, 0 Git, stale | 190 ms, 0 Git, stale |
| Draft save | 2,800 ms, 18 Git, 1 remote | 2,250 ms, 6 Git | 2,371 ms, 18 Git, 1 remote | 1,759 ms, 6 Git | 2,236 ms, 6 Git |
| Draft save, offline | **refuses** `REMOTE_REMOTE_NOT_FOUND` | 2,255 ms, 6 Git | **refuses** `REMOTE_REMOTE_NOT_FOUND` | 1,658 ms, 6 Git | 2,208 ms, 6 Git |
| Takeover on another laptop | 6,537 ms | 6,577 ms, 110 Git, 3 remote | 9,377 ms | 9,420 ms, 110 Git, 3 remote | 6,443 ms, 110 Git, 3 remote |

The same change as on macOS:
- An expired Story list or intake catalog answers from its last verified record as `stale`, with 0 Git
  and 0 remote. The build before SDA recomputed: 15–17 and 26 Git processes and a remote round trip.
  The catalog falls from about 2 s to under 0.2 s.
- Both answer offline after expiry, where the build before SDA refused, and a forced refresh offline
  answers `refresh-failed` with the real error.
- A draft save starts 6 local Git processes and no remote, online and offline. The build before SDA
  took 18 and a remote round trip, and refused offline.
- Everything else starts the same processes in both builds: `status`, `nextsteps`, the repository
  snapshot, `check`, a forced refresh online and the takeover.

**Where Windows differs from macOS, in both builds:**
- `check` starts 51 Git processes (43 on macOS), the intake catalog's forced refresh 26 (20), and a
  takeover 110 (104).
- The Story list with a fresh cache starts 0 Git in most samples and 2 in some (0 on macOS), so it
  is listed as starting Git with a fresh cache.

**Stories the build before SDA wrote:** all 18 checks pass (`m6-legacy-check-win32-x64.json`).

**SDA tests on native Windows**, Node 26 (`test/sda-*.test.mjs`, `test/configuration-drafts.test.mjs`):
- Without the slow lane (run 41165394303): 68 of 69 passed. The failure was the work list's pending
  pushes, a Windows defect fixed below.
- With the slow lane, after the fixes (run 41172364199, `main@1345ec001`): 96 tests, 81 passed, 9
  skipped and 6 failed. The work list now passes its pending-push check and fails later, on a Git shim
  the test writes as a POSIX shell script.
- With the slow lane, after the Windows fixes below (run 41192722032, those fixes on `main@8dd691421`;
  the set adds `test/util.test.mjs`, `test/background-process.test.mjs` and
  `test/worktree-fingerprint.test.mjs`): 141 tests, 141 passed, 0 skipped, 0 failed. No SDA test
  skips on Windows any more: the Git ledger's shared-state conformance suite had skipped there since
  it was written, with no reason given, and its six cases pass.

**Found by the Windows run and fixed on `main`:**
- **Node 22.12 to 22.16 and 23 misreport files on this Windows.** A path `lstat` or `stat` reports
  device 0, while `fstat` of the open file reports the volume, so every same-file check refuses
  ("changed while being opened"); the first run used Node 22.14.0 to match the Mac and failed `init`
  and 16 SDA tests. Node 20.20, 22.17, 22.18, 22.23, 24 and 26 agree. The minimum is now Node 26, the
  managed runtime's line (`54ee93d41`); VS Code runs its bundled engine on its own Node.
- **A remote URL read from the Git configuration file without Git kept Git's escapes and quotes.**
  Git writes a Windows path with its backslashes doubled (`C:\\<HOME>\\...`), so a push another checkout made to the same remote
  was missing from the work list's consistency block. The readers now decode the value as Git does
  (`55ce8103b`).
- **One directory has two spellings.** A Windows process keeps the spelling its working directory
  was given, an 8.3 short name such as `RUNNER~1`, while Git reports the long one, and
  `fs.realpathSync` keeps short names. `index status`, the work list's consistency block and
  retention's in-use check compared the two as strings, so a checkout a command was running in could
  read as unprotected. They now compare canonical spellings (`platformPathWithin` in `util.mjs`), and
  22 calls in 16 modules use `realpathSync.native` (`605e0019e`, `20e3b86e9`).
- **Background work ended with its command.** Windows ends a child started without `detached` when
  its parent exits, so a refresh behind a stale answer never finished. The index refresh, the history
  index, the AST warm-up, configuration reviews and workspace retention now start through
  `src/background-process.mjs`, which on Windows starts the work from a detached relay with a hidden
  console (`d4954756c`).
- **Retention never removed a Story worktree.** Git for Windows sets `core.autocrlf=true` for the
  whole machine, so a checked-out text file holds CRLF and its blob LF. The exhaustive fingerprint
  compared raw bytes, with Git's system configuration off, so every such file read as changed and
  "Detach & drop local" always refused. A file now counts as unchanged when its bytes are exactly
  what Git's checkout writes, with the person's own `core.autocrlf` and `core.eol`; a line-ending-only
  edit is still a change (`d89e68154`).
- **Test fixtures that assumed POSIX:** a signing gitconfig written by hand with raw Windows paths,
  Git shims written as shell scripts, a PID 1 assumed running, a working directory restored after its
  fixture was deleted, and a refresh switch the suite runner sets but a bare `node --test` does not
  (`605e0019e`, `5e3f6df63`, `6573faa93`).

## Budgets (§17, SDA-AC-002, SDA-AC-018, SDA-AC-021)

| Budget (§17) | Measured, this build | Met |
|---|---|---|
| An initialized Story list or catalog read with a verified snapshot starts zero Git, remote or model processes | 0 Git, 0 remote, fresh or expired, online or offline | Yes |
| A local draft save starts zero remote or model processes; local Git only falls (decision D2) | 0 remote, 0 model, 11 local Git (6 after the fix under open items) | Remote and model: yes. Local: 11, down from 19; 6 after the fix |
| An expired advisory read returns last-known state without waiting on the network | `stale` at once, 0 remote | Yes |
| Concurrent refreshes share one authority observation per scope, across processes | `test/sda-read-index.test.mjs` (three processes, one observation) | Yes |
| No ordinary listing creates a checkout or temporary clone, walks source history or reads every artifact body | The Story list and catalog start no Git at all | Yes |

**What still starts Git with a fresh cache** (SDA-AC-018 asks for the remaining bottlenecks):
- `nextsteps`: 2 local reads, the actor's identity and the remote URL. The identity is read fresh on
  purpose (M2).
- The repository snapshot: 3 Git processes at 100 files and 4 at 10,000, including `git status` for
  the worktree it reports.
- `check`: 43 local Git processes. It is the explicit local refresh.
- Takeover: 104 Git processes and `gh api user`, including those of the two steps it runs as their
  own CLI processes. It runs once per laptop.

## Compatibility evidence

- **Stories the build before SDA wrote** (`scripts/sda-legacy-check.mjs --legacy-cli-root=<worktree of
  c6a65e33b>`). That build initializes a repository and starts two Stories: one approved through
  intake, one left at intake. This build then:
  - reads them (`status`, `nextsteps`, the Story list, `ledger verify`, and every stored record of
    both Story branches and the ledger through its family's migrations);
  - rebuilds the index;
  - takes the approved Story over on another laptop, with its own machine state;
  - advances the other Story through intake.

  The older build's bytes stay identical, locally and on the remote. Its ledger entries, written
  before M1 added payload digests, verify with the same count. The advanced Story's new transitions
  sit on top of the older history. Report: `benchmarks/sda/m6-legacy-check-darwin-arm64.json`.
- **Pinned and amended Stories** (`test/sda-acceptance-009.test.mjs`). The approved workflow is
  amended after a Story started. The Story keeps its pinned closure, and its source, closure,
  artifacts, decisions and evidence stay byte-identical, with the ledger and its pins, through:
  - export: the Story published by one laptop, and that laptop's backup;
  - import: another laptop taking the Story over and restoring the backup, and every stored record
    read through its family's migrations;
  - index rebuild on both laptops.

  The other laptop reads the Story under its pinned closure, not the amended one.
- **`cfp-` and `cft-` derivations.** The same test pins a proposal ID and a transaction ID computed
  by the build before SDA from fixed inputs. `src/configuration-state-contract.mjs` has not changed
  since 2026-10-10.
- **Mixed builds** (decision D6, `test/configuration-drafts-store.test.mjs`). An older build that
  writes `drafts.json` after the v2 migration is imported once, and the drafts are unchanged. A newer
  build's draft, proposal or authority record is refused by this build's reader with
  `SCHEMA_VERSION_FUTURE` (M5). The gap that remains, and the rollout that retires it, are below.
- **Result contract.** The consistency block is an optional field of `sflow-result` v2. A result
  without it is byte-identical to before, and an older v2 reader ignores it (B5,
  `test/sda-result-consistency.test.mjs`).
- **Record families.** Every SDA record is a registered family with its golden
  (`test/fixtures/schema-migrations/goldens.json`). A newer version is refused, never rewritten.

## Acceptance criteria

Each criterion of §18, with where it is shown. "Met" means a test or report in this repository
shows it; "part" names what is not shown.

| ID | Status | Evidence |
|---|---|---|
| SDA-AC-001 | Met | `test/source-inspection.test.mjs`: direct local-Git reads per module (`localReads` in `benchmarks/sda/inventory.json`) may only fall, and a fall must be recorded (M1). |
| SDA-AC-002 | Met | `test/sda-read-index.test.mjs` (M2); the matched reports above: the Story list and the intake catalog answer offline after expiry with 0 Git. |
| SDA-AC-003 | Met | `test/configuration-drafts-store.test.mjs` (crash and concurrent saves), `test/configuration-drafts.test.mjs` and `test/sda-index-command.test.mjs` (index rebuild keeps drafts, journals and pending pushes). |
| SDA-AC-004 | Met | `test/sda-m5-takeover.test.mjs` (offline approve is `OUTCOME_UNKNOWN`, a lost answer settles to one approval), `test/publication-faults.test.mjs` (B2). |
| SDA-AC-005 | Met | `test/ledger.test.mjs` (payload digest), `test/transport-intents.test.mjs`, `test/configuration-drafts-store.test.mjs` (`OPERATION_ID_REUSE`). |
| SDA-AC-006 | Met | `test/sda-m5-takeover.test.mjs`: two laptops' Stories both land; a second proposal on one approval group is refused `CONFIGURATION_ENTITY_CONFLICT`; a separate asset lands (B2). |
| SDA-AC-007 | Met | `test/sda-acceptance-007-010-020.test.mjs` (reader side), `test/publication-faults.test.mjs` (writer side). |
| SDA-AC-008 | Part | `test/sda-m5-surfaces.test.mjs`: the CLI, the gateway (the route VS Code and Copilot use) and the read worker agree on two lifecycle states (B5). Hooks are not compared. |
| SDA-AC-009 | Met | `test/sda-acceptance-009.test.mjs` (pinned and amended; `cfp-` and `cft-`); `scripts/sda-legacy-check.mjs` (legacy, against the build before SDA). |
| SDA-AC-010 | Met | `test/sda-acceptance-007-010-020.test.mjs` (imported, looped and future-phase definitions), `test/sda-lifecycle-boundary.test.mjs`. |
| SDA-AC-011 | Met | `test/sda-lifecycle-final-binding.test.mjs` (M4). |
| SDA-AC-012 | Met | `test/sda-m5-multi-laptop.test.mjs` (M5), `test/sda-m5-takeover.test.mjs` (no application branch scan, B2). |
| SDA-AC-013 | Part | `test/configuration-proposal.test.mjs`, `test/capability-value-activation.test.mjs` (M3), `test/sda-clone-boundary.test.mjs` (B6). The clones that remain are listed in that ratchet with their reasons (below). |
| SDA-AC-014 | Met | `test/sda-read-index.test.mjs` (three processes, one observation; M3's fix under load). |
| SDA-AC-015 | Met | `test/sda-m5-surfaces.test.mjs`: denial, empty inventory, absent authority, corruption, timeout and cancellation keep their own codes and recovery (B5). |
| SDA-AC-016 | Met | `test/sda-m5-retention.test.mjs` (M5); `test/sda-names.test.mjs` (machine-state list). No evidence-hold record exists in code; signed evidence lives on published branches, which no cleanup deletes. |
| SDA-AC-017 | Met | `test/sda-conformance.test.mjs`, `test/sda-lifecycle-conformance.test.mjs` (M1, M4; cancellation B4). |
| SDA-AC-018 | Part | This report: macOS meets the budgets; Windows (2026-10-31) meets them except the Story list with a fresh cache, which starts 2 Git processes in some samples (both builds). Each lists its remaining bottlenecks. |
| SDA-AC-019 | Not applicable | ADR 0018 option A migrates no authority. |
| SDA-AC-020 | Met | `test/sda-acceptance-007-010-020.test.mjs` (signed ledger and evidence across index rebuild, record reads and retention). |
| SDA-AC-021 | Met | `test/sda-read-index.test.mjs`, `test/session-listing-cache.test.mjs` (M2); the matched reports above. |
| SDA-AC-022 | Met | `test/finding-identity.test.mjs`, `test/finding-dispute.test.mjs`, `test/finding-escalation.test.mjs` (M2). |
| SDA-AC-023 | Met | `test/sda-names.test.mjs`. |
| SDA-AC-024 | Met | `test/sda-m2-story-identity.test.mjs`, `test/subject-identity-records.test.mjs`, `test/local-identity.test.mjs` (M2). |
| SDA-AC-025 | Met | `test/governed-push-lease.test.mjs` (M1). |

## The contracts move to `v1`

The repository owner approved the plan on 2026-10-30: keep both contracts at `draft-1` until
publication cancellation (B4) and the consistency block (B5) land and M6's qualification passes,
then move both to `v1` together, with this report as the evidence.

- **The move.** `sda-shared-state/draft-1` became `sda-shared-state/v1`
  (`src/sda/shared-state-contract.mjs`), and `sda-lifecycle-authority/draft-1` became
  `sda-lifecycle-authority/v1` (`src/sda/lifecycle-authority-contract.mjs`).
- **What `v1` holds.** Each contract's name, qualifications (`production`, `test-only`), capabilities
  and outcomes, pinned by `test/sda-contract-v1.test.mjs`. A change to any of them is `v2`, with its
  own review.
- **The last changes before the move.**
  - The lifecycle contract's cancellation (B4). It is honoured up to the push: `cancelled` before the
    commit, `retained-locally` after it, and never during the push.
  - The shared-state contract's consistency block (B5).
- **Nothing stored is rewritten.** No record carries a contract version. It lives in each adapter's
  descriptor at run time, and selection compares it with the same constant.

## Operator recovery documentation

`docs/SDA-OPERATOR-RECOVERY.md`, for the people who run Singularity Flow for a team. It covers:
- reads served from last-known state;
- locks held by another process or laptop, and machine identity;
- publications that did not finish, including the cancellation refusals;
- a laptop lost, replaced or handed over, with takeover and backup;
- configuration drafts, cleanup and reset;
- mixed builds and the staged rollout;
- what to collect when asking for help.

It names only commands, codes and fields that exist. The repository owner approved it as written on
2026-10-31, which meets that part of M6's exit.

## Staged rollout

SDA adds no writer fence between builds (ADR 0018, option A). The rollout is the existing
`minimumBuild` update, in four steps:
1. Release the build that carries SDA M3 to M6, and publish it to the release location
   (`docs/RELEASE-ARTIFACT-HANDOFF.md`).
2. Raise `singularity/product.yml` `minimumBuild` to that release, through the configuration review.
   Each teammate's build installs it at their first mutation after its daily check. A requirement is
   never a refusal: when the install cannot happen, the command continues on the running build.
3. Watch for older builds. A new `drafts.json.migrated-v2-N` file means an older build still wrote
   drafts on that clone after the newer one migrated them.
4. A rollback is a newer release with the fix. A machine never installs a build older than the one it
   runs.

**The one gap until step 2 completes.** A change an older build still holds in `drafts.json` can come
back as a waiting draft after the newer build proposed it (B1). The older build does not see drafts
the newer build saved.

## Fixed on the way

**Composed steps were invisible to the probe.** `session takeover` runs `session attach` and `documents list` as their own CLI processes
(`src/cli-steps.mjs`). Their Git work went to stderr the parent captured and dropped. So
`SINGULARITY_FLOW_SUBPROCESS_PROBE` reported 28 processes and no fetch for a takeover that fetched the
Story and created its worktree. With the probe on, the composing command now counts each step and
every process the step started. Without the probe, nothing changes. The `--timings` counters still
cover the composing process only, so the baseline takes the larger of the two remote counts.

**Two tests were red on `main` since B5 and B6b.** The full suite below found both:
- The SDA-AC-025 push scan (`test/governed-push-lease.test.mjs`) read B5's
  `PENDING_OPERATION_KINDS`, `Object.freeze(['push'])`, as a Git push with no lease. A frozen
  constant list is not a process's arguments, so the scan now skips one.
- B6b's `includeFiles` in `src/configuration-object-store.mjs` started its own `ls-tree`. That
  raised the module's local Git reads from 1 to 2, over SDA-AC-001's ceiling
  (`test/source-inspection.test.mjs`). It now lists the files through the pool's
  `ConfigurationObjectReader`: the same tree listing, admitting regular files only, bounded, with
  lazy fetch sealed off. The module is back to 1, and the Git bypass baseline has one site fewer.

**A fixture raced Git's background maintenance.** `test/review-safe-commits.test.mjs` amends a
commit with plain Git. Git 2.54 then starts detached automatic maintenance, which was still writing
`objects/pack` when the test removed the directory (`ENOTEMPTY`). It failed alone as well as in the
suite. Its Git helper now turns automatic maintenance off, as the other fixtures that commit do.

## Verification

- **Full suite, slow lane on**, on `main@e34fb6dbf` plus this change before the fixes above:
  - 16 shards, 1,351 files, 12,781 tests;
  - 12,761 passed, 16 skipped, 4 failed, in 84 minutes.
- **The four failures:**
  - the two tests red on `main` (above);
  - the maintenance race in `test/review-safe-commits.test.mjs` (above);
  - `test/workspace-run-runtime.test.mjs`: a service missed its 5-second readiness window at a load
    average near 18. It passed on its own.
- **After the fixes**, these 17 files ran again with the slow lane: the four that failed, every file that
  imports the configuration object store or reader, the Git bypass audit, the clone boundary, the files
  that read the capability map through the pool, configuration drafts, the bundle budgets and DX
  performance. 476 of 477 tests passed. The one failure was the maintenance race, which then passed
  three runs out of three with its fix.
- `node scripts/check.mjs` and `node scripts/git-bypass-audit.mjs` pass.
- **Native Windows, 2026-10-31:** the SDA tests above (Matched reports (Windows)); the matched reports
  and the legacy check ran in the same workflow.

## Names (SDA-AC-023)

M6 adds no command, configuration key, refusal code, record family or machine location. The two
contract versions change within their prefixes, each owned by its contract module in
`test/sda-names.test.mjs`: `sda-lifecycle-authority/` since M4, and `sda-shared-state/`, listed in M6.
The new scripts are qualification tools: they are not part of the command registry.

## Open after M6

- **Windows:** measured 2026-10-31 (above), and every SDA test passes there with the slow lane. Open
  there:
  - the Story list with a fresh cache starts 2 Git processes in some samples (SDA-AC-018);
  - a proposal upload started with `--background-sync` still ends with its command: it forks with an
    IPC handshake rather than starting through `src/background-process.mjs`. The outbox keeps the
    proposal, and the next `sync` uploads it;
  - the destructive proof's own `git status` reads run without the system `core.autocrlf`, so a
    racily clean CRLF file can read as modified there. That keeps a checkout; it never removes one;
  - that the relay opens no console window was not observed: the hosted runner has no desktop.
- **SDA-AC-008:** hooks are not compared with the CLI, the gateway and the read worker.
- **SDA-AC-013:** the clones that remain are listed, with their reasons, in
  `test/sda-clone-boundary.test.mjs`:
  - capability proposal listing, inspection and rebase preview, whose validation needs a working tree;
  - onboarding snapshots, the quota-checked blobless survey;
  - state-mirror reads, where a depth-one clone is cheaper than the pool for ledger history;
  - configuration clones for a Story start without the object cache.
- **The consistency block** is attached by the gateway's `work.list` and `home.overview`. Session
  reads, the change flight plan, `nextsteps` and the snapshot coordinator do not attach it yet
  (decision D8).
- **Cancellation:** no production command passes a signal yet (B4). The two cancellation refusals
  exist, are tested, and appear once a command cancels.
- **Fixed after M6: a draft save took 11 local Git processes here, not 9.** The save checks the
  change in the approved-configuration read's copy of the approved files, which has no Git. B6b's
  batched read of the editor's baseline, the committed `workflow.yml` and `portfolio.yml` at `HEAD`,
  failed there, and so did the four reads it falls back to; the baseline came back empty, as it did
  before B6b. The editor now asks no Git for that copy and the baseline is the same. The same harness
  then measures 6 local Git processes and 0 remote, online and offline (`--samples=3 --files=100
  --stories=1`). The tables above are the measurement at `6a0d0a650`.
- **Mixed builds** keep the one gap described under the rollout until `minimumBuild` is raised.
- **Not measured:** slow networks, and process-cold apart from warm runs.
- **Evidence holds:** no hold record exists in code (SDA-AC-016).
- **Decided after M6: the specification's status.** The repository owner accepted it on 2026-10-31.
