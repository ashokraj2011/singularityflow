# SPEC-CIC v1.1 — Change Impact Cone

**Product:** Singularity Flow
**Date:** 13 November 2026
**Status:** Owner decisions recorded 2026-11-13 (section 9). Stages 1 and 2 are built (section 7.1), stage 3 (section 7.2) and stage 4 (section 7.3, owner decisions 2026-11-14); stages 5 to 7 follow in the order of section 7, each behind its own switch where it changes an outcome.
**Namespace:** CIC. Specification documents declare their own namespace in their header (see [DOCUMENTATION-MAP.md](DOCUMENTATION-MAP.md)); no other document uses CIC.
**Source baseline:** commit 4aabac18a (main 15d6137d3 with the decisions-card work)
**Replaces:** SPEC-CIC v1.0 (draft of the same day), corrected against the source baseline
**Companions:** [Clause-driven specifications (SDS)](CLAUSE-DRIVEN-SPECIFICATIONS.md), [SPEC-SCS](SPEC-SCS-SPEC-CODE-SYNC-v1.md), [SPEC-UIF](SPEC-UIF-UPSTREAM-ISSUES-AND-FORWARD-AMENDMENT-v1.md), [SPEC-PMC](SPEC-PMC-PHASE-MUTATION-CONTRACT-v1.md), [SPEC-PHR](SPEC-PHR-PHASE-RESPONSIBILITY-v1.md)
**Normative language:** MUST, MUST NOT, SHOULD and MAY express requirements.

## 1. Decision

**When a clause changes, SFlow already keeps the evidence of unaffected clauses. This specification closes the gaps that stop that from being sound and usable on its own: dependencies are declared, not observed; an unknown dependency is treated as no dependency; the step an amendment reopens can still publish what it drafted against the old scope; and a person cannot see the exact effect of a change before deciding it.**

Nothing here adds a store, a lifecycle or an approval path. It adds records to the existing Story state, one check at the existing publication boundary, and one read-only preview in front of the existing intent-amendment route. The preview and the approval compute the effect with one function, so what a person previews is what approving does.

## 2. Baseline

Read from the source baseline and confirmed against the full source, not only the files v1.0 searched. File references are to that commit; a line given with `~` is approximate.

### 2.1 Built

| Capability | Where |
| --- | --- |
| Hash-chained, append-only scope revisions (`scope-revision/v1`) recording clauses, statement hashes, what changed and each later step's generation | `src/scope/revisions.mjs` `recordScopeRevision`; schema `schemas/workflow.schema.json:648-698` (`additionalProperties: false`) |
| Stale set: added or revised clauses plus every clause depending on one, transitively | `staleClausesOf`, `src/scope/revisions.mjs:73-88` |
| `dependsOn`: the clause IDs a clause's own statement cites | `extractClauses` and `clauseReferences`, `src/specifications.mjs:236-246` |
| Evidence staleness per clause, step and generation | `scopeStaleness`, read by `src/evidence/evaluate.mjs` |
| Approver "still holds" answers that carry a step's evidence across an amendment | `src/scope/carried-evidence.mjs` |
| Intent amendments: `draft` (a read), `propose`, `decide`, `acknowledge`, and Refresh of a stale proposal; decided on the decisions card on every host | `src/commands/story.mjs` ~1907-2607; `src/decision-list-reads.mjs`, `src/decision-list.mjs`, VS Code Decide card, Copilot CLI card |
| Rule E8: an approved step after the scope whose artifacts cite none of the stale or removed clauses keeps its approval, while every step before it did | `src/phase-retention.mjs` `amendmentRetentionCandidates` (~107-117); `decideIntentAmendment` artifact loop, `src/state.mjs` ~8926-8960 |
| Claim-map blast radius of an amendment (one hop) and amendment churn, informational | `blastRadius` and `amendmentChurn`, `src/amendment.mjs:83-140` (AMD requirements) |
| An amendment that only updates the scope to what a conformance report found resets nothing; each step that read the scope gets a "still holds" row | `differenceAmendmentReport`, `src/state.mjs` ~9078-9096 [SCS:REQ-022] |
| The step an amendment is proposed from pauses until it is decided; an approved one is acknowledged before work resumes | `src/intent-amendment-pause.mjs`; acknowledgement gate in `src/state.mjs` |
| A pending prompt pair can be set aside with its reason, kept under `context/superseded/` | `supersedePromptGeneration`, `src/inject.mjs:187-203` |
| File-level reverse-dependency closure from changed paths to affected sources and tests | `src/verification/incremental-verification-graph.mjs` |
| Cone invalidation of evidence at initiative level | `src/initiative-evidence.mjs` |
| Story schema migrations (story-workflow v1 to v13) | `src/schema-migrations.mjs` ~2800-2826 |
| Per-workflow switches pinned with the Story | the `spec` block pattern: `schemas/workflow-definition.schema.json:199-229`, normalized in `src/specifications.mjs:115-187`, pinned by `snapshotResolution` in `src/config.mjs`, read from the pinned raw field so a Story pinned earlier keeps its behaviour (for example `src/conformance-differences.mjs:15-17`) |

### 2.2 Gaps, with the verdict against the full source

