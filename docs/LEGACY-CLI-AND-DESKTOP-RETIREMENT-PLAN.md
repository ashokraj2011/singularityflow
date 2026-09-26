# Legacy CLI dispatcher and desktop-reference retirement plan

**Plan ID:** `LCR-v1`

**Status:** proposed; planning only, no runtime removal authorized by this document

**Code baseline reviewed:** `main@e2b7dec6ab9d8c9e792ea81bce4feed18b1799cd`

**Last reviewed:** 2026-09-26

**Decision owner:** Singularity Flow maintainers

## Decision in one paragraph

Finish retiring the *standalone* Electron product by correcting stale documentation and guarding
the distribution boundary. Do not remove VS Code's Electron-host integration. Separately, replace
the old CLI dispatcher **without removing current user functionality**: migrate active handlers into
focused command modules, migrate legacy terminal narration to structured results, retire only
reviewed compatibility spellings after their consumers have moved, and delete the dispatcher only
when no route or binary imports it. This is a code-organization and compatibility project, not a
Story, workspace, capability, schema, or Git-authority migration.

## Verified baseline and terms

| Item | Current fact | Planned disposition |
|---|---|---|
| Standalone Electron app | `apps/desktop` is absent from current `main`; the app is retained at `desktop-final-v0.9.0` and `archive/desktop-app` under [ADR 0004](adr/0004-retire-electron-desktop.md). | Keep the audit archive. Remove misleading *current-product* claims, not history. |
| Install graph | `package.json` has only `apps/vscode` as a workspace; `test/dependency-hygiene.test.mjs` rejects installed `electron` and `electron-builder`. | Extend the packaging guard; no Electron dependency removal is pending. |
| Legacy dispatcher | 78 of 131 top-level registry entries default to `src/commands/legacy.mjs`, which loads the approximately 16k-line `src/cli.mjs`. These include live `start`, `session`, `phase`, `workflow`, and `wm` operations. | Extract functionality; do **not** delete these public commands. |
| Hybrid modules | `src/commands/init.mjs`, `capability.mjs`, and `workspace.mjs` load the shim for some operations; `story.mjs` calls back into `cli.mjs`. | Count and migrate subcommands and callbacks, not just registry entries. |
| Legacy narration | `src/narration/migration-status.mjs` permits 64 commands to use the older output path. This is distinct from dispatcher routing. | Move them to the existing `CommandResult`/renderer contract and lower the ratchet to zero. |
| Compatibility spellings | Top-level aliases and subcommand aliases exist; examples include `workspace switch`, `workflow duplicate`, `wm inject`, and `jira list`. Some are in help, skills, scripts, or VS Code callers. | Classify individually; remove only after canonical routes and a versioned deprecation decision. |
| VS Code Electron host | `ELECTRON_RUN_AS_NODE`, Code Helper fallback, and host benchmark logic serve the VS Code extension, not a standalone app. | Keep and test them. |

`legacy` therefore has three meanings that must not be conflated: old *dispatch location*, old
*narration shape*, and an actually obsolete *public spelling*. A command is not obsolete merely
because the first or second label applies.

## Scope and non-negotiable invariants

In scope: command dispatch and dependency extraction, direct `cli.mjs` import removal, structured
result migration, reviewed alias retirement, stale desktop documentation, package/VSIX guards,
performance measurements, and cross-platform release proof.

Out of scope: changing Story or capability data formats, dropping historical schema readers,
removing the `legacy-v3` World Model solely because of its name, rewriting Git branches, removing
the `sflow`/`singularity-flow` primary executables, removing supported install/uninstall runners,
deleting the desktop archive tag/branch, or removing VS Code's Electron runtime handling.

Every extraction must preserve:

1. Canonical command spelling, parsed `argv`, `--json` schema, human output meaning, exit status,
   and documented shell/Copilot routes unless a separately approved contract change says otherwise.
2. Operation ID, read/mutation classification, model policy, mutation lease, subject resolution,
   refusal code, declared effects, and deterministic remediation plan.
3. Exact repository/workspace/Story selection. The current `cli-entry.mjs` cwd switch is a
   compatibility bridge; it cannot simply disappear while services still resolve relative paths
   from `process.cwd()`.
4. Git safety: no extra fetch, clone, checkout, reset, push, authority bypass, credential logging,
   or TLS/proxy override as a side effect of module extraction.
5. No new Story or workspace migration requirement. A currently installed CLI and the replacement
   must read the same persisted state during the supported upgrade path.

Do not add deprecation warnings to machine-readable stdout. Any future human-facing warning must
have a tested stderr/JSON policy and must not turn a successful governed mutation into a failure.

## Milestone M0 — closed inventory and migration harness

