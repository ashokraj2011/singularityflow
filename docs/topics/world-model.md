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
version: 38
---
The world model provides repository-grounded views used during governed generation. In a monorepo, scope it to the capability's source and shared directories so unrelated products do not increase scan cost or invalidate evidence.

## Repository knowledge

Beside the v4 evidence layer, `wm knowledge` reads what the code does from the committed tree:
rules and limits with their exact lines, journeys from an endpoint or UI event to its effects, data
shapes, error paths to HTTP statuses, test cases and what they exercise, functions with rules no test
reaches, test titles that contradict the code, and the clauses of approved Story specifications
with the code and tests that tag them. It is deterministic and model-free, cached by
content on this machine, and added to each phase prompt as one cited slice for the phase's reader,
focused on the Story (`worldModel.knowledge.prompt: off` turns it off). `wm knowledge show business`
is the product owner's view: approved requirements, journeys, rules, messages and vocabulary. Use `wm knowledge show`,
`slice` and `eval`; see [the knowledge model guide](../KNOWLEDGE-MODEL.md).

## Registered World Model: off by default

The registered World Model is off unless a repository sets `worldModel.registered: on`. While it is
off nothing builds, reads, verifies or asks for it, a Story that pinned it continues without it,
`wm build` and the other registered commands refuse with `WMB_REGISTERED_OFF` (`wm status` answers
`off`), and every phase prompt carries the Repository brief read from the source instead
(`singularity-flow wm brief --phase PHASE`). What follows applies only where it is on.

## Registered v4 builder

`registered-v4` is the only World Model format; omitting `worldModel.format` selects it. It uses exact scoped source,
closed extractors and view contracts, deterministic Evidence/Derivation/Fact catalogs, independently
validated views, exact cache reuse, and one atomic state-branch publication. Every factual unit is
bound to a registered Fact ID; model composition cannot create facts, evidence, assurance, or
provenance. The built-in views are `dev.impact`, `dev.hotspots`, `biz.rules`, and
`arch.contracts`. Use `sflow world-model plan`, `build`, `facts`, `evidence`, `validate`, and
`doctor`; see [the complete WMB v4 guide](../WORLD-MODEL-BUILDER-V4.md).
All packaged Story and Initiative selectors and agent presets now use logical v4 IDs; the repository
catalog pins exact `@4` contracts. Native defaults use deterministic composition, cache reuse, and
strict assignments. Empty selections and workflows with World Model disabled stay that way.
File-only initialization refuses an agent upgrade that would require changing this catalog; update
the catalog in `singularity/workflow.yml` and publish it through the normal configuration review.
`biz.rules` grounds registered rules, `arch.contracts` grounds interfaces, `dev.impact` describes
structural/test impact, and `dev.hotspots` describes concentration. They do not replace test execution,
screenshots, security review, or release evidence. Legacy-v3 view names are refused, not aliased.
During explicit migration, current deterministic registration runs before narrative composition.
Exact legacy claims may bind only to current registered Facts; every unresolved claim becomes a
typed `unavailable` Fact through the model-free migration producer, using only claim identity
hashes. The regenerated view and exact migration receipt publish together in one state transaction.

Model composition applies independent budgets: each view contract bounds SFlow's logical prompt
estimate and returned output bytes, while the model runner's finite tool-free invocation ceiling
(currently 64,000 tokens) bounds provider-reported aggregate usage. Provider system/history context
is not measured by the logical prompt estimate; unknown overhead remains unknown, not zero.
Usage and enforced limits are retained in invocation diagnostics. Exceeding the aggregate ceiling
does not publish an invalid view or trigger an automatic retry. The failure card shows available
usage and limits. If every selected view permits deterministic composition, choose **World Model →
Build / refresh effective model → deterministic composer**, then review a new exact Plan. Required-
model contracts instead require configuration-authority review; validation is never relaxed.

