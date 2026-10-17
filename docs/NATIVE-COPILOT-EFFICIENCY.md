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

Retrospective qualification limitation: that harness rebuilt both sources using the candidate
partitioner. Its historical timing/closure comparisons are therefore superseded, not a qualified
before/after package comparison. The data remains retained for audit; use the revision-owned
builder qualification in the next section instead. Functional regression results are unaffected.

Historical latency and closure comparisons are not repeated here because of that packaging
limitation. Listing/accounting still avoids checking phase templates merely to display metadata;
that behavior is covered by regression tests, independently of the excluded timing comparison.

Native Windows regressions: 81 passed, zero failed, one platform-specific unsafe
cache-ancestor symlink test skipped; scripted lifecycle/output: 16 passed. VS Code
typechecking and unchanged installed bundle budgets passed. Local checks also passed.

### Narrow recorded-state reads and prepared workers

Progress and report summaries now share a recorded-state reader instead of loading an accepted
execution catalog merely to display recorded progress or usage. The reader uses the same subject
index/schema migration and the same extracted in-memory Story hydration as the lifecycle owner.
It clones request-local values. Reporting reads only its live pricing preferences and uses the
same token preference validator as strict configuration loading. Neither value proves the current
execution closure is intact or authorizes a transition. Missing live templates may no longer
prevent an informational progress display; phase entry, review, publication, submission and
approval continue through their existing execution/admission owners. Next steps, phase review and
input readiness do not substitute a state-only summary for those decisions.

Skill and instruction argv validation lives in pure request modules. Existing command exports
delegate to the same contracts, and early CLI validation no longer loads the command service.
The ordinary state-read bundle also owns progress/report, their observation preferences and the
private read service. It retains the existing 1.5 MiB static closure ceiling, unrelated-domain
exclusions and 20-file installed deployment ceiling. Three source-graph slots account for extracted
token/session/state-hydration helpers; installed byte/module ceilings are not increased.

Local approved-configuration selection captures ref names, exact object IDs and object types in
one bounded namespace listing. Each candidate's commit, workflow, portfolio and optional state
manifest are read in a bounded object batch, with object hashes checked before use. Parsed asset
policy is reused only for that exact authority object. Lower-priority candidate bytes are not
opened after a higher-priority authority succeeds. Authority order, state-mirror digest checks,
remote ownership and full extraction/containment checks remain in place. Read failures are not
converted into a successful lower-priority authority selection.

VS Code schedules private read-worker preparation after activation yields, ahead of a menu click,
when warm reads are enabled. Only owned definitions are prepared: no Story/configuration read,
handler, provider, test, readiness witness or approval is executed. Progress and JSON report reads
join the worker's closed model-free vocabulary; author/reviewer packets and mutations remain
excluded. Build/environment binding, bounded lifetime/queue, fresh request scopes, cache resets,
cancellation and one authoritative CLI fallback remain enforced. Preparation is cancelled on
client invalidation/disposal. Lightweight requests do not eagerly load the full reset/authority
domains; after a full-policy request has loaded them, every subsequent request still clears them.

VS Code bundles also use syntax compression while preserving identifiers and source maps. The
unchanged bundle budgets enforce the resulting deployed sizes; this build-size change alone is
not a measurement of actual VS Code activation latency.

Additional nested spans cover Story bootstrap/aggregate/execution-catalog loading, phase review,
next-step draft evidence/publication lookup/prerequisites and catalog authority refs/objects.
Do not sum nested spans or attribute unassigned process wall time entirely to Node startup.