**Purpose:** make the removal set reviewable and prevent the old paths from growing during the
project. This milestone changes no command behavior.

- Generate a checked-in or check-generated inventory from `COMMAND_REGISTRY`: canonical name,
  aliases, module path, subcommand resolver, operation IDs, output classification, model policy,
  public binaries, VS Code callers, Copilot skills, documentation references, and tests.
- Include *hybrid* fallbacks in `commands/init.mjs`, `capability.mjs`, `workspace.mjs`, and
  `story.mjs`; registry-only counts are insufficient. Inventory direct `cli.mjs` imports in
  `bin/`, `scripts/`, and `src/`.
- Classify every public spelling as `canonical-active`, `compatibility-active`, `retirement-candidate`,
  or `internal-only`. Record an owner and replacement for each retirement candidate. Do not
  infer usage from a missing test alone.
- Capture parity fixtures for representative success, refusal, malformed input, offline Git,
  selected workspace, dirty worktree, `--help`, and `--json` paths. Compare normalized output and
  declared effects; separately assert the Git process trace where a call must remain local.
- Add a check that a *new* command cannot silently inherit the registry's legacy-module default.
  Existing entries may remain allowlisted until their batch lands; the allowlist can only shrink.
- Record cold/warm startup baselines using the pinned DX fixture before extracting handlers.

**Gate M0:** inventory count matches the registry and hybrid imports; every proposed deletion has
a named canonical replacement or a documented reason to retain it; no new legacy route is admitted.

### Initial 78-command routing inventory

These are extraction-planning groups, **not** read/mutation or model-policy classifications. The
generated M0 inventory remains authoritative if the registry changes. Each implementation change
should move only one to three handlers, not a whole row at once.

| Group | Count | Commands currently routed through the old dispatcher |
|---|---:|---|
| UX and read-facing | 17 | `help`, `show`, `choices`, `inbox`, `progress`, `report`, `receipt`, `impact`, `context`, `tokens`, `prompt-log`, `help-metrics`, `guide`, `quickstart`, `logs`, `doctor`, `review` |
| Local, install, integrations | 14 | `harness`, `factory-reset`, `reset-all`, `local-reset`, `fresh-install`, `reinstall`, `plugin`, `hook`, `bootstrap`, `secrets`, `telemetry`, `jira`, `mcp`, `knowledge` |
| Story and routing | 16 | `start`, `resume`, `return`, `agent`, `session`, `finalize`, `refresh-branch`, `next`, `assign`, `watch`, `recover`, `run`, `action`, `fault`, `fix`, `repair` |
| Phase and approval | 15 | `inputs`, `spec`, `prepare`, `phase`, `artifact`, `regression`, `submit`, `clarification`, `approve`, `reject`, `reopen`, `cancel`, `sync`, `validate`, `gate` |
| Governance and configuration | 15 | `workflow`, `agents`, `visual`, `documents`, `pr`, `stack`, `ledger`, `capabilities`, `state`, `configuration`, `constitution`, `initiative`, `epic`, `story`, `copilot` |
| World Model | 1 | `wm` |

`init`, `workspace`, and `capability` are separately registered lazy modules with legacy
subcommand fallbacks; `story` also dynamically imports `cli.mjs`. Bare root help is another
special case outside the 78 registry routes.

## Milestone M1 — complete the Electron retirement boundary

**Purpose:** remove confusion and release risk, not VS Code functionality.

- Review `RELEASE-PHASE-INPUTS.md`, `RELEASE-EPIC-WIZARD.md`, and
  `RELEASE-EPIC-STORY-LINEAGE.md`. Their stable filenames may be needed for inbound links: either
  rewrite current guidance against CLI/VS Code/Copilot or add a prominent historical-status banner
  and point to current guidance. Reconcile the statement in `docs/README.md` that `RELEASE-*`
  behavioral guidance is current.
- Keep the archive reference in ADR 0004, `DISTRIBUTION.md`, and architecture history. Do not
  rewrite Git history or delete the archival ref merely to erase a string search hit.
- Extend dependency/packaging tests to refuse `apps/desktop`, desktop build scripts, Electron app
  dependencies, or desktop binaries in current npm and VSIX artifacts. Do not fail on
  `ELECTRON_RUN_AS_NODE`, VS Code Code Helper detection, repository framework detection, or the
  actively used Copilot ACP transport.
- Confirm the npm tarball and staged VSIX are the only application artifacts in the current
  release manifest.

**Gate M1:** active product docs name CLI, VS Code, and native Copilot only; the install graph and
packaged artifacts contain no standalone Electron app; VS Code host tests still pass.

## Milestone M2 — extract low-risk and latency-sensitive reads

**Purpose:** prove the module pattern on visible commands before touching governance mutations.

