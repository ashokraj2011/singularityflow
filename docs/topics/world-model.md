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
version: 19
---
The world model provides repository-grounded views used during governed generation. In a monorepo, scope it to the capability's source and shared directories so unrelated products do not increase scan cost or invalidate evidence.

## Registered v4 builder

Set `worldModel.format: registered-v4` to use the governed v4 pipeline: exact scoped source,
closed extractors and view contracts, deterministic Evidence/Derivation/Fact catalogs, independently
validated views, exact cache reuse, and one atomic state-branch publication. Every factual unit is
bound to a registered Fact ID; model composition cannot create facts, evidence, assurance, or
provenance. The built-in views are `dev.impact`, `dev.hotspots`, `biz.rules`, and
`arch.contracts`. Use `sflow world-model plan`, `build`, `facts`, `evidence`, `validate`, and
`doctor`; see [the complete WMB v4 guide](../WORLD-MODEL-BUILDER-V4.md). Legacy v3 remains the
compatibility default and requires an explicit rebuild or migration before v4 reads will trust it.
During explicit migration, current deterministic registration runs before narrative composition.
Exact legacy claims may bind only to current registered Facts; every unresolved claim becomes a
typed `unavailable` Fact through the model-free migration producer, using only claim identity
hashes. The regenerated view and exact migration receipt publish together in one state transaction.

## Shared lifetime and regeneration

The governed world model belongs to the repository source snapshot, not to a Story. Its validated
snapshot is published on the configured state branch and reused by every Story, terminal, Copilot
session, and VS Code surface that resolves the same source scope. Story/work-item lifecycle files
are excluded from the source fingerprint, and Story context is injected separately by the governed
phase prompt.

Normal lifecycle commands inspect, reuse, and compose this shared model without a task guide. They
never turn a Story title or conversational objective into `--task`. In registered v4, `wm ensure` is
a read-only readiness check: a missing or stale required view is refused rather than built. Create or
replace v4 bytes only through an explicit `wm build`, `wm regenerate`, or `wm migrate`; exact valid
cache entries are reused without another model call.

All state-backed surfaces use the same approved authority: `ledger.remote`, then
`worldModel.remote`, then `git.remote`. Read-only status, Help, gateway, and VS Code views never
fetch. If the remote is newer, run `sflow wm refresh-authority --format registered-v4`; a
storyless multi-capability repository must retain the displayed `--capability ID`. A remote or local
authoritative state tip that removed the model cannot fall through to an older application-branch
copy.

The state branch is `worldModel.stateBranch` when that compatibility override is authored;
otherwise it is `ledger.branch` (default `state`). Canonical configuration resolves these fallbacks
before ledger defaults are applied, so an implicit `origin` cannot hide an explicit World-Model or
application remote.

Registered-view execution is version exact. Stable configuration IDs resolve to installed contract
references such as `dev.impact@4`, and omitted `worldModel.views` means the complete active installed
catalog. The `all` selector is expanded before plans, checkpoints, workers, diagnostics, or manifests
are created.

Registered v4 always uses its repository-local exact cache. Set
`SINGULARITY_FLOW_WMB_SHARED_CACHE` to an approved absolute directory, or pass `--shared-cache`, to
automatically warm and reuse validated L2 bundles across checkouts. Shared bytes still pass the full
local validator and corrupt entries never publish. Completed builds also retain a rebuildable local
Fact/Evidence query index without source bodies; losing that index does not lose governing evidence.
Freshness compares the current approved scope, policy, view contracts/selection, extractor
registry, consumer profile, and output budget as well as source bytes. `wm regenerate --stale`
therefore rebuilds the complete current configured view set instead of preserving views removed by
new policy.

With `materialization.mode: on-demand`, `confirmation: automatic`, `depth: light`, and a
deterministic v4 composer, lifecycle authoring may add a missing phase view to a valid same-source
projection without invoking a model; v4 maps light to its `quick` depth and preserves existing views
byte-for-byte. Stale, invalid, source-mismatched, or intentionally removed models still require a
reviewed action. The automatic child build is bound to the inspected state commit and manifest, so
authority movement before execution cannot widen an extension into a replacement. In advisory
grounding mode, a failed deterministic warm-up does not block normal
file-based authoring: the prompt receipt records `groundingAvailability: unavailable` with a stable
reason code. Enforced grounding remains fail-closed.

The optional registered runtime and human-confirmed inputs live only at
`world-model-inputs/runtime-observations.json` and
`world-model-inputs/human-confirmed-knowledge.json`. They must use the closed versioned,
self-hashed formats. A monorepo with explicit `worldModel.sourceRoots` must include
`world-model-inputs` to opt in; `singularity/**` stays excluded so lifecycle metadata never becomes
repository evidence or forces Story-by-Story regeneration.

## Legacy v3 materialization and model routing

