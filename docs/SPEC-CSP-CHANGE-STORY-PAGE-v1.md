# What this change does (CSP) — v1: one plain-English page per Story

**Specification ID:** `CSP-v1`

**Status:** building on branch `change-story` (from `main@29c9c43b9`), 2026-11-27.

**Owner, 2026-11-27:**
- "a simple change explanation in prose manner: we had these requirements and acceptance criteria; to satisfy it we
  created/edited these parts of the code; this is the simple explanation of code; and to test that, these were created"
- "a little more explanation of the code in high level ... the why part also"
- "What we changed should have more details, like list methods and what it does, returns, or what part edited, not in
  code way but in English way"
- "after the implementation done it should be available."

**Builds on:**
- the Story's own records: its clauses (`src/comprehension/xpl2/clause-sources.mjs`), each code step's delivered change
  set (`deliveryEvidence`), its test runs (the `test-execution` receipts) and the settled decisions;
- the clause tags in code and tests (`src/source-clause-tags.mjs`);
- the TypeScript compiler's parser and the structural scanner (`src/ast-packs/typescript-core.mjs`,
  `src/ast-packs/polyglot-syntax-core.mjs`, `src/polyglot-lexical.mjs`) for the functions a change touched;
- XPL2's commentary checks (`src/comprehension/xpl2/narration.mjs`) for the words Copilot writes;
- the record documents SFlow already writes (`src/record-documents.mjs`) and the Story's system documents
  (`README.md`, `STATUS.md`, `USER-STORY.md`);
- [WCB](SPEC-WCB-WATCH-CODE-BASE-v1.md)'s record of code changed outside the plan (a `plan-accounting` settlement of class
  `out-of-plan`), when it is on main.

---

## 1. What a person sees

A page, `CHANGE-STORY.md`, in the Story's folder beside `STATUS.md`:

> **What this change does: GRAPH-12, "Plot a function"**
>
> 1. **What we had to do.** The requirement in a sentence or two, then each acceptance criterion with its ID.
> 2. **How it works.** About five plain sentences on the flow through the parts.
> 3. **Why we did it this way.** Bullets, each with its source: "(plan, decision 2)", "(design, decision 1)" or
>    "(Copilot's reason)".
> 4. **What we changed.** Each file, New, Edited or Removed, with the criteria it serves; under it every function it
>    added, changed or removed, in plain words: what it does, what it needs, what it gives back, and for a changed one
>    "What changed: before … now …". The section ends with "Removed: …" or "Removed: nothing."
> 5. **How it was tested.** Each new or changed test with the criterion it covers, then SFlow's own run on the delivered
>    code, "SFlow ran them on the delivered code: 2 passed", or "Tests not run yet".
> 6. **Outside the plan.** Each file the approved plan did not name, "by Copilot: <its reason>" or "by you". Left out
>    when there is no such record.

It shows in five places, all from one builder and one renderer: the Story's documents, the top of the code step's
approval (one line and "open the full page"), the Work page's task view, the pull request description, and
`/sf-explain`.

## 2. The rules

