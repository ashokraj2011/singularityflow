# SDA M2: the read index and identity

Specification: `docs/SPEC-SDA-STORAGE-INDEPENDENT-WORKFLOW-v1.md` (§5, §8, §11, §14, §17, §20 M2).
Engine: `main@fa3094b83` plus this change. Index engine: ADR 0017 (the existing JSON projections, no
new storage engine).

M2's exit condition: lists, catalogs and advisory sessions meet the zero-Git budgets on macOS and
Windows, and SDA-AC-002, 013, 014 and 021–024 hold.

- **macOS:** the budgets are met (below).
- **Windows:** not measured. That part of the exit stays open with M0's Windows baselines.

## What landed

| Deliverable | Where | Checked by |
|---|---|---|
| Read index with serve-last-known | `cachedCheck` in `src/repository-check-cache.mjs`; `LAST_KNOWN_KINDS` (Story list, intake catalog) | `test/sda-read-index.test.mjs`, `test/session-listing-cache.test.mjs` |
| Cross-process refresh coalescing | `coalescedRefresh` (a `file-lease.mjs` lease beside each record); `src/index-refresh-launcher.mjs` | `test/sda-read-index.test.mjs` (three processes, one observation) |
| Configuration reads without a clone | `INSPECTION_READ` in `src/approved-configuration-reader.mjs`; `exactObjectStoryConfigurationSnapshot` in `src/configuration-branch.mjs` | `test/story-configuration-object-cache.test.mjs` |
| Identity leaks closed (§5 table) | session discovery, `src/story-index.mjs`, `src/repository-local-id.mjs`, `src/transport-intents.mjs`, `src/subject-identity-records.mjs`, `src/local-identity.mjs`, Auto | `test/sda-m2-story-identity.test.mjs`, `test/subject-identity-records.test.mjs`, `test/local-identity.test.mjs`, `test/change-flight-plan.test.mjs` |
| Canonical finding IDs | `src/finding-identity.mjs`; the code-delivery gate; disputes and escalation | `test/finding-identity.test.mjs`, `test/finding-dispute.test.mjs`, `test/finding-escalation.test.mjs` |
| `index status/refresh/rebuild/verify` | `src/commands/read-index.mjs` | `test/sda-index-command.test.mjs` |
| SDA names (SDA-AC-023) | — | `test/sda-names.test.mjs` |

## Serve last-known (SDA §8, SDA-AC-021)

The Story list (`session candidates`) and the intake catalog (`workspace branches --intake`) are the
two reads M0 found refusing offline after expiry. Each is now served from its last verified record.

| Situation | Before | Now |
|---|---|---|
| Within the interval, nothing it depends on changed | cache hit | unchanged: `fresh` |
| Past the interval, nothing it depends on changed | recomputed, waiting on the remote; offline it refused | served at once as `stale`; a replay of the read refreshes it in the background |
| Something it depends on changed (a local ref, `check`, `--refresh`) | recomputed; offline it refused | recomputed; if the authority cannot be reached, served as `refresh-failed` with the real error |
| A refusal that is not about reaching the authority (no such workspace) | refused | refused (never masked) |
| No record yet | first read local, then the remote | unchanged: never synchronized is not an empty inventory |
| A record checked "in the future" (the clock moved back) | refused as a miss | still no record: never served |
| The repository's remote changed, or another repository is selected | refused or recomputed | never served: each record is bound to its authority (the repositories it was read in and their remote URLs, read from Git configuration with no process) |

What this changes for a person:

- **What each answer reports.** It carries `freshness` (`fresh`, `stale`, `refresh-failed`),
  `completeness`, `checkedAt` and, when a refresh failed, `refreshError`. The error is bounded: its
  code, message, outcome class and the Git diagnosis (stage, classification, retryable, timed out).
  - The listing's `--diagnostics` and the roster show it.
  - The stderr notice names it: "Using the last-known (refresh failed: …) Story listing".
  - The catalog's human output warns when it is stale or refresh-failed.
- **The background refresh replays the read.** It runs the read again with
  `SINGULARITY_FLOW_INDEX_REFRESH=1`, detached, under the record's lease.
  - A failed refresh is not retried for 60 seconds.
  - Its error is kept beside the record (`<record>.refresh.json`), so the next read says
    `refresh-failed` rather than `stale`.
  - Test runs turn it off (`scripts/test-machine-state.mjs`), so no replay outlives a test.
