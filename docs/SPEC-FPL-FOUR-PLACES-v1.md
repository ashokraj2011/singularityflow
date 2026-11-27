# Four places (FPL) — v1: Work, Needs you, Rules and Library become SFlow's sidebar

**Specification ID:** `FPL-v1`

**Status:** M1 and M2 built (2026-11-26), M3 built (2026-11-27); M4 to M6 not built. This is the build specification for
roadmap Bet 2. It is measured on `main@5ac41f37e`.
- **M1** (`main@cbeb9978d`): `needs-you`, `needs-you show`, `/sf-inbox` on them, card approvals, and the Needs-you tab.
- **M2** (branch `fpl-m2`, from `main@2809f6edc`): `work "<words>" --plan-only`, `work list [--offline]`, the task page's
  facts in `work status`, `/sf-task` with no words listing the tasks in flight, and the Work tab with its box, In
  progress, Done this week and the one task page. Work is the first tab and the sidebar opens on it.
- **M3** (branch `fpl-m3`, from `main@70131c215`): `rules [--offline]` and `rules preview --change-set -`
  (src/task-rules.mjs), `taskRules` collecting every problem with its field (`checkTaskRules`), rule IDs, the `use` rule's
  `{ workflow, because, id }` form, the `tasks.rule.add`, `tasks.rule.change`, `tasks.rule.remove` and `tasks.idPrefix.set`
  Studio operations, the rules checked in `workflow check`, a Studio change set, `configuration save` and `configuration
  approve`, the proposals' "Waiting for review" (`taskRules` on each proposal), the Rules tab and its one page with the
  form, its preview and Propose, and the topic's corrected `use: { change: classic-delivery }`. Not in M3: the `by:` group
  (§11, question 3), the "Team guidance" rename (§11, question 4), and `/sf-explain` reading `rules --json` live (REQ-038):
  its topic route serves the tasks topic, which names `sflow rules`.
- The places stay behind `singularityFlow.navigation.layout` (default `classic`) until M5.

**Owner, 2026-11-26:**
- The four places become SFlow's default sidebar in VS Code:
  - **Work**: the "what do you want done" box (`/sf-task`) and the tasks in flight, with their plans.
  - **Needs you**: one inbox. Each approval, decision and question waiting on this person is a card, with SFlow's checks
    and recommendation.
  - **Rules**: the team's "when … then add …" rules, which only add steps (the `tasks:` rules of ITW).
  - **Library**: skills and agents, the repository's own and the trusted marketplaces', with updates and feedback. This
    is the Marketplace page that shipped this week.
- Today's views stay reachable under **Advanced**. Nothing is lost.
- **Needs you** covers everything waiting on the person across the workspace's repositories and Stories, not only the
  open repository.
- **Rules first:** the Rules place edits team rules that only add steps. Full workflows stay in Workflow Studio, under
  Advanced.
- **Workflows run as they are (owner, 2026-11-26):** built-in workflows and the custom workflows teams create run step
  for step as defined. The four places, `/sf-task` and team rules only add; they never rewrite, reorder or drop a
  workflow's steps. A Story started with a chosen workflow follows it unchanged, and Workflow Studio stays one click away.

**The concept:** the design canvas "SFlow UI Reimagined" (2026-11-24): the boards Main, Home, Task, NeedsYou, Rules and
Library. This spec builds what those boards show, with the differences listed in §6.3.

**Builds on:**
- intent to work ([ITW v1.1](SPEC-ITW-INTENT-TO-WORK-v1.1.md)): kinds, the composer, `tasks:` rules, `/sf-task`, and the
  in-turn carry;
- the decision list and the Decide card (`src/decision-list*.mjs`, `decision-plain.mjs`, `decision-advice.mjs`);
- the approval page, approval focus (`src/approval-focus.mjs`) and SF Guard
  ([PSS](SPEC-PSS-v1-PRESENCE-SIGNED-STEPS.md));
- the Marketplace page and All skills (`marketplace catalog`, `skill catalog`) and the conversion review
  ([MCR](SPEC-MCR-MARKETPLACE-CONVERSION-REVIEW-v1.md));
- workspaces, the machine-wide Story index (`src/story-index.mjs`) and repository discovery
  ([RDS](SPEC-RDS-REPOSITORY-DISCOVERY-AND-SELECTION-v1.md));
- the reviewed configuration path (`proposeConfigurationChange` in `src/configuration-proposal.mjs`, and
  `configuration approve`).

---

## 1. Why

What a person meets in VS Code today, counted at `main@5ac41f37e`:

| | Today |
|---|---|
| Sidebar views | 2: the Navigator (a webview) and Run (a tree, shown only when the repository has run configurations) |
| The Navigator | 7 main-menu rows. Run & Test, the intake details, and up to 40 pinnable shortcuts. 3 footer menus holding 32 entries: Work tools 14 (with Understand changes 5 inside it), Help & diagnostics 8, Activity & logs 5 |
| Workflow Studio | 11 views: Workflows, Build, Agents, Skill master, Instructions, Constitution, Artifacts, Library, People, Integrations, Changes |
| Configuration Center | 8 tabs |
| Editor pages | about 75 webview pages (76 places in the code create one) |
| Command palette | 200 commands contributed, 174 of them in the palette (9 of those only with run configurations); 26 hidden |
| Copilot | 197 `/sf-` skills |
| A person's actions | about 32 for a six-step classic Story, about 8 of them real decisions (the concept board, 2026-11-24). A fix through `/sf-task` takes 4: the words, the intake's answer and two Yeses ([ITW](SPEC-ITW-INTENT-TO-WORK-v1.1.md) A11, measured by the journeys on 2026-11-26) |

The concept board counted the same things on 2026-11-24 as "19 places and 195 palette commands". Since then five
commands and three skills were added.

Nothing today answers "what is waiting on me?":
- `inbox` and the Inbox page read one repository and list everyone's items. The `/sf-inbox` skill tells the agent to
  call it once for each repository.
- `home` (My Work) is filtered to this person, but it covers approvals only, in one checkout.
- The Approvals page, the Navigator's badge, the decision list and the Decide card cover only the Story open in this
  window.
- Reviews lists the configuration proposals of one repository.

`/sf-task` removed the workflow a person had to pick (ITW). The screens did not follow it. Starting work, deciding,
changing the team's rules and finding a skill are each spread over several of the places above.

## 2. What a person sees

```text
SINGULARITY FLOW                         [Refresh] [Ask SFlow] [Advanced]
shop · 3 repositories
  Work   Needs you (3)   Rules   Library

  What do you want done?
  [ fix the login timeout on slow networks              ] [Start]
  Likely plan: Intake → Code → Tests → You approve the code

  In progress
    Fix the login timeout on slow networks      TASK-12 · shop-web
    Intake done → Code done → Tests now → You approve the code
    Add CSV export to orders                    TASK-11 · shop-api
    Waiting for you: approve the plan

  Done this week
    Retry failed card payments once             checked on its branch
```

