# AST Intelligence

Singularity Flow's structural-intelligence broker adds bounded, evidence-bearing code facts to the
world-model path. It is always optional. It does not replace the existing text and Git paths, does
not run a daemon, and never participates in lifecycle authorization.

## What this release provides

- a versioned result envelope bound to the configuration, repository revision, and selected-cone
  content hash;
- Git-index census with explicit path, capability-cone, changed-file, and opt-in `--all` scopes;
- file, symbol, and import references at honest `text` assurance, without source bodies in results;
- a bundled, on-demand polyglot structural preview for Java, Python, Kotlin, and Swift declarations,
  signatures, nesting, imports, annotations, declared relationships, and exact spans, all honestly
  labeled `text` because the scanner is not a language parser;
- a data-driven `LanguageCatalogV1`, rich protocol-v2 fact boundary, and deterministic syntax-first,
  optional-semantic provider pipeline;
- bounded, existing-only Maven, Gradle/Android, Python, SwiftPM, and Xcode project discovery that
  hashes existing metadata without running builds, dependency resolution, or repository scripts;
- per-operation file, byte, and individual-file budgets with visible partial coverage;
- separate content-addressed text, syntax-skeleton, and semantic-overlay cache families plus cone manifests below
  `<git-common-dir>/singularity-flow/ast/v2`;
- machine-local `auto`/`off` preference combined with repository and environment policy by choosing
  the most restrictive value;
- optional Story-start cache warming with a non-blocking background default, a wait-before-first-
  phase choice, and a fully disabled choice;
- a versioned, structured-argv contract and guarded machine-local registry for bounded
  out-of-process syntax/semantic adapter packs;
- immutable derivation manifests that bind exact committed Git objects, policy/profile/options,
  engine and adapter artifacts, runtime, grammars, dependencies, and canonical output digests;
- a read-after-write-verified directory evidence store plus cache-independent, model-free replay;
- resumable builds that retain accumulated pages and return a usable handle even when the first
  file exceeds the current operation budget; and
- deterministic structural predicates available through explicit diagnostics without becoming a
  prerequisite for publication, submission, readiness, or terminal governance.

The built-in JavaScript/TypeScript extractor remains lexical and its facts are labeled `text`.
Java, Python, Kotlin, and Swift use the legacy-named `sflow-polyglot-syntax` pack for a structural
preview when effective policy permits adapters. Despite that compatibility ID and its syntax pipeline
stage, it performs comment-aware line scanning rather than parsing; its manifest and every emitted
fact therefore have `text` assurance, no grammar identity, and `preview` conformance. It cannot
satisfy a required syntax gate. Parser-backed Java/JDT, Python/Pyright, Kotlin Analysis, and
Swift/SourceKit providers remain optional packs: their absence retains text previews and reports the
exact parser/project/toolchain boundary.

## Configure

### VS Code

Open **Singularity Flow → Configuration → AST intelligence**, select **AST intelligence** in the
Configuration Center, or run **Singularity Flow: AST Intelligence Settings** from the Command
Palette. The same destination can be pinned in Favorites; Architect and Admin personas receive it
as a first-use favorite.

The panel exposes all four policy layers without hiding their precedence:

- repository mode, fallback, generated roots, budgets, language policy, and structural predicates;
- the machine-local `auto`/`off` preference;
- the effective `SINGULARITY_FLOW_AST` environment override as read-only state; and
- a bounded operation override for context preview or cache build.

The scope banner names the active workspace, selected repository, local repository root, and how
that context was resolved. When a workspace contains several repositories, choose one in that
banner. The selection uses the same durable `workspace use --repository` record as the CLI,
Copilot, My Work, Lifecycle, and Configuration; it is not a panel-local override. Repositories that
are missing or need workspace repair cannot be selected.

Repository changes are validated and saved locally through the configuration engine. They are not
published automatically. Cache pruning and clearing require a preview followed by the exact
confirmation phrase. Context previews show coverage, degradation, and diagnostics only; source
bodies, facts, adapter process details, and resume handles are not copied into the webview.

### YAML and CLI

