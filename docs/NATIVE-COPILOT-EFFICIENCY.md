# Native Copilot efficiency

SFlow skills run inside the host's native conversation. They cannot control that
conversation's cache, model session, billed tokens or context retention. ACP session
reuse affects SFlow-owned provider calls, not ordinary `/sf-*` turns.

## Entry and reuse contract

### Utility reads

Eight utility skills use the requested read itself as their pause-aware entry:
status, progress, nextsteps, logs, agents, workflows, skills and instructions.
For example:

```sh
singularity-flow progress STORY-ID --utility-entry --for-agent --json
singularity-flow workflow list --utility-entry --for-agent --json
```

The opt-in result is `sflow-utility-entry`: a verified `repositoryPath`, requested
`operation`, `readCompleted: true`, and the existing result under `data`.
It is a completed read, not lifecycle readiness or permission to mutate. Pause and
request eligibility are checked before Git. A missing repository, unknown flag,
mutation, retained-skill selector, output-file request or failed read is refused,
not converted into a successful entry. Paused results retain the existing pause
contract. Older installations must be updated rather than silently retrying.

The closed forms are status, progress, nextsteps, logs, agents list/mappings/status,
workflow list, skill/instruction list/show, phase show, inputs with `--dry-run`,
and report with `--format json`. Every combined call requires `--for-agent --json`.
Explicit IDs and supported filters are preserved; no directory search, selection
change, extra STATUS.md read or duplicate pause/session/workspace call is needed.
Mixed catalog skills keep their original gates for create/edit/activate operations.
Ordinary CLI output stays compatible; agents list/mappings/status now honor JSON.
Logs with no existing file return an empty JSON array instead of prose.

Catalog reads retain approved-configuration selection, pending-proposal notices,
instruction references, attachment scope and exact retrieval semantics. Skill and
instruction readers share projections with Studio but skip unrelated canvas,
template, integration and blueprint construction. Agent and workflow lists no
longer enter the legacy dispatcher. Mutations still use the existing owners.

Only the closed read forms share an invocation-local read scope across accounting
and execution. Application/configuration roots and bootstrap/current definitions
remain separate keys; approved overlays still open fresh scopes and verify bytes.
No scope crosses commands, a writer, publication or an approval decision.

Reproduce paired installed-build measurements against a trusted baseline checkout:

```sh
node scripts/bench-utility-entry.mjs /absolute/path/baseline-checkout results.json
```

The fixture has 1,000 files, 20 unrelated branches, full seeded catalogs and no
configured remotes/models. It compares the old pause-plus-read skill sequence with
the combined read, recording the read separately to distinguish handler savings
from the removed process. Each variant starts with an empty private V8 cache and
then uses three fresh processes; the OS cache is not flushed. This is CLI
qualification, not a measured native Copilot conversation or token-savings claim.

The [2026-10-17 paired results](../benchmarks/utility-entry/qualification.json)
retain every wall/read sample. Windows ran natively with Node v24.21.0; macOS used
v25.5.0. Both variants used full agent JSON to isolate CLI/backend costs, not
bounded presentation or host/model latency. Windows fixture TEMP was a short
disposable path; antivirus, OneDrive and enterprise laptop behavior are not qualified.

| Windows utility sequence | Before, first | Combined, first | Before, repeat median | Combined, repeat median |
| --- | ---: | ---: | ---: | ---: |
| Status | 700 ms | 434 ms | 447 ms | 271 ms |
| Progress | 1,112 ms | 833 ms | 710 ms | 496 ms |
| Workflow list | 1,517 ms | 1,141 ms | 1,104 ms | 836 ms |
| Skill list | 1,406 ms | 1,043 ms | 1,189 ms | 473 ms |
| Instruction list | 1,443 ms | 778 ms | 1,149 ms | 472 ms |

Across the ten Windows forms, first-sequence improvements range from 15% to 46%;
repeat medians improve 24% to 60%. These include removing the separate pause
process. Standalone reads are not universally faster: the Mac nextsteps first
sample regressed from 428 to 478 ms, and its baseline repeat samples were noisy.
Progress, phase show, input preview and report reduce uncached definition loads
from three to two without conflating bootstrap and current policy. Source fallback
workflow/agent catalogs load 246/238 engine modules instead of 608/614, with
accounting retained and no legacy dispatcher or model runner import.