- **Two existing tests changed their expectation, as SDA-AC-021 requires.**
  - An offline `--refresh` used to refuse with `SESSION_STATE_REFRESH_UNAVAILABLE`; it now answers
    from the last-known listing with that code as its `refreshError`.
  - A failed explicit refresh used to make every later read refuse; they now answer `refresh-failed`.
- **Verification records are unchanged.** Phase entry, next steps, the readiness preview and the
  accepted-workflow checks are not served last-known: an expired or disproved record is recomputed
  and its refusal stands. A final governed check never reads the index (SDA-AC-011 is untouched).

## Cross-process coalescing (SDA-AC-014)

- **The refresh lease.** Every refresh of a last-known record holds `<record>.lease`
  (`acquireFileLease`, reclaimed when its owner dies).
- **A routine read that finds the lease held** waits up to 30 seconds. It then takes the record the
  other process wrote, when nothing it depends on has changed since it began waiting (`source:
  'shared'`).
- **An explicit refresh** waits too, then makes its own observation.
- **The test:** three processes refresh one record at once, and the verifier runs once.
- **The interval is still the repository-check setting.** Explicit refresh bypasses it.

## Zero Git (SDA-AC-002, §17)

- **The test.** With the remote moved away and the record expired, `session candidates` answers
  `stale` and `complete`. It starts 0 Git processes and 0 network operations, on two consecutive
  reads.
- **No-Git environment.** No Git process starts, so whether Git could run does not matter. A
  different `PATH` is a different record by design: the record binds the environment it was
  computed in.
- **The intake catalog** answers offline after expiry with 0 remote operations.
- **Still not zero:**
  - `nextsteps` starts two local Git reads on a warm cache: `git config` for the actor and
    `git remote get-url`. The identity read is deliberately fresh, because a cached identity would
    let a one-time authorization pass to another person (`src/git.mjs`, `identity`). Neither read
    touches the network.
  - The repository snapshot runs `git status` for the worktree revision, which is the state it
    reports.

## Configuration reads without a clone (SDA-AC-013)