| Gap | Verdict | What the source does |
| --- | --- | --- |
| G1 Declared dependencies only | **Accurate** | The stale set is the added and revised clauses plus transitive `dependsOn`, where `dependsOn` is only the clause IDs a clause's own statement cites. Step-level retention (rule E8) in `decideIntentAmendment` (`src/state.mjs` ~8729-9041): an artifact is affected when its path is in the claim-map radius (one hop) or it cites a stale or removed clause by exact ID; a code step is affected when the radius affects any claim; a convergence step always is; E8 keeps only an unbroken run of unaffected approved steps. Work that used a clause without citing it keeps its approval. |
| G2 Unknown means unaffected | **Accurate**, in five places | (1) A removed clause does not count as changed for the clauses that depend on it (`revisions.mjs:74`). (2) A missing or unreadable artifact counted as unaffected in the E8 loop (`state.mjs` ~8940-8942: `existsSync` false, or `.catch(() => '')`). (3) Revisions with `changes: null` (Stories from before E6) are filtered out of staleness. (4) A step not in a revision's `dependentGenerations`, or at generation 0, is never stale. (5) A changed clause that no claim names widens nothing. |
| G3 Running work not bound to a scope revision | **Narrow** | A Story has one current step; the amendment pause holds the step it was proposed from, and the acknowledgement gate holds the reopened step until someone has read the amendment. The real hole: approval reopens the first reset step in place (`in_progress`), and the draft it held from before the amendment can be published after acknowledgement. Its prompt pair is not set aside (`supersedePromptGeneration` exists, but approval does not call it) and its generation intent stays open. The mutation guard (`src/copilot-mutation-guard.mjs`) is at its 68-module static ceiling, so it can read a flag but cannot import a new check. |
| G4 No preview, class or limit | **Half covered** | `story intent-amendment propose` computes the clause diff and the claim-map radius, but commits a record as it does; a dry run exists inside `proposeIntentAmendment` and only Refresh uses it (`story.mjs` ~2063-2066, 2237, 2469); `draft` is registered as a read (`src/command-registry.mjs:504-506`). The real effect (stale set, affected and preserved artifacts, steps E8 keeps, the "settles" path and its "still holds" rows) is computed only inside `decideIntentAmendment`. The decisions card names every later started step under "Steps it may reopen" (`src/decision-list-reads.mjs:371-412`, rendered by `src/decision-list.mjs` ~700-787), which over-counts. |

The clause capsule in every composed prompt holds every clause of the earlier steps (`predecessorSpecClauses`, `src/specifications.mjs:1707-1721`). "The clause was in its prompt" is therefore true of every earlier clause for every later step, and an `input` edge (REQ-001) carries no selectivity on its own; it matters for D1.

### 2.3 Statements in v1.0 that the source contradicts

| v1.0 said | The source | This version |
| --- | --- | --- |
| The agent read budget is 4 KiB and results report truncation | An agent view is at most 4,000 bytes (`DEFAULT_AGENT_OUTPUT_BYTES`, `src/agent-output.mjs:40-44`); a result is never truncated: the whole result is kept under `.sflow/out/` and the view names the ranges to read (~991-992) | REQ-012 keeps the preview's agent view within 4,000 bytes; the rest is in the kept result |
| Register CIC through the namespace owner | No namespace owner exists; a specification declares its namespace in its own header | CIC is declared here |
| `material` changes need the scope-change authority the policy names | No such policy key exists. Amendments are decided under the scope step's `approvalPolicy` (`src/state.mjs` ~8631-8656), with groups from `approvalAuthorities` | A new optional policy key names an `approvalAuthorities` group (REQ-014) |
| The preview is `scope impact` | `impact` is an existing command (impact studies) | The preview is `story intent-amendment preview` |
| A class named `clarification` | `clarification` is an existing command and an Auto request type | The classes are `editorial`, `refinement` and `material` (D2) |
| Churn is unbounded and unmeasured | The AMD requirements in `src/amendment.mjs` already compute the radius and churn (`amendmentChurn`, informational) | The preview and report show it (D4) |
| Records are added beside `scopeRevisions` | `scopeRevisions` entries are `scope-revision/v1` with `additionalProperties: false` | New revisions are `scope-revision/v2` beside v1 (D3) |
| No migration framework exists | Story migrations exist (story-workflow v1 to v13) | None is needed: records are additive (D3) |
| Header named a repository by its owner's account | | The baseline is a commit only |

## 3. Invariants

| ID | Invariant |
| --- | --- |
| CIC:CON-001 | The cone only grows from observation. Recorded dependencies add to declared and cited ones; they never remove one. |
| CIC:CON-002 | Missing information widens the cone. No model statement, and no absence of a record, narrows it. |
| CIC:CON-003 | The only routes that keep evidence inside the cone without re-running its step are the approver "still holds" answer for that step and generation, and a change the scope approvers approved as `editorial` (D2), which the record says was carried that way. |
| CIC:CON-004 | Exact phase-bundle approval remains the only approval that advances lifecycle state (SDS:CON-061). This specification adds no clause-level approval. |
| CIC:CON-005 | Work superseded by a revision is retained as history. It is never deleted, relabelled or published. |
| CIC:CON-006 | The preview is read-only: it records no history entry and writes no file under the Story. Every mutation continues through the existing amendment, change-request and return routes. |
| CIC:CON-007 | The preview and the approval compute the effect with one function, from the same Story state and proposed bytes, bound to the scope generation the amendment was proposed against. A preview of a proposal the Story moved under says so instead of showing an effect approval would refuse. |

