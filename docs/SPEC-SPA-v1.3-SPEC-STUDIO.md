# SPEC-SPA v1.3 — Spec Studio

**Status:** accepted. S0 (inventory: [SPEC-STUDIO-S0-INVENTORY.md](SPEC-STUDIO-S0-INVENTORY.md)), S1 (the model-free library), S2 (Story slices; its live Copilot check ran on 1 November, §10.1, found REQ-018 unmet, and passed on a rerun after its fix), S3 (the Studio panel, model-free, verified in real VS Code), S4 (generation: proposals, assisted findings, `/sf-spec-author`, the `spec-studio` turn mode and `#sflowSpecStudio`, built and verified model-free; its paid live Copilot authoring run ran on 1 November, §10.2, and published a reviewed specification after two guard gaps and a missing directory were found) and S5 (split: a reviewed revision divided among child specifications and Story slices, with coverage, model-free, verified in real VS Code) have landed.
**Author:** Singularity Flow
**Date:** 31 October 2026
**Namespace:** SPA. Clause IDs here replace v1.2's; an older clause is cited as "v1.2 REQ-015".
**Baseline inspected:** main `edd1498f4`
**Supersedes:** SPEC-SPA v1.2. v1.2's storage, publication and reading rules (its §3.2–§3.6) are kept as this plan's library layer. v1.2's trial is replaced by the code findings in §1 and a live check at S2.
**Shape:** a VS Code Spec Studio over a model-free library. Copilot generates; a person decides and publishes.

Normative requirements use MUST, MUST NOT, SHOULD and MAY.

## 0. Summary

What was asked for:
1. **A Spec Studio:** a place to write, research, question and review a specification before any Story exists.
2. **Generated specs:** Copilot drafts the specification, researches the code, and finds the gaps.
3. **Stored on the state branch:** each published revision is immutable.
4. **Stories attach a spec and implement part of it.**
5. **One spec splits into child specs and Stories.**

The plan keeps v1.2's small library underneath: local drafts, immutable revisions on the state branch, pinned reads. It adds the Studio, Copilot generation, Story slices with coverage, and splitting on top.

Two findings from today's code shape it (§1):
- Pinning a document is not enough. Stories released from an Epic carry the Epic's requirements and Decisions table on their branch, but the agent never sees them.
- Nothing links a Story's clauses to the parent clauses it delivers. Nothing checks that the Stories together deliver the parent.

| | v1.1 | v1.2 | v1.3 |
| --- | --- | --- | --- |
| Studio UI | Views listed, not designed | None | Three-column VS Code Studio (§3) |
| Generation | Optional assisted drafting | None | Copilot proposes clauses, research, gaps and checks. A person accepts (§4) |
| Storage | 10 record families, a catalog | 3 families, no catalog | 6 families, no catalog (§8) |
| Story use | Decision import with applicability proofs, clause adoption with ID rewriting | Attach the whole document | Attach a slice of clauses. Its text and decisions go into the Story's prompt. The existing scope gate makes the Story cover them (§6) |
| Splitting | Not covered | Not covered | Split into child specs and Story slices, with coverage (§7) |
| New engines | Many | None | None. Reuses the knowledge model, the analyzer, the state-branch publisher, the Story source, the scope review and the Workflow Studio pattern |

## 1. What today's code does

A model-free probe on 31 October ran the local Epic route end to end and read the code:

| Question | Finding | Where |
| --- | --- | --- |
| Do released Stories get a hash-bound specification? | Yes. The Epic copies `requirements.md` (Decisions included), `traceability.yml`, `impact-analysis.yml`, `parent-specification.md` and `story-specification.md` into `singularity/story-context/<WORK-ID>/` and pins their hashes as `governedContext` | `initiative-repositories.mjs:583-667`, `:727-735` |
| Does the agent see them at the Story's first step? | **No.** The intake prompt gets only the Story's title, its description and the bare AC IDs ("AC-001\nAC-002"). It gives no requirement text, no decisions and no path to read. Only the finalize check and `story fetch` read `governedContext` | `commands/start.mjs:1413-1418`, `phase-prompt-composer.mjs:290-302`, `story-lineage.mjs:772-783` |
| Do attached Story documents reach the agent? | Yes, offered to the phase as supporting evidence | `phase-prompt-composer.mjs:884`, `document-runtime.mjs` |
| Is a Story's clause linked to the parent clause it delivers? | No. The Story writes `[WORK-ID:AC-001]` in its own namespace. It shares a name with the Epic's AC-001 and nothing more | `templates/workflow.yml:640-643` |
| Is delivery checked across sibling Stories? | Only allocation at Epic planning ("not allocated to any planned Story"). Nothing checks that the started Stories cover the parent | `epic-traceability.mjs:99` |
| Do decisions feed later prompts? | Approval harvests decisions into knowledge records. "Prior knowledge" is composed only into Epic prompts, not Story prompts | `initiative-context.mjs:213` |

So the core of "a Story can attach a spec" is getting the spec's clauses and decisions into the Story's prompt. Holding them in the Story's branch is not enough. [SPA:REQ-001]

## 2. Concepts

| Term | Meaning |
| --- | --- |
| Spec | A specification in the repository's library, ID `SPEC-` plus uppercase letters, digits and hyphens (`SPEC-CHK-004`) |
| Draft | The one editable copy of a spec on this clone (v1.2 REQ-006 to REQ-008: shared Git storage, one immutable snapshot per save, operation IDs) |
| Revision | An immutable published copy, `SPEC-CHK-004@3` |
| Clause | A requirement, behaviour, acceptance criterion or constraint with a literal anchor, `[SPEC-CHK-004:REQ-003]` |
| Research item | A fact the spec relies on, with its basis: `code` (a cited span verified by hash), `document` (an attached file) or `person` (stated by someone, named) |
| Gap | An open question in the spec. Kinds: `code-disagrees`, `missing-unwanted-path`, `vague-term`, `missing-boundary`, `open-question` |
| Decision | How a gap was closed: the chosen option's exact wording, the reason, the signer, and the time. Or a deferral with an owner |
| Quality report | The check result in three parts: **D**, deterministic analyzer rules; **A**, assisted checklist findings that Copilot proposed and a person accepted or dismissed; **H**, the person's decisions on gaps and checklist articles |
| Slice | The clauses of one revision that one Story delivers |
| Split | A published plan that divides a revision's clauses among child specs and Story slices |
| Coverage | For each clause of a revision: which slices it is allocated to, which Stories claim it, and which have delivered it |

