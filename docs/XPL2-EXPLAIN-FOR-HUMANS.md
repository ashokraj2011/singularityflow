# Explain for humans (`XPL2`) — decision record and implementation status

**Implemented boundary (this release):** M0 (decision, compatibility, transient schema), M1
(`explain --subject` for all six subjects at their actual source availability), the early M5
graphical release (the VS Code **Change Explorer**: map, inventory, inspector, exact native diff),
M2 (a deterministic reading tour in every view, and optional structured narration with a separate,
labelled commentary mode) and M3 (recorded test attempts, criterion witnesses and evidence-reuse
applicability from their owners, ordinary commit history for a line, this machine's invocation and
prompt records for a generation with the entries its retention removed, observed writes that name who
left a line when they explain it exactly, and retained snapshots compared from the explorer and the
CLI) and M4 (exact links: the
implementation bindings a code-delivery receipt records, joined to captured units by file content,
with the approval's decision about them; structural impact stays a named unavailability). Nothing here approves, verifies, publishes or gates. Every view is
read-only and grants no authority; only an explicit `--narrate` calls a model.

**Not in this release:** a structural impact producer (none is keyed to an exact change set), observed
writes from terminal commands, kernel model invocations and phase publication (§6), PR rendering and
export, reopening a retained snapshot as a view, and installed-host qualification. Each is reported as
a named unavailability, never approximated.

## 1. Decision

XPL2 is a *subject view* layer over the existing comprehension capture (`CMP`), not a new capture.

- **One capture.** The comprehension IDE slice builds the `change` view inside the same leased
  capture that produces the manifest, bounded diff, code explanation and source references, so the
  map, the inventory, the inspector and every CLI subject describe one repository moment. CLI
  subjects rebuild from the slice's own inputs; they never re-read a second moment.
- **Closed catalogs.** Facts come only from registered statement templates over typed arguments,
  cite admitted sources or the read observation that found something absent, and use a closed
  reason vocabulary. Unknown templates, arguments and reasons are programming errors.
- **Two identities.** `explanationSetSha256` hashes the whole universe for the capture;
  `explanationSha256` hashes the selected subject. Neither includes a clock, a path to the checkout,
  the viewport or the audience. Subject-scoped observations are hashed only into the subject view.
- **No authority.** Every statement carries `authority: "none"`. Audiences reorder and fold; they
  never add, remove or re-evaluate a statement.

### Ownership

| Surface | Owner |
|---|---|
| Engine | `src/comprehension/xpl2/` — `reasons`, `templates`, `vocabulary`, `model`, `change-subject`, `subjects`, `clause-sources`, `narration`, `command` |
| Records | `src/comprehension/xpl2/clause-sources.mjs` (clauses, and attempts, witnesses, reuse decisions and implementation bindings in the slice; invocations, prompts, prompt removal notes and observed writes for `--subject generation`), `lineCommitAt` and `committedFilesAtRevisions` in `src/git.mjs` |
| Observed writes | `observed-write-recorder.mjs` (driven by the pre-tool guard and the prompt and session-end hooks in `src/copilot-mutation-guard.mjs` and `src/copilot-repository-boundary.mjs`; the hook bundle loads it from source), `observed-writes.mjs` (the store's reader), `writer-attribution.mjs` (pure chain by digest), `line-writer.mjs` (which change holds a line) |
| Comparison | `compare.mjs` (import-free; the Change Explorer imports it), `snapshots.mjs` (retained in `src/comprehension/ide-slice.mjs`, read only by `--compare`) |
| Terminal text | `src/narration/render-explanation-subject.mjs`, registered by the explain handler (narration, comparison, record view) |
| Narration | `src/comprehension/xpl2/narration.mjs` (pure input projection, prompt and validation, and `narrateXpl2Explanation`, the one model call, loaded only for `--narrate`) |
| Capture | `src/comprehension/ide-slice.mjs` (adds `explanationView`; `explanationInputs` only on request) |
| CLI | `singularity-flow explain --subject …`, operation `explain.subject` in `src/command-registry.mjs` |
| Copilot | `/sf-explain` (`plugin/skills/sflow-explain`), conversational, relays the same command |
| VS Code | Comprehension Center **Change Explorer** tab, the `singularityFlow.openChangeExplorer` command, and the focused `explainChangeAtCursor` / `explainFileChanges` menu commands (`apps/vscode/src/views/change-explorer*.ts`) |

## 2. Compatibility

| Form | Behavior |
|---|---|
| `explain <topic>` | Unchanged documentation service. An unknown `--subject` is refused, never sent to documentation search. |
| `explain code …` | Unchanged route, operation (`explain.code`), schema and skill (`/sf-explain-code`). |
| `explain code --narrate` | Unchanged. |
| `explain --subject S …` | New operation `explain.subject`. |
| `explain TOPIC --subject S` | Refused: a topic and a subject are never combined silently. |
| `explain --subject S --narrate` | Optional operation `explain.subject.narrate`; with models off it falls back to `explain.subject` and reports the narration unavailable (`model-disabled-fallback`). |
| `--length` or `--commentary` without `--narrate` | Refused (`XPL2_NARRATION_LENGTH_INVALID`, `XPL2_NARRATION_OPTION_INVALID`). |
| `explain --subject S --snapshot …` | Refused with `XPL2_SNAPSHOT_UNAVAILABLE`: a retained snapshot keeps only what a comparison needs and cannot be shown as a view; the refusal names `--compare`, and `--since REVISION` sets an explicit baseline. |
| `explain --subject change --compare previous|SNAPSHOT-ID` | The view plus `data.comparison` against a retained snapshot (§6). An unknown or ambiguous ID (`XPL2_SNAPSHOT_NOT_FOUND`, `XPL2_SNAPSHOT_AMBIGUOUS`), another subject (`XPL2_COMPARE_SUBJECT_INVALID`) or a malformed digest (`XPL2_SNAPSHOT_ID_INVALID`) is refused with `details.nextAction`; `previous` with nothing earlier reports the comparison unavailable. |

The subject view is `kind: "xpl2-explanation"` at schema version 1, marked transient: it is a
read projection and is never persisted as a record. Consumers must refuse an unknown kind or a
future version rather than guess (tested by `XPL2-AC-061`).

### Selectors

| Subject | Selector | Answers |
|---|---|---|
| `change` | none | Inventory, relationships, attention, and every source's state |
| `clause` | `--id NAMESPACE:ID` | Declarations (all of them, conflicts kept), the clauses its text names and those naming it, delivery requirement, region associations, `@clause` tags in changed code with the author's note, declared test tags |
| `test` | `--id` | Declared tags, exact-path presence in the change, recorded results with their scope, the criterion witness the verification owner judged, and recorded attempts (`--id TA-…`) |
| `line` | `--path P --line N [--side before\|after]` | The unit that contains the line, or `outside-change-set` / opaque; ordinary commit history at the exact baseline commit (an unchanged after-side line is mapped across the hunks above it); the recorded write that changed it last when observed writes explain the file exactly, otherwise `origin-unestablished` with the precise reason |
| `gap` | none | The owner's gap register when readable; otherwise the named unavailability |
| `generation` | `--phase P --gen N` | Recorded phase/generation history, and this machine's model invocations, prompt-log entries (and those its retention removed), observed writes and test attempts for that generation; the generation's authorship as a whole is `origin-unestablished` (ask a line) |

`--path` is repository-relative and portable: absolute paths, drive letters and `..` escapes are
refused; spaces, colons and non-ASCII names are accepted. `--for reviewer|auditor|developer`
chooses order and folding. `--max-bytes` bounds delivery (default 64 KiB, measured as the compact
UTF-8 JSON of the explanation after serialization; the shared `--json` envelope around it is
indented by the common emitter and is outside this bound). A bounded page sets
`delivery.complete: false`, names `bounded-delivery`, and keeps every total.

## 3. Source status inventory

| ID | Source | Owner | Status in this release |
|---|---|---|---|
| `SRC-MANIFEST` | Change-region manifest | `cmp.change-region-manifest` | Available, verified |
| `SRC-DIFF` | Bounded Git patch | `cmp.diff-preview` | Available when the preview projects; otherwise `OBS-DIFF` names why |
| `SRC-STRUCTURE` | Cached AST symbols | `ast.cached-symbols` | Navigation hints only when cached; `OBS-STRUCTURE` otherwise |
| `SRC-GRAPH` | Comprehension cause graph | `cmp.intent-graph` | Region-level associations only; `OBS-CAUSE` records absence |
| `SRC-BINDINGS-NN` / `OBS-BINDINGS-NN` | Implementation bindings of each code-delivery phase, with the delivered change set and the phase approval's decisions | `story.code-delivery` | Bindings checked against their recorded digest and the delivered change set against its own; a failure of either contributes nothing (at most 8 phases, 500 bindings each) |
| `SRC-DELIVERY` | Phase delivery record | `story.delivery-evidence` | Self-hashed; applicability `current` only for the same change set |
| `SRC-SPEC-NN` | Specification artifacts | `story.specification-artifact` | Bounded read (8 artifacts, 1 MiB each, 500 clauses); inaccessible reveals no content or digest. A citation of a clause another artifact declares is kept as a citation, never a parse failure |
| `SRC-TAGS` | `@clause` and `@ac` comments in the changed files | `xpl2.source-tags` | Verified against the capture's content digests; bounded (400 files, 1 MiB each, 2,000 tags); `OBS-TAGS` when no changed file can carry one |
| `SRC-STORY` | Story lifecycle state | `story.workflow-state` | Recorded, unverified |
| `SRC-REPLAY` | Normalized Story history | `cmp.story-replay` | Recorded order only; not a provenance timeline |
| `SRC-PROOF` | Shadow proof observation | `gdp.shadow-proof` | `gap` subject only, when the owner answers |
| `OBS-WEL`, `OBS-PE` | Witness insights, prompt/tool-trace capture | enrollment / none | Named state (`observe`, `off`, `not read by this release`) |
| `OBS-IMPACT`, `OBS-PROVENANCE`, `OBS-ADMISSION` | Impact, provenance for the whole change, admission | none | Named `adapter-unavailable` / `evaluation-unavailable`. The impact preview (change flight plans) is keyed by intent and baseline, not a change set, and the world-model blast projection is a draft, so neither is admitted as exact-subject impact. Provenance is asked line by line (`SRC-WRITES`) |
| `SRC-WRITES` / `OBS-WRITES` | Observed writes on this machine | `xpl2.observed-writes` | `--subject line` and `--subject generation` only; unverified local records (14 days, 1 MiB a day); dropped days, unreadable lines and the read bound mark coverage incomplete |
| `OBS-LINE` | Line locator | `xpl2.line-locator` | Subject-scoped |
| `SRC-RUN-NN` / `OBS-RUN-NN` | Test attempts the phase's delivery bound (submitted runs, or preflight runs before submission) | `verification.test-attempts` | Each record's digest checked against the delivery's binding; a tampered, unreadable or not-yet-admitted record contributes no fact |
| (witnesses) | Criterion witnesses | `verification.witness-results` | Judged by the verification owner's `witnessResult` against those attempts; cites `SRC-DELIVERY` and the run |
| `SRC-REUSE` | Evidence-reuse decisions | `story.evidence-reuse` | State from the owner's `evidenceReuseState`; the current source is observed only when a decision exists; the evaluation instant is not hashed |
| `SRC-LINE-HISTORY` / `OBS-LINE-HISTORY` | Commit history of the baseline for one line | `git.commit-history` | `--subject line` only: one `git blame --porcelain` at the exact baseline commit |
| `SRC-INVOCATIONS`, `SRC-PROMPTS`, `SRC-GENERATION-ATTEMPTS` | This machine's model invocation records, prompt log (with its removal notes) and test attempts | `model-runner.invocation-audit`, `prompt-audit`, `verification.test-attempts` | `--subject generation` only; never prompt text; `machine-local-only`, `recording-disabled`, `source-expired` and `outcome-unobserved` stay visible |

Every source carries integrity (`verified`, `self-hashed`, `unverified`, `failed`, `unavailable`),
origin, applicability (`current`, `stale`, `unknown`) and availability. A digest is never invented
for an unavailable or inaccessible source.

## 4. Catalogs

**Statement templates** (`xpl2.<kind>@1`): `change-inventory`, `singularity-files-hidden`, `hunk`,
`opaque-unit`, `file-type`, `mode-change`, `declaration-overlap`, `region-association`,
`cause-not-recorded`, `clause-declared`, `clause-cites`, `clause-required`, `clause-untagged`,
`clause-tag`, `acceptance-tag`, `test-tag`, `test-result`, `admission-unavailable`, `feature-state`,
`gap-observed`, `no-complete-evaluation`, `line-in-unit`, `line-outside`, `line-opaque`,
`generation-recorded`, `provenance-unavailable`, `source-state`, and for M3 `witness-result`,
`test-attempt`, `evidence-reuse`, `line-commit`, `line-changed`, `line-commit-unavailable`,
`generation-invocation`, `invocation-overlap`, `generation-prompt`, `capture-state`, `prompt-entries-removed`,
`prompt-log-cleared`, `line-writer`, `line-writer-unestablished`, `generation-write`, and for M4 `exact-cause`,
`binding-not-joined`, `binding-decision`, `line-binding`. Text arguments are
display-sanitized (controls, format and bidirectional characters removed and bounded); identities
are compared on untouched values.

**Reasons** (36): `subject-ambiguous`, `subject-unknown`, `subject-not-found`, `source-moved`,
`source-inaccessible`, `source-not-recorded`, `recording-disabled`, `source-expired`,
`snapshot-kind-mismatch`, `evaluation-unavailable`, `evaluation-incomplete`, `source-scope-mismatch`,
`region-only-association`, `origin-unestablished`, `narrative-semantic-support-unverified`,
`unsupported-source-version`, `partial-inventory`, `access-view-changed`,
`revalidation-unestablished`, `adapter-unavailable`, `feature-disabled`, `integrity-failed`,
`not-applicable`, `complete-empty`, `opaque-content`, `text-projection-unavailable`,
`untracked-content-excluded`, `no-active-story`, `outside-change-set`, `bounded-delivery`,
`owner-reported-failure`, `owner-reported-gap`, `conflicting-sources`, `navigation-hint-only`,
`machine-local-only`, `outcome-unobserved`.

**Relationships** — each states what it means and what it does not imply, and both appear in the
Change Explorer:

| Type | Granularity | Does not imply |
|---|---|---|
| `file-contains-unit` | exact unit | semantic ownership |
| `declaration-line-overlap` | navigation | body coverage, ownership or behavior |
| `region-associated-with-clause` | region only | that any individual hunk implements the clause |
| `source-tags-clause` | declared mapping | that the code implements or meets the clause; the tag is the author's declaration |
| `clause-cites-clause` | specification text | that either clause is met, or that work on one covers the other |
| `test-source-tags-clause` | declared mapping | that the test ran, passed or covers the changed code |
| `test-source-in-change` | exact path | that the test exercises the other changed files |
| `test-occurrence-in-run` | exact occurrence | that every test in the run passed, that the run was authenticated, or that the test covers the changed code |
| `binding-covers-unit` | exact interval | that the lines implement or meet the clause, or serve only this clause: every changed hunk of a planned path is bound, and a person decides |
| `decision-covers-binding` | owner decision | that the code meets the clause, or that any later revision is approved |
| `reuse-decision-cites-run` | owner decision | that the run happened on this change; a reused run is not a new execution |
| `observation-gap` | diagnostic | that the item has no reason or evidence elsewhere; a gap is not a failed test |

No test-to-clause-to-code join is ever inferred. Attention is ordered: reported failure (only when
an owner reported one), reason not recorded, worth inspecting, visibility limit.

**Clause links.** A changed file links to a clause through its own `@clause:NS:TYPE-NNN` comment,
read with the grammar delivery uses; the text after the ID on that line is the author's note on how
the code meets the clause, quoted as theirs. A changed test links to a criterion through its
`@ac:NS:AC-NNN` comment. Each tag says whether this change wrote its line (`added`, read from the
patch's own `+` lines, or any line of a new untracked file), left it alone (`unchanged`) or cannot
tell (`unknown`). A tag this change wrote is always shown; one already in the file is shown only for
a clause the Story's specification declares, so an old file's tags for other work stay out. A clause
links to another only through its specification text naming it; the change view shows the clauses
its tags and records name plus one citation step either way. A file or test whose change wrote a tag
(with a note, for `@clause`) is not reported as a change with no recorded reason.

## 5. Reading tour and narration (M2)

**Reading tour.** Every view's `presentation.tour` lists, in a fixed order, the statements for
*purpose* (clause text), *changes* (inventory and units), *links* (tags, region associations),
*checks* (recorded results), *attention* (every attention statement, then visibility limits),
*history* (generation records), and one safe *next* inspection action. Every attention statement
is always shown, whatever its kind; any other step shows at most twelve statements and counts the
rest, and statements of kinds no step lists are counted on the last step, so every statement is
shown or counted exactly once and stays in the view. It is presentation only:
the same for every audience and outside both hashes. The Change Explorer shows it under **Read this
change**, and **Copy summary** copies it.

**Structured narration** (`--narrate [--length brief|standard|long]`, 100/250/500 words):

- *Input.* Only the delivered statements' IDs, kinds, computed text, citations and limits, the
  attention list, counts and the closed connective list. Attention statements first, then the tour
  order, bounded to 160 statements; the number left out is reported. No source, patch, paths beyond
  what statements say, or tools.
- *Output.* `{"sections":[{"connective":"…","statements":["S-…"]}]}` with the connectives `start`,
  `changes`, `links`, `checks`, `attention`, `unknown`, `next`. Any other field is discarded as
  prose and counted; unknown connectives, IDs and duplicates are dropped and counted; a verdict or
  other top-level field, a non-JSON answer or an oversized answer makes the narration unavailable.
- *Display.* The computed text of each chosen ID under the connective's fixed heading, labelled
  `AI-organized summary — record-derived, advisory`. Attention statements the model left out are
  appended under *What needs attention (always shown)*, outside the word budget.
- *Commentary* (`--commentary`). Free text labelled `AI commentary — semantic support unverified`,
  always `semanticSupport: unverified` (valid IDs are citation syntax only). It is withheld, with
  each reason, for any URL, address, link, code, entity or Markdown structure, control or escape
  characters, secret-shaped text (also inside quotes or brackets), over-length text, no citation,
  or citations that are not statements of the view.
- *Boundary.* The call goes through the model runner with its usual audit and the existing prompt
  capture setting (never switched on here), under channel `xpl2-narration-advisory` with no tools.
  Any failure reports the narration unavailable with its code. The narration is never stored and
  never changes `data.explanation` or either hash. `--max-bytes` bounds the explanation and the
  narration together (`wire.explanationBytes`, `wire.narrationBytes`); a narration that would not fit
  is replaced by its notice (`bounded-delivery`).

## 6. Records, history and comparison (M3)

- **Tests.** A phase's bound attempts are read from the Story and each is checked against the digest
  its delivery bound. Every criterion witness is judged by the verification owner's own function, as
  the phase review does; the statement gives the result, how the witness is bound (by tag or to one
  exact declaration), the assurance reached and any shortfall, and always says it is a local run.
  An *exact occurrence* edge to the run is drawn only when the owner observed that test's own
  occurrence. A failed attempt or witness is a reported failure; a missing or inconclusive one is
  worth inspecting.
- **Applicability.** Only an evidence-reuse decision's own owner says whether earlier evidence
  applies. XPL2 computes no footprint, overlap or carry-forward: a changed source, an expired,
  revoked or superseded decision, an unobserved source or a record missing what its rule binds each
  read as not applying, with `revalidation-unestablished`. A reused run keeps its own step and attempt
  and is never shown as a run of the reusing step.
- **Line.** `--subject line` asks `git blame` once, at the exact commit the capture resolved (never
  the revision text, so it works outside a Story too): a before-side line
  directly, an unchanged after-side line mapped across the size change of the hunks above it, a
  context line inside a hunk through the patch. An added or changed line is not in the baseline's
  history, and no later commit is read. An after-side question about a deleted or renamed-away
  file says so and points to the before side or the new path. The commit's author
  is quoted as what the commit records, never as who produced the line; no share of model-written
  lines is estimated anywhere.
- **Observed writes.** No hook of their own: the pre-tool guard that already runs in an explicit SFlow
  Copilot turn *notes* each edit it allows before it runs (target paths, the SHA-256 of their bytes,
  salted hashes of their lines, and what the tool's own arguments say the bytes become: that digest
  and the lines it changes), and the session's next pre-tool call, or its next prompt or its end,
  *settles* the note by reading the files again. A file that has not changed yet stays noted. A
  record keeps, per file, the SHA-256 before and after and only the lines those two versions differ
  in; it is *verified* when the after bytes are exactly what the arguments say (`edit` and
  `str_replace` with an empty `new_str` included, `insert`, `replace_string_in_file`, VS Code's
  `multi_replace_string_in_file` `replacements[]`, `create`/`create_file`, `apply_patch`; LF arguments
  match a CRLF file). Otherwise its changed lines are kept unverified: they can never be credited,
  and they leave every other line traceable. A record also keeps the writer (turn, skill, hashed
  Copilot session, agent), the Story step and open generation, and the HEAD commit and branch it was
  made on; never content, arguments or commands (the line hashes live only in the note, which
  settling deletes). Records live in `<git dir>/singularity-flow/xpl2/observed-writes/` (one JSONL
  segment per UTC day, 1 MiB a day, 14 days; a full day leaves a marker created exclusively, never
  through a link), are discardable and are read only by explain commands. Measured added cost per
  pre-tool call: one `lstat` when nothing is noted; about 0.7 ms to note an edit of a 300-line file
  (3 ms at 3,000 lines) and 0.3 to 0.4 ms to settle it, plus about 2 ms to load the recorder in that
  hook process. No process is started.
- **Who left a line.** `--subject line` takes the change that holds the line: this capture for an
  added or changed after-side line (baseline bytes to the captured bytes, by the capture's own
  digest), otherwise the commit `git blame` named (paths unquoted; its parent's bytes to its own,
  read as a checkout writes them with `git cat-file --filters`, so line-end conversion and filters
  still match bytes read from disk). Only records made on a commit the line's history descends from
  take part (one ancestry check per recorded commit), so another branch's identical change is never
  credited. Starting from the bytes that hold the line, the writes that left exactly those bytes are
  found: the line is credited when it lies in a verified changed range of theirs; a line outside
  their changed ranges is followed back to the bytes before them, and so on. Recorded time order is
  never used; writes by different writers that left the same bytes are ambiguous. The statement
  names the write(s), the tool, the turn and session, and the Story step; it is this machine's record
  of what a tool did, not of who designed the line. Otherwise the view keeps `origin-unestablished`
  and states the basis: no recorded write on this history, bytes no recorded write left, an
  unrecorded change in between, an unverified write, several writers or histories, the line
  unchanged by the writes, or unreadable records. Identical bytes re-created by an unrecorded writer
  (a revert and a hand re-apply) cannot be told apart from the recorded write.
- **Sources that do not record writes.** Terminal commands: the guard sees their changes only
  against a baseline shared across tool calls, so a command's change cannot be told from an edit or
  a person in the same window. Kernel model invocations: their records keep a content-free tool
  observation (name, kind, operation, status, output size) and no target or digest; the ACP client
  sees each mutating call's targets, but recording its writes needs the provider's raw tool input,
  whose shape this release has not verified against a live run. Phase publication: a generation's
  delivered change set and sidecars carry paths and content digests, but their producer is the
  authorship declared at publication, not a write anyone observed; the kernel's own writes (Story
  state, context records, sidecars) are Singularity Flow files, which change views do not show. Each stays a named unavailability.
- **Generation.** `--subject generation` lists this machine's model invocations for that exact
  Story, phase and generation, in their own recorded start order, with overlaps named and never
  ordered; requested and provider-reported models are separate, and a missing outcome or tool
  observation is said, never counted as zero. Prompt-log entries say whether they were prepared,
  handed to the Copilot host or sent through the runner, and how many secret-shaped values were
  redacted; the prompt text never enters the view. The prompt log now writes a text-free removal note
  (identity, Story, step, generation, why, when) for every entry its retention window or size limit
  removes, bounded to the newest 2,000, and a clear leaves a single cleared note; the view states
  how many entries of the generation were removed and when the log was cleared. The generation's
  observed writes are listed with their writer and files. An unreadable store, a listing cut at its bound
  and records missing their identity are each reported, never read as none. Reading enables no
  capture.
- **Retained snapshots.** The Comprehension Center's change view (the Change Explorer) and
  `explain --subject change` keep their view on this machine, and say so (the explain headline: kept
  this view for a later --compare); it is retained in `<git dir>/singularity-flow/xpl2/snapshots/` under its
  explanation-set digest: its comparison projection only (unit IDs, paths, unit and unit-content
  digests, source and observation states, the statement count). At most 64 snapshots, 512 KiB each
  and 8 MiB in all, each kept until 14 days unseen; an entry whose content does not match its name is
  not read. Each view reports its own snapshot ID (`data.snapshot`).
- **CLI comparison.** `explain --subject change --compare previous|SNAPSHOT-ID` (a digest or a prefix of
  at least 12 hex digits) compares the current view with a retained snapshot using the explorer's own
  comparison (`compare.mjs`) over the whole change view, never a bounded page; a view that holds only
  part of the change is not compared unit by unit. `previous` is the most recently seen other
  snapshot of the same Story.
  The result (`data.comparison`) and the terminal say how many change units are new, gone and
  unchanged, which files they are in and which sources changed, and never change the view.
- **Comparison.** When a newer snapshot raises *Snapshot changed*, the banner counts the change units
  that are new, gone and unchanged, compared unit by unit by the change each holds
  (`unitContentSha256`: its own hunk text with its paths, independent of position; the file change
  and ranges when the patch was not projected), and names the sources and files that changed. A
  view from before units carried this says it cannot be compared unit by unit;
  it names files rather than the newer view's display IDs, which are numbered afresh. A unit digest
  stays bound to its snapshot, so no link from one view opens a unit of the other.

## 7. Exact links (M4)

- **Producer.** The only exact, owner-verified link between a clause and changed lines is the
  implementation binding a code-delivery phase records [E2G-011]: each clause bound to the delivered
  hunks (zero-context, exact line intervals) of its planned paths, with the author's explanation, and
  the phase approval's decision about that exact binding set. The CMP cause graph remains
  region-level, and the revision hunk-claim set has no producer that writes claims, so neither is
  read as exact.
- **Join.** A binding joins a captured unit only when the capture holds the very file change the
  receipt delivered: same status, paths, modes, before object and after content, compared field by
  field (never by display ID, change-set digest or capture subject); a submodule pointer or other
  entry with no content digest must also have the same after object. Each delivered interval lies in
  exactly one captured unit, because both describe the same bytes; an insertion point counts as
  inside a unit when it falls between its lines. A whole added file binds as one interval of its
  real line count (receipts recorded before that count was corrected still join as the whole file). A binding with no hunks stays a region association.
- **Stale and missing.** A bound file whose bytes differ now is reported *not joined* with
  `source-scope-mismatch` (worth a reader's attention), a bound file not in the capture with
  `outside-change-set`; staleness is per file change, never global.
- **Counts.** Several bindings may name one unit; it is counted once in `causeBoundUnits`, and
  `exactLinks` counts the links. A bound unit is no longer reported as having no recorded reason.
- **Delivery applicability.** When the Story kept the delivered change set, the delivery record is
  `current` exactly when the capture holds the delivered application file changes with the same
  content, so a later commit of the same bytes no longer reads as stale.
- **Explorer.** An exact link is drawn from the clause to the unit's file card, as a solid heavy line
  labelled *exact lines* and the unit; the file's card, pane and the Relationships table name the
  unit itself. Relationships that join the same two cards (a tag and a binding) each get their own
  lane and label row, so neither hides the other.

## 8. Change Explorer (VS Code)

- **Layout.** Inventory rail (search, counts, attention), a map of *Intent → Changed code →
  Recorded results* with an *Also changed* group, a Relationships table and a Timeline, the selected
  change as a side-by-side preview, and a *Why this is shown* inspector with sources and limits.
- **Bounds.** At most twelve nodes per column and four *also changed* files are shown first (forty
  in total); the rest are labelled clusters that stay in the page, the inventory and the table.
  At most eighty edges are drawn at once, the selection's first, with a note when more exist.
- **Pinning.** The view is pinned to the slice it was built from. A newer snapshot only raises
  *Snapshot changed*; the reader moves by refreshing, or by asking about a file from a menu, which
  is an explicit question about the file as it is now. Hidden panels release the pin, the lease
  and in-flight exact reads (`retainContextWhenHidden: false`).
- **Menus.** A *Singularity Flow* submenu on the editor and Explorer context menus, the editor
  title, Source Control (title and changed files) and the Navigator title and Work section, all
  shown only while a governed repository is selected (`singularityFlow.repositoryActive`).
  *Explain This Change* resolves the cursor line on the after side by the rule of
  `--subject line` (a text unit covers a line inside its after range, an opaque unit covers its
  file) and selects that unit once; *Explain Changes in This File* selects the file. A line or
  file outside the change set selects nothing more specific and says so in a note about the
  request, never about the change.
- **Messages.** Four closed actions (`explorer-open-diff`, `explorer-open-file`, `explorer-copy`,
  `explorer-audience`). Each carries the explanation-set digest, the exact unit digest, the page's
  render session and an increasing request number; the host resolves them against the pinned view
  and refuses anything else visibly. No path, command or URI from the page is ever used.
- **Native diff.** Both sides are read through `comprehension source`, page by bounded page, each
  page checked against the reference, offset and whole-content digest, then served read-only from
  memory under the private `singularity-flow-explained` scheme. If the working file moved, the
  source owner refuses (`CMP_SOURCE_REFERENCE_STALE`) and nothing is substituted. *Open working
  file* is a separate, labelled action and refuses links that resolve outside the repository.
- **Inert rendering.** Everything is escaped; control, format and bidirectional characters are
  shown as `[U+XXXX]` markers; SVG is drawn with `createElementNS` and `textContent`; the page runs
  under a nonce CSP with `default-src 'none'`. Colours come only from theme variables, with narrow
  layouts and reduced motion supported.

## 9. Measured performance (local, not qualified)

Measured on the development machine with the source CLI, cold process per call:

| Query | Files / units | Subprocesses | Wall time | Explanation bytes |
|---|---|---|---|---|
| `explain --subject change` | 5 / 10 | 27 | 0.38 s | 31,890 |
| `explain --subject change` | 14 / 28 | 27 | 0.37 s | 73,412 (bounded to 64 KiB by default) |
| `explain --subject change` | 40 / 80 | 27 | 0.44 s | 193,506 (bounded) |
| `explain --subject line` | 40 / 80 | 27 | 0.44 s | 14,880 |
| `explain code` (baseline) | any | 32 | 0.41–0.48 s | — |

`--subject line` reads Git once more (one batch for at most two blobs) only when an observed-write
record names the line's path; with none it spawns nothing extra.

Subprocess counts are flat in the number of files (no per-file or per-unit work) and are asserted by
`XPL2-AC-060`. They come from the existing capture primitives; the proposed warm target of three Git
spawns needs a warm retained capture, which this release does not have (V13: no safe read is
omitted to meet a spawn count). Installed-host p50/p95 qualification (`XPL2-AC-013`, `-064`) remains
open.

## 10. Known limits

- A path the diff preview cannot project (for example one Git must quote) leaves every unit opaque
  for that capture. XPL2 says so with `text-projection-unavailable` rather than calling a text file
  non-text; the limit is inherited from the preview owner.
- Retained snapshots keep no file bytes, so an exact diff can still be opened only while the capture
  is current. An already-open diff keeps its captured bytes.
- WEL contents are never read; the WEL state is reported only. Of PE, only content-free metadata is
  read (model invocation records and prompt-log entries without their text), and only for
  `--subject generation`.
- Observed writes come only from explicit SFlow Copilot turns' file edits on this machine. The
  bytes after an edit are read at the session's next hook call, so a change by someone else in
  between is part of what is observed; such lines are kept unverified and never credited. An edit
  left unsaved in an editor buffer is seen as no change. Native chat, terminal commands, kernel model
  invocations and other machines are not observed (§6).
- Prompt-log entries removed before removal notes existed, or past the newest 2,000 notes, still
  cannot be told from entries never kept; the view states the retention window and marks the notes
  partial at their bound.
- `--snapshot` is refused: a retained snapshot is a comparison projection, not a view.

## 11. Acceptance traceability

State: **tested** (witness passes in this repository), **partial** (the part named is tested; the
rest is open), **open** (not implemented in this release).

| AC | Title | State | Witness / reason |
|---|---|---|---|
| 001 | Citation and diagnostic integrity | tested | `test/xpl2-engine.test.mjs` |
| 002 | Complete unit accounting | tested | `test/xpl2-engine.test.mjs` |
| 003 | Unavailable gap set is not mergeable | tested | `test/xpl2-engine.test.mjs` |
| 004 | Assurance and disposition stay separate | tested | `test/xpl2-engine.test.mjs` |
| 005 | Audience parity | tested | `test/xpl2-engine.test.mjs` |
| 006 | Semantic determinism | tested | `test/xpl2-engine.test.mjs` |
| 007 | Corrupt source isolation | tested | `test/xpl2-engine.test.mjs` |
| 008 | No lexical entailment shortcut | tested | `test/xpl2-narration.test.mjs` (60 adversarial cases) |
| 009 | Narration cannot mutate results | tested | `test/xpl2-narration.test.mjs` (no PR integration exists; the copied summary is the computed tour) |
| 010 | Explicit model and capture choice | tested | `test/xpl2-narration.test.mjs` (local stand-in provider through the real runner; no provider is called) |
| 011 | Line origin not inferred | tested | `test/xpl2-provenance.test.mjs` (invocation records never name a writer), `test/xpl2-observed-writes.test.mjs` (through the real pre-tool guard: a line is credited only for lines a checked write changed, line by line across two turns and through `git blame`; a person's line kept by a rewrite, unchecked lines, another branch's identical change and two writers of the same bytes stay unestablished with their basis; CRLF and non-ASCII paths) |
| 012 | Disjoint footprint is insufficient | tested | `test/xpl2-applicability.test.mjs` (the reuse owner's rule; XPL2 computes no overlap) |
| 013 | Reference performance qualification | open | Local measurements in §6; installed-host qualification open |
| 014 | Impact producer readiness | tested | Named unavailability (`test/xpl2-engine.test.mjs`, `test/xpl2-exact-links.test.mjs`); no producer keyed to an exact change set exists |
| 015 | Shared snapshot and safe PR update | open | PR integration not in this release |
| 016 | Existing routes remain working | tested | `test/xpl2-routing.test.mjs` |
| 017 | Six explicit subjects | tested | `test/xpl2-routing.test.mjs` |
| 018 | Portable path selection | tested | `test/xpl2-routing.test.mjs` |
| 019 | Observation is not Candidate | tested | `test/xpl2-engine.test.mjs` |
| 020 | Code and evidence cannot race | tested | `test/xpl2-identity.test.mjs` |
| 021 | Late view result discarded | partial | Diff reads abort on hide/refresh and late results are dropped; no dedicated witness |
| 022 | Paged source remains pinned | tested | `test/vscode-xpl2-ui.test.mjs` |
| 023 | Partial inventory is explicit | tested | `test/xpl2-engine.test.mjs` |
| 024 | Clustering preserves counts | tested | `test/vscode-xpl2-graph.test.mjs` |
| 025 | Historical native diff | partial | Captured bytes kept and live bytes never substituted (`test/xpl2-diff.test.mjs`); retained snapshots (`test/xpl2-snapshots.test.mjs`) keep no file bytes, so reopening after a move is still open |
| 026 | UTF offsets and deletion side | tested | `test/xpl2-diff.test.mjs` |
| 027 | Opaque resource rendering | tested | `test/xpl2-diff.test.mjs` |
| 028 | Hash does not authenticate author | tested | `test/xpl2-engine.test.mjs` |
| 029 | Absolute times remain canonical | tested | `test/xpl2-engine.test.mjs` |
| 030 | Hidden records do not leak | tested | `test/xpl2-engine.test.mjs` |
| 031 | Conflicting admitted sources | tested | `test/xpl2-engine.test.mjs` |
| 032 | Region is not hunk cause | tested | `test/xpl2-engine.test.mjs`, `test/xpl2-exact-links.test.mjs` (with exact bindings beside it) |
| 033 | Test association is not cause or coverage | tested | `test/xpl2-relations.test.mjs` |
| 034 | Multiple exact causes | tested | `test/xpl2-exact-links.test.mjs`, real Story in `test/xpl2-exact-links-story.test.mjs` |
| 035 | Unit identity cannot be reused | tested | `test/xpl2-exact-links.test.mjs` (same display IDs, other bytes: not joined), `test/xpl2-provenance.test.mjs` (comparison), `test/xpl2-snapshots.test.mjs` (CLI comparison equals the explorer's, by unit content) |
| 036 | Existing unchanged test can be inspected | tested | `test/xpl2-engine.test.mjs` |
| 037 | Suite and witness limits displayed | tested | `test/xpl2-engine.test.mjs` |
| 038 | Action prerequisites retained | tested | `test/xpl2-engine.test.mjs` |
| 039 | Reuse is not a new execution | tested | `test/xpl2-applicability.test.mjs` |
| 040 | Unknown dependency coverage | tested | `test/xpl2-applicability.test.mjs` |
| 041 | No AI line-share fabrication | tested | `test/xpl2-provenance.test.mjs` (no feature telemetry is emitted); observed writes name one line's writer, never a share |
| 042 | Parallel and reordered events | tested | `test/xpl2-provenance.test.mjs`; `test/xpl2-observed-writes.test.mjs` (writes are chained by digest, never by recorded time) |
| 043 | Capture boundary and privacy | tested | Prepared, handed-off, redacted, capture-off and machine-local states, no capture enablement, an entry the retention window removed named from the log's removal note, and a clear stated (`test/xpl2-provenance.test.mjs`); observed-write records hold no content (`test/xpl2-observed-writes.test.mjs`). Removals before notes existed stay indistinguishable (§10) |
| 044 | Missing events are not zero actions | tested | `test/xpl2-provenance.test.mjs` |
| 045 | Read has no mutation | tested | `test/xpl2-routing.test.mjs` |
| 046 | Unsafe prose can be withheld | tested | `test/xpl2-narration.test.mjs` |
| 047 | Computed-only input and bounded output | tested | `test/xpl2-narration.test.mjs` |
| 048 | Click routes, not executes | tested | `test/vscode-xpl2-ui.test.mjs` |
| 049 | Linked selection | tested | `test/vscode-xpl2-graph.test.mjs` |
| 050 | First release without WEL and PE | tested | `test/vscode-xpl2-graph.test.mjs` |
| 051 | Full-fidelity table and keyboard | tested | `test/vscode-xpl2-accessibility.test.mjs` |
| 052 | Themes and narrow layouts | tested | `test/vscode-xpl2-accessibility.test.mjs` (theme-variable and layout rules; visual check in the running editor) |
| 053 | Forged messages and source escape | tested | `test/xpl2-security.test.mjs` |
| 054 | Inert source and strict assets | tested | `test/xpl2-security.test.mjs`, terminal: `test/xpl2-routing.test.mjs` |
| 055 | Multi-root and linked-worktree isolation | partial | Cross-repository handles never resolve (`test/xpl2-security.test.mjs`); linked worktrees not yet exercised |
| 056 | Restricted and remote hosts | open | Needs installed-host qualification |
| 057 | Hide/dispose releases content | partial | Release clears the pin, lease and reads; listener/timer growth not yet measured |
| 058 | Audience is not authorization | tested | `test/xpl2-security.test.mjs` |
| 059 | Export privacy and races | open | Export not in this release |
| 060 | No N+1 or hover work | tested | `test/xpl2-performance.test.mjs` |
| 061 | Old and future schema handling | tested | `test/xpl2-engine.test.mjs` |
| 062 | Normal lifecycle unaffected | partial | View failures are isolated in the slice; the full suite is the regression witness |
| 063 | Content-free feature measurements | open | No feature telemetry is emitted |
| 064 | Installed feature qualification | open | Needs installed-host runs |