## 4. Requirements

### 4.1 Observed dependencies (G1)

**[CIC:REQ-001]** When a step publishes a generation, the kernel MUST record a dependency record for it from production facts only: the clause revisions (ID and statement hash) in its composed input as the prompt receipt records them (under switch 1 the receipt records them; before stage 3 it held only the capsule's digest and counts); the clause claims in the planned claim maps (a code step's observed claim map is written at submission, after the record, so its claims are the ones planned for it); the paths in its code-delivery change set; the tests bound to its clauses by the traceability bindings; the witnesses; and the source and implementation bindings and the citations. A model's description of what it used is not an input.

**[CIC:REQ-002]** Dependency records MUST be append-only, digest-bound to the step generation and to the scope revision current at publication, and kept in the existing Story state. Each edge names its kind: `input` (in the composed input), `claim` (the generation claims the clause), `path` (it changed a path a clause expects), `test` (a bound test verifies the clause), `witness`, `binding` or `citation`. Each revision recorded after enablement is a `scope-revision/v2` record that stores the stale set it computed, with each clause's reason (`added`, `revised`, or `depends` with the clauses it depends through), and the edges it used; v1 records are never rewritten, and the hash chain runs through both and is verified on read. A broken chain or a tampered record is reported and read as `unresolved`; no refusal is added, since none existed for v1.

**[CIC:REQ-003]** The effective dependency set used for staleness MUST be the union of `dependsOn`, exact-ID citations and recorded edges. `staleClausesOf` and `scopeStaleness` keep their current results as a lower bound; recorded edges can only add stale items.

**[CIC:REQ-004]** For a revised clause, the cone MUST include the file-level closure: the paths claimed for that clause, their transitive dependents from the incremental verification graph, and any evidence whose witness covers one of those files. Evidence is addressed by clause, step and generation as today.

### 4.2 Widening (G2)

**[CIC:REQ-005]** Each step generation MUST have a coverage state: `resolved` when a complete dependency record exists for it, otherwise `unresolved`. Generations published before enablement, generations whose receipt or claim map is missing or fails its digest, and generations that changed a path no clause claims are `unresolved`. A changed path that an approved plan row or approved plan amendment (`PAM-NNN`, add-supporting) names as a supporting change counts as covered and depends on no clause (owner decision, 2026-11-14). Each unresolved generation names its reasons from a closed set (section 7.2).

**[CIC:REQ-006]** On any revision that adds, revises or removes a clause, every `unresolved` generation of the defining step and of every later step MUST be treated as inside the cone: an unresolved record counts as affected, never as unaffected. A removed clause counts as changed for the clauses that depend on it. A revision with `changes: null` (the first revision, or one from before E6) makes every clause it holds stale. A changed clause that no plan claims reaches every later published step whose record does not resolve it. A revision reaches a step's evidence at a generation as follows: a step it lists in `dependentGenerations`, at or below the generation recorded there, generation 0 included once the step has published (a step that never published holds no evidence, so a Story's first revision marks nothing stale for the steps after its scope); the step whose generation made the revision, at its earlier generations; and any other step, at every generation not published after the revision (by its `generationPublications` time; an unknown time counts as before).

**[CIC:REQ-007]** Every item in a computed cone MUST carry the reason it is there: `declared`, `cited`, `recorded:<edge kind>`, `file-closure`, `unreadable` or `widened:unresolved`. The share of the cone that is widened is reported, so teams can see what missing records cost them.

**[CIC:REQ-020]** A missing or unreadable artifact of a step after the scope MUST count as affected by an approved amendment, so its step is not kept by rule E8. An artifact that was recorded as absent and is still absent holds no evidence and is neither affected nor kept. This closes G2 place (2) and is delivered without a switch: it only resets a step whose evidence cannot be read.

**[CIC:REQ-021]** A document step that rule E8 would keep because its artifacts cite none of the changed clauses, while those clauses were in its prompt, MUST be asked "still holds" by its own approvers on the decisions card: one question per such step per change (D1). Until it is answered the step's evidence of those clauses is stale; "returns" reopens it through the existing route.

### 4.3 The reopened step (G3)

**[CIC:REQ-008]** When an approved amendment reopens a step in place, the kernel MUST set aside that step's pending prompt pair with the amendment as its reason (`supersedePromptGeneration`), close its open generation intent, and pin the scope revision the step now works against.

**[CIC:REQ-009]** At publication, a generation composed against an earlier scope revision than the step's pin MUST be refused with a typed code naming the revision and the amendment; it is not rebased (owner default). The refusal's route composes the step again on the current scope.

**[CIC:REQ-010]** The mutation guard MUST NOT import the check. A code step's application writes from the draft are denied because REQ-008 closes its generation, which the guard already requires open; the denial returns the step's re-entry route (`phase begin`). A document step's writes are how it is written again, so they stay allowed, and REQ-009 refuses an agent's publication of it until the step is composed again. Reads remain allowed. Work already produced is retained under CON-005. (Built in stage 5 without the flag first planned here: section 7.4.)

**[CIC:REQ-011]** A step rule E8 keeps is not touched: its approval and its published generation stand, and nothing is set aside.

### 4.4 Preview, class and allowance (G4)

