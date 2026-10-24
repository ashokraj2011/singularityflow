---
id: code-explanation
title: Explain current code changes
aliases:
  - explain-code
  - generated-code-explanation
  - code-walkthrough
questions:
  - What changed in the generated code?
  - Why is each current code change present?
  - What evidence exists for the current code changes?
  - Which change unit does this line belong to?
  - What is known, and what is not recorded, about this requirement?
  - Which turn wrote this line?
  - What moved since the last time I looked?
keywords:
  - hunks
  - impact
  - proof
  - narrative
  - subject
  - change-explorer
commands:
  - explain
related:
  - delivery-and-proof
  - model-independence
  - world-model
version: 13
---
## Purpose and prerequisites

`singularity-flow explain code` presents one bounded, read-only explanation of the selected
repository's current changes. `/sf-explain-code` resolves the active Story checkout, runs the same
command once, and relays its result without reading or summarizing source files independently.

Run it from a selected Git repository. A ready Story session improves the available grounding but
the computed layer remains explicit about every unavailable join.

Explanations cover application code only. Singularity Flow's own files (`singularity/`,
`.github/agents/`, every root `singularity/workflow.yml` configures, and `.singularity-flow/`
state such as Story worktrees) are never shown as changes. They are counted instead: the headline
says how many were left out, and the JSON reports them under `scope`.

## Use it from each surface

- **Shell:** `singularity-flow explain code --json`, optionally with one exact `--hunk`, `--symbol`,
  `--clause`, or `--since` selector. `singularity-flow explain code --repository [--path DIR] --json`
  explains what the repository, or one folder or file of it, holds.
- **Copilot:** `/sf-explain-code` resolves the repository boundary and relays the same
  computed result. Model narration is separate and optional.
- **VS Code:** the extension renders the engine result and does not manufacture missing impact or
  proof. **Change Explorer** (a tab of the Comprehension Center, also its own command) draws the
  same subject view as a map of intent, changed code and recorded results, with an inventory, an
  inspector and an exact native diff. **Code Explanation** is the per-hunk list of why each change
  is there. Open them from any of these, in a repository:
  - right-click in a file → **Singularity Flow** → **Explain This Change** (the change at the
    cursor), **Explain Changes in This File**, **Change Explorer**, **Code Explanation**;
  - right-click a file in the Explorer → **Singularity Flow** → **Explain Changes in This File**;
  - the editor title's **Explain Changes in This File** button;
  - Source Control: the **Change Explorer** button, or right-click a changed file;
  - the Singularity Flow sidebar: **Work → Explain changes**, or the title bar's Change Explorer
    button and its **…** menu;
  - the Command Palette: **Singularity Flow: Explain This Change**, **Explain Changes in This
    File**, **Change Explorer** or **Code Explanation**.

  A line outside every changed hunk, or a file with no change in the snapshot, opens the Change
  Explorer with a note saying so. Unsaved edits are not part of the snapshot.
- **Subjects:** `singularity-flow explain --subject change|clause|test|line|gap|generation --json`
  asks one exact question over the same capture. `/sf-explain` relays it in Copilot.

## Guided workflow

The computed result always contains `whyEachChange`, `impact`, and `proof`. It is deterministic for
its reported local inputs, model-free, `observe-only`, and non-authoritative. Tracked textual hunks
receive `H-NNN` IDs. Binary, metadata-only, and untracked resources remain visible as `O-NNN`
opaque units with explicit unavailable detail. Every textual hunk remains unexplained: integrity-
valid region-scoped graph references may be shown, but they are explicitly not hunk-bound causes.
Cached symbols are declaration-line navigation hints only. Current `impact` is
unavailable with `repository-impact-not-projected`; current per-hunk `proof` is unavailable with
`candidate-bound-hunk-proof-not-projected`. An integrity-valid evidence source hash does not upgrade
either section. Callers, importers, affected tests, contract effects, and structural absence remain
unavailable without exact Candidate-bound authority joins.

Use one exact drill-down when needed:

```text
singularity-flow explain code --hunk H-001 --json
singularity-flow explain code --symbol SYMBOL-ID --json
singularity-flow explain code --clause CLAUSE-ID --json
singularity-flow explain code --since REVISION --json
```