Qualification distinguishes a legacy Story from an actual pinned Story. The pinned fixture
captures its policy, template and custom-agent bytes in its first commit and independently loads
the accepted execution catalog before measurement. Catalog tests use full seeded configuration
on a local approved branch. Both output modes pair cold/private-bytecode-cache and prewarmed
requests against the same baseline. Private-worker qualification separately records first-worker,
prepared-first-request and repeat latency, including the preparation cost outside request timing;
an older build without the preparation API is identified as bytecode-only, not an already running
worker. The harness checks canonical before/after result parity (excluding report read-time clocks).
These are native-process Windows tests, not native Copilot conversations or office-laptop
PowerShell, antivirus and hook qualification. Local Mac smoke timings under concurrent activity
are diagnostic only and are not used as evidence of performance gains.

Each revision must be built by its own selected package's builder/partitioner, not by a shared
candidate builder. Raw reports retain both partitioner digests and the summary verifies them
against the exact Git revisions. The initial run `39011285299` failed this methodology check and
is excluded from the performance record; it must not be used as evidence of gains.

The corrected [qualification record](../benchmarks/utility-entry/narrow-recorded-reads.json)
uses baseline `c9062f33`, runtime `d98ae9ca`, test/harness `264fa0be`, and native Windows
run `39012031992`.
All seven jobs passed. The two regression groups total 117 passed, zero failed and one existing
Windows symlink-test skip; scripted lifecycle, typechecking and unchanged bundle budgets passed.
The report retains every first/repeat sample, nested timing, slowdown and raw-artifact hash.

Full-JSON CLI first-request medians, milliseconds (three samples per cell):

| Story | Command | Cold before → after | Prewarmed before → after |
| --- | --- | ---: | ---: |
| Legacy | Progress | 370 → 171 | 258 → 133 |
| Legacy | Report | 366 → 174 | 258 → 134 |
| Pinned | Progress | 618 → 174 | 546 → 139 |
| Pinned | Report | 564 → 172 | 447 → 133 |
| Legacy | Next steps | 621 → 619 | 471 → 460 |
| Pinned | Next steps | 855 → 789 | 664 → 653 |
| Legacy | Phase documents | 578 → 576 | 428 → 428 |
| Pinned | Phase documents | 758 → 829 | 597 → 594 |

Progress/report improve 48–75% in this full-output comparison; bounded-output pairs improve
47–70%. Next steps, phase review, inputs preview and most catalog reads remain broadly flat,
including the pinned cold phase-review slowdown above. The catalog's batched object selection
does not remove all independent policy/asset scans. These are not universal command gains.

Private-worker first-request medians, milliseconds, measured separately with persistent Git
facts disabled:

| Story | Read | Unprepared before → after | Prepared before → after | Candidate repeat median |
| --- | --- | ---: | ---: | ---: |
| Legacy | Status | 424 → 155 | 236 → 19 | 10 |
| Legacy | Progress | 588 → 153 | 438 → 18 | 10 |
| Legacy | Report | 584 → 161 | 435 → 25 | 11 |
| Pinned | Status | 452 → 174 | 262 → 31 | 22 |
| Pinned | Progress | 1,152 → 274 | 968 → 30 | 20 |
| Pinned | Report | 1,229 → 171 | 1,144 → 43 | 26 |

The old worker did not support progress/report, so its transport is an explicit CLI fallback;
the record distinguishes that from a worker request. Both versions get bytecode preparation in
the prepared comparison, while only the candidate supports definition preparation. Candidate
definition preparation for these reads costs 100–292 ms outside the visible request, in addition
to separately retained bytecode warmup. It moves work earlier; it is not eliminated work. Full
next-step execution remains heavy: candidate prepared first requests are 383 ms legacy / 922 ms
pinned, with repeat medians 169 / 586 ms. Worker gains do not apply to arbitrary Copilot shell
commands, mutations or model/tool-host time.

