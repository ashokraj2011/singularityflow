# Team Agent to SFlow Workflow Import

**Specification ID:** `TAWI-v2`

**Status:** Implemented in v1 (`workflow import-team`, `/sf-import-team`); revised against the engine at `main` `a0970db5`, decisions in §18

**Version:** `1.0.0`

**Date:** 2026-10-14

**Copilot entry point:** `/sf-import-team` (skill directory `plugin/skills/sflow-import-team`)

**Deliverable:** one validated `sflow-workflow-bundle` JSON file, imported through the existing
Workflow Studio Import flow.

**Related work:** [Workflow authoring](topics/workflow-authoring.md) (bundle export and import),
[Phase mutation contracts](SPEC-PMC-PHASE-MUTATION-CONTRACT-v1.md) (Copilot turn guards),
`skill inspect <LOCAL-DIRECTORY>` (stable local capture precedent).

---

## 0. What this revision changes

Every engine claim in the previous draft was checked against the code. The draft's intent stands;
these corrections change how it must be built.

| Previous draft said | Verified fact | Consequence in this revision |
|---|---|---|
| The skill reads the team directory and writes the JSON. | During an `/sf-*` turn the Copilot guards refuse listing or searching outside the repository (`copilot-repository-boundary.mjs`), refuse unregistered shell commands, and refuse file edits when no Story contract exists (`copilot-mutation-guard.mjs`). Only exact-file reads pass. | All capture, compilation, validation and writing are **registered CLI commands**. The model interprets; it never walks the directory or writes files itself (§4). |
| "A new compiler may be required." | Bundle construction (`buildBundle`), validation, the compact canonical JSON and the digest in `src/workflow-transfer.mjs` are private. Hashes from `records.mjs` use a different canonical form. Export falls back to working-tree authority when no approved `sflow/config` exists. | No second serializer. Extract a shared compiler API from `workflow-transfer.mjs` and use it for both export and conversion (§8, ENG-1). |
| File `<workflow-id>.sflow-workflow.json`. | No naming convention exists; export writes whatever `--out` names; VS Code filters on `.json`. | Default name `<workflow-id>.sflow-workflows.json` (the form tests use); any `.json` imports. |
| "Obtain the schema version from the engine." | Family `workflow-bundle`, `currentVersion: 9`; v1–v8 readable; newer refused with `SCHEMA_VERSION_FUTURE`. | Kept, with the exact family named. |
| "Closed schema." | Top level, object sections and the dependency closure are exact (`SKP_WORKFLOW_PACKAGE_INVALID`, `WORKFLOW_BUNDLE_INVALID`, `…_DEPENDENCY_EXTRA`, `…_DEPENDENCY_MISSING`). Individual asset records are only type-checked, and an `encoding: base64` field is honoured although the digest covers the string. | Requirements use the exact behaviour; the asset-record gap is ENG-5. |
| "Supported dependency assets." | Exactly six asset kinds, UTF-8 text only: `template`, `agent`, `vendored`, `skill`, `instruction`, `constitution`. Binary exists only inside approved compiled `skillPackages`, which a converter cannot fabricate. Limits: 1 MiB per asset, 16 MiB total, 2,048 assets, 32 skill packages. | Scripts, hooks, images and arbitrary documents are prerequisites or unsupported, never assets (§7.6). |
| Phase fields `producer`, `generatesCode`, `requiredArtifact`. | Phase-level `producer` is refused (`SKP_PHASE_PRODUCER_UNSUPPORTED`). Code generation is `generation.task: code` with `writeScope: source-and-artifact`. The YAML key is `artifact`. `authoringSkill` accepts built-in `sf-*` skills only. | Mapping uses real fields (§7.2). Custom procedures become attached library skills, not `authoringSkill`. |
| A phase belongs to its workflow. | `phases` is one map shared by every work type; each phase has **exactly one default agent across the whole catalog** (agent `metadata.sflow-phases` / `sflow-default-for`). | Imported phases need namespaced IDs; reusing a destination phase ID is a collision, not a merge (TAWI-REQ-016). |
| "Defined exhausted-loop outcome." | Decision kinds are `branch`, `loop`, `ask`; one decision per phase; backward routes require `maxRounds` (default 3, limit 1–20) and a `by` group; exhausting the rounds **pauses the Story for a person in `by`**, which is not configurable; automatic backward routes require `approval.mode: required` on the deciding phase. | Exhaustion maps to that fixed behaviour; a source that needs a different outcome is `unsupported` (TAWI-REQ-019). |
| Conditional instructions ("applies when"). | No condition support for instructions or skills: only step restrictions, the free-text `use` field, `sflow-loading`, and placement inside skill text (`<instruction>id</instruction>` or `<!-- sflow-instruction: id -->`). | Conditions are preserved by **placement** in the procedure text and shown as `approximated`; there is no silent "always" (TAWI-REQ-014). |
| "Use an eligible independent reviewer." | No general agent-independence rule. Human self-approval is allowed and disclosed (`allowSelfApproval`, `phase_self_approved`); agent independence exists only in `sourceReview.reviewerAgent`. | Independence maps to `sourceReview` with a distinct reviewer agent or `allowSelfApproval: false`; otherwise unresolved (TAWI-REQ-017). |
| Structural simulation of pass/repair/exhausted routes. | `workflow simulate` is a structural lifecycle profile; it does not walk decision routes. | Route simulation is new engine work (ENG-2, `src/workflow-route-simulation.mjs`), required for v1. |
| A phase is valid once the loader accepts it. | The loader keeps a workflow readable when a route drops a responsibility. Every route owes scope, plan, implement, verify and review (derived from structure in `src/evidence/responsibilities.mjs`), and a code step needs an earlier step that defines requirement clauses (`plannedClaims`); Story start refuses otherwise. | Compile checks the obligation graph and planned claims itself. A candidate meets them through artifact kinds (`requirements`/`implementation-spec` for scope, `implementation-plan` for plan, `test-evidence` for verify) or declares `omits` with a reason and approval group. |
| Independent review is configured per phase. | `sourceReview` is a work-type policy: `{ mode: enforce, phases, reviewerAgent }`. | The candidate carries `workflow.sourceReview`. |
| Parallel or nested execution "not flattened". | Story workflows have neither (SGOS programs and Initiatives do). | Parallel or nested source orchestration is `unsupported` in v1. |
| Existing ingestion could be reused. | No feature ingests external agent or skill directories. `asset-import` takes single https/`market:`/`mcp:` files. `harness-imports.mjs` is about governed evidence handles, not harnesses. `skill inspect <dir>` is the only local-directory capture. | Capture is new, built on `skill inspect`'s stable-capture helpers and `secrets.mjs` (§6). |
| Import validation includes configuration diagnostics. | Import runs `validateDefinition` + `validateAgentCatalog` (+ `validatePortfolio`), at preview and again at apply; `diagnoseWorkflowText` is not used. | Compile-time validation runs the same validators plus `diagnoseWorkflowText` for located messages. |