Native Windows qualification also covers source/bundle parity, scoped catalog
isolation, pause-before-Git, the scripted four-phase lifecycle and bounded output.
Configuration fault-injection fixtures were made genuinely portable: file-URL
imports, legal filenames, a native executable bridge, exact quoted arguments,
binary stream draining and BOM-free stdin. Their corrected end-to-end checks ran
in a follow-up qualification. The bridge's C# compiler is a test-only requirement,
not a product dependency. Production object/integrity validation was not weakened.
One pre-existing Windows symlink test is skipped where unsupported.

### Cold utility follow-up

Installed catalog handlers now have an explicit coarse `cold-catalogs` family rather
than falling into the general compatibility dispatcher. Agent, workflow, skill and
instruction lists retain their original services, approved configuration and pending
draft notices. Their static bundle closure is limited to 5 MiB and cannot include
the compatibility, model, intake, phase or hook-context families. The complete
deployment remains at most 20 module files; shared engine modules keep one identity.
Home, Inbox and editor definitions keep their separate general-read family. The
small read/sync worker-helper families share a slot, never their entry programs.
Package inspection is also lazy in the source skill router.

The existing installation/VS Code runtime warmup additionally prepares catalog and
phase definitions. It executes no command, model, worker program, repository scan or
authority decision. The same selected executable, build and compile-cache environment
are used; disabled caching, failed preparation and cancellation retain the ordinary
command path. Preparation has a real cost: first-visible-request measurements after
warmup report that cost separately, not as a cold-start speedup.

`agents list`, `agents mappings` and `agents status` are explicit read operations.
Agent creation, editing, trust locking, synchronization and output refresh keep the
existing `agents` mutation operation, reset-visible lease and authority policy.
Unknown actions cannot acquire read classification. No approval or publication gate
is cached or relaxed.

Compare against an already-combined baseline without counting the previous entry
optimization twice:

```sh
node scripts/bench-utility-entry.mjs BASELINE RESULTS.json --combined-baseline --samples=3
node scripts/bench-utility-entry.mjs BASELINE WARMED.json --combined-baseline --prewarm --samples=3
```

Each sample gets its own private V8 cache and three subsequent fresh processes;
variant order alternates. Warmup runs before measurement on both sides and its
duration is retained. The OS cache is not flushed, full agent JSON is used, and no
native Copilot host/model latency or office-laptop antivirus policy is measured.

The [paired cold follow-up results](../benchmarks/utility-entry/cold-followup.json)
compare against `7e50d127` with combined entry on both sides. Native Windows passed
89 regression/lifecycle/output tests, typecheck and the unchanged package budgets.
The static catalog-family dependency closure drops from 15.7 MB to 4.2 MB; actual
execution can dynamically load additional shared services.

| Windows read | Mode | Before first median | After first median |
| --- | --- | ---: | ---: |
| Agents | Cold | 573 ms | 524 ms |
| Workflows | Cold | 743 ms | 709 ms |
| Phase documents | Prewarmed | 514 ms | 480 ms |
| Report | Prewarmed | 477 ms | 453 ms |

These are incremental improvements, not a blanket speedup. Several commands remain
flat and small regressions are retained. Prewarming the additional definitions costs
roughly 40 ms more on this Windows fixture; it moves work ahead of the visible
request and is not a total-work reduction for a one-off command. For example, the
prewarmed skill/instruction reads are slightly slower in this sample. All cold,
repeat and warmup wall samples are retained, including unchanged/regressed cases.

### Shared read context and useful compact catalogs

The CLI's closed read forms now open a command-local context. Repeated accepted-Story
resolution shares one pending load, keyed by repository, configuration overlay and
Work ID. Each consumer receives its own workflow object. Ordinary writer scopes do
not opt into this memo; fresh/bypassed reads see new bytes, and nothing survives the
invocation. Counters distinguish `story.context-requests` from `story.context-load`.

Bootstrap and current configuration still have different validated definitions.
Only the secured source read and YAML parse are shared; compatibility normalization
and policy validation run against separate clones. Tests require one source read/
parse for two policy variants, reject broken current agents after bootstrap, and
refuse malformed YAML in either variant. No approved revision, receipt, identity,
permission change or publication decision is cached across requests.

