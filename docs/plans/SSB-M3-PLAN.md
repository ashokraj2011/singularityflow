# SSB M3 plan: publication and recovery of a Story's state ref

**Spec:** [SSB-v1](../SPEC-SSB-STORY-STATE-BRANCH-v1.md), REQ-004, REQ-005, REQ-008 and milestone M3; WMR REQ-022.

**Baseline:** `6c7b0ecbf` (2026-11-27), with M2 and the fixes of `4c542e39e` on it.

**Gate:** kept. `story.storage: state-ref` acts only under `SINGULARITY_FLOW_STORY_STATE_REF_PREVIEW=1`, which only
tests set. Today's layout (`story-branch`) behaves as before, and its tests run unchanged. The setting opens in M5.

**Size:** 4 days, in four stages, each committed on `ssb-m3` with its tests green.

---

## 1. What M3 does

- **Publication (REQ-005).** A state-ref Story's transition commits its records on the state ref, then publishes, in one
  `git push --atomic`, under an exact `--force-with-lease` per ref:
  - the state ref `refs/singularity/state/<ID>` (or `refs/heads/sflow/state/<ID>` under `ledger.pinTransport: branches`);
  - the Story branch, only when its tip moved (probe 1: an unchanged ref reports `=` and is left out);
  - the ledger branch and the entry's pin, when the ledger is on and shares the remote.
