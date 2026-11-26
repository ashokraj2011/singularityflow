# SSB M1 plan: one resolver for a Story's paths

**Spec:** [SSB-v1](../SPEC-SSB-STORY-STATE-BRANCH-v1.md), REQ-009 and milestone M1.

**Baseline:** `5ac41f37e` (2026-11-26).

**Status:** Built on `ssb-m1` (from `480c2f936`): B0 to B12, with the touched-area tests (721 files) and the guard tests green on Node 22. Not merged. What changed from this plan while building is in §9.

**Size:** 6 days. The spec's first estimate was 4 days. It counted only the `workDir(` and `workDirRelative(` calls.

---

## 1. What M1 does

- One resolver turns a Story's ID into every path SFlow uses for it:
  - a file on disk;
  - the path a record stores;
  - a Git object to read;
  - the scope that stages the Story's records.
- Every call site in `src/`, the VS Code extension and the plugin moves to it. After M1, nothing else joins a Story's
  paths (REQ-009).
- Today's layout behaves the same, byte for byte, and its tests pass unchanged. No test file is edited. Two test files
  are added (§7).
- The resolver also has its `state-ref` arm, written and unit-tested as path arithmetic only. No Story reaches it in M1,
  because nothing creates a state ref until M2.

M1 does not:
- create the state ref or its checkout (M2);
- change publication (M3);
- move documents (M4);
- add or validate `story.storage` in `sflow/config` (M5);
- touch Epic paths (M6). Their 23 spellings are listed in the appendix for M6.

## 2. What it replaces

A Story's folder is spelled in twelve ways today. Counts are on `5ac41f37e`, in `src/`, `apps/vscode/src` and
`plugin/`:

| Key | Spelling | Count |
|---|---|---|
| W | `workDir(root, config, id)` calls | 177 |
| R | `workDirRelative(config, id)` calls | 135 |
| P | `workflowPath(` calls | 7 |
| C | `clarificationRecordRelative(` calls | 6 |
| I | inline `config.workItemRoot ?? 'singularity/work-items'` joins | 164 in 110 files |
| B | joins on a bare `.workItemRoot` | 16 |
| X | path patterns that spell `singularity\/work-items` | 98, 93 of them in `schema-migrations.mjs` |
| H | uses of `work-item-location.mjs`: `workItemWorkflowRelative`, `DEFAULT_WORK_ITEM_ROOT` | 26 |
| L | other `singularity/work-items` literals: one-off joins, help text, comments | 40 |
| S | `'work-items'` as a path segment | 9 |
| F | `configuration-source.json` and `CONFIGURATION_SOURCE_PATH` | 47 |
| E | Epic paths: `singularity/initiatives`, `initiativeRoot ?? …` | 23 (M6) |

The spec's §7 counts every `workDir(` text, 180. Of those, 177 are calls of the helper.

The inline joins choose the Stories folder in four orders. M1 keeps each one exactly:

| Order | Sites |
|---|---|
| The definition's `workItemRoot`, else the default | about 150 |
| The Story's pinned `workflow.resolution.workItemRoot`, else the default | 15 |
| The pinned value, then the definition's, then the default | 7 |
| The definition's, then the pinned value, then the default | 2 |

The definition a Story's checkout loads is its pinned copy, so the four agree on every real Story. They differ only for a
definition read from somewhere else, such as `sflow/config` after `workItemRoot` changed. M2 settles one order with a
test: the pinned value first.

## 3. The resolver

It goes in `src/story-paths.mjs`, the module that already holds `workDir` and `workDirRelative`:
- 86 modules import it already, so it is in every bundle closure that joins a Story's path;
- adding to it adds no module. So no VS Code runtime crosses its module ceiling
  (`benchmarks/dx/vscode-bundle-budgets.json`), and no cold-bundle family needs a new claim.

It stays a leaf. It imports `node:path` and `util.mjs` only. Today it also imports `phase-generation.mjs`, for
`clarificationRecordRelative`'s default generation. B0 moves `clarificationRecordRelative` into `phase-generation.mjs`,
beside its twin `groundingRecordRelative`, and points its two importers there (`clarifications.mjs`,
`source-review-lifecycle.mjs`). Then `phase-generation.mjs` can use the resolver without an import cycle.

```js
// src/story-paths.mjs: the one place that joins a Story's paths [SSB:REQ-009]

export const DEFAULT_WORK_ITEM_ROOT = 'singularity/work-items';  // work-item-location.mjs re-exports it
export const STORY_LAYOUTS = Object.freeze(['story-branch', 'state-ref']);
export const STATE_CHECKOUT = '.sflow-state';    // REQ-006, owner 2026-11-26: spec §11.2, item 4
export const STORY_DOCUMENTS = 'docs/stories';   // REQ-001, owner 2026-11-26
export const STATE_REF_PREFIX = 'refs/singularity/state/';

/**
 * The Stories folder: the first source, in the caller's order, that names one; else the default.
 * A workflow (it has `workItem`) gives its pinned `resolution.workItemRoot`; a definition gives
 * its `workItemRoot`.
 */
export function storiesRoot(...sources) {}

/**
 * One Story's paths. Pure: no file or Git read.
 * root: the code checkout, or null when the caller needs only the spellings a record stores.
 * sources: a definition, a workflow, or an array of them in precedence order, as storiesRoot.
 * layout: given by Story start and by tests; otherwise read from the workflow (§4).
 */
export function storyLocation(root, sources, id, { layout } = {}) {}

class StoryLocation {
  layout;                // 'story-branch' | 'state-ref'
  id;
  directory;             // the Story's state folder on disk
  file(...parts) {}      // a state file on disk
  record(...parts) {}    // how a record names that state file
  fromRecord(path) {}    // the state file a record names, on disk, read as written
  inside(path) {}        // a recorded path relative to the Story's state; null if not this Story's
  prefix;                // story-branch: '<storiesRoot>/<ID>'; state-ref: null
  owns(path) {}          // whether a code-checkout path is one of this Story's records
  document(artifact) {}  // a step's document: { relative, absolute }
  isDocument(path) {}
  workflowFile;          // file('workflow.json')
  configurationSource;   // { relative, absolute }
  configurationRoot;     // where the pinned copy's usual paths resolve
  codeTreeExclusion;     // the root a code-tree digest leaves out
  object(...parts) {}    // { revision, path } for a Git object read; revision null: the caller's commit
  commitScope;           // { cwd, pathspecs }: what stages this Story's records
}

export function stateRefName(id, { pinTransport = 'refs' } = {}) {}  // or refs/heads/sflow/state/<ID>
export function storiesDirectory(root, ...sources) {}  // the folder of every story-branch Story in a checkout
export function storyIdOfRecord(path, ...sources) {}   // the Story a story-branch record path belongs to, or null
export function isStoryRecordPath(path, ...sources) {} // whether a path is any Story's record (story-branch)

// Kept for the 12 test files that import them. After M1 no src module calls them (the ratchet, §7).
export function workDir(root, config, id) {}           // storyLocation(root, config, id).directory
export function workDirRelative(config, id) {}         // storyLocation(null, config, id).prefix
export function workflowPath(root, config, id) {}      // storyLocation(root, config, id).workflowFile
```