- Each place has one list in the sidebar.
- Opening a row opens that place's page in the editor: a task, a card, the rules or the Library.
- Each place has one page, and it is reused: a second row replaces what the page shows.
- **Advanced** shows today's Navigator, unchanged.

## 3. The rules

### 3.1 The sidebar

**FPL:REQ-001, the default.**
- The SFlow activity-bar container opens on the four places: Work, Needs you, Rules and Library, in that order.
- They are tabs in one webview view. The view keeps its ID, `singularityFlow.navigation`, so pins and its position
  survive the upgrade.
- One webview, not four, so the sidebar starts no new web process (probe 2, §9).
- The view's title is the place shown. Its description is the workspace's name.
- The Run tree stays a separate view, shown only with run configurations as today, and now collapsed by default.
- With no workspace and no SFlow repository open, the view shows today's first step (Guided start, or Choose a
  workspace, from `deriveSidebarNavigation`) in place of the tabs.

**FPL:REQ-002, the header.**
- The header holds:
  - the workspace and its repository count, which opens the existing workspace switcher;
  - three title actions: Refresh, Ask SFlow (the existing `singularityFlow.askSFlow`) and Advanced.
- Nothing else sits above the tabs.

**FPL:REQ-003, one page per place.**
- Work's task page, the Needs-you card, the Rules page and the Library page each open in the editor.
- Each is one reused editor tab. A second row replaces what the tab shows; it never opens another tab.
- A page never changes anything when it opens. Only its buttons do.

### 3.2 Work

**FPL:REQ-004, the box.**
- "What do you want done?" takes a sentence.
- **Start** sends exactly `/sf-task <words>` to the Copilot chat the person used last, as `singularityFlow.startTask`
  does today (`workbench.action.chat.open`, `isPartialQuery: false`).
- While the person types, a line under the box shows the likely plan. It is read from
  `work "<words>" --json --plan-only` (§4), after typing pauses for 600 ms, and only when SFlow can tell the kind from
  the words (`kindFromWords`). Otherwise there is no line.
  - It is called "Likely plan". The plan line in the chat is the plan.
  - Start never waits for the preview.
- **Start with a workflow…** under the box opens today's Start Work form (`singularityFlow.startWork`), the explicit
  `/sf-start` route.
- The task starts in the window's repository, as `/sf-task` does. When the workspace has other repositories, the box
  names this one ("in shop-web"). **Another repository…** opens the existing switcher
  (`singularityFlow.switchWorkspaceRepository`).

**FPL:REQ-005, in progress.**
- Work lists this person's Stories in flight across the workspace's repositories, tasks and classic Stories alike.
  "This person's" means the person started the Story, or has a checkout of it on this computer.
- Each row has:
  - the title;
  - the ID and repository;
  - when it started;
  - the plan as one line of chips;
  - one status line.
- The chips are the Story's steps by label, each with its state: done, now, waits for you, to do, or added.
- The status line:
  - says "Waiting for you: <the card's question>" and opens that card when an item in Needs you belongs to the Story;
  - otherwise says who or what it waits for ("Waiting for Priya: approve the code") or what runs now, in `work status`'s
    words.
- Stories that are not this person's are under **All Stories in this workspace**, today's Stories page.

**FPL:REQ-006, the task page.**
- **The header** shows the title, then the ID, kind, base and who started it and when. **Intake** opens the Story's
  intake details (`singularityFlow.openStoryIntake`).
- **Its buttons:**
  - **Open in Copilot chat** sends `/sf-task` for a task, or the Journey's route for a classic Story.
  - **Stop the task** runs today's cancel (`cancel <ID> --reason … --confirm <ID>`), with its confirmation.
- **The plan** is the chip line, with **Add a step**.
  - Add a step offers only the steps `work add` can add to this task (`ADDABLE`, minus those already there), and runs
    `work add <ID> --add <STEP>`.
  - A refusal is shown in its own words, with its one route.
- **The plan note** says where each step came from: "Composed from your words: a fix. The team's rules added the tests,
  the security review (src/auth) and your approval of the code." It is read from the Story's composition (`rules`,
  `added`, each with its `because`).
- **What is happening** lists the Story's material events, oldest first, in plain words, then "Now" and "Next".
- **Documents** are each step's document on the Story's branch (`work status` `steps[].document`).
- **Changed files** shows the files changed against the base, with lines added and removed.
  - **Explain the change** opens the Code Explainer in My change.
- **Rules applied** lists the rules that applied to this task, each with its `because`.
- **Lessons** links the Lessons page for this Story when it has lessons.
- There is no Pause. Nothing of a task runs between chat turns, so there is nothing to pause (§6.3).

**FPL:REQ-007, done this week.** This person's Stories that ended in the last seven days, each with where it ended:
"checked on its branch", "pull request open" or "report ready" (ITW REQ-018).

### 3.3 Needs you

**FPL:REQ-008, what waits on a person.** An item is one of:

| Kind | Waiting on this person when | Read from |
|---|---|---|
| Step approval | the step is `awaiting_approval`, this person is admitted for a required group still missing (`matchApprovalAuthority`, `remainingRequiredAuthorities`), the self-approval rule allows them (`mayDecideApproval`), and they have not approved this version (SF Guard's `presenceCounts` counted) | the Story's record, no checkout |
| Workflow decision | `pendingDecision` for the current step, whose `by` admits this person | the Story's record, no checkout |
| Decision | an open decision-list item (not settled, not optional) with `decidedBy.allowed` and a question (`waitsOnPerson`): conformance gap, upstream issue, refactor behaviour, test risk, departure, owed sign-off, intent amendment and the other `PENDING_ITEM_KINDS` | the Story's checkout on this computer |
| Next version | the yes to start a step's next version (`versionOpening`) | the Story's checkout on this computer |
| Intake answers | a task's intake waits for its required answers (clarification `required`, no record yet), and this person started the task | the Story's checkout on this computer |
| Review | a configuration proposal this person may approve: a rule, a library import, a workflow change (`workflow proposals`, with the approver rules of `config-approvers.mjs`) | the repository's configuration branches |
| Initiative approval | an Initiative output or pack this person may approve. Today `approvals-model.ts` decides this in VS Code, for the open Initiative only; the rule moves into the engine | the Initiative's record |

- An item exists only when the command that records it would accept this person. The list uses the same checks as
  `approve`, `decisions record`, `decision choose` and `configuration approve`, never a copy of them.
- A first-use yes for a marketplace skill is asked and answered in the task's chat before its Story starts (ITW
  REQ-010). It is not an item. Its import proposal is a Review item for the configuration's approvers.
