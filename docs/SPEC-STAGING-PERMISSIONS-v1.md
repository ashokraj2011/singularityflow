# Staging permissions across Copilot turns (STG) — v1

Status: built 2026-10-21, with the recommended answers to both decisions below. It changes the Copilot edit guard
(`src/copilot-mutation-guard.mjs`), the phase mutation contract (`src/phase-mutation-contract.mjs`),
phase entry, source review, and the `/sf-phase` and `/sf-review-source` skills.

A Story step's author records the person's clarification answers by writing one JSON file at a
Git-private staging path, then running `singularity-flow clarification record`. A source reviewer
writes its report the same way. Today the permission to write that file lasts only for the Copilot
turn in which the CLI printed the path. A later turn that already knows the path is refused with an
error that offers no way forward, and the Story stops.

## The incident (2026-10-21, reproduced on main `89c1677a` and again on `1e81b9ef`)

A specification step with an open clarification checkpoint, in a linked Story worktree, ran through
three turns in one Copilot chat:

| Turn | What the model did | Guard |
|---|---|---|
| 1, `/sf-phase` | Ran `phase enter --compose`; the CLI issued `<git-dir>/singularity-flow/clarification-responses/specification-gen1.json` to this turn. Then it stalled, and after 7.5 minutes the person stopped the turn (`abort: user_initiated`). | — |
| 2, `/sf-phase` | Did not run `phase enter`. It reused turn 1's entry from the conversation, asked the two questions, and wrote the remembered path with `apply_patch`. | **Denied**: `PHASE_MUTATION_PATH_DENIED (…/specification-gen1.json). May edit this phase's artifacts only.` Route: `/sf-phase`. |
| 3, `/sf-phase` | Ran `phase enter`, so the path was issued again and the write would have been allowed. It never tried. It reported "the file-edit tool denied the exact CLI-issued staging path", although nothing was denied in that turn. | — |

The reproduction drives the guard with its own test fixture. Turn 1 is allowed (`{}`). Turn 2, in the
same session and without `phase enter`, gets the identical refusal. Turn 2 after `phase enter` is
allowed again. No path segment was a link, and the file did not exist.

## Root cause

1. **Permission lifetime is shorter than path lifetime.**
   - Each explicit turn starts from an empty grant. `captureMutationTurn` calls `createRecord`
     without the previous record, so `contract.allow.staging = []`.
   - A path enters the grant only when its issuer runs in that turn: `issueMutationStaging`, called
     from phase entry (`clarification`) and source-review context (`source-review`).
   - The path itself outlives the turn. It is printed in the entry result and its saved agent-results
     file, and it stays in the conversation. The clarification guidance even gives a standalone
     discovery route (`git rev-parse --git-path singularity-flow/clarification-responses/<phase>-gen<N>.json`).
   - So any turn that knows the path but did not run its issuer is refused.
2. **The skill invites the skip.** `/sf-phase` says "First run `singularity-flow phase enter
   --compose --for-agent --json` once" and "reuse binding/recovery/clarification/references …; no
   duplicate lookups". After an interrupted turn, a model reads that as "I already entered in this
   chat". Stopping a stalled turn and running the skill again is ordinary, so this will recur.
3. **The phase guard's refusal has no repair route.**
   - An unissued staging file falls through to the generic `PHASE_MUTATION_PATH_DENIED`, with the
     artifact-scope summary and a route back to the skill already running.
   - `stagingPathMismatch` corrects only a path that resembles one already issued in this turn, so
     with nothing issued it says nothing.
   - The three other per-turn guards already name their issuer: "no candidate file is issued to this
     turn. Run singularity-flow workflow import-team inspect first", and the same for
     `workflow build` and `workflow validate`.
4. **Consequence.** With no route, the model generalised the refusal to the path itself. It
   stopped trying even after a correct re-entry, and its final message misreported that turn.

### Related: the same-turn refresh race (92d1d455)

- **What `92d1d455` fixes.** A background contract refresh could rewrite the turn record over a
  grant just issued, inside one turn. That commit makes `issueMutationStaging` write an issuer
  receipt, and `currentContract` recovers a grant from a receipt.
- **Why it doesn't fix this incident.** A receipt must match the live turn's `turnId`, Story, step,
  generation and mode, so a later turn still finds nothing. The reproduction above still fails after
  that commit.
- **How D1 fits.** D1 derives the two step files on every contract read, so they never depend on a
  receipt. Receipts stay for files issued within a turn: team-import candidates, build proposals,
  fix-workflow change sets and app drafts.

## Goals

- A correctly bound turn can always write its own step's staging file, whether or not this turn ran
  the issuer, whether the turn was interrupted, and whether it is a new chat.
- Every refusal of a staging or issued file names the exact command that issues it, on all three
  surfaces (Copilot, Shell, VS Code).
- Nothing widens:
  - only exact files, never a directory;
  - never another Story, checkout, step, generation or turn mode;
  - the content checks in `clarification record` and `review-source check|stage` are unchanged.

## Non-goals

- Carrying arbitrary issued paths from one turn to the next. Per-turn issuance stays for files that
  cannot be derived from pinned state: team-import candidates, workflow-build proposals, fix-workflow
  change sets, and `app suggest` drafts.
- Changing how answers or review reports are validated or recorded.
- Rewording the shared output contract used by every skill.

## Design

### D1 — Derive a step's own staging files from the pinned contract

This is the permanent part. A step's clarification response and source-review report have one exact
location each. It is fully determined by the bound checkout's Git directory, the Story, the step,
the generation and the turn mode. The guard derives these files when it builds a turn's contract,
instead of waiting for an issuer to add them.

- New module `src/phase-staging-paths.mjs`, the single source of these paths:

  ```js
  /** The exact Git-private staging files a turn on this step may write. Never a directory. */
  export function phaseStagingPaths({ gitDirectory, workflow, phase, turnMode, clarificationMode })
  // authoring, step editable, clarificationMode !== 'off':
  //   <gitDirectory>/singularity-flow/clarification-responses/<phase.id>-gen<phaseInspectionGeneration(workflow, phase)>.json
  // read-only-review, step has a source review, no author conflict:
  //   <gitDirectory>/singularity-flow/source-reviews/<workId>-<phase.id>-gen<phase.generation>.json
  // every other mode: []
  export function clarificationStagingPath(gitDirectory, workflow, phase)
  export function sourceReviewStagingPath(gitDirectory, workflow, phase)
  ```

- Callers that derive these paths today switch to the helpers, so issuer and guard cannot drift:
  - `src/phase-entry-authoring.mjs:112` (clarification);
  - `src/source-review-agent-context.mjs:74` and `src/source-review-staging.mjs:43` (source review,
    which are two separate copies today).
- `createRecord` sets `contract.allow.staging` to the derived files. It keeps any files still issued
  within the same turn, as today.
- `issueMutationStaging` is unchanged. It still issues files within a turn, with its receipts from
  `92d1d455`. Because issuer and guard share one helper, the path it issues equals the derived
  path by construction, and acceptance test 7 pins that.
- Directory preparation:
  - A derived file that fails the ordinary path checks (for example, a link) is dropped from the grant.
  - The derived file's parent directory is created, mode 0700, when the turn's record is created, so
    a write needs no shell `mkdir`.
  - Parent directories never become edit permissions.
  - Only the exact derived file's existing ancestors are created, never a broader tree.
- The comment "exact and issuer-provided" on the staging exception in `mutationPathDecision` becomes
  "exact, and derived from the pinned contract or issued in this turn".

Why this is safe:

- **Exactness is unchanged.** It is still one file per step, generation and mode, in the bound
  checkout's own Git-private directory.
- **Cost is low.** The contract already loads the accepted Story and pins the workflow file digest.
  The clarification mode is read from the same pinned definition that phase entry uses. A changed
  workflow or generation still invalidates the record (`currentContract` digest checks), and the
  next turn derives the new generation's file.
- **The written file grants nothing by itself.** `clarification record` validates it against the
  pinned checkpoint and answer binding, and `review-source check` against the review binding.
- **Turn-mode separation is unchanged.** An authoring turn never derives the reviewer's file, and a
  review turn never derives the author's.

### D2 — A refusal that names the issuer

When a denied write targets a reserved staging location, the guard returns a specific, actionable
refusal instead of `PHASE_MUTATION_PATH_DENIED`. A reserved location is a file under
`<git-dir>/singularity-flow/{clarification-responses,source-reviews}/`, in any checkout.

| Case | Code | Reason (summary) | `next` |
|---|---|---|---|
| Same checkout, this step, a different generation | `PHASE_MUTATION_STAGING_PATH_MISMATCH` (existing) | Write exactly `<derived file>`. Copy the CLI path verbatim. | none; correct the target |
| Same checkout, no derived file for this turn's mode (for example clarification off, or a review file in an authoring turn) | `PHASE_MUTATION_STAGING_NOT_ISSUED` (new) | "This turn may not write `<file>`. It is issued by `<issuer>` in a `<mode>` turn. Preserve the person's answers; do not repeat questions." | the issuer route |
| Another checkout's Git directory | `PHASE_MUTATION_STAGING_NOT_ISSUED` | "`<file>` belongs to another checkout. This turn is bound to `<repositoryRoot>`." | `session current --for-agent --json` |

Each issuer route carries `commandGuidance` in the usual order (Copilot, Shell, VS Code):

- an authoring turn: `singularity-flow phase enter --compose --for-agent --json`, skill `/sf-phase`;
- a review turn: `singularity-flow review-source context --for-agent --json`, skill `/sf-review-source`.

Refusals carry `details.nextAction` so `scripts/finding-routes-audit.mjs` accepts them.

Order and limits:
- The existing same-name correction runs first. A file with the same name as one this turn may write,
  in any checkout, is answered with "write the issued staging file at exactly <this turn's file>".
- The new refusal applies only to a target refused for where it is (outside the bound worktree, or
  under `.git`). A link, an unreadable ancestor or an invalid target keeps the ordinary denial; it is
  never offered back as the file to write.

Run-and-test needs no change: with no draft issued, its refusal already says "To draft start entries
run singularity-flow app suggest --json and write only its draft.applicationFile".

### D3 — Entry and skill wording

These lines tell the model to do the work. They add no stop, relay or hand-off reason.

- `/sf-phase`: "Run `singularity-flow phase enter --compose --for-agent --json` at the start of
  every `/sf-phase` turn, including after an interrupted turn. An earlier turn's entry is context,
  not this turn's binding." This replaces "First run … once". The existing reuse sentence becomes
  "reuse this turn's binding/recovery/clarification…".
- `/sf-review-source`: the same rule for `review-source context`.
- Phase entry's clarification checkpoint guidance (`src/clarifications.mjs:428`) adds: "This path is
  this step's own staging file in every turn of this generation. An earlier refusal of it does not
  apply after this entry: write it now with a file-edit tool."
- If a skill exceeds its token budget, raise its `maximumTokenOverride` with this reason. Never trim
  other sentences to fit.

### D4 — Class inventory

| Issued file | Issuer | After D1–D3 |
|---|---|---|
| Clarification response | `phase enter` | Derived (D1); refusal names `phase enter` (D2) |
| Source-review report | `review-source context` | Derived (D1); refusal names `review-source context` (D2) |
| Team-import candidates | `workflow import-team inspect` | Per turn; the refusal already names the issuer |
| Workflow-build proposal | `workflow build status` | Per turn; the refusal already names the issuer |
| Fix-workflow change set | `workflow validate` | Per turn; the refusal already names the issuer |
| Run-app application draft | `app suggest` | Per turn; the refusal already names the issuer |
| Read hints (local documents, visual sources) | `document-runtime`, `review-source context` | Reads are not blocked; unchanged |

## Acceptance tests

All tests use the existing fixture in `test/phase-mutation-contract.test.mjs` and a fake Copilot.
No test makes a paid model call.

1. **The incident.**
   - Turn 1 enters the step and is issued the path.
   - Turn 2, in the same session, has no `phase enter`. An `apply_patch` `*** Add File:` at the
     derived clarification path is allowed, where today it is denied.
   - The same holds for `create`/`edit` with an absolute path, a `file:` URI, and a batched
     `toolCalls[]` payload.
2. **A new chat.** A different session on the same Story and step is allowed without `phase enter`.
3. **Wrong generation.** Writing the gen0 or gen2 file returns `PHASE_MUTATION_STAGING_PATH_MISMATCH`
   naming the gen1 file. Nothing is written.
4. **Another checkout.** A second Story worktree's clarification file is refused with
   `PHASE_MUTATION_STAGING_NOT_ISSUED` and the `session current` route.
5. **Mode separation.**
   - A review turn cannot write the clarification file.
   - An authoring turn cannot write the review file. Both refusals name the other issuer.
   - Approval-only, decision, publish-only, read and session turns derive nothing.
6. **Clarification off.** No derived file. The refusal names `phase enter` and states that this step
   has no clarification checkpoint.
7. **One derivation.**
   - Phase entry's `clarification.responseStagingPath` equals `phaseStagingPaths(...)`.
   - Both source-review call sites return the helper's path, and the old inline joins are gone.
8. **No widening.**
   - The derived file's directory, siblings, and the parent `singularity-flow/` are still refused.
   - A symlinked or hard-linked target is still `linked-target`.
   - A target that is a directory is refused.
9. **Routes.**
   - Each new refusal carries three-surface `commandGuidance` and `details.nextAction`.
   - `finding-routes-audit` and `upstream-route-dead-ends` pass.
10. **Recording still validates.** A derived-path write with wrong answers, or an answer binding from
    another generation, is still refused by `clarification record`.
11. **Skills.**
    - Plugin tests pin the "every turn" sentence in `/sf-phase` and `/sf-review-source`.
    - No skill gains "On a refusal or any stop".
    - The skill HTML catalog is regenerated.
12. **Interrupted turn, end to end.** In the fake-Copilot harness, `/sf-phase` is aborted after
    `phase enter`. The next `/sf-phase` stages and records the answers, and authoring continues.

## Compatibility

- No record schema change. `allow.staging` already exists and is now populated at creation.
- Installed copies need an engine update. A global `sflow` is a copy; reinstall with `--build`.
- Existing Stories need nothing. The next turn derives its file.

## Decisions needed

1. **When the clarification file is derived.**
   - Recommended: whenever the step's clarification mode is not `off`. This needs no extra read at
     turn start, and `clarification record` already refuses a stale or duplicate response.
   - Alternative: only while the checkpoint is open. This costs one record read per turn.
2. **Whether D2's `NOT_ISSUED` route also starts a new turn's re-entry automatically.**
   - Recommended: no. The refusal names the command, and the model runs it in the same turn.
     Automatic re-entry would hide which turn issued what.

## Files

| File | Change |
|---|---|
| `src/phase-staging-paths.mjs` | New |
| `src/phase-mutation-contract.mjs` | Staging exception comment; the contract accepts derived staging |
| `src/copilot-mutation-guard.mjs` | `createRecord` derives staging; D2 refusals; run-and-test wording |
| `src/phase-entry-authoring.mjs` | Uses the helper |
| `src/source-review-agent-context.mjs`, `src/source-review-staging.mjs` | Use the helper |
| `src/clarifications.mjs` | Checkpoint guidance line |
| `plugin/skills/sflow-phase/SKILL.md`, `plugin/skills/sflow-review-source/SKILL.md` | D3 wording |
| `plugin/skills/registry.yml` | Budget overrides if needed |
| `docs/SINGULARITY-FLOW-SKILLS.html` | Regenerated |
| `test/phase-mutation-contract.test.mjs`, `test/plugin.test.mjs`, `test/phase-entry.test.mjs`, `test/source-review-lifecycle.test.mjs` | Acceptance tests |
| Cold CLI bundle families, VS Code bundle budgets | New module placement; ceilings to the next boundary in their own commits if needed |
