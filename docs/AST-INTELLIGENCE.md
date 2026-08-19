# AST Intelligence

Singularity Flow's structural-intelligence broker adds bounded, evidence-bearing code facts to the
world-model path. It is optional. It does not replace the existing text and Git paths, does not run
a daemon, and never makes a lifecycle gate weaker when it is disabled.

## What this release provides

- a versioned result envelope bound to the configuration, repository revision, and content-aware
  worktree fingerprint;
- Git-index census with explicit path, capability-cone, changed-file, and opt-in `--all` scopes;
- file, symbol, and import references at honest `text` assurance, without source bodies in results;
- per-operation file, byte, and individual-file budgets with visible partial coverage;
- a derived cache below `<git-common-dir>/singularity-flow/ast/v1`;
- machine-local `auto`/`off` preference combined with repository and environment policy by choosing
  the most restrictive value;
- a versioned, structured-argv contract for optional out-of-process syntax/semantic adapters; and
- deterministic structural predicates whose required unknown, failed, or partial results never pass.

This release does **not** claim that its lexical TypeScript/JavaScript references are parser facts.
They are labeled `text`. Compiler-backed TypeScript, Android/JVM, iOS/Swift, semantic resolution,
codemods, and MCP structural tools remain adapter-pack milestones. An adapter advertisement alone
does not raise result assurance; the broker must execute and validate a supported adapter in a
future release.

## Configure

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
`disabled` envelope and creates no cache or materialization side effects.

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
opaque, single-use, 24-hour resume handle. Resumption fails closed if the configuration, revision,
or any worktree byte has changed.

## Safety and troubleshooting

- Results contain paths, hashes, declaration locations, and dependency targets—not source bodies.
- The cache is derived local state. It is never committed and may be cleared after preview and exact
  confirmation. Linked worktrees share the repository's Git-common cache.
- A malformed local preference fails closed with its exact path and repair command.
- Adapter manifests are discovered only through `SINGULARITY_FLOW_AST_ADAPTER_MANIFESTS`, a
  platform-delimited list of explicit JSON files. The broker does not search repositories or PATH.
- Run `wm ast doctor --json` to see the effective mode, pinned cone, available assurance, invalid
  adapter diagnostics, and cache size.

See also [World model](topics/world-model.md), [Repository state and snapshots](topics/repository-state-and-snapshots.md), and [Diagnostics](topics/diagnostics-and-regression.md).