## 1. Objective

A user selects a local directory of team automation (agents, skills, instructions, templates and
framework guidance) and an **entry agent**: the agent whose instructions describe the end-to-end
process. `/sf-import-team` converts that process into an SFlow workflow, validates the conversion,
and writes one bundle the user imports through Workflow Studio. The entry agent is the workflow's
source, not merely an agent to copy into the catalog.

The conversion is honest about what it cannot represent. Anything the engine cannot express is
reported and keeps the bundle from being called ready; nothing is approximated silently.

## 2. Terms

| Term | Meaning in this spec |
|---|---|
| Workflow | An SFlow work type (`workTypes.<id>`) with its ordered phases, decisions and policies. |
| Phase (step) | An entry in the shared `phases` map, used by one or more work types. |
| Agent | A `.github/agents/<id>.agent.md` persona with `metadata.sflow-phases` / `sflow-default-for`. |
| Library skill | `singularity/skill-library/<id>/SKILL.md`, attached to an agent (agent scope) or a workflow (workflow scope, `attachments.yml`). |
| Instruction | `singularity/instruction-library/<id>/INSTRUCTIONS.md`, placed inside skill text. |
| Decision | A `branch`, `loop` or `ask` node after a phase (`workflow-decisions.mjs`). |
| Bundle | A `kind: sflow-workflow-bundle`, `workflow-bundle` v9 JSON file. |
| Conversion session | The machine-local working record of one conversion: capture, candidate, decisions, findings. |
| Candidate | The model's proposed mapping, in the versioned `team-import-candidate` record format (§5). |
| Disposition | Per source item: `mapped`, `approximated`, `unresolved`, `unsupported`, `excluded`. |

## 3. User experience

### 3.1 Invocation

```
/sf-import-team <directory> [--entry <agent>] [--workflow-id <id>] [--namespace <prefix>]
                [--root <extra-directory>]... [--destination <repository>] [--out <file>]
```

These are skill arguments. Each maps to an option of the CLI commands in §4.

### 3.2 Result

The skill reports, in a compact summary:

- workflow ID, the phase sequence and the decisions;
- counts of agents, skills, instructions and templates;
- dependency coverage and every non-`mapped` disposition with its reason;
- the validation state (§10), and the exact `bundleSha256` it describes;
- destination compatibility, when a destination was given;
- a Markdown-preview link to the bundle and the next action (Workflow Studio → Import).

It never pastes prompts, source documents, generated skill bodies or code into chat.

### 3.3 Import