- A question an agent asks in a chat turn stays in that chat. Needs you holds only what is recorded or derived from
  records. The intake row is the one derived question, and its card says "Answer in Copilot chat".
- Optional items, settled items and machine items (SFlow's own checks) are never items.

**FPL:REQ-009, who "this person" is.**
- In each repository, this person is the identity SFlow records with there: `identity(root, { offline: true })`, the Git
  email and the cached GitHub login. So an item shows exactly when that repository's recording command would accept it.
- When SFlow cannot tell whether an item is this person's, for example from malformed approver groups, it is shown.
  - Its card says "SFlow could not tell whether this one is yours".
  - Acting on it still goes through the real check.
  - Hiding it could lose work.

**FPL:REQ-010, across repositories.**
- Needs you reads every repository of the active workspace (`workspaceStatus` members).
  - A member that is cloned is read from its clone.
  - A member that is not cloned yet is read from its remote URL, as `discoverRemoteStoryCandidatesByUrl` does for
    `inbox` today.
- With no workspace active, it reads the window's repository.
- Other workspaces on this computer are not read in v1. A line says how many there are (§11, question 1).
- Stories are found as `inbox` finds them today: the ledger's state index, then each in-progress Story's `workflow.json`
  (`discoverRemoteStoryCandidates` with `includeState`). No branch is checked out to list.
- Decision, Next version and Intake items need the Story's checkout. They are read for Stories that have one on this
  computer: the Story index, `listStoryIndex`. They use `readPendingList(…, { offline: true })`, with no probes.
- For a Story with no checkout here, those items are found when its approval card opens (REQ-014).

**FPL:REQ-011, order.** Same records, same order:
1. **Holds work**: every item that is not a Review or Later: step approvals, workflow decisions, decisions, next-version
   yeses, intake answers and Initiative approvals. Oldest first.
2. **Reviews**: configuration proposals. Oldest first.
3. **Later**: `LATER_KINDS` items (owed sign-offs, departures, items asked for later), soonest expiry first, then
   oldest.

Ties go by repository name, then Story ID, then the item's key.

**FPL:REQ-012, one card at a time.**
- The sidebar lists the items. Each row has:
  - the question, for example "Approve the plan?";
  - the Story's title, its ID and its repository;
  - "SFlow recommends: approve" or "SFlow does not recommend it yet".
- Opening a row shows its card in the one Needs-you page, with focus on the card's question.
- The card holds one question. A Story with three items has three rows and three cards.
- After a choice the card shows what happened, and **Next: <the next item's question>**. It never moves on by itself,
  so the person reads the result.

**FPL:REQ-013, what the card says.** In this order:
1. **The question**, and the Story's title, ID, kind and repository, with why this person is asked ("your team's rules
   give the plan to a person").
2. **What it is about**: for an approval, the document's summary and its "What needs your eyes" items (`approvalFocus`).
   For a decision, its `plain.why`.
3. **What SFlow checked**, one line each: the review result, every requirement having its place, which rules applied
   and why no other review was added, the tests that ran. Each line is from the approval focus's `checked`, the decision
   item's `check`, or the composition's rules. A check that did not run says so.
4. **SFlow's recommendation**, from the engine: the decision item's `recommended`, or the approval item's (decision-list
   kind `approval`: "Nothing on this list holds it, and its checks are recorded"). With no recommendation, the card says
   why and names the item that holds it.
5. **The choices**, named by what they do ("Approve the plan", "Send it back with a note", "Keep the old behaviour").
   **Read the whole document** opens it.

**FPL:REQ-014, acting from the card.** Every choice goes through today's path for its kind:
- **Step approval:**
  - `choices begin approve <ID> --fetch --json --review-packet`;
  - `guard card approve` where the policy signs;
  - `approve <PHASE> --work-id <ID> --fetch --selection-receipt <T>`.
  These are the approval page's calls. **Send it back** is the approval page's return, `reject … --to … --reason`.
