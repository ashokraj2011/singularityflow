# SDA operator recovery

For the people who run Singularity Flow for a team: what each SDA recovery state means, what to run,
and what never to do. Specification: `docs/SPEC-SDA-STORAGE-INDEPENDENT-WORKFLOW-v1.md` (§8, §9, §11,
§12, §15). The Story's own branch is still lifecycle authority (ADR 0018, option A). Nothing in this
page moves authority or approves anything.

Every command here takes `--json`. The person's own recovery steps are in the `recovery` topic
(`singularity-flow help recovery`). In Copilot, `/sf-doctor` runs the `index`, `lock show`,
`lock show-file` and `backup inspect` reads on this page. A release, a backup's create or restore and
a configuration approval have no Copilot route: the person runs them in their own terminal.

## Reads that answer from last-known state

**What a person sees.** The Story list or the intake catalog answers with `freshness: stale` or
`freshness: refresh-failed`. Text output warns, for example "Using the last-known (refresh failed: …)
Story listing". Results carrying the consistency block (`sflow-result` v2 `consistency`) report the
same `freshness`, `checkedAt`, `acceptedRevision` and `refreshError`. VS Code's intake form shows the
catalog's freshness as a note, never a blocker.

**What it means.**
- `fresh`: verified now, or within the interval of cached repository checks. With manual repository
  checks a served record is `stale` with `backgroundRefresh: manual`.
- `stale`: the record is past the repository-check interval and nothing it depends on changed. It was
  served at once, and a background replay refreshes it.
- `refresh-failed`: a refresh could not reach the authority. `refreshError` holds the real code, its
  outcome class and the Git diagnosis, with the inner `cause` under the wrapper code and the `command`
  that ends it. A failed refresh is not retried for 60 seconds.
- `completeness: partial`: the last refresh answered only in part. It counts as no success and clears
  no earlier error.
- `freshness: null`: never synchronized. It is not an empty list.
- Only the Story list and the intake catalog are served last-known. Phase entry, next steps, the
  readiness preview and every governed check recompute, and their refusals stand.
- Remotes are read as Git reads its configuration: any case, the legacy `[remote "x"]` and
  `[remote.x]` forms, and `insteadOf` rewrites. A configuration with `[include]` or `[includeIf]`
  makes the authority unknown, so no last-known answer is served for it.
- A record this process cannot read (another build, a moved checkout, another environment) counts as
  missing: the next read answers from the local clone and replaces it. Such records never block the
  offline Story list. VS Code and a terminal keep separate records. After an upgrade, existing records
  are not usable once, because their file names change.
- A changed remote is an authority change. The same repository written another way (a local path as
  a `file://` URL) keeps its record. Another repository's record answers nothing, and neither does
  this clone's copy of the old remote's refs, until a read of the new repository succeeds.

**What to run.**
1. `singularity-flow index status` shows each record's freshness, last refresh and error, whether a
   refresh is running, and the repository's pending pushes. It names a record not usable here and
   why, and for a first read that failed, its cause and fix.
2. Fix the cause named in `refreshError` (network, credentials, a moved remote), then
   `singularity-flow index refresh`. A cause a retry does not end names its fix and
   `singularity-flow workspace doctor --network` instead of a refresh.
3. `singularity-flow index verify --authority` replays each record and reports `matches` or
   `changed`. It exits 1 when a record cannot be verified. `index verify --all` names the repair for
   the whole machine, `index rebuild --all`.
4. `singularity-flow index rebuild` discards unverifiable and unusable records and the Story
   summaries. Their next read rebuilds them. With `--all` it also discards a listing whose folder is
   gone. It never touches drafts, journals, pending pushes or Story state.

**Refresh leases.** While another process refreshes a record, a read that has a last-known record
serves it at once; a read with none waits for that refresh, up to the refresh's own bound (120
seconds). A refresh lease whose owner runs on another machine, or cannot be proven running, is never
taken over by age. `index status` shows it with `singularity-flow lock show-file <LEASE-FILE>` to
review it and `singularity-flow lock release-file <LEASE-FILE> --confirm <TOKEN>` to release it.
`index rebuild` removes a lease only when its owner has stopped.

**Never** delete `.git/singularity-flow` to "clear the cache". It holds journals, pending
publications and laptop-local documents beside the rebuildable records.

## Locks held by another process or laptop

