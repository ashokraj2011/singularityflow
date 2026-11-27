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