- **What changed.** `workflow list`, `config read`, `config validate` and `config snapshot` (the
  editor's slices) opt into exact-object reads (`INSPECTION_READ`).
- **The order they try:**
  1. the workspace and prepared snapshots;
  2. the machine-wide bare cache;
  3. a new fallback: the authority commit's objects are fetched into the application repository and
     read there (the transfer Story intake already prepares, `refs/sflow/intake-configuration/selected`).
- **Where the fallback matters.** The bare cache declines on Windows, where its ACL trust cannot be
  established, and for unusual remotes. There, the new fallback means no temporary clone.
- **The temporary clone remains only as the last resort.**
- **Unchanged:**
  - Gateway reads stay off the derived cache, as before.
  - One fresh authority observation still admits every read.
- **Typed editing without a checkout** is M3's deliverable ("typed configuration intent") and is not
  part of this change.

## Identity (SDA §5, SDA-AC-024)

| Leak | Now |
|---|---|
| Discovery refused a Story whose recorded branch differs from the ledger pointer's | Listed by its Work ID at the ledger's branch, with `bindingFinding: { code: 'STORY_BRANCH_BINDING_MISMATCH', recordedBranch, ledgerBranch }`. A Work ID mismatch is still refused. The Story summaries cache never stores such a row, because an older build would drop the field. |
| The Story index took a branch name as a lookup | Only a recorded alias matches. A legacy entry without aliases uses its recorded branch. |
| Auto assumed branch = Work ID | The plan records its branch, and start, rollback, recovery, the checkpoint clone and `auto recover` use it. A recovered Story must record the same branch. |
| Epic and Initiative IDs from a branch inventory | Allocation, Initiative resume, the Initiative list and goals read the ledger's identity records (`src/subject-identity-records.mjs`). An ID the records do not know is refused (`INITIATIVE_IDENTITY_UNRECORDED`). Local Epic reservations now write a ledger entry. |
| A repository without a remote was keyed by `gitdir:<path>` | It gets a random ID, created once in `<common dir>/singularity-flow/local-repository-id`, as key `repo:<id>`. Legacy `gitdir:` entries still match and are rewritten when next recorded. |
| Push intents stored the absolute checkout path | New intents carry `repository: { id, key }`. A retry resolves its checkout locally: the recorded path while it still holds the repository, else a Story-index checkout of the same repository that pushes to the same URL and holds the commit. M1's operation digest is unchanged. |

**Ledger off.** With the ledger off there are no identity records. Allocation, the list, goals and
resume keep today's branch scan, and say so (`identitySource: 'branch-scan-ledger-off'`).

**What is not done:**
- **A Story listed with a binding finding.** `session attach` still refuses it. That is the safe
  direction: it is listed with its finding, and attaching it waits on a decision about which
  branch to bind.
- **An Auto plan whose recorded branch differs from its Work ID.** It is refused before any effect
  (`AUTO_STORY_BRANCH_UNSUPPORTED`), because Story start (`story-start.mjs`) names a new branch by
  the Work ID. Plans record the Work ID as the branch, so only a hand-altered plan reaches this.
- **Reading identity records is linear in the ledger's length** (paged, 1,000 entries a page).

## Canonical finding IDs (SDA-AC-022)

- **The ID.** Every problem the code-delivery gate reports now carries an identity `{code, path,
  value}` in the same order as its sentence. The canonical ID is `FND-` followed by 24 hex
  characters of its digest.
  - It never covers a message or a line number.
  - Aggregated sentences (several clause IDs) are one finding whose value is the sorted set.
  - The refusal carries `details.findings` and `details.findingIds`. The sentences are unchanged.
- **New disputes** store each entry as `<ID> <sentence>` in the existing schema-3 `problems` field.
  - A dispute covers a current finding by its ID, whatever the sentence now says.
  - A record made before IDs keeps matching its exact sentences. That is the migration alias,
    resolved when the record is read: records are append-only and hash-bound, so it cannot be
    written into them.
  - An older client reads the new records and fails closed on them: it compares whole sentences.
- **Escalation** fingerprints a finding by its code and canonical IDs, or by `{code, path, value}`,
  and never by wording.
- **Uncovered corner cases** keep their own codes and use `symbol:category` as the value. Their
  obligation ID carries a line number.

## `index` (SDA §14)

| Command | Does | Never |
|---|---|---|
| `index status` | Each record's freshness, last refresh and error, whether a refresh is running, the Story summaries file, and the repository's pending pushes | changes anything |
| `index refresh` | Replays each record's read in the foreground. On a computer with no records it runs the first reads (`session candidates`, `workspace branches --intake`). | replaces a record when the authority cannot answer |
| `index rebuild` | Discards unverifiable and non-replayable records (their next read rebuilds them) and the Story summaries; refreshes the rest | touches drafts, journals, pending pushes or Story state (SDA-AC-003) |
| `index verify` | Checks each record's integrity. With `--authority` it replays each one and reports `matches` or `changed`. Exits 1 when a record cannot be verified. | — |

**Scope:** the checkout's repository-check records and the Story lists whose read ran in this
repository; `--all` covers every list on the computer. Replays are limited to the two listed reads
and refuse `--yes`, `--confirm` and `--force`.

## Lifetimes that competed with the interval

M0 listed hard-coded lifetimes beside the repository-check setting. None is advisory freshness of
shared state, so none derives from the setting. Each is a validity bound:

| Lifetime | Bound on |
|---|---|
| `GIT_FACT_TTL_MS` 15 min | local Git facts, also checked against file fingerprints |
| read worker `MAX_AGE_MS` 5 min, `IDLE_MS` 1 min | a worker process's life |
| `REFRESH_CACHE_MAX_AGE_MS` 2 h | a retained refresh checkout |
| RDS `cursorTtlMs`, `cacheTtlMs` 15 min | the RDS-v1 provider query contract (repository discovery from the hosting provider) |
| gateway `INTAKE_TTL_MS` 30 min | an in-memory intake draft |
| `STORY_INTAKE_RECEIPT_TTL_MS` 15 min | a sealed intake receipt (security) |
| Copilot guard and boundary `MAX_AGE` 30 min | a boundary record |
| `REFRESH_MS` 12 h | the check for a newer build |
| Git storage availability 30 s / 1 min | a probe memo |
| `GITHUB_ACCOUNT_TTL_MS` 10 min | an account lookup memo |

## New names (SDA-AC-023)

`test/sda-names.test.mjs` lists every SDA name with the modules that own it, M1's included, and
fails when another module uses one.

- **Command and results:** the command `index`, and result types `sflow-index-status`, `-refresh`,
  `-rebuild` and `-verify`.
- **Refusal code:** `INDEX_COMMAND_INVALID`.
- **Environment variable:** `SINGULARITY_FLOW_INDEX_REFRESH`.
- **Sidecar files:** `<record>.lease` and `<record>.refresh.json`, in directories the machine-state
  list and the private-runtime allow-list already cover.
- **Export:** `INSPECTION_READ`.
- **Identity:** `STORY_BRANCH_BINDING_MISMATCH`, `INITIATIVE_IDENTITY_UNRECORDED`,
  `INITIATIVE_IDENTITY_AMBIGUOUS`, `LOCAL_EPIC_RESERVATION_AMBIGUOUS`, `AUTO_STORY_BRANCH_UNSUPPORTED`,
  the `branch-scan-ledger-off` source and the `local-repository-id` file. That file is not named
  `repository-id`, which is already the `--repository-id` option for a workspace member.
- **Findings:** the `FND-` ID and the `code.delivery.*` finding codes.
- **Counter:** `configuration.exact-object-transfer`.
- **Freshness fields:** `freshness`, `completeness`, `refreshError` and `backgroundRefresh`; sources
  `last-known` and `shared`.

## Budgets

The refresh machinery (`src/projection-refresh.mjs`), the finding identity module and the identity
readers load lazily. The source facade's one Git-query read became lazy too: it had pulled four
query modules into the workspace startup graph. Raises are recorded with their measurements.

| Budget | Ceiling | Measured |
|---|---|---|
| `commands/start.mjs` eager source | 9,285,000 | 9,279,969 |
| Narrow-reads chunk | 4,540,000 | 4,537,465 |
| Hook-context chunk | 7,570,000 | 7,568,920 |
| Catalog chunk | 5,360,000 | 5,356,118 |

**Three module ceilings were already red after M1.** Its leaf `outcome-classes.mjs` (constants, no
import) and the facade were added without a recorded raise. M1's test selection missed these files.

| Entry | Ceiling now |
|---|---|
| Story start | 459 |
| Capability leads | 13 |
| Copilot edit guard | 62 |

The workspace startup graph is back under its old ceiling of 27, at 26.

## Failures found by the full run

The full suite, with the slow lane on, ran 12,598 tests: 12,570 passed and 10 failed. All 10 are
fixed, and each failed file was rerun green.

**From M2:**
- **New modules fell into the compatibility chunk.** The modules imported only dynamically are now
  claimed in the `phases` family (`scripts/build-cold-cli-bundle.mjs`).
- **Last-known records were not bound to their authority.** The test that changes the remote URL
  caught it, and so did VS Code Start Work's retry after the remote moved.
- **The staged VS Code CLI** cannot build a bundle from untracked new files. It passes once they
  are committed.

**Already red on `main` before this change:**
- **M1 (`fa3094b83`):**
  - GDP companion lock drift on `auto-candidate.mjs` and `publication-unit-of-work.mjs`. It now has
    its review, `docs/contracts/gdp/COMPANION-LOCK-REVIEW-2026-10-30-SDA-LEASED-PUSHES.md`.
  - VS Code and startup module ceilings, now at their observed counts.
- **`e5dd29cfa`:** every `--for-agent` read loaded the compatibility and model chunks through the
  unclaimed `agent-result-keeper.mjs`. It is now claimed in the `light` family.
- **`024a6daed`:** a VS Code label said "governed agent".

## Open after M2

- **Windows measurements.** The zero-Git budgets are measured on macOS only.
- **The consistency block** in `sflow-result` (Appendix A, question 2).
  - Freshness travels in the listing's diagnostics and snapshot fields.
  - `session candidates --json` without `--diagnostics` still prints only its items.
- **`acceptedRevision`.** A record does not yet carry the authority revision it was computed from;
  it carries `checkedAt` and its dependency stamp.
- **Typed configuration editing without a checkout** (M3).
- **`session attach` for a Story with a binding finding**, and **Auto with a non-ID branch** (above).
- **Advisory reads beyond the two lists.** `nextsteps` still starts two local Git reads, and the
  snapshot runs `git status` (above).