Installed static closures remain within their unchanged ceilings: core 1,336,698 → 1,344,136
bytes; status/record reads 1,373,296 → 1,486,049 bytes; full lifecycle reads 7,121,613 →
7,129,155 bytes; 20 files in both deployments. The narrow read improvement comes from avoiding
unneeded execution-catalog work, not a claim that every closure shrank. Candidate cold CLI
progress spends about 15–20 ms in its handler; next steps still spend 322–516 ms, including a
244 ms accepted-catalog span for the pinned Story. Handler-module loading is 123–137 ms for
next steps versus less than 1 ms for progress. Root dispatch is about 84–99 ms and a further
57–70 ms of process wall time remains unassigned in these samples. Workflow listing retains
80–86 ms accounting, 119–135 ms metadata and 95–97 ms pending-proposal spans. These nested
medians must not be summed. The next optimization should target those measured owners rather
than weaken execution policy or attribute all remaining time to YAML/output rendering.

### Strict policy reads, accepted history and multi-artifact reviews

Strict Story loading now has a dedicated read owner. The lifecycle facade exports that same
implementation, rather than keeping a second state loader; revision metadata, path helpers and
branch membership also share canonical leaf implementations. Accepted amended Stories still
invoke the original skill/test-command revalidation owners. The optimization does not replace
execution policy with informational state, reinterpret old pins, or grant an author/reviewer action.

Governed-agent Markdown parsing is separated from discovery, synchronization and remote management.
Configuration bootstrap does not import live-agent services until it actually needs them. Snapshot
capture and test-command amendment services are loaded on their own paths, not merely to read an
accepted snapshot. Committed JSON parsing has a bounded 4 MiB / 128-entry byte-digest cache; every
caller receives its own object. It caches parsing only, never Git object availability, a mutable
file/ref, identity, readiness, an approval, or an integrity verdict.

Accepted-history inspection gets first-add and touch evidence from one NUL-delimited, bounded
Git query per exact path. Merge, rename, deletion and restoration evidence retain the original
full-history semantics. Reuse belongs to the existing Git fact owner, including HEAD, object-store,
configuration, replacement, graft and shallow-boundary fingerprints. A request-local root/path
memo is not sufficient: governed blobless hydration can change visibility without moving HEAD.
Failures, malformed history and resource ceilings remain refusals.

Phase review captures one document catalog and uses its private registered records for document
reads. It no longer rebuilds and hashes the whole catalog for each document. The public records
are copies, not authority inputs. Catalog/aggregate changes during the request and changed,
escaped, symlinked or mismatched document bytes remain refused. New catalog/body timings and a
catalog-build counter make the work visible separately from the accepted-snapshot checks.

Draft inspection also has a canonical artifact-read owner. It retains descriptor/path rebinding,
portable exact-byte checks, managed-block normalization and supporting-document fingerprints.
Next-step definitions import this leaf directly, avoiding a first-use jump into the broad
publication chunk merely to determine whether the existing draft changed. Publication reexports
the same functions; there is no second, weaker hash or path implementation.

The small agent-output, catalog-presentation and paged-JSON helpers are claimed before policy
reads in the existing worker-support slot. Merely moving policy roots earlier had made the light
output chunk depend on policy and shifted the cost into every `--for-agent` response. Windows
output-stage timing exposed this regression. A separate 2 MiB presentation-closure guard and
unrelated-policy exclusions now protect rendering as well as the handler's static closure.

The bundle partitioner gives strict next-step definitions their own early ownership, instead of
sharing phase review's larger static closure. Both revisions in a paired measurement must still
use their own selected builder. Deployment remains at most 20 engine files. The next-step closure
now has a tighter 4.25 MiB ceiling; phase review retains its 7 MiB ceiling, and other byte ceilings
are unchanged. The VS Code gateway source-map module ceiling changes from 691 to 701 for eleven
additional leaf modules (701 measured locally). This counts bundled source inputs, not additional
deployed files; its 7,522,000-byte ceiling is unchanged.
The start command's raw-source ceiling likewise changes from 424 to 435 for the extracted leaves;
the local-session source ceiling tightens from 385 to 225 (219 measured). Unrelated-domain
exclusions remain enforced.

