# SPEC-SCF v1 — Simple configuration

**Product:** Singularity Flow
**Date:** 15 November 2026
**Status:** Approved by the owner on 15 November 2026 ("approve"), with every recommendation in section 7. Stage 1 is built (branch scf1, 15 November 2026); stages 2 to 5 are not. The owner decision of 16 November 2026 (D10, section 7) supersedes SCF:REQ-014's review-only rule for upgrades and pulls stage 4's history-ref removal into the upgrade (branch upgrade-direct). Stage 1e was extended to fresh-install and local-reset the same day (D11). Stage 5 is built (branch workspace-repair, 16 November 2026); building it found that D2's Git 2.29 is not enough for its main case (see D2).
**Namespace:** SCF. No other document uses it.
**Source baseline:** main bd90bcc46. File references are to that commit.
**Inputs:** the four analyses of 2026-11-15 (workspaces, upgrades, editing and review, configuration history).
They number 43 findings, 37 reproduced; the upgrade analysis's F11 holds three small items, so Appendix A has 45.
**Companions:** [SPEC-OAP](SPEC-OAP-ONE-APPROVAL-PATH-v1.md), [SPEC-PSS](SPEC-PSS-v1-PRESENCE-SIGNED-STEPS.md),
[SPEC-PHR](SPEC-PHR-PHASE-RESPONSIBILITY-v1.md), [SPEC-CIC](SPEC-CIC-CHANGE-IMPACT-CONE-v1.1.md) (its D3 rule:
records are additive, nothing is rewritten)
**Normative language:** MUST, MUST NOT, SHOULD and MAY express requirements.

## 1. The owner's request

The owner accepted every recommendation of the four analyses, then said:

> "yes and i want to make these things really simple"

## 2. The model

Six rules.

1. **One source of truth.** `sflow/config` decides what new work uses. A running Story uses only its own pinned
   copy (`singularity/configuration-source.json` and the files it copied). The `state` branch's copy of the
   configuration, the `sflow/config-history/*` refs and an application checkout's `singularity/` files never
   decide anything.
2. **One way in.** SFlow changes `sflow/config` only by approving a proposal, for every kind of change: workflows,
   capabilities, people and approvers, package upgrades. Approval lands exactly what the approver was shown. If
   `sflow/config` moved meanwhile, SFlow re-applies the proposal's field edits on top and asks only about a field
   both sides changed: pick one of the two values. Self-approval is recorded and shown, and a repository can
   require a second person.
3. **History is Git's own.** What a Story started from is its pin plus `sflow/config`'s commit history, which
   SFlow only ever moves forward. There are no history branches, archive tags or cleanup.
4. **Upgrades are one click.** A build publishes its packaged changes straight to `sflow/config` when it is
   installed or its one VS Code action runs (D10, superseding "upgrades are proposals"). A build older than the one
   that last upgraded a repository is told to upgrade; it never publishes over it.
5. **One identity.** A person is their Git name and email, plus their GitHub login when signed in, resolved for
   whoever runs the command. A repository is its canonical repository key. Every configuration commit says who
   proposed it and who approved it.
6. **A workspace is a folder you can move.** Story checkouts live inside it, never in SFlow's state folder. After a
   move, one command (`workspace repair`) puts the links right. VS Code's background upkeep changes nothing a Story
   or a Copilot turn depends on.

### 2.1 Where the first draft of the model was wrong