`phase show` uses the existing phase-review kernel through a narrow read handler,
not the lifecycle mutation dispatcher. JSON reports load the review-bundle renderer
only for an actual review operation. Installed bundles route phase documents and
reports through the read family, and keep the pure phase router in the early family;
source and installed-bundle parity cover these paths. Runtime warmup includes the
narrow read definitions without running their handlers. The deployment remains 20 files.

For agent-only skill/workflow lists, `catalogView.metadataOnly` retains useful names,
scope and pending status inline. Rich rows include attachment detail and phase IDs;
when those cannot fit, `detailLevel: identity` prioritizes every name over a richer
partial list, with phase counts and selected expansion pointers. Each
row binds its exact original definition with a digest and `detailField`; the complete
result stays in the private Git agent-result store, with long text in referenced files.
Large catalogs explicitly report `more`. Selected skill bodies, phase context, review
evidence, refusal packets and ordinary/full/raw JSON are not replaced by catalog
metadata. Copilot should list inline and expand only selected definitions, not read
the entire result by default. A catalog summary is neither an instruction nor authority.

To qualify backend and presentation separately, run the paired benchmark above with
`--agent-output=full` and `--agent-output=bounded`, cold and prewarmed. The bounded
listing consumer actually reads any required expansion file and counts the bytes and
file reads for all catalog IDs/names. This is a filesystem/CLI workload, not native
Copilot tool latency or measured billed-token savings. Warmup costs remain separate.

The shared context adds about 1.2 KB to the VS Code gateway bundle (module count
unchanged). Its byte ceiling increases by 2 KB, from 7,520,000 to 7,522,000; other
budget changes merged from main belong to the separate VS Code UX work. This small
measured packaging cost is not hidden as a runtime speedup.

The [shared-context qualification](../benchmarks/utility-entry/shared-read-context.json)
compares runtime `09c4fda1` with the newer main `64b2147a`, after integrating its VS Code
UX changes. Native Windows (Node v24.21.0) passed 80 tests, with one existing
platform-limited symlink test skipped, plus typecheck and package budgets. Local
macOS used Node v25.5.0. Every cold/repeat/warmup wall sample and catalog-consumer
byte/read result is retained, including regressions, with hashes of the raw reports.

| Windows full-JSON read | Cold before | Cold after | Prewarmed before | Prewarmed after |
| --- | ---: | ---: | ---: | ---: |
| Status | 249 ms | 250 ms | 160 ms | 161 ms |
| Next steps | 541 ms | 520 ms | 390 ms | 384 ms |
| Phase documents | 486 ms | 495 ms | 359 ms | 357 ms |
| Report | 355 ms | 353 ms | 240 ms | 248 ms |
| Workflows | 546 ms | 542 ms | 500 ms | 533 ms |
| Skills | 292 ms | 282 ms | 238 ms | 241 ms |

These incremental CLI timings are largely flat, not a universal speedup. The full-JSON
first-request medians across cold and prewarmed runs range from a 6.6% regression to a 3.9%
improvement. Most fixture reads have only one accepted-Story consumer; concurrent
coalescing is separately regression-tested rather than claimed as a saving on every
request. The narrow handlers reduce coupling while retaining the same review kernel.
Median warmup costs on the full-JSON Windows runner were 277 ms before and 281 ms
after; prewarming moves that cost ahead of visibility, not out of the total workload.

The larger measured saving is useful bounded output. Listing all 20 workflow names
consumed 13,116 bytes before (stub plus one full-file read), versus 5,932 bytes after
with no follow-up read: 55% less. Listing all 11 skill names fell from 24,496 to 4,814
bytes, 80% less, also without expansion. The new inline metadata is larger than the
old unhelpful stub; the complete listing task is smaller. Selected definitions remain
exact and catalogs larger than the inline limit explicitly require further reading.
This does not establish native Copilot tool latency, billed-token savings, whole-Story
speed or performance under an office laptop's antivirus/OneDrive policy.

### Lightweight installed reads and display projections