**[CIC:REQ-012]** `singularity-flow story intent-amendment preview` MUST be a model-free read, registered as a read, that computes without recording anything: for a drafted amendment (`--file`), what proposing it records (clause diff, radius) and what approving it would do; for a pending proposal (`<AMD-ID>`), what approving it does now. The effect it shows is the one approval applies (CON-007): the stale clauses with their dependents; for each later step, whether it is reset (and which one is reopened first), kept, or asked "still holds", each with its reason (a path in the radius, the clauses it cites, a code step the radius reaches, a convergence step, an unreadable artifact, or kept because it cites none, with "the clause was in its prompt" shown as information); the evidence kept; the plan rows carried; the approver groups asked "still holds"; and the churn and reversals of D4. Its agent view stays within 4,000 bytes; the whole result is kept.

**[CIC:REQ-013]** Each proposed change MUST be classified by registered rules as `editorial`, `refinement` or `material`. A model MAY propose the class; the rules bound it. A change is not `editorial` if it adds or removes a clause, changes a clause with a bound test or an acceptance clause, or changes expected paths or test bindings. A change that adds a clause, widens expected paths beyond the Story's admitted scope, or changes required authority is `material`. An ambiguous change takes the stricter class.

**[CIC:REQ-014]** Class determines handling, within CON-004. An `editorial` change carries the evidence of the clause it rewords without per-step "still holds": the scope approvers approve the new wording as editorial, and the approval record says the evidence was carried that way (D2). A `refinement` follows the existing intent-amendment route with the computed cone and its rows. A `material` change additionally needs the scope-change authority: an optional policy key naming an `approvalAuthorities` group, defaulting to the scope step's own approval groups.

**[CIC:REQ-015]** A person MUST be able to state a change in plain language in the Story's chat. The governed skill (`/sf-reject`) drafts it, shows the preview in the person's terms (what changes, what is redone, what is kept, who must confirm) and then proposes it through the existing route. No new mutation route and no new stop is added.

**[CIC:REQ-016]** No default change allowance is set (D4). The preview and the Story report MUST show the amendment churn and any clause reversed more than once. A pinned policy MAY later set an allowance once real Stories have been measured.

### 4.5 Measurement and enablement

**[CIC:REQ-017]** Per Story, counts MUST record revisions by class, cone size, widened share, evidence items kept, "still holds" questions and answers, steps reset and publications refused. Content is not recorded.

**[CIC:REQ-018]** The capability MUST be enabled per workflow by pinned policy in three independent switches, following the `spec` block pattern and read from the pinned raw field: switch 1 (`spec.observedDependencies: on`), observed dependencies, widening, file closure and D1 (REQ-001 to 007, 021); switch 2, the reopened step's pin and the publication check (REQ-008 to 011); switch 3, classes, the scope-change authority and the chat entry (REQ-013 to 016). The preview (REQ-012) and the fail-closed artifact read (REQ-020) need no switch: one only shows, the other only resets a step whose evidence cannot be read. With all switches off, behaviour is that of the source baseline plus REQ-020.

**[CIC:REQ-019]** Records added by this specification MUST be additive to the existing Story state, and no migration rewrites earlier records (D3). Widening of earlier generations under REQ-006 applies only to Stories whose pinned policy enables switch 1; a Story pinned before enablement keeps baseline behaviour, plus REQ-020.

## 5. Records

| Record | Fields | Lives in |
| --- | --- | --- |
| Scope revision v2 | the v1 fields, the stale set it computed with each clause's reason, the edges it used, `previousRevisionSha256` across v1 and v2 | `scopeRevisions`, beside v1 records |
| Step dependency record (`step-dependencies/v1`) | step, generation, publication time, scope revision and its digest, receipt path and digest, the claim maps relied on with their digests, the change set path and digest, edges (kind, clause ID, and the statement hash, path, test or line each kind carries), changed paths no clause claims, coverage state with reasons, record digest | one file per generation, `context/dependencies/<step>-gen<N>.json`, committed with the publication; the step keeps `dependencyRecords: [{ generation, path, recordSha256 }]` |
| Reopened-step pin | step, generation, scope revision digest, set-aside prompt location, amendment | the step's own record |
| Amendment effect | stale clauses with dependents, per later step: reset, kept or asked with reasons; first reset step; evidence kept; plan rows carried; "still holds" groups; churn | not stored by the preview; the approval stores what it applied in the amendment's `application`, as today |
| Applied change entry | class, cone size, widened share | existing amendment record |

## 6. Commands

| Command | Kind | Purpose |
| --- | --- | --- |
| `story intent-amendment preview --file <FILE>` | Read, model-free | REQ-012 for a drafted amendment |
| `story intent-amendment preview <AMD-ID>` | Read, model-free | REQ-012 for a pending proposal; the decisions card shows the same effect |
| `spec dependencies [STEP]` | Read, model-free | Recorded edges by kind and the coverage state per generation with its reasons, and the scope revision chain's check (stage 3). It sits beside `spec trace` and `spec coverage`: no `scope` command exists, and a new top-level command would add a command family to root dispatch |
| existing `story intent-amendment` and change-request commands | Mutation | Unchanged; they apply the effect the preview showed |

## 7. Delivery order