| The draft said | The code shows | So the model says |
|---|---|---|
| Relative worktree links (`git worktree --relative-paths`) | They switch on `extensions.relativeWorktrees`, and Git older than 2.48, or another Git implementation that does not know the extension, then refuses the whole repository (git-config(1)). SFlow supports Git 2.25 (`src/workspace-bootstrap.mjs:822-834`). | Keep absolute links; `workspace repair` re-links them (D2) |
| Move Story worktrees into the workspace | Inside a workspace they already are (`src/story-worktree.mjs:164-170`). Only a clone outside any workspace puts them in `<parent>/.singularity-flow`, which is the state folder when the parent is the home folder (`:172-177`). | Find a place for that one case (D3) |
| History refs can go because Stories carry their own copy | No Story reads them. They exist to prove the `state` copy (`src/configuration-branch.mjs:420-426`) and to anchor proposal-branch cleanup (`src/configuration-proposal-cleanup.mjs:84-88`). | They go with the `state` copy |
| An unbounded commits-only fetch replaces the 128 window | 128 is also a limit of the proof record that every build checks again when it reads a Story (`src/skp-amendment-audit.mjs:16,56-58`; `src/workflow-snapshots.mjs:593,630,795`). Today's builds would refuse a longer proof. | The unbounded fetch, plus a new proof version (SCF:REQ-020) |
| Every configuration record has `proposedBy` and `approvedBy` | Every build checks `singularity/configuration-transactions.json` field by field, and only for workflow proposal branches (`src/configuration-state-contract.mjs:12,34-39,73`). A new field or kind there stops every older build's approvals. | The approval commit records it: author, committer and trailers. The receipt file is unchanged |
| A stamped, ordered build id | `builtAt` is already the source commit's time for a clean build, but the wall clock for a dirty one (`scripts/reproducible-build.mjs:194-201`). The package baseline records only a commit or `version-0.9.0` (`src/workspace-configuration-refresh.mjs:1136-1139`). `product.yml` cannot hold a team minimum for most teams: it also requires a signed release channel (`src/product-requirement.mjs:70-84`). | The package baseline records its build, and that is the minimum (SCF:REQ-015, REQ-016) |
| Old builds are told to upgrade | An installed build cannot learn anything new. What every build since 2026-08-23 does honour: refresh refuses a package baseline that is not format v1 (`src/workspace-configuration-refresh.mjs:1361-1363,1431-1434`). | A v2 baseline fences older builds off; their message names the format, not "upgrade" (section 5) |
| Approver enrollment at Story start becomes a proposal | A refused enrollment push already starts the Story without the person as an approver (`src/story-start.mjs:578`). `add-current-identity` also changes approval policy by direct push (`--solo`, `--self-approval`, `--auto-enroll`, `src/configuration-people.mjs:395-412`). | Every people or policy edit is a proposal; a starter approves their own enrollment in the same step where policy allows (D5) |
| Every change is a proposal | Creating `sflow/config` has nothing to propose against, and a protected `sflow/config` changes by a merge on the Git host. | Two named cases (SCF:REQ-004, D6) |
| SFlow re-applies semantic edits | Activation already re-applies field edits and refuses a clash (`src/configuration-state-git.mjs:138-160`). Its defects are a first-parent base (`:102`) and a conflict route to Recreate & sync (`:155-158`). | Fix those two; no new engine |
| An optional policy can require a second person | `approvalSecurity.allowSelfApproval` already exists for Story steps (`src/approval-authority.mjs:22`). | Reuse it (D4) |
| The heartbeat is read-only | It writes its own presence and retention records. | A third command class: machine-local upkeep |
| Checkout files are never authority | An approved read uses a checkout's `singularity/workflow.yml` when one is there, unless the caller asks for the authority (`src/approved-configuration-reader.mjs:511`). | Outside a Story checkout, only `sflow/config` |

### 2.2 What a person has to know

| | Before | After |
|---|---|---|
| Branches and refs that hold configuration | 9 | 2: `sflow/config`, `sflow/config-change/<kind>/*` |
| Commands and routes that change it, and lists to look in | 15 routes, 5 lists | 3 routes, 1 list |
| States a proposal can be in | 26, across five kinds of proposal | 5: draft, proposed, needs a choice, approved, rejected |

Appendix B lists every item. Authoring entry points (Studio, `/sf-build-workflow`, `capability add`, and so on) are
not counted on either side: they stay, and each one now ends in a proposal.

## 3. Requirements

### One source of truth

- **[SCF:REQ-001]** New work (a Story start, a proposal, an approval, `doctor`, `configuration validate`) MUST read
  configuration only from `sflow/config` on the repository that owns it: the workspace's capability authority,
  else the checkout's origin, else the workspace lead. Inside a Story checkout, the Story's pin is the only
  configuration. The `state` copy, history refs or tags, an application checkout's `singularity/` files and any
  cache MUST NOT decide.
- **[SCF:REQ-002]** When `sflow/config` is missing or does not load, the refusal MUST name `sflow/config`, its
  commit and the problem, and give one route: a restore proposal (D7) or a repair proposal. `workflow fix` MUST
  work on a `sflow/config` that does not load.
- **[SCF:REQ-003]** SFlow MUST NOT write the `state` configuration copy, `sflow/config-history/*` branches or tags,
  or Recreate & sync backup tags. Those that exist stay, and are never read as authority. D10 changes the history
  refs: SFlow writes none from 16 November 2026, and an upgrade deletes the existing `sflow/config-history/*`
  branches, their archive tags and the `sflow/config-refresh/*` review branches once `sflow/config` holds the
  build's configuration. Until stage 4, the refresh and capability publication still write the `state` copy, now
  naming its repository (`subject.repositoryIdentity`) instead of a history ref.

### One way in

- **[SCF:REQ-004]** SFlow MUST change `sflow/config` only by approving a proposal, with one exception: creating it
  where none exists (the confirmed onboarding plan, recorded as proposed and approved by its creator). A merge on
  the Git host of a proposal branch, the route for a protected `sflow/config`, counts as that proposal's approval
  and is recorded as approved on the Git host.
- **[SCF:REQ-005]** A proposal is one branch `sflow/config-change/<kind>/<name>`, where kind is workflow,
  capability, onboarding, people or package. Its first commit's parent MUST be the `sflow/config` commit its author
  read. Its change is everything between its merge base with `sflow/config` and its tip, however many commits.
- **[SCF:REQ-006]** Approval MUST name the proposal commit the approver was shown
  (`configuration approve <proposal> --confirm <commit>`, the same on every surface). A proposal that moved since
  is refused and shown again.
- **[SCF:REQ-007]** When `sflow/config` moved after the merge base, approval MUST re-apply the proposal's field
  edits onto the current `sflow/config` with the existing engine, and MUST ask only about a field both sides
  changed differently, as two values to pick from (two versions of a file that is not YAML or JSON). The pick is
  part of the approval. Nothing replays several proposals at once.