Explicit private-worker preparation also loads next-step definitions, without reading a Story,
running a handler, opening a generation, testing, or invoking a model. Demand-started light workers
retain light preparation. Optional preparation does not interrupt an in-flight read; repository,
build, environment, cancellation, queue and age limits remain enforced. Each real read starts a
fresh closed read scope. These worker gains do not automatically apply to arbitrary Copilot shell
commands.

Qualification extends the paired Windows fixtures to legacy, accepted pinned and genuinely
accepted revision-2 skill-amended Stories. Each has 1,000 application files, 20 unrelated branches,
120 additional commits and eight extra draft artifacts plus its primary artifact. The amended
fixture shares setup with adversarial amendment tests and proves both the accepted closure and
the phase's revalidation baseline. Approvals in this synthetic setup are test data only; no user
Story or external repository is modified. Full/bounded output modes and cold/prewarmed processes
are measured separately, with raw first/repeat samples and preparation costs retained. Direct
Node/owned-worker measurements still do not qualify office-laptop shell, security-software,
Copilot-hook or whole-conversation latency.

Expanded Windows regression coverage exposed three existing harness assumptions: Git CRLF
warnings overflowed fixture creation's default 1 MiB child buffer, a path assertion compared
Windows and Git separators literally, and timing-file mode bits were treated as POSIX permissions.
The fixture runner now drains a bounded 16 MiB diagnostic volume, paths compare canonically, and
POSIX mode assertions run only where those bits express that contract. Rotation, stored bytes,
tamper/invalidation checks and all production policy gates remain enforced. This does not attest
Windows ACLs; the report records the original failures and the exact bounded rerun.

The [paired Windows results](../benchmarks/utility-entry/strict-policy-reads.json) compare the
integrated build with main `94b6278d`, using each revision's own builder. There are three fresh
private-V8-cache samples and nine subsequent fresh-process samples per command/output/warmth.
OS caches are not flushed. Legacy/pinned fixtures have 122 commits; the accepted revision-2
amended fixture has 124. All have nine draft artifacts. These are synthetic one-phase read
fixtures, not a claim about a full Story or a long chain of accepted amendments.

Full-JSON CLI first-request medians, milliseconds (before → after):

| Story | Next steps, cold | Next steps, prewarmed | Phase review, cold | Phase review, prewarmed |
| --- | ---: | ---: | ---: | ---: |
| Legacy | 887 → 896 | 687 → 688 | 956 → 933 | 775 → 736 |
| Pinned | 903 → 908 | 732 → 800 | 990 → 963 | 802 → 808 |
| Amended | 3,138 → 2,952 | 2,942 → 2,770 | 3,198 → 3,032 | 3,078 → 2,847 |

The amended strict CLI reads improve about 4–8%, not an order of magnitude. Legacy and pinned
reads are mostly flat; the pinned prewarmed next-step median regresses 9%. Bounded-output pairs,
including their slower cases, are retained separately rather than pooled across different VMs.
Three pairs establish the measured result, not a statistical guarantee about enterprise laptops.

Owned-worker next-step medians, milliseconds:

| Story | Fresh worker | Definition-prepared worker | Prepared-worker repeats |
| --- | ---: | ---: | ---: |
| Legacy | 793 → 782 | 511 → 449 | 297 → 302 |
| Pinned | 1,057 → 996 | 766 → 704 | 563 → 546 |
| Amended | 4,361 → 3,701 | 4,019 → 3,375 | 3,251 → 2,695 |

Definition preparation itself increases from 95 → 147 ms, 71 → 100 ms and 98 → 149 ms respectively.
That work moves before the user request; it is not free. Bytecode preparation costs are also
retained. Worker Git-fact persistence is disabled in this suite, unlike the CLI suite, so the
two sets cannot be subtracted or used as interchangeable speedup claims. Canonical worker
results match before/after except report clocks.

