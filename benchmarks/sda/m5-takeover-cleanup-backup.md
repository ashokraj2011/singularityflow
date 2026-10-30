# SDA M5: takeover, cleanup, backup and migration tooling

Specification: `docs/SPEC-SDA-STORAGE-INDEPENDENT-WORKFLOW-v1.md` (§11, §12, §15, §19 items 12 and 14, §20 M5).
Authority: ADR 0018 option A. No authority moves and nothing is migrated between authorities.
Engine: `main@97ad71b41` plus this change.

M5's exit condition: multi-laptop, retention, legacy import and writer-fencing cases pass.

## What landed

| Deliverable | Where | Checked by |
|---|---|---|
| Takeover discloses the work left on the other laptop | `src/commands/session-takeover.mjs` (`localWorkNotCarried`) | `test/sda-m5-multi-laptop.test.mjs` |
| Backup and restore of the work that exists only on one laptop | `src/local-backup.mjs`, `backup create|inspect|restore` (`src/commands/backup.mjs`) | `test/sda-m5-multi-laptop.test.mjs`, `test/sda-m5-backup.test.mjs` |
| Cleanup of rebuildable projections; recovery and authored state kept | `src/workspace-checkout-inventory.mjs`, `src/workspace-retention.mjs` | `test/sda-m5-retention.test.mjs` |
| Factory reset names the drafts it removes | `src/factory-reset.mjs` | `test/factory-reset.test.mjs` |
| Writer fences of the local stores, and legacy import | `src/configuration-drafts.mjs`, `src/local-backup.mjs`, `src/schema-migrations.mjs` | `test/sda-m5-backup.test.mjs` |

## Takeover on another laptop (SDA-AC-012, §19 item 12)

`session takeover` already fetched only the Story's branch, verified its configuration pin and asked again
for the laptop-local documents the current phase uses. M5 adds what §11 required:

- **The disclosure.** The result carries `localWorkNotCarried`: configuration drafts, laptop-local
  documents, and publications or pushes still waiting on the laptop that had the Story did not come
  along. They are recoverable only if they were published, or backed up there and restored here.
- **Nothing of the other laptop is reused.** Before M5 every "two laptops" test ran both clones in one
  machine state. `test/sda-m5-multi-laptop.test.mjs` gives each laptop its own home, machine state and
  machine ID, sharing only the remote. After laptop B takes the Story over, no file of B's machine state
  or of B's runtime directory, and not the takeover result itself, holds:
  - a path of laptop A;
  - laptop A's machine ID;
  - a lock token of laptop A.

Committed records can still hold machine-specific text. A check's output (`phase.checks[].stdout`, up to
2,000 characters) may name a laptop path. Takeover reads it as evidence and never as a path to use.

## Backup and restore (§19 item 14)

`singularity-flow backup create --out <DIRECTORY>`, `backup inspect <DIRECTORY>`, `backup restore <DIRECTORY>`.

**What a backup carries:** the two kinds of authored data that exist only on one laptop.
- Configuration drafts, exactly as stored, each with its operation ID and payload digest.
- Laptop-local Story documents, as content-addressed objects with their Work ID, key, SHA-256 and size.

**What it never carries:** locks, sessions, caches and indexes, journals, temporary files and absolute
paths. Publications and pushes still waiting on that laptop are recovered there with `sync`, so the
backup names them (`notCarried`) and does not carry them.

**Where it goes:** a new or empty directory outside every checkout of the repository: no worktree and
no Git directory (`BACKUP_INSIDE_CHECKOUT`). The documents must never be committed. The manifest is
written last, so an interrupted backup has none and is refused as incomplete.

**What restore does.** It changes no shared state.
- **A draft** is saved again through the ordinary draft save, under its original operation ID. It is
  checked against the approved configuration as it is now:
  - the same operation already saved is left as it is;
  - a different change under that operation ID is refused (`OPERATION_ID_REUSE`);
  - a change the approved configuration has since taken is refused, and is not saved again.