- **[SCF:REQ-008]** The approve view MUST show what lands, after any re-apply: each workflow, field and value
  before and after, and each file. It is the same in the terminal, Copilot and VS Code.
- **[SCF:REQ-009]** A proposal MUST be in one of five states: draft (saved, not yet proposed), proposed, needs a
  choice, approved or rejected. A person may reject a proposal with a reason, and its author may withdraw it,
  which is a rejection by its author. Running approve again on an approved proposal finishes whatever an
  interruption left; there is no separate reconcile route.
- **[SCF:REQ-010]** There MUST be one list, `configuration proposals`, for every kind, showing each proposal's
  author and state. Approval stays the presence-signed person step (`src/presence/repository-step-routes.mjs:25`);
  agents cannot approve (`src/person-step-catalog.mjs:120-125`).
- **[SCF:REQ-011]** When the approver is the proposal's author, the approval MUST be recorded and shown as a
  self-approval. With `approvalSecurity.allowSelfApproval: false`, a configuration approval needs another person
  (D4). A `poc` ("solo") repository self-approves and says so.
- **[SCF:REQ-012]** Approver enrollment at Story start, `add-current-identity` and every people or approval-policy
  edit MUST be a people proposal. At Story start, where the repository allows self-approval and the person was
  never removed from that group, the starter approves their own enrollment in the start confirmation (D5);
  otherwise the Story starts without them as an approver and the proposal waits, as a refused push does today. A
  person removed by an approved change MUST NOT be added back by their own approval.
- **[SCF:REQ-013]** Drafts (Studio, build sessions, `/sf-fix-workflow`) MUST be kept as edits against the commit
  they were read from, never as a full snapshot. When `sflow/config` moves, SFlow re-applies them and shows only
  the clashes; a draft is never discarded for that reason.

### Upgrades

- **[SCF:REQ-014]** ~~A build MUST only propose its packaged configuration, as a package proposal.~~ Superseded for
  upgrades by D10 (owner, 16 November 2026): the installer, `workspace refresh-configuration`,
  `/sf-refresh-configuration`, `workspace reinitialize`, `product reviews` and the VS Code pass publish this build's
  packaged configuration straight to each repository's `sflow/config`, authored by the person's own Git identity
  (REQ-018), with no review branch, merge request or extra confirmation. Only where the host refuses the push
  (branch protection) is the candidate kept on a `sflow/config-refresh/*` review branch, reported by its full name
  with a compare link. `--review-only` still proposes when a person asks for it. Each repository is its own
  publication; an unreachable one, one that needs a newer build, and one whose kept team edit conflicts hold up no
  other.
- **[SCF:REQ-015]** The package baseline (`singularity/.product/configuration-baseline.yml`) MUST move to format v2
  and record the proposing build's commit and `builtAt`. A build MUST NOT propose or publish over a baseline from a
  newer build (D1). A build without a clean stamp (a development checkout or a dirty tree) MUST NOT propose or
  publish packaged configuration. A build MUST NOT trust ownership entries that an older build wrote.
- **[SCF:REQ-016]** The approved baseline's build is the repository's minimum build. On an older build, a command
  that reads or writes that repository's `sflow/config` (Story start, propose, approve) MUST refuse with "this
  repository needs a build from <date> or later" and the install route. Work inside a running Story is not gated.
  Going back to an older build is an explicit package proposal labelled as a rollback (D8).
- **[SCF:REQ-017]** A new configuration field SHOULD stay out of packaged files wherever a code default serves, as
  `spec.changeImpact` does, so that older builds can still read the configuration.

### Identity

- **[SCF:REQ-018]** A person is their Git `user.name` and `user.email`, plus their GitHub login when signed in,
  resolved per command for whoever runs it and never cached across environments or people (branch
  gh-account-cache, ed12a52a2). Configuration commits MUST carry it. The proposal commit's author is the proposer.
  The approval commit's author is the proposer and its committer the approver, with `Proposed-by` and `Approved-by`
  trailers, and `Self-approved: yes` when they are one person. Never the OS login, never `unknown@invalid`: with no
  email, refuse with the `git config user.email` route. `singularity/configuration-transactions.json` is unchanged.
- **[SCF:REQ-019]** A repository is its canonical repository key (`sameGitRepository`,
  `gitRepositoryComparisonKey`). Every repository comparison MUST use it, never the raw URL.

### History and proof

- **[SCF:REQ-020]** Whether a Story's pinned commit is an ancestor of today's `sflow/config` MUST be checked with one
  commits-only fetch of `sflow/config` with no depth limit. A new ancestry proof version MAY hold more than 128
  commits and is bounded by size instead: 1 MiB, about 2,000 commits of the size measured on the analysis fixtures
  (roughly 300 bytes each before encoding). v1 proofs stay valid, and v2 is written only once the repository's
  minimum build reads it.
  When there is no ancestry, the refusal MUST say that `sflow/config` was rewritten outside SFlow and give the
  route (D9).

### Workspaces