Drill-downs filter the same computed records. They never fuzzy-match, use chat history, or ask a
model to fill a gap. `--since` selects a Git baseline; it is not retained Revision Loop Candidate
lineage.

Review the computed records first. Request narration only when an advisory reader-facing summary is
useful, and keep the computed IDs visible so every accepted sentence remains traceable.

## Explain the whole repository

`singularity-flow explain code --repository` lists the application code a repository holds:
- its folders, with file counts, languages and test files;
- each file's declarations from the AST index;
- every `@clause` and `@ac` tag, and the clauses those tags name.

When a workspace clones, adopts or repairs a repository whose code fits the AST budget
(`ast.budgets`, 500 files and 20 MiB by default), it indexes that code in the background, so the
explanation is ready from the start. A larger repository is explained one folder or file at a time:
the answer lists its folders, and `--path <folder>` explains and indexes just that scope on request.
Files that differ from HEAD are read from the working tree. Only the local, disposable AST cache is
ever written.

## Ask one exact question with `--subject`

```text
singularity-flow explain --subject change --json
singularity-flow explain --subject clause --id ORD:AC-001 --json
singularity-flow explain --subject test --id TEST-OR-COMMAND --json
singularity-flow explain --subject line --path src/a.ts --line 42 [--side before] --json
singularity-flow explain --subject gap --json
singularity-flow explain --subject generation --phase implementation --gen 2 --json
```

Each subject view is built from the same leased capture as `explain code`. Every sentence is a
registered template over typed arguments and cites admitted sources or the read observation that
found something absent; `not recorded`, `disabled`, `unavailable` and `not applicable` stay
distinct. A region-level association is never shown as hunk-level, a declared test tag is a mapping,
not coverage, and no test-to-clause-to-code join is inferred.

The change and clause views show how a change links to the Story's clauses as soon as the code is
written: a `@clause:NS:REQ-001` comment in changed code (the text after the ID is the author's note
on how the code meets it), an `@ac:NS:AC-001` comment in a changed test, and a clause whose
specification text names another clause. Each tag says whether this change wrote it. Ask
`--subject clause --id NS:REQ-001` to see the clause's text, the clauses it cites and that cite it,
and the code and tests that tag it. A tag is the author's declaration, not proof that the code
meets the clause. `--for reviewer|auditor|developer`
reorders and folds statements without changing the set or its hashes. Output is bounded to 64 KiB by
default; a bounded page says so and keeps the full counts. Unknown subjects are refused, never sent
to the documentation search.

Every subject view carries a fixed reading tour, the same for every audience: what it is for, what
changed, why it is linked, what was checked, what needs attention or is unknown, how it was
produced, and one safe thing to inspect next. The VS Code Change Explorer shows it under **Read this
change**, and **Copy summary** copies it. No model is involved.

`--narrate [--length brief|standard|long]` asks a model to order the same computed statements into a
short reading. It is a separate optional operation (`explain.subject.narrate`): the model sees only
the statements, their citations and the attention list, may only choose statement IDs under fixed
headings, and any text it writes is discarded. Attention statements are always shown, and the
summary says how many statements it did not cover. It is labelled
`AI-organized summary — record-derived, advisory`, is never stored, and never changes the computed
view or its hashes. `--commentary` additionally allows free text labelled
`AI commentary — semantic support unverified`; it is withheld, with the reason, when it carries
markup, links, control characters, secret-shaped or oversized text, or cites IDs that are not
statements. With models off the narration is reported unavailable and the computed view is
unchanged. In a terminal the narration comes first, under its banner and headings with each
statement's own text and citations, followed by the commentary's state and then the unchanged record
view.