## 3. The Studio

The Studio is a VS Code panel built like Workflow Studio and its Build view: a lazily loaded panel, page logic in a `*-page.ts` file with pure helpers exposed for tests, and every read and write going through the CLI's `--json` commands. The panel never writes Git or files itself. [SPA:REQ-002]

Layout, three columns as in the requested mockup:

| Column | Shows |
| --- | --- |
| Left | Quality gate status: D rules passed, A checks pending, H decisions open. The governed records of the selected revision or draft (`spec.md`, `gaps.json`, `research.json`, `quality.json`). The authoring loop's seven steps with the active one marked. The gap pipeline, open gaps first |
| Middle (the stage) | The active step's work. For Review gaps: the gap, its evidence, its options, each option's computed impact, a rationale box, and **Close gap with option and sign**. Other steps get their own stage: research list, draft proposals, check findings, publish summary, attach, split planner, coverage |
| Right | The live `spec.md`, clause by clause, with literal anchors, linked citations, and flags on clauses touched by an open gap (for example "code disagrees, GAP-012") |
| Bottom tabs | Quality findings, state-branch manifest of the selected revision, the Copilot turn in progress |

Entry points: a Specifications item in the Navigator and the command `singularityFlow.openSpecStudio`. The Studio also opens from a Story when its intake step has a spec attached, focused on that slice. [SPA:REQ-003]

Every action has a CLI equivalent (§9), so the Studio is never the only way to do something. A person can author a spec with no model at all. [SPA:REQ-004]

The Studio keeps the person's steps few. Closing a gap is one choice plus a reason. Publishing is one confirmation that names the revision. Attaching is one Story command. Cancel and Back work on every stage, as everywhere else in the extension. [SPA:REQ-005]

## 4. The authoring loop

Seven steps, shown in the left column. A person can move between them freely. Only Publish is gated, by the check.

| Step | What happens | Who |
| --- | --- | --- |
| 1. Elicit | Title, intent, area of code, template. Copilot may propose an outline | Person, Copilot proposes |
| 2. Research | Facts the spec relies on, each cited. Code facts come from the knowledge model: rules, limits, entry points, journeys, test cases, and test/code disagreements, each with a path, lines and `spanSha256` | Runtime collects; Copilot proposes more |
| 3. Draft | Clauses with literal anchors, written in EARS shape where it fits | Copilot proposes; person accepts or edits |
| 4. Review gaps | Questions found by research or drafting, each with options and computed impact | Copilot or person opens; **person decides** |
| 5. Check | D, A and H, as in §5 | Runtime runs D; Copilot proposes A; person settles A and H |
| 6. Publish | A new immutable revision on the state branch (§8) | **Person** |
| 7. Attach or split | Story slices (§6) or a split plan (§7) | Person, Copilot proposes |

### 4.1 Generation is proposal-only

Copilot generates through a `/sf-spec-author` skill (`/sf-spec` stays the traceability skill it was, so the authoring turn has its own name) and a `#sflowSpecStudio` chat tool, the way the workflow builder works through `/sf-build-workflow` and `#sflowWorkflowBuilder`. Each Copilot output is a proposal: a draft edit, a research item, a gap with options, or an A-check finding. It is validated when staged and lands in the draft only when a person accepts it. One acceptance can take many proposals. [SPA:REQ-006]

A Copilot turn on a spec is a new turn mode, `spec-studio`. Its spec commands are reads plus proposal staging. Accepting proposals, deciding or deferring gaps, settling A and H, publishing, splitting and discarding are person-only. They MUST be own-terminal steps in `copilot-mutation-guard.mjs`: an agent is refused and given the person's exact command line. [SPA:REQ-007]

No model decides, approves or publishes. A spec authored entirely by hand has the same standing as a generated one. [SPA:CON-001]

### 4.2 Research is cited and verified

A `code` research item MUST cite a span by path, line range and `spanSha256` at a named commit. The runtime verifies the span when the item is staged and again at check, as the knowledge model already verifies its items. A changed span marks the item stale. A stale item stays visible and blocks a reviewed publication until the person refreshes or removes it. A Copilot item that cites nothing is shown as unverified and can support no clause. [SPA:REQ-008]

### 4.3 Gaps, options and impact

A gap is an append-only event list (v1.2 REQ-010): opened, decided, deferred, reopened. An opened gap carries its kind, the question, the evidence it came from (research item or clause IDs) and up to four options. Each option has its clause wording. [SPA:REQ-009]

Each option's **impact** is computed with no model by the knowledge model's `buildImpactRecords`, from the paths and symbols its evidence cites: the functions touched, their callers, the entry points that reach them, the rules they hold, the tests that reach them, and the files that usually change with them. Customer-impact and effort sentences are Copilot proposals, labelled as such. [SPA:REQ-010]

Deciding a gap records the chosen option's exact wording, the reason and the signer: the person's Git identity, as on any approval. "Close gap with O1 and sign" in the Studio runs exactly that command. [SPA:REQ-011]

`spec.md` MUST state every decided or deferred gap's outcome by its ID in its "Decisions and open questions" section, so the published text carries the decisions itself (v1.2 REQ-012). Accepting a decision MAY insert a proposed sentence there as a pending proposal. The person's prose is never rewritten silently. [SPA:REQ-012]

## 5. Check

`spec author check` produces the quality report. It needs no model. [SPA:REQ-013]