Workflow Studio → **Import…** → select the file. The existing flow runs
`workflow import <file> --resolve-all suggested --dry-run --json`, shows adds, reuses, renames,
replacements and conflicts, then **Create proposal** applies with `--confirm <planSha256> --propose`.
That produces a configuration proposal branch, or a local draft in local-authority mode. Activation
is the separate **Review and activate** step.

Generating the bundle never starts a Story, creates a proposal, activates or approves configuration,
or modifies the source directory or any repository.

## 4. Architecture

### 4.1 Responsibility split

| Step | Owner | Model? |
|---|---|---|
| Capture inventory and referenced content | CLI `workflow import-team inspect` | No |
| Interpret the process; propose the candidate | Copilot, following the skill | Yes |
| Stage, normalize and validate the candidate | CLI `workflow import-team compile` | No |
| Build, serialize, hash, re-read and write the bundle | CLI, shared compiler (ENG-1) | No |
| Destination preview | CLI `workflow import-team compile --destination` → existing import planner | No |
| Presentation | The skill, from returned JSON | Yes (summary only) |

The model never produces hashes, locks, validation results, approval receipts or integrity fields.

### 4.2 CLI

```
singularity-flow workflow import-team inspect <DIRECTORY> [--entry AGENT]... [--root DIR]... [--max-files N] [--max-total-bytes N] [--json]
singularity-flow workflow import-team compile --session ID [--dry-run] [--answer ID=CHOICE]... [--destination REPOSITORY] [--out FILE] [--allow-not-ready] [--json]
singularity-flow workflow import-team status [--session ID] [--json]
```

- `inspect` is **read-classified**. It captures the bounded inventory, resolves references, screens
  secrets, and returns: the capture digest, candidate entry agents, the reference graph with
  dispositions, the bounded and screened content of the selected closure, and a **session ID** with
  an issued **candidate staging path**.
- The model writes the candidate only to that staging path. This is the pattern the guard already
  allows for clarification responses: an exact path issued by the CLI, matched by the guard.
- `compile` reads the candidate, stages and validates it, and writes the bundle only with `--out`
  and without `--dry-run`. It is a mutation of the user-selected output file only.
- The skill must name only commands registered in the operation catalog (`unrunnableCommands`
  policy). It cannot ship before the CLI exists.

### 4.3 Conversion session record

The session lives in machine-local state, outside any repository and outside the source directory:
`<state>/team-imports/<session-id>/`. Directories are `0700`, files `0600`. It holds:

- the capture manifest: path, size, SHA-256 and screening result per file;
- the candidate and its revisions;
- the human decisions;
- the deterministic findings.

Sessions expire after seven days, and `workflow import-team status` lists what remains. The
record is never part of the bundle.

## 5. Candidate format (`team-import-candidate` v1)

A versioned, closed JSON record family registered in `schema-migrations.mjs`. The compiler accepts
nothing else from the model. Fields:

- `captureSha256`: the capture this candidate interprets. Compile refuses a stale capture.
- `workflow`: `id`, `label`, ordered `phases[]`, `decisions[]`.
- `phases[]`: real phase fields only (§7.2), with namespaced IDs.
- `agents[]`, `skills[]`, `instructions[]`, `templates[]`: content plus intended scopes.
- `attachments[]`: `{skill, agent | workflow, steps, use}`, the same shape as `attachments.yml`.
- `mappings[]`: one entry per extracted source item, with:
  - `{sourceItem, evidence: [{path, sha256, startLine, endLine}], target, disposition, kind}`
  - `kind` is one of `explicit | inferred | destination-policy`.
- `prerequisites[]`: things the destination must provide, such as approval authorities, quality
  commands or environments, each with source evidence.
- `decisionsNeeded[]`: open questions, each concrete and with choices.

Every evidence span must lie inside a captured file whose SHA-256 matches. Prose-only references are
allowed, but must cite the span they were read from.

## 6. Source discovery and capture

**TAWI-REQ-001 — Explicit boundary.** `inspect` reads only the selected directory and the explicit
`--root` directories. It never searches home, parent directories, other repositories or the
filesystem. Symbolic links that leave the roots are not followed; they are reported.

**TAWI-REQ-002 — Supported source formats (v1).** Recognition is by path and front matter, not by
guessing:

| Format | Recognized as |
|---|---|
| `.github/agents/*.agent.md`, `.github/chatmodes/*.chatmode.md` | Agents (Copilot) |
| `.<tool>/agents/*.md` in a hidden tool directory (front matter `name`, `description`, `tools`) | Agents (matched by layout, so no tool is named) |
| `**/SKILL.md` (a directory skill) | Skills |
| `.github/instructions/*.instructions.md` (with `applyTo`), `.github/copilot-instructions.md`, `AGENTS.md`, a root `<TOOL>.md` beside its `.<tool>/` directory | Instructions |
| `.github/prompts/*.prompt.md` | Procedures (a skill candidate) |
| Other Markdown or text referenced by the above | Reference documents |

