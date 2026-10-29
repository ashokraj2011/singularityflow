# SDA M0 qualification

Specification: `docs/SPEC-SDA-STORAGE-INDEPENDENT-WORKFLOW-v1.md` (§15 Stage 0, §17, §20 M0).
Engine: `main@c6a65e33b`. Decisions: ADR 0017 (read index engine) and ADR 0018 (lifecycle
authority options).

M0 asks for four things:

- every persistence path classified;
- current authority and recovery semantics recorded;
- read-path baselines on macOS and Windows;
- two decision records.

This file records what was done, what it found, and what remains before M0 can exit.

## How to reproduce

```
node scripts/sda-inventory.mjs --output=benchmarks/sda/inventory.json
node scripts/sda-read-baseline.mjs --samples=5 --files=100 --output=benchmarks/sda/read-baseline-<platform>-<arch>-100.json
node scripts/sda-read-baseline.mjs --samples=3 --files=10000 --output=benchmarks/sda/read-baseline-<platform>-<arch>-10000.json
```

The inventory reads `src/` as syntax trees and runs nothing.

The read baseline builds a disposable workspace with:

- a local bare remote;
- the ledger on;
- three Stories created by `start`.

It runs every process with the repository's isolated machine state and home
(`scripts/test-machine-state.mjs`), and it calls no model and no real network.

## Inventory

`benchmarks/sda/inventory.json` holds counts per module, with no line numbers. `--sites` lists every
call site with its line. `test/sda-inventory.test.mjs` refuses a module that starts Git or writes
files without a class.

It complements the GAL bypass audit (`scripts/git-bypass-audit.mjs`), which freezes where processes
are launched (1,932 sites). This inventory says what each Git call does (read, write, remote) and
which storage role its module plays.