What each member gives, for Story `W-1`, checkout `/r` and the default Stories folder:

| Member | `story-branch` (today, unchanged) | `state-ref` (used from M2) |
|---|---|---|
| `directory` | `/r/singularity/work-items/W-1` | `/r/.sflow-state` |
| `record('evidence', 'a.json')` | `singularity/work-items/W-1/evidence/a.json` | `evidence/a.json` |
| `fromRecord(p)` | `/r/<p>` | `/r/.sflow-state/<p>` |
| `inside('singularity/work-items/W-1/gdp/x.json')` | `gdp/x.json` | not asked: its records are already state-relative |
| `prefix` | `singularity/work-items/W-1` | null |
| `owns(p)` | `p` is under the prefix | always false: no state file is in the code checkout |
| `document('artifacts/design/design.md')` | `singularity/work-items/W-1/artifacts/design/design.md` | `docs/stories/W-1/design/design.md`. M4 may flatten it to `design.md` (REQ-001) |
| `isDocument(p)` | under `<prefix>/artifacts/` | under `docs/stories/W-1/` |
| `configurationSource` | `singularity/configuration-source.json` in `/r` | `configuration-source.json` in `/r/.sflow-state` |
| `configurationRoot` | `/r` | `/r/.sflow-state/configuration` |
| `codeTreeExclusion` | `singularity/` (the Stories folder's first segment, as `phase-upstream.mjs` does) | null until M3 decides on `docs/stories/` |
| `object('workflow.json')` | `{ revision: null, path: 'singularity/work-items/W-1/workflow.json' }` | `{ revision: 'refs/singularity/state/W-1', path: 'workflow.json' }` |
| `commitScope` | `{ cwd: '/r', pathspecs: ['singularity/work-items/W-1'] }` | `{ cwd: '/r/.sflow-state', pathspecs: ['.'] }` |

Rules:
- **The `story-branch` arm is today's formulas, unchanged.** Disk paths are `path.join(root, storiesRoot, id, …)`, as
  `workDir` does. Record paths are `posix(path.join(storiesRoot, id, …))`, as `workDirRelative` does.
- **Template-string joins** (`` `${root}/${id}` ``) give the same string as `path.join` for a normalized Stories folder.
  Every loaded definition is normalized (`normalizeWorkItemRoot`, `config.mjs`), and every test fixture's
  `workItemRoot` is normalized too (checked on `5ac41f37e`: 177 fixtures, 9 distinct values). So their outputs do not
  change.
- **Record readers are not guessed.** A record's field says which root it is relative to (REQ-009). `fromRecord` is for
  a state file. A code or document path is joined to the checkout root, as today.
- **Cheap on the hook path.** It is one small class with methods on its prototype, and no file or Git read.
  `copilot-hook-benchmark.test.mjs` is in every batch's gate.

### The pinned configuration

A state-ref Story's pinned copy lives at `.sflow-state/configuration/`, and its code checkout has no `singularity/`.
`loadDefinition(root)` (177 calls in 91 files) reads `singularity/workflow.yml` and its siblings through
`configurationReadRoot(root)`. The configuration overlay (`withConfigurationReadRoot`, `configuration-read-scope.mjs`)
already serves configuration from a root other than the checkout: that is how read-only surfaces read `sflow/config`
today. M2 installs it at command entry, with the root set to `location.configurationRoot`. So those 177 calls do not
change. M1 only adds `configurationRoot` and `configurationSource` and moves the Story-pin readers to them (B11).

## 4. How `story.storage` selects the layout

1. **The setting.** `story.storage: story-branch | state-ref`, in `singularity/workflow.yml` on `sflow/config`. It
   defaults to `story-branch` until the release that ships SSB, then to `state-ref` (owner decision 4, spec §10). M5
   adds it to `schemas/workflow-definition.schema.json` and to the definition's normalization. M1 adds no key.
2. **Copied once.** At Story start (`story-start.mjs`), the approved value goes into the Story's resolution (built in
   `config.mjs`, beside `resolution.workItemRoot`) as `workflow.resolution.storage = { layout, documents }`. A
   resolution without `storage` is a `story-branch` Story. So every Story already in flight keeps today's layout,
   with no migration (REQ-010, A6).
3. **Read in this order** by `storyLocation`:
   1. an explicit `layout` option (Story start, before `workflow.json` exists; and tests);
   2. `workflow.resolution.storage.layout`, when a source is a workflow;
   3. `detectStoryLayout(root, id)`, added in M2 outside the pure core: the state checkout's `workflow.json` names the
      ID, or the local state ref exists;
   4. otherwise `story-branch`.
4. **Never changes.** An explicit layout that contradicts the workflow's recorded one throws a `SingularityFlowError`.
   A test proves it.
5. **The build fence:** a `state-ref` setting raises the configuration's minimum SFlow build (REQ-010) in M5.

In M1, step 3 does not exist, and no workflow has `resolution.storage`. So every call resolves to `story-branch`. That
is why M1 changes no behaviour.

## 5. Call sites by module

Generated from `5ac41f37e`. The keys are §2's. Each file's own counts are in the appendix.