Anything else is inventoried by name and kind but never interpreted as executable behaviour. The
format table is versioned; adding a format is a capture change with its own tests.

**TAWI-REQ-003 — Entry agent.** `inspect` lists candidate entry agents: agents that reference other
agents or skills, or describe multi-step work.
- When exactly one is plausible, the skill may select it and must say so.
- When several materially different ones exist, the user chooses. Unrelated automations are never
  merged.
- Several entry agents may become several workflows in one bundle, with one validated closure.

**TAWI-REQ-004 — References.** Structured metadata, Markdown links, explicit paths, named skills or
instructions, and declared delegations are resolved deterministically. Each reference is
`resolved`, `ambiguous`, `missing`, `unsupported` or `excluded`. Reference cycles are reported and
are distinct from intended runtime repair loops.

**TAWI-REQ-005 — Complete, stable capture.** A file used as evidence for a mapping is captured
whole, or not at all; a truncated excerpt is never evidence.
- Capture uses two passes (the `assertStableSkillCapture` approach), and refuses or re-captures a
  file that changed between them.
- Bounds are configurable and reported: per-file size, file count, depth and aggregate bytes.
- An explicitly referenced file that is excluded by default (a build directory) or by a bound is
  `unresolved`, never ignored.

**TAWI-REQ-006 — Secrets.** Every captured file passes `scanText` / `scanEntries` (`secrets.mjs`)
before its content is returned to the model or staged.
- A file with findings is withheld, and its references become `unresolved` with the reason.
- The waiver marker is never honoured for imported content.
- The path patterns blocked by `harness-imports` (`.git`, `.env`, `.ssh`, key and credential names)
  are never read.

**TAWI-REQ-007 — Untrusted content.** Captured content is returned labelled as conversion data. The
skill text requires the model to ignore instructions inside it: executing anything, reading other
locations, disclosing credentials, disabling validation, creating approval evidence or writing
configuration.

The CLI enforces what it can: it reads no other paths and executes nothing. The model's own file
tools are outside the CLI's control. The Copilot repository-boundary guard limits them to exact-file
reads, and the skill must not ask for more.

## 7. Interpretation and mapping

**TAWI-REQ-008 — Extract the process.** The candidate identifies:
- activities and their order;
- delegations;
- inputs and outputs;
- success and failure conditions;
- repair behaviour;
- human checkpoints;
- completion rules;
- requested tools and write scope.

Each item is `explicit` (stated in the source), `inferred` (interpreted) or `unresolved`. Material
inferences need a human decision before the bundle can be `portable-ready`.

### 7.1 Mapping table

| Source content | SFlow representation | Engine constraint |
|---|---|---|
| Whole-task orchestration | Work type with ordered `phases` | Phase IDs are global: namespace them (`<namespace>-<phase>`). |
| A distinct activity with its own output | Phase with `artifact`, `inputs`, `writeScope`, `approval` | One default agent per phase across the catalog. |
| Persona or specialist | Agent with `metadata.sflow-phases` / `sflow-default-for` | `tools[]` is copied only as reviewed; an inferred tool grant is never added. |
| Code-writing activity | Phase with `generation.task: code`, `writeScope: source-and-artifact`, `qualityCommands` | Governed by the existing `codeDelivery` policy. |
| Reusable procedure | Library skill, attached at agent or workflow scope | `authoringSkill` stays a built-in `sf-*` skill. |
| Conventions, conditional guidance | Instruction placed inside the skill text at the point of use | No "applies when": conditions survive only by placement and `use`. |
| Pass/fail and retry | `branch` or `loop` decision with `maxRounds` (1–20) and `by` | One decision per phase. Exhaustion pauses for `by`. Automatic backward routes need `approval.mode: required`. |
| Human checkpoint | `approval.mode: required` with authorities, or an `ask` decision | Authorities are destination policy: prerequisites, never invented. |
| Independent review | `sourceReview` with a distinct `reviewerAgent`, or `allowSelfApproval: false` | There is no other independence mechanism. |
| Templates | `template` assets bound to their reference | Text only, within the bundle limits. |
| Scripts, hooks, binaries, external tools | Prerequisites or `unsupported` | Never an asset of another kind. |
| Parallel or nested orchestration | `unsupported` in v1 | Story workflows have neither. |

**TAWI-REQ-009 — Phase-specific prompts.** A phase receives only its own role, procedure, attached
skills and placed instructions, required inputs, expected outputs, completion conditions, and write
scope. The source agent's full orchestration text is never copied into every phase, so a planning
phase cannot write code because the source described the whole task.

