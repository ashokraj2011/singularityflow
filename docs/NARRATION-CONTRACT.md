# Narration contract

Singularity Flow can already perform governed actions. What it has not had is a coherent,
evidence-backed account of *what happened, why it happened, what was preserved, and what the person
should do next* — the same account, in the CLI, in Copilot, in a review packet, in a pull-request
body, and in the VS Code Journey.

That account is the narration plane. It sits over the kernel:

```
deterministic kernel
      ↓
structured result and evidence
      ↓
explanation + preserved guarantees + valid continuation
      ↓
CLI · Copilot · review packet · pull request · Journey
```

**The guardrail is one sentence.** Narration may explain truth and project truth, but it must never
become another place where truth is computed or stored.

## Three contracts, kept apart

| Contract | Responsibility |
|---|---|
| `schemas/reference-envelope.schema.json` | Bounded, model-safe preview of governed evidence — byte limits, hashes, preview safety |
| `schemas/command-result.schema.json` | Outcome, explanation, continuation, and declared state effects |
| `src/narration/messages.mjs` | Human-language rendering of message IDs and reason codes |

The reference envelope is an evidence-transport boundary. `why[]` and `next[]` do not belong in it.
A command result may carry a reference envelope inside `data`; it must never become one.

## The clauses

Clauses marked **enforced** have a mechanical test in `test/narration-contract.test.mjs` or a gate in
`scripts/check.mjs`. The rest are review obligations until their step lands.

| # | Clause | Status |
|---|---|---|
| NCL-001 | Every command returns the command-result schema, version 1. | in migration |
| NCL-002 | Reference-preview envelopes remain independent evidence contracts. | **enforced** |
| NCL-003 | Every refusal declares machine-readable effects. | **enforced** |
| NCL-004 | Refusal reassurance must agree with declared effects. | **enforced** |
| NCL-005 | Every WHY entry has a cataloged reason code and a resolvable source. | **enforced** |
| NCL-006 | Every result has NEXT, remediation, or an explicit rest state. | **enforced** |
| NCL-007 | NEXT actions come from the existing deterministic planners. | **enforced** |
| NCL-008 | NEXT is derived from post-command state. | **enforced** |
| NCL-009 | Terminal prose is rendered only at the output boundary. | in migration |
| NCL-010 | JSON output contains no terminal-only formatting. | **enforced** |
| NCL-011 | Recap consumes normalized beats, not storage events directly. | not started |
| NCL-012 | Beat normalization is deterministic and deduplicated. | not started |
| NCL-013 | Brief recap uses deterministic selection, never a model. | not started |
| NCL-014 | Recap ordering has a stable tie-break rule. | not started |
| NCL-015 | Timezone and locale are pinned rendering inputs. | not started |
| NCL-016 | Quoted user content is normalized, escaped and bounded. | not started |
| NCL-017 | Friendly callbacks retain their immutable provenance reference. | **enforced** |
| NCL-018 | Journey and CLI share planners, not transient envelopes. | partial |
| NCL-019 | Derived forecasts declare source, sample and coverage. | not started |
| NCL-020 | Narration must never become lifecycle authority. | **enforced** |

## Why the effects field exists

Reassurance is the easiest thing in a governance tool to get quietly wrong. "Nothing was submitted.
Nothing was lost." is true when it is written and false two releases later when a handler starts
touching an external system on the same path.

So the guarantee is not the sentence. The guarantee is:

```js
effects: { stateChanged: false, filesChanged: false, publicationCreated: false, externalSystemsChanged: false }
```

`commandResult()` refuses to build a `refused` outcome that declares any effect true, and the
terminal renderer derives its reassurance line from the effects rather than from the catalog. The
catalog's `preserves` flag only marks a message as *permitted* to reassure.

## Why WHY is codes, not prose

A handler-authored `detail: 'phase 1 of your pinned rail is requirements'` is prose distributed
across sixty command modules. It cannot be translated, tested by slot, or improved centrally, and
two handlers will word the same reason differently within a month.

```js
because('phase.selected-by-pinned-rail', 'pin', {
  ref: 'workflow@4af71c2',
  slots: { phase: 'requirements', position: 1 }
})
```

The narrator renders the sentence. The `ref` survives into the rendered line, JSON, review packets
and artifacts, because a citation a reviewer cannot resolve is a claim rather than evidence:

```
  - requirements is phase 1 of the rail this Story pinned when it started
      ↳ pin:workflow@4af71c2
```

## Why the output boundary is scoped, not global

`main` contains roughly a thousand `console.log` and `stdout.write` sites: JSON serialization,
tables, artifact rendering, diagnostics, help text, progress, headlines, refusals. A blanket
"no raw prose" grep would either force one enormous migration or accumulate exceptions until it
means nothing.

The boundary is therefore structural. Handlers return a `commandResult`; `src/narration/render-*.mjs`
own the printing. Enforcement arrives per module as commands migrate, starting with new and lazily
loaded ones, with legacy modules explicitly exempt until their turn.

## Order of work

1. NCL specification and command-result schema — **done**
2. Result constructors and one output boundary — **done**
3. Message catalog and refusal-effects law — **done**
4. Vertical Story slice: `resume`, `submit`, `approve`, `reject`, `status`
5. Planner-derived NEXT and no-dead-ends conformance across the slice
6. Normalized narration beats and deterministic recap
7. Review packet, pull-request description and continuation reuse
8. Story and Initiative Journey adapters
9. Callbacks
10. Foreshadowing
11. Migrate the remaining command catalog incrementally

The vertical slice comes before breadth on purpose: it proves the whole experience on five commands
before several hundred terminal strings are touched.