| Measure | Count |
|---|---:|
| Git call sites | 1,400 (811 read, 340 write, 157 remote, 92 with an argv built elsewhere) |
| Modules that start Git | 175 |
| Local Git sites outside `git*.mjs` and the remote boundary (SDA-AC-001's ratchet baseline) | 976 |
| Filesystem write sites | 1,060 |
| Modules that parse YAML | 108 |
| Named lifetimes / named timeouts | 52 / 162 |

| Class | Modules | Git sites | Git writes | Remote Git | File writes |
|---|---:|---:|---:|---:|---:|
| shared-state | 128 | 711 | 194 | 94 | 361 |
| source-control | 56 | 506 | 113 | 45 | 178 |
| surface | 39 | 55 | 14 | 8 | 83 |
| projection | 37 | 38 | 1 | 0 | 95 |
| artifact | 28 | 23 | 4 | 1 | 64 |
| installation | 21 | 27 | 5 | 5 | 159 |
| local-operational | 19 | 9 | 1 | 0 | 65 |
| local-authored | 13 | 31 | 8 | 4 | 55 |

- **Classes.** The classes are SDA §15's, with two changes:
  - `local-draft` is widened to `local-authored`: drafts, journals, outboxes and private bindings,
    which can be the only copy (§6.3).
  - `local-operational` is added for logs, telemetry, leases, run state and preferences.
- **Primary role.** A module has one class, its primary role. Many play several:
  - `ledger.mjs` is shared state, but it also holds the ledger outbox;
  - `git.mjs` is source control, but it also publishes.
- **Heaviest modules.**

  | Module | Git sites |
  |---|---:|
  | `git.mjs` | 207 |
  | `ledger.mjs` | 92 |
  | `organisation.mjs` | 75 |
  | `configuration-branch.mjs` | 46 |
  | `workspace-configuration-refresh.mjs` | 43 |
  | `workspace.mjs` | 40 |
  | `state.mjs` | 35 |
  | `sgos/candidate-lifecycle.mjs` | 32 |

- **Surfaces that start Git themselves** (SDA §4 wants them to go through services):
  - `cli.mjs` (15 reads, 4 writes, 1 remote);
  - `first-run-guide.mjs` (8 writes);
  - `commands/story.mjs`, `commands/secrets.mjs`, `commands/session.mjs`, `commands/auto.mjs`;
  - `commands/shared/session-repository-authority.mjs`;
  - `doctor.mjs`;
  - `cli-entry.mjs`.
- **Counts are a floor.** A wrapper call whose argv is a variable (`git(args)`) cannot be resolved
  statically and is not counted.

### Lifetimes that compete with the repository-check interval

SDA §8 makes the repository-check setting (default `cached`, 30 minutes) the only advisory interval.
The inventory finds these freshness-type lifetimes hard-coded elsewhere. M2 either derives each from
that setting or documents it as a validity bound:

- `GIT_FACT_TTL_MS` 15 minutes (`git-fact-cache.mjs`)
- `MAX_AGE_MS` 5 minutes and `IDLE_MS` 1 minute (`read-worker-client.mjs`)
- `REFRESH_CACHE_MAX_AGE_MS` 2 hours (`workspace-configuration-refresh.mjs`)
- `cursorTtlMs` and `cacheTtlMs` 15 minutes (`repositories/constants.mjs`)
- `INTAKE_TTL_MS` 30 minutes (`gateway/kernel.mjs`)
- `STORY_INTAKE_RECEIPT_TTL_MS` 15 minutes (`story-intake-receipt.mjs`)
- `MAX_AGE` 30 minutes (`copilot-mutation-guard.mjs`, `copilot-repository-boundary.mjs`)
- `REFRESH_MS` 12 hours (`build-currency.mjs`)
- `AVAILABLE_TTL_MS` 30 seconds and `UNAVAILABLE_TTL_MS` 1 minute (`git-storage-availability.mjs`)
- `GITHUB_ACCOUNT_TTL_MS` 10 minutes (`git.mjs`)

The remaining named lifetimes are lock staleness, leases, receipts and retention. They are bounds, not
freshness.

## Read baseline (macOS)

Run on macOS arm64 (Apple M4), Node 22.14.0, Git 2.54.0, with 3 Stories and the ledger on.

- **Method:** a fresh CLI process per sample, medians over 5 samples (100 files) and 3 samples
  (10,000 files). OS caches were not flushed.
- **Conditions:**
  - *Fresh cache:* the repository-check cache was filled immediately before the read.
  - *Forced:* repository-check mode `always`, which is what an expired cache costs.
  - *Offline:* the remote repository was moved away.
- **Source of the counts:** Git process counts come from the subprocess probe. Remote operations come
  from the command's `--timings` line where it writes one.

| Read (from the Story checkout) | Fresh cache | Forced refresh | Offline, fresh cache | Offline, after expiry |
|---|---|---|---|---|
| Story list (`session candidates`) | 259 ms, 0 Git | 440 ms, 15–16 Git, 1 remote | answers, 0 Git | **refuses** `SESSION_STATE_REFRESH_UNAVAILABLE` |
| `status` | 124 ms, 0 Git | 117 ms, 0 Git | answers | answers |
| `nextsteps` | 243 ms, 2 Git | 311 ms, 8 Git | answers | answers |
| Intake catalog (`workspace branches --intake`) | 79 ms, 0 Git | 821 ms, 20 Git, 1 remote | answers, 0 Git | **refuses** `REMOTE_REMOTE_NOT_FOUND` |
| Repository snapshot | 104 ms, 3 Git | 124 ms, 3 Git | answers | answers |
| `check` | 641 ms, 43 Git | 590 ms, 43 Git | answers | answers |

At 10,000 tracked files the counts are the same. Times stay within about 12% (`nextsteps` 243 to
271 ms), except the repository snapshot, which goes from 104 to 175 ms with one more Git process.

**Findings:**

1. **Expiry offline is the gap SDA-AC-021 targets.** The Story list and the intake catalog refuse once
   their cache has expired and the remote is unreachable. Everything answers from a fresh cache.
2. **`check` discards the intake catalog's cache.** The next catalog read refetches online, and refuses
   offline even though nothing about the catalog changed. M2's invalidation must mark records stale,
   not delete them (ADR 0017).
3. **Some reads start Git even with a fresh cache.** `nextsteps` starts 2 Git processes and the
   repository snapshot 3–4. Against SDA §17's zero-Git budget these are M2 work. Trace them with
   `SINGULARITY_FLOW_SUBPROCESS_TRACE`.
4. **`status` already meets the budget**: 0 Git in every condition.
5. **`check` is an explicit local refresh by design** (43 Git, no remote) and is outside the
   zero-Git budget.

## VS Code runtime

- **Measured:** VS Code 1.143.1 runs Electron 43.7.7 with Node 24.21.0, and `node:sqlite` loads there
  (`DatabaseSync`). The command was
  `ELECTRON_RUN_AS_NODE=1 "<VS Code>.app/Contents/MacOS/Code" -e "…"`. The extension host runs on the
  same Electron.
- **Not measured:** the extension's declared minimum, VS Code 1.90.0, shipped Electron 29 with
  Node 20.9 per its release notes. That version has no `node:sqlite`.

This answers SDA Appendix A question 1. ADR 0017 keeps the extension's floor because Phase A needs no
SQL engine.

## Open before M0 exits

- **Windows baselines.** Run the two baseline commands above on native Windows and commit the reports.
  The scripts are written for it, but have not been run there.
- **The accepted DX baseline** (`benchmarks/dx/accepted-baseline.json`, status `unestablished`).
  `scripts/dx-benchmark.mjs` accepts it only from a GitHub-hosted `ubuntu-latest` runner, and the
  repository has no workflow that runs one. Establishing it needs a CI workflow, which is a separate
  decision.
- **Maintainer review of the classification.** One class per module is a judgement. The rules and
  overrides in `scripts/sda-inventory.mjs` say why each module got its class.
- **ADR 0018's decision.** It gates Stage 3, not M1 or M2.
