# World Model repair (WMR) — v1: clean up what was deleted, and make the Repository brief earn its place

**Specification ID:** `WMR-v1`

**Status:** M1 and M2 built on branch `wmr-m1m2` (2026-11-26): REQ-007–015 and REQ-017–019, REQ-024–027. REQ-016 is
not built: probe P1 showed JSX parsing did not cause the missing file. M3 (REQ-029) built on branch `wmr-m3`
(2026-11-26); its measure of the owner's kept prompts, before and after M1 and M2, is in §11. M0 (the text clean-up)
is on main (`4c8b464a6`). M1's last part, the dead `worldModelViews` fields and the rest of the removed World Model's
code, is retired on branch `wm-dead` (§10). M4: REQ-023 is built with SSB M2 on branch `ssb-m2` (2026-11-26);
REQ-020–022 wait for SSB M3 and M4 (§4.6). The probes' answers are in §7. The
planning fix §11 left open is built on branch `wmr-words` (2026-11-26): every graph Story's planning brief now names the
grapher file (§11).
Written on 2026-11-26 from two read-only reviews of that day: one of the code, one of the owner's real use. Checked
against `main@cbeb9978d`; built on `main@30484105e`.

**Owner, 2026-11-26.**
- "review the current repo world model and see if we need to improve it or not"
- On named views (business, architect and so on): "office skills dont ask for it ..but we need to clean up the skills".
  So **no views are added**. This spec cleans up and fixes what exists.
- "create a spec to clean up and rectify the worldmodel issues"

**Standing rule (owner, 2026-10-09):** the World Model is guidance and never authority. Nothing is blocked, refused or
authorized because of it. A missing, stale or broken brief means "no brief, with a warning", and work goes on. Every
requirement below keeps that rule, and REQ-023 removes the one place that still breaks it.

**Builds on:**
- **The Repository brief** (`src/knowledge/`, about 12,800 lines). This is all that is left of the World Model after
  the October removal of the registered v4 model, its views, CALM and architecture intent (`src/removed-features.mjs`).
  It reads the committed source, builds cited records (rules, validation, contracts, flows, impact, risks) and writes
  one brief per step into the prompt section `world-model-grounding`.
- **The per-step profile.** `phaseBriefProfile` (`src/knowledge/phase-brief.mjs:22-73`) picks one of four readers
  (product, architect, developer, tester), a budget of 2–4 KB and a section order. It goes by the step's output kind,
  then a code task, then the step's name, then its other declared task.
- **The switches.** `worldModel.knowledge.prompt` (`src/knowledge/render.mjs:47`) and the work type's
  `intelligence.worldModel` (`src/intelligence-policy.mjs:54`).
- **The surfaces.** `wm brief`, `/sf-worldmodel`, VS Code's "What this phase sees" panel, the Repository Brief panel,
  the Studio World Model section and the Code Explainer.
- **The Story path resolver** of [SSB](SPEC-SSB-STORY-STATE-BRANCH-v1.md) M1 (`src/story-paths.mjs`), on main since
  `cbeb9978d`.

---

## 1. Why

### 1.1 What the owner's real use shows

The owner's real workspace kept all 107 composed step prompts of 16 Stories (2026-11-06 to 11-23), with their
receipts and the Copilot logs of 85 sessions. The workspace is a React calculator app.

| What | Measured |
|---|---|
| Briefs reaching prompts | 107 of 107 step prompts carry one; none is empty |
| Size | median 2,590 bytes (about 650 tokens); 5.8% of a step's prompt |
| Cost | 3.3 of 1,076.6 AI credits (0.31%) |
| Literal facts | about 35 cited lines checked at their commits: every one exact |
| Intake briefs | all 23, across 11 Stories, byte-for-byte the same once the header is removed |
| The file the Story changed | in all 6 graph Stories, no planning brief names `FunctionGrapher.jsx`, though the approved plan names it first |
| Call claims | wrong on JSX: "`playSound` … called from 8 places, no test reaches it" (45 call sites; a test reaches it); `evaluate` "called by `evaluateExpression`" is really mathjs's `math.evaluate` |
| Use by the agent | the agent reads the brief, but never quotes or uses it and never runs `wm brief`; planning still runs a median of 14.5 searches and reads per step |
| Verify and release | almost no code exploration there (26 calls over 35 entries), so the brief is pure overhead |
| Cache | rebuilt on every SFlow bookkeeping commit with no source change: 12 entries of 168 KB each, all for one Story |

**In short:** cost is not the problem, and the facts are right. The brief doesn't earn its place for three reasons. It
is generic before code exists. It misses the file being changed. Its call-graph claims are guesses that read as facts.

### 1.2 What the code review found

1. **Clean PRs (SSB) will break it without a warning.**
   - Approved specifications are read from `<workItemRoot>/*/workflow.json` at HEAD (`src/knowledge/requirements.mjs:54-70`).
   - Story documents in `docs/stories/` would count as repository docs (`src/knowledge/brief.mjs:61-66`).
   - Lessons are committed to the Story branch (`src/story-publication-service.mjs:221`).
   - Planned paths are joined without the workflow (`src/phase-prompt-composer.mjs:386-395`).