- **A document's bytes** are restored only where the Story holds that exact record (`documents
  restore`, which checks the SHA-256 again). The result names each one:
  - `superseded`: the Story replaced or detached the document;
  - `story-not-here`: the Story is not on this laptop, with the takeover command.
- **Restoring twice** changes nothing. Nothing is proposed, approved, committed or pushed.

**What a restore refuses whole, restoring nothing:**
- a backup another repository made (`BACKUP_REPOSITORY_MISMATCH`, matched by a digest of the
  repository's comparison key);
- a damaged object (`BACKUP_INTEGRITY_FAILED`);
- a draft whose change no longer matches its digest (`BACKUP_INVALID`);
- a manifest a newer build wrote (`SCHEMA_VERSION_FUTURE`).

**The multi-laptop case.**
1. Laptop A starts a Story with a laptop-local document, saves a draft and backs both up.
2. Laptop B takes the Story over and restores the backup:
   - the draft comes back under its operation ID;
   - the document comes back under its ID, and takeover no longer asks for it;
   - a second restore changes nothing;
   - a document the Story no longer holds is reported `superseded`.
3. **Backup restored after the authority advanced.** The draft is approved on A. A third laptop
   restores the same backup:
   - the draft is checked against the configuration as it is now and refused, so an approved change
     never comes back as a waiting draft;
   - the document is `story-not-here`, with the takeover command.

## Cleanup (SDA-AC-016)

- **Unused clones.** Unused-clone cleanup kept a clone with anything in its runtime directory besides
  its checkout record and locks. Since M2 every listing writes `story-summaries.json`, and reads fill
  `cache/`, so a clone that ever answered a listing was kept forever.
  - Both are rebuilt by the next read, and now go with the clone.
  - Everything else still keeps it: configuration drafts (M3), journals, outboxes, pending publications,
    an unfinished Story start, and laptop-local documents. Each is a case of
    `test/sda-m5-retention.test.mjs`.
- **Story worktrees.** Worktree cleanup checked the shared runtime directory for pending, recovery,
  outbox, intent and journal records. It now also waits while a Story start in the clone has not
  finished (`story-start/`, whose journal is removed when the start completes).
- **Factory reset** removes the runtime directory, where drafts live. Its preview now names the saved
  draft files it would remove, and the `backup create` command that saves them first. It kept local
  documents already, and still does.
- **Locations.** M5 adds no machine location: a backup lives where the person chooses.
  `SDA_MACHINE_LOCATIONS` still lists only M3's machine ID.
- **Evidence holds.** The spec lists "evidence under retention hold" among what cleanup protects. No
  hold record exists in code. Signed evidence lives on published branches, which no cleanup deletes.

## Legacy import and writer fences (§15, ADR 0018 option A)

Option A migrates no authority, so SDA-AC-019 does not apply. `minimumBuild` remains an update the next
mutation installs, continuing on the running build when the install fails. M5's writer fences are those
of the local namespaces SDA introduced. All are in `test/sda-m5-backup.test.mjs`.

- **The draft store against a newer build.** A draft, proposal or authority record with a schema above
  `@2` is refused with `SCHEMA_VERSION_FUTURE` and the upgrade. Nothing is written beside it. Before M5
  it was called damaged, with the advice to move it aside.
- **The draft store against an older build.** A window's bundled CLI that predates M3 writes `drafts.json`
  again after the migration. The next read imports it once: drafts already migrated are not duplicated,
  and its file is kept as `drafts.json.migrated-v2-1`.
- **Backups.** A manifest a newer build wrote is refused whole: nothing is restored. The manifest is a
  registered record family (`local-backup-manifest` v1).
- **Legacy layouts.** A backup migrates them where they live first: the single `drafts.json` and the
  document store an earlier build kept inside the runtime directory. They are carried with their exact
  operation IDs and SHA-256 digests.

## Fixed on the way

- **The SDA inventory had two unclassified modules.** `apm-marketplace.mjs` and `apm-policy.mjs`, added
  after M4, write and commit files into the organisation's APM catalog and policy repositories.
  `test/sda-inventory.test.mjs` was red on `main` because of them. They now join `apm-install.mjs` in the
  `installation` class. `benchmarks/sda/inventory.json` is regenerated, with `local-backup.mjs` as
  `local-authored`.
- **`apm attach` routed outside its family.** APM A7 (`38b61ada9`) moved `apm` to `/sf-apm` and routed
  `apm attach` to `/sf-import`, which was no longer in the family. `test/command-skills.test.mjs` was red
  on `main`. The family is now `/sf-apm` and `/sf-import`.

## Verification

- **Full suite, slow lane on**, on `main@97ad71b41` plus this change, on a machine running no other tests:
  - 16 shards, 1,343 files, 12,729 tests;
  - 12,713 passed, 16 skipped, none failed, in 86 minutes.
- **The first run** shared the machine with another session's suites, at a load average near 85. All 16
  shards ran past their deadlines, and three tests failed on timing. Each of the three passed on its own
  and in the quiet rerun.
- **Rebased onto `main@38b61ada9`** (APM A7), which changed two of these files: `src/command-skills.mjs` and
  the generated `src/docs-manifest.json`. After the rebase, `node scripts/check.mjs` and the command, help,
  documentation, inventory and SDA tests were run again.

## Names (SDA-AC-023)

`test/sda-names.test.mjs` lists them with their owning modules. M5 adds no configuration key or machine
location.
- **Command:** `backup create|inspect|restore`, with its own module and no alias. Create and restore
  have no skill route.
- **Results:** `sflow-backup-create`, `sflow-backup-inspect`, `sflow-backup-restore`.
- **Refusal codes:**
  - `BACKUP_COMMAND_INVALID`, `BACKUP_DESTINATION_INVALID`, `BACKUP_INSIDE_CHECKOUT`, `BACKUP_INVALID`;
  - `BACKUP_INTEGRITY_FAILED`, `BACKUP_REPOSITORY_MISMATCH`, `BACKUP_TOO_LARGE`, `BACKUP_DRAFTS_UNAPPROVED`.
- **Record family:** `local-backup-manifest`.
- **Fields:** `localWorkNotCarried` (takeover), `savedConfigurationDrafts` (factory reset), `story-not-here`.
- **An existing code with its one meaning:** `SCHEMA_VERSION_FUTURE`, now also thrown by the draft store.

The migration registry is a GDP-locked companion: see
`docs/contracts/gdp/COMPANION-LOCK-REVIEW-2026-10-30-SDA-LOCAL-BACKUP.md`.