The kernel admits mandatory Facts first and preflights a complete canonical narrative against the
output budget before invoking a provider. Optional Facts are then admitted only when both the input
packet and a complete canonical narrative fit. This witness establishes feasibility for the installed
arrangement, not optimal packing or semantic insight. The model organizes the admitted packet but
must narrate **every** admitted Fact, including optional and unavailable results. Dropping one returns
`WMB_ADMITTED_FACT_OMITTED`, eligible only for the existing bounded failed-view retry policy; neither
automatic deterministic downgrade nor invented replacement facts are allowed.

Build results report ledger/admitted/narrated counts and individual input/output-budget exclusions.
The VS Code completion summary reports these counts separately: complete admitted coverage is not
complete repository coverage. Changing these rules changes the kernel/prompt identity, so exact old
cache entries cannot masquerade as current validation. Old receipt schemas remain readable; rebuild
a stored view through a freshly reviewed Plan when its installed-build identity is no longer current.

**Legacy-v3 removed.** A configuration that sets `format: legacy-v3`, names a legacy view
(`business`, `architecture`, `development`, `testing`, `release`, `operations`, `security`), or
sets `worldModel.v4.legacyAssignments: inherit-configured` still loads: the World Model is guidance,
so those entries are dropped, a phase or agent assigned only legacy views runs without World Model
context, and `sflow doctor` names each one. `sflow wm migrate-views --dry-run` previews the rewrite
to registered views across `workflow.yml`, `portfolio.yml` and Agent Markdown (`business` →
`biz.rules`, `architecture`/`security` → `arch.contracts`, `development`/`testing` → `dev.impact`;
`release` and `operations` are removed), keeping each file's formatting; apply it with the printed
`--confirm` phrase, then publish the configuration (`sflow config publish`) before building. An old
legacy-v3 projection at the output path is not read; a registered `sflow wm build` replaces it. A
Story started under legacy-v3 keeps its records, but its phases compose with zero World Model bytes
(grounding unavailable, reason `WMB_FORMAT_RETIRED`), `wm` commands refuse for it, and its old
prompt receipts are reported as not verifiable, as a warning.
Start a new Story to use registered views. For the business reading of the code, use
`wm knowledge show business`.

`arch.calm@1` is a registered-v4 projection. Its reviewed build plan and completion result expose
required/optional policy, strict validation and profile, final status, and any durable refusal
receipt.

The exact cache/current-projection behavior in this section is the operational WMB v4 path. The
newer WMP immutable per-key history service is additive. For each newly created Story whose
accepted configuration selects `registered-v4`, Story start derives exact phase/agent Model and
View Keys, reads one already-published state-authority cut, rechecks authority, and pins that cut
before WFA captures the Story policy. It does not write history automatically. See
[Persisted World-Model views](../PERSISTED-WORLD-MODEL-VIEWS.md) for the exact-history boundary.

## Shared lifetime and regeneration

The governed world model belongs to the repository source snapshot, not to a Story. Its validated
snapshot is published on the configured state branch and reused by every Story, terminal, Copilot
session, and VS Code surface that resolves the same source scope. Story/work-item lifecycle files
are excluded from the source fingerprint, and Story context is injected separately by the governed
phase prompt.

Normal lifecycle commands inspect, reuse, and compose this shared model without a task guide. They
never turn a Story title or conversational objective into `--task`. In registered v4, `wm ensure` is
a read-only readiness check: it reports a missing or stale required view and refuses to build it.
That command refusal is not a lifecycle refusal; ordinary work records unavailable context and
continues. Create or replace v4 bytes only through an explicit `wm build`, `wm regenerate`, or
`wm migrate`; exact valid cache entries are reused without another model call.

The same fail-open availability rule applies when a new Story enrolls in immutable exact history.
An exact Model/View hit becomes an active self-hashed Story pin. A miss, or any other failure to
select a history cut, becomes a self-hashed `unavailable` exact-history pin carrying the failure
code, so Story start never fails because of World-Model history. Story start performs no model,
render, AST, cache, fetch, or publication work, and later history cannot silently repin the Story.
Existing WMB current-projection grounding remains available under its existing policy, but it does
not acquire immutable WMP authority. For an active pin,
each phase re-reads the exact bytes at the pinned commit and proves the complete closure and current
authority ancestry. State fast-forward is allowed while the cut remains reachable. Rewind,
unrelated replacement, authority drift, missing or modified bytes, and closure mismatch leave the
pinned bytes out of the prompt, with a warning and the reason in the receipt, instead of falling
back to a newer mutable projection. A pending prompt whose pin can no longer be re-proved is
recomposed, as when its documents change; the phase is not refused.