2. **The cache throws away paid model output.**
   - `prune` keeps the 12 newest `*.json` files of `.git/singularity-flow/knowledge/` (`src/knowledge/store.mjs:47-52`).
   - That folder also holds model-written briefs, polish, explanations and `rule-proposals.json`.
   - The key includes the HEAD commit (`src/knowledge/source.mjs:151`), so every commit orphans the paid files first.
3. **The Story's source scope never reaches the brief.** `readKnowledgeSource` re-reads the approved configuration
   instead (`source.mjs:75`). Above `maximumCodeFiles: 4000` (`source.mjs:24`) the brief only guesses areas. Area
   selection ignores the plan's files (`src/knowledge/prompt.mjs:47-51`), and the Code Explainer's fallback refuses
   with `KNOWLEDGE_SCOPE_TOO_LARGE`.
4. **One guidance-only breach.** `spec author gaps` refuses the whole listing (`SPEC_RESEARCH_UNAVAILABLE`,
   `src/commands/spec-author.mjs:122`) when only the knowledge build fails.
5. **Wrong descriptions.** Studio shows the old name-only reader and an 8 KB default (`src/knowledge/render.mjs:38-57`,
   `src/workflow-studio.mjs:59`), not what `phaseBriefProfile` gives. `wm knowledge slice` claims to show what a phase
   receives, but renders the old 8 KB slice.
6. **Tasks get the wrong reader.** `/sf-task`'s docs, investigate and review tasks do their work in `design`
   (`src/task-composition.mjs:36-38`), so a code review gets the architect's brief.
7. **Stale text.** About 25 skills, 12 templates, 22 help topics and the CLI help still name deleted parts. Examples:
   - "world-model view declarations";
   - views such as `arch.contracts` and `dev.impact`;
   - a "World-Model manifest" and world-model snapshots;
   - `wm` subcommands that now refuse.
   `src/workspace-impact.mjs` prints a per-repository "world model" line that is always "not available".

## 2. Terms

- **Brief:** the Repository brief a step's prompt carries, built by `repositoryBriefPrompt`.
- **Planned files:** the files the Story's approved plan says it will change: the rows' paths of the planned claims, and
  the plan document's file table.
- **Name-matched call:** a call edge found by matching a name, not resolved by a language service. Resolved calls exist
  only after `wm ast warm --semantic`.
- **Analysis entry:** a cache file named by its knowledge key (`<64 hex>.json`). Paid output is a model-written file:
  the brief, polish, explanations, or rule proposals.

## 3. Not in scope

- **No named views** (business, architecture, data, UI). The owner decided so on 2026-11-26.
- **No new gate, refusal or approval input** from the brief.
- **No model call by default.** Compose never calls a model, as today.
- **No raise of the brief's budgets.**
- **No change to the frozen prompt section ids,** or to the receipt shape `files[]`.

---

## 4. Requirements

### 4.1 Clean-up (M0, building on `wm-clean`)

**WMR:REQ-001, no text names a deleted part.** No packaged skill, agent, template, help topic, CLI help or VS Code
string tells a person or an agent to use any of these:
- a World Model view (`business`, `arch.contracts`, `dev.impact`, `biz.rules`, `views/<x>.brief.md`);
- a World-Model manifest or snapshot;
- CALM or architecture intent;
- a `wm` subcommand that refuses with `WMB_REMOVED` or `COMMAND_REMOVED`;
- the `sflow-world-model-views:` header.

Text that names the brief says what it is: "The Repository brief is guidance; it is built for you and never blocks."
"World Model" stays an accepted name for it.

**WMR:REQ-002, commands named exist.** Every `wm …` form a skill names exists with that shape. For example, `wm
knowledge explain` takes no symbol.

**WMR:REQ-003, Initiative templates name what exists.** The solution architecture, feasibility, requirement impact,
impact analysis and repository map templates cite the Repository brief, not "the repository world model". They name no
view: `worldModelViews` is an empty list. The code that still carries `worldModelViews` is listed for retirement in
M1. It is not removed in M0. (Retired in M1 on `wm-dead`: the packaged portfolio names no view list at all; §10.)

**WMR:REQ-004, no output that is always empty.** The per-repository "world model" line of workspace impact and the
capability doctor's world-model snapshot report are removed. A JSON field a consumer reads stays, documented as
always null, until that consumer changes.

**WMR:REQ-005 (built, M1), an ignored header is named once.** An agent's `sflow-world-model-views:` header is listed among the
settings dropped at load (`src/removed-features.mjs`, doctor `removed-settings`), in one plain line. It never refuses
or warns on every run.

**WMR:REQ-006, upgrades replace the old text.** Every changed packaged file moves its current digest and records the
old one as a known earlier version (`src/packaged-asset-history.mjs`, `src/packaged-workflow-history.mjs`). A
refresh then replaces it. An unused v4 template (`templates/world-model/pinned-core-v4.md`) is deleted with its
packaging and history entries.

### 4.2 Focus on the Story

