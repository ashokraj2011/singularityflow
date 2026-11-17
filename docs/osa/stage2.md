# OSA Stage 2 — successor openings made durable

**Specification:** [SPEC-OSA v1.1](../SPEC-OSA-ONE-STEP-AUTHOR-v1.1.md) section 7, REQ-030–REQ-034, AC-015–AC-017; implementation plan section 4.
**Branch:** `osa-v11-s2`, from `osa-v11-s1` at `90e7095cc`.
**Status:** the stage's implementation and its targeted qualification. The heavy run (full suite on Node 22, then the weekly Node 26 run) has not been made; it comes at the end.

## 1 What changed

| # | Item | Where |
|---|---|---|
| 1 | Two lifecycle members, vocabulary 10: `version-opened`, `version-writer-taken-over` | `src/vocabularies/catalog.mjs`, their review effect (`state.mjs`) and history spelling (`gateway/work-records.mjs`) |
| 2 | The proposal and its question | `src/story-version-proposal.mjs` |
| 3 | The consent records: proposal record, grant, receipt | `src/story-version-consent.mjs` |
| 4 | The opening operation, its checkpoints, reconciliation and the writer fence | `src/story-version-opening.mjs` |
| 5 | What a checkout observed of an opening, from files only | `src/story-version-acceptance.mjs` |
| 6 | The kernel's opening facts and reservation | `src/kernel/step-state.mjs`, `src/kernel/step-versions.mjs`, `src/phase-generation-need.mjs` |
| 7 | The commands on the operation | `src/commands/phase-opening.mjs`; `phase begin`, `phase rollover`, `phase opening` (`commands/phase-lifecycle.mjs`), `prepare` (`commands/shared/prepare-configured-phase.mjs`), the requested and own-correction successors, `session takeover` |
| 8 | The guard binds the yes to the exact version and keeps it | `src/copilot-mutation-guard.mjs`, `src/copilot-answer-binding.mjs` |
| 9 | The entry, the task, the review continuation, the guide and sequence name one consent route | `phase-authoring-entry.mjs`, `phase-authoring-progress.mjs`, `source-review-continuation.mjs`, `sequence.mjs`, `phase-entry-context.mjs` |
| 10 | Qualification | `test/osa-stage2-opening.test.mjs`, `test/osa-stage2-journey-h.test.mjs`, `test/osa-stage2-compat.test.mjs`, journey F and G in `test/journey-stories.test.mjs` |

The old working-copy-only opening is gone: `phase begin`, `phase rollover --confirm`, `prepare` and the own correction no longer open a version with `saveStoryDraft` and no commit.

## 2 Records

All three consent records and every checkpoint are sealed with the clone's machine-local key (`machine-local-hmac-sha256-v1`, the key `publication-machine-integrity.mjs` already keeps), each with its own purpose. A JSON file written by hand is never a proposal, a grant, a receipt or a checkpoint.

### 2.1 `VersionOpeningProposal/v1`

`{ schema, operation: 'version-opening/v1', workId, phase, step, kind: code|document, version, highWatermark, from: { published, publicationDigest }, abandoned, reason, consent: required|not-required, evidence: { testsRecorded }, confirmation, adoption, configurationRevision, lifecycleRevision }`, and its digest (`sha256:` of the canonical JSON).
- `version` is the kernel's `proposedNext`, or a legacy local opening's own number.
- `consent` is `not-required` only for version 1 (§7.2).
- `lifecycleRevision` is the local Story branch head the proposal was made on; `confirmation` the value the preview showed.
- Reasons: `initial`, `watermark`, `rework`, `rejected`, `amendment`, `author-conflict`, `review-corrections`, `requested-change`, `changed-after-publication`, `own-correction`, `legacy-promotion`.

**The question** (§7.1) uses the actual numbers and names tests only when the published version recorded them:
- `Start version 2 of Implementation? Published version 1 will stay unchanged.`
- `Start version 3 of Implementation to fix the review's findings? Published version 2 and its recorded tests will stay unchanged.`
- `Start version 4 of Planning? No version was published; version 3 was reserved earlier and abandoned, so its number is not used again.`

### 2.2 The consent path

