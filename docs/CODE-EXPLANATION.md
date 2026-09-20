# Code explanation (`XPL`)

**Implemented boundary:** amended, read-only, observe-only explanation of the selected repository's
current changes. The command is useful for review, but its output is not a Candidate approval,
verification verdict, publication gate, or durable cause record.

Code explanation keeps two layers separate:

1. a deterministic computed explanation assembled from the current bounded comprehension
   projections; and
2. an optional model-assisted narrative whose ID selection is untrusted and whose displayed prose
   is rendered from computed records by the kernel; it is visibly advisory and never promoted into
   the computed explanation.

The current tranche deliberately does not claim the full authority or acceptance criteria of the
original XPL draft. [Deferred authority](#deferred-authority-and-original-xpl-criteria) lists the
remaining prerequisites.

## Public routes

The terminal route is:

```text
singularity-flow explain code
  [--hunk ID | --symbol ID | --clause ID]
  [--since REVISION]
  [--narrate]
  [--length brief|standard|long]
  [--json]
```

`sflow` is the equivalent short executable name. The exact second positional, `code`, selects this
repository-bound operation. Every other `singularity-flow explain <topic-or-question>` form remains
the global, repository-independent documentation service.

Copilot exposes the same operation as:

```text
/sf-explain-code
  [--hunk ID | --symbol ID | --clause ID]
  [--since REVISION]
  [--narrate]
  [--length brief|standard|long]
  [--json]
```

The skill resolves the active Story checkout, runs exactly one CLI command, and relays the returned
sections, warnings, authority labels, IDs, and next actions. It does not read source files or create
its own account of the diff. The shell command may also run directly in an explicitly selected Git
repository.

`--narrate` selects the optional `explain.code.narrate` operation. Without it, the registered
`explain.code` operation is model-free. `--no-model`, a disabled model policy, or an unavailable
provider preserves the computed explanation as the automatic fallback. `--length` is accepted only
with `--narrate`; using it on the computed-only route is refused.

## Subject and interval

This tranche describes the exact repository change-set compatibility subject returned by the
comprehension layer. It is a baseline-to-current observation that can include index, working-tree,
and untracked resources. It is not labelled as the universal persisted publication Candidate.

Without `--since`, the existing comprehension baseline precedence selects and reports the baseline.
`--since REVISION` selects an explicit Git baseline for the observation. It does **not** mean “since
another retained Revision Loop Candidate,” and it does not infer candidate ancestry or reconstruct
discarded attempts. An invalid or unavailable revision is refused rather than silently replaced
with another baseline.

## Fixed computed sections

The computed result always preserves the following order. JSON uses the stable section names shown
in parentheses.

The JSON envelope also reports `candidate`, `query`, integrity-checked `sources`, `counts`,
`availability`, and `unexplained`. `explanationSetSha256` identifies the complete unfiltered unit
set and its admitted sources; `explanationSha256` identifies the returned projection, including a
drill-down. Neither hash makes the projection authoritative.

### Why each change is there (`whyEachChange`)

Every observable change unit appears in this section in the complete result. A drill-down returns a
pure subset of these same units.

- A tracked textual Git hunk receives a deterministic `H-NNN` identifier and exact before/after
  coordinates.
- A tracked binary or metadata-only change, and an untracked resource whose body is deliberately
  excluded, receives a deterministic `O-NNN` opaque change unit. The result states that textual or
  semantic detail is unavailable; it does not omit the resource.
- Cached symbol matches may be shown as navigation hints only when the cached declaration line
  overlaps the current side of a hunk. There is no enclosing-symbol inference. The match does not
  establish declaration ownership, semantic segmentation, or completeness.
- An integrity-valid graph may expose references scoped to the containing change region, including
  clause IDs. Those references are explicitly `hunkBound: false`; the unit's cause remains
  unavailable with `region-cause-not-hunk-bound`. Without such references, hunk-level cause
  authority is unavailable. In both cases every textual hunk remains `unexplained` in this tranche.

One hunk may intersect more than one navigation hint. The current result does not turn that overlap
into a claim that one declaration owns the hunk.

### What it touches (`impact`)

The current impact projection is always explicit but unavailable:
`reason: repository-impact-not-projected` and `truth: null`. Its callers, importers, tests, and
contracts collections remain empty. Changed paths and cached declaration-line hints remain visible
on the change units; they are not promoted into repository-impact claims.

Callers, importers, test impact, exported-contract effects, and semantic dependency completeness
remain unavailable until an exact Candidate-bound World-Model authority join exists. An empty
collection is therefore never rendered as “zero callers,” “no importers,” “no affected tests,” or
“contract unchanged.”

### What is proven and what is not (`proof`)

The current proof projection is also always explicit but unavailable:
`reason: candidate-bound-hunk-proof-not-projected`. An integrity-valid evidence projection may be
acknowledged by hash in `sources`, but it is never upgraded into a per-hunk clause, record, passing
result, or coverage statement.

The proof object reserves the vocabulary `passed-current`, `ready`, `owed`, and `stale` for a future
authoritative adapter; it asserts none of those statuses today. In particular, this tranche does not
infer changed-line coverage, test-to-hunk coverage, requirement satisfaction, or a verification
verdict from path adjacency or the mere presence of evidence.

## Drill-downs

Drill-downs are deterministic filters over the same computed result; they do not start a second
analysis or widen its authority.

- `--hunk ID` selects the exact returned `H-NNN` change unit.
- `--symbol ID` selects exact cached symbol references already present in the projection. Names are
  not fuzzy-matched and ambiguous identifiers are not guessed.
- `--clause ID` selects exact recorded clause/cause references already present in the projection.
- `--since REVISION` changes the explicit Git baseline before the same projection is built.

Only one of `--hunk`, `--symbol`, or `--clause` may be selected. A well-formed identifier with no
match produces an empty or unavailable result with its reason; it does not fall back to grep, a
model, chat history, or a similarly named subject.

## Optional advisory narration

When model execution is enabled and the user explicitly passes `--narrate`, the narrative receives
the bounded computed JSON only. It receives no full source files, repository search, tools, chat
history, or independent evidence access.

The model can select and order admitted citation IDs; it cannot author displayed facts. The kernel
treats that selection as untrusted typed input and renders record-owned sentences before display:

- every displayed sentence is derived from one exact admitted ID;
- unknown or uncited selections are dropped and counted;
- model-proposed prose is discarded, so unrelated assertions, unsupported correctness language,
  and terminal control sequences cannot cross the narrative boundary;
- `--length brief|standard|long` selects a ceiling of 100, 250, or 500 words respectively
  (`standard` is the default); and
- the displayed block is headed `Narrative — advisory, not a record` and has `authority: none` in
  JSON.

Narration never changes the computed sections. A malformed, timed-out, cancelled, unavailable, or
policy-disabled narration degrades to the computed explanation and reports narration unavailable.
It cannot make the read fail closed around otherwise available computed facts.

Singularity Flow does not persist narrative bytes as evidence, a receipt, a comprehension record,
or an input to a check. The ordinary content-free model-invocation audit may record operation,
status, and usage. Terminal scrollback, Copilot chat, and the selected provider can have their own
retention policies; “not persisted by Singularity Flow” is not a claim that those external surfaces
store nothing.

## Degradation is data, not inference

| Condition | Result |
|---|---|
| No changed resources | The three fixed sections remain present with zero observable units. |
| Untracked resource | Path and opaque unit remain visible; body, textual hunk, and semantics are unavailable. |
| Binary, mode-only, or metadata change | Opaque unit remains visible; no textual or declaration claim is made. |
| Bounded patch unavailable or too large | Resource units remain visible; hunk coordinates and patch detail are unavailable. |
| AST cache disabled, missing, stale, or unsupported | Symbol/declaration detail is unavailable; no cache is built or repaired by this read. |
| Region-scoped graph references exist | References may be exposed with `hunkBound: false`; cause remains unavailable and the hunk remains unexplained. |
| No usable graph reference | Hunk-level cause authority is unavailable; filenames, prose, and chronology are not substituted for cause. |
| Integrity-valid recorded evidence exists | Its projection hash may be listed as a source; proof remains unavailable and no per-hunk status is inferred. |
| Evidence is missing, mismatched, or fails integrity checks | Its source hash is omitted and proof remains unavailable; it is not promoted to a pass. |
| Drill-down has no exact match | The filtered result is empty or unavailable with a reason code. |
| Narration cannot run or validate | The computed explanation is returned unchanged and narration is marked unavailable. |

These states are non-blocking. No explanation failure can submit, approve, reject, publish, repair,
or otherwise change lifecycle state.

## Surfaces

- **Terminal:** human output keeps the three fixed sections in order; `--json` returns their bounded
  structured form and exact availability metadata.
- **Copilot:** `/sf-explain-code` is a one-command relay. Narrative requires an explicit request.
- **VS Code:** the Comprehension Center exposes the computed explanation through its leased,
  read-only comprehension snapshot. Its narrative button only prefills
  `/sf-explain-code --narrate` in Copilot with partial-query mode; it never submits or invokes the
  model until the user reviews and sends the request.

The three surfaces consume the engine result. UI state, skill prose, and webview state are never
authority.

## Security and privacy boundary

- The computed operation is read-only and model-free. It performs no lifecycle mutation and grants
  no authority.
- Repository paths in evidence are normalized repository-relative paths. A drill-down cannot escape
  the selected repository.
- Drill-down values are capped at 512 UTF-8 bytes and reject NUL bytes; hunk IDs must have the
  `H-NNN` form. Missing and ambiguous subjects never trigger a search fallback.
- Untracked file bodies are not copied into the bounded patch projection because newly created files
  may contain credentials.
- Manifest, diff, cached-symbol, graph, and evidence bindings are checked before their identities or
  facts are admitted. Machine-local checkout paths are excluded from the canonical explanation.
- The change set is captured again after the patch, cache, graph, and evidence reads. If the
  repository moved, the whole projection retries once and then refuses instead of mixing two
  working-tree moments under one digest.
- Optional narration receives only the computed JSON and cannot invoke tools. Computed strings are
  treated as untrusted data, not instructions.
- Narrative IDs are checked against a closed kernel catalog; displayed prose comes from that catalog.
  Citation presence does not upgrade a statement's assurance or prove correctness.
- Model-provider routing, `--no-model`, input/output bounds, cancellation, and content-free usage
  accounting use the existing model-operation boundary. Story-scoped requests retain the exact
  work ID and phase in prompt-audit and usage attribution.
- No per-person productivity metric is produced.

## Deferred authority and original XPL criteria

This implementation is an inspection aid, not completion of the original XPL acceptance matrix.
The following work remains before stronger claims are permitted:

1. Bind comprehension to the same immutable persisted Candidate used by verification, review,
   approval, publication, and recovery rather than a repository-change-set compatibility subject.
2. Install durable governed cause records and current authority joins for requirements, decisions,
   feedback, refusals, repairs, and supersession.
3. Define and qualify versioned cross-language hunk-to-declaration segmentation with byte coverage,
   overlap rules, deletion/binary/rename fallbacks, extractor identity, and a cross-platform corpus.
4. Join exact Candidate-bound World-Model facts with completeness envelopes before reporting callers,
   importers, contract effects, or structural absence.
5. Verify exact Candidate-bound test/witness receipts and an explicit coverage adapter before
   reporting changed-line or test-to-hunk coverage.
6. Expose retained Revision Loop lineage before `--since` can mean a delta between two retained
   Candidates or include reverted/discarded attempts.
7. Prove canonical cross-machine byte identity for the computed payload across supported platforms,
   with policy, evidence cut, extractor/view versions, and baseline included in its subject key.
8. Complete the authoritative VS Code structural/evidence views and any future explicitly requested
   narrative UI without turning a webview into authority.

Accordingly:

- observable change-unit accounting is implemented, but region-scoped graph references are not
  hunk-bound causes and semantic declaration ownership is not claimed;
- deterministic local filtering is implemented, but universal cross-machine byte identity is not
  claimed;
- `--since` is an explicit Git-baseline comparison, not retained-Candidate lineage;
- impact and per-hunk proof are explicitly unavailable; integrity-valid source projection hashes do
  not substitute for either authority; and
- narration is advisory with content-free invocation auditing, not an `advisory` evidence or Token
  Ledger row.

Use the returned availability and reason fields as the source of truth. Do not convert an unavailable
field into a negative fact or a missing authority into a positive explanation.