**WMR:REQ-007 (built, M2), the plan's files lead.** Once a plan is approved, planned files are the union of two sources:
- the planned claims' paths (`workflowPlannedPaths`);
- every path in the approved plan document's file table.

A planned file the knowledge does not know yet (a new file) is still listed, as "(new, planned)". It is no longer
dropped by the `known.has(file)` filter (`src/knowledge/records/impact.mjs:99`).

**WMR:REQ-008 (built, M2), area selection reads the plan.** `selectKnowledgeAreas` takes the planned files beside the changed
files and the Story's words. So on a repository above `maximumCodeFiles`, the plan and first code briefs read the
planned files' areas instead of coming back empty.

**WMR:REQ-009 (built, M2), the Story's scope.** `buildKnowledge` and `readKnowledgeSource` take the source scope compose already
applies (`sourceRoots`, `sharedRoots`, `excludedRoots`, the environment exclusions). The scope is read from the
Story's pinned configuration, not the live approved one. A capability Story's brief then reads its capability's
folders only.

**WMR:REQ-010 (built, M2), the Explainer names an area.** When the Code Explainer falls back to `wm knowledge calls`, it passes
the area of the files that got no call hierarchy. It no longer asks for the whole repository and gets
`KNOWLEDGE_SCOPE_TOO_LARGE`.

### 4.3 Where the brief goes

**WMR:REQ-011 (built, M2), only where it helps.** By default the brief is left out of these steps:
- **intake and requirements** (the product reader), where no code is known to change yet;
- **verification and release.**

It stays in design, plan, implementation-spec, reproduction and code steps. A team can turn it back on per work type
with `intelligence.worldModel: on` and per step with `worldModel.knowledge.prompt`. The receipt says why it was left
out: `groundingAvailability.reasonCode: 'BRIEF_NOT_FOR_THIS_STEP'`.

**WMR:REQ-012 (built, M2), the step's intent picks the reader.** A step's pinned intent is a declared signal, read after the
output kind and before the name:
- `/sf-task`'s review intent gets a reviewer profile: rules, risks, what the change touches, then contracts.
- An investigate task's design step gets the developer's profile.
- A docs task's design step gets the product profile.
- A marketplace agent's own step ids use their intent the same way, instead of falling to the catch-all.

**WMR:REQ-013 (built, M2), no repeat within a step.** A step's next version reuses the brief when the Story's changed files did
not change. For example, the 14 verification retries of one Story each carried the same brief. The receipt records
the reuse; nothing new is composed.

### 4.4 Claims that are true

**WMR:REQ-014 (built, M2), name-matched calls are not facts.** While a language's calls are name-matched only, the brief does not
state any of these:
- "called from N places";
- "reached by N entry points";
- "no test reaches it";
- "tested by <file>";
- a caller → callee chain.

It may say "calls matched by name" once per brief. When resolved calls exist for that language, the claims come back,
as today. A rule's own "tested" status from a test that names it stays.

**WMR:REQ-015 (built, M2), a question needs a true premise.** "Questions for the product owner" are not drawn from "no test
reaches this rule" while the reach is name-matched (`src/knowledge/brief.mjs:507-508`).

**WMR:REQ-016 (not built: P1 found another cause), JSX components are functions** (depends on probe P1). A React file's components and handlers count as
functions in the graph: function declarations, `const X = (...) => …`, and `memo` and `forwardRef` wrappers. Then
"no test reaches it" is not said of code a rendered component reaches.

### 4.5 The cache

**WMR:REQ-017 (built, M1), rebuild only when source changes.** The knowledge key is built from these, without the commit:
- the files' digests;
- the manifests;
- the rule files;
- the approved requirements' digests;
- the roots and the scope.

History (churn, ownership, co-change) is keyed by the newest commit that touched a read path. A bookkeeping commit
that changes no read path reuses the entry.

**WMR:REQ-018 (built, M1), prune only analysis entries.** `prune` removes only files named `^[0-9a-f]{64}\.json$`. Paid output
moves to `knowledge/paid/` and is pruned by its own count, 30 by default and oldest first. `rule-proposals.json`
moves out of the cache folder to `knowledge/rule-proposals.json` and is never pruned. A rule draft a person has not
confirmed is never lost to a prune.

**WMR:REQ-019 (built, M1), paid output survives a commit.** A model-written brief, polish or explanation is keyed by the
analysis it was written from (REQ-017's key) and the selection. A commit that changes no read path keeps it in use.

### 4.6 Ready for clean PRs (with SSB M2–M4)

**WMR:REQ-020, approved specifications follow the Story's layout.** *Waits for SSB M4 (documents in `docs/stories/`) and
M3 (published state refs): at HEAD a state-ref Story has neither its records nor, before M4, its documents.*
`readApprovedRequirements` finds each Story's records through the resolver:
- in today's layout, the Story folder;
- under SSB, the state ref (records) and `docs/stories/<ID>/` (approved documents).

Approval digests are checked as today. In either layout, a Story whose records cannot be read is skipped with a
warning, never silently.

**WMR:REQ-021, Story documents are not repository docs.** *Waits for SSB M4: until `docs/stories/` is SFlow's (REQ-001
refuses a folder a repository already uses), leaving it out would drop a team's own docs. `.sflow-state/` is never in a
commit, so the HEAD reader cannot meet it.* `readDocumentation` leaves out `docs/stories/**` and the
state checkout (`.sflow-state/`). The current Story's own unapproved drafts never become docs statements or
docs-origin rules.

