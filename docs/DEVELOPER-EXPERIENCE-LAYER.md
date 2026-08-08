# Developer Experience Layer

This document describes the shipped P0/P1 developer-experience layer. It is a
thin deterministic surface over the existing lifecycle engine; it does not add a
second workflow state store or silently invoke a model.

## First run

`singularity-flow guide --first-run` executes a real disposable quick-fix Story.
The sandbox is announced before work starts, has isolated Git and home state, and
uses neither network nor model access. Success removes the sandbox by default;
failure preserves it with diagnostics.

## Proportional quick fixes

The `quick-fix` work type has exactly two phases:

1. **Implement** produces deterministic change evidence and requires no human
   approval by explicit contract.
2. **Verify** produces deterministic verification evidence. The configured
   `quick-fix-low-risk-v1` policy may waive review only when its complete,
   hash-recorded predicate set passes.

A policy waiver is an audited lifecycle decision and is never represented as a
human approval. A failed predicate preserves the normal approval boundary.

## Conditional snapshots and timings

`snapshot --if-revision` supports cheap polling. Snapshot envelopes contain
per-slice hashes and one coherent revision derived from HEAD, index/worktree
content, untracked bytes, and selected subject state. Timings are opt-in through
`--timings`; human output is written separately from JSON payloads.

## Deterministic pull-request descriptions

`pr describe` renders lifecycle status, clause claims, governance warnings, and
worldline information from governed state. It is local and read-only by default.
Clipboard copying and editing an already existing PR are explicit options. PR
creation is not an implicit side effect.

## Command metadata

The command registry now records classification, model policy, output behavior,
and its current module owner. This is the compatibility foundation for later CLI
decomposition; it does not claim that every command has already moved into a
separate lazy-loaded module.

## Not yet claimed

The broader developer-experience program also proposes richer `why` and `me`
commands and an optional resident host. Those remain future, evidence-gated work.
The current layer keeps the CLI process-per-command architecture and measures it
before introducing another long-running local process.