```yaml
ast:
  mode: auto                 # auto | off
  fallback: host-and-text    # host-and-text | text-only
  warmOnStoryStart:
    mode: background         # background | before-first-phase | off
    scope: configured-roots  # configured-roots | repository
  evidence:
    mode: replayable         # replayable | identified | off
  budgets:
    maxFiles: 500
    maxBytes: 20971520
    maxFileBytes: 2097152
  languages:
    java:
      mode: auto
      minimumAssurance: text
      syntaxProvider: sflow-polyglot-syntax  # optional text-only structural preview
    python:
      mode: auto
      minimumAssurance: text
    kotlin:
      mode: auto
      minimumAssurance: semantic
      semanticProvider: sflow-kotlin-analysis # optional installed pack
      semanticProfile: android-debug
    swift:
      mode: auto
      minimumAssurance: text
```

The active Story's pinned capability source roots are authoritative. When no roots are pinned, an
ordinary AST request examines changed tracked paths only. Repository-wide work requires `--all`.

Story-start warming is different from an ordinary unscoped read. It runs only after the governed
Story commit and any required publication have succeeded. `configured-roots` uses the Story's
pinned capability/world-model roots; when no roots are declared it explicitly selects the bounded
repository scope. `repository` always selects that bounded repository scope. `background` launches
an independent local worker and returns immediately. `before-first-phase` waits for the same build
before returning from Story start. In both modes failures become local status warnings, never undo
the Story, and never block a phase. The latest job is visible in AST Intelligence and `wm ast doctor`.

The effective mode is the most restrictive of `ast.mode`, the machine preference,
`SINGULARITY_FLOW_AST`, and an operation override. With mode `off`, the command returns a valid
`disabled` envelope before repository census or fingerprinting and creates no cache or
materialization side effects.

`fallback: text-only` never starts an adapter. `fallback: host-and-text` may execute the bundled
structural preview, a reviewed machine-installed parser pack, or an explicit development/test manifest. Bounded
text facts remain available when a pack is absent or fails, and the result becomes partial when
configured assurance cannot be established. `generatedRoots` are tagged in facts rather than
silently omitted. Repository files can select an allowed provider ID but can never supply `argv`.

While AST is enabled, an unknown programming-language extension is skipped with the warning
`AST_LANGUAGE_UNSUPPORTED`; the result is partial and ordinary file access continues. Install a
reviewed pack whose validated manifest advertises the language and extension to obtain structural
facts for that source, or turn AST off when structural intelligence is not wanted. Documentation,
configuration, stylesheets, and assets are not classified as programming-language claims by this
check.

## Use

```bash
singularity-flow wm ast doctor
singularity-flow wm ast status --json
singularity-flow wm ast context --paths src --max-files 200 --max-facts 50 --max-output-bytes 32768 --json
singularity-flow wm ast context --cursor OPAQUE-CURSOR --json
singularity-flow wm ast query --predicate symbol --value Payment --paths src --max-facts 50 --max-output-bytes 32768 --json
singularity-flow wm ast query --cursor OPAQUE-CURSOR --json
singularity-flow wm ast query --predicate symbol-id --value SYMBOL-ID --paths src --json
singularity-flow wm ast query --predicate references --value SYMBOL-ID --paths src --json
singularity-flow wm ast query --predicate hierarchy --value SYMBOL-ID --paths src --json
singularity-flow wm ast query --predicate module --value MODULE --paths src --json
singularity-flow wm ast build --paths src --json
singularity-flow wm ast build --resume HANDLE --json
singularity-flow wm ast gate --paths src --json
singularity-flow wm ast evidence reproduce --receipt singularity/work-items/WRK-1/context/ast/intake-gen1.json --json
singularity-flow wm ast warm --semantic --provider sflow-java-jdt --project maven:. --profile default --dry-run
singularity-flow wm ast cache status
singularity-flow wm ast cache prune --dry-run
singularity-flow wm ast cache prune --confirm "PRUNE AST CACHE"
singularity-flow wm ast cache clear --dry-run
singularity-flow wm ast cache clear --confirm "CLEAR AST CACHE"
singularity-flow wm ast preference set off
singularity-flow wm ast preference set auto
singularity-flow wm ast pack list
singularity-flow wm ast pack doctor sflow-polyglot-syntax
singularity-flow wm ast pack install /offline/pack/manifest.json --dry-run
singularity-flow wm ast pack install /offline/pack.tgz --dry-run
singularity-flow wm ast pack remove PACK --dry-run
```