Ordinary JSON status now has a separate reader/router; human rendering, ledger detail
and submission readiness retain the original detailed owner. The status chunk may
statically reach only its core dependencies, with a 1.5 MiB closure ceiling. A separate
`cold-narrow-reads` family owns progress, report, phase documents and next-step reads,
with a 7 MiB ceiling. Home/Inbox/editor definitions remain separate. Maintenance
definitions share the phase slot, preserving one instance per module and the existing
20-file deployment limit. Source and installed parity still exercise human and refusal
paths, hooks and worker isolation. No handler is executed by runtime warmup.

Closed utility reads load accounting preferences from secured configuration bytes
instead of discovering agents and checking every template just to initialize logging.
The logging and harness preference validators are unchanged; the pure harness policy
is shared with its original public exports. Enabled harness accounting still records
events. Writers and unlisted forms retain full accounting preparation. Handler policy
checks remain independent of observation preferences.

Default workflow listing in that read context uses a display-only catalog projection.
Each projected record declares `readiness: not-assessed` and binds the exact workflow
source digest, approved commit when present, packaged catalog digest and running build.
Agent discovery, dependency admission and template availability are not inferred from
this view. `--for-start`, start/preflight, executable-definition loading, publication and
approval keep their strict paths. The projection cannot occupy a strict-definition
cache key. No projection persists across requests. Fresh scope/overlay tests cover
edits, missing templates, malformed preferences, source changes and strict refusal after
metadata display. Classification is captured before an approved reader opens a fresh
overlay; source bytes are not carried across that authority boundary.

Timing records now separate secured source-path checks, source I/O, parsing, definition
validation, agent discovery, template checks, accounting preparation/preferences,
workflow metadata and pending-proposal lookup. These spans nest and must not be added
together. `SINGULARITY_FLOW_OUTPUT_TIMING=stderr-v1` additionally emits a bounded
`@@sflow-output/v1` diagnostic with post-handler buffer/envelope serialization,
rendering/emission durations and
byte counts, never content or paths. It is opt-in and leaves stdout unchanged. The paired
benchmark retains these diagnostics and nested spans; the old baseline has no output
diagnostic, not a measured zero cost. Wall time outside named stages remains unassigned,
not automatically attributed to Node startup. Full/bounded modes run on separate Windows
hosts and must not be subtracted to claim a rendering overhead.

Installed byte/module budgets are unchanged. Two source-graph ceilings increase by two
to account for the extracted source reader and pure policy helper; the new installed
read-closure byte ceilings guard the actual deployment cost.

Qualification is retained in
`benchmarks/utility-entry/light-read-projections.json` (baseline `c9e1d7be`,
runtime `3629dbda`, native Windows run `39008579928`). Ten commands were paired
before/after, in full and bounded output modes, on Windows Node 24.21.0 and this
Mac's Node 25.5.0. Each mode retains three private-V8-cache first requests and nine
subsequent fresh-process requests. Prewarming is performed before timing, with its
cost recorded separately; it does not make work free. OS and Git fact caches are not
flushed. In particular, the first baseline status sample creates persistent facts
which later candidate samples can reuse, so its apparent cold gain is not strong
evidence of a startup improvement.

Windows full-output first-request medians, in milliseconds:

| Command | Cold before → after | Prewarmed before → after |
| --- | ---: | ---: |
| Workflow list | 871 → 757 (13% faster) | 728 → 601 (17% faster) |
| Agents list | 605 → 462 (24% faster) | 455 → 311 (32% faster) |
| Next steps | 824 → 792 | 614 → 600 |
| Phase documents | 760 → 756 | 565 → 559 |
| Inputs preview | 832 → 806 | 621 → 631 |
| Status | 215 → 199 | 158 → 159 |
| Report | 474 → 477 | 334 → 330 |

Bounded-output workflow/agent listings show similar Windows gains: 13%/24% cold
and 17%/31% prewarmed. Most other Windows commands are approximately flat, including
skill/instruction listings; the record retains every slowdown. Mac listings also
improve, but other Mac commands have mixed results, including regressions. This is
not a claim of universal command, whole-Story or native Copilot tool/token savings.
Hosted Windows uses a short disposable TEMP and invokes Node directly: office-laptop
antivirus, PowerShell/.cmd startup and actual Copilot hooks are not qualified here.