| Module group | Batch | Files | W | R | P | C | I | B | X | H | L | S | F | E |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Story state kernel and paths | B2 | 29 | 75 | 87 | 3 |  | 14 | 3 |  | 6 | 2 |  | 1 | 2 |
| Steps, prompts and phase records | B3 | 39 | 31 | 12 |  | 2 | 38 | 3 | 2 |  |  |  |  |  |
| Approvals, decisions, presence | B4 | 16 | 11 | 8 |  | 1 | 13 | 1 |  |  | 2 |  |  | 2 |
| Evidence, tests and verification | B5 | 38 | 10 | 8 |  |  | 43 |  |  |  |  |  |  |  |
| Publication, recovery and Git | B6 | 10 | 2 |  |  |  | 12 | 1 |  |  |  | 2 |  | 2 |
| Documents, clarifications, inputs | B7 | 16 | 16 | 5 |  | 3 | 11 |  |  |  | 7 |  |  | 1 |
| Commands | B8 | 30 | 27 | 14 |  |  | 13 | 3 |  |  | 6 |  | 7 |  |
| Automatic work | B8 | 6 |  |  | 1 |  | 6 |  |  |  |  |  |  |  |
| Discovery, sessions, workspaces | B9 | 11 |  |  |  |  | 10 | 1 |  |  | 2 |  | 6 | 2 |
| Editor, gateway and hosts (CLI side) | B9 | 12 | 4 |  |  |  | 3 | 3 |  | 10 | 8 |  |  | 2 |
| VS Code extension | B9 | 5 |  |  |  |  |  |  | 2 |  | 1 | 1 |  | 1 |
| Plugin (hooks, extensions, skills) | B9 | 2 |  |  |  |  |  |  | 1 |  | 1 |  |  |  |
| Other modules | B9 | 6 |  |  | 1 |  | 1 |  |  | 7 |  |  |  |  |
| Record classifiers (path patterns) | B10 | 8 | 1 | 1 | 1 |  |  |  | 93 |  | 7 | 6 |  | 3 |
| Configuration pin and assets | B11 | 8 |  |  | 1 |  |  |  |  |  | 2 |  | 33 | 2 |
| Epics (M6) | M6 | 6 |  |  |  |  |  | 1 |  | 3 | 2 |  |  | 6 |
| **All** | | **242** | **177** | **135** | **7** | **6** | **164** | **16** | **98** | **26** | **40** | **9** | **47** | **23** |

`src/state.mjs` alone has 132 of them: 57 `workDir(`, 72 `workDirRelative(`, one `workflowPath(` and two inline joins.

A further kind is not in these counts: readers that join a recorded path to the checkout root, such as
`path.join(root, receipt.path)`. A search for that shape finds 133 candidates in 81 files. Only those whose field holds a
state file change, to `fromRecord` (B12).

## 6. Order of conversion

Each batch is one commit on its own. It replaces expressions with resolver calls that return the same string for
`story-branch`. It edits no test, and it lowers the ratchet's ceilings (§7) to its new counts. Batches B2 to B9 follow
the import graph: the kernel first, then the modules that call it.

How each kind converts:

| Today | After |
|---|---|
| `workDir(root, config, id)` | `storyLocation(root, config, id).directory` |
| `path.join(root, config.workItemRoot ?? D, id, ...rest)` | `storyLocation(root, config, id).file(...rest)` |
| `posix(path.join(config.workItemRoot ?? D, id, ...rest))`, or a template string | `.record(...rest)` |
| `workDirRelative(config, id)`: one of four uses | `.record(…)` to store a path, `.commitScope` to stage, `.owns(p)` or `.inside(p)` to test a path, `.object(…)` to read a Git object |
| `` `${root}/${id}/` `` with `startsWith` | `.owns(p)`, or `.inside(p)` when the remainder is used |
| `workflow.resolution?.workItemRoot ?? definition.workItemRoot ?? D` | `storyLocation(root, [workflow, definition], id)` |
| `/^singularity\/work-items\/[^/]+\/gdp\/…$/` tested on a repository path | `/^gdp\/…$/` tested on `location.inside(p)`, or on the ID-free remainder from `storyIdOfRecord` |
| `path.join(root, config.workItemRoot ?? D)`: every Story | `storiesDirectory(root, config)` |
| `git show <commit>:<Stories folder>/<ID>/workflow.json` | `location.object('workflow.json')` |

The batches:

| Batch | Scope | Days |
|---|---|---|
| B0 | The resolver, the wrappers and the two new tests in `story-paths.mjs`. `clarificationRecordRelative` moves to `phase-generation.mjs`. `work-item-location.mjs`'s `workItemWorkflowRelative` and `DEFAULT_WORK_ITEM_ROOT` delegate to it. Measure both bundle gates before and after | 0.5 |
| B1 | The about 20 small helpers that spell a Story's path for many callers: `groundingRecordRelative` (`phase-generation.mjs`); the `workRelative` helpers of `test-recovery-runtime.mjs`, `test-command-epoch.mjs` and `story-test-command-amendment.mjs`; `phase-appeals.mjs`; `step-action-receipts.mjs`; `source-review-lifecycle.mjs`; `phase-evidence-amendment.mjs`; `evidence/graph.mjs`; the default folder of `design-inventory.mjs`, `visual-compare.mjs`, `visual-coverage.mjs`, `visual-native-capture.mjs` and `mcp-evidence.mjs`; `impact.mjs`'s measurement folder; `story-base-lineage.mjs`; `trp-delivery-selection.mjs`; `comprehension/xpl2/clause-sources.mjs` | 0.5 |
| B2 | The Story state kernel: `state.mjs` (132 sites), then the other 28 kernel files | 1 |
| B3 | Steps, prompts and phase records, including `governance.mjs`, `phase-prepublish.mjs`, `phase-upstream.mjs` (`codeTreeExclusion`) and `change-flight-plan.mjs` | 0.5 |
| B4, B6, B7 | Approvals, decisions and presence; publication, recovery and Git; documents, clarifications and inputs | 0.5 |
| B5 | Evidence, tests and verification, including `delivery-evidence.mjs` | 0.5 |
| B8 | Commands and automatic work | 0.5 |
| B9 | Discovery, sessions and workspaces; editor, gateway and CLI-side hosts; `copilot-mutation-guard.mjs`; the VS Code extension (`inbox-model.ts`, `watcher-refresh-fence.ts`, `gdp-local-runner-review.ts`; `schema-form-model.ts` holds only an example path) and the plugin's documents extension. The `sflow-report` skill's line already names `workflow.resolution.workItemRoot`. The TypeScript side gets the same answers from a small copy of `storyIdOfRecord` and `isStoryRecordPath`, checked against the engine's by a test | 0.5 |
| B10 | Record classifiers: `schema-migrations.mjs` (93 patterns), `schema-census.mjs`, `revision/`, `delivery-modes/` and `ask/retained-history.mjs`. Each pattern drops its Stories-folder prefix and is tested on the path inside the Story. `schema-migrations.mjs` is a companion in `docs/contracts/gdp/companion-lock.json`, so this batch carries a lock review document and new digests | 0.5 |
| B11 | The Story-pin readers of `configuration-source.json`: `story-start.mjs`, `session-read-service.mjs`, `organisation.mjs`, `configuration-restore.mjs`, and the Story-pin readers in `configuration-branch.mjs`. Repository-level uses (bootstrap and `sflow/config`) stay as they are | 0.25 |
| B12 | Readers of recorded state paths: the 133 candidates are sorted, and those whose field holds a state file move to `fromRecord`. Then the ratchet's final ceilings, and the full suite once | 0.75 |