The next-step static closure falls from 7,126,830 to 3,946,716 bytes; deployment remains 20 files.
Presentation falls from 1,847,969 to 1,751,818 bytes instead of inheriting policy. The amended
cold next-step module-load median falls from 171 to 81 ms, but execution still takes 2,656 ms.
Its Story aggregate span is 1,852 ms; accepted-chain and snapshot-byte spans are 1,482 and 260 ms,
and accepted catalog interpretation is 375 ms. These nested spans overlap. YAML parsing is about
3 ms, validation 14 ms and output rendering below 1 ms: those are not the remaining dominant cost.

History batching reduces logical Git requests from 153 to 119 in that sample. With persistent
facts already available, actual spawns remain around 50, explaining why CLI gains are smaller
than worker gains. Phase review builds one catalog; catalog and document-body spans are about
4 and 14 ms for nine artifacts. Further improvement should target the still-shared forensic
accepted-chain/aggregate reads and their real Git processes, including the legacy/amended
fallbacks that deliberately keep their original strict owner. It must not cache a mutable
readiness/approval decision or omit amendment revalidation merely to improve the number.

Windows qualification includes 145 integrity cases (141 initially passed, one skipped, and
three harness portability failures subsequently corrected and rerun), 182 lifecycle/document
cases (175 passed, seven platform skips), 44 final bundle/read cases and the three corrected
portability cases. Repository contracts, type checking and bundle limits pass. Original failed
run IDs and exact correction deltas remain in the report; the original run was not relabeled green.

### Mac strict policy-read qualification (2026-10-17)

The [retained Mac measurements](../benchmarks/utility-entry/mac-strict-policy-reads.json)
compare fresh main `43bac9ea` with runtime/test commit `ac4d4ceb`. The host is an Apple M4,
10 logical CPUs, macOS 26.7.1, Node 25.5.0 and Git 2.54.0. Reports ran serially, with alternating
before/after order within each three-pair sample. Host load is retained: this was a busy
interactive Mac, not a quiescent performance laboratory or a Windows qualification.

Each legacy, pinned and accepted revision-2 amended fixture has 1,000 source files, 20 unrelated
branches, 120 added history commits and nine draft artifacts. Total history is 122/124 commits.
The fixtures have one phase and at most one accepted amendment, not a long amendment chain.
Full and bounded output, cold and bytecode-prepared processes, and fresh/definition-prepared
owned workers are all retained separately. Each command has three first-request samples and
nine repeats. Cold means an empty private V8 cache, **not** flushed OS/Git caches. Each revision
uses its own bundle builder. Worker canonical values match except report clocks. No models or
user Stories were used, and no remote network latency was measured.

The amended load previously verified its accepted snapshot while loading the Story, discarded
the resulting closure, then verified it again to construct the execution catalog. The strict
loader now passes its freshly verified catalog directly to the execution service. Skill
revalidation baselines and accepted test-command epochs still go through their existing forensic
owners. The handoff is private to that load, with exact repository/Story/snapshot identity; it
does not create a cross-request readiness or approval cache. Ordinary domain reads keep their
existing forensic-only contract. Tests refuse forged/cross-root capabilities, changed resolution,
removed committed revalidation markers and stale data on a subsequent load.

Full-JSON CLI first-request medians, milliseconds (before → after):

| Story | Next steps, cold | Next steps, prewarmed | Phase review, cold | Phase review, prewarmed |
| --- | ---: | ---: | ---: | ---: |
| Legacy | 351 → 346 | 263 → 264 | 365 → 362 | 277 → 275 |
| Pinned | 380 → 387 | 377 → 299 | 401 → 411 | 308 → 313 |
| Amended | 746 → 682 | 535 → 421 | 654 → 552 | 545 → 471 |