**WMR:REQ-022, lessons leave the Story branch.** *Waits for SSB M3, where an approval commits only the state ref.* Story
lessons (LRN) stop being committed to the code branch (`src/story-publication-service.mjs:221`,
`src/story-lessons.mjs:233-245`). Under SSB they live on the Story's state ref. `phaseLessons` reads them through the
resolver. A failure to record a lesson never blocks an approval (probe P5).

**WMR:REQ-023 (built, SSB M2), compose passes the workflow.** Every compose join that reads Story records passes the
workflow as the first source to `storyLocation` (for example `workflowPlannedPaths`). A state-ref Story then never reads
as an empty plan.

### 4.7 Guidance only, everywhere

**WMR:REQ-024 (built, M1), spec research degrades.** When the knowledge build fails, `spec author gaps` lists the gaps and marks
their impact "not available (why)". It never refuses with `SPEC_RESEARCH_UNAVAILABLE` for that alone.

**WMR:REQ-025 (built, M1), an inventory of refusals.** A test lists every `SingularityFlowError` that `src/knowledge/` and its
callers raise. It fails when a new one is raised on a path a Story step, an approval or a publication takes. Read
commands a person runs, such as `wm knowledge show` or `wm rules confirm`, may still refuse.

### 4.8 Surfaces say what happens

**WMR:REQ-026 (built, M1), Studio shows the real brief.** The Studio World Model section calls `phaseBriefProfile` for each step
and shows the step's real reader, budget and sections, or "no brief here (REQ-011)". `KNOWLEDGE_READER_RULES` and
the 8 KB default stop being shown.

**WMR:REQ-027 (built, M1), one slice.** `wm knowledge slice` either renders what `phaseBriefProfile` gives, or is retired with
`COMMAND_REMOVED` pointing to `wm brief --phase`. Default: retired.

**WMR:REQ-028, where it lives in the four places.** In FPL, "What this phase sees" and the Repository Brief panel are
reachable from a Story's card in Work, not only from Advanced. FPL M2 places them; this spec only names the need.

### 4.9 Measured

**WMR:REQ-029 (built, M3), a real-use measure.** `scripts/world-model-v5-benchmark.mjs` gains a real-use mode. Its input is a
folder of kept prompts and receipts (the prompt audit) plus the Stories' diffs. It reports:
- **hit rate:** the share of plan and code briefs that name at least one file the Story changed;
- **wrong-claim count:** claims of reach, callers or tests that the diff's tests contradict;
- **brief bytes per step,** and how many steps got no brief and why.

It never sends anything anywhere and calls no model.

---

## 5. Acceptance

- **A1 (REQ-001–006):** a grep of plugin/, templates/, docs/topics/ and help text for deleted parts finds only lines
  marked historical. A refresh from the previous release replaces each changed skill, agent and template. check-iso
  passes.
- **A2 (REQ-007, 008):** a fixture app with 19 files whose plan's file table names `src/FunctionGrapher.jsx` gets a
  plan brief and a first code brief that name it. A plan that names a new file lists it as "(new, planned)".
- **A3 (REQ-008, 009):** on a fixture above `maximumCodeFiles`, a capability Story's plan brief is not empty, and it
  reads only the capability's folders.
- **A4 (REQ-011):** a feature Story's intake, verification and release prompts carry no brief, and their receipts say
  `BRIEF_NOT_FOR_THIS_STEP`. Its design, plan and code prompts carry one. `intelligence.worldModel: on` on the work type
  brings intake's back.
- **A5 (REQ-012):** a `/sf-task` review task's design step gets the reviewer profile.
- **A6 (REQ-013):** a step's second version with no new changed file reuses its brief.
- **A7 (REQ-014, 015):** on the JSX fixture with name-matched calls only, no brief says "called from", "reached by",
  "no test reaches" or "tested by", and no question rests on them. With resolved calls the golden briefs are unchanged.
- **A8 (REQ-017):** a bookkeeping commit that changes only Story records reuses the cache entry. Nothing is analysed
  again.
- **A9 (REQ-018, 019):** after 20 commits, a model-written brief and an unconfirmed rule draft are still there.
  `wm rules confirm` credits the drafted meaning, not "template".
- **A10 (REQ-020–023):** in the SSB state-ref layout fixture, approved clauses are read, `docs/stories/**` gives no
  docs statement, lessons are read from the state ref, and a state-ref Story's plan brief lists its planned files.
- **A11 (REQ-024, 025):** with the knowledge build forced to fail, `spec author gaps` lists the gaps with impact "not
  available", and every Story step, approval and publication goes on.