That is 6 days. B2 has to wait for B0 and B1. B3 to B9 can be split between people after B2, one module group each,
because they touch disjoint files.

## 7. Tests that prove no behaviour change

**New: `test/story-paths-resolver.test.mjs`.**
- The wrappers equal the old formulas byte for byte. The cases cover each Stories folder the fixtures use (9 values on
  `5ac41f37e`), IDs with dots, dashes and underscores, and POSIX and Windows `path` flavours (`path.win32` is passed in
  as the platform's `path`).
- Every `story-branch` member equals today's spelling in the table of §3.
- `storiesRoot` gives each of the four precedence orders of §2 the result its old expression gave, including when
  sources disagree.
- For both layouts:
  - `fromRecord(record(x))` equals `file(x)`;
  - `owns(record(x))` is true for `story-branch` and false for `state-ref`;
  - `document()` is under `docs/stories/<ID>/` for `state-ref`;
  - `object()` names the state ref for `state-ref`.
- An explicit layout that contradicts the workflow's throws.
- `story-paths.mjs` imports only `node:path` and `util.mjs`.

**New: `test/story-paths-ratchet.test.mjs`.**
- It counts each §2 spelling outside an allow-list, and fails when a count rises above its ceiling. The allow-list is
  `story-paths.mjs`, the default and validation in `config.mjs`, `work-item-location.mjs`'s normalization, and
  `configuration-assets.mjs`'s runtime roots.
- Each batch lowers the ceilings by hand in its own commit. The test never rewrites them, unlike `osa --ratchet`.
- At M1's end the ceilings are 0 for W, R, P, C, I, B, X and H in `src/`. L keeps only help text and comments, each
  named. E stays for M6.
- A new spelling that other work lands on `main` during M1 fails this test, so it is caught at the next rebase.

**The proof set, run unchanged at every batch:**
- the kernel and paths: `test/state-kernel.test.mjs`, `test/state-story-listing-paths.test.mjs`,
  `test/grounding-paths.test.mjs`, `test/path-grounding.test.mjs`, `test/git-bookkeeping-paths.test.mjs`;
- Story start: `test/story-start.test.mjs`, `test/story-start-publication.test.mjs`,
  `test/story-start-recovery.test.mjs`;
- the walks: `test/story-invariants.test.mjs`, `test/story-fuzzer.test.mjs`, `test/journey-stories.test.mjs`,
  `test/journey-routes.test.mjs`, `test/journey-tasks.test.mjs`, `test/surface-agreement.test.mjs`;
- bundles, closures and speed: `test/cli-bundle.test.mjs`, `test/vscode-package.test.mjs`,
  `test/vscode-bundle-budget.test.mjs`, `test/lazy-command-handlers.test.mjs`,
  `test/source-review-fastpath.test.mjs`, `test/copilot-hook-benchmark.test.mjs`;
- the inventory: `test/sda-inventory.test.mjs`.

**Added by batch:**

| Batch | Also run |
|---|---|
| B2 | `test/policy-read-optimization.test.mjs`, `test/story-approver-refresh.test.mjs`, `test/lifecycle-unhappy-paths.test.mjs`, `test/no-dead-end.test.mjs` (slow lane), `test/story-index.test.mjs` |
| B5 | `test/story-test-known-baseline.test.mjs`, `test/story-test-risk-lifecycle.test.mjs`, `test/story-test-command-amendment-lifecycle.test.mjs`, `test/test-recovery-admission.test.mjs`, `test/trp-repair-lifecycle.test.mjs`, `test/trp-selection-lifecycle.test.mjs` |
| B6 | `test/publication-unhappy-paths.test.mjs`, `test/journey-replay.test.mjs` |
| B9 | `test/journey-vscode.test.mjs`, `test/vscode-watcher-refresh-fence.test.mjs`, `test/story-list-presentation.test.mjs`, `test/vscode-decisions.test.mjs` |
| B10 | `test/gdp-contract-freeze.test.mjs` with the lock review, `test/schema-upgrade-all.test.mjs`, `test/schema-upgrade-cli.test.mjs`, `test/world-model-history-schema-census.test.mjs` |

Every batch also runs:
- the test files that import a module it changed;
- the test files that name such a module;
- the scan-type tests (names matching `ratchet|golden|plain-language|no-secret|help|docs|skill|budget|audit|inventory|catalog|exit|osa`).

How:
- through the isolated runner with a list file, never plain `node --test`;
- on Node 22;
- with `SINGULARITY_FLOW_TEST_SLOW=1`;
- the full suite once, at M1's end, then `node scripts/check.mjs` before the push.

The 509 test files that spell `singularity/work-items` stay as they are. They are the evidence that the paths on disk
did not change.

## 8. Risks

- **Bundle bytes.** `story-paths.mjs` grows by about 6 KB in every closure that has it. The CLI bundle's closures sit
  just under ceilings that `test/cli-bundle.test.mjs` raises in 5,000-byte steps, each with a comment naming its
  measurement. Each inline join removed is about 60 bytes, so B1 to B5 give back about 10 KB. B0 and B1 land
  together, and both bundle gates are measured before the push. Any raise follows that gate's own rule.
- **The four precedence orders** are kept as they are. Settling on one is a behaviour change, so it waits for M2,
  with its own test.
- **Readers of recorded paths** are found by a search pattern, so some may be missed. In M2 the state-ref Story fuzzer
  is the backstop: a state-ref Story has no `<Stories folder>/<ID>/` in its checkout, so a missed reader fails loudly
  there instead of reading a wrong file.
- **The GDP lock:** B10 changes a lock companion, so it needs a lock review document. A bare hash refresh is not enough.
- **Work landing on `main` meanwhile** adds new spellings. The ratchet fails them at the next rebase. Each batch is
  rebased before its gate.

## 9. Changes while building

Found while building M1, on `480c2f936`. Each batch's commit adds its own.

- **B0, the resolver.** As §3, with these differences:
  - `storyRecordOf(path, ...sources)` gives `{ id, inside }` for a record path, so a classifier gets the ID-free remainder
    in one call; `storyIdOfRecord` and `isStoryRecordPath` use it.
  - `CONFIGURATION_SOURCE_RELATIVE` names the story-branch pin, `singularity/configuration-source.json`.
  - `storyLocation(..., { pathModule })` takes `path.win32` in tests, for the Windows flavour of §7.
  - `inside(prefix)` is `''`, and `owns(p)` is true only strictly below the prefix: the sites that test
    `startsWith(`${prefix}/`)` keep their answers.
  - A source is a workflow when it has `workItem` or `resolution`; a definition has neither (its schema).
- **C is not counted.** `clarificationRecordRelative` moved beside `groundingRecordRelative` and goes through the resolver,
  as its twin does. So its six calls are calls of a resolver-backed helper, not joins, and the ratchet has no C.
- **The ratchet counts member calls** (`paths.workDirRelative(`, `dependencies.workDir(`), which §2's counts left out.
- **Counts moved on.** `main` gained 17 commits after `5ac41f37e`. The ratchet's first ceilings are measured on
  `480c2f936` after B0 and B1: W 177, R 137, P 7, I 141, B 9, X 97, H 28, L 36, S 9, F 45, E 34. Its B pattern counts
  joins only (`path.join(... .workItemRoot` and `${... .workItemRoot`), so it finds 9, not 16.
- **H counts `DEFAULT_WORK_ITEM_ROOT` only** (from B2). `workItemWorkflowRelative` validates a Work ID and normalizes the
  root before it asks the resolver, so its callers keep that refusal; replacing it with a bare resolver call would drop
  the check. `storiesRoot()` names the default everywhere else.
- **B2.** `task-amendment.mjs` (R2) and the lazy `state.mjs` imports of `workDir` in `story-baseline-admission.mjs`
  were not in the appendix; both are converted. `story-readiness-snapshot.mjs` stamps the default folder's
  `workflow.json`, as before, through `storyLocation(member, null, story)`.
- **B3.** `change-flight-plan.mjs` tested `(^|/)singularity/work-items/<ID>/` anywhere in a path. The resolver gains
  `storyRecordWithin(path, ...sources)`: the first Stories folder at the start or after a `/`. It agrees with the old
  patterns on every path SFlow writes; it differs only for a Stories folder nested in itself or glued to a longer
  segment name. A local `workItemRoot` variable joined by hand (`phase-prompt-composer.mjs`) goes through
  `storyLocation(root, { workItemRoot }, id)`. `phase-mutation-contract.mjs` names `<Stories folder>/null` for a
  contract without a Story, as before, through `String(workId)`.
- **B4.** `departure-records.mjs` and `findings/register/on-the-way.mjs` imported `story-paths.mjs` only lazily; their
  inline joins outside those functions now import it statically, so their own closures gain `story-paths.mjs` (they
  already held `util.mjs`, its only import). `presence/attribution.mjs` keeps its root normalization (backslashes,
  trailing slashes) and asks the location whether a path is the Story's record and not its document.
- **B5.** A template string coerced a missing ID to `undefined`, where `path.join` throws. Where the ID is read from a
  record (`receipt.workId` in `delivery-evidence.mjs`, `story.workId` in `findings/register/remediation.mjs`), the
  resolver gets `String(id)`, so a malformed record is still refused with its own message. `trp-document-runtime.mjs`
  and `test-recovery-admission.mjs` keep `story-paths.mjs` lazy, as they kept `state.mjs`.
- **Spellings a test pins stay, by name.** "No test file is edited" holds, so where a test reads a module's source
  and expects the old spelling, the site keeps it and the ratchet allows that line: `state.mjs`'s
  `activeWitnessClauses(workDir(...))` (`test/approval-witness-criteria.test.mjs`), and `dependencies.workDir(` in
  `commands/story-test-attestation.mjs` and `commands/story-test-repair.mjs`, a seam their tests inject. Each wrapper
  asks the resolver. So W ends at these three allowed lines, not at a literal 0.
- **B8.** `commands/nextsteps.mjs` keeps an OS-relative `workflow.json` path (`path.join` without a root, so Windows
  separators): `storyLocation('', definition, id).file('workflow.json')` gives the same string. Lazy `state.mjs`
  imports of `workflowPath` (`auto/auto-flight-store.mjs`) now lazily import `story-paths.mjs`.
- **B9.** The extension's copy of the classifier lives in `apps/vscode/src/story-attach.ts` (`storyRecordWithin`,
  `DEFAULT_STORIES_FOLDER`), a module both `views/inbox-model.ts` and `gdp-local-runner-review.ts` reach, so no
  extension bundle gains a module. The plugin's documents extension ships without the engine and keeps its own copy.
  A third new test, `test/vscode-story-record-path.test.mjs`, holds both copies to the engine's answers and to the
  patterns they replaced. The plugin's old pattern matched the folder even glued to a longer segment name
  (`xsingularity/work-items/`); the copy reads it only at the start of a path or after a `/`.
  `watcher-refresh-fence.ts` matches Stories and Epics in one pattern and waits for M6. `copilot-plain-chat.mjs`
  imports the resolver lazily, as it imports everything off the hook's first path. `cli-entry.mjs` keeps its
  `ls-files` glob of every Story's `workflow.json`: root dispatch does not load `story-paths.mjs` (L, named).
  `repository-subject-index.mjs` brings `storiesRoot` into the VS Code help and support runtimes: one module each
  (+75 and +71 bytes), raised with their measurements.
