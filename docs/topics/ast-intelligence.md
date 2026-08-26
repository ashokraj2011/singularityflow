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
version: 1
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
unanswered. Cache population occurs only through the explicit `wm ast build` command.

## State and safety

Context and query reads are bounded by selected paths, files, facts, and output bytes. Start with a
small scope and widen it deliberately. AST results contain facts and provenance rather than source
bodies. Cache writes, semantic warm-up, pruning, and clearing remain explicit operations with their
documented confirmation boundaries. No AST outcome grants lifecycle authority.

## Troubleshooting

- A disabled result is valid; inspect the effective policy layers before changing configuration.
- Partial coverage or `AST_LANGUAGE_UNSUPPORTED` means ordinary file access continues without a structural claim for that source.
- If semantic assurance is unavailable, inspect `project-binding` and the provider/toolchain row; do not relabel text facts as semantic.
- Use the returned cursor instead of restarting a partial bounded read with repository-wide scope.

## Related topics

Continue with `sflow explain project-binding`, `sflow explain world-model`, or the detailed
`docs/AST-INTELLIGENCE.md` reference included with the installation.
