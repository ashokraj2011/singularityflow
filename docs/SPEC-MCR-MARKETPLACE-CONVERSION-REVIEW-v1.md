# Marketplace Conversion Review (MCR) — v1: a correct import, a safe update, and feedback for the marketplace

**Specification ID:** `MCR-v1`

**Status:** Built 2026-11-23 (owner: "Build MCR this is very important"; the §12 questions kept their defaults). M1 and M2 in e615edfa1; M3 (provenance, Check for updates, Update) after it. Owner direction, 2026-11-23: "it is important to make sure the import is correct and
an update will be fine .. maybe need a proper screen to make sure the conversion is right and what sflow corrects and
give the feedback to marketplace stakeholders", then "create a spec and keep it".

**Builds on:** [TAWI-v2](SPEC-TAWI-TEAM-AGENT-WORKFLOW-IMPORT-v2.md) (agent to workflow bundle, import through the
transfer review), the marketplace agent conversion (`src/agent-workflow.mjs`, `src/agent-workflow-bundle.mjs`,
`workflow from-agent`), repository marketplaces (`marketplace add --repo`, `src/commands/marketplace-repository.mjs`),
Workflow Studio's **Make a workflow** card (`apps/vscode/src/views/workflow-studio-page.ts`), and the custom workflow
check (`src/custom-workflow-health.mjs`).

---

## 1. Why

A marketplace agent is a kind of workflow. SFlow converts it once into an SFlow workflow, which a team then imports
and every new Story uses. The conversion makes real decisions:
- which step each stage becomes, and what each step is for;
- what a hard gate becomes;
- which skills attach where, and when;
- which steps SFlow must add.

Today a person sees those decisions only as a short card and a few free-text notes. Three things follow:

1. **Nobody can easily confirm the conversion is right.** The person approves an import without seeing stage by
   stage what became of the agent.
2. **What SFlow corrected is invisible to the marketplace.** The conversion already finds problems that belong to
   the marketplace: a skill a stage names but the agent does not depend on, a dependency no stage uses, a stage it
   cannot classify. They stay in the importer's notes, and the next team meets them again.
3. **An update is blind.** The imported workflow keeps only a description line ("From marketplace X: agent 1.2.0").
   Nothing records the commit or the bytes it came from, so SFlow cannot say an agent changed, nor show what changed.

## 2. What exists today (checked against `main` ddab68a07)

| Piece | Where | What it does |
|---|---|---|
| Conversion | `convertAgent` in `src/agent-workflow.mjs` | Stages become steps, intents come from pdlc-tasks, stage names and the step-intent rules, gates become questions or approvals, skills attach per answer. Returns `source` {marketplace, repository, commit, agent, version, lifecycleState, pdlcPhases, pdlcTasks}, `steps`, `added`, `open`, `questions`, `storyValue` and free-text `notes`. |
| Bundle | `src/agent-workflow-bundle.mjs` | Lays the workflow out (templates with "Stage N of agent (marketplace/agent)" guidance, skill attachments) and compiles the portable bundle. |
| Studio card | `renderAgentWorkflow` in `workflow-studio-page.ts` | Steps with intent and why, skills, questions, `Note:` lines, and one-click choices for the first open stage, then **Import…**. |
| Import review | the transfer panel (TAWI) | Shows the bundle's differences against the repository; a person approves. |
| Marketplace pin | `marketplace add --repo`, **Read its newest commit** | A repository marketplace is trusted at one commit and repinned on request. |
| Running Stories | workflow snapshot | A Story keeps the workflow and skills it started with, verified by digest. |
| Custom workflow check | `custom-workflow-health.mjs`, `workflow fix` | Checks non-shipped workflows once per SFlow build and offers fixes. |

**Missing:**
- provenance kept with the import;
- findings as structured data, each with an owner;
- a review screen that shows stage by stage what the agent became;
- feedback a person can hand to the marketplace;
- update detection, and a review of only what changed.

## 3. Terms

