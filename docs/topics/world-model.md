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
version: 14
---
The world model provides repository-grounded views used during governed generation. In a monorepo, scope it to the capability's source and shared directories so unrelated products do not increase scan cost or invalidate evidence.

## Shared lifetime and regeneration

The governed world model belongs to the repository source snapshot, not to a Story. Its validated
snapshot is published on the configured state branch and reused by every Story, terminal, Copilot
session, and VS Code surface that resolves the same source scope. Story/work-item lifecycle files
are excluded from the source fingerprint, and Story context is injected separately by the governed
phase prompt.

Normal lifecycle commands inspect, reuse, and compose this shared model without a task guide. They
never turn a Story title or conversational objective into `--task`. A direct `wm ensure --task` or
`wm compose --task` is an explicit request for an ad-hoc task guide; it may extend the shared model
while preserving all valid existing artifacts. Expensive semantic generation requires an explicit
`wm build`/`wm ensure` action or an opted-in `on-demand` policy with confirmation. Automatic
materialization is restricted to the deterministic `light` builder, which consumes zero model
tokens. An unchanged ready source snapshot is reused rather than rebuilt.

If a same-source state-branch model is valid but lacks a view required by a later phase or Story,
ordinary lifecycle `wm ensure` fills the complete approved repository view catalog with the
deterministic light builder. It does not invoke the provider. Existing valid same-source tiers are
preserved byte-for-byte, and both bounded tiers of every configured view are warmed so a later
Story does not pay again merely because the last phase published a narrow selection. An explicit
`--depth`, `--model`, `--view`, `--views`, `--tier`, or `--task` remains exact and is never widened.
Changed source snapshots still cannot reuse older semantic claims; an explicit semantic build is
required when refreshed semantic analysis is desired.

Semantic generation routes existing calls by task: each parallel discovery view uses `analyze`,
and final synthesis uses `reason`, both resolved through `singularity/modelTiers.yml`. The build
fails before discovery if neither that mapping nor a legacy configured provider model exists. The
bundled mapping resolves both tasks to `auto`: every isolated ACP session explicitly asks Copilot
to select its concrete model. The model-invocation audit distinguishes the requested `auto`
selector, the ACP session selection, and provider-reported resolved model telemetry; it never
pretends the selector itself is a concrete model.
`wm build --model MODEL` and `wm ensure --model MODEL` remain explicit caller-named overrides and
are recorded as such. A concrete override fails closed if ACP or provider telemetry reports a
different model. Build
manifests, `wm status`, `doctor`, model-invocation audits, and activity logs expose the resolved
routing without storing prompts or generated content in diagnostics.

## Purpose and prerequisites

Use this topic when the current goal matches **world model**. Start in a governed checkout unless the command explicitly operates on installation or machine-local workspace state. Run `sflow doctor` when setup, identity, credentials, or repository health is uncertain, and use `sflow status` or `sflow home` to confirm the selected work before a mutation.

## Use it from each surface

- **Shell:** `sflow wm`. Run `singularity-flow wm --help` for the exact forms supported by this build.
- **Copilot:** `/sf-worldmodel` for world-model and bounded AST status, context, query, build, and evidence-replay guidance. Model-free gateway hosts may resolve bounded AST status/context/query/replay reads; cache builds remain explicit CLI operations.
- **VS Code:** open Singularity Flow **Configuration Center → World model** for grounding scope, or **Configuration → AST intelligence** for optional structural diagnostics, adapter availability, coverage, and guarded cache maintenance. The AST scope banner identifies the active workspace repository and, for multi-repository workspaces, switches the shared repository used by VS Code, Copilot, and the CLI. Both settings surfaces save the same YAML used by the CLI.

## Guided workflow

1. For a normal repository, leave `worldModel.sourceRoots` and `sharedRoots` absent to describe the whole application tree.
2. For a monorepo, set `sourceRoots` to the owned application directories and `sharedRoots` to required contracts/libraries. Capability scopes override application roots at the nearest child and inherit shared roots additively.
3. Run `sflow doctor --performance --offline`. Review scoped/total file counts and warm fingerprint time before building.
4. Run `sflow wm status`, then explicitly materialize with `sflow wm light`, `sflow wm build`, or `sflow wm ensure` as policy requires.
5. Re-read `sflow wm check`. New Stories and Initiatives pin the resolved capability scope, so later capability-map edits do not silently change their evidence boundary.
6. If structural predicates are configured, optionally run `sflow wm ast gate --json` for diagnostics. Its result never gates publication or submission. Reproduce any successfully retained diagnostic evidence with `sflow wm ast evidence reproduce --receipt <RECEIPT> --json` (`replay` remains a compatibility alias).
7. If validation succeeds but publication fails, run `sflow wm recovery list`, inspect the retained ID, then use `sflow wm recovery publish <ID> --confirm <ID>`. It republishes the retained bytes without another model call.

## State and safety

World-model fingerprints use Git's existing index object IDs for clean paths and read visible bytes only for changed or untracked paths. They do not write Git objects or execute configured clean filters. Sparse-checkout paths absent from disk remain represented by their index objects and are not mistaken for deletions. Semantic model generation and governed publication still mutate only through the documented `wm` commands and lifecycle checks.

AST context/query/gate reads reuse and best-effort warm content-addressed blob skeletons for exact
committed Git inputs; dirty inputs remain memory-only and cache failures never block the read.
`wm ast build` additionally writes the cone manifest and treats cache write failures as explicit
build failures. The built-in JavaScript/TypeScript facts are
lexical `text` assurance. Java, Python, Kotlin, and Swift receive `text`-assured declaration previews
from the bundled, on-demand polyglot scanner unless the effective policy is `off` or `text-only`.
That scanner is not a language parser and cannot satisfy required syntax gates. Optional reviewed
parser or semantic packs can provide syntax or semantic evidence when their immutable
project/toolchain binding is complete. Symbols in an explicit required diagnostic need
parser-backed syntax or semantic assurance; a text match is advisory. Context and query results are bounded by fact count and
serialized output bytes and continue through an opaque cursor bound to the exact cone. Required
predicates report a failed explicit diagnostic on partial coverage, disabled analysis, insufficient
assurance, or a failed predicate, but never block lifecycle work.

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
- AST receipt or replay warnings concern optional historical evidence only; they do not require republishing a generation or block submission.
- If a Copilot or VS Code action is unavailable, use the displayed CLI fallback; do not guess a command from the label.

## Related topics

Continue with `sflow explain agents-and-routing`, `sflow explain model-independence`, `sflow explain knowledge-and-remote-assets`.