- **A12 (REQ-026, 027):** Studio shows "developer, 3 KB" for a code step named `implement-story` (not product, 8 KB).
  `wm knowledge slice` refuses with `COMMAND_REMOVED` and names `wm brief --phase`.
- **A13 (REQ-029):** run on the owner's kept prompts, the real-use measure reproduces §1.1's numbers before the change.
  Then, on new Stories of the same app after the change:
  - the hit rate is at least 80%;
  - the wrong-claim count is 0;
  - intake, verify and release carry no brief.

## 6. Milestones

| M | What | Size |
|---|---|---|
| M0 | Clean-up of stale text and dead outputs (REQ-001–006), on branch `wm-clean` | building |
| M1 | Cache (REQ-017–019), guidance only (REQ-024, 025), surfaces (REQ-026, 027), dead `worldModelViews` fields retired | built (dead fields on `wm-dead`) |
| M2 | Focus and placement (REQ-007–013) and true claims (REQ-014–016), with golden briefs updated | about 1.5 days |
| M3 | The real-use measure (REQ-029), run on the owner's kept prompts before and after | built on `wmr-m3`; §11 |
| M4 | Ready for clean PRs (REQ-020–023), built inside SSB M2–M4 | REQ-023 built with SSB M2 (`ssb-m2`); the rest with SSB M3–M4 |

M0 and M1 can land together. M2 lands with its measure from M3, so the change shows its effect.

## 7. Probes before building

Answered on 2026-11-26 while building M1 and M2 (`wmr-m1m2`):
- **P1:** `FunctionGrapher.jsx` was parsed as code (its component is a function in the graph) and every graph Story's
  planned claims named it. Two things kept it out of every brief. The planning step's brief (the architect's) had no
  "What a change touches" section, and at the step's first version no plan existed yet. Then at the code step its file
  record had nothing to say and was dropped (`records/impact.mjs`, `if (!parts.length) return`): its only importer,
  `App.jsx`, was planned too, so "imported by" was empty. So the cause is REQ-007's, not JSX: **REQ-016 is not built.**
  Seen on the way: a component whose parameters span lines (`export const Display = ({\n … }) => {`) is not read as a
  function; it did not cause the missing file.
- **P2:** measured on a scratch clone of SFlow's own repository at `30484105e` (4,195 code files in 48 areas), on this
  machine, with no semantic pack, for a Story planning `src/knowledge/records/impact.mjs` and
  `src/phase-prompt-composer.mjs`:
  - **Before REQ-008 and REQ-009:** the plan brief came back empty ("this Story names no area of it", 0.05 s). The
    first code brief (one changed file in `src/knowledge/`) built that area only: 0.5 s cold, 0.2 s warm, one 0.8 MB
    cache entry.
  - **After:** the plan brief and the first code brief both name the planned files. They build `src/knowledge/` and
    `src/`'s own 1,081 files: 26–28 s cold, 0.5 s warm, 12.3 MB in two entries (11.5 MB for `src/`). With the Story's
    source scope set to `src/knowledge` (REQ-009): 0.4 s cold, 0.2 s warm, 0.8 MB.
  - **So:** the cost is the size of the areas the Story's files fall in. A folder's own files are one area however
    many there are, so a flat `src/` costs about 27 s cold whenever one of its files changes; a changed file there cost
    the same before. REQ-017 keeps bookkeeping commits from paying it again. Not changed here: a cap on an area's
    size, or a planned file's area being built only when small, is a follow-up.
- **P3:** not run: it needs real VS Code.
- **P4:** yes: the 16 golden briefs pass on `main@30484105e`.
- **P5:** no. Recording a step's lessons runs inside the approval's publication unit, in a `try` whose `catch` keeps the
  approval (`story-publication-service.mjs`); what `approve` and `submit` print afterwards (`lessonsAfterApproval`)
  catches its own reads. A test pins both (`test/knowledge-refusal-inventory.test.mjs`, P5).

1. **P1, the missing file.** Why no brief named `FunctionGrapher.jsx` in the owner's graph Stories. Was it absent from
   the planned claims' paths? Dropped by the known-file filter? Or not parsed as code, given 21 functions and 13
   edges for 19 files? The answer decides whether REQ-016 is needed.
