---
id: ast-intelligence
title: Optional AST intelligence
aliases:
  - ast
  - structural-intelligence
questions:
  - What is AST intelligence?
  - How do I enable AST intelligence?
  - How do I disable AST intelligence?
  - What happens when AST is unavailable?
  - Can AST be built when a Story starts?
  - Compare AST and text access
keywords:
  - parser
  - semantic facts
  - syntax facts
  - unsupported language
commands:
  - wm
related:
  - project-binding
  - world-model
  - model-independence
version: 4
---
AST intelligence is an optional, bounded source of structural code facts for the world model. It
can identify symbols, imports, declarations, and relationships with an explicit `text`, `syntax`,
or `semantic` assurance label. It never replaces ordinary Copilot file access, Git evidence, or
text grounding, and it never authorizes or blocks a lifecycle transition.

## Purpose and prerequisites

Use AST intelligence when a code question benefits from structural facts instead of broad file
search. No pack is required for ordinary governed work. Run `sflow wm ast doctor --json` before
depending on a particular language, provider, assurance level, or project binding.

## Use it from each surface

- **Shell:** run `sflow wm ast doctor --json`, then a bounded `sflow wm ast context` or `query`.
- **Copilot:** use `/sf-worldmodel` and request one bounded AST status, context, or query read.
- **VS Code:** open **Singularity Flow → Configuration → AST intelligence** for the simple Auto/Off choice and diagnostics.

## Guided workflow

In VS Code open **Singularity Flow → Configuration → AST intelligence**. The simple repository
choice is **Auto** or **Off**. The equivalent machine-local commands are
`sflow wm ast preference set auto` and `sflow wm ast preference set off`. Effective mode is the
most restrictive of repository policy, machine preference, environment override, and an explicit
operation override.

`auto` means use an available reviewed provider within the configured safety budgets. It does not
promise semantic assurance. `off` returns a valid disabled result without scanning or creating a
cache. In either mode normal file access and governed work continue.

The repository can also set `ast.warmOnStoryStart.mode` to `background` (the default),
`before-first-phase`, or `off`. The VS Code AST Intelligence page exposes this as **Warm the AST
cache when a Story starts**. Background warming starts only after the governed Story commit is
durable and lets Story work continue immediately. The wait option completes the same bounded build
before returning from Story start. Neither option can fail, roll back, or block the Story.

`scope: configured-roots` uses pinned capability/world-model roots and falls back to the bounded
repository when no roots are declared. `scope: repository` explicitly requests the bounded entire
repository. The worker is tied to the exact starting revision and skips instead of warming a newer
checkout. Its local status is shown by `wm ast doctor`; it creates no governed commit and uses no
model.

## Availability and assurance

Run `sflow wm ast doctor --json` for effective mode, language/provider coverage, existing project
bindings, available assurance, diagnostics, and cache size. JavaScript and TypeScript have bundled
lexical facts. Java, Python, Kotlin, and Swift can use the bundled text-assured preview; reviewed
parser or semantic packs are optional.

Missing packs, unsupported languages, adapter failures, incomplete project bindings, and evidence
store failures produce disabled or partial diagnostics. Even a predicate marked `required` is
required only for an explicitly requested `wm ast gate` diagnostic; it is not a publication,
submission, readiness, or governance gate.

Start with a small query such as `sflow wm ast query --predicate symbol --value Payment --paths src
--max-facts 50 --max-output-bytes 32768 --json`; follow its opaque cursor only if the question is
unanswered. Successful reads automatically warm immutable Git-backed skeletons in the disposable
Git-common cache. Dirty and untracked bytes remain memory-only. `wm ast build` remains the explicit,
fail-closed way to build a cone manifest or surface cache write failures.

## State and safety

Context and query reads are bounded by selected paths, files, facts, and output bytes. Start with a
small scope and widen it deliberately. AST results contain facts and provenance rather than source
bodies. Automatic warming writes only disposable content-addressed cache entries and never governed
state; a write failure produces a warning and the read continues. Semantic warm-up, explicit builds,
pruning, and clearing retain their documented boundaries. No AST outcome grants lifecycle authority.

## Troubleshooting

- A disabled result is valid; inspect the effective policy layers before changing configuration.
- Partial coverage or `AST_LANGUAGE_UNSUPPORTED` means ordinary file access continues without a structural claim for that source.
- If semantic assurance is unavailable, inspect `project-binding` and the provider/toolchain row; do not relabel text facts as semantic.
- Use the returned cursor instead of restarting a partial bounded read with repository-wide scope.

## Related topics

Continue with `sflow explain project-binding`, `sflow explain world-model`, or the detailed
`docs/AST-INTELLIGENCE.md` reference included with the installation.