All state-backed surfaces use the same approved authority: `ledger.remote`, then
`worldModel.remote`, then `git.remote`. Read-only status, Help, gateway, and VS Code views never
fetch. If the remote is newer, run `sflow wm refresh-authority --format registered-v4`; a
storyless multi-capability repository must retain the displayed `--capability ID`. A remote or local
authoritative state tip that removed the model cannot fall through to an older application-branch
copy.

Stored-model integrity and current-source availability are separate. After the stored manifest,
catalogs, and blobs verify, status exposes `freshness.status` as `fresh`, `stale`, or `unavailable`.
An ordinary dirty or otherwise uncapturable source snapshot is `unavailable`, with `fresh: false`,
`current: null`, the original reason (commonly `WMB_SOURCE_SNAPSHOT_REQUIRED`), and no invented
staleness receipt. `wm status --json` and `wm availability --json` still exit successfully because
the inspection completed; text output says **source comparison unavailable**, never **fresh**.

Example (other authority and view fields are omitted):

```json
{
  "fresh": false,
  "freshness": {
    "status": "unavailable",
    "fresh": false,
    "built": "sha256:<published-source-digest>",
    "current": null,
    "reason": "WMB_SOURCE_SNAPSHOT_REQUIRED"
  },
  "stalenessReceipts": []
}
```

This result does not corrupt or delete the reusable model. Advisory prompt composition may use its
verified bytes only as clearly labelled historical context under the pinned staleness policy.
Grounding and architecture-intent checks do not count it as current evidence until the source is a
comparable committed revision or an explicitly captured Candidate Snapshot; they report this as a
warning and do not refuse work. Diagnostic reads do not commit source, capture a snapshot,
rebuild, refresh skills, or call a model.

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
Deterministic views retain their fixed renderer identity. A model-routed view instead binds its
durable execution digest to the exact installed provider and requested-model selector; its kernel
stamp carries that canonical request profile, the provider-observed model, and invocation ID.
Cache reuse reconstructs and verifies that same route/profile before accepting the bytes.
Freshness compares the current approved scope, policy, view contracts/selection, extractor
registry, consumer profile, and output budget as well as source bytes. `wm regenerate --stale`
therefore rebuilds the complete current configured view set instead of preserving views removed by
new policy.

Upgrading Singularity Flow does not strand a published model. Each reviewed change to the extractor
registry is recorded with its effect. A model an earlier build published stays readable when the
installed build has reviewed that build's registry. It also stays current when every change since
then was mechanical, meaning facts and views are unchanged, so no rebuild and no model call is
needed. Otherwise it is stale, as for any other identity change. A model this build cannot verify
exactly, from an unreviewed or much older build, is refused before any of its bytes are used.
Grounding continues without it, `wm doctor` reports `earlier-build` with a warning, and
`sflow world-model build` replaces it.

With `materialization.mode: on-demand`, `confirmation: automatic`, `depth: light`, and a
deterministic v4 composer, lifecycle authoring may add a missing phase view to a valid same-source
projection without invoking a model; v4 maps light to its `quick` depth and preserves existing views
byte-for-byte. Stale, invalid, source-mismatched, or intentionally removed models still require a
reviewed action. The automatic child build is bound to the inspected state commit and manifest, so
authority movement before execution cannot widen an extension into a replacement. In every
grounding mode, a failed deterministic warm-up does not block normal file-based authoring: the
prompt receipt records `groundingAvailability: unavailable` with a stable reason code and zero
World-Model bytes.