**TAWI-REQ-010 — Phase contracts.** Every phase resolves:
- its default agent;
- its `artifact`, `inputs` and `writeScope`;
- its approval;
- any checks;
- its route out.

A code phase must have `qualityCommands` taken verbatim from source evidence (`argv` exactly as
written), or a declared prerequisite. The model never invents arguments, environments or approval
membership. Hidden or redacted arguments in the source are reported as such, not treated as
missing.

### 7.2 Behaviour preservation

**TAWI-REQ-011 — Nothing silently weakened.** Every relevant source activity has a mapping or an
explicit non-`mapped` disposition. The conversion never silently:
- removes a checkpoint;
- turns a failure into a warning;
- replaces "test again" with an unchecked continuation;
- treats unavailable evidence as a pass;
- makes a mandatory instruction optional;
- adds behaviour the source doesn't require.

**TAWI-REQ-012 — Destination policy is labelled.** Anything SFlow requires that the source did not
say (an approval mode, `maxRounds`, a `by` group) is recorded as `kind: destination-policy` and shown
separately. It is never attributed to the source.

**TAWI-REQ-013 — Dependency relationships survive.** The bundle preserves:
- agent → skill attachments;
- skill → instruction placement;
- phase restrictions;
- `use` text;
- the templates a phase needs.

Instructions an agent referenced directly become an agent-scoped guidance skill that places them.

**TAWI-REQ-014 — Conditional guidance.** An instruction that applies at a point in a procedure is
placed there with `<instruction>id</instruction>` and keeps its condition in the surrounding text.
For example, "When changing an API contract, follow `<instruction>api-compatibility</instruction>`"
must not become a phase-wide rule.

Copilot `applyTo` globs and similar conditions have no engine equivalent. They are shown as
`approximated`, with the original condition quoted, so a reviewer can accept or reject the
approximation.

**TAWI-REQ-015 — Scope.**
- Workflow-scoped skills attach through `attachments.yml` to the imported work type and steps only.
- Agent-scoped skills follow the agent.
- The composer's existing dedupe applies: one rendering, merged scopes and `use`, and a refusal when
  the bytes differ.

**TAWI-REQ-016 — No collision by reuse.**
- Generated phase, agent, skill and instruction IDs are namespaced and unique case-insensitively
  (Windows and macOS).
- The candidate never reuses a destination ID to merge behaviour.
- Reusing a destination asset happens only through the import planner's `keep` with identical
  bytes.

**TAWI-REQ-017 — Independence is not invented.** Renaming the author's agent does not create an
independent reviewer. A source requirement for independent review maps to a `sourceReview` reviewer
agent distinct from the author, or to `allowSelfApproval: false`. Otherwise it stays `unresolved`.

**TAWI-REQ-018 — Executable dependencies.** Scripts, hooks and commands are never executed during
inspection or conversion. Their presence is recorded. A script-backed procedure is never turned into
an instruction-only skill that claims to preserve behaviour.

**TAWI-REQ-019 — Decisions and loops.** Every branch route has a supported `when` (except the last
route), and every loop has a `goal`, a `back` target and a `maxRounds` between 1 and 20. An
unbounded source loop needs a human-chosen bound.

The exhausted outcome is SFlow's fixed pause for the `by` group. A source that needs anything else
on exhaustion, such as automatic escalation or skip, is `unsupported` until the engine supports it.

## 8. Packaging

**TAWI-REQ-020 — One compiler.** The bundle is built by the shared compiler extracted from
`workflow-transfer.mjs` (ENG-1), so export and conversion produce bytes the same way:
- the same closure rules;
- the same compact canonical JSON and `bundleSha256`;
- the same per-asset `sha256` and `size`;
- the same per-workflow `definitionSha256`.

The compiler takes the staged candidate configuration as input. It never initializes a repository or
fabricates approved-configuration provenance.

**TAWI-REQ-021 — Exact schema.**
- The bundle is `workflow-bundle` at the engine's current version (9 today), with only the fields the
  reader defines.
- Conversion evidence, mappings and states never enter the bundle; they live in the session record
  and the summary.
- A conversion report file is written only on request, beside the bundle, never inside it.

**TAWI-REQ-022 — Supported assets only.**
- Every retained asset is one of the six kinds, UTF-8 text, at its canonical path, within the
  limits.
- Library skills are `skill` assets. Compiled `skillPackages` are never produced, because they
  require an approved `sflow/config` source.
- An unsupported resource is reported, the candidate is kept, and the state is not ready. No
  resource is relabelled as another kind.

**TAWI-REQ-023 — Output safety.**
- The bundle is written only to `--out`.
- An existing file is refused, as export does (`WORKFLOW_EXPORT_OUTPUT_EXISTS`).
- The write is complete and atomic, with mode 0600.
- Paths inside a repository's `singularity/`, `.github/` or `sflow/` configuration are refused.
- The written file is re-read with `readWorkflowBundle` before success is reported.
- A failed conversion never overwrites a previously valid bundle.