- First batch: `help`, `show`, `choices`, `guide`, and `logs`. Handle `inbox` as a separate read
  because its remote discovery and refusal behavior need independent parity tests. The DX
  benchmark explicitly identifies `help`, `inbox`, `guide`, and `logs` as monolith-loading reads.
- Move each handler's service imports into its command module, not a renamed giant shared module.
  Preserve the import-light root dispatcher. Route root `--help` away from its special
  `commands/legacy.mjs` call in `src/cli-entry.mjs` only after the new help module is equivalent.
- Migrate user-facing results for these commands to the existing narration contract where
  practical; update the legacy narration list and ratchet for each completed command.
- Add startup tests that prove unrelated commands do not import the extracted module or the
  monolith. Enforce no regression against accepted DX p50/p95 budgets and record the measured
  module-load improvement separately from end-to-end latency.

**Gate M2:** listed reads no longer import the shim; CLI and VS Code snapshots, help coverage,
offline behavior, output parity, and DX budgets pass. A failure reverts only that read's routing.

## Milestone M3 — extract active lifecycle and domain commands

**Purpose:** retire the bulk of the dispatcher without changing governed work semantics.

Use small reviewable vertical slices, each with a dedicated command module and parity tests:

| Slice | Representative commands | Extra proof required |
|---|---|---|
| Story/session | `start`, `resume`, `return`, `session`, `story`, `prepare`, `phase`, `submit`, `approve`, `reject`, `reopen`, `cancel` | Same selected checkout, phase-agent binding, publication and approval gates, branch/HEAD/index preservation, remote-call trace. |
| Workflow/configuration | `workflow`, `configuration`, `constitution`, `agents`, `mcp`, `documents`, `jira` | Approved `sflow/config` authority and exact proposal/review behavior; old workflow/schema readers remain. |
| Workspace/capability | Residual legacy subcommands in the existing `workspace` and `capability` modules; `capabilities` | Exact member selection, deferred materialization, repository identity, Windows path behavior, no extra Git transport. |
| Model and governance | `wm`, `impact`, `telemetry`, `context`, `gate`, `validate`, `ledger`, `state`, `review` | Model-policy boundary, registered operation context, state and evidence outputs. |
| Remaining/admin | All remaining allowlisted commands, reset/install/bootstrap and public wrapper paths | Reset boundary, installer receipts, no unsafe process launch or package graph changes. |

Before deleting the cwd compatibility bridge, pass an explicit repository execution context through
migrated handlers and the services they call. Test a caller rooted in Story A while selecting a
Story in repository B; no command may silently operate on the prior workspace. Keep the bridge
for unmigrated code until its last consumer is gone. Preserve the monolith's remaining repository
logging and harness-completion behavior when extracting a handler; the outer operation context,
mutation lease, timing, and local journal in `cli-entry.mjs` must still wrap the whole operation.

`bin/sflow-about.mjs`, `bin/sflow-inbox.mjs`, `bin/sflow-next.mjs`, `bin/sflow-agent.mjs`,
`bin/sf-reset-all.mjs`, `bin/sf-local-reset.mjs`, and `scripts/gate.mjs` import `src/cli.mjs`
directly today; `src/commands/story.mjs` dynamically imports it for `start`, `status`, `submit`,
`finalize`, and confirmed-convergence submission callbacks. Repoint them through the
canonical entry/command modules with equal exit and failure semantics. Review the other public
binaries before deciding whether a wrapper spelling is redundant; do not silently remove a
supported install or recovery command.

**Gate for each slice:** no remaining shim import for its operations; acceptance fixtures and
security tripwires pass; its operation IDs and refusal plans are unchanged; the registry's
remaining-legacy count decreases. **Gate M3:** no registry or hybrid handler routes to
`commands/legacy.mjs`, and no production source, binary, or script imports `src/cli.mjs`.

## Milestone M4 — finish structured narration

This work can proceed alongside M2 and M3, but it has its own completion gate. For each of the
64 entries in `LEGACY_NARRATION_COMMANDS`, return the established `CommandResult` shape and render
human text only at the output boundary. Update the `NCL-001`/`NCL-009` migration status in
`docs/NARRATION-CONTRACT.md` only when corresponding tests enforce it. Preserve `why`, `next`,
effects, and exact shell/Copilot continuation routes on refusals. Reduce
`MAX_LEGACY_NARRATION_COMMANDS` after each accepted slice; never raise it to accommodate new work.

**Gate M4:** the legacy narration allowlist is empty, the ratchet is zero, JSON is parseable with
no terminal prose, and CLI/Copilot/VS Code consumers render the same underlying result.

## Milestone M5 — retire actual compatibility spellings