**CSP:REQ-001, SFlow writes every fact.** With no model call, from its own records:
- the requirement and acceptance criteria (the Story's description and its clauses);
- each delivered file, New, Edited or Removed, from the delivered code against the Story's base commit, limited to the
  files a code step delivered (its change set), so a merge from the base branch adds none;
- each file's changed functions, from the parser: a function only after is New, only before is Removed, in both with
  different text is Edited; a small helper the change added and only one other changed function calls folds into one
  line under that caller;
- which criterion each file and test serves, from their `@clause`/`@ac` tags;
- the test names in the delivered test files, and SFlow's own recorded run of them;
- the outside-the-plan list, from WCB's settlements.

**CSP:REQ-002, Copilot writes the English, in the code step.** An optional file, `change-explanation.json`, beside the code
step's document, part of that step's own output (registered and committed with it). Its shape:

```json
{
  "how": "About five plain sentences on how the change works.",
  "functions": {
    "src/graph.mjs": {
      "parseFunction": { "does": "…", "needs": "…", "gives": "…", "changed": "Before …; now …" }
    }
  },
  "reasons": ["A choice the plan did not decide, and why.", { "text": "…", "file": "src/graph.mjs", "function": "plot" }]
}
```

The code step's prompt asks for it in one optional line. Nothing checks that it exists, and nothing waits for it.

**CSP:REQ-003, SFlow checks Copilot's words before showing them.**
- A text with a link, markup, code, control characters or a secret shape is withheld (XPL2's commentary checks), and the
  page says one was withheld.
- An entry is kept only when every file and function it names is in the change.
- A changed function with no kept entry reads "not described yet"; no "How" reads "Not described yet".
- Missing or withheld English never refuses, holds or asks anything.

**CSP:REQ-004, why from the documents first.** Each decision in an approved plan or design step's "decisions" section
(a heading with "decision" in it: its bullets, numbered items or table rows) is a reason, "(plan, decision N)" or
"(design, decision N)". Copilot's reasons follow, "(Copilot's reason)".

**CSP:REQ-005, when it is written.** Inside the lifecycle commit of:
- a code step's publication and its submission (each version);
- any later step's publication and submission, while a code step has a published version, so a test step's run fills
  the tests section and a later version rewrites the page.

It is a Story record (the Story's folder, outside `artifacts/`): no step registers it, no gate counts it, and it is not
in the code tree a delivery or a test run is bound to. A page that cannot be built is skipped; the commit goes on.

**CSP:REQ-006, timing.** Available once the code step has a published version. Until SFlow has a recorded test run on the
delivered code (a separate test step), the tests section lists the tests and says "Tests not run yet".

**CSP:REQ-007, the approval.** The code step's approval item (`decisions`, the Decide card and the VS Code approval page)
starts with one line, "What this change does: <files, functions, tests>", and `details.changeStory` with the page's
path and the read that prints it. The VS Code pages open it in a Markdown preview.

**CSP:REQ-008, the Work page.** `work status` returns `changeStory` (its path and summary); the task view shows the line
and "What this change does", which opens the page in a Markdown preview.

**CSP:REQ-009, the pull request.** `pr describe` adds the page (without its title) under "What this change does".

**CSP:REQ-010, the read.** `singularity-flow explain --subject change --page [--work-id ID] [--json]` prints the page:
the one SFlow wrote, or, when there is none yet, the page built now from the records (nothing is written).
`/sf-explain`, asked what the change did, answers from it.

**CSP:REQ-011, no new stop.** No new refusal, question, decision or approval anywhere. A skill step that declares its
outputs accepts `change-explanation.json` as an optional one.

## 3. Acceptance

- **CSP:AC-001** After a code step's publication the Story's folder holds `CHANGE-STORY.md` with the six sections (the
  sixth only with a WCB record), each changed file marked, and each changed function listed.
- **CSP:AC-002** A changed function with no kept English reads "not described yet"; a withheld text is not shown.
- **CSP:AC-003** A plan decision reads "(plan, decision N)"; a reason in the explanation file reads "(Copilot's reason)".
- **CSP:AC-004** With no test run on the delivered code the tests section says "Tests not run yet"; after SFlow's run it
  says how many passed.
- **CSP:AC-005** The page changes no delivery, test or review digest, and no gate counts it.
- **CSP:AC-006** The code step's approval item starts with the page's line and names the read.
- **CSP:AC-007** `explain --subject change --page` prints the page.

Tests: `test/change-story-page.test.mjs` (the builder: facts, functions, the fallback, withholding, reasons' sources)
and `test/change-story-journey.test.mjs` (a real Story: intake, code, test).

## 4. Milestones

- **M1** The builder, the function list, Copilot's file and its checks, the renderer.
- **M2** Written in the lifecycle commits; a system document; the read; `/sf-explain`; the code step's prompt line.
- **M3** The approval line, the Decide card, the VS Code approval page and Work page, `work status`, the pull request.
- **M4** The journey test and the merge checks.
