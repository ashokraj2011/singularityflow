# Clean pull requests (CPR) — v1: a Story's pull request shows only its code

**Specification ID:** `CPR-v1`

**Status:** Superseded by [SSB-v1](SPEC-SSB-STORY-STATE-BRANCH-v1.md) and
[ADR 0019](adr/0019-story-state-off-the-code-branch.md), and not to be built. It is kept as the fallback if SSB is not
built. Owner, 2026-11-23: "Lets not store all singularity things in the branch, Why cant it be in state branch?", then,
asked what drives it: "yes mostly for clean PRs".

**Decision this records:** a code-only pull request, built when the Story lands. Moving lifecycle state off the Story
branch would be ADR 0018's option B, a re-architecture of weeks. That stays the owner's later choice. ADR 0018's
option A stands: the Story branch keeps its records while the work runs.

**Builds on:** [Git branches and stored state](GIT-BRANCH-STORAGE.md), Story landing (`src/story-landing.mjs`), pull
requests (`src/pull-request.mjs`), Epic merge order (`src/initiative-repositories.mjs`).

---

## 1. Why

A Story branch holds the Story's code and, beside it, everything SFlow records:
- `singularity/work-items/<WORK-ID>/**`: the Story's state, documents, approvals, evidence, receipts and reviews;
- the frozen copy of the configuration it started with, and `singularity/configuration-source.json`, which binds it.

Today the pull request opens from that branch. So its diff and its commits carry dozens of SFlow files and a commit
per step, and a reviewer must find the code among them. Once merged, `main` carries every Story's records too.

## 2. What changes

The Story branch stays as it is: SFlow's, holding code and records while the work runs.

When the Story lands (after the person approves its delivered code and SFlow finalizes it), SFlow builds a second
branch from it, **the pull request branch**, and opens the pull request from that one:

| | Story branch `<WORK-ID>` | Pull request branch `pr/<WORK-ID>` |
|---|---|---|
| Holds | code and SFlow's records | the code only |
| Written by | SFlow, at every step | SFlow, at landing, and again when the Story changes after |
| Reviewed in the pull request | no | yes |
| Merged | never | by a person, on the Git host |

## 3. The rules

**CPR:REQ-001, which paths are SFlow's.** A Story's records are:
- `singularity/work-items/**`, covering every Story's, so a Story built on another carries neither;
- `singularity/configuration-source.json`;
- every file of the pinned configuration copy, as `configuration-source.json` lists them.

Nothing else is. A repository's own files under `singularity/` (configuration merged from a governance proposal) are
the application's, and the rule below keeps them as the base has them.

**CPR:REQ-002, the tree.** The pull request branch's last commit has the Story's tree, except that every SFlow path has
the base branch's content: the same file where the base has it, and absent where the base does not. Its diff against
the base therefore shows the Story's code changes and nothing of SFlow, and never deletes a file the base has.

**CPR:REQ-003, the history.** It has one commit per Story commit that changed code, in order, with their authors and
dates. A commit that changed only records is left out. Each commit's message is its step and version in words
("Implementation v2"), followed by `Story: <WORK-ID>`.

**CPR:REQ-004, proof.** The Story records its pull request branch:
- its name;
- its last commit;
- the digest of its code tree, equal to the Story's own code tree with SFlow's paths left out.

A pull request branch whose code differs from the approved code is never opened. The landing refuses with the
difference and its route.

**CPR:REQ-005, the pull request body.** As today: lineage, the lifecycle status, and the evidence receipt and matrix.
It also says where the records are: "SFlow's records for this Story are on branch `<WORK-ID>` (not part of this
change)".

**CPR:REQ-006, after a change.** When the Story changes after its pull request opened (a returned step, a reopen), the
next landing builds the pull request branch again. It pushes with a lease on the commit it last pushed, so a commit a
person added to the pull request branch by hand is never overwritten: that is refused, with its route. The Story
branch is never rewritten.

**CPR:REQ-007, Epics.** A Story counts as merged into its Epic branch when the code of its pull request branch has
landed there: by merge, squash or rebase, as today's check counts landings. The check reads the pull request branch the
Story recorded, then the Story branch for a Story landed before CPR.

**CPR:REQ-008, retention.** Nothing changes for records:
- The Story branch keeps them.
- The ledger's commit anchors keep its commits after a host deletes the branch.
- A merged pull request branch is the host's to delete.

**CPR:REQ-009, the setting.** `git.pullRequest: code-only | story-branch` in `singularity/workflow.yml`. The default is
`code-only`, which takes effect on the next Story that lands. `story-branch` keeps today's behaviour. `direct` (no pull
request) is unchanged.

## 4. Surfaces

- **Landing** (`landAfterLastApproval`) and `singularity-flow pr <WORK-ID>` build the pull request branch, then open the
  pull request from it. The preview says which branch it is and how many SFlow files it leaves out.
- **VS Code** shows the pull request branch's link where it shows the pull request today.
- **Status and next steps** name the pull request branch when one exists.

## 5. Acceptance

- **A1:** A closed Story's pull request diff against its base holds only its code and tests. No `singularity/work-items/**`
  path, no pinned copy and no `configuration-source.json` is in it, and every repository `singularity/` file is as the
  base has it.
- **A2:** Its commits are the code-changing commits, in order, with their authors. Record-only commits are absent.
- **A3:** Its code tree digest equals the Story's with SFlow's paths left out. A pull request branch edited to differ is
  refused at landing.
- **A4:** A Story built on another Story carries neither Story's records.
- **A5:** After a returned step, landing again rebuilds the pull request branch with a lease. A commit a person pushed
  to it is never overwritten.
- **A6:** An Epic's merge order counts a Story merged when its pull request branch landed by merge, squash or rebase.
- **A7:** `git.pullRequest: story-branch` behaves exactly as today.
- **A8:** The Story fuzzer walks a Story to its landing and checks A1 and A3 each time.

## 6. Milestones

| Milestone | Scope | Size |
|---|---|---|
| M1 | Pull request branch builder (REQ-001 to 004), landing and `pr`, the body line, the setting | about 1 day |
| M2 | After a change (REQ-006), Epics (REQ-007), status and VS Code | about 1 day |

## 7. Open questions for the owner

1. **The branch name.** Default `pr/<WORK-ID>`. A team that names branches after its tickets might prefer `<WORK-ID>`
   for the pull request branch, with the Story branch renamed `sflow/story/<WORK-ID>`. That is a bigger change, so the
   default is `pr/<WORK-ID>`.
2. **The history.** Default: the code-changing commits, as REQ-003. The alternative is one commit for the whole
   Story, which is cleaner but loses each version's context. A team can squash at merge either way.
3. **Existing repositories.** Default: `code-only` from the next landing. The alternative is to keep `story-branch`
   until a repository opts in.
