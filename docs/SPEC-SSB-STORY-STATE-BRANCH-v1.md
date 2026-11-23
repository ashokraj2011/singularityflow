# Story state branch (SSB) — v1: a Story's code branch holds code and documents; SFlow's records live beside it

**Specification ID:** `SSB-v1`

**Status:** Proposed, not built. Decision record: [ADR 0019](adr/0019-story-state-off-the-code-branch.md).

**Owner, 2026-11-23:**
- "Lets not store all singularity things in the branch, Why cant it be in state branch?"
- "yes mostly for clean PRs"
- "documents will be in the PR and it should be part of the code base. The workflow, .singularity and all can be in
  state"

**Replaces:** [CPR-v1](SPEC-CPR-CLEAN-PULL-REQUESTS-v1.md), which is not to be built alongside it (§9).

**Builds on:**
- [Git branches and stored state](GIT-BRANCH-STORAGE.md);
- [State authority](STATE-AUTHORITY.md);
- ledger publication (`publishBranchWithLedgerEntry` in `src/ledger.mjs`);
- the publication journal (`src/publication-journal.mjs`);
- Story paths (`src/story-paths.mjs`).

---

## 1. Why

Today a Story branch `<WORK-ID>` holds, beside its code:
- `singularity/work-items/<WORK-ID>/**`:
  - `workflow.json`;
  - the documents;
  - approvals, decisions, receipts, reviews, clarifications, context, telemetry and evidence;
- the pinned configuration copy;
- `singularity/configuration-source.json`.

Every approval and decision is a commit on it. So its pull request shows dozens of SFlow files and a commit per step,
CI runs for every decision, and the default branch collects every Story's records after a merge.

## 2. What changes

| | Story branch `<WORK-ID>` | The Story's state ref |
|---|---|---|
| Holds | code, tests, and the Story's documents in `docs/stories/<WORK-ID>/` | everything else SFlow keeps for the Story |
| A commit when | code or a document changes | any step, approval, decision or receipt |
| In the pull request | yes, reviewed and merged | never |
| On disk | the checkout | `.singularity/` inside the checkout, ignored by Git |

## 3. The rules

**SSB:REQ-001, the documents.**
- Each step's document is written to `docs/stories/<WORK-ID>/<step>.md`. A step with several files gets
  `docs/stories/<WORK-ID>/<step>/`.
- This covers:
  - requirements, design and plan;
  - the code step's summary;
  - verification evidence;
  - the release report.
- `stories.documents` in `singularity/workflow.yml` names another folder. A folder the repository already uses for other
  files is refused at configuration time.
- A step's document is replaced in place by its next version. Its earlier versions stay in the branch's history and in
  the review packets.

**SSB:REQ-002, the state ref.** Everything else SFlow keeps for the Story is on one ref of its own:
- `workflow.json`, the lifecycle authority;
- approvals, decisions, receipts, review packets, clarifications, context, telemetry and evidence records;
- the inputs;
- each document's metadata (its sidecar);
- the pinned configuration copy and `configuration-source.json`.

The ref:
- is `refs/singularity/state/<WORK-ID>` by default. That is not a branch, so it shows in no branch list, offers no pull
  request, and starts no CI.
- is the branch `sflow/state/<WORK-ID>` where the repository uses `ledger.pinTransport: branches`, the setting that
  already exists for hosts that refuse SFlow's own refs.
- has no application history.
- is never merged. The host never deletes it on a merge.

**SSB:REQ-003, its tree.**

```text
workflow.json
approvals/ context/ submissions/ …    as in today's singularity/work-items/<WORK-ID>/, without the documents
configuration/                        the pinned copy, at its usual paths
configuration-source.json
```

**SSB:REQ-004, binding.**
- Every state commit names the Story branch commit it is about.
- An approval names:
  - that code commit;
  - the approved document's SHA-256;
  - the code tree's digest.
- A Story branch tip that moved past that commit with a change to code or a document makes the approval stale, by
  today's rule for a change after publication. A commit a person pushed to the Story branch is found the same way.

**SSB:REQ-005, publication is one atomic push.** One `git push --atomic`, under exact leases, moves:
- the Story branch, when its tip moved;
- the Story's state ref;
- the ledger branch;
- the ledger entry's pin.

Nothing lands alone: this is `publishBranchWithLedgerEntry` with one more ref. A host without atomic pushes takes
today's sequential path, in this order:
1. the Story branch;
2. the state ref;
3. the ledger.

The publication journal records every ref's expected and new tip, so recovery finishes or reports an interrupted push.

**SSB:REQ-006, the state checkout.**
- SFlow keeps the state ref checked out at `.singularity/`, a linked worktree inside the Story's checkout. Agents read it
  as workspace files, with no prompt for reading outside the workspace.
- `.singularity/` is listed in `.git/info/exclude`, never in a committed `.gitignore`. So `git status`, `git add -A` and
  the code step's file scope never see it.
- Agents never edit it. The hooks refuse a direct edit to `.singularity/`, as they refuse one to SFlow's records today.
- A missing or damaged state checkout is rebuilt from the ref at the next command. Only unpublished work is lost, as with
  an uncommitted file today.

**SSB:REQ-007, fetching.**
- Opening, resuming, attaching from a second laptop and taking over a Story fetch its state ref along with its branch.
- Listing a repository's Stories reads `refs/singularity/state/*` in one call.

**SSB:REQ-008, retention.**
- The ledger's pin keeps each published code commit alive after a host deletes a merged Story branch, as today.
- State commits are kept by the state ref. Deleting it is not a cache clear, as for the ledger.

**SSB:REQ-009, paths in records.**
- A record names a state file relative to the state root, and a code or document file relative to the repository root.
- One resolver turns either into a file on disk. Nothing else joins a Story's paths.
- Records of a Story on today's layout keep their paths and are read as written.

