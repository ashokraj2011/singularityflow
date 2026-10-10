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
| L5 change | What does a change touch? | hotspots (change count × complexity × importers × fix commits, with who changes the file), files that change together (from commits of at most 20 files, root commits excluded, noting pairs with no import between them), impact sets for every function with rules (callers, importers, tests, files it usually changes with), function risk (complexity, callers, rules, test reach, how often its file changes and needed a fix), every function's line span |

Every observed item cites the exact lines it was read from and a hash of those lines; derived
items (journeys, coverage, drift, hotspots) are computed only from observed items. Each level
reports `ready`, `thin` or `insufficient` with the reason, so an empty level says so in one line
instead of padding a prompt.

## Commands

```bash
singularity-flow wm knowledge build [--area PATH] [--refresh] [--json]
singularity-flow wm knowledge show [overview|business|rules|contracts|journeys|entities|tests|system|change] [--focus TEXT] [--max-bytes N] [--base REF]
singularity-flow wm knowledge slice [--role developer|tester|architect|product | --phase PHASE] [--focus TEXT] [--max-bytes N]
singularity-flow wm knowledge items [--kind KIND] [--json]
singularity-flow wm knowledge eval --expected FILE [--json]
singularity-flow wm knowledge explain [--refresh] [--dry-run] [--json]
singularity-flow wm knowledge brief [--ref BRANCH] [--phase PHASE] [--focus TEXT] [--refresh] [--cached] [--dry-run] [--json]
singularity-flow wm knowledge calls [--path PREFIX] [--json]   # each call, with where both ends are defined
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
| Micronaut | `@Controller("/path")` with `@Get`/`@Post`/`@Put`/`@Delete`/`@Patch` endpoints; declarative `@Client` interfaces as outbound calls, never as endpoints; `io.micronaut` builds named as the framework |
| Android | `AndroidManifest.xml` activities, services, receivers and providers (launcher, exported) and permissions; `settings.gradle` modules; Compose `onClick = { … }` handlers; Room `data class` entities; Retrofit and Feign interfaces as outbound calls, never as endpoints |
| Python | FastAPI and Flask routes, pydantic models, dataclasses and TypedDicts, `except X: raise HTTPException(status_code=…)` statuses, pytest functions |
| Validation | Bean Validation on fields, records and Kotlin `@field:` (`@NotNull`, `@NotBlank`, `@Min`, `@Max`, `@DecimalMin`, `@Size`, `@Pattern`, `@Email`, `@Positive`, …) and which types an endpoint validates (`@Valid`/`@Validated` request bodies); pydantic `Field(gt=…, max_length=…)`, `conint`, `constr`; zod `z.object({ … })` chains; class-validator decorators |
| Rule files | JSON and YAML rule objects in rule folders (`rules/`, `policies/`, `decisions/`, `decision-tables/`, …) or files named `*rules.json|yml`: a condition (`when`, `if`, `condition`, …) and an outcome (`then`, `action`, `outcome`, `decision`, …), with conditions written as `{ field, op, value }`, `all`/`any` groups or `{ age: { gte: 18 } }`; values under secret-like keys, or flagged by the secret scanner, are withheld. Rule files are not read as configuration keys |
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

## Repository brief

`wm knowledge brief` gives every view a person or a phase needs, each statement with its source:
**Business rules** (`biz.rules`), **Contracts** (`arch.contracts`), **Flows**, **Change impact**
(`dev.impact`), **Risks** (`dev.hotspots`) and **Questions for the product owner**.

- **Evidence:** this knowledge (code rules with their messages and HTTP statuses, endpoints, data
  shapes, flows, tests, history, approved requirements) plus rule-like statements from README files,
  `docs/` and architecture decision records at the same commit, each with its heading. Each piece of
  evidence gets a short ID.
- **With the model on**, the model writes every view from that evidence in plain business language.
  Each statement must cite evidence IDs, and it is kept only if every code name, number and quoted
  text in it appears in what it cites; statements that cite nothing, cite unknown evidence or judge
  the code are dropped and listed. A view the model leaves empty shows its evidence instead. The
  result is cached on this machine for the same evidence, prompt and model, and shown instead of
  asking again; `--refresh` writes it again. When this knowledge has no plain-language explanations
  yet, the same model call writes them too (see below), so Copilot's fixed per-call prompt of about
  11,400 tokens is paid once for both. Each is still checked against its own evidence and cached
  separately; `--refresh` rewrites only the brief.
- **Without a model** (or with `--cached`), a brief the model wrote earlier for the same
  evidence is shown; otherwise the evidence itself, with fixed sentences. Questions then come from
  rules no test reaches, documented HTTP statuses no code rule returns, and documented names the
  code never uses.
- `--phase` orders the views for that phase's reader (product, architect, developer or tester).
  `--dry-run` prints the exact prompt, including the explanation task when it would be added.
- It reads the checked-out commit. When that commit has no code, it reads the most recently
  committed local or remote branch that has code instead, and says which; `--ref BRANCH` names one.
  Another branch is read from Git's objects: nothing is checked out or cloned; in a partial clone the
  files it reads are downloaded into `.git` first. Singularity Flow's own branches (`sflow/*`, the
  state ledger) are never offered. A commit with no code and no rule-like docs is not sent to the model.
- It works in any Git repository, and reads the one it is run in even when a Singularity Flow
  workspace is selected (the selection is used only when no repository is open). Without `singularity/workflow.yml` the model is Copilot CLI
  (`copilot` on PATH) choosing its own model; a configured provider and model are used when present.
  Nothing is written to the working tree: the cache and the model audit live under `.git`.
- In VS Code, **Singularity Flow: Repository Brief** shows every view as a tab, with branch and phase pickers,
  **Write with model** (which shows a brief already written for the same evidence instead of paying
  for it again), **Write again** once the model has written it, and buttons that open each source at
  its line.

## Rules: docs, code and tests

`wm knowledge show rules` (and `show business`) ends with every business rule as one record: what
the docs state (README files, `docs/`, decision records and approved Story requirements), what the
code enforces, and whether a test reaches it. Records are built without a model and linked by
anchors: the same message (quoted, or the docs sentence itself), a named constant or a name the
code's message quotes, the same bound ("at most 20 lines" against `size() > MAX_ITEMS` with
`MAX_ITEMS = 20`; "Orders under 10.00 are not accepted" reads as at least 10), a value ("5%" against
`VIP_DISCOUNT_RATE = 0.05`), a null check ("`rule` is null" against `rule == null`), the same HTTP
status, and the nouns both describe. A name or word that many rules share counts for little. Each
record has a status:

| Status | Meaning |
|---|---|
| agreed | the docs state it and the code enforces it |
| documented only | the docs state it; no code enforcing it was found |
| enforced only | the code enforces it; the docs do not state it |
| conflict | docs and code describe the same rule differently: another bound, or another HTTP status |

and says whether a test reaches the enforcing code ("Documented, enforced, tested."). Validation
constraints are rules too ("OrderRequest.lines: required, at least 1 long, at most 20 long"), linked to
the docs by their field names and bounds ("Refund amounts must be positive" against `@Positive`). A
Bean Validation constraint on a type no endpoint validates is reported as declared but not enforced
("no endpoint validates it (@Valid is missing)") and becomes a question for the product owner. When
the repository maps the framework's validation exception (`MethodArgumentNotValidException`,
`ConstraintViolationException`, …) to a status, constraints carry it ("HTTP 400 when invalid"), so a
README promising 422 for invalid fields is a conflict. Rules kept in rule files are records too
("minimum-age: when `age >= 18` → decides `eligible`"); whether a test exercises them is not claimed. Conflicts are
warnings for a person, never refusals. Phase briefs list the Story's rules with their status, and
intake briefs turn conflicts, documented-only rules and untested refusals into questions for the
product owner. `--json` adds the records themselves.

## Contracts

`wm knowledge show contracts` lists what the system exposes and depends on, one line each, built
without a model:

- **Exposed:** each endpoint with what its handler takes (the request body type with its fields and
  their validation constraints; path, query and header parameters), what it returns (wrappers such
  as `ResponseEntity<T>`, `Mono<T>` and `Promise<T>` removed), the HTTP statuses its flow refuses
  with, and whether a test reaches the handler or a function on its flow. For example:
  "POST /interest/calculate takes InterestRequest {principal, rate, period: BigDecimal} and returns
  InterestResult; refuses with 400 (5 checks); tested". Read from Spring, JAX-RS and Micronaut
  (Java and Kotlin), NestJS and FastAPI handlers. Message listeners, timers and program starts are
  listed after them.
- **Seams:** interfaces and abstract classes the repository declares, with the classes that
  implement them ("PaymentGateway (interface) is implemented by StripeGateway").
- **Storage:** Spring Data and Micronaut Data repositories with the entity and id they store and the
  finder methods they declare.
- **Called:** outbound HTTP calls with a literal target.
- **Data shapes:** enums with their values, and the types the endpoints and repositories use, with
  fields and constraints.
- **Configuration:** the first configuration keys, secret-named values withheld.

Phase briefs list the contracts that match the Story's words first.

## Flows, change impact and risks

Three more record kinds are built without a model:

- **Flows** (`wm knowledge show journeys`): each entry point with the call chain from its handler to
  the step holding the most rules (the other steps it reaches are counted as helpers), the refusals
  and HTTP statuses on the way, its effects (database, messages, files, outbound calls) and the
  response its handler declares. For example: "POST /orders → OrderController.place →
  OrderService.place (and 1 helper: totalOf); refuses 3 ways (HTTP 400); 6 rules on the way; writes
  the database; returns Order".
- **What a change touches** (`wm knowledge show change`, and in phase briefs): read from a change's
  own lines, not from the last commit. The changed line ranges since a base (`--base REF`, default
  `HEAD`; in a phase brief the Story's base commit) are mapped to the functions they fall in, each
  with its callers, the entry points whose flow reaches it, its rules, the tests that reach it and
  the files that usually change with its file. A file whose changed lines are not known, and a file
  the Story's reviewed plan expects to change, is read whole; a file declaring a type an endpoint
  takes or returns is a contract change ("Order.java (planned): declares Order, used by POST
  /orders").
- **Risks** (`wm knowledge show change`, and in phase briefs): where a change is risky and why, in
  words. File records carry the history (how often the file changed in 12 months, how many of those
  commits fixed something, whether one person makes most changes, which files change with it);
  function records carry what is true of one function (complexity, entry points and callers
  reaching it, rules, whether a test reaches it). Tests that contradict the code and functions with
  rules no test reaches are risks too. What the change touches ranks first.

A commit fixed something when its subject names a fix, bug, hotfix, incident, regression or revert.
Authors are compared by address, ignoring case.

## Plain-language explanations

`wm knowledge explain` asks the configured model to explain the repository, its journeys and its
rules in plain words. The model receives knowledge items and short excerpts of the lines they cite
(single statements, secret-scanned, quoted as data). Every sentence must list the items it relies
on, and a sentence is kept only if every code name, number and quoted text in it appears in those
items or their excerpts; sentences that cite nothing, cite outside their subject, judge the code
("correct", "secure") or exceed six per subject are rejected and listed. Kept sentences are
`inferred`: they appear under "In plain words" in views and phase slices with that label, are cached
on this machine with the exact knowledge they were checked against, and are never counted as
verified grounding. Composing a prompt never calls a model for them. Explanations already saved for
the same knowledge, prompt and model (by an earlier `explain` or by a model-written brief) are shown
without asking again; `--refresh` asks the model again. Without a model and nothing saved the
command says so and changes nothing; `--dry-run` prints the exact prompt.

## In phase prompts

`wm compose` gives every phase one **Repository brief**: a few cited bullets about the code the
Story touches, built without a model. It replaces both the knowledge slice and the registered World
Model view files that phases used to receive (World Model v5, milestone M0).

- **Inputs:** this knowledge, README and docs statements, accepted plain-language explanations, and,
  only where `worldModel.registered: on`, the registered views the phase selects. The registered
  World Model is off by default: nothing builds, reads or verifies it, and the brief is the phase's
  only World Model context. A view file is read for its statements only: its hash
  header, facts JSON, fact IDs and "No registered deterministic producer…" lines stay in the
  published file. Declarations are folded per type (accessors together), imports per file, and
  same-file lexical call guesses are left out.
- **Ranking:** items matching the Story's title, description, acceptance criteria and changed files
  come first; an item appears once. "What a change touches" is read from the Story's changed lines
  and planned files (see above); with neither, it lists what depends on the functions the Story
  names. A registered impact view describes the last commit, so the Story's own records replace it.
- **Format:** short sections with plain bullets, each ending with its source as `(File.java:42)` or
  `(README.md › Heading)`; what could not be determined is one closing "Not known" line. No JSON,
  hashes or fact IDs reach the prompt.
- **Budget:** the whole brief fits the phase's budget; what did not fit is counted on a pointer
  line. `worldModel.knowledge.maxBytes` replaces the defaults for every phase.

| Phase | Budget | Sections, in order |
|---|---|---|
| intake, requirements, specification | 2 KB | what exists, rules that apply, questions for the product owner, contracts |
| design, planning, architecture | 3 KB | contracts, flows, rules, risks, what exists |
| implementation spec, fix design, component mapping | 4 KB | what a change touches, rules, contracts, flows, risks |
| reproduction, fix spec | 3 KB | rules, what a change touches, risks, contracts |
| implementation and others | 3 KB | what a change touches, rules, contracts, risks |
| verification, testing | 3 KB | rules, risks, flows, what a change touches |
| conformance | 2 KB | contracts, rules, what a change touches |
| release | 2 KB | contracts, rules |

`singularity-flow wm brief --phase PHASE [--work-id ID]` prints exactly what a phase receives, without
recording anything. The prompt receipt still binds each registered view file by its committed hash,
plus the digest of what was read from it (renderer `repository-brief-view` v1), and grounding
verification recomputes that digest from the committed bytes. A Story pinned to an exact-history
packet keeps that packet byte for byte; its brief then carries knowledge only, beside the packet.
The brief travels in the existing grounding section (or the capability section beside a pinned
packet), so prompt budgets and token-reduction contracts apply unchanged. Turn knowledge off with
`worldModel.knowledge.prompt: off`; the registered views are still read into the brief.

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

- Calls are resolved by a compiler only where a semantic AST pack has been warmed: the bundled
  `sflow-typescript` pack for JavaScript/TypeScript (`wm ast warm --semantic --provider
  sflow-typescript --project node:. --profile default`, once per `package.json` project), the
  bundled `sflow-java` pack for Java on the machine's JDK (`wm ast warm --semantic --provider
  sflow-java --project maven:. --profile default`; a parent build covers its modules), the bundled
  `sflow-python-pyright` pack for Python (`--provider sflow-python-pyright --project python:.`), or
  an installed semantic pack that reports `calls`. Those edges are reported as `callsResolved` (with
  `callResolution` naming the providers), and a file's name-matched edges are dropped once it has
  resolved ones. A call through an interface or base class also reaches every repository method the
  pack reports as overriding or implementing it, so a Spring or Micronaut controller's call to an
  injected `OrderService` leads to `OrderServiceImpl`, and a FastAPI route's call to an abstract service
  leads to each subclass that implements it. Elsewhere calls are matched by name
  (`callsMatchedByName`, marked `inferred`), and a dynamic dispatch can be missed. An entry point
  leading into its handler is not counted as a call. Until a project is warmed, a build reads nothing from the AST
  layer (`callResolution.status: not-warmed`). A file whose checkout differs from the commit
  contributes no resolved calls. On Singularity Flow's own repository a warmed build resolves 47,475
  of 49,413 calls; the rest are in projects that were not warmed.
- Drift is reported only when a test that exercises a rule uses comparative words ("more than",
  "at least") that contradict the rule's operator and shares a value with it.
- Coverage means a test names the function or reaches it through calls, not that a line ran.
- An explanation's check is lexical: a sentence that uses only plain words can still misread what it
  cites, which is why kept sentences stay labelled `inferred`.
- History covers the last 12 months (at most 2,000 commits, merges skipped).
- Requirements come from approved Markdown phase artifacts only; uploaded documents, Jira text and
  unapproved drafts are not read.
