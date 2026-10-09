# Code Explainer (VS Code)

**Implemented boundary:** an interactive, read-only explanation of the source code a change touches:
which functions changed, who calls them, what they call, which tests name them, and which
requirements their files are associated with. It is model-free; **Ask Copilot** only opens chat with a
prompt the person reviews before sending. Nothing here approves, verifies, publishes or gates.

Open it with **Singularity Flow: Code Explainer**, from the Navigator title bar or Source Control
title bar, or from **Explain This Code** in the editor's *Singularity Flow* submenu, which focuses the
function at the cursor (and works on code the change did not touch). **Code Explainer** is one of the
Navigator's main destinations, and *Work tools → Understand changes* lists it too.

## What it shows

- **Dependency graph.** One card per file, one row per function, method or class, laid out in layers:
  callers to the left of what they call. Changed rows carry their `+added −removed` counts and a
  colour bar (new, modified, removed); unchanged rows appear only when they call changed code or are
  called by it. Calls between rows of one file loop around the card's edge. Changed files without
  code (documents, configuration) share one *Other changed files* card. Singularity Flow's own files
  (its governed roots, agent definitions and `.singularity-flow/` state), Git metadata (`.git/`) and
  tool folders such as `node_modules/` are never drawn or listed, whichever path separator the
  platform uses, and **Explain This Code** refuses them: they are not application code. Each file and
  folder carries an icon for its language (Java, Python, TypeScript, JavaScript, C#/F#/VB on .NET,
  shell and PowerShell, and a badge for other languages).

  **View** chooses what the graph covers:
  - **Delta** draws what the Story changed and the code it calls or is called by.
  - **Full** maps every function in the current worktree's code and how they call each other, with
    anything the Story changed still marked as changed. **Folder** limits it to one part of the
    repository: each service or top-level folder, with Maven/Gradle chains such as
    `src/main/java/com/acme` folded into the folder that branches. When the whole worktree is more
    than the full view maps at once, files are taken from every folder in turn, so no folder is left
    out; choose a folder to map it in depth. A repository over the AST budget is listed from the
    worktree by the editor (Git metadata, Singularity Flow records and build output excluded), so its
    folders can still be chosen.

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

## Lenses