- **B10.** `schema-migrations.mjs` wraps each of its 95 Story patterns (93 literals and two `new RegExp`) as
  `insideStory(/^<rest>$/)`, an object whose `test` asks `storyRecordOf` for the path inside the Story; the families'
  `paths` arrays keep their order, so `familyForStoredPath` is unchanged. Compared before and after on paths generated
  from each old pattern, under the default and a configured folder: 520 lookups, no difference. The lock review is
  `docs/contracts/gdp/COMPANION-LOCK-REVIEW-2026-11-26-SSB-M1.md`. The import brings `story-paths.mjs` into root
  dispatch (one new eager file, +8,885 bytes, raised with its measurement) and into the VS Code extension and
  performance runtimes (one module each, raised). `ask/retained-history.mjs`'s `'work-items'` is a unit word in a
  message, not a path, so S stays at 1.
- **B11.** The Story-pin readers that know their Story ask the location: `story-start.mjs`'s refusal names
  `configurationSource.relative`, and `session-read-service.mjs` stamps `configurationSource.absolute`. Those that read
  a checkout's or a branch's pin without a Story ID (`organisation.mjs`, `configuration-restore.mjs`) use the
  resolver's `CONFIGURATION_SOURCE_RELATIVE`, which a test holds equal to `configuration-assets.mjs`'s
  `CONFIGURATION_SOURCE_PATH`. The 41 remaining F uses are `existsSync(path.join(root, CONFIGURATION_SOURCE_PATH))`
  checks of whether a checkout is pinned, `readConfigurationSource` and `materializeConfigurationSnapshot` in
  `configuration-branch.mjs`, and their messages: none names a Story, so M2 gives them the Story's layout rather than M1
  a guess. `configuration-assets.mjs` is a leaf with no imports and keeps the constant. The Story-root defaults in
  `knowledge.mjs`, `knowledge/requirements.mjs`, `harness-imports.mjs` and `initiative-repositories.mjs` (grouped
  under M6 in the appendix) go through `storiesRoot()`; their Epic paths stay for M6. The last literal joins
  (`commands/work.mjs`, `session-open-local.mjs`, `status-read.mjs`, `start-context.mjs`) and `cli-entry.mjs`'s
  tracked-subjects glob use the resolver too.