Amended full-JSON prewarmed policy reads improve about 14–21%; repeated fresh-process reads
improve about 18–27%. Legacy/pinned results are mostly flat and include slower cases; the
isolated pinned prewarmed next-step improvement is not a general pinned-path optimization.
Amended cold inputs preview is slightly slower, 588 → 595 ms, despite faster repeats.
Bounded-output results, all raw first/repeat samples, paired deltas and preparation costs remain
in the report, rather than pooling different output modes or dropping regressions.

Identical-code controls show why cold claims need caution: cold next steps are 649 → 574 ms and
inputs preview 615 → 735 ms with **no code difference**. The matched prewarmed controls are
478 → 479, 489 → 491 and 484 → 485 ms for next steps, phase review and inputs preview. Three pairs
are a measured result, not a statistical guarantee or a complete native Copilot latency claim.

Owned-worker next-step medians, milliseconds:

| Story | Fresh worker | Definition-prepared worker | Prepared-worker repeats |
| --- | ---: | ---: | ---: |
| Legacy | 294 → 288 | 115 → 119 | 50 → 52 |
| Pinned | 362 → 367 | 192 → 189 | 110 → 108 |
| Amended | 869 → 700 | 662 → 593 | 451 → 353 |

Amended definition preparation itself costs about 100 ms, plus roughly 230 ms for bytecode
preparation; neither is free. Worker Git-fact persistence is disabled, unlike the CLI suite,
so their absolute timings cannot be subtracted. Native Copilot hooks, VS Code activation,
publication/approval mutations and full Story runs are outside this measurement.

The amended prewarmed next-step path reduces logical Git requests from 119 to 67, history batches
from 34 to 14 and observed first-sample Git spawns from 50–68 to 36. The candidate records one
accepted-snapshot verification and one catalog handoff per strict load. Its execute-stage median
falls from 434 to 317 ms; accepted-chain and byte-validation spans fall from 206/34 to 110/29 ms.
Nested spans overlap, and the candidate aggregate now includes catalog interpretation. YAML
parsing is about 2 ms, validation 5 ms and output rendering below 1 ms. Nine-artifact catalog/body
reads take about 1/3 ms. First forensic validation and remaining policy execution still cost
time; a YAML cache or a cached approval verdict would not address those costs safely.

Deployment remains 20 files. The next-step closure is 3,948,379 bytes and the phase-review closure
6,961,416 bytes, only 1,663 bytes above baseline and within the unchanged bundle limits.
All 198 targeted regression/audit cases, 2,670 repository checks, VS Code type checking and CLI/
VS Code bundle limits passed. The report identifies the exact tested source and documentation/
reviewed-audit-fingerprint delta; this is not a claim that the entire repository suite ran.

Qualification also found a harness defect: direct fixture Git calls bypassed the product's
existing automatic-maintenance guard. Git 2.54 launched overlapping detached geometric repacks
during rapid history creation, lost temporary packs and left missing commit parents. Those runs
remain failed/diagnostic evidence; every matrix cell was rerun after applying the same existing
process-local guard to fixture setup. No user/repository Git settings or measured CLI environment
were changed. The stress regression proves 122 intact commits, `fsck`, effective setup protection
even with repository maintenance enabled, and unchanged repository settings. Trace hashes and
the excluded pre-fix failures are retained in the report; no integrity refusal was weakened.

To reproduce from the candidate checkout with an exact detached baseline:

```sh
node scripts/bench-utility-entry.mjs /path/to/baseline /path/to/result.json --combined-baseline --samples=3 --commands=policy --story-mode=amended --agent-output=full --history-commits=120 --artifacts=8
node scripts/bench-prepared-reads.mjs /path/to/baseline /path/to/worker.json --samples=3 --story-mode=amended --history-commits=120 --artifacts=8
```

Repeat for `legacy`/`pinned`, `bounded` output, and `--prewarm` on utility runs. Identical-code
controls use the candidate as both source checkouts. Record the explicit Node executable and
host load; do not relabel a concurrent development smoke run as qualification.

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