The World Model is guidance, never authority. Integrity checks—hash, provenance, source, path, or
prompt-snapshot mismatches—decide only whether World-Model bytes are used; bytes that fail them are
left out of the prompt with a warning. If the prompt budget drops the pinned World-Model section,
the receipt records it as unavailable (`WMP_GROUNDING_OMITTED_BY_BUDGET`). Phase publish, submission,
Story completion, Auto, `next`, planning, capability context, and Initiative publication report
grounding findings as warnings and never refuse because of them. `worldModel.grounding: enforce`
and `worldModel.staleness: fail` are still accepted and act as `warn`, as do a work type's
`intelligence.worldModel: required` and a capability policy's `worldModelGrounding: enforce`; use
`off` or `warn` in new configuration. `sflow doctor` warns once (`world-model-guidance`) while a
repository still configures `enforce`, `fail`, or `architectureIntent.blockRequiredUnfulfilledAt`.

The optional registered runtime and human-confirmed inputs live only at
`world-model-inputs/runtime-observations.json` and
`world-model-inputs/human-confirmed-knowledge.json`. They must use the closed versioned,
self-hashed formats. A monorepo with explicit `worldModel.sourceRoots` must include
`world-model-inputs` to opt in; `singularity/**` stays excluded so lifecycle metadata never becomes
repository evidence or forces Story-by-Story regeneration.

## Purpose and prerequisites

Use this topic when the current goal matches **world model**. Start in a governed checkout unless the command explicitly operates on installation or machine-local workspace state. Run `sflow doctor` when setup, identity, credentials, or repository health is uncertain, and use `sflow status` or `sflow home` to confirm the selected work before a mutation.

## Use it from each surface

- **Shell:** `sflow wm`. Run `singularity-flow wm --help` for the exact forms supported by this build.
- **Copilot:** `/sf-worldmodel` for world-model and bounded AST status, context, query, build, and evidence-replay guidance. Read operations remain bounded and model-free. A registered-v4 build uses the existing five-tool gateway: it creates an exact Plan, requires a separate host confirmation, then runs only the opaque one-time Plan handle.
- **VS Code:** open Singularity Flow **Configuration Center → World model** for grounding scope (grounding Off/Warn, staleness Warn/Ignore; an existing `enforce` or `fail` shows as Warn) and the registered composer, consumer, cache, and total-token controls; there is no format choice. Dotted registered view IDs such as `dev.impact` are accepted. **Build / refresh** selects an approved capability (when needed), exact installed views, and a reviewed state-branch Plan. A Story pinned to legacy-v3 is refused with `WMB_FORMAT_RETIRED`. Cancelling the review performs no mutation. If authority refresh is required, **Refresh state & retry** preserves the capability selection. With external authority, a settings Save creates a review proposal against the exact approved `sflow/config` revision and leaves the application checkout unchanged; merge it and refresh workspace configuration before building. A true local/FOS authority retains the validated local-draft path. Saving controls does not itself build or rewrite World-Model history, and an existing Story retains its pinned configuration. The Explorer exposes separate bounded exact reads for unavailable analysis, contradictions, staleness receipts, and cache economics; those datasets never inflate the ordinary workspace snapshot. Use **Configuration → AST intelligence** for optional structural diagnostics, adapter availability, coverage, and guarded cache maintenance. The AST scope banner identifies the active workspace repository and, for multi-repository workspaces, switches the shared repository used by VS Code, Copilot, and the CLI.

## Guided workflow

### Visual explorer in VS Code

Open **Configuration Center → World Model & CALM**, or run **Singularity Flow: World Model & CALM Explorer** from the Command Palette.

- **World Model** maps registered views to their configured workflow phases. Inspect fact states, exact view/ledger records, depth and shared versus overridden routing. Disabled assignments stay visible without active injection edges.
- **CALM architecture** draws only the published projection's components and directed relationships. Select a node or connection for its identity, evidence state, sources and exact content-addressed projection. Visual layer groups are layout aids, not inferred dependencies or flow order.
- Search, filter by group/state/workflow, focus a node's neighborhood, pan, zoom or **Expand map**. Keyboard selection and an accessible item list are available; Escape exits the expanded map.
- The authority commit and freshness status identify the displayed snapshot. Stale/historical state, missing projections, evidence gaps and bounded previews are explicit. Counts are recorded fact/component counts, not claims of complete acceptance coverage.