- **Final ratchet.** W, R, P, I, B, X, H, L and S are 0 outside named lines: the three `workDir` calls a test pins or injects,
  the two copies' default folder, and eight lines of help text, agent guidance, comments, an example value and a unit
  word, each with its reason. F stays at 41 (above) and E at 34 (M6).
- **B12, readers of recorded paths.** On this base the search (`path.join(root, <record>.<path field>)`) finds 81
  candidates, not 133. Sorted:
  - **State files, now `fromRecord`** (20): delivery receipts (`story-lineage.mjs` ×2, `state.mjs` ×2,
    `commands/shared/phase-review.mjs`, `spec-drift.mjs`), claim pointers (`state.mjs`,
    `amendment-plan-corrections.mjs`), intent-amendment proposals (`commands/story.mjs` ×3), the impact plan
    (`impact.mjs`), generation-start receipts (`generation-boundary.mjs`, `amended-drafts.mjs`), phase telemetry
    (`telemetry.mjs` ×2), work-interval baselines (`work-intervals.mjs` ×2), a dependency record's receipt
    (`dependency-records.mjs`) and a rendered agent brief (`agent-briefs.mjs`). Each reads the Story's location from
    the `config` and `workflow` in scope; for story-branch, `fromRecord(p)` is `path.join(root, p)`.
  - **State files with no Story in scope, left for M2** (5): `evidence/graph.mjs` `loadAttempt`,
    `criterion-test-failures.mjs`, `approval-waiver.mjs` `pendingWaiverSubmission`,
    `verification/changed-line-coverage.mjs` `boundStepAttempts` and `generation-boundary.mjs`
    `consumeGenerationIntent` take a phase or an entry, not a Story; M2 passes them the location.
  - **Documents, code and configuration, unchanged** (the rest): step artifacts (`artifact.path`, documents in M4),
    repository, template, skill, AST and workspace paths, and `story-lineage.mjs`'s governed-context seed, which mixes
    kinds.
- **Found by the guard tests at the end.** Moving `clarificationRecordRelative` into `phase-generation.mjs` moved its
  `nextPhaseGeneration` default with it, a second OSA predicate call there; the two twins now share one
  `contextRecordRelative` that holds the single call, and `story-paths.mjs`'s fall to 0 is locked in
  `benchmarks/osa/ratchet.json` by hand (no `--ratchet`). The resolver's two refusals name their way out, an SFlow
  update, as `config.mjs`'s newer-workflow refusal does (plain-language rule: no refusal with only generic help).
- **Budgets at the end of M1**, against `480c2f936`: eager submit.mjs 9,917,462 (+11,399), session current 4,375,656
  (+8,381), root dispatch 888,719 bytes (+9,335) and 40 files (one new: `story-paths.mjs`); VS Code gateway 7,891,977
  bytes (-977, its limit back at 7,893,000), extension 161 modules, help 147, support 115, performance 13 (one module
  each, `story-paths.mjs`), lazy panels 3,747,716 bytes (+271).
- **Found by the touched-area run.** The edit guard's static closure gains `story-paths.mjs` (56 to 57 modules: its
  mutation contract, record-family read and own `workflow.json` path use the resolver), raised in
  `test/lazy-startup-reads.test.mjs` and `benchmarks/performance-v2/import-budgets.json` with the measurement. The two
  layout refusals are cleared by whoever works in the checkout (`APPROVAL_HOLD_OWNERS`, `this-checkout`), as a stage's
  every code must say (`test/oap-m1-approval-check.test.mjs`). B12's `amended-drafts.mjs` variable shadowed the
  module's `recorded()`; renamed.
- **The full suite is not run in M1.** §7 asks for it once at M1's end; the owner's rule for this build runs only the
  touched-area tests and the named guard tests, so the full run is left to integration.
- **Not converted in M1: a Story prefix passed as a parameter** (`itemRelative`, `itemRoot`, `workRoot` joined by the
  callee, as in `recovery-preparation-context.mjs`). The prefix comes from the resolver; the callee's join stays until
  M2 passes the location instead. The ratchet does not count these.