2. **P2, size.** Per-compose time and cache entry size on a repository near 4,000 code files (SFlow's own), before and
   after REQ-008 and REQ-009.
3. **P3, the Explainer.** On SFlow's repository, does JavaScript's call hierarchy return nothing (so the fallback runs
   and refuses), or empty answers?
4. **P4, golden briefs.** Do the 16 golden briefs pass on main today (last regenerated 2026-10-24)?
5. **P5, lessons.** Can a failure while recording lessons block an approval today?

## 8. Risks

- **Less context at intake.** Dropping the brief at intake removes the product reader's rules list. The measure says
  intake briefs were identical across Stories, so the loss should be small. A team can turn it back on (REQ-011).
- **Fewer claims.** REQ-014 removes claims that are sometimes right. A brief that says less but nothing false is the
  aim. Resolved calls bring the claims back.
- **Cache migration.** Moving paid files to `knowledge/paid/` loses no file: the first run moves what it finds.
- **SSB order.** REQ-020–023 must land before SSB's state-ref layout is switched on for any Story. Otherwise the brief
  quietly loses requirements and plans.

## 9. Decided (owner, 2026-11-26)

The owner answered "yes for 1, 2, 3":
1. **Intake brief:** left out by default (REQ-011).
2. **Lessons under SSB:** on the Story's state ref, read through the resolver (REQ-022, M4).
3. **`wm knowledge slice`:** retired (REQ-027).

## 10. As built (M1 and M2, 2026-11-26)

Where the build reads the requirements one way among several:
- **REQ-011's switches.** `intelligence.worldModel: on` is a new value of the work type's setting (`required` acts
  the same). The per-step switch is `worldModel.knowledge.prompt` written as a mapping of step IDs to `slice` or
  `off`; a plain `slice` or `off` still covers every step. "Verification and release" covers the conformance step too.
- **REQ-012's plan steps.** A step whose intent is `plan` gets the implementation-spec profile (developer, 4 KB, the
  plan's files first), as the feature workflow's plan step already did. The reviewer's profile is 3 KB and is never
  chosen by a step's name. Corrected on `wmr-words`: spec-driven-standard's `planning` step does not move. It declares
  `design` as its document's kind, and the kind comes before the intent, so it keeps the architect's 3 KB brief. Since
  then that brief says what a change touches (§11).
- **REQ-013's sameness.** A brief is reused while the Story's base commit, its changed files' bytes, its plan, its
  words, its source scope and the reviews people wrote (`docs/knowledge/*.yml`) are the same. Only a recorded compose
  keeps one; `wm brief` reads it.
- **REQ-014's languages.** A language counts as resolved when a semantic pack resolved a call in a file of it.
- **REQ-018's rule drafts.** `rule-proposals.json` already lived at `knowledge/rule-proposals.json`; it stays there,
  and the prune no longer matches it.
- **The golden briefs.** The 16 goldens are kept unchanged and are checked with calls read as resolved (A7); 16
  `*.by-name.md` goldens hold what a repository without a semantic pack gets.
- **Not done there:** retiring the dead `worldModelViews` fields, and M0's text (the template comment in
  `templates/workflow.yml` and the help text said every step gets a brief). Both are done since: the help text on
  main (`0aaac1bb4`), the rest below.

### Dead fields retired (M1, branch `wm-dead`, 2026-11-26)

