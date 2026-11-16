# OSA activation and reversal

**Specification:** [SPEC-OSA v1.1](../SPEC-OSA-ONE-STEP-AUTHOR-v1.1.md) section 14 and implementation plan section 7, "Activation and reversal".
**Rule:** a reversal must not erase accepted openings, and must not let a stale writer in.
**Tested by:** `test/osa-stage5.test.mjs` (section 5 below). What is not tested is said in section 6.

## 1 What activates

OSA has no runtime switch for its decision owner. Stages 1 to 5 replaced the older deciders in the code, so the build is what activates it: a machine runs OSA when its CLI, its Copilot plugin and its VS Code extension come from an OSA build.

One owner switch stays, off by default: `SINGULARITY_FLOW_DOCUMENT_VERSION_OPENING=shared` opens version 1 of a document step through the opening operation ([stage4.md](stage4.md) section 7). Leave it off unless the owner decides otherwise.

**What an OSA build writes that an older build did not** (from Stage 2 on):

| Record | Where | Shared |
|---|---|---|
| The opening record | `context/version-openings/<step>-v<N>.json`, committed on the Story branch | yes |
| The step's `versionOpening` pointer, with its writer fence | the Story record (`workflow.json`) | yes |
| History events `version-opened` and `version-writer-taken-over` | the Story record, lifecycle vocabulary 10 | yes |
| Consent receipts, proposals and opening checkpoints | sealed files under the clone's Git directory | no, per clone |
| A task's waiting outcome | the task record's `blockedCode`; an older reader sees an ordinary blocked task | no, per clone |

**Stage 5 adds none of these, and no new schema version.** A Stage 5 build writes the same Story record (`story-workflow` version 13) and the same lifecycle events as Stages 2 to 4. The edit guard's turn record (machine-local) gains only extra entries in its existing `stamps` list, which an older guard checks like any other stamp.

## 2 Staged activation

1. **Land.** OSA lands on main after its Node 22 heavy run. The weekly Node 26 run that follows qualifies the stage (spec section 14).
2. **One machine first.** Install the build on one machine whose Stories are worked from that machine only: the owner's daily paid Story run is the live qualification row. Install the CLI, the plugin and the VS Code extension of the same build together.
3. **Then a team at a time, not a person at a time.** Every machine that writes the same Story should move together. In a mixed team:

   | Writer | Reader | What happens |
   |---|---|---|
   | OSA build | pre-OSA build | It reads the Story and can publish the version an OSA build opened: the intent keeps its shape and the high-watermark is unchanged. It refuses to sync a retained `version-opened` commit, because that event is not in its vocabulary: update SFlow, then sync. |
   | pre-OSA build | OSA build | Its local opening of a next version is a legacy opening: it grants nothing until `phase rollover` promotes it on the person's yes. Its version 1 still authors. |
   | pre-OSA build | the writer fence | **It does not read the fence.** It can write a version that another checkout took over. |

   So, until every machine that writes a Story runs an OSA build (Stage 2 or later), take no writer over on that Story.
4. **Watch.** The daily paid run is the live check: `/sf-code` and `/sf-next` reach a person's boundary, the reviewer starts or its fresh-chat route is named, and nothing routes healthy work to `/sf-recover`.

## 3 Reversal to an earlier OSA build

To go back to Stage 4 (`d5522e815`) or another Stage 2 to 4 build, install that build. Nothing else is needed:
- the records are the same (section 1), so every opening, receipt, fence and history event is read as before;
- the guard's turn records are machine-local and rebuilt at the next prompt.

What goes back with the code: the edit guard stops reading the repair stage, so a spent repair budget stops every view but no longer the guard (the Stage 3 behaviour); `return` prints a fixed `prepare` again; the refusals of section 4 of [stage5.md](stage5.md) name `recover` again.

## 4 Reversal to a pre-OSA build

To go back to main before OSA (`ea398577f`) or to `stable-2026-11-16` (`4ac5c5c40`), which predates Stage 2:

**Before installing it, on each machine and for each Story it writes:**
1. **Send every retained commit with the OSA build:** `singularity-flow sync`. The older build refuses to sync a `version-opened` commit, so this has to happen first.
2. **Settle every taken-over version.** Run `singularity-flow nextsteps <WORK-ID> --json`. If it names `singularity-flow session takeover <WORK-ID> --json`, this checkout's writer was fenced: its work is published or set aside by the person, and that checkout does not write that version again. The older build cannot enforce this.
3. **Publish or set aside every open next version** that the person has not yet written to, so that nothing waits on a consent receipt the older build cannot read.

**What stays, with no action:**
- **Accepted openings are not erased.** They are commits on the Story branch. The older build only appends its own commits, and never rewrites or deletes the opening record, the pointer or the history events. When the OSA build is installed again, they read as history.
- Published versions, reviews, approvals and evidence hashes are unchanged by either build (spec section 14).

**What is lost while reversed** (the older build's own behaviour):
- the writer fence: two checkouts can write one version;
- the person's yes before a next version: its `phase rollover --confirm` opens one without a consent receipt (D3);
- the kernel's one decision on every surface: its older deciders return, with the contradictions the decision inventory lists.

**Activating again** after such a reversal: an OSA build reads what the older build wrote. A version the older build published is history. A next version it opened locally is a legacy opening, which grants nothing until the person's yes promotes it. No action is needed beyond installing the build.

## 5 What is tested

| Claim | Test (Node 22, local, in process) |
|---|---|
| Stage 5 writes no new record: the kernel admits Story records 1 to 13, the Story record written is version 13, the lifecycle events include `version-opened` and `version-writer-taken-over` | `osa-stage5` "Stage 5 writes no new record …" |
| Read-only surfaces (every view, the task stage reads, the entry's permission, a guard turn and its write check) change no byte of the Story record, its opening record, its consent and checkpoint files, its Git refs or a local attachment | `osa-stage5` "read-only surfaces leave a Story with an accepted opening unchanged …" |
| A fenced writer stays out when the machine's turn records are lost, as a reinstall or a reversal of the host side loses them; the accepted opening is unchanged | `osa-stage5` "a fenced writer stays out when the machine's turn records are lost …" |
| A task outcome stops applying after any lifecycle event: an older record is never read as current | `osa-stage5` "a stale outcome is never applied …" |
| An older reader and a new writer (Stage 1 reader against Stage 2 records) | `osa-stage2-compat`, run at Stage 2 against `90e7095cc` ([stage2.md](stage2.md) section 8). Not run again at Stage 5: Stage 5 changes no record |

## 6 What is not tested

- **A real reversal to a pre-OSA build** (`ea398577f` or `stable-2026-11-16`). The claims in section 4 come from reading those builds' code and from Stage 2's compatibility run against a Stage 1 build, not from running the pre-OSA CLI against a Story an OSA build wrote.
- **Mixed teams on live hosts.** The table in section 2 is from local tests, not from two people on two laptops.
- **Windows.** Qualification is Mac-only (spec section 14).