| Stage | Change | Exit |
| --- | --- | --- |
| 1 | This document; SDS:REQ-144 amended to point to it | Reviewed and in the documentation map |
| 2 | The shared effect function used by `decideIntentAmendment` itself, `story intent-amendment preview`, the decisions card's exact effect on every host, and `/sf-reject` showing the preview before it proposes; REQ-020 | Preview, then propose and approve on a fixture: the applied reset, kept and "still holds" sets equal the previewed ones, and the preview recorded nothing |
| 3 | Records: `scope-revision/v2` storing the stale set and the edges it used, hash-chain verification, and per-generation dependency records from claim maps, the code-delivery change set, traceability bindings, witnesses, implementation bindings and citations, with coverage state; no outcome changes | Records present on a fixture Story; staleness results identical |
| 4 | Behind switch 1: fail-closed widening (REQ-005, 006), D1 (REQ-021), the union (REQ-003) and the file closure (REQ-004) | An uncited dependency and an unclaimed path both produce stale evidence; D1's question appears once per step and change |
| 5 | Behind switch 2: the reopened step's pin, the publication check, and setting aside its prompt and closing its code generation; the guard is unchanged | A draft from before the amendment cannot be published; a kept step is untouched |
| 6 | Behind switch 3: classes, the scope-change authority and the chat entry | The three classes behave as specified on fixtures |
| 7 | Counts (REQ-017), then one real Story with a change mid-flight | Report of cone size, widened share, churn and rework |

Stages 2 and 3 change no outcome except REQ-020, which only resets a step whose evidence cannot be read.

### 7.1 What stage 2 built, and what building it found

- `intentAmendmentEffect` (`src/state.mjs`) computes the effect from the Story as it is and the proposed bytes, before anything changes; `decideIntentAmendment` computes it at the same point and applies it, and `story intent-amendment preview`, the decisions card (terminal, VS Code Decide card, Copilot CLI card) and `/sf-reject` show it. The card's "Steps it may reopen" (every later started step) is replaced by the effect, step by step.
- The stale set is read from the scope revision the approval would record (`nextScopeRevision`, `src/scope/revisions.mjs`), built from the amended scope's clauses as its index will read them; the approval still records the revision after the index is refreshed, and the acceptance test pins the two equal.
- One case resets more than the preview shows, never less: a plan whose rows the amendment carries is kept only if it can read the amended scope once it exists (`carriedPlanBinding`, after the bytes are written). The preview shows it kept; if it cannot read it, approval runs it again with every step after it.
- REQ-020's unreadable case cannot be reached through the CLI for a file in the Story: every governed write first copies the Story directory to roll back from (`src/publication-recovery.mjs`), and an unreadable file there refuses the write. The engine's own check is the second line, and the test runs it in process.
- A step that never ran is reset in the effect's record but not named in its words: it reads the amended scope when it starts.
- Churn and reversals (D4) are read from the Story's approved amendments and its scope revisions' statement hashes.

### 7.2 What stage 3 built, and what building it found