The installed static status closure decreases from 1,636,828 to 1,373,296 bytes;
document reads decrease from 9,252,100 to 7,121,613 bytes. Deployment remains 20 files.
These byte reductions do not translate directly into proportional latency gains.
Listing/accounting no longer checks 57 phase templates merely to display a catalog.
Governed lifecycle reads still admit full policy: the Windows cold next-step profile
includes roughly 176–180 ms of handler-module loading and 405–416 ms of execution,
with about 42–47 ms of agent discovery and 77–82 ms of Git service work. Workflow
listing still spends about 114–120 ms preparing accounting, 181–190 ms producing
metadata and 116–136 ms looking up pending proposals. Spans are nested. YAML parsing
is only about 3–6 ms, and full next-step/list post-handler output serialization and emission are
each below 1 ms in these samples; neither explains the remaining latency. Status's
first output renderer import costs about 20 ms and is now visible separately.

Native Windows regressions: 81 passed, zero failed, one platform-specific unsafe
cache-ancestor symlink test skipped; scripted lifecycle/output: 16 passed. VS Code
typechecking and unchanged installed bundle budgets passed. Local checks also passed.

### Story operations

- Every registered skill is audited; aliases delegate once to their canonical owner.
- Story-bound operations use `singularity-flow session current --for-agent --json`
  once instead of separate pause and session calls. Pause is checked before repository
  discovery, including from a non-Git chat directory. Readiness, work ID, active-agent
  checks, custom work-item roots and exact selected checkout paths remain enforced.
- All seven selectable drafting skills use phase entry, including specialised skills
  in renamed or user-created phases. They reuse recovery, clarification, references
  and the composed prompt rather than looking up the same fields separately.
- `/sf-next` delegates composition to all these entry-capable skills. It still returns
  unrelated prerequisites and human decisions; it does not execute them automatically.
- Read `agentGuide.readOrder` once. Supplied input text is reused; only missing,
  truncated or task-relevant omitted material needs expansion. An approved brief is
  a projection, not the entire specification or a replacement for exact source review.
- Agent packet presentation retains the current platform's exact commands, all
  findings, hashes, confirmation requirements and governed text. Full terminal JSON
  remains available. Other platforms' duplicate command strings are omitted only
  when the current platform has a verified command.
- Same-invocation reuse is not a durable authorization cache. Selection changes,
  mutations, new publication bindings and operation-specific checks still require
  fresh evaluation. Approval consent is never reused.
- Preparation scaffolds or preserves a draft; the native agent must author it before
  checking publication readiness. Template TODOs are work to complete, not a reason
  to stop authoring. Deterministic artifacts remain kernel-owned.
- Independent review reads exact pinned sources and artifacts privately, not summaries.
  Chat shows supported summaries and verified Markdown-preview links, never artifact,
  code or diff bodies. Code reports use observed paths and added/deleted/created line
  counts from existing evidence; unknown or binary counts remain unavailable.
- Human approval requires complete review of the exact linked documents outside chat.
  Same-chat acknowledgement is reusable only with matching non-null `displayBinding`
  and unchanged `reviewBinding`. New chat, changed/null bindings or incomplete material
  require fresh human review. Summaries, opened previews and approval consent are not
  interchangeable; operation-specific consent remains explicit.

## Measuring a complete native Story

From the SFlow source/package directory:

```sh
npm run audit:copilot
npm run audit:copilot -- --details
npm run audit:copilot -- --trace /absolute/path/copilot-trace.json --story-dir /absolute/path/exact-story-directory
```

The default audits every packaged skill but prints only a summary and the ten
largest bodies; `--details` lists every row. The trace form additionally measures an
explicit exported host trace and retained prompt inventory. No filesystem search,
model invocation, Story mutation or raw prompt logging is performed. The trace is
limited to a regular non-symlink file of 16 MiB and 10,000 tool events. Do not include
secrets or full source/document bodies; the analyser only needs metadata:

```json
{
  "schemaVersion": 1,
  "workId": "DEMO-1",
  "workflow": "custom-delivery",
  "phaseOrder": ["intake", "coding", "close"],
  "completedPhases": ["intake", "coding", "close"],
  "lifecycleStatus": "completed",
  "events": [{
    "invocationId": "turn-3",
    "bindingKey": "exact-head:phase:generation:work-id",
    "phase": "coding",
    "command": "singularity-flow phase enter --for-agent --json",
    "responseBytes": 4500,
    "durationMs": 800,
    "freshnessRequired": false,
    "exactReviewMaterial": false
  }]
}
```

