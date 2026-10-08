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
| L3 domain | What does it mean? | rules (thresholds, matches, refusals, caps, calculations), named limits and where they are applied, what users are told, journeys from an endpoint or UI event to its effects, test cases and what they exercise, functions with rules no test reaches, test titles that contradict the code, `@clause` links, clauses of approved Story specifications |
| L4 system | How does it fit together? | outbound calls, configuration keys (secrets withheld) |
| L5 change | What does a change touch? | hotspots (change count × complexity × importers), files that change together (from commits of at most 20 files, root commits excluded, noting pairs with no import between them), impact sets for every function with rules (callers, importers, tests, files it usually changes with) |

Every observed item cites the exact lines it was read from and a hash of those lines; derived
items (journeys, coverage, drift, hotspots) are computed only from observed items. Each level
reports `ready`, `thin` or `insufficient` with the reason, so an empty level says so in one line
instead of padding a prompt.

## Commands

```bash
singularity-flow wm knowledge build [--area PATH] [--refresh] [--json]
singularity-flow wm knowledge show [overview|business|rules|journeys|entities|tests|system|change] [--focus TEXT] [--max-bytes N]
singularity-flow wm knowledge slice [--role developer|tester|architect|product | --phase PHASE] [--focus TEXT] [--max-bytes N]
singularity-flow wm knowledge items [--kind KIND] [--json]
singularity-flow wm knowledge eval --expected FILE [--json]
singularity-flow wm knowledge explain [--dry-run] [--json]
singularity-flow wm knowledge areas [--json]
singularity-flow wm knowledge confirm ITEM [--note TEXT]
singularity-flow wm knowledge correct ITEM --note TEXT
singularity-flow wm knowledge reject ITEM --note TEXT
```

A build reads the committed tree only (never working files, Singularity Flow's records, Git
metadata or build output) and keeps its result in a machine-local cache under the shared Git
directory, keyed by the exact content and the analyzer's own code, so every Story worktree reuses
it and a new commit or a new analyzer rebuilds it.

### Large repositories