- **Conversion:** the result of `convertAgent` for one agent at one marketplace commit, with the person's answers.
- **Finding:** one thing the conversion decided, changed, could not decide, or found wrong. It has a class (§5) and an
  owner: **the marketplace** (fix it there) or **SFlow** (SFlow's own choice, nothing to fix).
- **Provenance:** where an imported workflow came from, recorded at import (§7).
- **Update:** the same agent at a newer marketplace commit, converted again with the same answers.

## 4. The Conversion review screen

One screen in Workflow Studio, opened by **Make a workflow**, by **Update** (§8), and by Library's **Review
conversion** on an imported workflow. The same content is a Markdown review for Copilot (`/sf-import`) and the
terminal (`workflow from-agent <agent> --review`).

Sections, in order:

1. **Where it came from.** The marketplace, repository and commit; the agent's name and version; its lifecycle state,
   in words ("proposed: not yet reviewed by its maintainers"); its maintainer, from its `apm.yml`.
2. **Agent stage → SFlow step.** One row per stage, side by side:
   - the stage's number and title, its hard gate and its skills per answer;
   - the step it became, with what the step is for and why (the `because:` the conversion records);
   - what its gate became: the person's questions, or the step's approval;
   - which skills attach, and when ("when channel is web").

   A merged stage shows on the step it joined. A step SFlow added shows with no stage, marked **Added by SFlow**.
3. **What SFlow changed.** Every finding of class `sflow-*` (§5), each in one sentence with its reason. Examples:
   added steps, merged stages, skills left out, answers that stay questions, renamed IDs.
4. **Needs your answer.** Each stage SFlow could not classify, with one-click choices (today's `open` and `answers`).
   It asks the person; it never guesses.
5. **Checks.** The checks every custom workflow passes (the import's validation and `custom-workflow-health`), run
   on the converted bundle before import, each green or red with its fix.
6. **Feedback for the marketplace.** The findings the marketplace owns (§6), with **Save as Markdown**, **Copy** and
   **Open an issue**.
7. **Import.** Enabled only when nothing needs an answer and every check passes. It opens the transfer review as
   today.

## 5. Findings

The conversion returns structured findings in place of free-text notes. Today's notes become findings, and the
words stay the same. Each finding has `{ id, class, owner, stage?, step?, skill?, words, fix? }`.

| Class | Owner | Today's note it replaces / what it says |
|---|---|---|
| `sflow-added-step` | SFlow | "SFlow added Requirements before Code: …" |
| `sflow-merged-stage` | SFlow | "Stage 4 (…) is optional and … like …, so it runs inside that step" |
| `sflow-answer-stays-question` | SFlow | "The answer the agent records as … stays a question …" |
| `sflow-renamed-id` | SFlow | An ID changed to avoid a collision with SFlow's own |
| `marketplace-skill-not-a-dependency` | marketplace | "Stage N names skill X, which the agent does not depend on" |
| `marketplace-dependency-unused` | marketplace | "The agent depends on skill X, which no stage names" |
| `marketplace-stage-unclassified` | marketplace | A stage no rule could classify: the person answered, and the agent would be clearer with a pdlc-task |
| `marketplace-missing-task` | marketplace | A stage, or a skill it uses, has no pdlc-task in the marketplace taxonomy |
| `marketplace-answer-name-unusable` | marketplace | A recorded answer's name or choices cannot be a Story value |
| `marketplace-lifecycle` | marketplace | The agent is `proposed` (or not `released`) |
| `marketplace-metadata` | marketplace | A required `apm.yml` field is missing or invalid (version, maintainer, categories) |

**MCR:REQ-001:** Every note `convertAgent` writes today is a finding with a class and an owner. No free-text-only note
remains.
**MCR:REQ-002:** A finding's words are plain sentences that a marketplace maintainer can act on without knowing SFlow.

## 6. Feedback for the marketplace

**MCR:REQ-010:** The screen lists only the findings the marketplace owns, grouped by agent, each with its stage or skill
and a suggested fix.

**MCR:REQ-011:** **Save as Markdown** writes `conversion-feedback-<agent>-<version>.md`. Its contents:
- the marketplace, commit, agent and version;
- the maintainer from `apm.yml`;
- the date;
- the findings.

It holds no Story, person or repository data beyond those, because marketplaces may be shared or public.

**MCR:REQ-012:** **Copy** puts the same text on the clipboard.

**MCR:REQ-013:** **Open an issue** opens the person's browser on the marketplace repository's new-issue page, with the
title and body filled in. The person submits it. SFlow never posts, emails or opens an issue by itself. When the
text is too long for a URL, the page opens with the title, and the body is copied for pasting.

**MCR:REQ-014:** Findings SFlow owns are never sent as feedback. They are SFlow's own choices, shown to the importer
only.

## 7. Provenance

**MCR:REQ-020:** An import from a marketplace records its provenance in the repository's workflow configuration, beside
the workflow:
- the marketplace ID, repository and commit;
- the agent's name and version;
- the SHA-256 of its `agent.md` and of its `apm.yml`;
- the SHA-256 of each skill it attached;
- the person's answers (by step ID);
- the SFlow build that converted it.

**MCR:REQ-021:** The provenance is part of the reviewed import. It changes only with an import or an update, never by
hand. The custom workflow check reports one that does not match the workflow's files.

**MCR:REQ-022:** A workflow imported before MCR has no provenance. It shows "source not recorded" and offers **Record
its source**. That converts the agent at the pinned commit and compares: identical, it records provenance; different,
it opens the review as an update (§8).

## 8. Updates

**MCR:REQ-030:** **Check for updates** reads each trusted marketplace at its newest commit and compares the provenance of
every imported workflow. It runs on request: Workflow Studio's Library, `singularity-flow imports check`, Copilot's
`/sf-import`, and **Read its newest commit** (`marketplace add --repo` for a marketplace already trusted), whose same read
names the workflows made from it that changed. `singularity-flow check` never fetches, so it does not run it. It reports by
agent: "2 skills and 1 stage changed", "no change", or "removed from the marketplace".
(Built 2026-11-25: a skill imported on its own from a Git repository marketplace is checked too. It is read at the commit
the repository trusts, then at the newest commit. A changed text at the trusted commit is staged with its `import add …
--replace`. A newer text only at the newest commit names `marketplace add <ID> --repo …` first, since an import reads the
trusted commit. A skill the marketplace dropped is reported and stays. Before, these rows said "not checked".)

**MCR:REQ-031:** Network reads happen only when a person asks, or from the check they already run. Nothing polls in the
background.

**MCR:REQ-032:** **Update** converts the agent again at the new commit, with the recorded answers. It opens the review
screen in update mode, which shows only what changed:
- prompt text, as a line diff of `agent.md` stages and each skill;
- steps added, removed or reclassified;
- questions and gates;
- new or resolved findings.

A conversion whose result is byte-identical says "nothing changed for SFlow" and records the new commit only.

**MCR:REQ-033:** A new stage, or a stage whose classification changed, goes to **Needs your answer** again. A recorded
answer is reused only for a stage whose words and skills did not change.

**MCR:REQ-034:** Approving an update is an import, through the same transfer review. Stories already running keep their
frozen snapshot. New Stories use the update. A Story whose next step opens after the update does not change mid-Story.

**MCR:REQ-037:** An update moves the commit the repository trusts for its marketplace to the one the update read, in
the same reviewed import, so Browse and Make a workflow read what the workflow came from. The review says so first.

**MCR:REQ-036:** An update imports in place, never as a copy. The import record keeps a digest of everything its import
wrote. The update replaces, with no question, what the repository still holds exactly as written, and the record. It
asks about anything changed here since, or used by another workflow, and suggests keeping the repository's own. Found
in the real VS Code check of 2026-11-24, where the update was blocked and its review renamed everything.

**MCR:REQ-035:** An agent removed from the marketplace is never removed from the repository by an update. The workflow
stays, marked "source removed", until a person retires it.

## 9. Surfaces

| Surface | Review | Feedback | Updates |
|---|---|---|---|
| VS Code, Workflow Studio | the screen (§4) | buttons (§6) | Library: Check for updates, Update |
| Copilot (`/sf-import`) | `review.markdown`, with versions and no commit | `--feedback`, and the issue link for the person | `imports check` rows with their `updateCommand` |
| Terminal | `workflow from-agent <agent> --review` | `--feedback <file>` | `singularity-flow imports check [--json]`, `workflow from-agent <agent> --update` |

A Copilot turn may read and prepare. Importing and updating stay the person's reviewed steps, as importing is today.

## 10. Acceptance

- **A1:** Converting every agent of the public sample marketplace (`sdlc-marketplace`) gives a review
  where every stage appears once: as a step, merged into one, or open. Every note is a finding with an owner.
- **A2:** A seeded defect in the sample (a skill named but not depended on; a stage with no task) appears under
  **Feedback for the marketplace**, with a suggested fix. SFlow's own additions never appear there.
- **A3:** **Save as Markdown** and **Open an issue** produce the same findings. The issue URL never carries Story,
  person or repository data, and nothing is posted.
- **A4:** An import records provenance whose digests match the marketplace commit's bytes. The custom workflow check
  flags a hand-edited provenance.
- **A5:** **Update** at an unchanged commit says "nothing changed for SFlow". A one-word change in one skill shows
  exactly that line, and needs no answer.
- **A6:** A changed stage classification asks again. An unchanged stage reuses its answer.
- **A7:** A Story started before an update keeps its snapshot through the update. Checked by the Story fuzzer
  (`test/story-fuzzer.test.mjs`) with an update between two actions.
- **A8:** The screen is checked in a real page (the Studio page with recorded engine answers), as for the marketplace
  repository work on 2026-11-23.

## 11. Milestones

| Milestone | Scope | Size |
|---|---|---|
| M1 | Structured findings (§5); the review screen (§4) and its Markdown form | about 1 day |
| M2 | Feedback (§6): Markdown, copy, issue link | about half a day |
| M3 | Provenance (§7), Check for updates, Update with diff (§8), Record its source | about 1 to 1.5 days |

Each milestone lands on its own with its tests, and touched-area runs include the source-reading tests.

## 12. Open questions for the owner

1. **Who sees the feedback button.** Default: everyone who can import. Alternative: only a workflow approver.
2. **Mirror marketplace issues locally?** Should SFlow keep a local list of feedback already sent, so the same
   finding is not raised twice? Default: no. The Markdown file is the record.
3. **Updating a running Story.** Should a Story at a step not yet started be offered the updated skill? Default: no.
   Running Stories stay frozen (MCR:REQ-034).