For document reads, optionally include `document.displayBinding`, `document.sha256`
and `document.complete: true` only when the entire document was read. Separate chunks
are not duplicate complete reads. These observations do not authorize display reuse.
For usage actually reported by the provider, optionally include
`usage.inputTokens` and `usage.outputTokens` for that event, not repeated cumulative
totals. Missing usage remains **unavailable**, not zero. Do not estimate provider usage
from JSON length.

Completion is reported by the trace, not independently proven by the analyser.
Duplicate candidates need review; fresh bindings and exact review material must not
be removed just to meet a size target. Summed tool durations are not end-to-end latency.

Compare complete runs with the same workflow, task, model, native host version and
test policy. Record repair loops and human waits separately. Report measured tool
calls, packet bytes, document reads, elapsed time and observed provider usage, not a
headline savings percentage inferred from skill text size. The complete Classic
Delivery test exercises the kernel lifecycle and reports entry packet sizes, but it
is a scripted test, **not** a live Copilot efficiency benchmark.

## Scripted measurement — 2026-10-10

The complete Classic Delivery fixture finished intake, implementation, testing and
conformance, including publication, submission, approval and closure. It made 35
CLI calls: 23 journey operations and 12 measurement-only entry inspections.
Response totals include those inspections. These are not native Copilot calls.

| Phase entry | Previous compact form (bytes) | New agent form (bytes) |
| --- | ---: | ---: |
| Intake | 2,387 | 2,586 |
| Implementation | 23,335 | 22,630 |
| Testing | 11,504 | 11,409 |
| Conformance | 13,444 | 13,325 |

The baseline minifies the full entry result, matching the previous agent presentation;
it is not a separate historical-binary run. Both sides use minified JSON, not pretty
terminal JSON versus compact agent JSON. The new guidance adds 199 bytes to the small intake packet;
the larger implementation packet drops 705 bytes. Overall entry-size savings are
modest. The primary change is fewer prescribed lookups: 37 Story-bound skills now
use one pause-aware session entry instead of separate pause and session calls, and
all seven selectable authoring skills reuse phase-entry context. Actual native
Story tool-call, document-read, latency and billed-token savings still require a
complete exported host trace. No model was called by this fixture.

## Live measurement — 2026-10-11

One complete Classic Delivery Story (change an exported value from 1 to 2 and its unit
test) was driven through Copilot CLI 1.0.95 over ACP, model Auto (it chose
`gpt-6-luna`). A fresh clone at `4e81b3fa` with the plugin and direct skills installed in an
isolated `COPILOT_HOME` was used, with all 16 messages in one conversation, typed as a user would:
`/sf-next`, `/sf-session TOK-1`, `/sf-next`, the clarification answers, `/sf-submit`, and so
on. Readiness, Story start and the four approvals were human CLI steps outside the chat.
Usage is Copilot's own per-model-call record (`session.usage_record` in its session log).

| | Session + Intake | Code | Testing | Code checking | Total |
| --- | ---: | ---: | ---: | ---: | ---: |
| User messages (= premium requests) | 5 | 3 | 2 | 6 | 16 |
| Model calls | 39 | 29 | 23 | 55 | 146 |
| Input tokens | 1,338,691 | 2,305,218 | 2,944,829 | 10,359,940 | 16,948,678 |
| Tool calls | 36 | 30 | 28 | 51 | 145 |

- 95.9% of input tokens were cache reads, 4.1% cache writes; output was 41,915 tokens
  (18,207 reasoning). Copilot reported 19.2 AI units.
- Cost follows conversation length times model calls, not phase prompt size. The
  composed phase prompts were 8.9–20.4 KB; the first model call (system prompt, skills,
  `/sf-next`) was 15,127 tokens. The context re-sent on each call grew from 15K to
  217K tokens (the window is 272K): the CLI returned 375 KB of JSON over 80 calls, and
  that stays in the conversation. Copilot spilled 17 large results to temporary files
  and read them back 23 times.
