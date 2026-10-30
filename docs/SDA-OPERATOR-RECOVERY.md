# SDA operator recovery

For the people who run Singularity Flow for a team: what each SDA recovery state means, what to run,
and what never to do. Specification: `docs/SPEC-SDA-STORAGE-INDEPENDENT-WORKFLOW-v1.md` (§8, §9, §11,
§12, §15). The Story's own branch is still lifecycle authority (ADR 0018, option A). Nothing in this
page moves authority or approves anything.

Every command here takes `--json`. The person's own recovery steps are in the `recovery` topic
(`singularity-flow help recovery`).

## Reads that answer from last-known state

**What a person sees.** The Story list or the intake catalog answers with `freshness: stale` or
`freshness: refresh-failed`. Text output warns, for example "Using the last-known (refresh failed: …)
Story listing". Results carrying the consistency block (`sflow-result` v2 `consistency`) report the
same `freshness`, `checkedAt`, `acceptedRevision` and `refreshError`.

**What it means.**
- `stale`: the record is past the repository-check interval and nothing it depends on changed. It was
  served at once, and a background replay refreshes it.
- `refresh-failed`: a refresh could not reach the authority. `refreshError` holds the real code, its
  outcome class and the Git diagnosis. A failed refresh is not retried for 60 seconds.
- `freshness: null`: never synchronized. It is not an empty list.
- Only the Story list and the intake catalog are served last-known. Phase entry, next steps, the
  readiness preview and every governed check recompute, and their refusals stand.

**What to run.**
1. `singularity-flow index status` shows each record's freshness, last refresh and error, whether a
   refresh is running, and the repository's pending pushes.
2. Fix the cause named in `refreshError` (network, credentials, a moved remote), then
   `singularity-flow index refresh`.
3. `singularity-flow index verify --authority` replays each record and reports `matches` or
   `changed`. It exits 1 when a record cannot be verified.
4. `singularity-flow index rebuild` discards unverifiable records and the Story summaries. Their next
   read rebuilds them. It never touches drafts, journals, pending pushes or Story state.

**Never** delete `.git/singularity-flow` to "clear the cache". It holds journals, pending
publications and laptop-local documents beside the rebuildable records.

## Locks held by another process or laptop

**What a person sees.** A command waits, then refuses, naming the lock's owner, its machine and its
last heartbeat.

**What it means.** A lease is taken over automatically only when its owner is proven dead on this
machine. Age never decides. The owner is `unknown`, and never taken over, when:
- it is on another machine;
- it is in another PID namespace (`other-pid-namespace`), for example another container sharing
  this home;
- this computer's hardware changed since its machine ID was recorded (`machine-hardware-changed`).

**What to run.**
1. `singularity-flow lock show <KIND> <ID>` reads the lease.
2. Confirm the owner is really gone: the other laptop is off or has no running command, the
   container has stopped.
3. `singularity-flow lock release <KIND> <ID> --confirm <LOCK-TOKEN>` removes exactly the generation
   reviewed in step 1, and records the release in `locks/released-leases.jsonl`. A refusal that
   names a lease file and its token is released with `lock release-file <LEASE-FILE> --confirm <TOKEN>`.

Releasing is a person's own-terminal step. Copilot turns refuse it.

**Machine identity.** Each machine state has a random machine ID (`machine-id`, beside it the SHA-256
of the hardware it was recorded on, `machine-id.hardware`, never the hardware ID itself).
- A hostname change keeps the machine.
- A home restored onto other hardware gets a new machine ID the first time it would take over a
  lease. Leases under the old ID then read as another machine's and wait for a reviewed release.
- When the hardware cannot be read (Windows, or a restricted container), the machine ID alone decides,
  as before.
- Resets keep both files, so this machine's older leases never read as another machine's.

## Publications that did not finish

**What a person sees.** `status` and `nextsteps` name a pending publication and route to `sync`.
`status` adds `publicationPending { commit, message, nextAction }`.

| Refusal or state | Means | What to run |
|---|---|---|
| `OUTCOME_UNKNOWN` (for example `transport-indeterminate`) | The push was sent and no answer came back. The remote may hold the commit. | `singularity-flow sync <WORK-ID>` once the remote is reachable. It reads the remote first. An earlier unknown outcome stays unknown until then, and is never overwritten by a later unreachable retry. |
| `PUBLICATION_CANCELLED_BEFORE_PUSH` | The transition was cancelled after its commit and before its push. The commit is kept locally, and the push never started. | `singularity-flow sync <WORK-ID>` publishes that exact commit. |
| `SDA_OPERATION_CANCELLED` | The transition was cancelled before its commit. Nothing was written, or the preimage was restored. | Run the step again. |
| `STORY_PUBLICATION_SENT_ELSEWHERE` | The remote holds a commit SFlow did not push (a hand push). | `singularity-flow sync <WORK-ID> --set-aside`, then `--confirm <COMMIT>` in the person's own terminal. |
| A push refused for the remote's own reason (protected branch, HTTP 403) | Not a conflict. | Fix the cause at the remote, then `sync`. |