**SSB:REQ-010, layouts.**
- `story.storage: state-ref | story-branch` in `sflow/config`.
- The layout is chosen when a Story starts and never changes for that Story. Nothing is migrated.
- `state-ref` raises the configuration's minimum SFlow build, so an older build refuses with "update SFlow" instead of
  misreading a Story.
- Both layouts are read for as long as a Story on the old one exists.

**SSB:REQ-011, Epics.** An Epic's records (`singularity/initiatives/<EPIC-ID>/**`) move to
`refs/singularity/state/<EPIC-ID>` by the same rules. An Epic's documents go to `docs/epics/<EPIC-ID>/`. Merge order
reads each Story's `workflow.json` from its state ref.

## 4. What carries over from ADR 0018

| Mechanism | Under SSB |
|---|---|
| Atomic branch, ledger and pin push | One more ref in the same push (REQ-005) |
| Publication journal, outbox and recovery | Record and replay every ref's tips |
| Ledger trust tiers | Unchanged. An entry names the state commit and the code commit |
| `legacy-live` | Unchanged |
| Takeover | Fetches the state ref too (REQ-007) |
| The `minimumBuild` writer fence | Unchanged: it is in `workflow.json`, now on the state ref |
| Ledger-based discovery | Unchanged, plus the one-call listing (REQ-007) |

## 5. Surfaces

- **Agents, skills and prompts:** documents are named by their `docs/stories/…` path and state by its `.singularity/…`
  path, both from the resolver.
- **The code step:** its file scope covers the code checkout only. `docs/stories/<WORK-ID>/` stays each step's own
  document, under today's rule for another step's document. No new question.
- **VS Code:**
  - record views read the state checkout;
  - document links open `docs/stories/…`;
  - the Story list reads the one-call listing.
- **Landing:** the pull request opens from the Story branch, as today, and is already clean. Its body links the
  documents.
- **Status, next steps and `/sf-explain`:** unchanged in words. They read from the resolver.

## 6. Acceptance

- **A1:** A new Story's pull request, and the default branch after its merge, hold only:
  - its code and tests;
  - `docs/stories/<WORK-ID>/**`.

  No `singularity/work-items/**`, pinned copy or `configuration-source.json` is in them.
- **A2:** An approval, a decision or a clarification moves only the state ref. The Story branch gets no commit, and CI
  does not run.
- **A3:** One publication moves the Story branch, its state ref, the ledger and the pin together, or none of them. A push
  killed midway is finished or reported by recovery.
- **A4:** A code commit pushed after an approval makes that approval stale.
- **A5:** A second laptop, a takeover and `resume --fetch` open the Story with its state.
- **A6:** A Story started on today's layout finishes on it, unchanged.
- **A7:** An agent's direct edit to `.singularity/` is refused. `git status` in the checkout never shows it.
- **A8:** The Story fuzzer and the invariant checks walk both layouts. The journeys walk the new one.

## 7. Milestones

Measured on `main@99b0b01f8`:
- 180 `workDir(` calls in 55 files, and 131 `workDirRelative(` calls in 35;
- 138 source files and 492 test files that name `work-items`;
- 7 source files that name `configuration-source.json`.

| Milestone | Scope | Size |
|---|---|---|
| M0 | Probes, §8 | 1 day |
| M1 | The resolver (REQ-009). Every path join goes through it; today's layout behaves the same and its tests pass unchanged | 4 days |
| M2 | The state ref and checkout (REQ-002, 003, 006, 007), created at Story start | 3 days |
| M3 | Publication and recovery (REQ-004, 005, 008); approvals and decisions touch state only | 4 days |
| M4 | Documents in the code base (REQ-001); agents, skills, hooks and the code step's scope | 3 days |
| M5 | VS Code, Copilot hooks, status, landing, discovery; the setting (REQ-010) | 3 days |
| M6 | Epics (REQ-011); fuzzer, invariants and journeys on both layouts; storage and state docs | 3 days |

About four weeks. Every milestone lands on `main` behind `story.storage`, with today's layout unchanged, so `main`
stays shippable throughout.

## 8. Probes before building (M0)

1. GitHub, GitLab and Azure DevOps accept one atomic push of a branch, `refs/singularity/state/*`, the ledger and a pin
   under leases. GitHub Actions does not start for the state ref.
2. **Real VS Code:**
   - a linked worktree at `.singularity/` does not appear as a second repository in Source Control, or SFlow's
     extension hides it;
   - search and the file explorer behave.
3. **Copilot (VS Code, CLI and IntelliJ):** an agent reads `.singularity/` without a prompt, and SFlow's hooks see and
   refuse an edit to it.
4. `git clean -fdx`, `git stash -u` and a branch switch in the code checkout leave the state checkout repairable.

A probe that fails changes the design here before M1 starts.

## 9. Relation to CPR-v1

[CPR-v1](SPEC-CPR-CLEAN-PULL-REQUESTS-v1.md) would build a code-only copy of the branch at landing. With SSB the Story
branch is already that, so CPR is not built.

## 10. Open questions for the owner

1. **The documents' folder.** Default `docs/stories/<WORK-ID>/`.
2. **Which documents.** Default: every step's, including the two SFlow writes from its records (verification evidence
   and the release report). The alternative is to keep those two on the state ref.
3. **A hidden ref or a visible branch.** Default: the hidden ref `refs/singularity/state/<WORK-ID>`, which adds no
   branches and starts no CI. The alternative is a visible branch `sflow/state/<WORK-ID>` for everyone.
4. **When it starts.** Default: every new Story once it ships. The alternative is a repository opting in.