## 9. Validation

Validation runs inside `compile`; it is not left to the user. Deterministic checks decide the state.
The model's semantic review produces findings and decisions, never a pass.

**TAWI-REQ-024 — Dependency completeness (deterministic).** Every required reference is in the
bundle, a declared prerequisite, or `unresolved` (blocking). The bundle closure is exact: no
`…_DEPENDENCY_MISSING` and no `…_DEPENDENCY_EXTRA`. Every named skill and instruction exists, and
every attachment resolves to its owner and steps.

**TAWI-REQ-025 — Coverage completeness (deterministic).**
- Every source item extracted at capture or interpretation has exactly one mapping with a
  disposition.
- Every evidence span resolves inside the capture with a matching SHA-256.
- Every inferred mapping marked material has a recorded human decision.

**TAWI-REQ-026 — Semantic review (model, advisory).** The model reviews the candidate against the
source for:
- order;
- delegation;
- input/output meaning;
- conditional placement;
- pass/fail conditions;
- checkpoints;
- closure.

Its findings become repairs or `decisionsNeeded`. Contradictions in the source are reported, not
resolved by preference. Review findings never upgrade the state; only resolved findings and
decisions do.

**TAWI-REQ-027 — Structural validity (deterministic).** The staged configuration passes the
validators the importer uses:
- `validateDefinition`, `validateAgentCatalog` and `normalizeDecisions`;
- the obligation graph;
- `normalizeReworkLoops`.

It also passes `diagnoseWorkflowText`, for located messages, and the shared compiler's bundle
validation: identities, digests, sizes and closure.

**TAWI-REQ-028 — Route analysis (deterministic, v1).**
- Every phase is reachable.
- Every path reaches `end`.
- Every backward route is bounded.
- Every `by` group and approval authority names a declared authority or prerequisite.

Route-level simulation (ENG-2) runs on every compile with the engine's own decision rules: a
pass, each reachable route (a backward route is a repair), repeated failure until the rounds run out
(which must pause for the `by` group), unavailable evidence (the engine refuses to choose, so the
Story waits), and each rejection target. A route an earlier rule always shadows is reported.

**TAWI-REQ-029 — Destination preview.** With `--destination`, `compile` runs the existing planner,
`workflow import <bundle> --resolve-all suggested --dry-run --json`, against that repository's
verified configuration. It reports collisions, missing prerequisites and the `planSha256`.

It never applies anything. The planner already binds `bundleSha256`, the destination authority and
the target state, and a changed bundle or destination is refused at apply
(`WORKFLOW_TRANSFER_PLAN_STALE`).

## 10. Validation states

| State | Meaning |
|---|---|
| `portable-ready` | All deterministic checks pass; no material decision is open; no destination was checked. |
| `ready-for-destination` | `portable-ready`, plus the destination preview passed (bound to `bundleSha256` and `planSha256`). |
| `needs-decision` | Material interpretations or prerequisites wait for a person. |
| `unsupported` | Required behaviour or resources cannot be represented by the installed engine. |
| `invalid` | Structural, integrity or dependency validation failed. |

Warnings may accompany a ready state only when they affect neither required behaviour nor
importability. The summary names the `bundleSha256` it describes.

"Ready" never means approved, activated, executed, tested, or independently reviewed.

## 11. Repair and clarification

**TAWI-REQ-030 — Targeted repair.** The model may repair candidate errors that `compile` reports,
using information already captured:
- references;
- names;
- attachments;
- phase contracts;
- decision fields.

Every repair is followed by a full `compile --dry-run`. Missing authority, unknown execution
semantics and source contradictions are never repaired by guessing.

**TAWI-REQ-031 — Bounded attempts.** Automatic repair is limited per candidate; three is the
default. Compile fingerprints its findings, and an unchanged fingerprint ends repair. At the limit
the session is kept, and the remaining actions are listed.

**TAWI-REQ-032 — Useful questions.** Questions name a concrete ambiguity and its choices, for
example:
- Which agent is the entry point?
- Does this instruction apply only to API changes?
- Which authority approves the final checkpoint?
- What bound applies to this repair loop?

Related questions are asked together. The user is never asked to invent a question or an answer
format.

## 12. Skill contract

`/sf-import-team` is registered like every skill:

| Setting | Value |
|---|---|
| Directory and name | `sflow-import-team` |
| Registry class | `guided` |
| `executionBoundary` | `repository` |
| `disable-model-invocation` | `true` |
| `kernelModelPolicy` | `never`: Copilot interprets, the kernel calls no model |
| Body budget | Within its class budget |
| Generated blocks | Pause guard, output contract and execution boundary |

