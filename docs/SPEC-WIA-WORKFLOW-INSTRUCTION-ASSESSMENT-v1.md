# SPEC-WIA v1 — Workflow Instruction Assessment

**Product:** Singularity Flow
**Date:** 15 November 2026
**Status:** Built: `workflow assess`, Copilot's checked findings, the text-edit builder moves and `workflow build start --assess`; open decisions in section 8.
**Namespace:** WIA. Specification documents declare their own namespace in their header (see [DOCUMENTATION-MAP.md](DOCUMENTATION-MAP.md)); no other document uses WIA.
**Source baseline:** commit bd90bcc46
**Companions:** [Workflow authoring topic](topics/workflow-authoring.md) (`workflow assess`), `workflow check` (src/workflow-check.mjs), `workflow fix` (src/workflow-fix/), `workflow walk` (src/workflow-walk/), the workflow builder (src/workflow-build/)
**Normative language:** MUST, MUST NOT, SHOULD and MAY express requirements.

## 1. The request

The owner, 2026-11-15:

> "sf-fix-workflow and sf-buidl-workflow should check for any contradictiry instructions also ..check for reduntent instructions and should make it lean and crip and clear ... it should give a detail assement on the custom workflow people create and give suggetions should be able to implement that"

## 2. Decision

**`workflow assess [WORKFLOW]` is one read-only subcommand under `workflow`, not a section of `workflow check`.** [WIA:REQ-001]

Why a subcommand:

- `workflow check` runs on every `workflow validate`, Story-start preflight, Workflow Studio check and `workflow fix`; reading every layer's full text and comparing sentence pairs there would slow each of them, while an assessment is asked for.
- Check findings are inputs to `workflow fix` (a ratchet requires a fixer for every `CHECK_*` code), the simplify candidates and the build's verification. Assessment findings are about wording: they have their own codes (`ASSESS_*`), their own suggestions as builder moves, and never change what `workflow check` or `workflow validate` say, so no existing caller or shipped count moves.
- Its result has its own type (`workflow-assessment`), so `workflow check --json` keeps its schema.

No new top-level command family is added: `assess` is a `workflow` subcommand, classified a read.

## 3. What a step's agent receives [WIA:REQ-002]

For each step, the layers, as src/phase-prompt-composer.mjs puts them together, each with its file, owner and size in bytes and estimated tokens (about four characters a token), and the whole:

| Layer | Source |
|---|---|
| agent | the agent file's instructions, without the skill tables Studio keeps (`withoutAttachedSkills`, `Remote skills`) |
| step | the step's template, as this workflow runs it |
| skill, instruction | the skills the step's agent uses for it and the instructions they place (on-demand skills counted apart) |
| workflow | the workflow's own skills and its constitution |
| platform | the composer's own renderers on a Story at the step's first draft: the phase contract lines, the clarification checkpoint and final guard, the runtime protocols, the approved-inputs lead (`APPROVED_INPUTS_LEAD`) and the MCP policy |

Paths come from the Studio model, so an agent file is read wherever the repository keeps its agents (`.github/agents` or `singularity/agents`).

**Ownership** [WIA:REQ-003]. `team`: the repository's own text. `sflow`: a line SFlow ships in its own agents, templates, skills or instructions (kept in a copy too), and the boundary every agent file carries (`STORY_AGENT_BOUNDARY`, `REPOSITORY_AGENT_BOUNDARY`, `AGENT_CLARIFICATION_GUIDANCE`). `platform`: composed. Team text is judged for everything; SFlow's own only for what contradicts the step it runs in (it repeats itself on purpose so each agent file holds on its own, and changes with SFlow); the platform's is the reference and never judged.

## 4. Findings [WIA:REQ-004]

Every finding has a code, a kind, a severity (problem, warning, note), plain words, the exact quoted text, its file and line, the steps that read it, and a suggestion with its expected saving.

| Code | Kind | Severity | What |
|---|---|---|---|
| ASSESS_WRITES_CODE_IN_NO_CODE_STEP | contradictory | problem | told to write or change code in a step whose write scope writes no code |
| ASSESS_COMMITS_WHERE_KERNEL_COMMITS | contradictory | problem | told to commit, push or open a pull request; publishing records the work |
| ASSESS_CONTRADICTS_PLATFORM | contradictory | problem / warning | told to approve work (problem); to set the template aside, or change an approved earlier document (warning) |
| ASSESS_ASKS_WITH_CLARIFICATION_OFF | contradictory | warning | told to ask a person where the step asks nothing |
| ASSESS_RULES_CONFLICT | contradictory | warning | `guidanceConflicts` across every layer of the step, the platform's included |
| ASSESS_TOOL_UNAVAILABLE | contradictory | warning | a command its agent has no tool to run; an MCP server the step does not have; a script the repository does not have |
| ASSESS_SECTION_NOT_IN_TEMPLATE | contradictory | warning | a section its template has no heading for |
| ASSESS_BARE_CLAUSE_NUMBERS | contradictory | warning | bare `REQ-`/`AC-` numbers against the clause-ID rules |
| ASSESS_REPEATED_IN_STEP | redundant | note | a sentence or run of sentences the agent reads twice, in any two layers (near-duplicate matching) |
| ASSESS_RESTATES_PLATFORM | redundant | note | a sentence the platform's rules for that step already say |
| ASSESS_REPEATED_ACROSS_STEPS | redundant | note | one rule in several files that reach different steps |
| ASSESS_STEP_OVERSIZED | lean | warning | the step's team text is over 6,000 bytes and twice the workflow's typical step, with its biggest sections |
| ASSESS_OTHER_STEP_WORK | lean | warning | a section or sentence about another step of the workflow its readers never draft |
| ASSESS_VAGUE_WORDING, ASSESS_NESTED_CONDITIONS, ASSESS_LONG_SENTENCE | unclear | note | vague phrases, three or more conditions, more than 40 words (at most five a file each) |