**What a person sees.** A refusal naming the lock's owner, its machine and its last heartbeat. A
subject lock (named by its kind and ID, such as a Story's publication) refuses at once. A workspace registry or
selection lease is retried for up to 10 seconds first, and the Authority Store lock for a bounded
number of attempts.

**What it means.** A lease is taken over automatically only when its owner is proven dead on this
machine. Age never decides. The owner is `unknown`, and never taken over, when:
- it is on another machine;
- it is in another PID namespace (`other-pid-namespace`), for example another container sharing
  this home;
- its process is gone but its record names other hardware (`other-hardware`): another computer
  sharing this home at the same time. A dead process on this same hardware is still taken over;
- its record carries no hardware and this computer's hardware changed since its machine ID was
  recorded (`machine-hardware-changed`).

A few small local locks still expire by age and their refusals say "Retry": the bootstrap lease
(`BOOTSTRAP_LEASE_BUSY`), the choices selection receipt, the prompt audit, help metrics and the
repositories store. They are outside the reviewed-release rule.

**What to run.**
1. `singularity-flow lock show <KIND> <ID>` reads the lease. A refusal that names a lease file or a
   lock directory is read with `singularity-flow lock show-file <LEASE-FILE>`: workspace registry
   and selection leases, read index refresh leases, and Authority Store transaction and cutover locks.
   `lock show-file` and `lock release-file` run from any folder.
2. Confirm the owner is really gone: the other laptop is off or has no running command, the
   container has stopped.
3. `singularity-flow lock release <KIND> <ID> --confirm <LOCK-TOKEN>` removes exactly the generation
   reviewed in step 1, and records the release in `locks/released-leases.jsonl`. A lease file or lock
   directory is released with `lock release-file <LEASE-FILE> --confirm <TOKEN>`.

Releasing is a person's own-terminal step. Copilot turns refuse it. A refusal's recovery plan starts
with the exact release as that step, then the read that reviews it. `lock release` runs even while
another machine's repository reset barrier is up, and is the way out of that barrier
(`singularity-flow lock show factory-reset-barrier repository` reads it).

**Machine identity.** Each machine state has a random machine ID (`machine-id`, beside it the SHA-256
of the hardware it was recorded on, `machine-id.hardware`, never the hardware ID itself). Every lease
owner record also carries a short digest of its hardware (`hardwareDigest`).
- A hostname change keeps the machine.
- A home restored onto other hardware gets a new machine ID the first time it would take over a
  lease, but only when the hardware was recorded earlier. A first confirmation records the hardware
  and keeps the ID. Leases under an old ID then read as another machine's and wait for a reviewed
  release.
- When the hardware cannot be read (Windows, or a restricted container), the machine ID alone decides,
  as before.
- Resets keep both files, so this machine's older leases never read as another machine's.
- Authority Store locks are written in version 3, which builds from before it refuse rather than
  misread.

## Publications that did not finish

**What a person sees.** `status` and `nextsteps` name a pending publication and route to its sync.
`status` adds `publicationPending { commit, message, nextAction }`. A record it cannot read is
reported as `publicationPending.state: unreadable` with `singularity-flow doctor --json`, never as
nothing pending.

| Refusal or state | Means | What to run |
|---|---|---|
| `OUTCOME_UNKNOWN` (for example `transport-indeterminate`) | The push was sent and no answer came back. The remote may hold the commit. | `singularity-flow sync <WORK-ID>` once the remote is reachable. It reads the remote first. If the remote holds the commit, exactly or with commits another clone (a takeover) published on top, the commit counts as published, nothing more is pushed, and sync says it "had already reached" the remote. An earlier unknown outcome stays unknown until then, and is never overwritten by a later unreachable retry. |
| `PUBLICATION_CANCELLED_BEFORE_PUSH` | The transition was cancelled after its commit and before its push. The commit is kept locally, and the push never started. | `singularity-flow sync <WORK-ID>` publishes that exact commit. |
| `SDA_OPERATION_CANCELLED` | The transition was cancelled before its commit. Nothing was written, or the preimage was restored. | Run the step again. |
| `PUBLICATION_PENDING` | A retained commit waits for its publication. | The subject's own sync, in any turn: `singularity-flow sync <WORK-ID>`, `initiative sync <ID>`, `goal sync <ID>` or `adhoc sync <ID>`. |
| `REVISION_CONFLICT` (a lost race) | Another clone published first. Sync can never send this commit. | The refusal names `singularity-flow sync <WORK-ID> --set-aside` (or `initiative sync <ID> --set-aside`). Preview it, confirm the set-aside with `--confirm <COMMIT>` in the person's own terminal, then redo the step's action. |
| `STORY_PUBLICATION_SENT_ELSEWHERE` | The remote holds the commit, but SFlow has no record that its own push of it landed. It is reached only without a sealed lost answer, and is never claimed as SFlow's own publication. | `singularity-flow sync <WORK-ID> --set-aside`, then `--confirm <COMMIT>` in the person's own terminal. |
| A push refused for the remote's own reason (protected branch, HTTP 403) | Not a conflict. | Fix the cause at the remote, then sync. |

When the remote has moved past a retained commit, `singularity-flow recover <WORK-ID>` leads with the
set-aside preview and does not offer sync again.

No command cancels a transition yet. The two cancellation codes appear once one does, and a push
already in flight is never cancelled: it runs to its own deadline. `approve` on a phase that is
approved locally but still pending publishes that commit first, or refuses and routes to `sync`. It
never reports "already approved" while the approval is unpublished.

**Damaged records.**
- `LEDGER_CHAIN_INVALID` names the damaged ledger entry and `singularity-flow ledger verify`. Lists
  show what they could read and warn; a lookup or Epic ID allocation the readable part cannot answer
  refuses and names the verify. Restore the entry from a clone that still holds it intact. The ledger
  is never edited.
- `TRANSPORT_INTENT_INTEGRITY_INVALID` names the saved push's file, which never authorizes a push.
  To clear it, a person moves that file out of the transport outbox by hand.
  `singularity-flow push status --json` lists every damaged record with its file.

**Never** reset or force-push the Story branch to "unstick" it. The retained commit, its journal and
its pending marker are what `sync` reconciles by operation ID and digest.

## A laptop lost, replaced or handed over

**Committed and pushed work is never lost.** On the new laptop, clone the repository, then
`singularity-flow session takeover <WORK-ID>`. Takeover fetches only the Story's branch and the ledger
authority ref, verifies the configuration pin, and asks again for any laptop-local document the
current phase uses. It ends with its next step: that document's upload, binding the session, or the
Story's next steps.

**What does not come along** (`localWorkNotCarried` in the takeover result):
- configuration drafts;
- laptop-local Story documents;
- publications and pushes still waiting on the other laptop. These are published from that laptop
  with `singularity-flow sync <WORK-ID>` (`syncOnPreviousLaptop`); no backup carries them.

**Recovering them.**
- If the old laptop still works: on it, run `singularity-flow sync` for waiting publications, then
  `singularity-flow backup create --out <DIRECTORY>`. The directory must be new or empty. It is
  checked to be outside this clone, its Story checkouts and its Git directory; SFlow cannot see other
  clones of the repository on that laptop, so keep it out of them too.
- A backup larger than one backup carries (`BACKUP_TOO_LARGE`) is refused before anything is
  written, saying what is too large, so the same `--out` works once it fits.
- On the new laptop: `singularity-flow backup inspect <DIRECTORY>` previews, then
  `singularity-flow backup restore <DIRECTORY>`.
  - Restore saves each draft again under its original operation ID, checked against the approved
    configuration as it is now. A change already approved is not saved again: it is reported
    `already-approved`, or refused when it no longer applies.
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
- **`CONFIGURATION_DRAFT_OPERATION_REUSED`** (outcome class `OPERATION_ID_REUSE`): the same operation
  ID was used for a different change. The first change stands. Retry with a new operation ID if the
  second change is wanted.
- **`singularity-flow configuration drafts`** shows each draft as waiting, already approved,
  redundant or in conflict, and names the `configuration discard` route for a conflict.
- **A proposal whose upload failed** holds its drafts and names `singularity-flow sync <INTENT-ID>`.
  One merged and deleted on the Git host is recorded as approved by `configuration approve`; one
  closed gives its drafts back as waiting, and `configuration propose` proposes them again.
- **`configuration approve`** is the reviewer's own step, in their own terminal or Workflow Studio;
  Copilot turns refuse it.

## Cleanup and reset

- **Unused clones** are removed only when nothing in them is the only copy of something. Rebuildable
  records (`story-summaries.json`, `cache/`) and the release audit (`locks/released-leases.jsonl`) do
  not keep a clone. These do: configuration drafts, journals, outboxes, pending publications, an
  unfinished Story start, and laptop-local documents.
- **Story worktrees** are kept while a pending, recovery, outbox, intent or journal record exists,
  and while a Story start in the clone has not finished.
- **`factory-reset`** removes the runtime directory, where configuration drafts live. Its preview
  names the draft files it would remove, and each pending publication with its sync. Run
  `backup create` first for the drafts. It keeps laptop-local documents unless
  `--include-local-documents` is given.
- **Pending publications**: `factory-reset` and `reset-all` refuse while one waits
  (`FACTORY_RESET_PUBLICATION_PENDING`) and list each one's sync. Publish them first, or pass
  `--discard-pending-publications` on both the preview and the reset. A backup never carries them.
  `local-reset` in delete mode and the `fresh-install` reset do not check for them: run each sync
  first.

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
- `singularity-flow lock show <KIND> <ID> --json`, or `lock show-file <LEASE-FILE> --json`, for a
  lock refusal;
- the refusal's `code`, `outcomeClass` and `details`, and `status <WORK-ID> --json` for a Story.

Never send a backup directory, the draft store or `.git/singularity-flow`. They hold laptop-local
documents and drafts.