The following `light`, automatic materialization, task-guide, discovery, and synthesis behavior
applies only when `worldModel.format` is absent or set to `legacy-v3`. A direct `wm ensure --task` or
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
- **Copilot:** `/sf-worldmodel` for world-model and bounded AST status, context, query, build, and evidence-replay guidance. Read operations remain bounded and model-free. A registered-v4 build uses the existing five-tool gateway: it creates an exact Plan, requires a separate host confirmation, then runs only the opaque one-time Plan handle.
- **VS Code:** open Singularity Flow **Configuration Center → World model** for grounding scope and the registered-v4 format, composer, consumer, cache, and total-token controls. Dotted registered view IDs such as `dev.impact` are accepted. Use **Build / refresh** to select an approved capability (when needed), exact installed views, and review the request, source, scope, and state-branch CAS target before a native build. Cancelling performs no mutation. If authority refresh is required, **Refresh state & retry** preserves the capability selection. The Explorer exposes separate bounded exact reads for unavailable analysis, contradictions, staleness receipts, and cache economics; those datasets never inflate the ordinary workspace snapshot. Use **Configuration → AST intelligence** for optional structural diagnostics, adapter availability, coverage, and guarded cache maintenance. The AST scope banner identifies the active workspace repository and, for multi-repository workspaces, switches the shared repository used by VS Code, Copilot, and the CLI. Both settings surfaces save the same YAML used by the CLI.

## Guided workflow

1. For a normal repository, leave `worldModel.sourceRoots` and `sharedRoots` absent to describe the whole application tree.
2. For a monorepo, set `sourceRoots` to the owned application directories and `sharedRoots` to required contracts/libraries. Capability scopes override application roots at the nearest child and inherit shared roots additively.
3. Run `sflow doctor --performance --offline`. Review scoped/total file counts and warm fingerprint time before building.
4. Run `sflow wm status`. For registered v4, materialize with an explicit `sflow wm build --views ...`; `wm ensure` only verifies readiness and `wm light` is refused. For legacy v3, use `sflow wm light`, `sflow wm build`, or `sflow wm ensure` as policy requires.
5. Re-read `sflow wm check`. New Stories and Initiatives pin the resolved capability scope, so later capability-map edits do not silently change their evidence boundary.
6. If structural predicates are configured, optionally run `sflow wm ast gate --json` for diagnostics. Its result never gates publication or submission. Reproduce any successfully retained diagnostic evidence with `sflow wm ast evidence reproduce --receipt <RECEIPT> --json` (`replay` remains a compatibility alias).
7. If publication is pending, run `sflow wm recovery list`, inspect the retained ID, then use `sflow wm recovery publish <ID> --confirm <ID>`. Registered v4 retains the complete validated projection and exact state CAS authority, so this recovery does not re-extract, recompose, or call the model. Endpoint, source-guard, or remote-head drift is refused.

## State and safety

Legacy-v3 world-model fingerprints use Git's existing index object IDs for clean paths and read visible bytes only for changed or untracked paths. Registered v4 requires a clean exact in-scope source snapshot by default; commit or stash those bytes before building. When dirty bytes are intentionally the reviewed source and approved policy permits it, `wm snapshot` explicitly anchors an immutable repository-local Candidate Snapshot and returns the only hash accepted by `wm plan/build --candidate-snapshot`. Candidate capture writes private Git objects and a private ref; ordinary fingerprinting does not write Git objects or execute configured clean filters. Sparse-checkout paths absent from disk remain represented by their index objects and are not mistaken for deletions. Semantic model generation and governed publication still mutate only through the documented `wm` commands and lifecycle checks.

AST context/query/gate reads reuse and best-effort warm content-addressed blob skeletons for exact
committed Git inputs; dirty inputs remain memory-only and cache failures never block the read.
`wm ast build` additionally writes the cone manifest and treats cache write failures as explicit
build failures. The built-in JavaScript/TypeScript facts are
lexical `text` assurance. C, C++, C#, Go, Java, Kotlin, PHP, Python, Ruby, Rust, and Swift receive
`text`-assured declaration previews from the bundled, on-demand polyglot scanner unless the
effective policy is `off` or `text-only`.
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
- If publication or synchronization is pending, follow the exact recovery command in the refusal and verify with `sflow doctor`. Registered v4 recovery replays only the retained validated projection; do not rebuild or copy its files manually.
- If all files remain in scope, save non-empty `sourceRoots`/`sharedRoots` in Configuration Center or the capability map; an empty list deliberately means the whole application tree.
- If a scoped file is absent because of sparse checkout, add its directory to the capability's sparse cone and create/repair the workspace. Do not manually copy files around Git's sparse index.
- If warm status or fingerprint time remains high, run `sflow doctor --performance --json` and retain the measurements when asking the repository platform team about FSMonitor or untracked-cache policy.
- If a zero-progress AST build returns partial, use the minimum byte budget in `AST_BUDGET_NO_PROGRESS` with its opaque resume handle. Do not restart it with `--all` or discard its selected cone.
- If a context/query result has `nextCursor`, continue with `--cursor` rather than widening the scope. A policy, revision, cone, or relevant-byte change intentionally invalidates it.
- AST receipt or replay warnings concern optional historical evidence only; they do not require republishing a generation or block submission.
- If a Copilot or VS Code action is unavailable, use the displayed CLI fallback; do not guess a command from the label.

## Related topics

Continue with `sflow explain agents-and-routing`, `sflow explain model-independence`, `sflow explain knowledge-and-remote-assets`.