`--paths` may be repeated or contain comma-separated repository-relative prefixes. Symlinks,
gitlinks, missing paths, oversized files, and budget omissions are reported as degradation rather
than silently treated as evidence. `--all` is never inferred. A budget-limited build returns an
opaque, single-use, 24-hour resume handle, including when zero files fit. The diagnostic states the
minimum byte budget needed for the next file. Each page adds to the same cone manifest; resumption
fails closed if configuration, repository revision, selection, or any selected-cone byte changes.
An edit outside the selected cone does not invalidate the job or miss unchanged blob cache entries.

`context`, `query`, and `gate` reuse compatible blob records and best-effort warm missing immutable
Git-backed skeletons. Dirty and untracked bytes remain memory-only; an unavailable cache is reported
as `AST_CACHE_WARM_FAILED` without changing the structural result or blocking ordinary work. `build`
writes derived blobs plus manifests and remains fail-closed on cache write errors. Context and query
additionally bound model-facing output by
fact count and serialized JSON bytes. A first page includes coverage plus an opaque 24-hour
`nextCursor`; `--cursor` continues the same operation without accepting a replacement scope,
query, or budget. The cursor is stateless and integrity-bound to the repository, policy, revision,
selected-cone hash, input budgets, output limits, and next offset. Any relevant byte change makes
it stale. Query coverage reports facts examined, matched, and returned separately. Cache pruning
removes stale manifests/jobs, legacy v1 records, and blobs no live manifest references; it does not
use a repository-wide dirty-tree hash.

The Story-start worker is revision-bound: if the checkout moves before it begins, it records
`repository-revision-changed` and does no work. Its status and output summary live only below the
Git-common AST cache. It never edits application files, creates a governed commit, invokes a model,
or writes to a Story branch. The normal AST budgets still apply, so a large scope can report a
partial, resumable warm rather than turning Story creation into an unbounded scan.

Every structural result declares an evidence class. Ordinary CLI and UI reads are `preview` and may
inspect dirty worktree bytes. Governed prompt context is `recorded-context`; `gate` is an explicit
diagnostic class. Durable capture enumerates selected committed Git blobs. Dirty, untracked,
symlink, gitlink, missing-object, or otherwise degraded in-cone inputs produce a partial result and
omit durable evidence instead of failing the operation. Dirty paths outside the selected cone are
ignored. Commit the relevant bytes or narrow the cone when durable reproduction is desired.

Derivations are committed below
`singularity/work-items/<WORK-ID>/context/ast/derivations/`. Toolchain bundles are retained by SHA-256
in the directory evidence store; the default physical store is the workspace-local
`.singularity-flow/ast-evidence-store` directory. No store configuration is required.
`SINGULARITY_FLOW_AST_EVIDENCE_STORE` may select a shared directory without exposing that
path in governed evidence. Clearing `<git-common-dir>/singularity-flow/ast/` removes only disposable
skeletons and does not affect replay. Replay resolves source bytes from the recorded commit and exact
Git objects, verifies the retained toolchain by digest, never reads or fills the skeleton cache, and
returns `identical`, `different`, or an honest `unavailable` reason. It never substitutes a currently
installed artifact with a different digest.

The bundled lexical extractor and bundled polyglot structural preview are fully retainable and replayable.
Protocol-v2 external adapters are digest-verified for live use. Replayable publication retains the
exact manifest, executable/package files, runtime identity, grammar and dependency digests in the
evidence store; reproduction reconstructs that retained bundle and refuses when any required
toolchain identity is unavailable. The runtime never substitutes a newly installed provider or
labels an unretained external toolchain replayable. `replay` remains a compatibility alias for the
canonical `reproduce` action.

### Bundled-preview provenance

The legacy-named bundled polyglot pack is repository-native preview code, not a parser and not a
repackaged third-party grammar.
Its source is `src/ast-packs/polyglot-syntax-core.mjs`, it inherits the repository's MIT license,
and its manifest records a digest of the exact source used for each derivation. It has no generated
binary, downloaded grammar, or separate build step. Optional parser and semantic packs must instead declare
their license metadata and bind the adapter, runtime, grammar, and dependency artifacts by digest;
an incomplete or mismatched manifest is unavailable rather than silently downgraded.

## Lifecycle independence