- **Budgets.** The resolver adds about 8.5 KB of source to every closure that has it. B0 and B1 raise the eager budgets in
  `test/lazy-command-handlers.test.mjs` (submit.mjs 9,915,050; session current 4,376,031) and the VS Code
  `gateway-runtime.cjs` limit (7,896,000), each with its measurement. No module was added to any closure.

## Appendix: every file, by module group

Keys as in §2. Generated from `5ac41f37e` with a script outside the repository: per file, the count of each spelling.
Definitions in `story-paths.mjs` itself are left out.

**Story state kernel and paths** (B2, 29 files):
`src/abandoned-generations.mjs` I1; `src/config.mjs` I1 E2; `src/generation-boundary.mjs` I1; `src/lifecycle-worktree.mjs` I1; `src/state.mjs` W57 R72 P1 I2; `src/story-aggregate-read.mjs` P1; `src/story-approver-refresh.mjs` R1; `src/story-base-lineage.mjs` I1 B2 L1; `src/story-baseline-admission.mjs` W3; `src/story-epic-sources.mjs` W1; `src/story-index.mjs` H3; `src/story-lessons-notice.mjs` R3; `src/story-lineage.mjs` W6; `src/story-paths.mjs` W1; `src/story-policy-anchor.mjs` R1; `src/story-publication-read.mjs` W1; `src/story-publication-service.mjs` W2 R4; `src/story-readiness-snapshot.mjs` L1; `src/story-start.mjs` R2 F1; `src/story-state-write.mjs` W2 R1 P1; `src/story-test-command-amendment.mjs` I1; `src/story-test-risk.mjs` W2; `src/story-version-opening.mjs` R3; `src/story-worktree.mjs` H3; `src/work-intervals.mjs` I1; `src/workflow-retirement.mjs` I1 B1; `src/workflow-snapshots.mjs` I1; `src/workflow-task-outcome.mjs` I2; `src/workflow-task-store.mjs` I1.

**Steps, prompts and phase records** (B3, 39 files):
`src/acceptance-owner-check.mjs` W1; `src/amendment-plan-corrections.mjs` W3 R2; `src/candidate-isolation.mjs` I1; `src/candidate-scope.mjs` I1; `src/change-flight-plan.mjs` I2 X2; `src/draft-evidence-hold.mjs` I2; `src/governance.mjs` W10 C1 I5 B1; `src/local-test-runs.mjs` R3; `src/node-pin.mjs` R1; `src/phase-appeals.mjs` W1 I1; `src/phase-artifact-browser.mjs` R2; `src/phase-authoring-contract.mjs` I1; `src/phase-draft-check.mjs` I1; `src/phase-entry-context.mjs` B1; `src/phase-evidence-amendment.mjs` I1; `src/phase-execution-evidence.mjs` I1; `src/phase-finding-dispute.mjs` W1 I1; `src/phase-generation.mjs` I1; `src/phase-mutation-contract.mjs` I1 B1; `src/phase-prepublish.mjs` I7; `src/phase-prompt-composer.mjs` I2; `src/phase-publication-readiness.mjs` I1; `src/phase-publication-unchanged.mjs` I1; `src/phase-quality-risk.mjs` I1; `src/phase-retention.mjs` I1; `src/phase-upstream.mjs` I2; `src/planning.mjs` W4 R1; `src/projectors.mjs` W5 R1; `src/recovery-preparation-context.mjs` C1; `src/refactor-behaviour.mjs` R1; `src/return-locator.mjs` W1; `src/review.mjs` W2; `src/scope/authoring.mjs` I2; `src/settle-before-publication.mjs` W1; `src/step-action-receipts.mjs` I1; `src/step-action-recovery.mjs` I1; `src/submission-readiness.mjs` W1; `src/task-change-verify.mjs` R1; `src/witness-review-read.mjs` W1.

**Approvals, decisions, presence** (B4, 16 files):
`src/approval-check.mjs` R2; `src/approval-focus.mjs` W1 R2; `src/approval-waiver.mjs` I2; `src/automatic-approval-replay.mjs` I1; `src/choices.mjs` R1; `src/decision-list-facts.mjs` W1; `src/decision-list-reads.mjs` W5 R1; `src/departure-records.mjs` W3 R2 I2; `src/findings/register/on-the-way.mjs` W1 I1; `src/findings/register/remediation.mjs` B1 L1; `src/findings/register/store.mjs` I1; `src/outcome-review.mjs` I1 L1; `src/presence/attribution.mjs` I3; `src/presence/remote-check.mjs` I1; `src/presence/store-check.mjs` E2; `src/source-review-lifecycle.mjs` C1 I1.

**Evidence, tests and verification** (B5, 38 files):
`src/application-review-host.mjs` R1; `src/application-review-read.mjs` R1; `src/application-review.mjs` R1; `src/ast-evidence.mjs` I1; `src/ast-intelligence.mjs` I1; `src/ast-lifecycle.mjs` I1; `src/code-documentation-inspection.mjs` I1; `src/code-submission-evidence.mjs` I1; `src/conformance-readiness.mjs` I3; `src/criterion-test-failures.mjs` I1; `src/delivery-evidence.mjs` I9; `src/evidence-consistency-read.mjs` I2; `src/evidence-packet.mjs` I3; `src/evidence-receipt.mjs` W1; `src/evidence/cross-phase-change.mjs` I1; `src/evidence/graph.mjs` I1; `src/gateway/readiness-evidence.mjs` W3 I1; `src/impact.mjs` I3; `src/mcp-evidence.mjs` I3; `src/skp-phase-evidence.mjs` I1; `src/test-command-epoch.mjs` I1; `src/test-command-pins.mjs` R1; `src/test-recovery-admission.mjs` W2; `src/test-recovery-runtime.mjs` I1; `src/trp-delivery-selection.mjs` I1; `src/trp-document-runtime.mjs` W2 I1; `src/verification/base-run.mjs` R1; `src/verification/changed-line-coverage.mjs` W1; `src/verification/corner-case-obligations.mjs` I1; `src/verification/flaky-runs.mjs` R1; `src/verification/repository-tests.mjs` R1; `src/verification/test-policy.mjs` I1; `src/verification/witness-records.mjs` I1; `src/visual-compare.mjs` I1; `src/visual-coverage.mjs` I1; `src/visual-native-capture.mjs` I1; `src/visual-risks.mjs` W1; `src/visual-sign-off-capture.mjs` R1.