- Repair loops: two turns spent 5.0M input tokens (30%) adding a missing self-approval
  disclosure through `appeal repair-plan/run/resume`. The first Code edit added the clause
  tag but not the change, so publication failed its tests and was repaired. Two `/sf-next`
  turns only rendered inputs and named the drafting skill (0.86M tokens, 2 extra premium
  requests). `/sf-phase` declined to submit when asked, which cost one more turn.
- Waits: one model call hung for 15 minutes and the session was resumed
  (`session/load`). The final submit failed with `grounding is not defined`, fixed in
  `06533b54`. Cache writes after those pauses were 160K and 202K tokens, although the
  reported cache TTL was 1,800 s.
- `npm run audit:copilot -- --trace` over the 80 SFlow tool events reported 0 duplicate
  candidates. Its duplicate rule is per turn and covers status lookups only, while
  `phase enter` and `nextsteps` each ran 6 times across turns, and `phase show` ran
  after every publication and submission.

### After the fixes (`26a25df0`, `48bb1185`)

The same Story was run twice more:
- Run 2 used model Auto, which this time chose a different model.
- Run 3 was pinned to `gpt-6-luna`, the model of the first run, for a like-for-like comparison.

Both runs followed the CLI's approval output, "Context boundary: new … /clear, /sf-next": a fresh conversation per phase, entered with `/sf-session`, then the drafting skill and `/sf-submit`.

| Input tokens | First run | Run 3 (same model) | Run 2 (Auto) |
| --- | ---: | ---: | ---: |
| Attach + Intake | 1,338,691 | 1,913,873 | 1,022,841 |
| Code | 2,305,218 | 2,337,994 | 918,310 |
| Testing | 2,944,829 | 1,254,975 | 944,917 |
| Code checking | 10,359,940 | 2,409,731 | 1,487,834 |
| Total | 16,948,678 | 7,916,573 | 4,373,902 |
| Premium requests | 16 | 16 | 15 |
| Largest context per call | 216,524 | 101,394 | 71,925 |

- Code checking passed its draft check first time in both runs: the report arrived with the self-approval disclosures already written. No repair loop ran.
- Correction: the `/sf-session` turn that opened each fresh conversation (120K–173K tokens and one premium request each time) was mostly unnecessary. The Story selection is recorded per checkout, so it survives a new conversation. Only the first conversation after a start lacked it, and a start now records it too. Without those four turns, run 3 would have used 12 premium requests and about 7.4M input tokens, and run 2 about 11 and 3.8M.
- A hand-wired `session-start` hook, which re-asks for the Story in each new conversation under `workItemSelection: prompt`, now hands the selection over while the phase opened by an approval's `new` or `compact` boundary is unprepared.
- The request now leads both what the agent reads first and the composed prompt. Agent entry packets carry a bounded `story` summary right after `workId`. The phase contract opens with a "Requested outcome" line, and the full pinned source still follows.
- Run 3's model needed three corrective messages. It tagged an unapproved clause, published an Agent brief it could not correct without a new generation, and missed the committed test receipt. Model choice moves these numbers as much as the workflow does.
- An agent that extracts chosen fields with `python3` or truncates with `head -c` can miss what it did not extract. Run 2's agent never read `contextBoundary` in an old conversation. It also missed the Story description, which sits deep in the composed context. Field-only hints are not enough on their own; the surface that approves should start the fresh conversation.

## Regression checks

```sh
node --test test/native-copilot-efficiency.test.mjs test/phase-entry.test.mjs test/skill-efficiency.test.mjs test/copilot-pause.test.mjs test/authoring-skills.test.mjs test/classic-delivery-workflow.test.mjs
```

The catalogue audit rejects duplicate authoring context lookups. Tests retain pause,
identity, immutable binding, independent reviewer and human-confirmation boundaries.

The scoped suite passed 224 tests, including the complete scripted Story. The
2303 static checks and VS Code typecheck passed. Additional repository-upgrade
checks exposed three existing failures in `test/upgrade-contract.test.mjs`: stale
World Model classifications, a missing `MODEL_SESSION_INCOMPATIBLE` classification,
and a placeholder-only removed-command route. Their source, tests and discovered
version-sensitive code set are unchanged by this efficiency work; this is not a
claim that the entire repository test suite is green.