Owner, 2026-11-26: "retire the dead code". Every old input still loads with no refusal: configurations,
portfolios, capability files, agent files, workflow bundles, imports and Story snapshots that still carry the fields.
Retired:
- **Epic impact** (`epic impact`, `--markdown`, VS Code's Planning and impact page) reads no
  `singularity/world-model/manifest.json`, shows no WORLD MODEL column, no "No committed world model" line and no
  "unknown view" finding [REQ-003]. `initiative restart` says "Story branches unchanged".
- **View lists:** an Epic step's `worldModelViews` (phase and profile override) is accepted and left out; a
  capability adds none to an Epic step; `requiredWorldModelViews` is accepted and not read; the packaged portfolio's
  15 empty lists are gone; `workflow simulate` prints no `world-model=` per step. The portfolio and capabilities
  schemas keep the keys as deprecated, accepted and ignored.
- **Studio** (engine and VS Code page): no `views` on steps, agents, roles or Epic steps, no "knowledge views"
  editing, no `views`/`retiredViews` choices. A change from an older Studio that sends `views` writes nothing.
- **The `sflow-world-model-views` header** [REQ-005]: not parsed, not carried into configuration or a Story
  snapshot, not written for a new agent, not compared by seeded-workflow protection or WCA, not shown by the intent
  catalog or agent import. doctor's `removed-settings` names each agent file that still has it, once: "no longer
  read; the Repository brief comes from the step". A workflow bundle is no longer refused for a "World Model
  requirement", missing or unreferenced.
- **Change Flight Plan:** no `worldModel*` baseline fields, no `worldModel` category and no unknown for it. A plan
  previewed before still starts: its fields are not compared.
- **`workspace reinitialize --migrate-world-model`:** the unreachable migration summary and capability edit are
  deleted; the option is still refused by name.
- **`session context --slice world-model`:** retired (it always answered "unavailable"). Its contract is not
  frozen: no companion lock or digest names the slice list, and the gateway registry hashes argument schemas by name.
  Asked for by name, it is refused with `COMMAND_REMOVED` and points to `wm brief`.
- **Text:** `templates/workflow.yml`'s comments and two benchmark descriptions (GDP lock review
  `COMPANION-LOCK-REVIEW-2026-11-26-WMR-DEAD-FIELDS.md`; the two work types' earlier digests recorded) and
  `VERIFICATION.md`.
- **Found on the way:** reference repositories no longer read a committed World Model manifest or print "Reference
  World Model: not reusable" in the prompt.

Kept, because a contract is frozen (each says so where it stands):
- **A Story step's `worldModel.views` slot** (`capability-context.mjs`). A task change and a test-command amendment
  resolve the step again and compare it with the pinned one, so a Story started before keeps working. New Stories
  get an empty list: capability policy now folds `requiredWorldModelViews` to an empty slot.
- **That empty `requiredWorldModelViews` slot** in every folded capability policy: Stories and materialization
  receipts pin the policy's digest (`policySha256`, `resolutionSha256`).
- **A workflow bundle's `requirements.worldModelViews`**, always written empty: the bundle format is versioned and
  every reader requires the list.
- **WCA's impact graph** still reads views that a captured agent carries: a retained record's
  `consumerImpactSha256` is computed again from its retained inputs. New captures carry none.
- **Pinned resolution fields** not changed here: an Epic's `worldModelTiming`, `worldModelGrounding` and
  `worldModelOutputDir`, and a Story's `worldModelGrounding` and `worldModelStaleness`, are in pinned resolution
  digests.
- **Upgrade history:** packaged agents that shipped with the header, and the v1 personas' view lists, stay recorded
  so an upgrade still recognises them.
- Seen and left for their own contracts: the GDP proof kernel's `world-model` gap category, the auto contract's
  `world-model` context section, and an Epic phase context's `worldModelFiles` receipt.

## 11. Measured (M3, 2026-11-26)

**How it was run.** The real-use mode of REQ-029 reads three inputs and nothing else: the prompt audit's
`prompts.jsonl` (never the key beside it), the Story worktrees' records and receipts, and a complete local clone of the
repository with the Stories' branches. It never fetches, sends or calls a model:

```text
node scripts/world-model-v5-benchmark.mjs --real-use --prompts <workspace>/.singularity-flow/prompt-audit \
  --worktrees <workspace>/.singularity-flow/story-worktrees --repository <scratch clone> \
  [--replay <scratch clone>] [--json]
```

- **Before** is the briefs the kept prompts carried.
- **After** (`--replay`) re-composes each step's brief with today's code (main with M1 and M2) on a scratch clone. It
  uses the step's own commit, so the Story's pinned configuration, its plan and its changed files are the ones that step
  had. It calls `phaseRepositoryBrief` directly. A step that cannot be re-composed exactly is counted "not replayable",
  with why.

`test/world-model-real-use.test.mjs` checks it on synthetic Stories of the graph-calc fixture, and runs it under Node's
permission model to show it reads nothing outside its input.

**How it counts.**
- **Hit:** a plan or code step whose brief names a code file the Story's final diff changed, by its path or by a file
  name no other file has. A step with no brief counts as a miss. Steps of a Story that changed no code file are left
  out.
- **Most-changed file:** stricter. The brief names the code file, not a test, with the most lines changed.
- **Wrong claim:** counted conservatively.
  - "No test reaches it" is wrong only when a test file names the symbol: at the brief's commit, or one the Story's
    diff adds.
  - "Called from N places" is wrong only when its call sites are none, or at least 3×N and N+10.
  - A named caller, or a flow's next step, is wrong only when the file that defines the caller never calls it.
  - "Tested by" is wrong only when no such file exists.
  - Reach through entry points is counted, never judged.

**The owner's calculator app, 16 Stories:** 107 step prompts, 2026-11-06 to 11-23. All 107 steps were replayable.

| What | A13 target | Before (kept) | After (replayed) |
|---|---|---|---|
| Plan and code steps whose brief names a changed file | at least 80% | 93% (40 of 43) | **93%** (40 of 43) |
| … the file the Story changed most | — | 67% (29 of 43): plan 6 of 12, code 23 of 31 | 84% (36 of 43): plan 5 of 12, code 31 of 31 |
| Wrong claims | 0 | 97 of 1,164 judged (1,469 made); 3 distinct claims | **0** (none made) |
| Steps with no brief | intake, verification, release | 0 of 107 | **61 of 107**, all `BRIEF_NOT_FOR_THIS_STEP`: intake 24, verification 23, release 14 |
| Brief bytes per step, median | — | 2,589 (107 briefs) | 2,169 (46 briefs: plan 2,266, code 2,010) |
| Brief bytes, all steps | — | 239,404 | 99,456 (−58%) |
| Brief share of its step's prompt, median | — | 5.8% | 6.4% |
| Briefs identical across Stories, header removed | — | 26: 23 intake briefs of 14 Stories, 3 code briefs of 2 | 2: two plan briefs of 2 Stories |

**§1.1 reproduced (before):**
- 107 of 107 prompts carry a brief, and none is empty: as §1.1.
- Median 2,589 bytes: §1.1's 2,590 counted each brief's closing newline.
- 5.8% of a step's prompt: as §1.1.
- 23 intake briefs are byte-identical once the header is removed, as §1.1 says. They span 14 Stories, not 11: §1.1
  miscounted. The measure also finds 3 code briefs identical across 2 Stories.
- 0 of the 6 graph Stories' planning briefs name the grapher file: as §1.1.
- Call claims: the conservative count confirms §1.1's wrong caller count (45 call sites, "called from 8 places") and
  its wrong caller. It finds one more: a helper "called from 2 places" has 12 call sites. It does not confirm "a test
  reaches it". No test file in any Story's tree or diff names the sound helper, so none of the 794 "no test reaches it"
  claims is counted wrong.

**A13 passes on the replay:** the hit rate is 93%, there are 0 wrong claims, and intake, verification and release carry
no brief.

**What is left, plainly:**
- **The hit rate as A13 defines it does not tell before from after.** The app's shell file is named in almost every
  brief (it is the entry point), and most Stories change it. The most-changed-file rate does tell them apart: 67%
  became 84%, and every code brief now names the file its Story changed most (REQ-007). In the 6 graph Stories, the
  code briefs that name the grapher file went from 11 of 20 to 20 of 20. With the planning fix below it does tell
  them apart: 93% became 100%.
- **Planning briefs missed the graph Stories' main file: 0 of 6, before and after.** Fixed on branch `wmr-words`
  (2026-11-26). A probe replayed one graph Story's planning step and found three causes, not one:
  - The owner's planning steps pin the document kind `design`, so they get the architect's brief, which had no "What a
    change touches" section. 5 of the 6 Stories pin no intent; the sixth pins `plan`, but the kind comes first.
  - At the step's first version there is no plan and no change, so nothing could list a file. The grapher also has no
    rule, contract, flow or risk record that the Story's words could have ranked first.
  - The words did not meet. The record readers already split `FunctionGrapher` into "function grapher", but "grapher"
    stayed apart from "graph". The template and docs ranking, the header and area selection did not split at all.
  - Behind all three, the words are few. Every graph Story's title is "graph" (with "new" or "(copy)"), and no other
    words are given; the approved requirements are not part of them.
- **The fix.**
  - One reader for a Story's words and the code's names: split at case changes, acronyms too, and a long word's
    "-er" folded ("grapher" is "graph", "plotter" is "plot"), on both sides. Used by every record, the template and
    docs ranking and the brief's header. Area selection splits the Story's words and folder names the same way; its
    match by prefix already met "grapher".
  - Before the Story plans or changes a file, "What a change touches" lists the code files whose own names its words
    match: at most 3, never a test, as "`src/components/FunctionGrapher.jsx` (name matches the Story's words)". Once
    there is a plan or a change, its files lead (REQ-007).
  - The architect's brief has that section, second after contracts, and only from the Story itself. A Story whose
    words name no file gets no list of the code's busiest functions there.
  - The brief's renderer is version 2, so a brief kept by version 1 is composed again (REQ-013).
- **Replayed after the fix** (the same 107 steps, all replayable):

  | What | Before (kept) | M1 and M2 (replayed) | With the fix (replayed) |
  |---|---|---|---|
  | Plan and code steps whose brief names a changed file | 93% (40 of 43) | 93% (40 of 43) | **100%** (43 of 43): plan 12 of 12, code 31 of 31 |
  | … the file the Story changed most | 67% (29 of 43) | 84% (36 of 43): plan 5 of 12 | **98%** (42 of 43): plan 11 of 12, code 31 of 31 |
  | Graph Stories whose planning brief names the grapher file | 0 of 6 (0 of 7 briefs) | 0 of 6 (0 of 7) | **6 of 6** (7 of 7) |
  | Graph Stories' code briefs naming it | 11 of 20 | 20 of 20 | 20 of 20 |
  | Wrong claims | 97 of 1,164 judged | 0 | 0 |
  | Brief bytes, all steps (plan median) | 239,404 (2,752) | 99,456 (2,266) | 100,150 (2,308) |
  | Briefs identical across Stories | 26 | 2 plan briefs of 2 Stories | the same 2 |

  - The one plan step that misses its most-changed file is a Story titled "bimary": its words name no code. It and a
    Story titled "bin (copy)" keep identical planning briefs for that reason.
  - Code briefs changed in one Story only: its rules now lead with the grapher's own rules instead of the interest
    calculator's.
  - Goldens: the 6 design goldens of the three fixtures with a change gain the section, naming the Story's own changed
    function. A few contract and rule lines move into the "… N more" pointer to keep the 3 KB budget. No other golden
    changes; the word reader alone changes none.
- **New Stories.** A13 asks for new Stories of the same app after the change. The replay re-composes the same Stories'
  steps instead. Once the owner has run new Stories, the same command without `--replay` measures them.

**Follow-ups already known:**
- An area-size cap for one huge folder (P2: a flat `src/` of 1,081 files is one area and takes about 27 s cold).
- A component whose parameters span lines (`export const X = ({\n … }) => …`) is not read as a function (P1).
- Area selection matches folder names only. In a repository too large to build whole, a planning step whose words
  name a file but no folder still gets no brief. Matching file names there would build more areas while composing
  (P2's cost), so it is left until it is measured.
- `wm show --focus` and the approved requirements' word leads keep their own readers. The first matches by substring
  and so already reaches "grapher" from "graph"; the second does not fold "-er".
- A plan's file table can name a file that is not code (a Story's evidence picture). It is listed as "(new, planned)"
  (REQ-007), and now in the architect's brief too.
