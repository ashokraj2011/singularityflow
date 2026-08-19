# AST Intelligence

Singularity Flow's structural-intelligence broker adds bounded, evidence-bearing code facts to the
world-model path. It is optional. It does not replace the existing text and Git paths, does not run
a daemon, and never makes a lifecycle gate weaker when it is disabled.

## What this release provides

- a versioned result envelope bound to the configuration, repository revision, and selected-cone
  content hash;
- Git-index census with explicit path, capability-cone, changed-file, and opt-in `--all` scopes;
- file, symbol, and import references at honest `text` assurance, without source bodies in results;
- per-operation file, byte, and individual-file budgets with visible partial coverage;
- a per-blob content-addressed skeleton cache plus cone manifests below
  `<git-common-dir>/singularity-flow/ast/v2`;
- machine-local `auto`/`off` preference combined with repository and environment policy by choosing
  the most restrictive value;
- a versioned, structured-argv contract for bounded out-of-process syntax/semantic adapters;
- resumable builds that retain accumulated pages and return a usable handle even when the first
  file exceeds the current operation budget; and
- deterministic structural predicates enforced before phase publication and revalidated from a
  governed receipt before submission and terminal governance.

The built-in JavaScript/TypeScript extractor remains lexical and its facts are labeled `text`.
Syntax or semantic assurance is accepted only from an explicitly configured adapter after its
identity, version, request binding, paths, content hashes, fact kinds, assurance, output size, and
JSON response validate. Compiler-backed TypeScript, Android/JVM project models, iOS/Swift project
models, semantic resolution, and codemods remain adapter-pack milestones; Kotlin and Swift filename
recognition alone is not parser support.

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

Repository changes are validated and saved locally through the configuration engine. They are not
published automatically. Cache pruning and clearing require a preview followed by the exact
confirmation phrase. Context previews show coverage, degradation, and diagnostics only; source
bodies, facts, adapter process details, and resume handles are not copied into the webview.

### YAML and CLI

```yaml
ast:
  mode: auto                 # auto | off
  fallback: host-and-text    # host-and-text | text-only
  budgets:
    maxFiles: 500
    maxBytes: 20971520
    maxFileBytes: 2097152
  languages:
    typescript:
      mode: auto
      minimumAssurance: text
```

The active Story's pinned capability source roots are authoritative. When no roots are pinned, an
ordinary AST request examines changed tracked paths only. Repository-wide work requires `--all`.

The effective mode is the most restrictive of `ast.mode`, the machine preference,
`SINGULARITY_FLOW_AST`, and an operation override. With mode `off`, the command returns a valid
`disabled` envelope before repository census or fingerprinting and creates no cache or
materialization side effects.

`fallback: text-only` never starts an adapter. `fallback: host-and-text` may execute a compatible
adapter declared through `SINGULARITY_FLOW_AST_ADAPTER_MANIFESTS`; bounded text facts remain
available when the adapter is absent or fails, and the result becomes partial when configured
assurance cannot be established. `generatedRoots` are tagged in facts rather than silently omitted.

## Use

```bash
singularity-flow wm ast doctor
singularity-flow wm ast status --json
singularity-flow wm ast context --paths src --max-files 200 --json
singularity-flow wm ast query --predicate symbol --value Payment --paths src --json
singularity-flow wm ast build --paths src --json
singularity-flow wm ast build --resume HANDLE --json
singularity-flow wm ast gate --paths src --json
singularity-flow wm ast cache status
singularity-flow wm ast cache prune --dry-run
singularity-flow wm ast cache prune --confirm "PRUNE AST CACHE"
singularity-flow wm ast cache clear --dry-run
singularity-flow wm ast cache clear --confirm "CLEAR AST CACHE"
singularity-flow wm ast preference set off
singularity-flow wm ast preference set auto
```

`--paths` may be repeated or contain comma-separated repository-relative prefixes. Symlinks,
gitlinks, missing paths, oversized files, and budget omissions are reported as degradation rather
than silently treated as evidence. `--all` is never inferred. A budget-limited build returns an
opaque, single-use, 24-hour resume handle, including when zero files fit. The diagnostic states the
minimum byte budget needed for the next file. Each page adds to the same cone manifest; resumption
fails closed if configuration, repository revision, selection, or any selected-cone byte changes.
An edit outside the selected cone does not invalidate the job or miss unchanged blob cache entries.

`context`, `query`, and `gate` reuse compatible blob records but never fill the cache. Only `build`
writes derived blobs and manifests. Query coverage reports facts examined, matched, and returned
separately. Cache pruning removes stale manifests/jobs, legacy v1 records, and blobs no live
manifest references; it does not use a repository-wide dirty-tree hash.

## Lifecycle enforcement

When `ast.predicates` is empty, lifecycle behavior is unchanged. When predicates are configured:

1. publication evaluates the bounded selected cone before any generation mutation;
2. any required failure, unknown, disabled result, adapter shortfall, or partial coverage blocks;
3. a passing evaluation is stored as a content-integrity receipt for that phase generation;
4. submission re-reads the receipt and re-evaluates the exact accepted paths; and
5. governance and terminal gates verify the receipt's exact integrity-protected bytes from the
   generation commit rather than trusting a later working-tree copy.

The receipt binds the work item, phase, generation, configuration policy hash, repository revision,
cone hash, evaluated paths, assurance, predicate outcomes, and diagnostics. Advisory predicates are
reported but do not authorize a failed required predicate.

## Copilot and gateway reads

`/sf-worldmodel` exposes the same bounded CLI operations. Gateway hosts can resolve model-free
`wm.ast.status`, `wm.ast.context`, and `wm.ast.query` reads; they return the validated result envelope
with no source bodies and cannot build cache entries or advance lifecycle state. Whole-repository
scope remains explicit.

## Safety and troubleshooting

- Results contain paths, hashes, declaration locations, and dependency targets—not source bodies.
- Adapter processes receive a bounded request naming only selected paths and content hashes through
  JSON stdin; their commands are structured argv, never shell strings, and their output is
  size/time bounded. Adapter-authored prose and stderr are not retained in results because they can
  contain source bytes, credentials, or host paths. Adapters are trusted local executables and
  retain the current user's filesystem access, so configure only reviewed adapters.
- The cache is derived local state. It is never committed and may be cleared after preview and exact
  confirmation. Linked worktrees share the repository's Git-common cache.
- A malformed local preference fails closed with its exact path and repair command.
- Adapter manifests are discovered only through `SINGULARITY_FLOW_AST_ADAPTER_MANIFESTS`, a
  platform-delimited list of explicit JSON files. The broker does not search repositories or PATH.
- Run `wm ast doctor --json` to see the effective mode, pinned cone, available assurance, invalid
  adapter diagnostics, and cache size.

See also [World model](topics/world-model.md), [Repository state and snapshots](topics/repository-state-and-snapshots.md), and [Diagnostics](topics/diagnostics-and-regression.md).