AST never gates publication, submission, readiness, or governance. A predicate marked `required`
means only that an explicitly requested `wm ast gate` diagnostic reports `allowed: false` when the
predicate cannot be established. It does not create a workflow prerequisite or receipt obligation.
Repository, machine, environment, workflow-profile, and operation-level AST-off switches are always
valid. Missing packs, unsupported languages, adapter failures, incomplete project bindings, dirty
evidence inputs, and evidence-store problems are reported as disabled/partial diagnostics while the
workflow continues through ordinary Git and file access.

When durable diagnostic evidence is successfully captured, its derivation still binds exact input
objects, configuration, engine/adapter/runtime/grammar/dependency artifact digests, and outputs.
Migrated v1/v2 receipts remain authentic historical records but are `legacy-unreplayable`; they are
never required for current lifecycle transitions. A `required` `symbol-exists` diagnostic still
needs syntax assurance to report a pass; a lexical name remains advisory evidence.

## Copilot and gateway reads

`/sf-worldmodel` exposes the same bounded CLI operations. Gateway hosts can resolve model-free
`wm.ast.status`, `wm.ast.context`, `wm.ast.query`, `wm.ast.symbol`, `wm.ast.references`,
`wm.ast.hierarchy`, `wm.ast.module`, and `wm.ast.evidence.replay` reads; they return the validated
result envelope with no source bodies. Successful reads may warm disposable local cache entries but
cannot write governed configuration/state, create manifests, or advance lifecycle state.
The embedded VS Code gateway exposes the same planners. The workflow and developer agents direct
symbol/import questions through these bounded reads and follow a continuation only while the
question remains unanswered. Whole-repository scope remains explicit.

## Safety and troubleshooting

- Results contain paths, hashes, declaration locations, and dependency targets—not source bodies.
- JavaScript and TypeScript receive built-in lexical symbols. Java, Python, Kotlin, and Swift use
  the bundled text-assured structural preview unless policy selects `off`/`text-only`; other catalogued
  languages retain the text floor until a reviewed pack is installed. Recognition and preview
  scanning are never claimed as parsing.
- Programming source that the compiled language catalog cannot identify is skipped with a visible
  warning and partial coverage. Normal Copilot file access, code delivery, and lifecycle transitions
  continue regardless of AST language support or availability.
- Adapter protocol v2 manifests bind the executable/package, manifest, runtime, grammars, and
  dependency artifacts by SHA-256. The broker verifies the executable digest before launch and the
  adapter must echo the request derivation identity and implementation digests.
- Adapter processes receive a bounded request naming only selected paths and content hashes through
  JSON stdin; their commands are structured argv, never shell strings, and their output is
  size/time bounded. Adapter-authored prose and stderr are not retained in results because they can
  contain source bytes, credentials, or host paths. Adapters are trusted local executables and
  retain the current user's filesystem access, so configure only reviewed adapters.
- The cache is derived local state. It is never committed and may be cleared after preview and exact
  confirmation. Linked worktrees share the repository's Git-common cache.
- A malformed local preference fails closed with its exact path and repair command.
- Installed manifests are discovered only from the guarded machine-local pack registry.
  `SINGULARITY_FLOW_AST_ADAPTER_MANIFESTS` remains a development/test override. The broker does not
  discover executable configuration from repositories or PATH.
- Pack installation accepts a local manifest/directory or a bounded `.tar`, `.tar.gz`, or `.tgz`
  archive. Its in-process reader checks compressed bytes, extracted bytes, expansion ratio, member
  count, header checksums, paths, types, and link metadata before materializing regular files into an
  isolated directory. It validates the manifest and every artifact digest, previews the content-bound
  confirmation, never delegates extraction to system `tar`, and never fetches a network URL.
- Semantic warm-up is an explicit mutation. Its preview discloses each structured command and
  repository configuration effect; confirmation is bound to the provider, project, profile,
  metadata, and command plan. Normal context/query/gate reads never warm a project or resolve
  dependencies. Warm commands use provider-specific offline flags.
- Timed-out or cancelled adapter processes terminate their process tree before the broker returns,
  so a descendant cannot continue writing delayed derived output.
- Run `wm ast doctor --json` to see the effective mode, pinned cone, per-language provider matrix,
  existing-only project bindings, available assurance, invalid-pack diagnostics, and cache size.

See also [World model](topics/world-model.md), [Repository state and snapshots](topics/repository-state-and-snapshots.md), and [Diagnostics](topics/diagnostics-and-regression.md).
