# Code Explainer (VS Code)

**Implemented boundary:** an interactive, read-only explanation of the source code a change touches:
which functions changed, who calls them, what they call, which tests name them, and which
requirements their files are associated with. It is model-free; **Ask Copilot** only opens chat with a
prompt the person reviews before sending. Nothing here approves, verifies, publishes or gates.

Open it with **Singularity Flow: Code Explainer**, from the Navigator title bar or Source Control
title bar, or from **Explain This Code** in the editor's *Singularity Flow* submenu, which focuses the
function at the cursor (and works on code the change did not touch). The sidebar lists it under
*Work tools → Understand changes*.

## What it shows

- **Dependency graph.** One card per file, one row per function, method or class, laid out in layers:
  callers to the left of what they call. Changed rows carry their `+added −removed` counts and a
  colour bar (new, modified, removed); unchanged rows appear only when they call changed code or are
  called by it. Calls between rows of one file loop around the card's edge. Changed files without
  code (documents, configuration) share one *Other changed files* card. Singularity Flow's own files
  (its governed roots, agent definitions and `.singularity-flow/` state) are never drawn, and
  **Explain This Code** refuses them: they are not application code.

  **View** chooses what the graph covers:
  - **Delta** draws what the Story changed and the code it calls or is called by.
  - **Full** maps every function in the current worktree's code and how they call each other, with
    anything the Story changed still marked as changed.

  The explainer opens on Delta when the Story has changed code and on Full when it has not. **Re-index**
  rebuilds the chosen view from the worktree as it is now, files not yet committed included.
- **Inspector.** For the selected function: an explanation written from the facts below, its
  estimated complexity, size, callers, calls and test references, its typed signature, the exact
  lines that changed inside it, and links to every caller, callee and test reference. Selecting a call
  edge lists its call sites; selecting a card describes the file.
- **Requirement → test trace.** Four columns: requirements (with gaps, the author's `@clause` notes
  and the requirements each one cites or is cited by), changed code, tests and the
  recorded results of the phase. Clicking a card lights its chain.
- **Repository.** What the whole repository holds, from `explain code --repository`:
  - its folders, with counts;
  - each file's declarations and `@clause`/`@ac` tags;
  - the clauses those tags name.

  In Delta it opens on its own when there is no change to explain. A repository over the AST budget is
  explained one folder at a time: choose a folder to explain it, and **Up** to go back. Choosing a
  declaration opens it in the dependency graph, with its callers, callees and tests. The page asks
  by entry index; the host resolves each request against the explanation it read.
- **Walkthrough.** The changed functions in reading order (callers before the functions they call,
  code before tests, whole-file changes last), one step at a time, each with its explanation and diff.

Interaction: drag to pan, ⌘/Ctrl + wheel (or pinch) to zoom, drag a card's header to move it, click a
row to inspect it, double-click (or Enter) to open it in the editor, ←/→ to move to a caller or
callee, ↑/↓ within a card, `/` to find, `I` to isolate the selection's neighbourhood, `F` to fit,
`L` to lay the graph out again, `M` for the overview. Filters show or hide changed, repository, caller,
callee, test, external and other cards; **Call depth** 1–3 follows callers of callers and callees of callees.

## Where the facts come from

| Fact | Source | What it does not mean |
|---|---|---|
| What changed | The Story's leased comprehension capture: the XPL2 `change` view and its bounded patch. Singularity Flow's own files are not part of it. When the patch preview is not available (a very large change can exceed it), the base version of each changed code file is read through `comprehension source` (digest-checked) and diffed line by line against the working text. | — |
| Which function a line is in | The editor's document symbols; a comment or decorator block directly above a declaration belongs to it. A removed line of a rewritten region follows the most similar added line; a function declared only on removed lines is listed as removed. With no language service, an outline read from the file's own text, marked *text outline*. | A text outline gives positions only, not calls. |
| Calls | The editor's call hierarchy (`vscode.prepareCallHierarchy`, incoming and outgoing calls). A JavaScript or TypeScript repository without a `jsconfig.json` or `tsconfig.json` lets the language service see only open files, so the explainer first opens the worktree's other code files in the background (up to 60) and says so in its notes. | Static resolution only: dynamic dispatch, callbacks and reflection can add calls it cannot see. |
| Test references | The editor's references, kept only when they are in a test file. | A test that names a function does not prove it exercises the change. |
| Signature and documentation | The editor's hover for the symbol; otherwise the declaration text. | — |
| Complexity | One plus the decision points counted in the function's own text, strings and comments removed. Bands: ≤5 simple, ≤10 moderate, ≤20 complex. | An estimate, not a syntax-tree measurement. |
| Requirements | The change view's `@clause` tags, each bound to the function whose own lines (its leading comment block included) hold it; its region associations (file level); declared `@ac` test tags; and the clauses each requirement's text cites. | A tag is the author's declaration and a file-level association is only that; neither proves a function implements the requirement. |
| Gates | The same readiness gate count the status bar shows, never recounted. | — |

Every sentence in the explanation says which of these it rests on. **How this view was built** (the
*engine* item in the status line) lists, per language, where symbols and calls came from and how many
language-service requests were answered, empty or failed.

## Boundaries

- **Bounded.** At most 40 changed code files are analysed, 120 call-hierarchy requests and 240
  functions per build, and 40 reference and hover lookups. The full view maps up to 60 code files and
  traces calls from up to 100 functions within 360 requests. Anything cut is named in the view.
- **Live but pinned.** A build describes one moment. Saving a file shown, or a newer capture, raises
  *The repository changed since this view was built* with **Refresh**; nothing rebuilds under the reader.
- **Closed messages.** The page sends a model id and a symbol, file or call id; the host resolves it
  against its own harvest. It never opens a path, runs a command or follows a URL from the page, and a
  repository file opens only when it stays inside the repository.
- **Inert page.** Every name, path and source line is set as text under a nonce-only policy.
- **Export.** *Export JSON* saves the model (functions, calls, metrics, explanations, trace) to a file the
  person chooses. It carries no source text beyond signatures, and `authority: "none"`.
- **Exact diff.** *Compare diff* opens the captured before and after bytes read-only, as the Change
  Explorer does.

The engine half lives in `apps/vscode/src/views/code-explainer-model.ts` (pure, tested by
`test/vscode-code-explainer-model.test.mjs`), the page in `code-explainer-page.ts` (tested by
`test/vscode-code-explainer-page.test.mjs`) and the host in `code-explainer.ts`. The evidence-centred
view of the same capture is the Change Explorer ([Explain for humans](XPL2-EXPLAIN-FOR-HUMANS.md)).