- **Decision:** the Decide card's `decisions record <ID> --choose dN=OPT … --confirm sha256:…`, with `guard card
  decisions` for a row SF Guard signs.
- **Workflow decision:** `decision choose <ID> --option … --reason … --expected <key>`.
- **Review:** `workflow proposal <branch> --json` for its summary, then `configuration approve <branch> --confirm
  <commit>`, as Workflow Studio's Changes view does.
- **Next version:** the Decide card's version consent.
- **Intake answers:** **Answer in Copilot chat** sends `/sf-task` to this window's chat. It is offered only when the
  Story's checkout is this window's. Otherwise the card gives the route to that checkout (`storyCheckoutRoutes`).
- **Initiative approval:** `initiative choices begin approve <INIT-ID> <OUTPUT|phase>` and its answers.

How the card runs:
- The card runs in the Story's place on this computer: its Story-index checkout, or else the workspace's clone of its
  repository. A client bound to that repository runs each command; it is not the window's client.
- A Story with no checkout here is checked out in its repository's clone by `--fetch`, as an approver's approval is
  today. The card says so before the first action: "Approving checks out TASK-11 in shop-api."
- A refusal (uncommitted work in that clone, the Story's checkout elsewhere) is shown in its own words with its one
  route. See §11, question 2.
- A Story's decision items, found when its approval card opens, become cards of their own, placed before the approval
  they hold.
- SF Guard sees the same card surfaces as today (`vscode-approval`, `vscode-card`). Needs you adds no surface and no
  path of its own.
- The card offers only the choices the engine marks available and recordable. A choice the engine could know it would
  refuse is never shown.

**FPL:REQ-015, after acting.**
- The item leaves the list and the badge drops at once. The next refresh confirms it.
- A task's step that goes on after the choice carries its chat on, as the approval page and the Decide card do today
  (`continueTaskInChat`, `continueTaskAfterDecision`). This happens only when the Story's checkout is this window's.
- For anyone else's task the card says "TASK-11 goes on when its author continues it".

**FPL:REQ-016, refresh and freshness.**
- The list is read:
  - when the place opens;
  - after any SFlow change made in this window (`refreshAfterKnownMutation`);
  - when a local Story's `workflow.json` changes (the existing watchers);
  - every 5 minutes while VS Code has focus;
  - and on Refresh.
- The 5-minute read waits for the background governor (`BackgroundWorkGovernor`), so it never competes with a Story
  start or the intake form. Refresh never waits.
- The list paints first from the last read, with its time: "Checked 10:42 · 3 repositories".
- A repository that cannot be read keeps its last-known items and gets one line: "shop-api could not be read (offline);
  showing 10:31". The others are never hidden by it.
- `needs-you --offline` reads only what is kept and fetches nothing.

**FPL:REQ-017, scale.**
- Kept per repository and identity: the state index's commit and, for each in-progress Story, the object ID of its
  `workflow.json` with the items computed from it. A Story whose `workflow.json` did not change costs no read on the
  next refresh.
- Repositories are read 3 at a time, as VS Code reads them for the Stories page.
- Budgets on the host test machine:
  - a list for 20 repositories and 400 in-progress Stories paints from what is kept in under 500 ms;
  - one card opens in under 2 s.
- More than 50 items shows the first 50 and "Show 23 more".

**FPL:REQ-018, the badge.**
- The activity-bar badge counts Holds work and Reviews items. Later items are not counted.
- It is the view's badge (`WebviewView.badge`), with the tooltip "3 things need you". A screen reader reads it as
  "Needs you: 3 waiting".

### 3.4 Rules

**FPL:REQ-019, the list.** Rules shows:
- the built-in rules:
  - every code change gets tests;
  - a person approves the code;
  - a person approves a plan where there is one.

  They are marked **Built in** and have no Change (ITW §9, question 3).
- every `tasks:` rule in the approved configuration, as "When … Then …", with its `because`. Each kind of rule reads:
  - `always`: "any code changes" or "a task is a feature";
  - `paths`: "a task touches src/auth/**";
  - `use`: "a task is a change", then "Follow the workflow Classic delivery".
- each rule that waits for review, marked **Waiting for review**, with who proposed it;
- the ID prefix ("Tasks are named TASK-<n>"), with Change.
- **How SFlow composes a task**: the kinds and their steps, read from `KIND_STEPS`.
- **Workflows**: one line linking Workflow Studio under Advanced, for work a team must always do one way.

**FPL:REQ-020, adding or changing a rule.** The form asks:
- **When**:
  - any code changes;
  - a task is of these kinds;
  - a task touches these files (globs).
- **Then**:
  - add a step, from requirements, design, plan, review and test;
  - a person approves a step;
  - follow a workflow. Only with "a task is of this kind", and only a workflow of this repository.
- **Why**: one line, required. It becomes `because`, and it is what a refused "skip the tests" says (ITW REQ-004).
- The form offers only what `taskRules` accepts. A kind, step or workflow that does not exist is never in a list. The
  topic's example `use: { release: classic-delivery }` names a kind that does not exist, so it is corrected as part of
  M3.

**FPL:REQ-021, what a rule adds.** Beside the form, a preview from `rules preview --change-set - --json` (§4):
- one line for each kind the rule affects: the steps before and after, the added ones marked. For example "A fix
  touching src/billing/x.ts: Intake → Code → Tests → Billing review → You approve the code";
- "No other kind changes";
- for a removed rule, every step it would stop adding.

The preview is pure: it runs `composeTask` with and without the change on the candidate configuration. It reads no
marketplace and makes no network call.

**FPL:REQ-022, the reviewed path.**
- **Propose this rule** sends one change set through `workflow studio apply --change-set - --propose`. That reaches
  `proposeConfigurationChange`, like every other configuration change. It uses new operations: `tasks.rule.add`,
  `tasks.rule.change`, `tasks.rule.remove` and `tasks.idPrefix.set` (§4).
- Nothing writes `singularity/workflow.yml` directly, except where the repository's configuration authority is local,
  exactly as for any Studio change today.
- The proposal is a Review item in the Needs you of each person who may approve it. It applies once approved.

**FPL:REQ-023, checked before it lands.**
- `taskRules` collects every problem, each with where it is (`tasks.paths[1].because`), not only the first.
- `workflow check`, a configuration save and `configuration approve` run it. Today none does, so a broken rule lands and
  then breaks every `work`.
- A problem in a rule the change did not touch is a warning, so an already-approved configuration does not turn red.
- A problem in a rule the change adds or changes refuses the proposal.

**FPL:REQ-024, stable names.**
- A rule written by the Rules place gets an `id` (a slug of its when and then), so a Story's records name the rule by
  its ID, not its position (`always[0]`).
- Rules without an `id` keep their position names. Stories already recorded are read as written.

**FPL:REQ-025, tasks in flight keep their rules.**
- A task takes its rules from the configuration it started with, as today.
- The Rules page says "4 tasks in flight keep the rules they started with" when a proposal is approved.
- `work add` on those tasks still refuses with today's words when the rules changed under them, and gives its complete
  restart command (ITW REQ-009).

**FPL:REQ-026, Rules stay rules.**
- Rules lists only rules that add steps or approvals.
- Lessons a team marked as rules (LRN) are guidance that agents read, not steps. They are not listed here. One line,
  "Guidance the agents read: 3 lessons", links the Lessons page.
- People and approval groups and the Constitution stay in Advanced. The Rules page links both, and a rule's approver
  links People.

### 3.5 Library

**FPL:REQ-027, one list.**
- Library lists the repository's skills and agents and those of every trusted marketplace, in one list.
- It has a search, and filters: All, This repository, one for each trusted marketplace, and Updates.
- Each row has:
  - the name;
  - Skill or Agent;
  - where it comes from, with its version;
  - one line of what it does;
  - one state line.
- The Library page is today's Marketplace page (`marketplace-page.ts`), with its right-hand column:
  - **Marketplaces you trust**: Read its newest commit, Browse, Trust another marketplace;
  - **Feedback for <marketplace>**;
  - **Add your own agent folder…** (`singularityFlow.addUserAgent`).
- It is read from `marketplace catalog --json`, joined with `skill catalog --json` for what each row is used by. An
  untrusted marketplace is never read.

**FPL:REQ-028, states.** A row's state line is one of:
- "Update available", with what changed;
- "Waiting for review": an import or update proposal is open. Today `marketplace catalog` cannot say this; it gains it
  from `workflow proposals` (§4);
- "Beta: SFlow asks before using it", or "Proposed: not yet reviewed by its maintainers", from `lifecycle` and
  `readiness`;
- "Used in 4 tasks", or "Not used yet";
- "Not approved yet": a marketplace that only the working copy trusts.

**FPL:REQ-029, actions through the reviewed path.**
- Install, Update, Get newer, Remove and Open keep today's routes. Each goes through Workflow Studio's preview and a
  proposal (`studioTargetFor`).
- The Library writes nothing itself. A new install appears as "Waiting for review" and as a Review item in its
  approvers' Needs you.

**FPL:REQ-030, updates.**
- `imports check --json` runs when the Library opens, at most once a day per repository, under the background governor.
  **Check now** runs it at once.
- What it finds shows on the rows and in one line on Work ("1 update from acme: requirements-writer changed").
- An update is not a Needs-you item until someone proposes it.

**FPL:REQ-031, feedback.**
- An agent's conversion feedback (MCR §6) shows in the Library's column with today's three actions: Open an issue,
  Copy, and Save as Markdown.
- "You submit the issue in your browser. SFlow never posts it."
- Feedback on a single skill is not in v1.

### 3.6 Advanced

**FPL:REQ-032, today's Navigator, whole.**
- **Advanced** (the title action, and the last row under the tabs) shows today's Navigator in the same view:
  - its main menu, context, pins and footer menus;
  - rendered by today's `sidebarBody`, unchanged;
  - with **← The four places** at the top.
- Every destination it reaches today, it reaches the same way.

**FPL:REQ-033, the palette is unchanged.**
- All 200 commands keep their titles and palette visibility. Context-menu and editor-title entries stay as they are.
- New commands open each place: `singularityFlow.places.work`, `.needsYou`, `.rules`, `.library` and `.advanced`.

**FPL:REQ-034, the setting.**
- `singularityFlow.navigation.layout` is `places` (the default) or `classic`.
- `classic` makes today's Navigator the view's first screen, with the four places one row away.
- The setting changes no data and no command.

**FPL:REQ-035, the map.**
- One module, `places-map.ts`, says for every command and every Navigator, Studio and Configuration destination where a
  person finds it: a place, Advanced, or both.
- A host test fails when a command is added to `package.json` without a line in it. §5 is the map in words.

### 3.7 Words and access

**FPL:REQ-036, plain words.** This follows ITW REQ-012 and the decision card's plain words:
- Names and versions, never:
  - a step ID, a digest, a commit, a ref or a branch's internal name;
  - "phase", "generation" or "work item".
- A step is its label. A version is "version 2". A task is "TASK-12".
- A card asks one question, which ends with "?". Its choices are verbs that say what they do.
- A refusal says what is needed, why, and the one thing to do. That is a button, or a complete command with nothing
  left to fill in but the person's own words (no composed commands).
- Times are "10:42", "yesterday" or "Monday". Counts are words a person reads aloud.
- The same item says the same words in VS Code, in `/sf-inbox` and in the terminal: one builder, `decision-plain.mjs`
  and the approval focus.

**FPL:REQ-037, accessibility.**
- **The tabs** are an ARIA tablist. Arrow keys move between them, Home and End jump, Enter and Space open, and the open
  tab has `aria-selected`.
- **Chips** carry their state in words as well as colour ("Tests, running now"; "You approve the code, waits for you").
  The arrows between chips are hidden from screen readers, and the chip line is an ordered list.
- **Cards:** the question is the page's first heading and takes focus when the card opens. The result of a choice is
  announced (`role="status"`). Every button is named by its effect.
- **Rules form:** every field has a label. Problems are linked to their field (`aria-describedby`). The preview is
  announced politely.
- **Colour and theme:** only VS Code's theme colours (`--vscode-*`, `CALM_PALETTE_STYLE`). Text contrast is at least
  4.5:1 in light, dark and high-contrast themes.
- **Width:** the sidebar works from 220 to 600 px, and editor pages from 320 px, with no sideways scroll.
- **Behaviour:** nothing is shown only on hover, and nothing moves when the person prefers reduced motion.

### 3.8 Copilot CLI and IntelliJ

**FPL:REQ-038, Copilot CLI.**
- **Work:** `/sf-task <words>`, as today. `/sf-task` with no words and no task open here lists the person's tasks in
  flight from `work list`, instead of only asking for words.
- **Needs you:**
  - `/sf-inbox` runs `needs-you --json` and lists the same items, in the same order and words, then offers to take the
    first.
  - An item in this repository goes on with `/sf-approve <ID>` or `/sf-decide <ID>`, and the Copilot CLI decisions card
    where that is used today.
  - An item in another repository gives its route: `workspace use` and `session open`, from `storyCheckoutRoutes`.
- **Rules:** a plain chat question ("what are our team rules?") is answered from `rules --json` through `/sf-explain`'s
  topic route. A rule is changed in VS Code, or by a proposed save of `workflow.yml` in the terminal (`configuration
  save … --propose`). There is no new skill.
- **Library:** `/sf-marketplace`, as today.

**FPL:REQ-039, IntelliJ.**
- GitHub Copilot in IntelliJ gets the same skills, so `/sf-task`, `/sf-inbox` and `/sf-marketplace` read the same.
- Recording a yes in a chat needs SFlow's hooks, and IntelliJ's Local agent does not run them today. So in IntelliJ a
  choice is given as the person's own terminal command, with every value filled in (SF Guard signs there), or as "open
  it in VS Code".
- The read-only IntelliJ panel (branch `intellij-plugin`, not merged) can show `needs-you --json` later. It is not in
  v1.

## 4. The engine behind each place

| Place | Read or write | Today | What changes |
|---|---|---|---|
| Work | `work "<words>" --json --plan-only` | `work` without `--start` plans, but runs the skill and agent choosers, which can read marketplaces | New option: `composeTask` and `planLine` only, no choosers, no network |
| Work | `work list [--offline] --json` | none. VS Code joins `session candidates` rows for the Stories page; the Story index lists this computer's checkouts | New: this person's Stories in flight and those done this week, across the workspace (`listStoryIndex` plus each member's `session candidates`), each with its `work status` steps |
| Work | `work status <ID> --json`, `work add <ID> --add STEP`, `cancel <ID> …` | exist | none |
| Needs you | `needs-you [--offline] [--refresh] --json` | `inbox` (one repository, everyone), `home` (approvals, one checkout) | New, `src/needs-you.mjs`. It reuses `discoverRemoteStoryCandidates`, `matchApprovalAuthority`, `remainingRequiredAuthorities`, `presenceCounts`, `mayDecideApproval` (exported from `gateway/work-records.mjs`), `readPendingList` and `waitsOnPerson`, and the approver rules of `config-approvers.mjs`. Result `sflow-needs-you`: `person`, `scope.repositories[{id, name, read: fresh\|kept\|failed, at, why?}]`, `items[{key, kind, group, repository, story, step, question, why, waitingSince, recommended, checked[], choices[], route}]`, `otherWorkspaces` |
| Needs you | `needs-you show <KEY> --json` | the approval page and Decide card read one Story in the window's checkout | New: one card's full content (REQ-013), read in the Story's place (REQ-014) |
| Needs you | approve, decide, return, choose, approve a proposal | `choices begin approve`, `guard card …`, `approve`, `reject`, `decisions record`, `decision choose`, `configuration approve`, `initiative choices …` | none. The approval page and Decide card take a repository and a Story instead of the window's snapshot |
| Rules | `rules [--json]` | `taskRules` (stops at the first problem, returns a string) | New read: built-in rules, `tasks:` rules in plain when and then, open proposals that touch `tasks:` |
| Rules | `rules preview --change-set - --json` | none | New, pure: every kind composed with and without the change, and every problem with its field |
| Rules | `workflow studio apply --change-set - --propose` | the reviewed write path, with no `tasks` operation | New operations `tasks.rule.add`, `tasks.rule.change`, `tasks.rule.remove`, `tasks.idPrefix.set`, written in place with the YAML's formatting kept |
| Rules | `workflow check`, `configuration save`, `configuration approve` | do not check `tasks:` | Run `taskRules` (REQ-023) |
| Library | `marketplace catalog --json` | rows, statuses, updates, actions | Gains `used {tasks, workflows, agents}` from `skill catalog`, and the status `waiting-for-review` from `workflow proposals` |
| Library | `skill catalog --json`, `imports check --json`, `workflow from-agent M/A --review --json` | exist | none |

`inbox` keeps its output for scripts and today's Inbox page. About ten test files and the `/sf-inbox` skill call it
today, so it is left alone; `needs-you` is the person's read, and `/sf-inbox` moves to it.

## 5. Where today's views and commands land

Every command stays in the palette with its title (REQ-033). This table says where a person also finds it in the new
sidebar. The last column is where it is today: today's Navigator, now under Advanced, or the palette and the editor's
menus. A command that is only in the palette today stays only there. The command IDs drop the `singularityFlow.`
prefix.

| Today | Commands | In the four places | Advanced and the palette |
|---|---|---|---|
| Starting and following work (13) | startTask, startWork, myWork, openWorkspaceStories, openJourney, openStoryIntake, openProgress, openPhaseArtifacts, refresh, returnToWork, continueSafely, cancelWork, openCopilot | **Work**: the box (startTask), Start with a workflow… (startWork), In progress (myWork), All Stories (openWorkspaceStories), the task page's Open in Copilot chat (openJourney's route, openCopilot), Documents (openPhaseArtifacts), its intake (openStoryIntake), Stop the task (cancelWork); Refresh is the header's | Main menu and Work tools, as today |
| A Story's step actions (14) | prepareStoryPhase, publishStoryPhase, submitStoryPhase, prefillStoryPhaseGeneration, prefillNextCommand, runAction, reopenCompleted, rollForwardRework, reviewStoryTestRecovery, changeTestScope, resolvePhaseIssues, openMeteredCopilot, takeoverStory, attachSessionToWorkspace | The task page's Open in Copilot chat is the daily route | Work tools › Current work actions & artifacts, as today |
| Deciding and approving (12) | approve, decide, decisions, decideStory, adjudicate, reviewWitness, openApprovals, openInbox, openReviews, openConfigurationApprovals, reviewCapabilityProposals, sfGuard | **Needs you**: each card is the approval page, the Decide card, the decision list, the adjudication or the evidence sign-off for one item; Reviews, configuration approvals and capability proposals are Review items | Main menu (Reviews), pins (Inbox, Approvals, Configuration approvals), as today; the rest, including SF Guard, in the palette |
| Workflows and who approves (7) | openWorkflowStudio, openDesigner, configurePeople, openConstitution, importTeamWorkflow, publishConfiguration, openSharedWorkflowDrafts | **Rules** links Workflow Studio (Workflows), People and approval groups, and the Constitution | Workflow Studio's 11 views, as today |
| Skills, agents and instructions (10) | marketplace, allSkills, openSkills, openInstructionDesigner, openReusableInstructions, addUserAgent, openApmPackages, configureTemplates, configureMcp, lessons | **Library** is the Marketplace page (marketplace) with All skills' columns (allSkills); a row opens Studio's Skill master or Agents (openSkills); Add your own agent folder (addUserAgent) is the Library's | Studio's Instructions, Artifacts, Integrations and Library; Agent packages; Lessons (also on Work's task page) |
| Configuration (18) | openConfigurationCenter, configureTests, configureAuto, configureWorldModel, configureAstIntelligence, configureModels, configureModelMode, configureProfile, choosePersona, manageFavorites, connectJira, resetJira, configureTeams, resetTeams, togglePromptLog, countCopilotChatUsage, stopCountingCopilotChatUsage, openEnvironmentFiles | none | Main menu (Configuration) and its 8 tabs, the profile button, pins, the Prompt log switch, as today |
| Workspaces and setup (30) | openWorkspaces, createWorkspace, adoptWorkspace, switchWorkspace, switchWorkspaceRepository, openWorkspace, startWizard, openWalkthrough, mapCapability, onboardTeam, fastOnboardRepository, init, smartInit, addCapability, editCapability, openCapabilities, resumeWorkspaceBootstrap, workspaceDoctor, repairWorkspace, checkoutInventory, cleanupCheckouts, cleanupRetention, runRetention, executionContext, checkRepository, refreshAuthorityPin, bootstrapLocalAuthority, useOfflineAuthorityPin, configureGitAcceleration, clearDerivedCache | The header's workspace line (switchWorkspace, switchWorkspaceRepository, openWorkspaces); a window with no workspace shows Guided start (startWizard) in place of the tabs | Main menu (Workspaces), context, pins, as today |
| Updates, repair and help (24) | updateSflow, upgradeOrRepair, refreshCapability, upgradeWorkspaces, afterInstall, about, reinitializeWorkspaces, refreshRepositorySetup, repairRepositorySetup, factoryReset, openLocalReset, openHelp, explainTopic, explainError, copyHelpCommand, prefillHelpAction, openHelpTopicFromChat, askSFlow, openDeveloperHome, resetGuideSession, doctor, openDiagnostics, openFaultRepairs, openCopilotExtensions | The header's Ask SFlow (askSFlow); refusals keep their Explain error and help links | Help & diagnostics, as today |
| Activity and logs (10) | openActivityLog, openPerformanceReport, openWorkspaceLogs, refreshWorkspaceLogs, openPromptAudit, showPrompts, openJournal, inspectCompositionCache, checkLedgerDeployment, openHarnessReport | none | Activity & logs, as today |
| Understanding code and changes (17) | openChangeExplorer, openCodeExplainer, openCodeExplanation, openRepositoryKnowledge, reviewRepositoryKnowledge, showPhaseBrief, openComprehensionCenter, explainFileChanges, explainChangeAtCursor, explainCodeAtCursor, previewSelectedImpact, showImpact, openImpact, impactForm, openFlowImpact, expandReference, openSpecificationTrace | Work's task page: Explain the change (openCodeExplainer, My change). The editor's context menus are unchanged | Work tools › Understand changes, as today |
| Evidence, review and delivery (22) | openEvidenceMatrix, attachEvidence, manageEvidence, detachEvidence, addSource, openVisualAssurance, applicationReview, openOutcomeReview, guideDeliveryValidation, openReconciliation, openInvestigation, openContextReceipt, openHandoff, openArtifact, findings, uploadFindings, openGoals, openDashboard, openStories, openSpecStudio, openBrowserWorkspace, openAdhocWork | Work's task page opens a step's document (openArtifact) | Work tools and pins, as today |
| Run and test (19) | workspaceRunTest, startApplication, runTests, testSummary, editRunConfigurations, selectRunConfiguration, runSelectedConfiguration, debugSelectedConfiguration, stopRunningConfiguration, rerunSelectedConfiguration, runConfiguration, debugConfiguration, stopConfiguration, openConfigurationInBrowser, showConfigurationLog, editConfiguration, copyConfigurationCommandLine, runConfigurationInEnvironment, refreshRunConfigurations | The Run view, unchanged | Run & Test in the context section, as today |
| Execution workflows (4) | openCommandCenter, createSgosWorkflow, reviewSgosMetaTool, reviewLocalRunner | none | Work tools and pins, as today |

The rows add up to 200, the commands contributed at `main@5ac41f37e`. The Navigator's own rows, all reached under
Advanced as today, are:
- the 7 main-menu rows;
- the context section's Run & Test and intake details;
- the 40 shortcuts;
- the 32 footer-menu entries;
- the Prompt log switch.

Studio's 11 views and the Configuration Center's 8 tabs open as today.

## 6. Boundaries

### 6.1 What stays as it is

- Every approval, decision and review is recorded by today's commands, with their checks, SF Guard signatures and
  answer binding. Needs you adds a list and a card, never a way to record.
- Workflows, Workflow Studio, `/sf-start`, `/sf-auto` and the Configuration Center stay, under Advanced. A built-in or
  custom workflow runs exactly as defined; nothing in this spec changes how a chosen workflow's steps run (owner,
  2026-11-26).
- `inbox`, `home` and their pages stay, under Advanced.
- No step ID, hash or "resume" is typed anywhere (ITW REQ-008).

### 6.2 Not in v1

- The browser workspace (`src/local-ui`, redesigned 2026-11-23) in the four places. It can read the same engine
  commands later.
- Other workspaces in Needs you (§11, question 1).
- Feedback on a single skill. A notice when a newer marketplace commit changes a skill in use (MCR:REQ-031) before the
  Library is opened.
- An IntelliJ panel.
- Recording a pending chat question as an item. Only the intake's required answers are derived (REQ-008).

### 6.3 Differences from the concept boards

| Board | Shows | Here |
|---|---|---|
| Task | Pause | No Pause: nothing of a task runs between chat turns. Stop the task is today's cancel |
| Home, Task | the plan ends in "Pull request" | A task ends with the checked change on its branch; the pull request is a step only when asked (ITW REQ-018) |
| NeedsYou | "Add a skill from acme?" as a card | The first-use yes is asked in the task's chat; its import proposal is the card, for the configuration's approvers |
| Rules | badges such as "Added by the Security group" | The rule's `because` line, and "Waiting for review" with who proposed it. A Git author is not a group |
| Rules | "Then: add a review by a group" | Needs a new `by:` field (§11, question 3) |
| Main | Configuration, Diagnostics, Journal, Help and Run in a settings menu | They are under Advanced, which is today's Navigator, so nothing moves twice |

## 7. Acceptance

Host tests use the page builders and the engine on fixtures. Each test runs with isolated machine state
(`MACHINE_STATE_LOCATIONS`), never this computer's own. "Real VS Code" is the isolated instance driven over CDP, as the
repository's VS Code checks are.

**Needs you**
- **A1:** On a fixture workspace of three repositories (one not cloned) and eight Stories, `needs-you --json` lists the
  test person's items and only those:
  - **listed:**
    - a plan approval (repository A);
    - a workflow decision (B);
    - a refactor's behaviour choice on a Story checked out here (A);
    - a rule proposal they may approve (C, read from its remote URL);
  - **not listed:**
    - an approval they already gave;
    - one they submitted, where the self-approval rule refuses them;
    - one for a group they are not in;
    - an optional item and a settled item.
- **A2:** The order is Holds work (oldest first), then Reviews, then Later. The same records give the same JSON, times
  aside.
- **A3:**
  - With B unreachable, A's and C's items still show, with one line for B and its last-known time.
  - `--offline` fetches nothing; a probe counts zero Git fetches.
- **A4:** Every card's choices are the engine's available ones, and its first choice is the recommended one. A test runs
  each choice's command on the fixture. None is refused for a reason the card could have checked.
- **A5:** Approving the plan from the card records through `choices begin approve` and then `approve
  --selection-receipt`, with the `vscode-approval` SF Guard surface where the policy signs.
  - The item leaves the list and the badge drops by one.
  - For a task checked out in this window, the chat receives `/sf-task`.
- **A6:** A second refresh with no Story changed reads no `workflow.json`. A 20-repository, 400-Story fixture paints
  from what is kept in under 500 ms, and a card opens in under 2 s.
- **A7:** The badge equals Holds work plus Reviews, and is read as "Needs you: 3 waiting".

**Work**
- **A8:** Start sends exactly `/sf-task <words>`. For each of the nine kinds' journey sentences, the likely plan equals
  the plan line of the journey's chat.
- **A9:**
  - In progress lists this person's Stories across the fixture's repositories, with chips equal to `work status` steps.
  - A Story with an item in Needs you says "Waiting for you: …" and opens that card.
- **A10:**
  - Add a step runs `work add` and shows its refusal's one route.
  - Stop the task runs `cancel` after its confirmation.
  - Open in Copilot chat sends `/sf-task` for a task, and the Journey's route for a classic Story.

**Rules**
- **A11:** `rules --json` lists the three built-in rules as fixed and every `tasks:` rule as plain when and then, with
  its `because`.
- **A12:** Adding "touching src/billing/** adds a review" makes one Studio change set and one proposal through
  `proposeConfigurationChange`; `workflow.yml` on the configuration branch does not change before approval. The preview
  shows fix and change tasks touching `src/billing` gaining the review step, and no other kind changing.
- **A13:**
  - A broken rule is refused before the proposal, with every problem and its field.
  - `workflow check` reports a broken `tasks:`. Today it does not.
  - An untouched broken rule is a warning.
- **A14:** For every kind and every rule in the fixture, a rule's addition adds and never removes a step. Removing a
  rule is a proposal whose preview names each step it stops adding.
- **A15:** Tasks in flight keep their rules after a rule change is approved. The page says how many.

**Library**
- **A16:**
  - The Library lists the repository's and each trusted marketplace's skills and agents, with "Used in N tasks" and a
    state line.
  - An untrusted marketplace is never read.
- **A17:** Installing from the Library goes through the import preview and a proposal. The row reads "Waiting for
  review" until it is approved, and the proposal is a Review item in an approver's Needs you.
- **A18:** `imports check` runs at most once a day per repository, and never while a Story starts.

**Advanced**
- **A19:** `contributes.commands`, `menus.commandPalette` and every other menu in `package.json` are as before, apart
  from the five new commands.
- **A20:** Every Navigator destination, Studio view and Configuration tab is reached from Advanced in at most two
  clicks. `places-map.ts` names every command, and the test fails on one it does not name.
- **A21:**
  - Advanced renders today's `sidebarBody` output, byte for byte, for the same inputs.
  - `classic` shows it first.

**Words and access**
- **A22:** None of the four places' rendered pages, for the fixtures, contains a step ID, a digest, a commit, a ref, or
  the words phase, generation or work item.
- **A23:** The tabs, chips, cards and form have the roles, names and states of REQ-037. The real check runs light, dark
  and high-contrast themes at 260 px and 480 px sidebar widths.

**Other hosts and journeys**
- **A24:** `/sf-inbox` in Copilot CLI lists the fixture's items in the VS Code tab's order and words. It offers the
  first as `/sf-approve`, `/sf-decide`, or the route to the other repository. In IntelliJ the same list reads, and a
  choice is given as the person's own terminal command with every value filled in.
- **A25:** The route follower walks a fix from the Work box to its checked change. The person takes 4 actions: the
  words, the intake's answer and two Yeses, one of them from Needs you. Mechanical actions are zero (ITW REQ-019).
- **A26, real VS Code**, with a two-repository workspace:
  - the SFlow icon opens on Work, with the badge;
  - Needs you lists items from both repositories;
  - one approval from the card completes, on a policy SF Guard does not sign or with the owner's touch;
  - Rules proposes a rule, and it appears in Needs you;
  - the Library shows an update;
  - Advanced shows today's Navigator.

## 8. Milestones

| Milestone | Scope | Size |
|---|---|---|
| M1 | Probes (§9). The Needs-you read: `needs-you`, `needs-you show`, what is kept and its freshness, Initiative approvals moved into the engine. The approval page and Decide card bound to an item's repository and Story. The Needs-you tab, its card page and the badge. `/sf-inbox` on the new read, in Copilot CLI and IntelliJ (REQ-008 to 018, the Needs-you part of 038, 039, A1 to A7, A24) | about 2 weeks |
| M2 | Work: the box with its likely plan (`--plan-only`), `work list`, In progress, the task page, done this week, `/sf-task` with no words listing tasks in flight (REQ-004 to 007, the Work part of 038, A8 to A10). Built 2026-11-26 on `fpl-m2` | about 1 week |
| M3 | Rules: `rules`, `rules preview`, the `tasks.*` Studio operations, `taskRules` in check, save and approval, rule IDs, the Rules tab and page, the topic's corrected example (REQ-019 to 026, A11 to A15). Built 2026-11-27 on `fpl-m3` | about 1 week |
| M4 | Library: the Marketplace page as the Library, used-by counts, waiting for review, daily updates, the feedback column, the Library tab (REQ-027 to 031, A16 to A18) | 3 to 4 days |
| M5 | Advanced and the switch: the four places as the default, Advanced as today's Navigator, the layout setting, title actions, `places-map.ts` and its test, walkthrough and help topics (REQ-001 to 003, 032 to 035, A19 to A21) | about 3 days |
| M6 | Polish and journeys: the plain-words and accessibility pass, journeys with action counts, the real VS Code check, bundle budgets (REQ-036, 037, A22, A23, A25, A26) | about 4 days |

About 5½ to 6 weeks.
- Each milestone lands on `main` with the four places off until M5 switches the default, so `main` stays shippable.
- M1 comes first because Work's status lines and the Rules and Library proposals all point into Needs you.

## 9. Probes before building (first two days of M1)

1. `WebviewView.badge` shows on the SFlow activity-bar icon in VS Code from 1.90 (the extension's minimum), and a screen
   reader reads it.
2. One webview with four tabs against four webview views: activation time and memory in real VS Code. The spec assumes
   one.
3. A fresh Needs-you read of five repositories on the office network: one ledger fetch each, three at a time, with its
   p50 and p95.
4. An approval from a card that checks a Story out in another repository's clone: what VS Code's Source Control,
   watchers and open editors do when that clone is a folder of this window.
5. `workbench.action.chat.open` from a card in a multi-root window reaches the chat the person used last.
6. `/sf-inbox` in IntelliJ's Copilot chat: the read works there without SFlow's hooks.

A probe that fails changes this spec before the rest of M1 starts.

## 10. Risks

- **Reads across repositories cost fetches.** One ledger fetch per repository, plus `workflow.json` reads for
  in-progress Stories.
  - Mitigations: what is kept per Story (REQ-017), the background governor, `--offline`, and a line for each repository
    that failed.
  - A later version could carry "who acts next" in the ledger's summary (`storyLedgerSummary`) to skip the
    `workflow.json` reads. That changes the ledger entry, so it is not in v1.
- **Acting on another person's Story checks it out in a clone.** That is today's approver path, and it refuses when the
  clone holds uncommitted work (§11, question 2).
- **Identities differ by repository.** Each repository is judged with its own identity (REQ-009), so one person can see
  an item in one repository and not in another. The card names the identity it used.
- **"Could not tell" items** add noise. They are labelled, and the real check decides.
- **Two layouts.** Advanced reuses `sidebarBody` unchanged, and A21 holds it byte for byte, so the old layout cannot
  drift.
- **The likely plan can differ from the chat's.** The agent names the kind, and the preview guesses it. A8 holds the
  journeys' sentences equal, and the chat's plan line is the plan.
- **Stricter `tasks:` checks** could turn existing configurations red. Untouched rules give warnings only (REQ-023).
- **Bundle size and activation.** The places load lazily, as other panels do (`lazyPanels`). The bundle-budget test
  bounds them.
- **The same name for two things.** LRN's "Team rule" button and the Rules place both say "rules" (§11, question 4).

## 11. Open questions for the owner

**Decided 2026-11-26, each on its default:** 1 the active workspace; 2 today's approver path; 3 yes, `by:` that only
adds a group; 4 rename to "Team guidance".

1. **Other workspaces.** Default: Needs you reads the active workspace's repositories and says how many other workspaces
   it did not read. The alternative is to read every workspace on this computer, at a fetch per repository.
2. **Approving another person's work.** Default: today's approver path, which checks the Story out in that repository's
   clone and refuses when the clone has uncommitted work. The alternative is a separate review checkout for each
   approval, as Epic review uses (`src/epic-review.mjs`). It touches nothing of the person's own work, but it is a
   second checkout of the Story on this computer, which the Story index forbids today.
3. **A rule that names who approves** ("touching src/payments needs Security's approval"). Default: yes, a new `by:
   <group>` on `always` and `paths` rules, which can only add a group that must also approve. The alternative is
   "a person approves", with the step's existing approvers only.
4. **LRN's "Team rule" button.** Default: rename it "Team guidance", so that "rules" means only rules that add steps.
   The alternative is to keep both names.