| Record | Written by | When | Kept |
|---|---|---|---|
| Proposal record (`version-opening-proposal-record/v1`) | the `phase rollover` preview | every preview, under its confirmation value | `<git common dir>/singularity-flow/version-consents/` |
| Grant (`version-opening-grant/v1`) | the pre-tool hook | on the person's yes delivered by the host: an answer to a question naming that exact version (question tool), or the `/sf-confirm` code typed into their own prompt | same folder, under the proposal digest; 30 minutes |
| Receipt (`VersionOpeningConsent/v1`) | the opening command | from the grant, from a yes typed at the person's own TTY, or for the exact confirmation run outside every Copilot turn bound to the Story's checkout | committed in the opening record |

**`VersionOpeningConsent/v1`:** `{ schema, receiptId, proposalDigest, binding: { workId, phase, version, from, confirmation }, principal: { kind: 'human', identity: { name, email, login }, assurance, session, host }, response: { surface, question, answer, turnId }, confirmedAt, expiresAt, machineLocalIntegrity }`.
- `surface`: `question-tool`, `confirm-code` or `terminal`. `assurance`: `host-answer`, `host-confirm-code`, `terminal-tty` or `terminal-command`.
- An Auto repair of a step Auto already published (landing 11-17): the Repair Plan names the version it starts ("Confirming this plan is the yes to start version N of …"), so the person's confirmation of the plan's exact hash is their yes. The executor opens it in process through `openVersion` with a receipt of `surface: 'auto-repair'`, `assurance: 'auto-repair-plan'` and an `authorization` naming the flight and plan (`src/auto/auto-version-authority.mjs`). The ratified Auto policy cannot give it, and Auto never confirms a `phase rollover` preview itself.
- The identity is the one this machine resolves (Git configuration, a cached GitHub login, `SINGULARITY_FLOW_GITHUB_ACTOR`), recorded at the preview and carried by the grant; never a value from a model's arguments. `session` is the SHA-256 of the host session that answered.
- `expiresAt` is 30 minutes after the yes (one turn window, AC-021).
- Refusals: `VERSION_CONSENT_REQUIRED`, `_UNVERIFIED` (not sealed here), `_WRONG_TARGET` (another proposal or version), `_DECLINED`, `_EXPIRED`, `_PRINCIPAL_CHANGED`.

The guard tightened in two places: a yes now must answer a question that names the preview's exact version number (it matched any number before), and a confirmation with no preview on this clone is refused before any question is read. In a chat with no `/sf-` command, a confirmed rollover is never run.

### 2.3 The opening record and the step's pointer

Committed at `context/version-openings/<step>-v<N>.json`: `{ schema: 'version-opening/v1', operationId, payloadDigest, proposal, proposalDigest, consent (the receipt, or null for version 1), settled (the own correction only), writer: { fence, writerId, operationId, actor }, intent: { id, receiptSha256 }, openedAt }`.

The step's `versionOpening` pointer in `workflow.json`: `{ operationId, version, highWatermark, reason, path, sha256, consent: { receiptId, surface, assurance } | null, writer: { fence, writerId, operationId }, openedAt }`. `highWatermark` is the reservation: the kernel never reuses it (a used reservation counts in `max(published, watermark, reservation) + 1`), and the live opening's reservation is its own number. A takeover adds `context/version-openings/<step>-v<N>-fence<F>.json` and moves the pointer's `writer`.

## 3 The operation (§7.2)

`openVersion(root, config, workflow, phase, { proposal, digest, receipt, principal, operationId, open })`:
1. **Identity.** The operation ID is stable: `vo-` and the first 32 hex digits of SHA-256 over the operation name and the proposal digest, or one the caller passes. Its payload digest binds the Story, step, version and proposal digest.
2. **Replay.** The same ID and payload return the original outcome (no commit, no question); another payload under the ID is `VERSION_OPENING_OPERATION_REUSED`; a refused operation replays its refusal.
3. **Expected revisions.** The proposal is recomputed from the Story as it is now: a moved head or another number is `VERSION_OPENING_STALE`, with the kernel's current route. The remote revision is the publication's lease.
4. **Consent.** Every opening but the first of version 1 needs its verified receipt.
5. **One commit.** Through `commitAndPublish` (the Story unit of work: subject lock, journal, exact-path staging, leased push, retained pending publication), with `transactionId` = the operation ID: the reservation, the step's own opening (a code step's generation intent and receipt, a document's reservation), the opening record with the receipt, the pointer and a `version_opened` history entry. Staged paths: `workflow.json`, `STATUS.md`, `context/version-openings/`, `context/generation-start/`, `context/work-intervals/`, and the event's ledger intent. Never application files, unrelated changes or local attachments.

