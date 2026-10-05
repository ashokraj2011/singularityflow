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
version: 7
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
  `--clause`, or `--since` selector.
- **Copilot:** `/sf-explain-code` resolves the governed repository boundary and relays the same
  computed result. Model narration is separate and optional.
- **VS Code:** the extension renders the engine result and does not manufacture missing impact or
  proof. **Change Explorer** (a tab of the Comprehension Center, also its own command) draws the
  same subject view as a map of intent, changed code and recorded results, with an inventory, an
  inspector and an exact native diff. **Code Explanation** is the per-hunk list of why each change
  is there. Open them from any of these, in a governed repository:
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
to the documentation search. `--narrate` is not offered for subjects in this release.

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
- If narration is refused or invalid, use the unchanged computed result; no governed evidence was
  lost.
- If a subject view says `bounded-delivery`, narrow the question with `--subject line` or
  `--subject clause`, or raise `--max-bytes`; the counts already cover the whole change.
- If the Change Explorer says the snapshot changed, refresh it; it never mixes two captures.
- If right-click menus have no **Singularity Flow** entry, no governed repository is selected in
  this window yet. Open the Singularity Flow sidebar or choose a workspace, and the menus appear.

## Related topics

Continue with `sflow explain delivery-and-proof`, `sflow explain model-independence`, or
`sflow explain world-model`.