The bar under the header chooses how to look at the code. **Code** is everything above: the
dependency graph, the trace, the walkthrough and the repository. The other four lenses read the same
harvest (each file's text, the outline its language service gave and the calls it resolved) and
answer the questions a person asks first. They work for any language; nothing runs the code or asks
a model, and each says what it rests on.

- **Concepts** shows how the code is organised and what it is about.
  - *How it is organised* places each file in one part of an architecture, by the evidence it names:
    - **entry points**: route annotations or registrations, listeners, `main`, a UI root;
    - **user interface**: files that render markup;
    - **cross-cutting**: exception handlers, advice, middleware;
    - **logic**: services, engines, calculators;
    - **data shapes**: DTOs, models, records, files that only declare fields;
    - **storage**: repositories, DAOs, ORM models;
    - **configuration**, **utilities** and **tests**.

    Arrows count the calls between parts, and choosing a part lists its files with the reason each
    is there.
  - *What it is about* lists the words the declarations use most, weighted by what carries them
    (a type name counts more than a field). It folds `eval` into `evaluate`, counts plumbing words
    (`handler`, `request`, `data`) a quarter, and drops grammar words. Related words are those
    sharing names, files and calls.
- **Entities** shows the data the code works with.
  - Declared types: classes, records, structs, interfaces, enums and type aliases, with their fields
    and types. Accessors fold into their field (`data · get/set`) and enums list their values.
    Controllers and services are behaviour, so they are left out.
  - Objects built in code: an object literal a function returns or names, such as
    `{ result, error }`.
  - Component inputs: the props a component destructures.
  - Links: a field whose type names another entity is a *has* link (*many* for a collection), and
    `extends` or `implements` is an *is* link. *Used by* lists the functions whose declarations take
    or return the entity, or whose text builds it with `new`.
- **Data flow** follows data from one entry point, chosen from the list, to everything it reaches.
  - Entry points are found from:
    - a route (`@PostMapping`, `app.post('/x', …)`, `@app.route`, `[HttpPost]`, `HandleFunc`);
    - a UI event (an element's `onClick`, `addEventListener`);
    - a listener or timer;
    - a program start.
  - Steps are the functions the data reaches. A call arrow says what the call hands over,
    `parameter ← argument → where the result goes`, read from the call site and the callee's own
    parameter list.
  - State is `useState` values: who writes them, which components they render as props, and the
    effects that save them.
  - Endpoints are the HTTP response (including the status an exception handler returns for a thrown
    type), browser storage, files, the database, another service, the screen, the clipboard, sound
    and the log.
  - *Changes form here* lists conversions such as `new BigDecimal(n.doubleValue())` or `parseFloat(…)`.
    Two values that reach a comparison by different conversions can disagree.
  - A call into a library is part of its step, and a trivial getter or setter is part of the call
    that reads it.
- **Logic** draws one function's own text as a flowchart, and the inspector reads it as numbered
  sentences ("If …", "Otherwise, if …", "Repeat …", "When …", "If it fails with …", "Return …",
  "Stop with an error: …"). Each sentence links to its line.
  - A decision puts its branches side by side.
  - An else-if chain is one decision whose outcomes are tried in order.
  - A switch or `when` with more than three cases hangs its cases down a spine.
  - A loop draws its way back.
  - It reads brace languages and Python's indentation.

**Matched by name.** When the language service resolves no call between two functions the text
plainly connects, Data flow matches the call by name: by its receiver (`orderService.place(…)` is
`OrderService.place`), within the same file, or through an import of that name. These arrows are
dashed and labelled *(by name)*. A language service still indexing after start-up answers fewer
calls, so **Re-index** once it settles. A Java server often does.

**What the lenses do not mean.**
- A route or event entry is the annotation or attribute the text declares, not a request anyone made.
- A layer is a name, annotation or folder pattern, not a design rule.
- A concept is a word in names.
- An entity link is a type named in a field.
- Data flow is static. Callbacks, reflection, dependency injection and dynamic dispatch can add
  flows it cannot see.

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
| Calls | The editor's call hierarchy (`vscode.prepareCallHierarchy`, incoming and outgoing calls). A JavaScript or TypeScript repository without a `jsconfig.json` or `tsconfig.json` lets the language service see only open files, so the explainer first opens the worktree's other code files in the background (up to 60) and says so in its notes. A file none of whose functions gets a call hierarchy (Java without the Red Hat Java extension in Standard mode, for one) gets the calls Singularity Flow found in the committed code instead (`wm knowledge calls`: matched by name, or resolved by the compiler once the Java semantic pack is warmed), placed on the outline's own cards and marked "from code analysis"; for Java the notes also say what gives the editor its own call hierarchy. | Static resolution only: dynamic dispatch, callbacks and reflection can add calls it cannot see. Calls matched by name can join same-named methods of different classes. |
| Test references | The editor's references, kept only when they are in a test file. | A test that names a function does not prove it exercises the change. |
| Signature and documentation | The editor's hover for the symbol; otherwise the declaration text. | — |
| Complexity | One plus the decision points counted in the function's own text, strings and comments removed. Bands: ≤5 simple, ≤10 moderate, ≤20 complex. | An estimate, not a syntax-tree measurement. |
| Requirements | The change view's `@clause` tags, each bound to the function whose own lines (its leading comment block included) hold it; its region associations (file level); declared `@ac` test tags; and the clauses each requirement's text cites. | A tag is the author's declaration and a file-level association is only that; neither proves a function implements the requirement. |
| Gates | The same readiness gate count the status bar shows, never recounted. | — |

Every sentence in the explanation says which of these it rests on. **How this view was built** (the
*engine* item in the status line) lists, per language, where symbols and calls came from and how many
language-service requests were answered, empty or failed.

## Boundaries

- **Bounded.** Anything cut is named in the view.
  - Per build: at most 40 changed code files, 120 call-hierarchy requests, 240 functions, and 40
    reference and hover lookups.
  - The full view maps up to 60 code files of the whole worktree, or 150 of one chosen folder, taken
    from each folder in turn, and traces calls from up to 100 functions within 360 requests. A
    repository over the AST budget lists at most 5,000 code files from the worktree.
  - The lenses show 14 concepts and 80 entities. A data-flow path has at most 70 nodes, 6 steps deep.
    Logic is drawn for 240 functions of up to 600 lines, 160 statements each.
- **Live but pinned.** A build describes one moment. Saving a file shown, or a newer capture, raises
  *The repository changed since this view was built* with **Refresh**; nothing rebuilds under the reader.
- **Refusals stay where they belong.** When the engine refuses one domain (a Story whose review
  evidence it cannot bind, for example), Lifecycle shows that error. The captured change, the world
  model and the diagnostics are still read on their own, so the explainer keeps its Delta.
- **Closed messages.** The page sends a model id and a symbol, file or call id (and, to open a step
  of a function's logic, a line inside that function); the host resolves it against its own harvest. It never opens a path, runs a command or follows a URL from the page, and a
  repository file opens only when it stays inside the repository.
- **Inert page.** Every name, path and source line is set as text under a nonce-only policy.
- **Export.** *Export JSON* saves the model (functions, calls, metrics, explanations, trace) to a file the
  person chooses. It carries no source text beyond signatures, and `authority: "none"`.
- **Exact diff.** *Compare diff* opens the captured before and after bytes read-only, as the Change
  Explorer does.

The engine half lives in `apps/vscode/src/views/code-explainer-model.ts` (pure, tested by
`test/vscode-code-explainer-model.test.mjs`), the lenses in `code-explainer-lenses.ts` (pure, tested
by `test/vscode-code-explainer-lenses.test.mjs`), the page in `code-explainer-page.ts` (tested by
`test/vscode-code-explainer-page.test.mjs`) and the host in `code-explainer.ts`. The evidence-centred
view of the same capture is the Change Explorer ([Explain for humans](XPL2-EXPLAIN-FOR-HUMANS.md)).