**Publication, recovery and Git** (B6, 10 files):
`src/collaboration.mjs` I3; `src/document-publication.mjs` I1; `src/fault-repair.mjs` S2; `src/git-exact-story-revision.mjs` B1; `src/github-evidence.mjs` W1; `src/publication-pending.mjs` I2 E2; `src/publication-preflight.mjs` I1; `src/publication-set-aside.mjs` W1; `src/recovery-plan.mjs` I4; `src/repository-commit-policy/context.mjs` I1.

**Documents, clarifications, inputs** (B7, 16 files):
`src/artifact-review-read.mjs` I2; `src/asked-for-records.mjs` W1; `src/clarifications.mjs` C3 I2 L1; `src/comprehension/code-scope.mjs` L1; `src/comprehension/xpl2/clause-sources.mjs` I1 L1; `src/context-history.mjs` I1; `src/convergence-context.mjs` I1; `src/design-inventory.mjs` I1; `src/design-sources.mjs` I1; `src/document-replay.mjs` W2 R1; `src/documents-read.mjs` W5; `src/documents.mjs` W6 R4 L1; `src/grounding.mjs` I1 E1; `src/reference-repositories.mjs` I1; `src/spec-coverage-preview.mjs` W2; `src/spec-drift.mjs` L3.

**Commands** (B8, 30 files):
`src/commands/auto.mjs` I1; `src/commands/decision-plan-amendment.mjs` W1; `src/commands/decision-test-narrowing.mjs` R1; `src/commands/decision-test-risk.mjs` R1; `src/commands/decision-visual-risk.mjs` W1; `src/commands/input-restore.mjs` I2; `src/commands/inputs.mjs` W1; `src/commands/nextsteps.mjs` B3; `src/commands/phase-lifecycle.mjs` W1; `src/commands/plan-correction.mjs` I1; `src/commands/session-open-local.mjs` L1; `src/commands/session.mjs` I1; `src/commands/shared/record-spec-usage-after-transition.mjs` I1; `src/commands/shared/session-repository-authority.mjs` F2; `src/commands/shared/start-context.mjs` L1 F5; `src/commands/shared/story-draft-transaction.mjs` W1; `src/commands/spec-attach.mjs` I1; `src/commands/spec-author.mjs` I1; `src/commands/spec-dependencies.mjs` I1; `src/commands/spec-drift.mjs` I2; `src/commands/start.mjs` W1 R2; `src/commands/status-read.mjs` L1; `src/commands/story-target-origin.mjs` W1; `src/commands/story-test-selection.mjs` W1; `src/commands/story.mjs` W14 I1; `src/commands/tests.mjs` R4; `src/commands/upstream-issue.mjs` R6 I1; `src/commands/visual.mjs` W4; `src/commands/wm.mjs` W1; `src/commands/work.mjs` L3.

**Automatic work** (B8, 6 files):
`src/auto/auto-checkpoint.mjs` I1; `src/auto/auto-continuation.mjs` I1; `src/auto/auto-executor.mjs` I1; `src/auto/auto-flight-store.mjs` P1; `src/auto/auto-origin.mjs` I2; `src/auto/auto-phase-contract.mjs` I1.

**Discovery, sessions, workspaces** (B9, 11 files):
`src/capability-application-context.mjs` F2; `src/capability-context.mjs` F2; `src/capability-doctor.mjs` I1; `src/organisation.mjs` I1 F1; `src/repository-subject-index.mjs` I2 E2; `src/session-read-service.mjs` B1 L1 F1; `src/session-remote-url-discovery.mjs` I2; `src/session-story-discovery.mjs` I2; `src/skill-catalog.mjs` I1; `src/workspace-story-checkout.mjs` L1; `src/worldmodel.mjs` I1.

**Editor, gateway and hosts (CLI side)** (B9, 12 files):
`src/adhoc/landing.mjs` L1; `src/agent-hooks.mjs` H5; `src/cli-entry.mjs` L1 E1; `src/cli.mjs` W3; `src/copilot-mutation-guard.mjs` B1; `src/copilot-plain-chat.mjs` B2 L1; `src/editor.mjs` I3 E1; `src/first-run-guide.mjs` L2; `src/gateway/planners/work-return.mjs` W1; `src/help-pages.mjs` L1; `src/secrets.mjs` L1; `src/work-item-location.mjs` H5 L1.

**VS Code extension** (B9, 5 files):
`apps/vscode/src/extension.ts` E1; `apps/vscode/src/gdp-local-runner-review.ts` S1; `apps/vscode/src/views/inbox-model.ts` X1; `apps/vscode/src/views/schema-form-model.ts` L1; `apps/vscode/src/watcher-refresh-fence.ts` X1.

**Plugin (hooks, extensions, skills)** (B9, 2 files):
`plugin/extensions/documents/documents.mjs` X1; `plugin/skills/sflow-report/SKILL.md` L1.

**Other modules** (B9, 6 files):
`src/epic-review.mjs` H3; `src/pull-request.mjs` H2; `src/sgos/story-authority.mjs` H1; `src/state-stores.mjs` P1; `src/task-admission.mjs` H1; `src/workflow-walk/walk.mjs` I1.

**Record classifiers (path patterns)** (B10, 8 files):
`src/ask/retained-history.mjs` L1 S1 E1; `src/delivery-modes/local-signed-runner.mjs` S1; `src/delivery-modes/proof-store.mjs` S2; `src/revision/current-context.mjs` R1 P1; `src/revision/product-context.mjs` W1; `src/revision/store.mjs` S2; `src/schema-census.mjs` L3 E1; `src/schema-migrations.mjs` X93 L3 E1.

**Configuration pin and assets** (B11, 8 files):
`src/approved-configuration-reader.mjs` F3; `src/configuration-assets.mjs` L2 F3 E2; `src/configuration-branch.mjs` F18; `src/configuration-proposal.mjs` F3; `src/configuration-restore.mjs` F1; `src/configuration-superseded-refs.mjs` F1; `src/doctor.mjs` P1 F2; `src/skill-library-problems.mjs` F2.

**Epics (M6)** (M6, 6 files):
`src/harness-imports.mjs` L1 E2; `src/initiative-config.mjs` E1; `src/initiative-repositories.mjs` H3; `src/initiative-state.mjs` E2; `src/knowledge.mjs` B1 E1; `src/knowledge/requirements.mjs` L1.