Its turn mode, `import-team`, admits reads, the three `workflow import-team` commands and edits to exactly the issued candidate file, with or without a bound Story (ENG-3).

The body requires, in order:
1. `inspect`, then a confirmed entry agent.
2. Interpretation into the candidate, written only to the issued path.
3. `compile --dry-run` and repair within the limit.
4. Questions, when decisions are open.
5. `compile --out` only when the state is ready or the user explicitly asks for a non-ready file,
   which is never labelled ready.

## 13. Security, portability, performance

**Security.** TAWI-REQ-001, -005, -006, -007, -018 and -023, plus:
- no network fetching;
- detection of files that change during capture;
- path traversal refused.

A dependency withheld for security reasons is unresolved, never evidence of completeness.

**Portability.** Tests cover:
- Windows and macOS separators;
- CRLF and UTF-8 (BOM included);
- case-insensitive collisions;
- reserved names;
- relative-reference rewriting.

No source-machine absolute path appears in the bundle.

**Performance.**
- `inspect` lists names and front matter before reading bodies, and reads only the selected closure.
- The session caches captured content; the application repository is never loaded.
- Cold and warm runs are measured on Windows and macOS against committed fixtures.
- A smaller model context never removes required content.

## 14. Repeat generation and recovery

- The same accepted candidate on the same capture produces a byte-identical bundle, with the same
  `bundleSha256`. A new model interpretation may differ, and the difference is shown, not presented
  as equivalent.
- Re-running against a changed source re-captures and reports:
  - changed, removed and added files;
  - mappings whose evidence moved.
- Destination keep, rename and replace remain the import planner's choices; generation never
  authorizes replacement.

## 15. Engine changes this feature needs

| ID | Change | Why |
|---|---|---|
| ENG-1 | Export a compiler API from `workflow-transfer.mjs` (build, validate, canonical JSON, digest), used by both `workflow export` and `workflow import-team compile`. | The serializer and hasher are private. A second implementation would drift. |
| ENG-2 | Route simulation for decisions: pass, repair, exhaustion, unavailable evidence, rejection. | `workflow simulate` covers lifecycle structure only. |
| ENG-3 | Turn mode and guard admission for `/sf-import-team`: the `workflow import-team` commands plus the issued staging path. | The current `read` mode refuses unregistered shell and file edits. |
| ENG-4 | `workflow import-team inspect|compile|status` commands, the `team-import-candidate` record family, and the session store. | None exist. |
| ENG-5 | Close asset records to known fields, and refuse or define `encoding: base64` in assets. | Asset records are only type-checked today. |
| ENG-6 *(optional, later)* | Conditional applicability for instructions or skills. | Today conditions survive only by placement. |

## 16. Acceptance matrix

| ID | Requirement | Test | Required result |
|---|---|---|---|
| TAWI:AC-001 | REQ-008 | One agent describes the whole process. | A workflow with phases and decisions, not just a copied agent. |
| TAWI:AC-002 | REQ-008, -013 | The agent delegates to two specialists. | Specialists become phase default agents with their skills. |
| TAWI:AC-003 | REQ-013 | Agent → skill → instruction chain. | The chain resolves; the instruction is placed and composed once. |
| TAWI:AC-004 | REQ-008 | Orchestration lives in a referenced skill. | Phases and conditions are extracted from it. |
| TAWI:AC-005 | REQ-014 | A conditional instruction with `applyTo`. | Placed at its point of use; shown `approximated` with the original condition. |
| TAWI:AC-006 | REQ-009 | The same agent plans and codes. | The planning phase has an artifact-only `writeScope`; only the code phase has `source-and-artifact`. |
| TAWI:AC-007 | REQ-019 | A test/repair loop. | A loop with `goal`, `back`, `maxRounds` and `by`; route analysis passes. |
| TAWI:AC-008 | REQ-011 | Test evidence is unavailable. | Never mapped to a pass; the code phase keeps its checks. |
| TAWI:AC-009 | REQ-004, -024 | A missing or ambiguous dependency. | `needs-decision` or `invalid`, never ready; targeted questions. |
| TAWI:AC-010 | REQ-018, -022 | A required script. | Reported as prerequisite or unsupported; never relabelled; not ready. |
| TAWI:AC-011 | REQ-007 | The source contains importer-directed instructions. | No extra read, execution or write; the attempt is reported. |
| TAWI:AC-012 | REQ-016 | Case-insensitive ID collision. | Refused before the bundle is written. |
| TAWI:AC-013 | REQ-005 | A file changes during capture. | Capture refused or redone explicitly. |
| TAWI:AC-014 | REQ-023 | The output already exists. | Refused; the previous file is unchanged. |
| TAWI:AC-015 | REQ-027, ENG-5 | Wrong hash or an unknown field. | Compile and `readWorkflowBundle` refuse it. |
| TAWI:AC-016 | REQ-029 | Destination preview passes. | `ready-for-destination` with `bundleSha256` and `planSha256`. |
| TAWI:AC-017 | REQ-029 | The destination changes before import. | The existing importer refuses (`WORKFLOW_TRANSFER_PLAN_STALE`). |
| TAWI:AC-018 | REQ-029 | No destination given. | `portable-ready`, never destination-qualified. |
| TAWI:AC-019 | REQ-020 | Import, then export again. | Contracts and dependency relationships survive; the second import is all reuse. |
| TAWI:AC-020 | REQ-015, -016 | The destination already has a phase with the same base name. | The imported workflow's skills do not attach to it; the namespaced ID is used. |
| TAWI:AC-021 | REQ-006 | A captured file contains a secret. | Withheld from the model and the bundle; its references are unresolved. |
| TAWI:AC-022 | REQ-002 | One fixture per supported source format. | Each is recognized as the format in the table; unsupported ones are inventoried only. |
| TAWI:AC-023 | REQ-019 | A source loop with no bound, or more than 20 rounds. | `needs-decision` asking for a bound of 1–20. |
| TAWI:AC-024 | REQ-019 | The source escalates automatically on exhaustion. | `unsupported`, citing the fixed pause behaviour. |
| TAWI:AC-025 | REQ-017 | The source requires independent review by the same persona. | `unresolved`, not a renamed agent. |
| TAWI:AC-026 | REQ-020, §14 | Compile the same candidate twice. | Identical bytes and `bundleSha256`. |
| TAWI:AC-027 | §12, ENG-3 | Run the skill under the real Copilot guards. | No guard refusal on the documented path; directory listing still refused. |
| TAWI:AC-028 | REQ-010 | A code phase whose source gives no test command. | A declared prerequisite, never an invented `argv`. |