Recorded checks come from their owners: the test attempts a phase's delivery bound (each checked
against its recorded digest), each acceptance criterion's witness as the verification owner judges
it, and evidence-reuse decisions with their owner's state. A reused run is never shown as a new run,
and nothing is carried forward unless that owner says it still applies. `--subject line` adds the
commit that last changed the line at the baseline (an added or changed line is not in the
baseline's history), and
`--subject generation` lists this machine's model invocations, prompt-log entries (never their text),
the entries the prompt log's retention removed (it keeps a text-free note of each), recorded writes
and test attempts for that generation.

**Who wrote a line.** In an explicit SFlow Copilot turn, every successful file edit is recorded on
this machine: the path, the SHA-256 of its bytes before and after, the lines it changed, and the
turn, skill and Copilot session that made it (never content or arguments). A write is checked
against the tool's own arguments; one that cannot be checked is kept but never credited.
`--subject line` names the turn whose write changed the line last only when the recorded writes
explain the file exactly, from the bytes before the change that holds the line (the baseline, or
the commit `git blame` names) to the bytes that hold it now. Otherwise it stays
`origin-unestablished` and says why: no recorded write, bytes no write left (someone or something
unrecorded changed the file), an unrecorded change in between, an unchecked write, or more than one
writer. Terminal commands and edits outside explicit turns are not recorded. Records are kept for 14
days and are this machine's only.

**Compare with an earlier view.** Every change view is retained on this machine (only what a
comparison needs: no statement text or file bytes; 64 views, 14 days). `explain --subject change
--compare previous` compares the current change with the previous view of the same Story, unit by
unit, the way the Change Explorer's *Snapshot changed* banner does; `--compare SNAPSHOT-ID` names
one (each view reports its own ID). Changes are compared by their content, never by display ID.

Exact links come from the implementation bindings a code-delivery step records: each clause bound
to the exact changed lines of its planned paths, with the author's explanation and the approval's
decision about it. A binding joins a change unit only while the file holds exactly the delivered
bytes; after a later edit it is reported as not joined. Several clauses can bind one unit, which is
still counted once. A binding is a mapping a person reviewed, not proof that the code meets the
clause. Repository impact remains unavailable: no impact producer is keyed to an exact change.

## State and safety

`--narrate [--length brief|standard|long]` requests a separate optional model operation. The three
lengths allow at most 100, 250, or 500 words; `standard` is the default. The model receives only the
computed JSON and no tools or full source. Every accepted sentence cites admitted IDs and appears under
`Narrative — advisory, not a record`. The model selects citation IDs; the kernel discards proposed
prose and renders facts from the admitted computed records, so a cited hallucination cannot cross
the boundary. Invalid or unavailable narration falls back to the unchanged computed result.
Singularity Flow persists no narrative bytes as evidence or receipts, although content-free
invocation usage and external terminal, chat, or provider retention can still apply.
`--length` without `--narrate` is refused.

This feature does not approve a Candidate, prove a requirement, report complete callers or changed-
line coverage, or gate publication. See [Code explanation](../CODE-EXPLANATION.md) for degradation,
security, privacy, and the deferred authority prerequisites.

## Troubleshooting

- If no current change is available, verify the selected repository and Story worktree before
  retrying; do not search the home directory for another checkout.
- If a hunk, symbol, or clause is unavailable, use an ID returned by the unfiltered computed result.
- If impact or proof reports an unavailable reason, treat that reason as the result. Narration cannot
  upgrade missing Candidate-bound authority.
- If narration is refused or invalid, use the unchanged computed result; no evidence was
  lost.
- If a subject view says `bounded-delivery`, narrow the question with `--subject line` or
  `--subject clause`, or raise `--max-bytes`; the counts already cover the whole change.
- If the Change Explorer says the snapshot changed, refresh it; it never mixes two captures.
- If `--compare` says no snapshot matches, run `explain --subject change --compare previous --json`;
  snapshots are retained only on this machine and expire after 14 days unseen.
- If a line's writer is not established, the reason is the answer: only explicit SFlow turns'
  checked edits are recorded, and any unrecorded change to the file since leaves it unestablished.
- If right-click menus have no **Singularity Flow** entry, no repository is selected in
  this window yet. Open the Singularity Flow sidebar or choose a workspace, and the menus appear.
- If `--repository` says the code is over the AST budget, ask about one folder with `--path`, or raise
  `ast.budgets` in `singularity/workflow.yml` when indexing the whole repository is acceptable.
- If `--repository` lists no declarations, check that AST is not `off` (`sflow wm ast doctor`).

## Related topics

Continue with `sflow explain delivery-and-proof`, `sflow explain model-independence`, or
`sflow explain world-model`.