- **[SCF:REQ-021]** Story checkouts MUST live inside their workspace, as today, or beside a clone that is in no
  workspace (D3), and never under SFlow's state folder. `reset-all`, `fresh-install` and destructive `local-reset`
  MUST list every Story checkout, keep it, and refuse while one holds uncommitted or unpublished work. A workspace
  that `fresh-install` or `local-reset` would delete MUST be kept whole while it holds a Story checkout, or the
  clone one belongs to; only its registration is forgotten (D10). Every linked worktree of a workspace clone is a
  Story checkout, and so is a clone with a Story's branch checked out in it while it holds such work.
- **[SCF:REQ-022]** `workspace repair <folder>` MUST fix a moved workspace (its registry entry, then
  `git worktree repair`), drop worktree entries whose folder is gone (Git's `prunable`), and recreate a managed
  Story checkout that was deleted. A command run in a moved workspace gives that one route. A workspace's own ID is
  never ambiguous.
- **[SCF:REQ-023]** The VS Code heartbeat, and any other machine-local upkeep, MUST write only its own presence and
  retention records: no contract refresh, journal, history index or Story index write, and no first-run or
  product-requirement pass. A Copilot turn's baseline advances only for commands that turn ran.

## 4. What is removed

| Removed | What depends on it today | After | Risk |
|---|---|---|---|
| **The `state` copy as authority.** Story start falls back to it (`src/configuration-branch.mjs:1777-1813`); approved reads list it as a candidate (`src/approved-configuration-reader.mjs:200-205`); capability discovery recovers from it (`src/organisation.mjs:2561-2594`). | Story start when `sflow/config` is missing; capability discovery on a new laptop; onboarding restore (`src/repository-onboarding.mjs:1038-1075`); VS Code's "has approved configuration" check (`apps/vscode/src/cli/runner.ts:1357-1500`); SGOS mutations (`src/sgos/platform/authority.mjs:322-326`). | `sflow/config` only; a missing one gets a restore proposal (D7). | Low. A repository with `state` but no `sflow/config` says "restore" instead of quietly working from an unproven copy. Records naming the `verified-state-mirror` kind (`src/sgos/contracts.mjs:2113,2725`, `src/sgos/pinned-policy.mjs:248`) stay readable. |
| **Writing the `state` copy.** `publishCapabilityMap` (`src/organisation.mjs:4746-4817`); the refresh's copy (`src/workspace-configuration-refresh.mjs:3294-3371`). | Organisation reads compare against it (`src/organisation.mjs:2747-2781`); the statuses `activation-complete-projection-pending` and `ready-state-refresh-pending`, and the `capability publish` retry, in VS Code's capability and onboarding views. | Nothing. Those statuses and the retry go. | Low. Ledger events and their pins (`src/ledger.mjs:1561-1567`) are separate and unchanged. |
| **History branches and archive tags.** Retention (`src/configuration-branch.mjs:420-538`), `src/configuration-history-refs.mjs`, auto-clean (`src/configuration-history-auto-clean.mjs`), `configuration cleanup-history` (`src/cli.mjs:8401-8406`). | The `state` copy's proof (above); onboarding's ref listing (`src/repository-onboarding.mjs:1865-1868`); SGOS's proof for a `state` authority (`src/sgos/platform/authority.mjs:141-271`); proposal cleanup's guard (`src/configuration-proposal-cleanup.mjs:84-88`); `ledger.configurationHistory` (`src/ledger-config.mjs:68-81`). | Nothing. Proposal cleanup deletes with the branch's own lease, which is safe because `sflow/config` only moves forward. `ledger.configurationHistory` stays valid and does nothing. | Low. |
| **Recreate & sync.** `src/configuration-recreate-sync.mjs`, `src/commands/configuration-recreate-sync.mjs`, the conflict route (`src/configuration-state-git.mjs:155-158`), VS Code (`apps/vscode/src/views/configuration-sync-model.ts`, `apps/vscode/src/extension.ts:8734-8766`), the skill (`plugin/skills/sflow-configuration/SKILL.md:25`). | Recovery from a conflict; "sync references" when nothing is pending. | Pick one of two values (SCF:REQ-007). Reference sync already runs after every approval (`src/configuration-proposal.mjs:846,921`). | Medium. A proposal written against an old layout may show many clashes; its route is to redo the draft on the new base. |
| **Direct pushes.** The installer (`install.sh:518-524`); plain and `--confirm-plan` refresh and reinitialize (`src/workspace-configuration-refresh.mjs:3227-3260`, `src/workspace-reinitialize.mjs:634`); Story-start enrollment (`src/story-start.mjs:571-590`, `src/commands/start.mjs:1609-1625`); `add-current-identity` (`src/configuration-people.mjs:442-493`, `src/cli.mjs:8452-8468`); Recreate & sync's apply (`src/configuration-recreate-sync.mjs:303`). | A solo person's one-step upgrade; a newcomer's first approvals; Configuration Center's people view; the enrollment snapshot a new Story pins (`src/configuration-people.mjs:495-498`). | Propose, then approve; inline for one's own enrollment where allowed. | Medium. A solo upgrade takes one more step. A newcomer's first Story start makes two pushes instead of one; an enrolled person still makes none (`src/configuration-people.mjs:213-224`). |
| **`sflow/config-refresh/*` reviews merged on the Git host.** | The VS Code pass and `product reviews` (`src/configuration-review-pass.mjs`), through `proposeCandidate` (`src/workspace-configuration-refresh.mjs:3198-3225`). | Package proposals in the one list. | Low. Open reviews are listed and approved as they are. |
| **The 128-commit window** (`src/skp-amendment-audit.mjs:16,122-125`). | Approver refresh (`src/story-approver-refresh.mjs:165`); skill-version and test-command amendments (`src/state.mjs:10536`, `src/story-test-command-amendment.mjs:219`); the check on every Story read (`src/workflow-snapshots.mjs:593,630,795`). | Unbounded commits-only fetch; proof v2 (SCF:REQ-020). | Medium: v2 must wait for the minimum build. |
| **One-click activation in VS Code.** Review and activate, Finish and activate, Save and activate (`apps/vscode/src/extension.ts:8384`, `apps/vscode/src/views/configuration-save.ts:130`). | Authoring in Studio and Configuration Center. | Propose, then the one approve view, with self-approval shown. | Low. |
| **The working-tree shortcut outside a Story checkout** (`src/approved-configuration-reader.mjs:511`). | Approved reads that do not ask for the authority, including `doctor` (`src/doctor.mjs:248-304`) and `configuration validate` (`src/cli.mjs:8411`). | In a Story checkout, its pin; elsewhere, `sflow/config`. | Medium: an offline read in an application checkout needs a fetched `origin/sflow/config`. |

D10 (16 November 2026) changes two rows above: the installer's and refresh's direct push stays (now authored by the
person, fenced by build order, one repository at a time), and `sflow/config-refresh/*` reviews go except where the
host refuses the push. The history-branch row is done in the upgrade itself, `configuration cleanup-history` and
VS Code's "Clean configuration history" included (removed, D10 answers 5).

Docs that describe removed behaviour change with the stage that removes it: `docs/topics/configuration.md:188-190`,
`docs/topics/capability-management.md:170-177,325-348,409`, `docs/topics/installation-and-upgrades.md:174,214-221`,
`docs/CONFIGURATION-RECREATE-SYNC.md`, `docs/CONFIGURATION-CENTER.md`, `ARCHITECTURE.md:282` and
`README-REFRESH-EXISTING-WORKSPACES.md`.

## 5. Migration

Nothing is rewritten (SPEC-CIC D3).

- `sflow/config`'s history, its receipt file, Story pins, ledger events and pins, the `state` copy, history branches
  and tags, and Recreate & sync logs and backup tags all stay exactly as they are.
- Running Stories keep their pin and keep working on old and new builds. Their v1 ancestry proofs check as today.
- Records that name the `verified-state-mirror` kind stay readable; no new one is written.
- `ledger.configurationHistory` stays valid and does nothing.
- Pending proposals of every kind, including open `sflow/config-refresh/*` reviews and branches with several commits,
  appear in the one list and are approved by the new rules.
- Existing Story checkouts keep their place and their links. `reset-all`, `fresh-install` and `local-reset` keep
  them (SCF:REQ-021, D11); new ones follow the new placement.
- Old history refs: ~~`doctor` and `product status` offer one previewed "remove old history refs" step, done in pages
  under leases. It never runs by itself, and leaving the refs is harmless.~~ Superseded by D10: the upgrade itself
  removes them, under leases and in pushes that fit a command line; a ref the host refuses to delete is reported
  and harmless.

**Older builds on the team**

- **They cannot downgrade.** Once a v2 baseline is approved, every older build's refresh refuses on every route
  (installer, terminal, VS Code pass), because each reads the baseline before it changes anything
  (`src/workspace-configuration-refresh.mjs:1431-1434`). Their refusal reads "Packaged configuration baseline must
  use singularity-flow-configuration-baseline/v1": it names the format, not "upgrade". The release notes and new
  builds' `product status` say what it means. Nothing stalls silently.
- **Their other direct writes continue until they upgrade:** enrollment and `add-current-identity`. New builds show
  those commits as landed outside SFlow (D6). Their Recreate & sync refuses as soon as any
  `sflow/config-change/people/` or `/package/` branch exists (`src/configuration-recreate-sync.mjs:129-133`), which
  is the safe outcome.
- Their Story start still falls back to the `state` copy if `sflow/config` is missing; that copy is no longer updated.
- From stage 1, builds read the minimum build and say "upgrade" in plain words. A team that wants older builds
  stopped as well can use the existing `product.yml` minimum, which needs a signed release channel.

## 6. Delivery stages

Ordered by value against risk. Each ships on its own, with no switch: each change either refuses something harmful
or narrows a route.

**Stage 1 — Stop the damage.** Five small, independent changes. Built 15 November 2026, one commit each; the
Story-start, propose and approve minimum-build refusal of SCF:REQ-016 is not yet built (refresh checks it per
repository).
- 1a. Build order and the fence: baseline v2 with its build, no proposal over a newer build, the installer and every
  refresh route only propose, the minimum-build refusal (SCF:REQ-014 to REQ-016). It MUST ship on main before
  agents-home merges.
- 1b. Identity in commits: refresh, onboarding and enrollment take the person's identity before entering their
  isolated clone, as capability activation does (`src/organisation.mjs:6939-6955`). Merge gh-account-cache
  (SCF:REQ-018).
- 1c. The `state` copy is never authority for Story start or organisation reads (SCF:REQ-001, REQ-002).
- 1d. The upkeep class for the heartbeat (SCF:REQ-023).
- 1e. `reset-all` and `fresh-install` keep and list Story checkouts (SCF:REQ-021, second sentence).
- 1f. `fresh-install` and destructive `local-reset` keep every Story checkout, and a workspace that holds one
  (SCF:REQ-021, second and third sentences; D10). Built 16 November 2026.

Fixes UP-F1, F3, F4, F5, F8, F9, F11b, CH-F1, WS-1, WS-2, WS-7, and parts of UP-F6 and F7. Risk: low.

**Stage 2 — Approval lands what was reviewed.** The merge base; approval bound to the commit shown; the approve view
with values; pick one of two values; reject and withdraw; approve run again finishes an interruption; a proposal's
parent is the commit its author read; the approval commit records proposer and approver; Recreate & sync goes
(SCF:REQ-005 to REQ-009, REQ-018). Fixes ER-F1, F2, F6, F12, and parts of F4 and F11. Risk: low to medium; it changes
the activation engine that every approval uses.

**Stage 3 — One way in.** People proposals (enrollment inline where allowed, `add-current-identity`, policy edits,
no self re-add after a removal); package proposals under `sflow/config-change/package/` through the same engine; the
one list; VS Code's activate buttons become propose and approve; drafts kept as edits; the second-person policy
(SCF:REQ-004, REQ-010 to REQ-013, D4, D5). Fixes ER-F3, F4, F8, F10, and part of F9. Risk: medium; it touches Story
start and VS Code flows. D4 changes regulated repositories, so the release notes say so.

**Stage 4 — Remove the old machinery.** (D10 pulled part of it into the upgrade on 16 November 2026: history refs are
no longer written; auto-clean is deleted; the upgrade deletes the old history and review refs; onboarding, SGOS,
proposal cleanup and the legacy-mirror proof fetch a source commit by object instead of reading a history ref.)
Stop writing the `state` copy and history refs; delete auto-clean,
cleanup-history and the history-ref paths in onboarding, SGOS and proposal cleanup; the restore proposal (D7);
`doctor` and `validate` read the authority; the unbounded ancestry fetch, with proof v2 once the minimum build allows;
the one-time removal step; the docs (SCF:REQ-002, REQ-003, REQ-020). Fixes CH-F2, F4, F5, F7, F8, and parts of CH-F9
and ER-F5. Risk: medium; it deletes code that others call, and section 4 lists each caller.

**Stage 5 — Movable workspaces and one repository key.** Placement for a clone outside any workspace (D3);
`workspace repair` re-links, prunes and recreates; the ambiguous-ID message; the canonical repository key everywhere
(SCF:REQ-019, REQ-021, REQ-022). Fixes WS-3, WS-4, WS-6, CH-F3. Risk: low to medium.

The findings this model does not touch keep their own targeted fixes (Appendix A, third list).

## 7. Owner decisions

Decided 15 November 2026: the owner approved every recommendation below ("approve"). Each recommendation is now
the decision; D2's Git 2.29 minimum is confirmed when stage 5 is built.

- **D1. What makes a build newer?** Recommended: the clean stamp's `builtAt`, which is the source commit's time
  (`scripts/reproducible-build.mjs:194-201`), recorded with its commit. Equal commits are the same build. Dirty and
  development builds never propose. Commit ancestry would need the product's Git history on every machine.
- **D2. Relative worktree links?** Recommended: no. Keep absolute links; `workspace repair` re-links them with
  `git worktree repair`, which needs Git 2.29 (to be confirmed), so the supported minimum rises from 2.25 to 2.29.
  Checked when stage 5 was built: Git 2.29 added `git worktree repair`, but mending a clone and its worktrees that moved
  together (a moved workspace) came in Git 2.31 (git/git cf76baea, not in v2.30.0), as did `prunable` in
  `git worktree list --porcelain`. So 2.29 was too low. Decided by the owner on 16 November 2026: `workspace repair`
  needs Git 2.31 and, on older Git, refuses with `WORKSPACE_REPAIR_GIT_TOO_OLD` (as built); the setup minimum stays
  as it is (2.25).
- **D3. Where does a clone outside any workspace keep its Story checkouts?** Recommended: a folder beside it,
  `<clone>.stories/`. Starting is refused if that would fall inside SFlow's state folder.
- **D4. Does `approvalSecurity.allowSelfApproval` govern configuration approvals too?** Recommended: yes, one policy
  for every approval. Team and `poc` repositories are unchanged (self-approval allowed and shown); a regulated one
  (default false) then needs a second person for configuration changes.
- **D5. May a starter approve their own enrollment at Story start?** Recommended: yes, where self-approval is
  allowed and they were never removed from the group; the start result says so.
- **D6. Are merges on the Git host and direct pushes to `sflow/config` supported?** Recommended: yes, as authority,
  because Git is the truth. They show as landed outside SFlow, with no approver; one that does not load gets the
  repair route. SFlow itself never writes that way.
- **D7. How is a deleted `sflow/config` restored?** Recommended: a restore proposal from the newest copy available (a
  clone's `origin/sflow/config`, else the newest Story pin, else the old `state` copy), shown in full and approved
  by a person.
- **D8. How does a team go back from a bad release?** Recommended: an explicit package proposal from the older build,
  labelled "roll back to build <date>" and listing what it removes. Approving it lowers the minimum.
- **D9. After a rewrite of `sflow/config` outside SFlow, can a running Story still adopt new approvers?** Recommended:
  yes, in the same step, by an approver's confirmation recorded as "adopted without ancestry". The refusal names
  the cause and this route.

Decided 16 November 2026, by the owner after installing main 04a6f2adc (stage 1), whose after-install pass opened a
review branch in each of three repositories that could not be found:

- **D10. Upgrades publish directly and remove the old history.** The owner: "upgrade should delete all the history
  branches and let them update sflow/config directly without any review or merge reqest .It should be one click
  actiivty". It supersedes REQ-014's review-only rule for upgrades and pulls stage 4's history removal into the
  upgrade. Kept from stage 1: the v2 baseline and its build stamp, the build-order fence (needs-newer-build holds up
  no other repository), "an unreachable repository holds up no other", the person's own identity in the commit,
  and the refusal for development and dirty builds. Only a host refusal of the push leaves a review branch, with
  its full name and a compare link. A conflict with the team's own edits follows today's rules (the team's value
  is kept and reported); where that no longer works, that repository prints its one-command route and holds up no
  other. Deleted: `sflow/config-history/*` branches, their archive tags, `sflow/config-refresh/*` review branches.
  Never deleted: `sflow/config`, `sflow/config-change/*`, the state branch, Story and application branches.
  The owner's answers to the build's six questions, the same day ("take the suggestions"): (1) a conflict with the
  team's own edit keeps today's rule, and only a result that will not load stops that repository; (2) a difference
  that is only the build's stamp publishes nothing; (3) a terminal user's first command after a new build may publish
  in the background, since the build fence makes it safe; (4) the protected-branch fallback leaves the run partial and
  the installer's "did not finish" warning, with the review link; (5) `configuration cleanup-history` and VS Code's
  "Clean configuration history" are removed; (6) the upgrade also clears each registered clone of its stale tracking
  refs and fetched archive tags for those refs, locally, refs only and never a file.

Decided the same day, after stage 1e:

- **D11. Do `fresh-install` and `local-reset` keep Story checkouts too?** Yes: the owner extended stage 1e's
  protection to both. Stage 1e let a Story checkout inside a workspace they delete go with it once it held no
  work. Now every Story checkout is kept, and each reset stops, naming the checkout and its route, while one holds
  uncommitted work or commits no remote has. A Story checkout is a linked worktree whose Git (HEAD, index, branch)
  lives in its clone, so keeping only its folder would leave it broken. The rule built is the simplest safe one,
  which the owner confirmed: a workspace that holds a Story checkout, or the clone one belongs to, is kept whole,
  with its clones and documents. Only its registration is forgotten, as forget-only does, and `workspace open <DIRECTORY>` registers
  it again. Every other workspace is deleted as before. The preview marks the workspace `kept` and lists each
  Story checkout. The confirmation phrases and "Nothing was removed" on a refusal are unchanged.
  The owner then confirmed the keep-whole rule and decided two more cases: every linked worktree of a workspace
  clone is a Story checkout (an Auto flight's among them), listed through a registered Git query
  (`repository.worktrees`); and a workspace clone with a Story's branch checked out in it, with no checkout of its
  own, is one while it holds uncommitted work or commits no remote has, so the reset refuses with the same
  message. Clean and published, it goes with its workspace as before.

Decided 16 November 2026, after stage 5 was built:

- **D12. Does one repository key loosen the stored key too?** No. The stored key (`gitRepositoryComparisonKey`, which the
  Story index and record identities carry) stays strict: only GitHub's ssh and https spellings are one repository there.
  `sameRepository` (host plus repository path, whatever the protocol, `.git` suffix, letter case or trailing slash) is
  used only where a remote read now is compared with one recorded earlier (SCF:REQ-019).

## Appendix A — The findings

IDs follow the analyses: WS (workspaces), UP (upgrades), ER (editing and review), CH (configuration history).

**Removed by the model (24)**

| Finding | By |
|---|---|
| WS-3 A deleted Story worktree folder leaves the Story impossible to open | REQ-022 |
| WS-6 A changed `origin` URL spelling stops the workspace | REQ-019 |
| WS-7 The Story index is rewritten every minute | REQ-023 |
| UP-F1 An older build silently downgrades `sflow/config` | REQ-014, REQ-015, stage 1a fence |
| UP-F3 Main-build teammates undo the agents-home migration | REQ-015, REQ-016 (ship before agents-home) |
| UP-F4 The installer and terminal refresh publish unreviewed | REQ-014 |
| UP-F5 Configuration commits carry the OS login and `unknown@invalid` | REQ-018 |
| UP-F8 One unreachable repository blocks the whole refresh | REQ-014 |
| UP-F9 Installer advice loops on agents-home | REQ-014 |
| UP-F11b Story start and organisation reads see different authorities | REQ-001 |
| ER-F1 A multi-commit proposal lands only its last commit | REQ-005, REQ-006 |
| ER-F2 Recreate & sync reverts an approved change and lands unreviewed ones | REQ-007, REQ-009 |
| ER-F3 Enrollment undoes a reviewed removal | REQ-012 |
| ER-F4 No independent review, no self-approval disclosure | REQ-010, REQ-011, REQ-018 |
| ER-F6 The reviewer does not see what lands | REQ-006, REQ-008 |
| ER-F8 Unpublished Studio edits are lost when `sflow/config` moves | REQ-013 |
| ER-F10 A kept Studio draft reverts newer values | REQ-013 |
| ER-F12 `/sf-fix-workflow` proposes with no authority binding | REQ-005 |
| CH-F1 The `state` copy becomes authority without proof | REQ-001, REQ-003 |
| CH-F3 The authority URL is compared as a string | REQ-019 |
| CH-F4 Cleanup has no way out under a deletion rule | REQ-003 |
| CH-F5 Archive tags grow forever and reach every clone | REQ-003 |
| CH-F7 Cleanup command lines overflow on Windows | REQ-003 (the one-time step pages) |
| CH-F8 Docs overstate history coverage | Stage 4 docs |

**The model, plus a targeted fix (10)**

| Finding | The model | Still to do |
|---|---|---|
| WS-1 The heartbeat ends `/sf-confirm` turns and switches off the shell guard | REQ-023 | Lock turn records, or check their hash before writing |
| WS-2 `reset-all` deletes Story worktrees in the home folder | REQ-021 | None beyond REQ-021 for existing checkouts |
| WS-4 A moved workspace breaks, and every route is a dead end | REQ-022 | The ambiguous-ID message |
| UP-F6 Mixed builds corrupt the ownership receipt | REQ-015 | Re-derive entries already marked wrongly, from the packaged history |
| UP-F7 Older builds are stopped team-wide | REQ-016, REQ-017 | Replace "Correct or remove this entry" (`src/configuration-diagnostics.mjs:298`) |
| ER-F5 An outside edit stalls the team with no repair | REQ-001, REQ-002 | Fail per workflow, not for the whole file |
| ER-F9 Independent proposals show as revisions of one | REQ-010 (author shown) | A proposal ID per author |
| ER-F11 Small confusions (details dropped, "Copilot: null", hook text) | REQ-007, REQ-009 | The output fixes |
| CH-F2 No new approvers after 128 commits or a rewrite | REQ-020, D9 | None |
| CH-F9 Other refs that grow per approval | REQ-003 (backup tags) | SGOS fetches blobs it does not need; local transport refs are never removed |

**Not touched by the model (11)**

WS-5 a brief detached HEAD drops a Story from the index; WS-8 a multi-root window binds only its first folder; WS-9
the active workspace is global; WS-10 a second laptop opens a Story another is working on; UP-F2 agents-home Story
start deletes team agents (build the removal set from the approved policy only, as REQ-001 already requires);
UP-F10 Copilot CLI has deprecated local plugin installs; UP-F11a the server's refusal reason is hidden; UP-F11c the
VS Code version range; ER-F7 a workflow `workflow validate` rejects can be activated; CH-F6 SFlow's own fetch never
prunes with the pins refspec; CH-F10 SHA-256 repositories in the Story pin.

## Appendix B — The concepts, listed

**Branches and refs, before (9):** `sflow/config`; the `state` branch's `configuration/` copy;
`sflow/config-history/<commit>` branches; the same names as archive tags; `sflow/config-change/workflow/*`;
`sflow/config-change/capability/*`; `sflow/config-change/onboarding/*`; `sflow/config-refresh/*`;
`sflow-config-recreate/*` backup tags. **After (2):** `sflow/config` and `sflow/config-change/<kind>/*`. The `state`
branch stays for the ledger. Ledger pins and the Story pin are unchanged and not counted.

**Routes, before (15):** `workflow activate` (and Studio's three activate buttons); `configuration approve`;
`capability activate`; `capability setup-activate`; a Git-host merge of an `sflow/config-refresh/*` review;
`workspace refresh-configuration` and `/sf-refresh-configuration`; `workspace reinitialize --confirm-plan`;
`./install.sh`; `configuration add-current-identity`; Story-start enrollment; `configuration recreate-sync`;
`capability onboard --confirm-plan`; `configuration cleanup-history` and its automatic run; `capability publish`;
`configuration reconcile`. **Lists, before (5):** `workflow proposals`, `capability proposals`,
`capability setup-proposals`, `product status`, `configuration drafts`. **After:** `configuration approve`,
`configuration reject`, and `capability onboard --confirm-plan` only to create `sflow/config`; one list,
`configuration proposals`.

**Proposal states, before (26):** workflow: saved but not uploaded, pending review, revision n of m, invalid,
conflict, review required, activation pending, outcome unknown, superseded, sync pending, activated; capability:
conflicting, discarded, cancelled, activation complete with projection pending; setup: configuration review
required, local registration pending, ready with state refresh pending; package: review required, shared review,
merged on the host, updated directly, blocked, published with the copy failed, stale plan; enrollment: published,
not enrolled. **After (5):** draft, proposed, needs a choice, approved, rejected.