Tests inspect generated configuration, references and routes. Matching prompt wording is not
acceptance.

## 17. Milestones

0. **Engine prerequisites:** ENG-1, ENG-3, ENG-4 (commands and session store), ENG-5.
1. **Capture:** `inspect`, the format table, the secret screen, stable capture, the reference graph.
2. **Interpretation:** the candidate record family, the skill text, questions.
3. **Packaging:** staging, the shared compiler, atomic output.
4. **Validation:** deterministic checks, route analysis, destination preview, states.
5. **Qualification:** realistic team fixtures per format, Windows and macOS portability and timing,
   a real Copilot run under the guards.
6. **Later:** ENG-6 conditional applicability, zip or remote ingestion.

**Definition of done:** for a supported team directory, `/sf-import-team` produces one bundle that
passes every deterministic check. It reports each non-`mapped` disposition, and is imported through
Workflow Studio without modifying the source, bypassing configuration review, or tripping the
Copilot guards.

## 18. Decisions (owner, 2026-10-14)

1. **Formats:** Copilot and the hidden-tool agent layout other coding agents use. The repository's
   own check refuses that vendor's name anywhere in the source, so its layout is recognised by
   shape: `.<tool>/agents/<name>.md`, `.<tool>/skills/<id>/SKILL.md`, and a root `<TOOL>.md` beside
   `.<tool>/`. Tests use `.acme/`.
2. **Command:** `workflow import-team inspect|compile|status`.
3. **Not ready:** the session keeps the work (machine state, seven days); a bundle file is written
   only when ready, or with `--allow-not-ready`, labelled not ready.
4. **Route simulation:** required for v1, and shipped (ENG-2).

## 19. What the implementation added to this specification

- Inspect returns `candidate.guide`, the candidate contract as data from the validator itself, so
  the skill stays within its token budget and cannot drift from what compile checks.
- Compile also proves the bundle imports cleanly into a fresh configuration, every destination's
  baseline, before any `--destination` preview.
- A destination that cannot be previewed is a person's finding (`needs-decision`), never a defect
  of the candidate.
- Answers to open questions are recorded by `compile --answer <id>=<choice>` in the session; the
  candidate can never claim one.

### 19.1 Live Copilot run (2026-10-14)

A real Copilot CLI session ran `/sf-import-team` under the packaged guards, against the fixture team
in the tests. It ended `ready-for-destination`; the bundle it wrote imported, validated as protected,
and a Story started on it. No tool call was refused on the documented path. The run found three
defects, all fixed with regression tests:

- The after-tool hook told any turn without a Story contract to stop and refresh a binding it never
  had (import-team, and setup or session turns before a Story is bound). It now mirrors the
  pre-tool guard's admission.
- The candidate check left decisions and omissions to the loader, which reports one error per
  compile, so the repair budget ran out. They are now checked together, and `candidate.guide`
  carries exact examples. A source reviewer is staged review-only and must author no phase.
- A person's answers now start a fresh repair budget.