No command cancels a transition yet. The two cancellation codes appear once one does, and a push
already in flight is never cancelled: it runs to its own deadline. `approve` on a phase that is
approved locally but still pending publishes that commit first, or refuses and routes to `sync`. It
never reports "already approved" while the approval is unpublished.

**Never** reset or force-push the Story branch to "unstick" it. The retained commit, its journal and
its pending marker are what `sync` reconciles by operation ID and digest.

## A laptop lost, replaced or handed over

**Committed and pushed work is never lost.** On the new laptop, clone the repository, then
`singularity-flow session takeover <WORK-ID>`. Takeover fetches only the Story's branch and the ledger
authority ref, verifies the configuration pin, and asks again for any laptop-local document the
current phase uses.

**What does not come along** (`localWorkNotCarried` in the takeover result):
- configuration drafts;
- laptop-local Story documents;
- publications and pushes still waiting on the other laptop.

**Recovering them.**
- If the old laptop still works: on it, run `singularity-flow sync` for waiting publications, then
  `singularity-flow backup create --out <DIRECTORY>`. The directory must be new or empty and outside
  every checkout of the repository.
- On the new laptop: `singularity-flow backup inspect <DIRECTORY>` previews, then
  `singularity-flow backup restore <DIRECTORY>`.
  - Restore saves each draft again under its original operation ID, checked against the approved
    configuration as it is now. A change already approved is refused, not saved again.
  - It restores a document only where the Story holds that exact record. A replaced document is
    `superseded`, and a Story not on this laptop is `story-not-here`, with the takeover command.
  - Restoring twice changes nothing. Nothing is proposed, approved, committed or pushed.
- A backup is refused whole when another repository made it (`BACKUP_REPOSITORY_MISMATCH`), an object
  is damaged (`BACKUP_INTEGRITY_FAILED`), a draft does not match its digest (`BACKUP_INVALID`), or a
  newer build wrote it (`SCHEMA_VERSION_FUTURE`).

**If the old laptop is gone**, its drafts and laptop-local documents are gone unless they were
backed up or published. Ask the person to upload the documents again. Takeover lists the ones the
current phase needs.

## Configuration drafts

- **`SCHEMA_VERSION_FUTURE`** on a draft, proposal or authority record: a newer build wrote it.
  Upgrade this build. Never move the file aside: it may be the only copy.
- **`drafts.json.migrated-v2`, `drafts.json.migrated-v2-1`, …** beside the draft store: the store
  moved to one file per draft (v2), and an older build wrote `drafts.json` again afterwards. Each was
  imported once, and the drafts are unchanged. A `-1` or later file means an older build is still in
  use on this clone (see the rollout below).
- **`OPERATION_ID_REUSE`**: the same operation ID was used for a different change. The first change
  stands. Retry with a new operation ID if the second change is wanted.

## Cleanup and reset

- **Unused clones** are removed only when nothing in them is the only copy of something. Rebuildable
  records (`story-summaries.json`, `cache/`) do not keep a clone. These do: configuration drafts,
  journals, outboxes, pending publications, an unfinished Story start, and laptop-local documents.
- **Story worktrees** are kept while a pending, recovery, outbox, intent or journal record exists,
  and while a Story start in the clone has not finished.
- **`factory-reset`** removes the runtime directory, where configuration drafts live. Its preview
  names the draft files it would remove. Run `backup create` first. It keeps laptop-local documents
  unless `--include-local-documents` is given.

## Mixed builds and the rollout

SDA adds no writer fence between builds (ADR 0018, option A). Builds from before SDA M3 keep working,
with one gap:
- an older build reads and writes `drafts.json` and does not see drafts a newer build saved;
- the newer build imports what the older one wrote, once;
- a change the older build still holds can come back as a waiting draft after the newer build has
  proposed it.

**Staged rollout.**
1. Release the build that carries SDA M3 to M6. Publish it to the release location
   (`docs/RELEASE-ARTIFACT-HANDOFF.md`) before requiring it.
2. Raise `singularity/product.yml` `minimumBuild` to that release, through the configuration review.
   Each teammate's build installs it at their first mutation in the repository after its daily check.
   A requirement is never a refusal: when the install cannot happen, the command says so and continues
   on the running build.
3. Watch for older builds: a new `drafts.json.migrated-v2-N` file means an older build still wrote
   drafts on that clone after the newer one migrated them.
4. A rollback is a newer release with the fix. A machine never installs a build older than the one it
   runs.

## What to collect when asking for help

Without private content:
- `singularity-flow doctor --json`;
- `singularity-flow index status --json`;
- `singularity-flow lock show <KIND> <ID> --json` for a lock refusal;
- the refusal's `code`, `outcomeClass` and `details`, and `status <WORK-ID> --json` for a Story.

Never send a backup directory, the draft store or `.git/singularity-flow`. They hold laptop-local
documents and drafts.