- **Switch 1** is `spec.observedDependencies: on | off` in the workflow definition's `spec` block (`schemas/workflow-definition.schema.json`, `normalizeSpecPolicy`). It is pinned only when on, so a Story without it (every Story pinned before it, and every new Story while it is off) keeps byte-identical state; readers check the pinned raw field. With it off nothing new is written: no record, no `dependencyRecords`, v1 revisions, and receipts as before.
- **Records** (`src/dependency-records.mjs`, loaded only on the publish path and by the read). `publishGeneration` writes one per generation after the generation's own records are final, in the publication's commit; `decideIntentAmendment` writes the record of the scope generation it publishes. One file per generation keeps `workflow.json` small: the step holds only `{ generation, path, recordSha256 }`. On the fixture the records were 976 to 2,427 bytes. Each `input` edge costs about 160 bytes, so a step after 100 clauses carries about 17 KB, in its own file.
- **Prompt receipts did not name the clause revisions.** They held the capsule's digest and counts only. Under switch 1 the composer now records `clauseRevisions` (each ID and approved statement hash, the same hash a scope revision holds) on the receipt. A receipt exists only when a prompt was composed (`phase enter --compose`, an agent's entry). A generation authored without one, such as deterministic code or the scope generation an amendment publishes, reads `unresolved` with `receipt-missing`. That will be common, and it is the fail-closed reading REQ-005 asks for.
- **Coverage reasons**, a closed set. At publication: `receipt-missing`, `receipt-digest` (the prompt no longer matches the receipt), `receipt-clauses-unrecorded`, `claim-map-missing`, `claim-map-digest`, `delivery-evidence-missing`, `unclaimed-paths` and `artifact-unreadable`. On read: `no-record`, `record-missing`, `record-digest`, `receipt-changed`, `claim-map-changed` and `scope-chain`.
- **Changed paths no clause claims:** under REQ-005 as first written, a plan's Supporting files (lockfiles, CI, build files) were unclaimed, so most real code generations that touch one read `unresolved`. The owner decided (2026-11-14) that a supporting change an approved plan row or plan amendment names is covered; stage 4 records it as `supportingPaths`.
- **`scope-revision/v2`** is written by `recordApprovedScopeRevision` under switch 1, with `stale` (each clause's reason) and `edges` (the declared edges the reasons used). Staleness still reads `changes` and `dependsOn` exactly as before, and the test pins `stale` equal to `staleClausesOf`. `schemas/workflow.schema.json` takes each item as v1 or v2, both with `additionalProperties: false`.
- **Nothing verified the v1 chain before.** `verifyScopeRevisionChain` checks each revision's digest and its link to the one before, through v1 and v2. Only the read uses it, and a record whose revision is not in a chain that verifies reads `unresolved` with `scope-chain`.
- **Outcomes are unchanged.** On the fixture, the same Story with the switch on and off has equal amendment effects, revision changes, staleness, reset and kept steps, and history.
- **Publish time:** the CLI's `phase publish` took 1.7 s, 1.7 s and 2.9 s for intake, fix-design and implement with the switch on, and 1.7 s, 1.7 s and 2.8 s with it off, within run-to-run noise.

### 7.3 What stage 4 built, and what building it found

Everything below applies only to a Story whose pinned spec policy has `observedDependencies: on`. With the switch off, outcomes are those of main: the stage 2 and stage 3 acceptance tests and the rest of the suite run with it off.

- **Staleness (REQ-006, `scope/revisions.mjs`).** Three rules close the remaining fail-open places of G2: a clause that depends on a removed one is stale; a revision with `changes: null` makes every clause it holds stale; and neither a step the revision does not list nor generation 0 is exempt. The reach rule is the one written in REQ-006. `scope-revision/v2` states the same set per clause, with the reasons `depends` (through a removed clause too) and `unrecorded`.
- **The amendment's effect** (`intentAmendmentEffect`, used by the preview, the card and the approval alike) reads each published step's record as it reads now. A step whose record is missing or unresolved is affected, with the reason `unresolved-record` and its reasons, so rule E8 never keeps it. Changed clauses no plan claims are listed as `unclaimedClauses`.
- **D1 (REQ-021).** A step rule E8 keeps whose record holds an `input` edge for a changed clause (one its prompt held and its document does not cite) gets a row on the Story's revalidation list: the amendment's `revalidate`, with `reason: prompt-held`, the clauses, and a recommendation. The recommendation is "still holds" when the step's document names neither those clauses nor any path they expect, otherwise "redo" (return the Story to it).
  - The card says why in one line, on the terminal, the VS Code Decide card and the Copilot CLI card alike.
  - The row is never settled for the person: the "settled for you" route does not take revalidation items.
  - It is answered on the Decide card or in the person's own terminal (`upstream-issue revalidate`), and since 2026-11-14 also as a yes or no in a /sf-decide chat (section 9a, decision 3).
- **Where an unanswered question waits:**
  - the approval of the step it is about, and of each step that reads it as an input;
  - for a step that completes at its submission (approval `none`, or a waiver), that submission;
  - the Story's end.

  Nothing else waits, and nothing loops back. The refusal is `AMENDMENT_STILL_HOLDS_REQUIRED` (person-decides-in-step), and it names the Decide card (`/sf-decide`) and the approvers' own command. The decision list marks the row as holding an approval only where the engine says so. `test/no-dead-end.test.mjs` walks this route (`code-step-waits-for-still-holds`).
- **Found:** a kept document step usually reads the scope only through its prompt's clause capsule, not as a phase input, so it has no input record. The existing "still holds" path refused it ("cannot read the approved scope"). For a D1 row the answer is now bound to the amended scope generation and its bytes, which is what carries its evidence across the revision (`revalidationCarriers`, `scopeStaleness`).
- **Found:** quick-fix's code step has approval `none` and completes at its submission. "Its own approval" therefore means its submission, which is where that step waits.
- **Supporting changes:** a changed path an approved plan row or plan amendment names as supporting is covered (`supportingPaths`), depends on no clause, and leaves the record resolved.

### 7.4 What stage 5 built, and what building it found

- **Switch 2** is `spec.preAmendmentDrafts: refuse | legacy` in the workflow definition's `spec` block. Unlike switch 1, it is pinned for every new Story, as `refuse` unless the workflow says `legacy` (owner, 2026-11-14). A Story pinned before the field has no value, reads as `legacy`, and keeps main's behaviour. Readers check the pinned raw field.
- **What approval does (REQ-008, `src/amended-drafts.mjs`, loaded only by the approval, the publication and the composer).** `decideIntentAmendment` pins the step it reopens in place to the amended scope as `phase.scopePin`: the amendment, the generation, and the scope revision and its digest. Then:
  - it sets aside the step's pending prompt pair for that generation, with the amendment as the reason (`supersedePromptGeneration`);
  - it closes the step's open code generation as `superseded`, keeping its start receipt beside the draft;
  - it copies the step's draft, read only, to `context/superseded/<step>-gen<N>-before-<AMD>/`.
- **Records, not times (REQ-009).** Under switch 2 each code generation's start receipt (`generation-start`) and each composed prompt's receipt record `scopeRevision`: the latest revision, its digest, and the last approved amendment. The reopened generation publishes only if both its code generation and its composed prompt started under the pinned revision or a later one, compared by the revision's place in `scopeRevisions` by digest. A document step an agent may have written (`governed-agent`, or no `--authored`) must also have been composed again since the pin, since an agent reads the amended scope only through that prompt. Its text may be the kept draft's unchanged: a person who finds it still holds publishes it as is, as their own, and its approvers approve it again (owner, 2026-11-14; section 9a, decision 5). As first built, unchanged bytes were refused; that check is gone. The refusal is `PHASE_DRAFT_PREDATES_AMENDMENT` (author-repairs-in-step). It names the amendment, the revision, the read-only draft, and the routes in the step, in order: `phase begin <step>` for a closed code generation, then `phase enter <step> --compose`. Nothing loops back and nothing else waits. `test/no-dead-end.test.mjs` walks it (`draft-written-before-the-amendment`): publish refused, begin, compose, publish.
- **Found: the closed generation's code.** It is written inside governance, but with the generation closed it read as code changed before the first `phase begin`. Two consequences followed:
  - the dirty-start rule blocked the new begin;
  - the step's entry sent its files to a person to set aside.

  Now a `phase begin` at the same generation and baseline carries that code (`baseline.mode: carried`, `carriedFrom`). The entry scopes it from the closed generation's baseline (`basis: closed-generation`). Protected and out-of-boundary paths still refuse as before.
- **REQ-010 needs no guard flag.** The guard already denies a code step's application edits without an open generation, and returns `phase begin`. Closing the generation at approval is therefore the flag, and the guard imports nothing new (its closure stays at 68 modules). A document step's artifact edits are how it is written again, so denying them would remove the way out. The publication check covers that step instead. REQ-010 and AC-009 are restated to match.
- **The old draft, read only, in the recomposed prompt (REQ-008).** The reopened step's next composed prompt carries a mandatory section, "Draft written before AMD-NNN (read only)". It names the copy's exact path, says it was written before the amendment, and says to keep from it only what still holds under the amended scope. It adds 357 to 368 bytes on the fixtures, against an 18,000-token (72,000-byte) prompt limit, and only on the pinned generation.
- **Found: a later reset step can hold a draft too.** When the first reset step comes before the current step, the current step's draft is reset with it. That step is pinned the same way when it still holds an open code generation or a composed prompt. In practice its code also blocks the earlier document step's publication (an artifact-only step), on main as well, until a person sets the code aside.
- **REQ-011:** a step rule E8 keeps is never pinned, and nothing of it is set aside.
- **Hosts:** the refusal reaches no card. It is the publish refusal's plan, shown alike in the terminal, VS Code Copilot and the Copilot CLI, and its routes pass the command crosswalk: `/sf-code` for `phase begin`, the entry's own route for `phase enter --compose`.
- **Middle states are compared, not only ends.** On the fixtures the same Story is walked with the switch on and off, and compared at each point:
  - after scope approval;
  - with the code step drafted;
  - after the amendment is approved;
  - after acknowledgement;
  - before and after the reopened step is published.

  At each point the steps' status and generation, the history, and the decision list are equal. Where the two legitimately differ is asserted explicitly: the pin, the closed generation, the set-aside prompt, the kept draft, the refusal, and the guard's answer.

## 8. Acceptance

| Case | Priority | Given / when → required observation | Requirements |
| --- | --- | --- | --- |
| CIC:AC-001 | P0 | A step's composed input contained clause B, which the step neither declares nor cites; B is revised → that step generation's evidence is stale with reason `recorded:input`, or its approvers are asked "still holds" (D1). | REQ-001, REQ-003, REQ-021 |
| CIC:AC-002 | P0 | A model output states that the step did not rely on clause B, while the receipt shows B in the input → the evidence is still stale. | REQ-001, CON-002 |
| CIC:AC-003 | P0 | Recorded edges are enabled on a Story → every item stale under the baseline computation remains stale. | REQ-003, CON-001 |
| CIC:AC-004 | P1 | Clause A is revised; file X is claimed for A and file Y imports X → evidence whose witness covers Y is in the cone with reason `file-closure`. | REQ-004 |
| CIC:AC-005 | P0 | A generation has no dependency record, or its receipt fails its digest → it is `unresolved` and enters the cone of any clause revision with reason `widened:unresolved`. | REQ-005, REQ-006 |
| CIC:AC-006 | P0 | A generation changed a path no clause claims → the whole generation is inside the cone of the next revision. | REQ-006 |
| CIC:AC-007 | P1 | A cone is computed → every item carries a reason and the widened share is reported. | REQ-007 |
| CIC:AC-008 | P0 | An amendment reopens a step that held a draft from before it → that draft's publication is refused with the typed code naming the revision. | REQ-008, REQ-009 |
| CIC:AC-009 | P0 | A reopened code step's draft is edited after acknowledgement → the guard denies it and returns the re-entry route; a reopened document step published by an agent that has not composed it again is refused, while its text unchanged is accepted; the earlier draft is retained. | REQ-010, CON-005 |
| CIC:AC-010 | P1 | A step rule E8 keeps → its approval and generation stand and nothing is set aside. | REQ-011 |
| CIC:AC-012 | P0 | `story intent-amendment preview` runs for a drafted change, then the change is proposed and approved → the preview recorded no history entry and wrote no file under the Story, and the applied reset, kept and "still holds" sets equal the previewed ones. | REQ-012, CON-006, CON-007 |
| CIC:AC-013 | P0 | A change to a clause with a bound test is proposed as `editorial` → the rules classify it as a refinement. | REQ-013 |
| CIC:AC-014 | P1 | A wording-only change of an untested requirement clause is approved as editorial → the new wording is approved, its evidence is carried, and the record marks the carry as editorial. | REQ-014, CON-004 |
| CIC:AC-015 | P1 | A person types a change in the Story's chat → they see the preview in plain terms, and the existing amendment is proposed through `/sf-reject`. | REQ-015 |
| CIC:AC-016 | P1 | One clause is reversed twice → the preview and the report show the reversal and the churn. | REQ-016 |
| CIC:AC-017 | P0 | All three switches are off → evidence evaluation, publication and amendment behaviour match the source baseline plus REQ-020 on the regression fixtures. | REQ-018 |
| CIC:AC-018 | P0 | A Story pinned before enablement receives a clause revision → baseline behaviour, and no earlier record is rewritten. | REQ-019 |
| CIC:AC-019 | P0 | A kept step's artifact is missing, or present but unreadable, when an amendment is approved → the step is reset, and its artifact is labelled affected. | REQ-020 |

v1.0's CIC:AC-011 (a session with no recorded clause set) is retired: a Story has one current step, and REQ-008 covers the step an amendment reopens.

## 9. Owner decisions, 2026-11-13

1. **D1, the clause in the prompt.** A document step that rule E8 would keep because it does not cite the changed clause, while that clause was in its prompt, is asked "still holds" by its approver on the decisions card: one question per such step per change (REQ-021). Built in stage 4, behind switch 1. Until then the preview shows "was in its prompt" as information beside "kept: cites none".
2. **D2, editorial changes.** An `editorial` change (wording only: no bound test, no acceptance clause, no expected-path or test-binding change; rules bound the class, a model may only propose it) carries evidence without per-step "still holds". The scope approver approves the new wording as editorial, and the record says it was carried that way (REQ-013, REQ-014).
3. **D3, additive records.** Records are additive: `scope-revision/v2` beside v1, no factory reset and no migration that rewrites a record. SDS:REQ-144 is amended accordingly (REQ-002, REQ-019).
4. **D4, no default allowance.** No default allowance limit. The preview and the report show churn and reversals; measure first (REQ-016).
5. **Publication of superseded work** is refused, not rebased (REQ-009).
6. **Naming.** The classes are `editorial`, `refinement` and `material`. The preview is `story intent-amendment preview`, beside the existing `draft` and `propose`. The scope-change authority is a new optional policy key naming an `approvalAuthorities` group, defaulting to the scope step's own approval groups.
7. **Older Stories.** The widening of REQ-006 applies only to Stories whose pinned policy enables switch 1; a Story pinned before enablement keeps baseline behaviour (REQ-019).

## 9a. Owner decisions, 2026-11-14

1. **Stage 4 takes the recommended defaults** (section 7.3).
2. **Supporting changes count as covered when the plan lists them.** A changed path named as a supporting change in an approved plan row or approved plan amendment (`PAM-NNN`, add-supporting) counts as covered and depends on no clause; any other changed path no clause claims stays `unclaimed-paths`, and the record is unresolved (REQ-005).
3. **A "still holds" row may be answered yes or no in chat.** This covers the D1 rows (`reason: prompt-held`) and the older SCS revalidation rows alike.
   - Yes is "still holds" (`unchanged`); no is "redo", which returns the Story to that step. Each answer is the row's own `upstream-issue revalidate` command, run by the /sf-decide turn for the bound Story only.
   - The chat answer binding holds the command to the person's own answer. A host's auto-reply, a declined question, or a reason they did not type is refused.
   - The command must also match the yes or no they gave for that row's question: Yes runs `unchanged`, No runs `return`. A mismatch, no yes or no, or Not now records nothing, and the refusal says to ask again.
   - One yes or no carries one row. A departure is held the same way (yes accepts, no rejects). An applicability or a plan row whose question names it is held to its Yes, since its No records nothing.
   - A reason shorter or longer than the command takes is refused before the command runs, with "ask the person for a reason of at least N characters", so the turn goes on. The question states the minimum.
   - The question names its row and the recommended answer and why, in one line. The row is never settled for the person.
   - Only the step's own approvers may answer; the command checks this as before. `decide-amendment`, a forward amendment's own approval, stays the approvers' own terminal step.
   - Where SF Guard requires the Story's person steps, no row offers chat: this row, and every other row whose chat choice SF Guard signs. Every host says the row is recorded in the person's own terminal.
4. **Stage 5: a draft from before an approved amendment is refused, not rebased.** The check is bound to records: the scope revision digest a code generation and a composed prompt started under, never times. Its way out is in the same step: begin and compose the step again. It names its exact commands, loops nothing back and stalls no other step. Switch 2 is on for new Stories (`spec.preAmendmentDrafts: refuse`, pinned), and a Story pinned before keeps main's behaviour. When the step is redone, the recomposed prompt names the old draft read only, at its exact path, marked as written before the amendment, to keep only where it still holds (section 7.4).
5. **A reopened document's text may stay as it was.** When the author of a document step the amendment reopened finds that the old text still holds under the amended scope, it is published unchanged; nothing makes them edit it to get past a check. What stays required is the record: an agent's draft is composed again under the amended scope, and the step's approvers approve it again.

## 10. Validation boundary

Section 2 was confirmed against the full source at the baseline commit, including every place G2 and G3 name. The SDS identifiers cited (SDS:REQ-144, SDS:CON-061) were checked against [CLAUSE-DRIVEN-SPECIFICATIONS.md](CLAUSE-DRIVEN-SPECIFICATIONS.md).
