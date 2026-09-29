# Explain for humans (`XPL2`) — decision record and implementation status

**Implemented boundary (this release):** M0 (decision, compatibility, transient schema), M1
(`explain --subject` for all six subjects at their actual source availability) and the early M5
graphical release (the VS Code **Change Explorer**: map, inventory, inspector, exact native diff).
Nothing here approves, verifies, publishes or gates. Every view is read-only, model-free and
grants no authority.

**Not in this release:** subject narration (M2), line provenance and proof carry-forward (M3), exact
hunk-level cause producers (M4), PR rendering and export, retained historical snapshots, and
installed-host qualification. Each is reported as a named unavailability, never approximated.

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
| Engine | `src/comprehension/xpl2/` — `reasons`, `templates`, `vocabulary`, `model`, `change-subject`, `subjects`, `clause-sources`, `command` |
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
| `explain --subject S --narrate` | Refused with `XPL2_NARRATION_UNAVAILABLE`; narration remains on `explain code`. |
| `explain --subject S --snapshot …` | Refused with `XPL2_SNAPSHOT_UNAVAILABLE`; use `--since REVISION` for an explicit baseline. |

The subject view is `kind: "xpl2-explanation"` at schema version 1, marked transient: it is a
read projection and is never persisted as a record. Consumers must refuse an unknown kind or a
future version rather than guess (tested by `XPL2-AC-061`).

### Selectors

| Subject | Selector | Answers |
|---|---|---|
| `change` | none | Inventory, relationships, attention, and every source's state |
| `clause` | `--id NAMESPACE:ID` | Declarations (all of them, conflicts kept), delivery requirement, region associations, declared tags |
| `test` | `--id` | Declared tags, exact-path presence in the change, recorded results with their scope |
| `line` | `--path P --line N [--side before\|after]` | The unit that contains the line, or `outside-change-set` / opaque |
| `gap` | none | The owner's gap register when readable; otherwise the named unavailability |
| `generation` | `--phase P --gen N` | Recorded phase/generation history; provenance is named unavailable |

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
| `SRC-DELIVERY` | Phase delivery record | `story.delivery-evidence` | Self-hashed; applicability `current` only for the same change set |
| `SRC-SPEC-NN` | Specification artifacts | `story.specification-artifact` | Bounded read (8 artifacts, 1 MiB each, 500 clauses); inaccessible reveals no content or digest |
| `SRC-STORY` | Story lifecycle state | `story.workflow-state` | Recorded, unverified |
| `SRC-REPLAY` | Normalized Story history | `cmp.story-replay` | Recorded order only; not a provenance timeline |
| `SRC-PROOF` | Shadow proof observation | `gdp.shadow-proof` | `gap` subject only, when the owner answers |
| `OBS-WEL`, `OBS-PE` | Witness insights, prompt/tool-trace capture | enrollment / none | Named state (`observe`, `off`, `not read by this release`) |
| `OBS-IMPACT`, `OBS-PROVENANCE`, `OBS-ADMISSION` | Impact, provenance, admission | none | Named `adapter-unavailable` / `evaluation-unavailable` |
| `OBS-LINE` | Line locator | `xpl2.line-locator` | Subject-scoped |

Every source carries integrity (`verified`, `self-hashed`, `unverified`, `failed`, `unavailable`),
origin, applicability (`current`, `stale`, `unknown`) and availability. A digest is never invented
for an unavailable or inaccessible source.

## 4. Catalogs

**Statement templates** (`xpl2.<kind>@1`): `change-inventory`, `hunk`, `opaque-unit`, `file-type`,
`mode-change`, `declaration-overlap`, `region-association`, `cause-not-recorded`, `clause-declared`,
`clause-required`, `clause-untagged`, `test-tag`, `test-result`, `admission-unavailable`,
`feature-state`, `gap-observed`, `no-complete-evaluation`, `line-in-unit`, `line-outside`,
`line-opaque`, `generation-recorded`, `provenance-unavailable`, `source-state`. Text arguments are
display-sanitized (controls, format and bidirectional characters removed and bounded); identities
are compared on untouched values.

**Reasons** (34): `subject-ambiguous`, `subject-unknown`, `subject-not-found`, `source-moved`,
`source-inaccessible`, `source-not-recorded`, `recording-disabled`, `source-expired`,
`snapshot-kind-mismatch`, `evaluation-unavailable`, `evaluation-incomplete`, `source-scope-mismatch`,
`region-only-association`, `origin-unestablished`, `narrative-semantic-support-unverified`,
`unsupported-source-version`, `partial-inventory`, `access-view-changed`,
`revalidation-unestablished`, `adapter-unavailable`, `feature-disabled`, `integrity-failed`,
`not-applicable`, `complete-empty`, `opaque-content`, `text-projection-unavailable`,
`untracked-content-excluded`, `no-active-story`, `outside-change-set`, `bounded-delivery`,
`owner-reported-failure`, `owner-reported-gap`, `conflicting-sources`, `navigation-hint-only`.

