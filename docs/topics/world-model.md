---
id: world-model
title: World model grounding and views
aliases:
  - worldmodel
  - wm
  - grounding
commands:
  - wm
related:
  - agents-and-routing
  - model-independence
  - knowledge-and-remote-assets
version: 8
---
The world model provides repository-grounded views used during governed generation. In a monorepo, scope it to the capability's source and shared directories so unrelated products do not increase scan cost or invalidate evidence.

## Purpose and prerequisites

Use this topic when the current goal matches **world model**. Start in a governed checkout unless the command explicitly operates on installation or machine-local workspace state. Run `sflow doctor` when setup, identity, credentials, or repository health is uncertain, and use `sflow status` or `sflow home` to confirm the selected work before a mutation.

## Use it from each surface

- **Shell:** `sflow wm`. Run `singularity-flow wm --help` for the exact forms supported by this build.
- **Copilot:** `/sf-worldmodel` for world-model and bounded AST status, context, query, build, and evidence-replay guidance. Model-free gateway hosts may resolve bounded AST status/context/query/replay reads; cache builds remain explicit CLI operations.
- **VS Code:** open Singularity Flow **Configuration Center → World model** for grounding scope, or **Configuration → AST intelligence** for structural policy, lifecycle predicates, adapter availability, coverage, and guarded cache maintenance. The AST scope banner identifies the active workspace repository and, for multi-repository workspaces, switches the shared repository used by VS Code, Copilot, and the CLI. Both settings surfaces save the same YAML used by the CLI.

## Guided workflow

1. For a normal repository, leave `worldModel.sourceRoots` and `sharedRoots` absent to describe the whole application tree.
2. For a monorepo, set `sourceRoots` to the owned application directories and `sharedRoots` to required contracts/libraries. Capability scopes override application roots at the nearest child and inherit shared roots additively.
3. Run `sflow doctor --performance --offline`. Review scoped/total file counts and warm fingerprint time before building.
4. Run `sflow wm status`, then explicitly materialize with `sflow wm light`, `sflow wm build`, or `sflow wm ensure` as policy requires.
5. Re-read `sflow wm check`. New Stories and Initiatives pin the resolved capability scope, so later capability-map edits do not silently change their evidence boundary.
6. If structural predicates are configured, run `sflow wm ast gate --json` for diagnostics before publishing. Publication enforces required predicates and writes a generation-bound receipt referencing exact-input, retained-toolchain evidence; submission revalidates it. Audit later with `sflow wm ast evidence reproduce --receipt <RECEIPT> --json` (`replay` remains a compatibility alias).
7. If validation succeeds but publication fails, run `sflow wm recovery list`, inspect the retained ID, then use `sflow wm recovery publish <ID> --confirm <ID>`. It republishes the retained bytes without another model call.

## State and safety

World-model fingerprints use Git's existing index object IDs for clean paths and read visible bytes only for changed or untracked paths. They do not write Git objects or execute configured clean filters. Sparse-checkout paths absent from disk remain represented by their index objects and are not mistaken for deletions. Semantic model generation and governed publication still mutate only through the documented `wm` commands and lifecycle checks.

AST context/query/gate reads reuse content-addressed blob skeletons but never populate the cache;
only `wm ast build` writes derived local cache records. The built-in JavaScript/TypeScript facts are
lexical `text` assurance. Java, Python, Kotlin, and Swift receive `text`-assured declaration previews
from the bundled, on-demand polyglot scanner unless the effective policy is `off` or `text-only`.
That scanner is not a language parser and cannot satisfy required syntax gates. Optional reviewed
parser or semantic packs can provide syntax or semantic evidence when their immutable
project/toolchain binding is complete. Required symbols always need parser-backed syntax or
semantic assurance; a text match is
advisory. Context and query results are bounded by fact count and
serialized output bytes and continue through an opaque cursor bound to the exact cone. Required
predicates fail closed on partial coverage, disabled analysis, insufficient assurance, or a failed
predicate.

Use `sflow wm ast pack list` and `sflow wm ast pack doctor [PACK]` to inspect providers. Installing
or removing a local offline pack is previewed and requires its content-bound confirmation phrase;
repository configuration can select provider IDs but cannot register executable paths. The VS Code
AST Intelligence page shows the effective per-language provider, assurance, project-model, and
toolchain matrix for the selected repository.

## Troubleshooting

- If the selected Story or branch is wrong, stop and use `sflow home`, `sflow session`, or `sflow workspace list` before retrying.
- If a command refuses because state moved, refresh and use the newly rendered action instead of replaying an old handle or confirmation.
- If publication or synchronization is pending, follow the exact recovery command in the refusal and verify with `sflow doctor`.
- If all files remain in scope, save non-empty `sourceRoots`/`sharedRoots` in Configuration Center or the capability map; an empty list deliberately means the whole application tree.
- If a scoped file is absent because of sparse checkout, add its directory to the capability's sparse cone and create/repair the workspace. Do not manually copy files around Git's sparse index.
- If warm status or fingerprint time remains high, run `sflow doctor --performance --json` and retain the measurements when asking the repository platform team about FSMonitor or untracked-cache policy.
- If a zero-progress AST build returns partial, use the minimum byte budget in `AST_BUDGET_NO_PROGRESS` with its opaque resume handle. Do not restart it with `--all` or discard its selected cone.
- If a context/query result has `nextCursor`, continue with `--cursor` rather than widening the scope. A policy, revision, cone, or relevant-byte change intentionally invalidates it.
- If submission says an AST receipt is stale, restore the expected selected bytes or republish the generation after reviewing the new gate result; a manual `wm ast gate` does not bypass lifecycle enforcement.
- If a Copilot or VS Code action is unavailable, use the displayed CLI fallback; do not guess a command from the label.

## Related topics

Continue with `sflow explain agents-and-routing`, `sflow explain model-independence`, `sflow explain knowledge-and-remote-assets`.