- **Recovery.** A push refused, cancelled or lost leaves one sealed pending record. The next transition finishes it before
  it starts (as `repairRetainedPublication` does for today's layout), and so does `sync`. A remote that moved past it is
  set aside with `sync <ID> --set-aside`.
- **The lifecycle contract.** The state ref is the lifecycle authority of a state-ref Story. Its unit of work sits behind
  `lifecycleAuthority(root)` (`src/sda/story-branch-authority.mjs`), beside the branch's, and passes the same conformance
  suite. `test/sda-lifecycle-boundary.test.mjs`'s `OTHER_PUBLICATIONS` becomes empty.
- **Binding (REQ-004).** Every state commit names the code commit it is about, in its trailer. An approval records that
  commit too; a code commit after it makes the approval stale by today's rule for a change after publication.
- **Approvals, decisions and clarifications** on a state-ref Story: the `prefix` sites they reach move to the resolver;
  the five readers with no Story in scope get the location.
- **Retention (REQ-008).** The ledger's pin keeps the code commit an entry names alive; the state ref keeps the state
  commits. Removing a Story checkout, and the workspace drop, refuse while the state ref holds commits not published.
- **Lessons (WMR REQ-022).** A state-ref Story's lessons are committed on its state ref and recalled from it.

M3 does not: move documents to `docs/stories/` (M4), refuse an agent's edit to `.sflow-state/` (M4), list Stories from
`refs/singularity/state/*` in discovery or VS Code (M5), open the setting (M5), or walk both layouts in the fuzzer (M6).

## 2. The atomic push

### 2.1 What moves

| Ref | New value | Lease (`--force-with-lease=<ref>:<expected>`) | When it is in the push |
|---|---|---|---|
| `refs/singularity/state/<ID>` | the new state commit | the state revision the transition is bound to: the remote's last published state, from the tracking ref `refs/singularity/remotes/<remote>/state/<ID>`; empty (create-only) for a new Story | always |
| `refs/heads/<Story branch>` | the checkout's `HEAD` | the remote's observed tip; empty when the remote has none | only when the remote's tip is not `HEAD` |
| `refs/heads/<ledger branch>` | the entry commit, built by `prepareLedgerAppend` | the ledger tip the entry extends | ledger on, same remote, its tracking tip is the remote's |
| the entry's pin | the code commit | empty (create-only) | with the ledger entry, when the remote has no such pin |

One `git ls-remote` before the state write observes all four refs. It decides what goes in the push and refuses early:
- the remote's state ref is not the bound revision, and not an ancestor of this clone's state: another clone published
  first (`REVISION_CONFLICT`). The way out is `resume <ID> --fetch`, which fast-forwards, or `sync <ID> --set-aside` when
  the two diverged;
- the remote's Story branch has commits this checkout lacks: `refresh-branch`, as today.

A remote whose state is an ancestor of this clone's (state commits made here and not yet published) is leased at its
observed value, as today's branch path leases the observed tip when local commits are ahead.

### 2.2 The ledger entry

- `publishedCommit` is the **code commit**, so the pin keeps it alive after a merged branch is deleted (REQ-008), and
  the ledger's own verification of pins is unchanged.
- The intent's payload names the state ref and the state commit's parent (`payload.storyState`); the state commit's
  trailer names the event (`Story-Event: <eventId>`) and the code commit (`Story-Code-Commit: <sha>`). So the entry and
  the state commit name each other, and the entry's schema does not change.
- The intent is persisted in the state checkout (`context/ledger-intents/<eventId>.json`) and committed with the
  records, so recovery reads it from the state commit.
- When the entry cannot be in the atomic push (no tracked ledger tip, or the remote's moved), the branch and the state
  ref are pushed atomically and the entry follows by `appendLedgerIntent`, exactly as today's unit of work does after
  its branch push. A failure there is the ledger outbox and its warning, as today.

### 2.3 Outcomes

| Push result | What it means | What is kept |
|---|---|---|
| exit 0, every named ref `*`, ` `, `+` or `=` | landed | tracking refs moved; the pending record cleared |
| `! [rejected] (stale info)` on any ref, `(atomic push failed)` on the rest | nothing moved; another writer moved a lease | pending record, `REVISION_CONFLICT`, route `sync <ID> --set-aside` |
| a hook refused it | nothing moved | pending record, the hook's text, route `sync <ID>` after the hook is fixed |
| a lost response, a signal, a timeout | unknown | pending record with `transport-indeterminate`, `OUTCOME_UNKNOWN`, route `sync <ID>` |
| `does not support --atomic` | the host cannot | the sequential path (§2.5) |

A push once begun is never abandoned by a cancellation (SDA §7.3); the signal is honoured before the state commit
(rolled back, `cancelled`) and after it, before the push (retained, `retained-locally`).

### 2.4 Recovery after each failure point

| The process stopped | Left behind | The next command |
|---|---|---|
| before the state write | nothing | — |
| during the state write | uncommitted files in `.sflow-state/` | the preimage restores them on a thrown error; after a crash the next transition refuses with the one `git stash` that sets them aside (M2's route) |
| after the commit object, before the ref moved | a pending record naming a commit the ref does not hold, and the files | `sync` sees the ref at the record's parent, drops the record; the files are set aside as above |
| after the ref moved, before the push | the pending record (`not-attempted`) | the next transition (`repairRetainedPublication`) or `sync` pushes it under fresh leases |
| during the push | the pending record (`transport-indeterminate`) | `sync` fetches the state ref: the remote holds the commit (landed: tracking refs and the ledger entry are finished, idempotently) or its lease (pushed again) or neither (`--set-aside`) |
| after the push, before the record was cleared | the pending record | `sync` finds the remote at the commit and finishes as above |

The pending record is the one `writePendingPublication` seals today, with `layout: 'state-ref'`, the state ref, the
state commit and its parent, the state lease, the code branch and commit, and the ledger intent's path. So status, the
transition gate and `sync` see it with no new store.

### 2.5 A host without atomic pushes

Today's sequential order: the Story branch, then the state ref, then the ledger. Each push is leased as above. A
failure after the branch landed keeps the pending record, and recovery pushes only what the remote lacks.

### 2.6 A second clone

`resume <ID> --fetch` (M2) fetches the branch, then the state ref into its tracking ref, and fast-forwards the local
state ref when nothing local is lost. Its tracking ref is the lease of its first transition, so its approval lands on
top of the first clone's records. The first clone's next transition sees the remote ahead and is routed to
`resume <ID> --fetch` before it writes anything.

## 3. Stages

### (a) Atomic publication, recovery and the lifecycle contract (1.5 days)

- `src/story-state-publication.mjs` (new, lazy, in the `publication` cold-bundle family): `StoryStateUnitOfWork`
  (`execute(transition, { signal })`), the observation of a state ref, the atomic and sequential pushes, `sync`'s
  recovery and the set-aside.
- `src/story-state-ref.mjs`: the state commit split into its object, the leased ref move and the checkout move; the
  tracking ref after a push; `storyStateAuthority` goes (the unit of work replaces it).
- `src/sda/story-branch-authority.mjs`: `publish` runs the state ref's unit of work for a transition with
  `storage.layout: 'state-ref'`; `observe({ ref, remote })` observes a state ref; `pending` is unchanged (same store).
- `src/story-publication-service.mjs`: one call, `lifecycleAuthority(root).publish(transition)`, for both layouts; the
  state-ref transition carries `storage`, its ledger intent folder (the state checkout) and its state lease.
- `src/state.mjs` `syncPublication` and `src/commands/sync.mjs --set-aside`: the state-ref arm, loaded only for a
  pending record with `layout: 'state-ref'`.
- `src/story-start.mjs`: the start result's `storage.published`.
- Tests, `test/story-state-publication.test.mjs` (new), real clones and a bare remote:
  - the lifecycle conformance suite on the state ref (absent then present; a moved lease never lands; a lost response is
    unknown, retained and holds the next; an unbound transition is refused; cancellation before the commit, after it,
    and during the push);
  - a Story started with publication on lands its branch, state ref, ledger and pin in one push;
  - an approval moves only the state ref, the ledger and a pin; the branch is not in the push (A2);
  - an atomic push refused for one ref moves none (a teammate moved the state ref; a host hook refuses the state ref);
  - a crash after the local commit and before the push is finished by the next transition, and by `sync`;
  - a lost response is settled by `sync`;
  - a second clone resumes with `--fetch` and approves; the first clone's next transition is routed to fetch;
  - the set-aside keeps the local commits on `refs/singularity/state-aside/<ID>/<time>`;
  - `ledger.pinTransport: branches`;
  - today's layout: `test/sda-lifecycle-conformance.test.mjs`, `test/story-start-publication.test.mjs` and
    `test/publication-unhappy-paths.test.mjs` unchanged.
- `test/sda-lifecycle-boundary.test.mjs`: `OTHER_PUBLICATIONS` empty; the state ref's unit of work is constructed only
  in the adapter.

### (b) Approvals, decisions and clarifications on a state-ref Story (1.5 days)

The 125 `prefix` uses in 58 files (`storyLocation(…).prefix` and a location's `.prefix`, measured on the baseline):
`state.mjs` 52, `commands/upstream-issue.mjs` 4, `commands/tests.mjs` 4, `story-lessons-notice.mjs` 3,
`local-test-runs.mjs` 3, `collaboration.mjs` 3, `task-amendment.mjs` 2, `story-publication-service.mjs` 2,
`comprehension/xpl2/clause-sources.mjs` 2, `commands/input-restore.mjs` 2, and one each in `workflow-walk/walk.mjs`,
`workflow-snapshots.mjs`, `verification/repository-tests.mjs`, `verification/flaky-runs.mjs`,
`verification/base-run.mjs`, `trp-delivery-selection.mjs`, `test-recovery-runtime.mjs`, `test-command-pins.mjs`,
`test-command-epoch.mjs`, `story-version-opening.mjs`, `story-test-command-amendment.mjs`, `story-state-write.mjs`,
`story-approver-refresh.mjs`, `source-review-lifecycle.mjs`, `skp-phase-evidence.mjs`, `revision/current-context.mjs`,
`refactor-behaviour.mjs`, `recovery-plan.mjs`, `projectors.mjs`, `planning.mjs`, `phase-retention.mjs`,
`phase-publication-unchanged.mjs`, `phase-publication-readiness.mjs`, `phase-prepublish.mjs`,
`phase-mutation-contract.mjs`, `phase-execution-evidence.mjs`, `phase-evidence-amendment.mjs`, `node-pin.mjs`,
`lifecycle-worktree.mjs`, `knowledge.mjs`, `governance.mjs`, `git-exact-story-revision.mjs`, `evidence-packet.mjs`,
`editor.mjs`, `draft-evidence-hold.mjs`, `document-publication.mjs`, `delivery-evidence.mjs`, `decision-list-reads.mjs`,
`commands/spec-dependencies.mjs`, `commands/spec-author.mjs`, `commands/nextsteps.mjs`,
`commands/decision-test-risk.mjs`, `commands/decision-test-narrowing.mjs`, `code-submission-evidence.mjs`,
`choices.mjs`, `approval-focus.mjs`, `application-review-host.mjs`, `amendment-plan-corrections.mjs`.

Converted by M2's one rule (spec §12, design change 3): `prefix` joined with a record becomes `record()`, a disk path
`file()`, a containment test `owns()`/`inside()`, a staging scope `commitScope`, and `root` becomes `recordsRoot` where
it is joined with a record or reads its history. Each conversion gives the same string for `story-branch`. The order is
driven by a test that walks a state-ref Story from start through publish, submit, approve, a decision and a
clarification, and fails on the first `STORY_STATE_REF_PATH_UNAVAILABLE`; sites no walk reaches keep the refusing
`prefix`, which stays loud.

The five readers with no Story in scope (M1 plan §9 B12) take the location from their caller:
`evidence/graph.mjs` `loadAttempt`, `criterion-test-failures.mjs`, `approval-waiver.mjs` `pendingWaiverSubmission`,
`verification/changed-line-coverage.mjs` `boundStepAttempts`, `generation-boundary.mjs` `consumeGenerationIntent`.

REQ-004's approval half: an approval of a state-ref Story records the code commit and the code tree's digest
(`codeTreeExclusion` becomes `.sflow-state/`'s absence: the code checkout's tree is already clean of records).

Tests: the walk above (`test/story-state-ref-approvals.test.mjs`), with A2 checked at each approval (the branch's tip
and the remote's are unchanged); a code commit after an approval makes it stale (A4); today's layout's proof set.

### (c) Retention and the workspace drop (0.5 day)

- `removeStateCheckout` (M2) refuses uncommitted records; it now also refuses while the local state ref holds commits
  the remote has not got (the tracking ref is not the local ref, or a pending record names them), with `sync <ID>` as the
  way out. The callers are M2's: `story-worktree.mjs`, `workspace-retention.mjs`, launch cleanup and rollback.
- The workspace drop (`commands/workspace.mjs` drop, `workspace-relink.mjs`) asks the same before it removes a
  checkout.
- Tests: in `test/story-state-ref.test.mjs`'s style, removal and the drop refused with unpublished state commits and
  allowed after `sync`.

### (d) WMR REQ-022: lessons on the state ref (0.5 day)

- `story-lessons-notice.mjs` (its three `prefix` uses) and `story-lessons.mjs`: a state-ref Story's lessons are written
  in its state checkout and committed on the state ref with the approval, not in `singularity/knowledge/records` on the
  branch (`lessonPaths` in `commitAndPublish`). Recall reads them from the state checkout of the Story in scope and,
  for other Stories in the clone, from their state refs (`sourceFileAt`).
- Tests: an approval with a noticed lesson leaves the branch unchanged and the lesson on the state ref; the next step
  recalls it.

## 4. Rules kept

- Git reads in `story-*.mjs` go through `src/source-inspection.mjs`; remote calls through `runRemoteGitAsync`.
  `test/source-inspection.test.mjs` and the GAL baseline (`scripts/git-bypass-baseline.json`, updated per file from
  `--print-baseline`) hold the counts.
- New code is lazy: loaded only for a state-ref Story. The eager closures and VS Code bundles are measured before the
  push; a ceiling rises only with a dated note.
- Every new refusal has a `code` and a `details.nextAction` that is not the same command.

## 5. Changes while building

Recorded here as each stage lands.

### Stage (a), built 2026-11-27

- **One store for what waits.** No journal of its own: the sealed pending record (`writePendingPublication`) is
  written before the state ref moves, with `layout: 'state-ref'`, and carries every ref's lease (§2.4). So the
  transition gate (`assertNoPendingPublication` and its `repairRetainedPublication`), status and `sync` see it as today.
  `syncPublication` hands a state-ref Story to `syncStoryStatePublication`.
- **Refused before the write.** The one `ls-remote` runs before the state write. A remote another clone moved is
  refused there (`STORY_STATE_REMOTE_MOVED`, `REVISION_CONFLICT`), with `resume <ID> --fetch` as the way out, or
  `sync <ID> --set-aside` when this clone also holds unpublished state commits. A remote branch with commits the checkout
  lacks is `STORY_PUBLICATION_REMOTE_DIVERGED` with `refresh-branch`, as today.
- **A lost answer stays unknown.** As the branch's unit of work does, a push whose answer was lost is retained as
  `transport-indeterminate` (`OUTCOME_UNKNOWN`), not settled by a second observation in the same command, so both
  adapters pass the same conformance suite. `sync` settles it from what the remote holds.
- **The ledger entry rides the push only when its tip is the remote's.** Otherwise the branch and the state ref go
  atomically and the entry follows by `appendLedgerIntent`, as today's unit of work does after its branch push.
  Publication `off` commits locally and appends the ledger as today's unit of work does.
- **The set-aside is previewed**, then done with `sync <ID> --set-aside --confirm <local state commit>`, as today's
  branch set-aside is.
- **Left as M2 had it:** a process that dies *during* the state write leaves its files in `.sflow-state/`; the next
  transition commits them with its own. The branch's journal restores its preimage after such a death; the state ref's
  unit of work restores it only on a thrown error.
- **Budgets.** Eager: start.mjs 9,934,309 (+646 over 9,933,663), submit.mjs 9,930,939, root dispatch and session current
  unchanged, no new eager file. VS Code: `gateway-runtime.cjs` 7,932,471 bytes and 950 modules (+15,780, +1:
  `story-state-publication.mjs`, bundled from the adapter's dynamic import); every other bundle unchanged.
- **Tests:** `test/story-state-publication.test.mjs` (16): the conformance suite on the state ref (8), the state ref's
  own checks (4: the code commit named, a lost answer settled by sync, one refused lease moves no ref and the set-aside,
  a host hook that refuses the state ref), and real Stories (4: the start's one push of branch, state ref, ledger and
  pin; a transition stopped before its push finished by the next transition and by `sync`; a second clone; the branches
  transport). `test/sda-lifecycle-boundary.test.mjs`: `OTHER_PUBLICATIONS` is empty.

### Stage (b), built 2026-11-27

The walk of §3 (b) (`test/story-state-ref-approvals.test.mjs`) takes a state-ref Story through the specification's
publication, submission, a scope decision and its approval, then the plan's clarification answer, publication and
submission, and a second clone that resumes it with `--fetch` and approves the plan; each transition is checked to have
moved the state ref on the remote and nothing else (A2). It moved 20 of the 121 `prefix` uses (54 files, as counted by
`storyLocation(…).prefix`, `location.prefix` and `located.prefix`); the 101 left (52 files) are on paths the walk does not
reach (code steps and their test runs, amendments, upstream issues, Epics) and still refuse loudly. What it showed:
- **Two spellings, as REQ-009 says.** A step's document is named relative to the code checkout: in M3 a state-ref
  Story's document is in its state checkout, so its name is `.sflow-state/artifacts/<step>/…` (`checkoutPath()` beside
  `record()`); M4 changes the folder to `docs/stories/<ID>/`. A record keeps its state-relative spelling. A callee
  handed the Story's folder (`itemRelative`) is handed `checkoutPath()` and spells its records with `recordIn` and
  reads them with `recordFileIn`; one handed the folder on disk (`itemDirectory`) finds what records are relative to
  with `recordsRootFor`. Each gives today's strings for `story-branch`.
- **Git's view of a path in the state checkout** is the state checkout's (`gitPlaceOf`), and a document or record is
  read at a state commit by its name there (`stateRelative`). `artifact scan` lists the state checkout's changed
  documents beside the code checkout's.
- **A state commit is a governed commit.** It carries the transaction trailers (transaction, event SHA-256,
  publication mode) beside `Story-Code-Commit` and `Story-Event`, and the transition's `expectedHead` is its parent
  state commit, with `codeHead` beside it, so a generation's publication record verifies against its containing commit
  as on the branch. The publication is found in the state ref's history; it is published when the remote's state ref
  holds it.
- **REQ-004 at approval.** The artifact-only check compares the code checkout with the code commit the state commit
  names. The commits after a submission are the state ref's after its evidence commit and the Story branch's after the
  code commit that commit names, so a code commit after a submission refuses the approval as today
  (`STORY_REVIEW_SOURCE_CHANGED`, A4). The recorded-history check asks both refs. A state commit's records are read at
  its root (`governedStateChange`'s `itemFile`), so a scope decision between a submission and its approval is
  review-safe as today. The code tree digest leaves nothing out: the code checkout holds no records.
- **The five readers** with no Story in scope read a recorded state path through `recordedStateFile(root, path)`,
  which joins the state checkout when the process knows the checkout's Story keeps its records on its state ref.
- **Left for (d):** a lesson noticed at approval is still written in the code checkout's knowledge store.
- **Tests:** `test/story-state-ref-approvals.test.mjs` (2): the walk, and a code commit after a submission (A4). The
  helper `test/helpers/submitted-planning-story.mjs` takes the Story's description.

### Stage (c), built 2026-11-27

- **Removal and cleanup keep unpublished records.** `removeStateCheckout` refuses records not committed
  (`STORY_STATE_CHECKOUT_UNSAVED`) and, through `assertStateRecordsSaved`, state commits the remote has not got: a
  publication waits for them, or the local state ref is ahead of its tracking ref (`STORY_STATE_UNPUBLISHED`, way out
  `sync <ID>`). A Story whose publication is off has no tracking ref and no waiting publication: its records stay with
  the clone, as a local branch does, and its checkout may go. `releaseStateCheckout` (cleanup of a prepared launch,
  workspace retention) keeps a checkout on either.
- **The workspace drop** (`src/workspace.mjs`, Detach & drop local) loses the clone's refs too, so it asks more:
  `assertStoryStatesKept` refuses while any local state ref, either transport's, is not contained in what the remote is
  known to hold, with `sync <ID>` when a publication waits or was made, else the `git push` that sends the ref. The
  reference proof then accepts state refs and their tracking refs. `workspace-relink.mjs` only forgets checkouts whose
  folders are gone; the refs stay in the clone, so it asks nothing.
- **No `git stash` (owner-side decision, 2026-11-27).** M2's way past unfinished records in the state checkout was a
  stash in the state checkout. It is now `sync <ID> --set-aside`: previewed with the changes and a token, then
  `--confirm <token>` keeps them in a commit on `refs/singularity/state-aside/<ID>/<time>-unfinished` whose parent is the
  checkout's commit, and puts the checkout back (`setUnfinishedRecordsAside`). Every refusal that named the stash names
  it instead.
- **A process that dies during the state write.** Before the write the unit of work saves the files as they were (the
  preimage, its bytes in the machine's store) and the ref's commit in `<common dir>/singularity-flow/state-write/`. The
  next transition and `sync`, under the Story's lock, and the checkout's repair at command start, when the owner process
  is gone, put the checkout back from it while the ref has not moved (the interrupted bytes are kept, as today's layout
  keeps them), or bring the checkout's HEAD to a ref that did move. So the next transition never commits what it left.
- **Tests:** `test/story-state-ref-retention.test.mjs` (3): unfinished records kept and set aside by `sync`, then the
  checkout removed; state commits not published keep the checkout and stop the drop until `sync`; a transition whose
  process exits in the middle of its state write, undone before the next commits. `test/story-state-ref.test.mjs`: the
  two refusals name `sync <ID> --set-aside`.

### Stage (d), built 2026-11-27 (WMR REQ-022)

- **Kept with the approval, on the state ref.** `noticeStepLessons` writes a state-ref Story's lessons in its state
  checkout (`singularity/knowledge/records/` inside it), so the approval's state commit carries them and the Story branch
  never does; the lesson's `at` is still the code commit it is about. Its three `prefix` uses moved: the step's test
  attempts and documents are named from the checkout, its review records from the state checkout.
- **Recalled from it.** `readAllLessons` adds, beside the checkout's own, the base branch's and this machine's copies:
  the lessons in the state checkout of the Story in scope, and those on the clone's other state refs, read from Git
  objects with no checkout and no fetch. It asks only a clone that keeps a state-ref Story (a state checkout here, or
  the exclude line). `lessonsKeptBy` reads the same stores, so the line after an approval names the lesson.
- **Tests:** `test/story-state-ref-approvals.test.mjs`: an approval with a lesson (a `Learnings to carry forward`
  section) leaves the branch and the code checkout unchanged and the lesson on the state ref; it is recalled from the
  state checkout, and another Story started in the same clone is given it from the first Story's state ref.

### Stage (e), built 2026-11-27 (owner's go)

The walk `test/story-state-ref-code-step.test.mjs` takes a state-ref Story through its specification and plan, then the
code step: `prepare`, the code and its test written in the code checkout, `phase publish`, `submit` (its tests run) and
`approve`. What it showed:
- **A code step's code is the branch's.** The state ref's unit of work commits the transition's code paths on the Story
  branch first (`commitIsolated`, the code's paths only, never `.sflow-state/`), names that commit in the state commit
  (`Story-Code-Commit`) and pushes the branch with the state ref in the one atomic push. A transition that fails after
  its code commit takes it back (`undoCodeCommit`). A document step commits no code.
- **The code is read where it is.** A state commit holds records and documents; its code is the commit it names. The
  code commit is used wherever a lifecycle commit stood for the code: the change since publication, the coverage of the
  plan's clauses, the delivery receipt's witnesses and source bindings, the review's code artifacts, the change sets of
  a generation result and of a testing repair (`lifecycleCodeCommit`, `codeCommitNamedBy`). `changedRepositoryPaths`
  resolves a state commit itself, asked only in a checkout with a state checkout.
- **Records in the state checkout.** A test run's attempts and reports, the delivery receipt and its change set, the
  work interval's baseline and reconciliation, the version opening, the generation-start receipt, dependency records,
  an amendment's set-aside drafts are spelled from the Story's records and written there (`recordPlace`, `recordIn`,
  `recordFileIn`). A content check that expected a folder before `context/` accepts a record at the state root.
- **Prefix sites moved** with the walk and with the families it reaches: test runs (`verification/attempts.mjs`, the
  run marker, flaky runs, repository tests, `tests` and the test decisions, node pin, refactor behaviour), delivery and
  submission evidence, work intervals, version opening, input restore, upstream issues and forward amendments (their
  proposals as documents in the state checkout, read at its head), the mutation contract, retention and the other
  document readers. 101 uses (52 files) before; 26 (21 files) after, measured on the merge with main 29c9c43b9. Of
  those, 4 are in arms only today's layout takes (state.mjs twice, story-state-write.mjs, workflow-snapshots.mjs), and 2
  pass a bare work-item root, so they always name today's path and never refuse (knowledge.mjs's Story base and the
  exact Story revision reader of skill steps, git-exact-story-revision.mjs): for a state-ref Story they read nothing.
  The 20 left refuse, on paths the walk does not reach: source review, test recovery (TRP), test-command epochs and
  amendments, evidence amendments, skill steps, task amendments, collaboration, application reviews, the approver
  refresh, projectors, the approval focus's earlier text, clause sources, `spec author coverage --repair` and the
  workflow walk's fixed ID.
- **Lessons.** `lessons drop`, `keep`, `edit` and `rule` on a state-ref Story write the change in its state checkout and
  commit it on its state ref (only the lesson records), never on the branch; `sync <ID>` now sends state commits made
  with no transition of their own, leased at the remote's last known value.
- **A stop between the state ref's move and its checkout's HEAD** (a fault point there) is finished at the next command's
  checkout repair, and `sync` publishes the waiting records (`test/story-state-ref-retention.test.mjs`).

### Stage (f), built 2026-11-28 (owner's go)

The walk `test/story-state-ref-code-step.test.mjs` now takes a state-ref Story from its start to its release on the real
CLI: specification (one statement left out of scope), plan, code, convergence, verification, release, and the closed
Story. The branch ends as the base and the one code commit; every transition after the code step is a state commit,
published with the branch. The same walk runs in today's layout beside it. What it showed:
- **Convergence's records** (the reconciliation, the projection, assisted candidates, legacy archives, earlier
  iterations) were spelled from the Story folder and read against the checkout. The convergence context now carries
  `recordsRoot` and `recordPrefix` (`recordPlace`) beside `itemRelative`, which stays the documents' spelling; its
  upstream documents are asked of the state checkout's Git (`gitPlaceOf` in `assertCommittedPath`).
- **The code is still the tested code**: the test step's and the release's check compared the checkout with a state
  commit, so it listed every file of both trees. It compares with the code commit a state commit names.
- **Documents named as records.** A step's document spelled with `record()` names a state-relative path the checkout
  does not have (the release's conformance report first). Every document site now uses `checkoutPath()`: the conformance
  report, a forward amendment's and a departure's target, the evidence report, the artifact browser, recovery's
  published document (read in the state commit), the artifact-only scope check's document folders. `document()` and
  `isDocument()` name where M3 keeps documents (the state checkout's `artifacts/`) until M4 moves them to
  `docs/stories/<ID>/`; main's change-story page is their first user.
- **The final audit** read pinned templates, clarifications, test receipts and the automatic approval's records from the
  checkout, and looked for state commits on the remote branch. It reads them where the Story keeps its records
  (`verifyCodeDeliveryReceipt` takes `recordsRoot`) and finds a state-ref Story's generations on the remote's state ref,
  which the atomic push moves with the branch.
- **The change-story page** (main's CSP) is written into the state checkout in the code step's publication and
  committed on the state ref; its change sets and run receipts are read from the records, `explain --subject change
  --page` finds it, and `work status` finds a state-ref Story checked out here (its record is in the state checkout).
- **Not SSB, on main too:** SFlow's release record document listed a statement a scope decision left out as a clause
  row, which its own conformance check then refused (`CONFORMANCE_REPORT_INCOMPLETE`, "invalid qualified clause ID
  'SRI-…'"), in today's layout as well (measured on the same walk). The decisions are listed under the trace instead, and
  under the verification evidence's results, which counted them as requirements ("2 of 3 requirements verified").
- Prefix sites: 26 (21 files) before, 24 after (`clause-sources.mjs` moved): 4 in arms only today's layout takes, 2
  bare-root readers that always name today's path (`knowledge.mjs`, `git-exact-story-revision.mjs`), 18 that refuse
  off the walk.

### What is left of M3

- The 18 `prefix` sites that refuse, off the walk: source review, test recovery (TRP), test-command epochs and
  amendments, evidence amendments, skill steps, task amendments, collaboration, application reviews, document
  publication, the approver refresh, projectors, the approval focus's earlier text, `spec author coverage --repair`
  and the workflow walk's fixed ID; and the 2 bare-root readers. Each is a family of its own walk (a returned step, a
  test recovery, a task amendment, a reviewed step).
- Copilot chat's prompt hook (`copilot-plain-chat.mjs`) and auto mode's step contract (`auto/auto-phase-contract.mjs`)
  look for a Story under the Stories folder only, so they see no state-ref Story.