The explorer reuses the leased read-only IDE slice. Navigation and filtering never call a model, rebuild, approve, commit or push. Full catalogs, controls, ordered flows and gaps remain under the two expandable data sections; configuration and explicit reviewed builds remain below the map.

1. For a normal repository, leave `worldModel.sourceRoots` and `sharedRoots` absent to describe the whole application tree.
2. For a monorepo, set `sourceRoots` to the owned application directories and `sharedRoots` to required contracts/libraries. Capability scopes override application roots at the nearest child and inherit shared roots additively.
3. Run `sflow doctor --performance --offline`. Review scoped/total file counts and warm fingerprint time before building.
4. Run `sflow wm status`. Materialize with an explicit `sflow wm build --views ...`; `wm ensure` only verifies readiness. With the default deterministic composer the build makes zero model calls and publishes to the state branch without committing to the application or Story branch.
5. Re-read `sflow wm check`. New Stories and Initiatives pin the resolved capability scope, so later capability-map edits do not silently change their evidence boundary.
6. If structural predicates are configured, optionally run `sflow wm ast gate --json` for diagnostics. Its result never gates publication or submission. Reproduce any successfully retained diagnostic evidence with `sflow wm ast evidence reproduce --receipt <RECEIPT> --json` (`replay` remains a compatibility alias).
7. If publication is pending, run `sflow wm recovery list`, inspect the retained ID (it starts with `wmb4-`), then use `sflow wm recovery publish <ID> --confirm <ID>`. A recovery ID retained by the removed legacy-v3 builder is refused. Registered v4 retains the complete validated projection and exact state CAS authority, so this recovery does not re-extract, recompose, or call the model. Endpoint, source-guard, or remote-head drift is refused.

## State and safety

A World Model build requires a clean exact in-scope source snapshot by default; commit or stash those bytes before building. When dirty bytes are intentionally the reviewed source and approved policy permits it, `wm snapshot` explicitly anchors an immutable repository-local Candidate Snapshot and returns the only hash accepted by `wm plan/build --candidate-snapshot`. Candidate capture writes private Git objects and a private ref; ordinary fingerprinting does not write Git objects or execute configured clean filters. Sparse-checkout paths absent from disk remain represented by their index objects and are not mistaken for deletions. World Model builds and governed publication still mutate only through the documented `wm` commands and lifecycle checks.

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
- If a command refuses with `WMB_FORMAT_RETIRED`, it is a removed legacy-v3 command or option, a new phase named a legacy view, or the Story pin is legacy-v3 (start a new Story). If `doctor` warns about ignored legacy views, run `sflow wm migrate-views --dry-run`.
- If a build refuses uncommitted source, preserve the edits. Commit or stash the in-scope changes through the normal Story workflow before retrying; the shared state model cannot be built from private working-tree bytes.
- If status says **source comparison unavailable**, preserve the source edits. Commit them through the normal workflow or explicitly capture a Candidate Snapshot when policy permits, then rerun the read or reviewed build. Do not treat `current: null` as the published digest and do not create a receipt from it.
- If all files remain in scope, save non-empty `sourceRoots`/`sharedRoots` in Configuration Center or the capability map; an empty list deliberately means the whole application tree.
- If a scoped file is absent because of sparse checkout, add its directory to the capability's sparse cone and create/repair the workspace. Do not manually copy files around Git's sparse index.
- If warm status or fingerprint time remains high, run `sflow doctor --performance --json` and retain the measurements when asking the repository platform team about FSMonitor or untracked-cache policy.
- If a zero-progress AST build returns partial, use the minimum byte budget in `AST_BUDGET_NO_PROGRESS` with its opaque resume handle. Do not restart it with `--all` or discard its selected cone.
- If a context/query result has `nextCursor`, continue with `--cursor` rather than widening the scope. A policy, revision, cone, or relevant-byte change intentionally invalidates it.
- AST receipt or replay warnings concern optional historical evidence only; they do not require republishing a generation or block submission.
- If a Copilot or VS Code action is unavailable, use the displayed CLI fallback; do not guess a command from the label.

## Related topics

Continue with `sflow explain agents-and-routing`, `sflow explain model-independence`, `sflow explain knowledge-and-remote-assets`.