This is a distinct product decision, not a prerequisite for extracting a handler. Start with
reviewed aliases such as `workflow add/upgrade/duplicate`, `workspace switch`, `process archive`,
`wm inject`, AST evidence `replay`, `jira list/show`, and `auto halt`; include the top-level alias
table and older `bin/sflow-*` wrappers in the inventory. For each candidate:

1. Prove the canonical replacement works and is documented with both shell and Copilot routes.
2. Move VS Code commands, packaged skills, tests, scripts, examples, and install/recovery output
   to the canonical spelling. Confirm no current repository template emits the old spelling.
3. Decide a versioned compatibility window and clear error or redirect behavior for old calls.
   Avoid warnings that corrupt `--json` output. Keep safety/recovery aliases when their removal
   would strand an installed version or automation.
4. Remove the spelling only in the announced release, with migration notes and a regression
   asserting the replacement. A normal patch release must not unexpectedly remove public calls.

**Gate M5:** every removed spelling has a published replacement and no in-repository consumer;
unknown-command guidance points to the canonical route. Aliases explicitly retained by product
decision remain documented and are not called technical debt merely for being aliases.

## Milestone M6 — delete the shim and qualify release artifacts

- Replace the registry's fallback-to-legacy default with an explicit missing-module error. Remove
  `src/commands/legacy.mjs` and `src/cli.mjs` only after static and runtime checks find no
  imports, including root help, hybrid modules, direct binaries, and test helpers. Move
  source-sensitive tests and checks that parse `cli.mjs` text (`test/helpers/command-source.mjs`,
  `test/command-services.test.mjs`, `test/organisation.test.mjs`, `scripts/check.mjs`, and
  `scripts/vocabulary-lint.mjs`) to explicit module/registry contracts. Repoint tests that
  directly import `cli.mjs` exports, including World Model build-context and factory-reset
  tests. Update `docs/UNDER-THE-HOOD.md` and the World Model builder template before deleting
  the file.
- Delete transitional allowlists and stale comments, regenerate operation/help/skill catalogs,
  and verify the npm package does not retain the monolith because `package.json` publishes all
  `src/` files.
- Run `npm run check`, `npm run test:cli`, `npm run test:vscode`,
  `npm run vscode:typecheck`, `npm run vscode:build`, `npm run pack:dry`,
  `npm run poc:release-gate`, and the DX benchmark.
  Run the focused registry, narration, help, skills, lazy-startup, dependency-hygiene, and
  distribution tests after each slice, not only at the end.
- Once a candidate commit is clean, run `npm run test:release:aggregate` with its no-skipped-test
  contract. Do not use this clean-checkout gate as a substitute for pre-commit focused tests.
- On a clean release candidate, build the exact npm tarball and VSIX pair with the supported
  release scripts. Run the packaged-VSIX golden smoke with
  `npm run smoke:golden -- --vsix <absolute-path-to-built-vsix>`. Prove installation, CLI/VSIX
  activation, Copilot skill discovery, Story start
  through phase handoff, rollback/uninstall, and package identity on physical macOS, Linux, and
  Windows with Node 20 and 22, following `DISTRIBUTION.md`. Do not claim those cells from a
  macOS-only simulation.

**Gate M6:** registry legacy fallback count zero; narration legacy count zero; `rg` finds no
active shim/monolith import; npm/VSIX package contents are clean; tests, performance budgets,
physical six-cell release evidence, and independent review pass before promotion.

## Delivery order, risk, and rollback

| Priority | Milestone | Relative size | Reversible boundary |
|---|---|---|---|
| First | M0 inventory, then M1 desktop/documentation | Small | Revert only guard/doc changes. |
| Next | M2 read-only extraction | Medium | Restore that command's registry route without changing stored data. |
| Main work | M3 domain slices and M4 narration, interleaved | Multi-sprint | Revert one reviewed slice; do not bundle unrelated governance mutations. |
| Last | M5 alias release decision, then M6 deletion/release proof | Medium, release-sensitive | Keep prior signed npm/VSIX pair and restore it if promotion fails. |

No schema migration, Git rewrite, or automated cleanup of user repositories belongs in this plan.
The largest risk is a command appearing equivalent while routing to a different repository or
emitting a different refusal/side-effect contract. Per-slice parity and exact workspace/Story
fixtures are therefore release gates, not optional smoke tests. M5 may be deferred indefinitely
without blocking M6 if maintainers choose to keep useful aliases as thin wrappers over the new
modules.

## Completion definition

This plan is complete only when the standalone desktop is absent from active docs and packages,
every active command has a focused registered module and structured result, no runtime or public
binary loads `cli.mjs` or `commands/legacy.mjs`, approved alias decisions are implemented without
breaking supported clients, and the physical release matrix validates the exact distributable
CLI/VSIX pair. Merely deleting files or making `npm run check` pass is not completion.