### 3.1 Checkpoints

| Checkpoint | Written | Grants edits |
|---|---|---|
| `prepared` | before anything is reserved | no; nothing is committed, the confirmation runs again |
| `locally-persisted` | right after the commit (the unit's `after-commit`) | no |
| `shared-pending` | the push did not complete (retained for sync), or `warn` mode, or reconciliation found the commit absent remotely | no |
| `shared-confirmed` | the remote took the leased push (the unit's `after-push`), or reconciliation found the commit there; with publication off, the local branch | yes, to its writer |
| `unknown` | the push's answer was lost and could not be read back, or the process stopped after the commit | no |
| `refused` | the lease was refused: another checkout changed the branch first (`VERSION_OPENING_CONFLICT`, route `sync <ID> --set-aside`) | no |

A refusal before the commit (a moved remote, a pending publication, a dirty start) removes the `prepared` checkpoint: nothing was opened. **Reconciliation** (`phase opening <step> --reconcile`, and the same confirmation or `phase begin` again) settles an uncertain opening as the same operation: the Story's own sync of the retained commit under its original lease, then one observation of the Story branch. It never authors again and never opens another version; an unreadable remote leaves it `unknown`. An opening found only in the working copy, never committed, settles nothing (`VERSION_OPENING_NOT_SHARED`).

## 4 The writer fence (§7.3)

- Each checkout has a writer ID (`<git dir>/singularity-flow/version-writer.json`); the opening names it with fence number = the step's last fence + 1.
- The kernel writes an operation's opening only when this checkout observed it `shared-confirmed` and holds its writer. Another writer: `held`, `takeover-writer`, rendered `session takeover <ID>`. Uncertain: `waiting`, rendered `phase opening <step> --reconcile`. Unobserved: the same.
- **Takeover** reuses `session takeover` (attach in an isolated worktree, fetch only the Story branch, refuse local edits). For an open version written elsewhere it then moves the fence with one leased commit (`version-writer-taken-over`); its result says `exclusiveOwnership: true` and `writerFence`.
- **The old writer** is refused without Git per tool call (REQ-041): at its entry (the Story branch is read once and the decision says `refresh-branch`), by the publication lease, and, once refreshed, by `VERSION_WRITER_FENCED` at publication. Another checkout may always inspect (`phase opening`).
- The guard reads two files per call only when the step has an operation opening: the writer file and the checkpoint. Both are stamped into the turn's binding, so a settled opening or a takeover re-derives the grant.

## 5 Legacy local openings (§14)

- An older build's local intent of **version 1** still authors, as Stage 1 normalized it; `phase begin` promotes it through the operation once its receipt verifies.
- Its local intent of a **successor** grants nothing: the entry asks, and `phase rollover` promotes it at its own number on the person's yes, keeping its intent and receipt (`reason: legacy-promotion`).
- No read changes either: `phase opening`, the entry and every other read only report it.

## 6 Findings and decisions

| # | Finding | Decision |
|---|---|---|
| 1 | The own correction (owner, 2026-11-13) opens the next version settled for the person, with an undo, and no yes. D3 and REQ-030 say every successor needs the person's yes. | Kept as the owner decided, through the opening operation, recorded as `settled: { kind: 'own-correction', id }`, never as consent. **Owner decision needed:** keep the exception or drop it. |
| 2 | A once-returned code step keeps its change request open until approval, so it stays "explicitly reopened" after it republishes, and its review's corrections opened version 3 with `phase begin` and no question (journey F `osa-stage-2`). | The review's corrections open through the rollover preview whatever the change request says. |
| 3 | A lost push answer with the remote still reachable is already settled by the unit of work (it reads the outcome back). | Only an unreadable outcome reaches `unknown`; journey H takes the remote away to test it. |
| 4 | Initial document versions have no opening record (Stage 1 left them so). | Unchanged in Stage 2: D3 is about successors; document successors use the operation. Recorded for Stage 3. |
| 5 | Kernel-built document steps cannot be rolled over (the rollover excludes deterministic steps). | Unchanged; their successors stay as before. Recorded for Stage 3/4. |
| 6 | VS Code's own chat never hands the hooks a question's answer. | Unchanged: there a successor starts by `/sf-confirm` code or the person's terminal, as before. |
| 7 | An older build cannot `sync` a retained `version-opened` publication: its vocabulary (v9) refuses the member. | Reported as the one unsupported combination; the supported route is to update SFlow on that laptop, then sync (section 8). |
| 8 | With an uncertain opening whose commit is retained for sync, the entry's act names the retained publication's own recovery first (`appeal resolve`, then `sync`), while the permission's next names `phase opening <step> --reconcile`. | Both settle the same commit under its original lease and neither opens another version; the entry grants nothing meanwhile (journey H). One route for both is Stage 3's (the recovery planner). |
| 9 | Session current's task named the step's entry while the other views named the person's preview for a next version. | The task's resume names the preview when the next version opens only on the person's yes (`workflow-task-store.mjs`). |
| 10 | Sequence guidance said "write version N" for an older build's local successor, which the kernel promotes first (the shadow comparison's 32 new differences). | Sequence names the rollover preview for it, as for any published step being written. |
| 11 | The outcome validation's "Request a repair" named `phase begin` for a published code step, which opened version 2 with no yes; `phase begin` refused for a successor named the kernel's route (readiness), not the preview. | Both name the step's preview (`phase rollover <step> --json`), which asks the person. A skill amendment's reopening asks the same way (`dead-end-routes`). |
| 12 | The question named recorded tests only from a submission's executions; a code step's passing run at publication was left out. | A passed run at the published version's publication counts too, as the review reads it. |
| 13 | With no `origin` configured and publication `required`, the unit of work refuses an opening with "remote changed after its exact push authority was observed": `configuredRemoteAuthority` returns an authority whose URL is null. | Not changed here (the unit of work's wording). Openings now publish, so fixtures that open a version through the CLI need a remote (`publication-preflight` uses a local bare one). Worth a plainer refusal (`PUBLICATION_REMOTE_AUTHORITY_MISSING`) in its own change. |

## 7 Ratchet and budgets

- AC-020 ratchet: no family rose except one named exception, `sequence.mjs` lifecycle commands 9 → 10 (renderer, owned by Stage 3's sequence cohort), for the consent preview of a published step being written. Five Stage 1 exceptions were deleted because their counts fell back; several families fell (`phase-lifecycle.mjs` predicates 7 → 3, `source-review-continuation.mjs` choosers 3 → 1 and skill literals 3 → 1, the entry's and the task's intent reads to 0).
- Session current: 221 files (unchanged), bytes 4,279,049 against a raised 4,279,100 (+1,478, measured and commented in `test/lazy-command-handlers.test.mjs`).
- Lifecycle handlers: within the unchanged 9,694,550 budget (`phase-lifecycle` 9,694,534, 16 bytes to spare; `submit` 9,659,164 with one new file, 471 of 473). The changed-files rollover moved from `phase-lifecycle.mjs` into the lazy `phase-opening.mjs`; the operation, consent and acceptance modules stay out of every eager closure.
- Plain language: two older violations fixed and locked in; no new one.

## 8 Compatibility (AC-019)

| Writer | Reader | Result |
|---|---|---|
| Stage 2 | Stage 1 (90e7095cc) | reads the Story and publishes the version Stage 2 opened: the intent and receipt keep their shape, `generationHighWatermark` is unchanged, so max(generation, watermark) + 1 names the same version; it keeps the pointer |
| Stage 2 | Stage 1, sync of a retained `version-opened` commit | refused by its vocabulary (v9): update SFlow, then sync. The member is governing, `preserve-and-restrict`. Read from the older vocabulary, not run |
| Stage 1 | Stage 2 | its local version 1 still authors; its local successor grants nothing until `phase rollover` promotes it on the person's yes |
| Stage 2 | Stage 2, a second checkout | sees the opening after refresh, may inspect it, writes only after a verified takeover |

`test/osa-stage2-compat.test.mjs` runs the first and third rows with the older build's own CLI when `SINGULARITY_FLOW_OSA_OLDER_CHECKOUT` names its checkout.

## 9 Acceptance rows

| Row | Result | Evidence |
|---|---|---|
| REQ-030 | **Pass** | consent receipt on every successor; refusals for declined, expired, wrong target, changed principal, unsealed and no yes; the guard holds the yes to the exact version (`osa-stage2-opening`, `review-next-step`, `requested-successor-cli`, journey F); one owner exception (section 6, item 1) |
| REQ-031 | **Pass** | conditional reservation and shared acceptance before successor edits; only metadata committed (`osa-stage2-opening` tests 1, 2, 5–10) |
| REQ-032 | **Pass** (Stage 1, kept) | an open successor leads, through the guard (journey G, `step-being-written`) |
| REQ-033 | **Pass** | replay and reconciliation of the same operation; no duplicate, no replacement (`osa-stage2-opening` 2, 5–11; journey H) |
| REQ-034 | **Pass** | writer fence, takeover, old writer refused at entry and publication (`osa-stage2-opening` 12; journey H) |
| AC-015 | **Pass** | the concurrent race: one wins, the other `VERSION_OPENING_CONFLICT` with the current action |
| AC-016 | **Pass** | faults before the reservation, after local persistence, after the push, after shared acceptance and before the reply |
| AC-017 | **Pass** | second host resumes after refresh; verified takeover fences the old writer; no cache or flag fabricates authority |

**No accepted opening or consent can be manufactured from local JSON:** an unsealed receipt or grant is refused; a hand-written pointer is `unobserved` and grants nothing; reconciliation never confirms an opening that is not committed.

## 10 Targeted runs at Stage 2

Node 22, through the isolated runner at concurrency 2. No touched set and no full run: the heavy run comes at the end, by the owner's rule.

| Run | Files | Result |
|---|---|---|
| Stage 2 qualification | `osa-stage2-opening` (12: the race, faults at six points, replay, consent refusals, offline, takeover) | pass |
| Slow lane (`SINGULARITY_FLOW_TEST_SLOW=1`) | `journey-stories` journeys F and G; `osa-stage2-journey-h` | pass: F's four checks with no KNOWN_BAD left, G's checks with its `osa-stage-3` todo unchanged; H |
| Compatibility | `osa-stage2-compat` with `SINGULARITY_FLOW_OSA_OLDER_CHECKOUT` at a Stage 1 checkout (`90e7095cc`) | pass, 4 of 4 |
| Neighbours | 53 files: `review-next-step`, `requested-successor-cli`, `requested-successor-document-cli`, `phase-authoring-continuation`, `phase-authoring-progress`, `phase-mutation-contract`, `step-being-written`, `source-review-lifecycle`, `publication-preflight`, `step-routes-stage1`, `osa-stage1-guard`, `osa-stage1-shadow`, `osa-stage1-skills`, `sequence`, `workflow-task-resume`, `workflow-task-completion`, `session-entry-bounded`, `session-entry-view`, `changes-after-publication-cli`, `confirmation-routes`, `settled-decisions`, `settled-decisions-flow`, `cic-pre-amendment-drafts`, `post-code-handoff`, `review-every-step-cli`, `dead-end-routes`, `rework-lifecycle`, `phase-entry`, `kernel-step-routes`, `voc-registry`, `int-material-events`, `oap-m2-review-effects`, `command-registry`, `copilot-turn-renewal`, `still-holds-in-chat`, `journey-routes` (fast tier), `cli-bundle`, `no-dead-end`, `agent-output`, `sda-m5-takeover` and the twelve `refusal-*` files | pass after the fixes in section 6 items 10–13: the first pass found 10 failures (688 passed), each a Stage 2 behaviour the test predated; the failing files then passed on rerun |
| Must stay green | `source-inspection`, `git-bypass-audit`, `sda-inventory`, `lazy-command-handlers`, `exit-ratchet`, `plain-language`, `osa-ratchet`, `osa-stage0`, `osa-stage1-kernel`, `documentation-privacy`, `docs-layer`, `documentation-consolidation` | pass |
| Repository check | `node check-iso.mjs <worktree>` (`scripts/check.mjs`) | pass: 3,780 checks, after registering `--reconcile` as a boolean flag and regenerating the operation catalog |

**Not run:** the full suite, the weekly Node 26 run and the performance comparison (`scripts/osa-perf-baseline.mjs`). The guard's added cost is two small file reads per call, only for a step whose version was opened by the operation.