Near-duplicates are stemmed content-word sets: Jaccard 0.75 or more, at least five words; against the platform 0.6, or 0.8 of the team sentence's words in one platform sentence. All heuristics are deterministic.

**Suggestions** [WIA:REQ-005]. `decidedBy: sflow` only when the change makes the text say what the step already does, so it cannot change how a Story runs (taking out a contradiction the settings already overrule, a duplicate, a restatement, another step's text, or keeping a repeated rule in one shared instruction). A choice between two of the team's rules, or a change of behavior (turning questions on, letting a step change code), is `decidedBy: person`, with each choice's moves. A finding no move makes (an oversized step, vague wording) names what to do; Copilot drafts the rewrite. Two findings about the same text share one change.

## 5. The report [WIA:REQ-006]

`workflow assess WORKFLOW` prints, per workflow: the counts, a verdict (a Story would misbehave; stories run with contradictory or unclear instructions; could be leaner; nothing to change), the size split (team, SFlow, platform, on demand), each step's layers with sizes and biggest sections, then each finding with its place, quote, why and suggestion with its saving, and how to apply them. `--json` returns the same result; the text is rendered from it, and the tests compare them.

## 6. Copilot's judgement, as suggestions only [WIA:REQ-007]

- `--read STEP [--part N]` gives one step's team text, each line with its file line number, in parts of at most 2,800 bytes of text, so each JSON part stays within a 4,000-byte agent view. Part 1 carries the step's settings, the platform rules it must agree with, and what SFlow already found.
- Copilot writes its findings `{ findings: [{ step, file, line, quote, kind, why, severity?, rewrite? }] }` to `next.findingsPath`, a private file issued to live `/sf-fix-workflow` and `/sf-build-workflow` turns, and runs `--verify`.
- SFlow checks each: the step exists; the file is one its agent reads; the text is the team's, not SFlow's; the quote (whitespace aside) starts on the named line; it is not a finding SFlow made; a Copilot finding is a warning or a note. A refusal says how to repair it ("Set line to 15."); the skill repairs and verifies again in the same turn.
- An accepted finding is `by: copilot`, `label: "Copilot's finding"`, `authority: suggestion`, `decidedBy: person`; a `rewrite` becomes the edit move. Copilot proposes it with `workflow build propose --by copilot`; a person accepts or declines each.

## 7. Applying suggestions [WIA:REQ-008]

**New builder moves** (src/workflow-build/text-moves.mjs), anchored on exact text that occurs once in the text as the build leaves it so far:

- `agent.edit { agent, old, new?, copy? }`, lowered to `agent.update`;
- `skill.edit { skill, old, new?, copy? }`, lowered to `skill.update`;
- `instruction.edit { instruction, old, new? }`, lowered to `instruction.update`;
- `step.change { id, edit: { old, new? } }`: the step's template as this workflow runs it, lowered to `template.update`;
- `instruction.extract { id, description, text, from: [{ agent|skill|instruction|step: ID, old }], label?, skill?, steps? }`: an instruction with the rule, one carrier skill (`<workflow>-shared-rules`, one `<instruction>` line a rule) attached to the workflow for `steps`, and the rule taken out of each source.

A file another workflow uses is never changed under it: an agent or skill is changed on a copy (`copy: <new ID>`; `agent.create` from it with the edited text and `phase.agent` for this workflow's steps, or `skill.create` with its attachments moved), a template on a copy this step uses in this workflow (`template.create` and `phase.update` with `workflow`, like changesCode's copy); a shared instruction is refused with what to do. A move that would leave an agent, skill or instruction empty is refused.

**`workflow build start --assess ID`** changes the workflow in place. Every suggestion with moves, and each choice of a person's suggestion, is a candidate, checked before it is offered: its moves must fit (`validateMoves`), and the assessment runs again on the result (text-only edits on the edited text in this process; anything else staged through Workflow Studio's plan with `workflow check` too). One that would add a problem, or that Workflow Studio could not save, is listed with the reason and not offered. Each offered one is a proposal by SFlow with `effect` (size and counts before and after). `workflow build decide --build ID --accept --all` accepts every pending one SFlow decided itself, checked together by one plan. `workflow build verify` runs `workflow validate`, `workflow walk` and the assessment on the result, before and after; an assessment problem still there is one the person accepts by ID, like a walk stop. The build finishes as one reviewed proposal; nothing changes until it is approved.

**Skills** [WIA:REQ-009]. `/sf-fix-workflow` steps 6 and 7 and `/sf-build-workflow` step 8 run the assessment, read and verify Copilot's findings, and walk the person through each suggestion (or all of SFlow's at once). No new stop, relay or hand-off reason: each issue is repaired in its own step. The fix-workflow turn may finish the assess build (`workflow build finish`) and edit the files issued to it, like the build-workflow turn. Budgets raised with their measured sizes: `sflow-fix-workflow` 1,616 body tokens (override 1,160), `sflow-build-workflow` 1,789 (override 1,330).

## 8. Open decisions for the owner

1. **Thresholds.** Oversized at 6,000 bytes and twice the typical step; a long sentence at 40 words; near-duplicates at 0.75. Kept conservative so the shipped workflows have no finding; the owner may tighten them.
2. **Extraction grows each step's prompt slightly.** A rule kept in one shared instruction is still read once by each step, now with its skill line; the team keeps one copy instead of several. It is offered as SFlow's own change; the owner may prefer it to be a person's choice.
3. **Severity of "ask with clarification off".** A warning, since the platform's final guard overrides it; an agent that follows it can still stop to ask.
