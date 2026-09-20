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
keywords:
  - hunks
  - impact
  - proof
  - narrative
commands:
  - explain
related:
  - delivery-and-proof
  - model-independence
  - world-model
version: 2
---
`singularity-flow explain code` presents one bounded, read-only explanation of the selected
repository's current changes. `/sf-explain-code` resolves the active Story checkout, runs the same
command once, and relays its result without reading or summarizing source files independently.

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

## Related topics

Continue with `sflow explain delivery-and-proof`, `sflow explain model-independence`, or
`sflow explain world-model`.