Above 4,000 code files a repository is never read whole. `wm knowledge areas` lists the areas it is
built in (about 1,000 files each, Maven and Gradle source chains folded into the folder that
branches; a folder's own files are an area separate from its subfolders), and `--area PATH` builds
one, cached on its own. A phase prompt builds only the areas the Story touches: those holding the
files it changed, then those whose folder names match the words of its title, description and
acceptance criteria (up to three), merged and marked as partial. A Story that names no area gets no
knowledge slice and a warning instead of a guess. Measured on a generated 12,000-file Java
repository: listing the areas takes about 1 second, building a 500-file area 0.7 seconds.

## Approved specifications

Code says what a repository does; an approved specification says what it was asked to do. A build
reads every Story record under the work-item root at HEAD and, for each phase artifact the record
lists as approved, the committed Markdown, but only while its bytes hash to the value recorded at
approval: a specification edited after approval is listed as not read ("approve it again to use
it"), never presented as approved. Each clause (`[WORK-1:AC-001]`) becomes a `requirement` item
citing its line, with the Story and who approved it. It is linked exactly to code and tests that
tag it in a comment of their own (`// @ac:WORK-1:AC-001` above the test), and, when nothing tags it,
to up to three rules, limits or journeys whose words it shares, shown as "matched by words,
inferred". A word match is a lead for a reader: it never counts as an implementation, and it never
pulls a requirement into a Story's focus. Uploaded Story documents (`DOC-nnn`) are not read.

`wm knowledge show business` is the product owner's view: approved requirements and where they
are met, journeys, rules, what users are told, and the words the code uses (data shapes, enum
values and numeric limits, without component props or hook results).

## Languages and frameworks

The analysis engine reads TypeScript and JavaScript (with JSX), Java, Kotlin, Python, C#, Go and
other C-like languages as text. On top of it:

| Stack | What is read |
|---|---|
| React | routes (`<Route path element>`), UI event handlers to the calls they make, `useReducer` actions, messages set with `setError`/`toast` |
| Spring | `@RequestMapping` endpoints, `@ExceptionHandler` statuses (annotations or `ResponseEntity.status`), `application.properties`/`.yml` keys |
| Android | `AndroidManifest.xml` activities, services, receivers and providers (launcher, exported) and permissions; `settings.gradle` modules; Compose `onClick = { … }` handlers; Room `data class` entities; Retrofit and Feign interfaces as outbound calls, never as endpoints |
| Python | FastAPI and Flask routes, pydantic models, dataclasses and TypedDicts, `except X: raise HTTPException(status_code=…)` statuses, pytest functions |
| Builds | npm scripts, Maven, Gradle (from the folder holding `settings.gradle`), pytest, `go test`, `dotnet test`; build scripts such as `build.gradle.kts` are read as manifests, not code |

## People's reviews

The person who knows the code is the authority. `wm knowledge confirm`, `correct` and `reject`
record a review in `docs/knowledge/confirmations.yml` in the working tree, with the reviewer's Git
identity and the hash of the lines the item cited; commit it with the code it describes, so it goes
through the repository's ordinary review. A confirmed item becomes `confirmed`; a correction is
shown beside the item; a rejected item leaves views and prompts and is listed instead. A derived
item (a test/code disagreement, coverage, impact) is tied to the lines of the item it is about.
When the reviewed lines change, the review stops applying and the item says to review it again; a
review whose item no longer exists is listed as a pitfall, never dropped quietly. Rules are
numbered within their function, so editing a condition keeps the rule's id and its review.
In VS Code, **Repository Knowledge** opens the current build as a preview and **Review Repository
Knowledge** picks an item and records the same confirm, correct or reject review.

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
| intake, specification, requirements | product | approved requirements, journeys, rules, what users are told, data shapes, pitfalls |
| design, architecture, planning | architect | areas, journeys, external calls and configuration, data shapes, hotspots, error paths |
| implementation and others | developer | pitfalls, rules, journeys, data shapes, tests, impact |
| testing, verification, conformance | tester | pitfalls, approved requirements, rules, tests, error paths, journeys |

"Pitfalls" is what a newcomer would get wrong: test/code disagreements, limits and where they are
applied, refusals, and functions with rules no test reaches. The slice travels in the existing
`capability-world-model` prompt section, so prompt budgets and token-reduction contracts apply
unchanged. Turn it off with `worldModel.knowledge.prompt: off`.

## Measuring it

`wm knowledge eval` scores a build against an expectations file (rules, limits, entities, entry
points, journeys, tests, untested functions, drift, error paths, messages, commands, outbound
calls, approved requirements) and names every miss. The fixtures under `test/fixtures/knowledge/` are scored in the test
suite:

| Fixture | Expected items | Found |
|---|---|---|
| React shop (TypeScript, Vitest, one approved and one edited specification) | 28 | 27; the Add button's journey runs through a prop and `useReducer` dispatch, which pattern analysis does not follow |
| Spring orders service (Java, JUnit) | 21 | 21 |
| Android notes app (Kotlin, Gradle modules, Compose, Retrofit, Room, JUnit) | 20 | 20 |
| FastAPI orders service (Python, pydantic, pytest) | 17 | 17 |

## Boundaries

- Pattern analysis, not a compiler: calls are matched by name where no language service answers
  (reported as `callsMatchedByName`), and a dynamic dispatch can be missed.
- Drift is reported only when a test that exercises a rule uses comparative words ("more than",
  "at least") that contradict the rule's operator and shares a value with it.
- Coverage means a test names the function or reaches it through calls, not that a line ran.
- An explanation's check is lexical: a sentence that uses only plain words can still misread what it
  cites, which is why kept sentences stay labelled `inferred`.
- History covers the last 12 months (at most 2,000 commits, merges skipped).
- Requirements come from approved Markdown phase artifacts only; uploaded documents, Jira text and
  unapproved drafts are not read.
