# Story state branch (SSB) — v1: a Story's code branch holds code and documents; SFlow's records live beside it

**Specification ID:** `SSB-v1`

**Status:** Open questions decided by the owner on 2026-11-26 (§10). M0's local probes ran on 2026-11-26 (§11); the
real-host and real-app probes are still to run. M1 (the resolver, [SSB-M1-PLAN](plans/SSB-M1-PLAN.md)) is on main. M2
(the state ref and its checkout, created at Story start) is built on branch `ssb-m2` (2026-11-26), behind
`story.storage`, with today's layout unchanged (§12). M3 to M6 are not built. On the roadmap as
[`SSB-001`](PENDING-WORK-ROADMAP.md#story-storage-off-the-code-branch-ssb). Decision record:
[ADR 0019](adr/0019-story-state-off-the-code-branch.md).

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
| On disk | the checkout | `.sflow-state/` inside the checkout, ignored by Git |

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
configuration/                        the pinned copy, at its usual paths, with its pin
                                      (configuration/singularity/configuration-source.json; M2, §12)
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
- SFlow keeps the state ref checked out at `.sflow-state/`, a linked worktree inside the Story's checkout. Agents read it
  as workspace files, with no prompt for reading outside the workspace.
- `.sflow-state/` is listed in `.git/info/exclude`, never in a committed `.gitignore`. So `git status`, `git add -A` and
  the code step's file scope never see it.
- Agents never edit it. The hooks refuse a direct edit to `.sflow-state/`, as they refuse one to SFlow's records today.
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

- **Agents, skills and prompts:** documents are named by their `docs/stories/…` path and state by its `.sflow-state/…`
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
- **A7:** An agent's direct edit to `.sflow-state/` is refused. `git status` in the checkout never shows it.
- **A8:** The Story fuzzer and the invariant checks walk both layouts. The journeys walk the new one.

## 7. Milestones

Measured again on `5ac41f37e` (2026-11-26). The first count, on `main@99b0b01f8`, is in brackets:
- 180 `workDir(` calls in 55 files [180 in 55], and 138 `workDirRelative(` calls in 39 [131 in 35];
- 141 source files and 509 test files that name `work-items` [138 and 492];
- 7 source files that name `configuration-source.json` [7]. 10 more use its constant `CONFIGURATION_SOURCE_PATH`.

The first count missed these. Each one joins a Story's path without either helper:
- 164 inline `workItemRoot ?? 'singularity/work-items'` joins in 110 files;
- 16 joins on a bare `.workItemRoot`;
- 98 path patterns that spell `singularity\/work-items`, 93 of them in `schema-migrations.mjs`;
- 26 uses of `work-item-location.mjs`'s helpers, 7 `workflowPath(` calls and 6 `clarificationRecordRelative(` calls;
- 5 files in the VS Code extension and 2 in the plugin.

In all, 242 files name a Story's or an Epic's paths. The plan's appendix lists them by module.

| Milestone | Scope | Size |
|---|---|---|
| M0 | Probes, §8 | 1 day |
| M1 | The resolver (REQ-009). Every path join goes through it; today's layout behaves the same and its tests pass unchanged. Plan: [SSB-M1-PLAN](plans/SSB-M1-PLAN.md) | 6 days (was 4: the joins above) |
| M2 | The state ref and checkout (REQ-002, 003, 006, 007), created at Story start. Built on `ssb-m2` (§12) | 3 days |
| M3 | Publication and recovery (REQ-004, 005, 008); approvals and decisions touch state only | 4 days |
| M4 | Documents in the code base (REQ-001); agents, skills, hooks and the code step's scope | 3 days |
| M5 | VS Code, Copilot hooks, status, landing, discovery; the setting (REQ-010) | 3 days |
| M6 | Epics (REQ-011); fuzzer, invariants and journeys on both layouts; storage and state docs | 3 days |

About four and a half weeks, with M1 at 6 days. Every milestone lands on `main` behind `story.storage`, with today's
layout unchanged, so `main` stays shippable throughout.

## 8. Probes before building (M0)

1. GitHub, GitLab and Azure DevOps accept one atomic push of a branch, `refs/singularity/state/*`, the ledger and a pin
   under leases. GitHub Actions does not start for the state ref.
2. **Real VS Code:**
   - a linked worktree at `.sflow-state/` does not appear as a second repository in Source Control, or SFlow's
     extension hides it;
   - search and the file explorer behave.
3. **Copilot (VS Code, CLI and IntelliJ):** an agent reads `.sflow-state/` without a prompt, and SFlow's hooks see and
   refuse an edit to it.
4. `git clean -fdx`, `git stash -u` and a branch switch in the code checkout leave the state checkout repairable.

A probe that fails changes the design here before M1 starts. Results so far: §11.

## 9. Relation to CPR-v1

[CPR-v1](SPEC-CPR-CLEAN-PULL-REQUESTS-v1.md) would build a code-only copy of the branch at landing. With SSB the Story
branch is already that, so CPR is not built.

## 10. Decided 2026-11-26

The owner answered the four open questions on 2026-11-26:

1. **The documents' folder:** `docs/stories/<WORK-ID>/` (REQ-001).
2. **Which documents:** every step's, including the two SFlow writes from its records: verification evidence and the
   release report (REQ-001). Neither stays on the state ref.
3. **The records:** the hidden ref `refs/singularity/state/<WORK-ID>` (REQ-002). It shows in no branch list and starts
   no CI. A visible branch for everyone is not taken. The branch `sflow/state/<WORK-ID>` stays only where
   `ledger.pinTransport: branches` is set, as REQ-002 says.
4. **When it starts:** every new Story once it ships. Stories in flight finish in today's layout (REQ-010, A6). So
   `story.storage` defaults to `state-ref` from the release that ships SSB. Until then it defaults to `story-branch`,
   which is what keeps `main` shippable during the build (§7).

## 11. Probe results

Run on 2026-11-26 with Git 2.54.0 on macOS, against local repositories (a bare remote over `file://`). The probe
scripts stay outside the repository. The commands that matter are below.

| Probe | Result |
|---|---|
| 1. One atomic push | **Passed locally.** GitHub, GitLab, Azure DevOps and the CI check still need real hosts (11.1) |
| 2. Real VS Code | **To run** by the coordinator (11.3) |
| 3. Copilot on VS Code, CLI and IntelliJ | **To run** by the coordinator (11.4). Code reading found a gap the probe will confirm |
| 4. The state checkout survives `git clean`, `git stash` and a branch switch | **Passed** for a linked worktree, with design changes (11.2) |

### 11.1 Probe 1: one atomic push

One `git push --atomic --porcelain` moved the Story branch, `refs/singularity/state/<ID>`, the ledger branch and a pin,
each under `--force-with-lease`. This is the form `publishBranchWithLedgerEntry` uses today.

| Case | What happened |
|---|---|
| First publication: all four refs created, each with a create-only lease (`--force-with-lease=<ref>:`) | All four landed together. Each reported `*`, the flag today's landed check reads |
| Second publication: every ref fast-forwarded under its exact lease | Landed. Each reported a space (fast-forward) |
| A teammate moved the state ref first, so only its lease is stale | Nothing moved. The state ref reported `! [rejected] (stale info)`, the others `! [rejected] (atomic push failed)` |
| A host hook refuses `refs/singularity/state/*` | Nothing moved. The hook's text names the ref, which is what today's fallback for a refused own ref looks for |
| An approval: the state ref and the ledger, no branch | Landed. The Story branch was not among the pushed refs, so a CI trigger on branches would not see it |
| `ledger.pinTransport: branches`: `refs/heads/sflow/state/<ID>` and a branch pin | Landed atomically |
| Listing: `git ls-remote <remote> 'refs/singularity/state/*'` | One call listed every Story's state ref |
| A plain clone | Fetched no `refs/singularity/*`. An explicit refspec fetched one Story's state. No branch list showed it |
| The Story branch deleted after a merge, then `git gc --prune=now` on the host | The state ref kept all its history, and pinned code commits survived. A code commit named only inside a state record was collected |
| A ref named at the value the host already has, such as an unchanged Story branch | Reported `=` (up to date), and its lease was not checked |

What it changes:
- **M3:** the push leaves the Story branch out when its tip did not move. Today's check accepts only a space or `+`
  for the branch, so an unchanged branch named in the push would read as not landed.
- **REQ-004 and REQ-008:** a state record binds only a code commit the ledger pins. A pin is added in the same push when
  a commit isn't pinned yet, such as one a person pushed before an approval. The state ref keeps no code commit alive:
  Git does not follow a commit ID written inside a file, and the ref has no application history by design.
- **REQ-007 (M2):** a fetched state ref lands in a tracking ref of its own (the probe used
  `refs/singularity/remotes/<remote>/state/<ID>`). A fetch then never overwrites local state commits that are not
  published yet. Every fetch names the refspec, since a clone or a plain fetch brings none.

**Still needs real hosts.** Use a throwaway repository on each host, with any content and one CI workflow that runs on
every push (GitHub Actions `on: push` with no filter; a GitLab pipeline; an Azure Pipelines trigger on all branches).
From a clone of it, in bash or zsh (the braces keep zsh from reading `$x:r` as a modifier):

```bash
R=origin; ID=SSB-PROBE-1; P=refs/singularity/pins/ssb-probe/e1; L=refs/heads/ssb-probe-ledger
base=$(git rev-parse HEAD)
code=$(git commit-tree "$(git rev-parse HEAD^{tree})" -p "$base" -m 'probe code 1')
state=$(git commit-tree "$(git mktree </dev/null)" -m 'probe state 1')
ledger=$(git commit-tree "$(git mktree </dev/null)" -m 'probe ledger 1')
# 1. One atomic push of four refs, create-only leases. Expect four lines starting with '*', then 'Done'.
git push --atomic --porcelain --force-with-lease="refs/heads/${ID}:" --force-with-lease="refs/singularity/state/${ID}:" \
  --force-with-lease="${L}:" --force-with-lease="${P}:" \
  "$R" "${code}:refs/heads/${ID}" "${state}:refs/singularity/state/${ID}" "${ledger}:${L}" "${code}:${P}"
# 2. Move only the state ref. Expect no CI run for this push (check the host's Actions/Pipelines page).
state2=$(git commit-tree "$(git mktree </dev/null)" -p "$state" -m 'probe state 2')
git push --porcelain --force-with-lease="refs/singularity/state/${ID}:${state}" "$R" "${state2}:refs/singularity/state/${ID}"
# 3. A stale lease. Expect '(stale info)' on the state ref, '(atomic push failed)' on the ledger, nothing moved.
state3=$(git commit-tree "$(git mktree </dev/null)" -p "$state" -m 'probe state 3')
ledger2=$(git commit-tree "$(git mktree </dev/null)" -p "$ledger" -m 'probe ledger 2')
git push --atomic --porcelain --force-with-lease="refs/singularity/state/${ID}:${state}" --force-with-lease="${L}:${ledger}" \
  "$R" "${state3}:refs/singularity/state/${ID}" "${ledger2}:${L}"
git ls-remote "$R" 'refs/singularity/*' "$L"
```

Then open a pull request from `SSB-PROBE-1`, merge it with the branch deleted, and run `git ls-remote` again: the state
ref and the pin must still be there. Clean up with
`git push "$R" ":refs/singularity/state/${ID}" ":${P}" ":${L}"`. Record for each host:
- whether the push in step 1 is accepted at all. If a host refuses `refs/singularity/*` (Azure DevOps is the one to
  watch), the repository uses `ledger.pinTransport: branches` and the state ref becomes `sflow/state/<ID>`. That is a
  branch, so the host's CI sees it, and the docs must then tell teams to exclude `sflow/state/**` from CI triggers;
- the porcelain lines of steps 1 and 3;
- whether any CI run, pipeline or webhook push event started for step 2.

### 11.2 Probe 4: the state checkout survives everyday Git commands

Three ways of keeping the state at `.singularity/` were tried, with `/.singularity/` in the clone's common
`.git/info/exclude`. Each was tried with the code checkout as the clone's main work tree and as a linked Story
worktree. Both kinds of checkout behaved the same.
- **Linked:** a linked worktree of the same repository, from
  `git worktree add --detach .singularity refs/singularity/state/<ID>`;
- **Gitfile:** a separate repository whose Git directory is under `.git/`, with `.singularity/.git` a file pointing to
  it;
- **Bare work tree:** a Git directory under `.git/` and no `.git` marker inside `.singularity/`.

| Command in the code checkout | Linked | Gitfile | Bare work tree |
|---|---|---|---|
| `git status`, `git add -A` | Clean, nothing staged | Same | Same |
| `git clean -fdx` | Kept: Git skips a nested repository | Kept | **Deleted** |
| `git clean -ffdx` (forced twice) | Deleted | Deleted | Deleted |
| `git stash -u` | Kept, nothing stashed | Kept | Kept |
| `git stash -a` | Kept ("Ignoring path .singularity/") | Kept | **The state files went into the stash** and left the disk until `stash pop` |
| A branch switch, `git reset --hard`, `git checkout -- .` | Kept | Kept | Kept |
| A switch to a branch that tracks files under `.singularity/` | **Overwritten:** Git wrote the branch's files into the state checkout with exit 0. A tracked file at a state file's path replaced it, and switching back deleted it | Same | Same |

Without the exclude line, `git status` shows `?? .singularity/`, and `git add -A` stages it as an embedded repository
(a gitlink, mode 160000). A commit would then put a pointer to the state into the code branch.

Repair of the linked worktree:
- **Folder deleted** (by `git clean -ffdx` or by hand): `git worktree add` refuses ("a missing but already registered
  worktree"). `git worktree prune`, then the same `git worktree add`, rebuilds it. A record survives when it was
  committed and the commit was put on `refs/singularity/state/<ID>`. An uncommitted file is lost, and so is a commit
  left only on the checkout's detached HEAD, which the next `git gc` collects.
- **Overwritten by a branch switch:** `git -C .singularity checkout -- .` restores every committed record.
- **Checkout moved:** both worktree links break. `git worktree repair <checkout> <checkout>/.singularity` fixes them.
  `worktree.useRelativePaths=true` survives a move without repair, but it sets `extensions.relativeWorktrees` and
  repository format 1, which Git before 2.48 refuses to open. So it is not used.
- **Story checkout removed:** `git worktree remove <Story checkout>`, without `--force`, removed the checkout and the
  state checkout inside it, uncommitted state included, and left a stale entry for `git worktree prune`.
- A HEAD that names `refs/singularity/state/<ID>` (not detached) moves the ref on every commit, but
  `git branch --show-current` then fails ("HEAD not found below refs/heads"). Tools would stumble, so it is not used.

What it changes (REQ-006, M2 unless named):
1. The state checkout is a linked worktree. The bare work tree is ruled out by `git clean -fdx` and `git stash -a`. The
   gitfile layout survives as well, but needs a fetch between the two repositories. Keep it as the fallback if probe 2
   finds that VS Code lists the linked worktree and the gitfile hides better. Both have a `.git` file, so that is
   unlikely.
2. The checkout stays on a detached HEAD, and every state commit moves `refs/singularity/state/<ID>` at once, under
   its expected value (`git update-ref <ref> <new> <old>`). Nothing lives only on the detached HEAD.
3. The exclude line carries weight. SFlow writes it before it creates the checkout, as `excludeAgentOutput` does for
   `.sflow/out`, and every command checks it. The code step's commit refuses a staged gitlink at the state folder.
4. **The folder's name.** `.singularity/` is SFlow's retired control root, and four things treat it so:
   - `refuseRetiredControlRoot` (`config.mjs`) refuses a checkout that holds `.singularity/` without `singularity/`. A
     state-ref Story checkout is exactly that, since application branches do not carry `singularity/`
     (`configuration-read-scope.mjs`);
   - `factory-reset` backs up and replaces `.singularity/`, the fresh-install reset lists it as installer-generated, and
     `DEFAULT_RUNTIME_ROOTS` reserves it;
   - VS Code's runner looks there for legacy configuration;
   - an old branch from a repository's `.singularity/` days tracks files there, and Git writes them into the state
     checkout on a switch (the table above).

   **Decided (owner, 2026-11-26):** the state checkout is `.sflow-state/`, a folder SFlow never used, so none of the
   four places above meets it. M1 holds the name in one constant (`STATE_CHECKOUT`). Probe 4 above ran at
   `.singularity/`; nothing it found depends on the name.
5. Removing a Story checkout (`story-worktree.mjs`, `workspace-retention.mjs`, `workspace-relink.mjs` and the other
   `git worktree remove` callers) removes its state checkout first. It refuses while the state checkout holds
   uncommitted records.
6. The checks that list ignored files skip the state checkout, as they skip `.sflow/out` (`withoutAgentOutputStatus`).
   They are in `git-query.mjs`, `workspace.mjs`, `workspace-retention.mjs`, `story-worktree.mjs`, `git.mjs`,
   `copilot-mutation-guard.mjs`, `factory-reset.mjs` and `fresh-install-reset.mjs`.
7. **M4, the edit guard:** today `.sflow-state/` counts as an application path (`isApplicationPath`: it is in no
   governed root). So a code step's agent may edit it, and any other step refuses it only as an application edit. M4
   adds the state folder to the governed roots, so the guard refuses it as SFlow's own state (A7).

Found while planning M1, not by a probe: a state-ref Story's pinned configuration, at `.sflow-state/configuration/`,
can be served through the configuration overlay that already exists (`withConfigurationReadRoot` in
`configuration-read-scope.mjs`). The 177 `loadDefinition(root)` calls then do not change (the M1 plan, §6).

### 11.3 Probe 2: real VS Code (for the coordinator)

This opens a VS Code window. Build the fixture from a terminal first. It needs no SFlow Story:

```bash
P="$HOME/ssb-probe"; rm -rf "$P"; mkdir -p "$P"; cd "$P"
git init -q -b main app && cd app
printf 'probe app\n' > README.md && git add README.md && git commit -qm base
git switch -qc WRK-1 && printf 'code\n' > code.txt && git add code.txt && git commit -qm code
idx="$P/state.index"; rm -f "$idx"
add() { GIT_INDEX_FILE="$idx" git update-index --add --cacheinfo "100644,$(printf '%s' "$2" | git hash-object -w --stdin),$1"; }
add workflow.json '{"workItem":{"id":"WRK-1"}}'
add approvals/a.json '{"marker":"ssbprobe-needle-7731"}'
add context/notes.md 'ssbprobe-needle-7731 in a state note'
git update-ref refs/singularity/state/WRK-1 "$(git commit-tree "$(GIT_INDEX_FILE="$idx" git write-tree)" -m 'WRK-1 state')"
rm -f "$idx"
printf '/.sflow-state/\n' >> "$(git rev-parse --git-common-dir)/info/exclude"
git worktree add -q --detach .sflow-state refs/singularity/state/WRK-1
git status --porcelain    # must print nothing
```

Then, in VS Code as installed, with SFlow's extension as installed:
1. Run `code --version` and note it. Open the folder: `code "$HOME/ssb-probe/app"`.
2. **Source Control:** open the Source Control Repositories view. Passes when only `app` is listed. Note whether
   `.sflow-state` shows as a second repository or under a worktrees entry.
3. If it shows, add `"git.ignoredRepositories": ["<the absolute path of app/.sflow-state>"]` to `app/.vscode/settings.json`
   and reload the window. Note whether that hides it. If not, try `"git.repositoryScanIgnoredFolders": [".sflow-state"]`
   instead. The setting that works is the one SFlow's extension would write.
4. **Explorer:** note whether `.sflow-state/` is listed (greyed as ignored). Open `.sflow-state/approvals/a.json` and note
   whether the status bar's branch changes to a detached HEAD.
5. **Search:** search for `ssbprobe-needle-7731` (Ctrl+Shift+F). The expected result is no match, because search honours
   ignore files. Turn off "Use Exclude Settings and Ignore Files" and search again: both state files should be found.
   In Quick Open (Ctrl+P), type `notes.md` and note whether it is offered.
6. **A commit:** edit `code.txt` and note that Source Control offers only `code.txt`. Commit it, then run
   `git -C "$HOME/ssb-probe/app" show --stat HEAD`: it must name no `.sflow-state` path.
7. Close the window. If step 2 listed `.sflow-state`, repeat steps 2–6 with the gitfile layout: run
   `git worktree remove --force .sflow-state`, then
   `git init -q --separate-git-dir="$(git rev-parse --git-common-dir)/singularity-flow/state/WRK-1" .sflow-state`
   (create the parent folder first), fetch `refs/singularity/state/WRK-1` into it and check it out detached.

### 11.4 Probe 3: Copilot on VS Code, the CLI and IntelliJ (for the coordinator)

This opens VS Code and IntelliJ windows, and spends a few premium requests.

**Reads, in the probe 2 fixture:** start each host's agent in `$HOME/ssb-probe/app`: Copilot Chat in agent mode in
VS Code, `copilot` in a terminal there, and Copilot Chat in agent mode in IntelliJ. Ask each:
"Read .sflow-state/approvals/a.json and tell me the marker." It passes when the agent answers `ssbprobe-needle-7731` with
no prompt about reading outside the workspace. Note whether the agent had to be given the path, or found the file with
its own search.

**Edits, in a throwaway SFlow repository with a Story open,** such as the daily-run fixture:
1. Make the state checkout for that Story's ID the same way, with the same exclude line.
2. In a step other than the code step, ask each host's agent: "Add a line to .sflow-state/approvals/a.json". Then ask it
   to run `echo x >> .sflow-state/approvals/a.json` in its terminal.
3. Repeat both in the code step.
4. For each host and each request, record: whether SFlow's hook saw the edit (its refusal, or the hook log), whether the
   edit was refused, and the reason shown.

Expected on today's build: outside the code step the edit is refused as an application edit. In the code step it is
allowed, because the guard counts `.sflow-state/` as application code (11.2, item 7). That allowed edit is the gap M4
closes, not a probe failure. A failure is a host whose hook never sees the edit or the shell write. On IntelliJ, also
note whether SFlow's hooks run at all: the Local agent ran none on 2026-11-23.

## 12. M2 as built (branch `ssb-m2`, 2026-11-26)

Built from `main@2809f6edc`. Everything is behind `story.storage`; without it, Story start and every read are as
before, and today's tests pass unchanged.

### What a state-ref Story does now

- **The setting.** `story.storage: story-branch | state-ref` in `singularity/workflow.yml`, checked when the
  configuration loads and in the definition schema. Absent is `story-branch` (decision 4). Its description says
  `state-ref` is being built. The build fence that makes an older SFlow refuse it is M5 (REQ-010).
- **Story start** (REQ-002, 003, 006). When the approved configuration says `state-ref`, Story start writes the exclude
  line, then creates `refs/singularity/state/<ID>` (one empty-tree root commit, create-only), then adds `.sflow-state/`
  as a detached linked worktree. All three come right after the Story branch is checked out, so every record lands in
  the state checkout. The start's records are committed on the state ref, under its expected value. The Story branch
  stays at its base: no SFlow file, no SFlow commit.
- **The pinned copy.** A pin from `sflow/config` moves into `configuration/` in the state, at its usual paths. Tracked
  files it replaced in the code checkout come back from the branch.
- **A refused start** removes the state checkout and the ref, as it removes the branch (the start journal records the
  ref). A start that crashed after its state commit is finished, not undone.
- **The layout is recorded** in `resolution.story.storage`, once, for the Story's life (REQ-010).
- **Transitions.** A state-ref Story's `commitAndPublish` goes to a state-ref lifecycle authority. It writes the records
  in the state checkout, commits there, and moves the ref under its expected value. A refusal rolls back through the
  transition's own preimage of `.sflow-state/`. Nothing is pushed: publication is M3.
- **Reading.** The Story index finds `.sflow-state/workflow.json` with no definition, since the folder's name is fixed.
  Finding it, or creating it, tells the resolver the Story's layout for the process, by checkout and Story (the M1
  plan's §4, step 3). A workflow's own `resolution.story.storage` always wins.
- **Every command** in a clone that keeps a state-ref Story makes the state checkout right for the checkout's Story
  branch at entry: made again, links repaired, a foreign folder set aside, moved to its ref when clean. A clone with a
  state-ref Story is known from files only: the folder, or the exclude line SFlow writes before the first checkout.
  Others pay one stat and one small file read. The pinned configuration is read from the state checkout for the command.
  A checkout with uncommitted records is never moved; a read that finds no Story tries the same once before it refuses.
- **Fetching** (REQ-007). `resume --fetch`, opening a local session and re-starting an existing Story fetch the state
  ref with an explicit refspec into `refs/singularity/remotes/<remote>/state/<ID>`. The local ref is then created, or
  fast-forwarded, only when nothing local is lost: a local ref ahead stays, and a diverged one is reported. Each is
  asked only when the branches name no Story, or a state checkout is already there, so a Story on today's layout pays
  nothing. Listing every Story's state is one `git ls-remote` (or a local `for-each-ref`).
- **Git's own checks** (§11.2 items 3, 5, 6). The checks that list ignored files skip `.sflow-state/`. Removing a Story
  checkout removes its state checkout first, and keeps both while it holds records not saved on the ref (launch
  cleanup, rollback, retention). The code step's preflight refuses `.sflow-state` staged or committed as a gitlink, with
  the `git rm --cached` command that takes it out.
- **`ledger.pinTransport: branches`** makes the state ref the branch `sflow/state/<ID>`.

### Design changes found while building

1. **`resolution.story.storage`, not `resolution.storage.layout`.** `resolution.storage` already holds a Story's
   document storage providers (SharePoint, S3 and so on), so the M1 resolver's field moved.
2. **The pin stays inside the pinned copy**, at `configuration/singularity/configuration-source.json`, not at the state
   root as REQ-003's first tree had it. Every reader of a pinned copy then finds it at its usual path through the
   configuration overlay.
3. **`recordsRoot`.** A record's spelling is relative to the Story's records: the checkout for `story-branch`
   (`<Stories folder>/<ID>/…`), the state checkout for `state-ref` (REQ-009). Files are `recordsRoot` joined with the
   spelling, and Git reads a record's history there: the state checkout's HEAD is the state ref. One rule converts a
   site without changing `story-branch`: `prefix` becomes `record()`, and `root` becomes `recordsRoot` where it is
   joined with a record or used for its history.
4. **A state-ref Story's `prefix` refuses, loudly** (`STORY_STATE_REF_PATH_UNAVAILABLE`), instead of `null`, which
   template strings turned into a `null/` folder in the code checkout. `branchPrefix` asks first. Every site not yet
   moved to `recordsRoot` therefore stops a state-ref Story with a refusal rather than writing in the wrong place. M2
   moved the sites Story start reaches: the workflow snapshot (capture, draft, verification, the creation record), the
   policy anchor, the first work interval and the first step's inputs.

### Probes 2 and 3 not run: the safe defaults taken

- The state checkout is a linked worktree (probe 4's choice). Whether VS Code lists it as a second repository, and the
  setting that hides it (`git.ignoredRepositories`), wait for probe 2 and M5.
- The edit guard still counts `.sflow-state/` as an application path (§11.2 item 7). Refusing an agent's edit there is
  M4, after probe 3. The exclude line keeps it out of `git status`, `git add -A` and the code step's commit today (A7's
  second half).

### Left for M3 and later

- **M3:** publication of the state ref with the branch, the ledger and the pin in one atomic push (REQ-005), and its
  recovery; approvals, decisions and clarifications on a state-ref Story (the sites past Story start still refuse with
  `STORY_STATE_REF_PATH_UNAVAILABLE`: 126 `prefix` uses in 60 files, and the five state readers with no Story in scope,
  M1 plan §9 B12); retention and the workspace drop checking unpublished state commits; WMR REQ-022 (lessons on the
  state ref).
- **M4:** documents in `docs/stories/<ID>/` (M2 keeps a state-ref Story's step documents in its state checkout); the
  edit guard; WMR REQ-020 and REQ-021.
- **M5:** discovery from `refs/singularity/state/*` (session discovery and takeover find a state-ref Story only by its
  ID today), the VS Code views, the build fence for the setting.
- **M6:** the fuzzer, invariants and journeys on both layouts (A8).
- The four precedence orders of the Stories folder (M1 plan §2): compose now passes the workflow first (WMR REQ-023);
  the other orders stay as they were.

### Tests

- `test/story-state-ref.test.mjs` (10): the ref and checkout on real clones (exclude first, no application history,
  leased commits, repairs after delete, move and a foreign folder, removal refused while unsaved, fetch into a tracking
  ref with the local ref kept when ahead, one-call listing, branches transport, ignored listings, the gitlink refusal).
- `test/story-state-ref-start.test.mjs` (7): Story start on both layouts and with `sflow/config`, a refused start
  leaving nothing, a second clone's `resume --fetch`, a deleted checkout made again at the next command, and the
  setting's checks.
- `test/story-paths-resolver.test.mjs`: the recorded field, the remembered layout, `recordsRoot` and the refusing
  `prefix`.
