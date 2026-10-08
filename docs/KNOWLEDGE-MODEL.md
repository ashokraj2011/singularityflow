# Repository knowledge model

**Implemented boundary:** a deterministic, model-free reading of what a repository's code does,
built from the committed tree at HEAD and added to phase prompts as a short, cited slice. It sits
beside the registered-v4 World Model: v4 stays the governed evidence layer (what exists, with
registered facts and provenance); knowledge says what the code does and means. Nothing here
approves, verifies, publishes or gates.

## Why it exists

A registered-v4 build of a small React shop (a $50 free-shipping threshold, a SAVE10 coupon for
orders of $30 or more, a VIP20 coupon for members only, a quantity cap of 10) published four views
with no business rules, export signatures dealt into sections by hash, and a hotspot view that was
entirely "unavailable". Its extractors read lines with regular expressions, five fact types have no
producer, and its validator only admits extracted fact sentences. Knowledge reads behaviour: the
same build finds every one of those rules with the line it is on.

## Levels

| Level | Answers | Items |
|---|---|---|
| L0 inventory | What is here? | languages, manifests, build and test commands |
| L1 structure | How is it organised? | areas, layers, data shapes (classes, records, interfaces, enums), entry points (routes, HTTP endpoints, `main`), the resolved import graph |
| L2 behaviour | What does the code do? | decision trees per function, calls, data reaching the network, database, storage or screen, error paths from a throw to the HTTP status its handler returns |
| L3 domain | What does it mean? | rules (thresholds, matches, refusals, caps, calculations), named limits and where they are applied, what users are told, journeys from an endpoint or UI event to its effects, test cases and what they exercise, functions with rules no test reaches, test titles that contradict the code, `@clause` links |
| L4 system | How does it fit together? | outbound calls, configuration keys (secrets withheld) |
| L5 change | What does a change touch? | hotspots (change count × complexity × importers), impact sets for every function with rules |

Every observed item cites the exact lines it was read from and a hash of those lines; derived
items (journeys, coverage, drift, hotspots) are computed only from observed items. Each level
reports `ready`, `thin` or `insufficient` with the reason, so an empty level says so in one line
instead of padding a prompt.

## Commands

```bash
singularity-flow wm knowledge build [--area PATH] [--refresh] [--json]
singularity-flow wm knowledge show [overview|rules|journeys|entities|tests|system|change] [--focus TEXT] [--max-bytes N]
singularity-flow wm knowledge slice [--role developer|tester|architect|product | --phase PHASE] [--focus TEXT] [--max-bytes N]
singularity-flow wm knowledge items [--kind KIND] [--json]
singularity-flow wm knowledge eval --expected FILE [--json]
singularity-flow wm knowledge explain [--dry-run] [--json]
```

A build reads the committed tree only (never working files, Singularity Flow's records, Git
metadata or build output) and keeps its result in a machine-local cache under the shared Git
directory, keyed by the exact content and the analyzer's own code, so every Story worktree reuses
it and a new commit or a new analyzer rebuilds it. Repositories above 4,000 code files are built
one area at a time with `--area`; the refusal names the areas.

## Plain-language explanations

`wm knowledge explain` asks the configured model to explain the repository, its journeys and its
rules in plain words. The model receives knowledge items and short excerpts of the lines they cite
(single statements, secret-scanned, quoted as data). Every sentence must list the items it relies
on, and a sentence is kept only if every code name, number and quoted text in it appears in those
items or their excerpts; sentences that cite nothing, cite outside their subject, judge the code
("correct", "secure") or exceed six per subject are rejected and listed. Kept sentences are
`inferred`: they appear under "In plain words" in views and phase slices with that label, are cached
on this machine with the exact knowledge they were checked against, and are never counted as
verified grounding. Composing a prompt never calls a model for them. Without a model the command
says so and changes nothing; `--dry-run` prints the exact prompt.

## In phase prompts

`wm compose` adds one slice per phase, focused on the Story's title, description and acceptance
criteria and kept within `worldModel.knowledge.maxBytes` (default 8192):

| Phase | Reader | Sections, in order |
|---|---|---|
| intake, specification, requirements | product | journeys, rules, what users are told, data shapes, pitfalls |
| design, architecture, planning | architect | areas, journeys, external calls and configuration, data shapes, hotspots, error paths |
| implementation and others | developer | pitfalls, rules, journeys, data shapes, tests, impact |
| testing, verification, conformance | tester | pitfalls, rules, tests, error paths, journeys |

"Pitfalls" is what a newcomer would get wrong: test/code disagreements, limits and where they are
applied, refusals, and functions with rules no test reaches. The slice travels in the existing
`capability-world-model` prompt section, so prompt budgets and token-reduction contracts apply
unchanged. Turn it off with `worldModel.knowledge.prompt: off`.

## Measuring it

`wm knowledge eval` scores a build against an expectations file (rules, limits, entities, entry
points, journeys, tests, untested functions, drift, error paths, messages, commands, outbound
calls) and names every miss. The fixtures under `test/fixtures/knowledge/` are scored in the test
suite:

| Fixture | Expected items | Found |
|---|---|---|
| React shop (TypeScript, Vitest) | 24 | 23; the Add button's journey runs through a prop and `useReducer` dispatch, which pattern analysis does not follow |
| Spring orders service (Java, JUnit) | 21 | 21 |

## Boundaries

- Pattern analysis, not a compiler: calls are matched by name where no language service answers
  (reported as `callsMatchedByName`), and a dynamic dispatch can be missed.
- Drift is reported only when a test that exercises a rule uses comparative words ("more than",
  "at least") that contradict the rule's operator and shares a value with it.
- Coverage means a test names the function or reaches it through calls, not that a line ran.
- An explanation's check is lexical: a sentence that uses only plain words can still misread what it
  cites, which is why kept sentences stay labelled `inferred`.
- Not built yet: IDE review and confirmation of items, co-change history, and per-area incremental
  rebuilds for very large repositories.