**Relationships** — each states what it means and what it does not imply, and both appear in the
Change Explorer:

| Type | Granularity | Does not imply |
|---|---|---|
| `file-contains-unit` | exact unit | semantic ownership |
| `declaration-line-overlap` | navigation | body coverage, ownership or behavior |
| `region-associated-with-clause` | region only | that any individual hunk implements the clause |
| `test-source-tags-clause` | declared mapping | that the test ran, passed or covers the changed code |
| `test-source-in-change` | exact path | that the test exercises the other changed files |
| `observation-gap` | diagnostic | that the item has no reason or evidence elsewhere; a gap is not a failed test |

No test-to-clause-to-code join is ever inferred. Attention is ordered: reported failure (only when
an owner reported one), reason not recorded, worth inspecting, visibility limit.

## 5. Change Explorer (VS Code)

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

## 6. Measured performance (local, not qualified)

Measured on the development machine with the source CLI, cold process per call:

| Query | Files / units | Subprocesses | Wall time | Explanation bytes |
|---|---|---|---|---|
| `explain --subject change` | 5 / 10 | 27 | 0.38 s | 31,890 |
| `explain --subject change` | 14 / 28 | 27 | 0.37 s | 73,412 (bounded to 64 KiB by default) |
| `explain --subject change` | 40 / 80 | 27 | 0.44 s | 193,506 (bounded) |
| `explain --subject line` | 40 / 80 | 27 | 0.44 s | 14,880 |
| `explain code` (baseline) | any | 32 | 0.41–0.48 s | — |

Subprocess counts are flat in the number of files (no per-file or per-unit work) and are asserted by
`XPL2-AC-060`. They come from the existing capture primitives; the proposed warm target of three Git
spawns needs a warm retained capture, which this release does not have (V13: no safe read is
omitted to meet a spawn count). Installed-host p50/p95 qualification (`XPL2-AC-013`, `-064`) remains
open.

## 7. Known limits

- A path the diff preview cannot project (for example one Git must quote) leaves every unit opaque
  for that capture. XPL2 says so with `text-projection-unavailable` rather than calling a text file
  non-text; the limit is inherited from the preview owner.
- Retained historical snapshots do not exist yet, so an exact diff can be opened only while the
  capture is current. An already-open diff keeps its captured bytes.
- WEL and PE contents are never read by this release; their state is reported only.

## 8. Acceptance traceability

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
| 008 | No lexical entailment shortcut | open | M2 narration is not offered for subjects |
| 009 | Narration cannot mutate results | open | M2 |
| 010 | Explicit model and capture choice | open | M2 |
| 011 | Line origin not inferred | partial | Provenance named unavailable (`test/xpl2-routing.test.mjs`); M3 producer open |
| 012 | Disjoint footprint is insufficient | open | M3 |
| 013 | Reference performance qualification | open | Local measurements in §6; installed-host qualification open |
| 014 | Impact producer readiness | tested | Named unavailability (`test/xpl2-engine.test.mjs`) |
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
| 025 | Historical native diff | partial | Captured bytes kept and live bytes never substituted (`test/xpl2-diff.test.mjs`); reopening after a move needs retained snapshots |
| 026 | UTF offsets and deletion side | tested | `test/xpl2-diff.test.mjs` |
| 027 | Opaque resource rendering | tested | `test/xpl2-diff.test.mjs` |
| 028 | Hash does not authenticate author | tested | `test/xpl2-engine.test.mjs` |
| 029 | Absolute times remain canonical | tested | `test/xpl2-engine.test.mjs` |
| 030 | Hidden records do not leak | tested | `test/xpl2-engine.test.mjs` |
| 031 | Conflicting admitted sources | tested | `test/xpl2-engine.test.mjs` |
| 032 | Region is not hunk cause | tested | `test/xpl2-engine.test.mjs` |
| 033 | Test association is not cause or coverage | tested | `test/xpl2-relations.test.mjs` |
| 034 | Multiple exact causes | open | M4 exact cause producer |
| 035 | Unit identity cannot be reused | open | M4 |
| 036 | Existing unchanged test can be inspected | tested | `test/xpl2-engine.test.mjs` |
| 037 | Suite and witness limits displayed | tested | `test/xpl2-engine.test.mjs` |
| 038 | Action prerequisites retained | tested | `test/xpl2-engine.test.mjs` |
| 039–044 | Reuse, dependency coverage, line share, event order, capture privacy, missing events | open | M3 producers |
| 045 | Read has no mutation | tested | `test/xpl2-routing.test.mjs` |
| 046, 047 | Unsafe prose, computed-only narration input | open | M2 |
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