| Part | Contents | Blocks a reviewed publication when |
| --- | --- | --- |
| D (deterministic) | The existing `analyzeSpecification(markdown, { namespace })`, unchanged; the template's required sections; literal clause anchors (an escaped-anchor or empty file has no clauses, v1.1 AC-001); `spec.gap-open`, `spec.decision-unstated`, `spec.research-stale`, `spec.citation-unverified`, `spec.section-missing`; template text left in (`spec.placeholder`, and `spec.template-example` for the example decision older templates carried) | Any blocking analyzer finding, or any of the library findings |
| A (assisted) | Copilot's findings against the analyzer's six starter checklist articles: completeness, ambiguity, consistency, verifiability, boundary conditions, non-functional. Each is accepted (it becomes a gap or an edit) or dismissed with a reason | Any finding still pending. With no Copilot run, A shows "not run", which is allowed and stated in the manifest |
| H (human) | Gap decisions, plus a decision on each checklist article (`satisfied`, `exception`, `not-applicable`, the analyzer's existing `CHECKLIST_DECISIONS`) | Any open gap, or any article without a decision |

`quality.json` is the report as checked: analyzer version, finding counts per part, and each finding. It is published with the revision. [SPA:REQ-014]

## 6. A Story attaches a slice

### 6.1 Attaching

`start <WORK-ID> ... --spec SPEC-CHK-004@3=REQ-001,REQ-003,AC-002` starts a Story that delivers those clauses. Without `=…` it delivers the whole revision. Without `@N` it pins the highest reviewed revision at that moment (v1.2 REQ-020). The flag may repeat for several specs, once per spec. A slice is attached only at start: a Story's creation commit makes its resolved policy, including its source digest, immutable, so `spec attach WORK-ID SPEC-ID…` on a started Story is refused (`SPEC_SLICE_ATTACH_AT_START`) and names the start command (S2). [SPA:REQ-015]

Only reviewed revisions can be attached. A draft revision is refused with `SPEC_LIBRARY_NOT_REVIEWED` (§12 Q4). [SPA:REQ-016]

A clause named in a slice MUST exist in the pinned revision. A slice that names a clause depending on an unnamed one (by explicit link in the spec) is refused, naming both, unless `--allow-partial-dependency` is given with a reason. [SPA:REQ-017]

### 6.2 The slice reaches the prompt

The slice MUST become part of the Story's immutable source, the record the prompt already composes as "Pinned Story source" with the authority "this is the requested outcome". It is an optional `specification` field, present only when a slice is attached, merged after the source is normalized and added to the composer's field allowlist; the clauses are an array of `{ anchor, text }` entries, so each becomes its own scope statement (S0). It contains:
- each sliced clause's exact text with its anchor;
- the decisions those clauses cite, and every decided gap of the revision, with their outcomes;
- the other clauses as anchors and first lines only, marked "not this Story";
- the revision ID, manifest digest and state commit.

So the agent sees the decided questions as settled, and the existing clarification rule ("what they state is settled, never asked again") applies to them. [SPA:REQ-018]

The S2 live check (§10.1) found this unmet: the clarification rule named only approved phase inputs, so under a `required` clarification mode the agent asked a slice's decided questions, proposing their decided answers as defaults. Since `07ac0da4f` the checkpoint instruction names the pinned slice as settled; on a rerun no settled question was asked on its own, though each Story still restated them in its one required confirmation.

A slice larger than the Story source's size limit is refused at attach, naming the size and the limit. It is never silently cut. [SPA:REQ-019]

### 6.3 The Story must cover its slice

Each sliced clause becomes a statement of the Story's scope inventory. The existing scope review then requires a Story clause that covers it, citing its `sourceReference`. This is the same gate that already makes a Story cover its request. A Story therefore implements its part of the spec under its own Work ID, and every covering Story clause links back to the spec clause it delivers. There is no ID rewriting and no adoption engine. [SPA:REQ-020]

A Story MAY add clauses of its own beyond its slice. It MUST NOT drop a sliced clause. To drop one, the person detaches it with a reason (`spec attach WORK-ID --drop REQ-003 --reason TEXT`, person-only). It is the existing scope decision on that clause's item: recorded `excluded` with the reason, by a person in the group that decides the Story's scope, so the final check no longer requires it and the usage records list it as dropped (S2). [SPA:REQ-021]

### 6.4 Coverage

After a Story's first step is approved, its claim on each sliced clause is written to the state branch as one immutable usage record per approved generation of that step (`singularity/specifications/<SPEC-ID>/usage/<WORK-ID>/<NNNNNN>.json`); closing the Story adds `delivered.json`. It is written after the approval has landed, never inside it. Paths are disjoint per Story, so two Stories never collide on a file; they share the state ref, and a lost race is retried. Closing the Story appends a delivered record that cites its evidence receipt. A usage write that fails is retried from the Story's approval or closure receipt by `spec author coverage SPEC-ID@N --repair --story WORK-ID`, which reads the Story's committed record and writes the same bytes. It never blocks the Story. [SPA:REQ-022]

`spec author coverage SPEC-ID@N` reads one pinned state commit (`spec coverage` is already Story clause coverage). For each clause it shows: allocated (by a split), claimed (approved Story first step), delivered (closed Story with evidence), or uncovered. The Studio shows the same thing as a coverage stage. An unreadable state branch is reported as unavailable, never as "uncovered". [SPA:REQ-023]

## 7. One spec splits into child specs and Stories

`spec split SPEC-CHK-004@3` opens a split plan. Copilot may propose one. Its entries are:
- **child specs:** a new spec ID, a title, and the parent clauses it takes forward. Each child is drafted with those clauses' text and `derivedFrom: SPEC-CHK-004@3`, and goes through its own authoring loop and revisions;
- **Story slices:** a title, a description and a clause list. Each becomes one `start … --spec SPEC-CHK-004@3=…` command, ready to run;
- **not delivered here:** clauses explicitly left out, each with a reason. [SPA:REQ-024]

A split MUST allocate every clause of the revision at least once, or list it as not delivered here. Dependencies between Story slices MUST be acyclic. This is stricter than Epic planning, which requires only acceptance criteria to be allocated; a small pure module checks both rules (S0). [SPA:REQ-025]

The person publishes the split. It is stored as `singularity/specifications/<SPEC-ID>/splits/<NNNNNN>/split.json`, bound to the parent revision's manifest digest. Publishing a split creates the child drafts on this clone and lists the Story start commands. It starts no Story by itself: starting a Story stays the Story's own command, run by whoever takes it. [SPA:REQ-026]

A child spec's revisions are independent of the parent's. A later parent revision does not change a child or a started Story. The coverage view shows children whose source clauses changed in a later parent revision as "parent moved", for a person to review. [SPA:REQ-027]

A split creates Stories directly, not an Epic (§12 Q1). Epics remain the route for cross-repository delivery with a merge order.

As built (S5): the plan file is JSON or YAML with `children` (`specId`, `title`, `clauses`), `stories` (`key`, `title`, optional `description`, `workId` and `dependsOn` keys, `clauses`) and `notDelivered` (`clause`, `reason`). A slice delivering a clause that depends on a clause another slice delivers comes after that slice, and the cycle check includes those implied edges. `--propose` checks the plan and keeps it on this clone (`$git/spec-split-proposals/<SPEC-ID>/<NNNNNN>.json`, family `spec-split-proposal`); `--publish` checks it again and publishes it. Each slice's command is ready to run: one depending on a clause it does not deliver carries `--allow-partial-dependency --reason` naming where that clause goes. A child's draft re-anchors each parent clause under the child's ID with the parent's number (`SPEC-CHK-004-INR:REQ-001` carries `SPEC-CHK-004:REQ-001`) and lists the parent's decisions on them; `derivedFrom` records the parent revision, the split and each clause's text digest, and a child revision's manifest carries it. Only a reviewed revision can be split, and publishing refuses a child ID the library or another split already holds.

## 8. Storage

The library layer is v1.2's, unchanged in behaviour (v1.2 REQ-006 to REQ-009, REQ-015 to REQ-020): local drafts in the clone's shared Git storage, one immutable snapshot per save, operation IDs and expected sequences, backup coverage, publication through `publishToStateBranch` with an `absent` precondition and `exactBlobSha256`, pinned reads through `committedFileText`, no catalog file, bounded retry, and "unknown" never reported as failure. [SPA:REQ-028]

A revision directory holds the records the mockup shows:

```text
singularity/specifications/<SPEC-ID>/<NNNNNN>/
  manifest.json   specId, revision, parent revision, derivedFrom, reviewState, operationId,
                  publishedBy, recordedAt, analyzer version, D/A/H counts, SHA-256 of every file
  spec.md         the draft's prose, byte for byte
  gaps.json       the gap events, in order
  research.json   the research items with their citations and verification state
  quality.json    the check report (§5)
singularity/specifications/<SPEC-ID>/splits/<NNNNNN>/split.json
singularity/specifications/<SPEC-ID>/usage/<WORK-ID>/<generation>.json
```

JSON uses the repository's `canonicalJson`. [SPA:REQ-029]

| Family | Holds |
| --- | --- |
| `spec-draft@1` | Local draft snapshot: spec.md, gap events, research items, accepted and pending proposals, sequence, operation ID |
| `spec-manifest@1` | Published manifest |
| `spec-gap-ledger@1` | Ordered gap events (in drafts and revisions) |
| `spec-research@1` | Research items |
| `spec-quality@1` | Quality report |
| `spec-split@1` | Split plan |
| `spec-usage@1` | A Story's claim or delivery of clauses |
| Story source | No version bump: an optional `specification` field, present only when a slice is attached (§6.2, S0) |
| `local-backup-manifest` | Version bump: carries spec drafts (v2) and split proposals (v3) |

Every family is registered in `schema-migrations.mjs` with current and future-version refusal fixtures, under a GDP companion lock review. [SPA:IFC-001]

## 9. Commands

| Command | Who | Effect |
| --- | --- | --- |
| `spec author new SPEC-ID --title TEXT [--from FILE]` | anyone | New draft from the template or a Markdown file |
| `spec author edit SPEC-ID --file FILE --expected-seq N` | anyone | Saves prose as the next snapshot |
| `spec author research SPEC-ID [--path PATH]... [--symbol NAME]... [--refresh]`, `--fact TEXT --source NAME`, `--remove R-NNN` | anyone | Collects or refreshes knowledge-model items with the tests that exercise them; adds a person's fact; removes an uncited item |
| `spec author propose SPEC-ID --file FILE` | anyone (Copilot's route) | Stages proposals; validates them; changes nothing accepted. The issued `proposalPath` (its folder made by `status --json`) is removed once staged; a refused file is kept for its repair |
| `spec author accept SPEC-ID PROPOSAL-ID... [--edit FILE]` | person | Accepts proposals into the draft |
| `spec author gap SPEC-ID --kind KIND --question TEXT [--research R-NNN,...] [--options FILE]` | anyone | Opens a gap with its evidence and options |
| `spec author gaps SPEC-ID [GAP-ID]` | anyone | Read: gaps with each option's computed impact |
| `spec author decide SPEC-ID GAP-ID (--option O1 \| --choice TEXT \| --defer --owner NAME \| --reopen) --reason TEXT` | person | Closes, defers or reopens a gap |
| `spec author check SPEC-ID [--json]` | anyone | The quality report |
| `spec author reject SPEC-ID PROPOSAL-ID... --reason TEXT` | person | Turns proposals down; the draft is unchanged |
| `spec author settle SPEC-ID ([--article ARTICLE=DECISION]... \| --all-articles DECISION \| [--finding A-NNN=gap\|fixed\|dismissed]...) [--reason TEXT]` | person | Settles H checklist articles and A findings: `gap` opens one from the finding, `fixed` needs the prose changed since, `dismissed` needs the reason. Repeat the flag once per value or give one comma-separated list; a value without its flag is refused (`SPEC_AUTHOR_ARGUMENT_UNEXPECTED`), as it is for every `spec author` and `spec split` action |
| `spec author publish SPEC-ID (--draft \| --reviewed)` | person | Publishes the next revision |
| `spec author show SPEC-ID[@N]`, `spec author list`, `spec author status SPEC-ID` | anyone | Reads; `status` is the host's one call for the Studio |
| `spec author discard SPEC-ID` | person | Removes the local draft |
| `start … --spec SPEC-ID[@N][=CLAUSES] [--allow-partial-dependency --reason TEXT]` | as Story start | Attaches a slice (§6) |
| `spec attach WORK-ID --drop CLAUSE-ID --reason TEXT` | person | Drops a sliced clause: its scope item is excluded (§6.3) |
| `spec split SPEC-ID@N [--propose --file FILE \| --publish]` | anyone reads and proposes; person publishes | Split plan (§7). `--propose` is a global boolean flag, so the plan is `--file FILE` (S5) |
| `spec author coverage SPEC-ID@N [--repair --story WORK-ID] [--json]` | anyone; repair writes | Coverage (§6.4) |

Every operation that writes takes `--operation-id` (generated by hosts). Every refusal names a working recovery command, so `test/dead-end-routes.test.mjs` covers the new codes. Handlers are lazily loaded modules routed from `specCommand` before any Story loads, as `spec drift` is. Root and start closures grow only by the slice reader that Story start needs. [SPA:IFC-002]

Nothing runs unless a person or host invokes a spec command or attaches a spec. Existing Stories, existing `spec` subcommands and Story start without `--spec` keep their baseline output. [SPA:REQ-030]

## 10. Milestones

Ordered so that the core value, a Story that sees and delivers its spec slice, is proven early, before the Studio UI is built.

| Milestone | Scope | Exit gate |
| --- | --- | --- |
| S0 | Inventory: answer every "S0 confirms" row in §13; name the families; add guard entries (the `spec-studio` turn mode lands with S4, its skill); write the companion lock review | [SPEC-STUDIO-S0-INVENTORY.md](SPEC-STUDIO-S0-INVENTORY.md), every row answered |
| S1 | Library core, model-free: drafts, research collection, gaps and decisions, check (D and H), publish, show, list | AC-001 to AC-010 |
| S2 | Slices: attach at start and before the first approval, the slice in the Story source, the scope gate, usage records, coverage | AC-011 to AC-017, plus a **live Copilot check** (paid; asked for first): two Stories per arm, with and without the slice, counting settled questions asked again |
| S3 | The Studio panel, model-free: three columns, gap resolver with computed impact, check, publish, attach, coverage | AC-018 to AC-021, verified in real VS Code |
| S4 | Generation: `/sf-spec-author`, the `spec-studio` turn mode, the chat tool, proposals of every kind, A checks | AC-022 to AC-025, plus one live Copilot authoring run (paid; asked for first). Landed model-free; the live run ran on 1 November (§10.2) |
| S5 | Split: split plan, child drafts, Story start commands, "parent moved" | AC-026 to AC-029 |

| ID | Scenario | Observable result |
| --- | --- | --- |
| [SPA:AC-001] | New draft from the template; an escaped-anchor file; a file with no clause | Unique literal clauses; `spec.anchor-escaped` names the lines; `spec.no-clauses` |
| [SPA:AC-002] | Crash at each write boundary of a save; the same save retried; a stale sequence | Previous snapshot intact; the same snapshot returned; stale refused, draft unchanged |
| [SPA:AC-003] | `research` on the sandbox storefront | Knowledge items for the pricing rule and its tests, each with a verifying `spanSha256` |
| [SPA:AC-004] | A cited span changes after research | The item shows stale; `publish --reviewed` is refused naming it |
| [SPA:AC-005] | A gap with two options on `orderDiscount` | Each option shows callers, entry points, rules and tests from `buildImpactRecords`, with no model call |
| [SPA:AC-006] | An agent runs accept, decide, settle, publish, split or discard | Refused with the person's exact command; an agent may stage proposals and open gaps |
| [SPA:AC-007] | A decided gap missing from "Decisions and open questions" | `spec.decision-unstated` names it |
| [SPA:AC-008] | `publish --reviewed` with any blocking D, pending A or open H | Refused, naming each; `--draft` succeeds and is shown as draft |
| [SPA:AC-009] | Publish, then a fresh clone reads `@1` after `@2` | One commit with only the revision directory, digests verify; `@1` bytes unchanged |
| [SPA:AC-010] | Two clones publish the same spec; different specs; lost acknowledgement; unreachable branch | One wins with `SPEC_LIBRARY_REVISION_CONFLICT` for the other; both land; same revision returned; `SPEC_LIBRARY_UNAVAILABLE`, never empty |
| [SPA:AC-011] | `start S-1 --spec SPEC@1=REQ-001,AC-002` | The Story source carries the sliced clauses, the decisions and the out-of-slice list; the composed intake prompt contains them verbatim |
| [SPA:AC-012] | Slice names a clause not in the revision, or omits a clause a sliced one depends on | Refused, naming the clause(s) |
| [SPA:AC-013] | Intake draft does not cover a sliced clause | The existing scope review names the clause's `sourceReference`, and the Story's final check refuses while it is unresolved (the scope gate advises at publication and blocks at the end) |
| [SPA:AC-014] | `spec attach --drop REQ-003 --reason …` by an agent; by the person | Agent refused; the person's drop is recorded as the clause's scope item excluded with the reason, so nothing requires it |
| [SPA:AC-015] | First step approved; Story closed | One usage record per generation; a delivered record citing the evidence receipt |
| [SPA:AC-016] | The usage write fails | The Story proceeds; `spec author coverage --repair` writes it from the receipt |
| [SPA:AC-017] | A new revision is published after attachment | The Story keeps its pinned slice; coverage of `@N` is unchanged |
| [SPA:AC-018] | Open the Studio on a draft with an open code-disagrees gap | Left: D/A/H counts and the gap first; middle: options with impact; right: the clause flagged |
| [SPA:AC-019] | Close gap with O1 and sign | Runs `spec author decide … --option O1`; the event shows the signer and reason; the counts update |
| [SPA:AC-020] | Cancel or Back on every stage | No write; the draft is unchanged |
| [SPA:AC-021] | The panel's bundle | Within the lazy-panels ceiling, or the ceiling is raised in the same change with the measurement |
| [SPA:AC-022] | `/sf-spec` drafts clauses | Proposals only; nothing in the draft until accepted |
| [SPA:AC-023] | Copilot proposes a research item with no citation, or a bad span | Shown unverified and refused as clause support; bad span refused at staging |
| [SPA:AC-024] | Copilot proposes A findings | Pending until settled; publish refused while pending |
| [SPA:AC-025] | The whole loop with models disabled | Zero model calls; A shows "not run"; a reviewed revision can still be published |
| [SPA:AC-026] | A split that leaves a clause unallocated, or has a dependency cycle | Refused, naming the clause or cycle |
| [SPA:AC-027] | Publish a split | `split.json` bound to the parent digest; child drafts carry their clauses and `derivedFrom`; Story start commands listed; no Story started |
| [SPA:AC-028] | Parent `@4` changes a clause a child took from `@3` | Coverage shows the child "parent moved"; the child is unchanged |
| [SPA:AC-029] | Coverage after two slices are delivered and one is claimed | Per clause: delivered, claimed, allocated or uncovered, from one pinned state commit |

### 10.1 S2 live Copilot check (1 November 2026)

Copilot CLI 1.0.103 over ACP, one pinned model (the account default) for all four Stories, on main `7e8411670` with kernel model calls off. Four Stories, each in its own repository from the same storefront fixture, ran their first step (`specification`, clarification `required`, at most 5 questions) with the same first prompt (`/sf-phase`) and answers from one sheet written before any question was seen. The two Stories are each feature's first: "Continue button requires accepted terms" (SPEC-SIGNUP-001) and "Discount only above INR 5000.00" (SPEC-DISCOUNT-001). Each spec has three requirements, three acceptance criteria and five decided gaps; the Story delivers REQ-001, REQ-002, AC-001 and AC-002.

- **Slice arm:** `start --spec SPEC@1=REQ-001,REQ-002,AC-001,AC-002`.
- **Document arm:** the same revision's `spec.md` bytes, Decisions section included, attached with `start --document`. Both arms' composed prompts carry the decision text; a no-spec control was not run, since it would re-ask by construction.

| Story | Arm | Questions put to the person | Settled by the spec | New | Other Stories' clauses pulled in |
| --- | --- | --- | --- | --- | --- |
| SLC-1 | slice | 5 | 4 | 1 (tests) | none |
| SLC-2 | slice | 5 | 4 | 1 (tests) | "no amount-needed message", from a decision's wording |
| DOC-1 | document | 1 (confirm a reading of 6 points) | 5 points restated | 1 (about REQ-003) | REQ-003 and its wording, until the answer said "not this Story" |
| DOC-2 | document | 5 | 4 | 1 (tests) | "no amount-needed message" |

Findings:
- **Settled questions are asked again in both arms (REQ-018 unmet).** Every proposed default equalled the decided answer, so the agents read the decisions; they asked because the mode is `required` and the clarification instruction (`src/clarifications.mjs`) treats only approved phase inputs as settled. Its own fallback, one confirmation of a concise interpretation, was used once (DOC-1).
- **The slice keeps the Story to its part.** With the whole document, DOC-1 planned the other Story's clause (listing missing items) until a person excluded it. Both slice Stories left REQ-003 and AC-003 alone. Decision text still travels whole, which is how both F2 Stories picked up a clause about a message that belongs to the other Story.
- **The slice makes the spec a scope obligation.** Each sliced clause was its own scope item: SLC-1 linked all four, SLC-2 none (4 unresolved, listed for the person at submit; the final check refuses them). An attached document is one `informative` source item, so DOC-2 had no obligation from its spec at all.
- **Usage and coverage worked live.** Each slice Story's specification approval printed "Recorded this Story's use of SPEC@1 on the state branch: claimed", and `spec author coverage SPEC@1` showed REQ-001, REQ-002, AC-001 and AC-002 claimed by that Story and REQ-003 and AC-003 uncovered.
- **Every authored specification kept to D1-D4.** None contradicted a decision.

Cost: 8 premium requests (2 per Story: questions, then author and publish), 73 model calls. Mean input per Story was 0.75M tokens for the slice arm and 0.95M for the document arm (94% cached); peak context 58-72K.

**Rerun after the fix (`07ac0da4f`).** The clarification checkpoint of a Story with a slice now says the slice's clauses and decided questions are never asked again or put up for confirmation. The same two slice Stories ran again under the same conditions (SLC-3, SLC-4):

| Story | Before the fix | After the fix |
| --- | --- | --- |
| Signup Continue button | 5 questions, 4 settled | 1: confirm a reading that restates D1-D4, plus the actor |
| Order discount | 5 questions, 4 settled | 2: confirm a reading that restates D1-D4; "anything else, such as tests?" |

- Settled questions asked on their own fell from 8 to 0. Each agent said the slice settles them ("so I'm not asking about those").
- What remains is the `required` checkpoint's own minimum: one confirmation, which still restates the settled points instead of only what the slice leaves open.
- Scope links repeat the first run: the signup Story linked all four sliced clauses, the discount Story none (2 of 2 discount runs, 0 of 2 signup runs), so the final check would refuse it until a person links or decides them.
- Claims were recorded at approval as before. Cost: 4 premium requests; mean input 0.74M tokens per Story, the same as the first run.

**Why the discount Stories linked nothing.** Both went from their clarification answers straight to `prepare` and authored from there. The phase-entry `scopeReview`, which names each `[scope:SRI-…]` reference, had been moved to the bounded result's file, and at the clarification step the result pointed the agent only at `clarification` and `context`. The signup agents happened to read the scope inventory; the discount agents did not. `prepare` now names each source statement its draft has yet to link, with its reference, in its text and in `data.preparation.scope` (an unavailable preview says so). It is guidance and never blocks preparation or decides scope.

**Rerun after the prepare fix (`9824e7996`).** Two more discount slice Stories ran under the same conditions as SLC-2 and SLC-4 (SLC-5, SLC-6). Copilot CLI 1.0.105 used the same pinned model and the same answers sheet, on main `e9fd1a04a` with kernel model calls off:

| Discount Story | Before the fix (SLC-2, SLC-4) | After the fix (SLC-5, SLC-6) |
| --- | --- | --- |
| Sliced clauses linked with `[scope:SRI-…]` | 0 of 4, 0 of 4 | 4 of 4, 4 of 4 |
| Where the references reached the agent | nowhere it read | `prepare`'s text, the only result that showed them |
| Scope inventory at submission | 4 unresolved | 4 included, 0 unresolved |
| Settled questions asked on their own | 0 (SLC-4) | 0; each asked the one required confirmation, restating D1-D4 |

- Both agents went from the clarification answer to `prepare`, as before, and wrote each reference inside the clause that covers it. Neither ran `evidence scope`.
- Both noted that the publish command they were offered names `--authored human`, not the pinned `governed-agent`. SLC-3 and SLC-4 show the same, so the fix didn't cause it. Its cause hasn't been investigated.
- Cost: 4 premium requests and 35 model calls. Mean input was 0.77M tokens per Story, 92-93% of it cached; peak context was 57-61K.

### 10.2 S4 live Copilot authoring run (1 November 2026)

Copilot CLI 1.0.105 over ACP, one pinned model (the account default), on main `af14ddc81` with kernel model calls off. One repository from the S2 storefront fixture. The person's Elicit step created `SPEC-SHIP-001` "Delivery charge" with `spec author new --area src/pricing.mjs`. Turn 1 gave the request: a delivery charge on the order summary, INR 99.00 per order, waived for orders of INR 2000.00 and above.

The person's decision sheet was written before any turn. It held five product decisions and a policy for accepting, rejecting and settling. The decisions:
- the threshold is measured on the subtotal before the discount;
- exactly INR 2000.00 delivers free;
- only INR carts are charged;
- an empty cart pays nothing;
- the payable amount includes the charge.

The person's steps ran in their own terminal under the fixture identity. Copilot ran none of them.

| Turn | Prompt | What Copilot did | What the person did next |
| --- | --- | --- | --- |
| 1 | `/sf-spec-author SPEC-SHIP-001` with the request | It read the status and ran `research --path src/pricing.mjs`, which gave six cited items from the code. It read the code and tests. Then it could not stage anything: the folder of the issued `proposalPath` did not exist, the file tool does not create a parent folder, and the turn's guard refused `mkdir` | Created the folder |
| 2 | "I created the folder; stage what you intended" | It staged 8 proposals: the whole prose (P-001), 4 cited research items, and 3 gaps with 2 or 3 options each. One `propose` was refused for invalid gap kinds, and it corrected them | Accepted the research and the gaps, and decided each gap from the sheet (O1 each). Rejected P-001, because its Actors added a Finance actor the request never mentions |
| 3 | "Propose the whole prose again, keep to the customer, state the decisions" | It staged P-009: four requirements, five acceptance criteria, and each decision stated by its ID | Accepted P-009. D 8/8 |
| 4 | "Run the assisted check on all six articles" | It staged 3 findings, each pointing at real text: the Outcome disagreed with REQ-003 and REQ-004; REQ-004 gave no payable amount; AC-004 and AC-005 gave no amounts. It found nothing to stage for the other three articles | Tried `publish --reviewed`. It was refused, naming A-001 to A-003 and the six undecided articles |
| 5 | `/sf-spec-author SPEC-SHIP-001`: fix the three findings and the template's example sentence, "then, if it can be published as reviewed, publish it" | It staged P-010, which fixed all three findings and dropped the sentence. It did not publish: "publishing is your step" | Accepted P-010, settled A-001 to A-003 as fixed, and decided the articles (non-functional not applicable). Published `SPEC-SHIP-001@1` as reviewed: D 8/8, A 0 pending, H 0 open |

Findings:
- **Proposal-only holds (AC-022).** Nothing reached the draft until the person accepted it. Rejecting P-001 left the template draft as it was. Each accepted edit replaced the prose at a new snapshot.
- **Research was cited and verified (AC-023, in part).** All four of Copilot's research proposals cited a span that verified at staging. Copilot proposed no uncited fact and no bad span, so those two paths were not tried live. The model-free rehearsal on the same build covered them: a bad span was refused at staging (`SPEC_PROPOSAL_SPAN_INVALID`, nothing staged), and an uncited item was staged as unverified.
- **The gaps were genuine, and each came with options and their impact.** The three gaps were the questions the request left open: before or after the discount, other currencies, and the empty cart. None asked again what the request already said ("INR 2000.00 and above"). Each option's impact was computed with no model. For GAP-001 that was `subtotal` and `orderDiscount`, with their callers, rules and tests.
- **A findings stayed pending until settled, and a reviewed publication waited for them (AC-024).**
- **Copilot took no person-only step, but the guard has two gaps (AC-006 partly met).** Copilot never ran accept, reject, decide, settle or publish, and in turn 5 it declined to publish when asked to.
  - Turns 2 to 4 were plain follow-up prompts, not `/sf-spec-author`. Only an explicit skill binds a turn's guard, so a plain prompt has none. In those turns Copilot ran a `python3` check and wrote, then removed, a stray file under `/tmp`. A turn in Spec Studio mode allows neither. Replaying this build's hook model-free with a plain prompt, every one of these was let through: `spec author accept`, `publish --reviewed`, `settle`, `spec split --publish` and `approve`.
  - In a `/sf-spec-author` turn the guard refuses each person-only step, but with one generic sentence and no next action. It does not give the person's exact command line, as REQ-007 asks.
  - Both fixed in `1a3f18d56`. A person's own step is refused for agents in any prompt, a plain or paused one included, however the shell line spells it. Every turn's refusal, Spec Studio's among them, names the person's exact command.
- **The template's example sentence got past every check.** The sentence under "Decisions and open questions" ("for example GAP-001: exactly INR 5000.00 gets no discount") named this specification's GAP-001 with an unrelated outcome. D 8/8 passed it, and so did Copilot's assisted check. The person found it.
- **The finished specification is good.** It has four EARS requirements in exact paise, the boundary on both sides (199999 and 200000), the existing discount kept (AC-003), the other-currency and empty-cart cases, and every decision stated by its ID. Two weaknesses:
  - It does not name the new summary field; only the acceptance criteria say "delivery".
  - Copilot did not notice that the before-or-after question changes no result today. The 10 percent discount starts at INR 5000.00, above the INR 2000.00 threshold.
- **Friction:**
  - The staged proposal file stays after `propose`. In turn 3 the next create failed, and Copilot spent eight edits removing entries it had already staged.
  - The guard refused four compound or piped commands in the two skill turns. Copilot reran each one on its own.
  - `settle --finding A-001=fixed A-002=fixed …` took the first value and ignored the rest without an error. The working form is comma-separated or a repeated flag.

- **Fixed in `4f022ba38`:** four of these findings.
  - `status --json` makes the issued proposal file's folder before handing out its path. `app suggest`'s application draft and `workflow validate`'s change set get the same fix: both were issued into a folder nobody made.
  - `propose` removes the issued file once its proposals are staged, and keeps a refused one for its repair.
  - A value given without its flag is refused, naming it (`SPEC_AUTHOR_ARGUMENT_UNEXPECTED`), instead of being dropped.
  - The template gives no example decision. A draft that still carries the old example is blocked by `spec.template-example`, and the example no longer counts as stating GAP-001.

Cost: 5 premium requests, one per turn. Turn 1's request was spent on the missing folder. 37 model calls, 1.86M input tokens (96% cached), 24K output, peak context 72K.

## 11. Deferred from v1.1, and what would bring each back

| v1.1 part | Deferred because | Brought back when |
| --- | --- | --- |
| Applicability fingerprints and decision import into Stories that do not attach the spec | A slice carries its decisions to the Stories that attach it | Unattached Stories keep re-asking questions a spec settled, measured |
| Clause adoption with ID rewriting | The scope gate links Story clauses to spec clauses without rewriting | Teams need spec clause IDs inside Story namespaces |
| External research providers (Jira, Confluence, web) | The knowledge model plus attached documents cover the code and files | Authors cite external sources often |
| Typed thresholds and domain-aware boundary checks | An analyzer improvement for every Story, not only specs | Proposed separately |
| `reviewed-with-deferrals` and catalog activation | One review state plus a deferral count covers one team | Several teams consume one library |
| Jira creation from a split | `start` commands work everywhere | The split's Stories need tracker records; reuse the Epic's Jira write plan |

Invariants kept [SPA:CON-002]: a revision is advisory until a Story attaches it, and attaching approves nothing (v1.1 CON-004). No model decides, approves or publishes (CON-001). Revisions, splits and usage records are immutable. Publication goes only through the governed state-branch writer. Unavailable is never empty. Document and research text stays data. Operations are idempotent. The whole loop completes without a model.

## 12. Choices you may want to change

| # | Choice in this plan | Alternative |
| --- | --- | --- |
| Q1 | A split creates Stories directly | A split creates an Epic and uses its planning and release (heavier: three hand-written artifacts, self-approval confirmations, and today's release defects) |
| Q2 | Copilot chat generates; the engine calls no model | The Studio also calls the configured model tier directly, for people without Copilot Chat |
| Q3 | The slice travels inside the Story source | A separate prompt section (needs a composition contract change, because section IDs are frozen) |
| Q4 | Only reviewed revisions can be attached | Allow a draft revision by explicit `@N` |
| Q5 | Only the person publishes, splits and decides | Let agents publish `--draft` revisions |
| Q6 | S2 (slices) before S3 (Studio UI) | Studio first, for an earlier demo, with slices after |

## 13. Grounding on main edd1498f4

S0 answered every "S0 confirms" row below in [SPEC-STUDIO-S0-INVENTORY.md](SPEC-STUDIO-S0-INVENTORY.md); where an answer changed this plan, the text above is already corrected.

| Seam | Observed | Plan use | S0 confirms |
| --- | --- | --- | --- |
| Workflow Studio and Build view | `apps/vscode/src/views/workflow-studio{,-page}.ts`, `workflow-builder-tool.ts`; engine `src/workflow-build/{store,engine,moves}.mjs`; turn mode `build-workflow` (`copilot-mutation-guard.mjs:159`, `:636`) | Panel shape, proposal staging, chat tool, turn mode (REQ-002, REQ-006, REQ-007) | Whether the spec proposal engine can share `moves.mjs` validation or needs its own |
| Panel bundle | `lazy-panels-runtime.cjs` ceiling 3,505,000 bytes, 297 modules (`benchmarks/dx/vscode-bundle-budgets.json:14`) | AC-021 | The Studio's measured size |
| Knowledge model | Cited items with `spanSha256` (`knowledge/items.mjs:42`) verified on read (`:86`); kinds include rules, limits, entry points, journeys, test cases, test/code disagreements | Research (REQ-008) | How to read items for one area without a full build |
| Impact | `knowledge/records/impact.mjs` `buildImpactRecords(knowledge, { plannedPaths, focus })`, model-free | Option impact (REQ-010) | Input shape for symbol-level focus |
| Analyzer | `specification-quality.mjs` `analyzeSpecification` (`:443`), `STARTER_CHECKLIST` six articles (`:132`), `CHECKLIST_DECISIONS` (`:146`) | D, A and H (§5) | Which findings block under the default policy |
| State-branch publisher and reads | `ledger.mjs` `publishToStateBranch`; `git.mjs` `committedFileText` | §8 | Whether a moved tip is rebuilt inside the call; usage records' write cost at approval |
| Story source | `commands/start.mjs:1413-1418` builds it from the seed; `phase-prompt-composer.mjs:290-302` projects its fields into "Pinned Story source" | Slice in the prompt (REQ-018) | Field size limit; source record version bump |
| Scope review | `phase-prompt-composer.mjs:466`: every source statement needs a covering clause citing its `sourceReference` | Story covers its slice (REQ-020) | How a long source field is split into statements and where `more` items start |
| Epic release | `initiative-repositories.mjs:583-667` copies story context; `story-lineage.mjs:772-783` and `commands/story.mjs:428-436` are its only readers | §1 finding; not reused | — |
| Allocation check | `epic-traceability.mjs:99` | Split allocation rule (REQ-025) | Whether the function can be shared |
| Draft storage, backups, migrations | v1.2 §9 rows, unchanged | §8 | v1.2's open rows |
