# SPEC-AGH v1 — Agents home

**Product:** Singularity Flow
**Date:** 14 November 2026
**Status:** Owner decision recorded 2026-11-14 (section 1). Built in the order of section 9.
**Namespace:** AGH. Specification documents declare their own namespace in their header (see [DOCUMENTATION-MAP.md](DOCUMENTATION-MAP.md)); no other document uses AGH.
**Source baseline:** commit e0815f523
**Companions:** [Installation and upgrades](topics/installation-and-upgrades.md), [Agents and routing](topics/agents-and-routing.md), [SPEC-SFG](SPEC-SFG-v1-SF-GUARD-AGENT-PROVENANCE.md), [APM packages](topics/apm-packages.md)
**Normative language:** MUST, MUST NOT, SHOULD and MAY express requirements.

## 1. Decision

**SFlow's own step agents move out of `.github/agents/` into `singularity/agents/`, and the upgrade path moves them in existing repositories.**

The owner decided this on 2026-11-14, in two messages:

> "Move to singularity/"

> "upgrade or migration should take care of this movement in existing repos"

`.github/agents/` is where GitHub Copilot looks for a team's own custom agents. SFlow's step agents use generic names (`developer`, `architect`, `product-owner`, `qa`, and 25 more in legacy init), so a team's own agent of the same name took the place of SFlow's. After this change `.github/agents/` belongs to the team again: SFlow does not write, read or check it for a repository on the new layout, with the one APM exception of section 5.4.

The plugin's own Copilot agents (`plugin/agents/sflow-*`) are not step agents. They stay where they are.

## 2. Problem, verified

Verified on 2026-11-14 in a fixture repository that already has its own `.github/agents/developer.agent.md` and `.github/agents/security-reviewer.agent.md`, neither with `sflow-phases` or `sflow-default-for`.

Agent discovery (`src/agents.mjs` `discoverAgentsSnapshot`) reads, in this order, the repository's `.github/agents`, then `plugin/agents`, then the bundled `templates/agents`. The first file to declare an ID wins. The team's `developer` therefore shadows SFlow's `developer`, and it declares no step.

| Route | Result at the baseline |
| --- | --- |
| `singularity-flow init` | `copyMissingFiles` keeps the team's file, writes about 30 other files, then fails: "Phase 'implementation' requires exactly one default agent; found 0". The repository is left half initialized. |
| `init --smart-detect --yes` | The proposal lists `.github/agents/developer.agent.md` with `expectation: 'create'`. Activation (`src/initialization/activation.mjs` `ensureTargets`) refuses: "Smart-init target now exists … Regenerate and review the proposal". A new proposal is the same proposal: a dead end. |
| A team agent with another name (`security-reviewer.agent.md`) | Coexists. |

## 3. Baseline: who reads agent files

| Reader or writer | Where | Before this change |
| --- | --- | --- |
| Discovery | `src/agents.mjs` | `.github/agents`, then plugin, then bundled |
| The derived `agentPromptsRoot` | `src/config.mjs` `loadDefinition` | Always set to `.github/agents`; not a `workflow.yml` field (`DISCOVERED_FIELDS` in `src/workflow-catalog.mjs`, deleted by the WCA compiler) |
| Legacy init | `INITIALIZATION_MAPPINGS`, `initializeDefinition` | Copies `templates/agents` to `.github/agents`, never overwriting |
| Smart init | `SMART_INITIALIZATION_ASSETS`, `src/initialization/proposal.mjs` | Proposes four agents in `.github/agents` with `expectation: 'create'` |
| Governed roots | `src/governed-roots.mjs` | Derived from the init mappings, so `.github/agents` is always governed |
| Configuration transport | `configurationAssetPolicy` in `src/configuration-assets.mjs` | `.github/agents` is always a configuration root |
| Package refresh | `src/workspace-configuration-refresh.mjs` `packagedAssets` | Three-way merges `templates/agents` into `.github/agents` |
| Historical package bytes | `src/packaged-asset-history.mjs` | Keyed by `.github/agents/<file>` |
| A Story's pin | `src/workflow-snapshots.mjs`, `src/story-configuration-closure.mjs` | Agent bytes captured as blobs; the source path recorded; the closure copies the files at their paths |
| Readiness and sparse roots | `src/story-readiness-snapshot.mjs`, `src/clone-strategy.mjs` | Fingerprint and keep `.github/agents` |
| Writers | Workflow Studio, `agents create`, builder, markup, team import, asset import, WCA, workflow fix | Write `.github/agents/<id>.agent.md` |
| Factory reset | `src/factory-reset.mjs` | Replaces packaged agents in `.github/agents`, keeps valid custom ones there |
| Transfer bundles | `src/workflow-transfer.mjs` | Carry agents as `.github/agents/<id>.agent.md` |
| APM | `src/apm-lock.mjs`, `src/apm-project.mjs` | APM deploys a package's agents into `.github/agents`; `apm.lock.yaml` lists them |

## 4. Invariants

| ID | Invariant |
| --- | --- |
| AGH:CON-001 | The layout is a recorded fact of the approved configuration, never inferred from which directories exist. |
| AGH:CON-002 | Updating SFlow never changes how a repository behaves before a person approves its migration. |
| AGH:CON-003 | A file in `.github/agents` that is not SFlow's keeps its bytes and its place through every SFlow route. |
| AGH:CON-004 | A Story keeps the layout it was started with, to the end. |
| AGH:CON-005 | The migration adds no authority. It is approved the way any configuration refresh is approved. |

## 5. Requirements

### 5.1 Home and signal

- **[AGH:REQ-001] Home.** On the new layout, SFlow's step agents MUST live in `singularity/agents/<file>`, with the file names they have today.
- **[AGH:REQ-002] Signal.** The layout MUST be read from the top-level `agentPromptsRoot` key of the approved `singularity/workflow.yml`. No key means the legacy layout, `.github/agents`. `singularity/agents` means the new layout. Any other value MUST be refused with `AGENT_PROMPTS_ROOT_UNSUPPORTED`, naming both values that are allowed.
- **[AGH:REQ-003] Who writes the signal.** The packaged `templates/workflow.yml` MUST NOT carry the key, so the package's three-way merge never adds or removes it. Init writes it for a repository it creates (REQ-006). Only the migration writes it into an existing configuration (REQ-012).
- **[AGH:REQ-004] Discovery.** On the new layout, discovery MUST read `singularity/agents`, then the APM agents of section 5.4, then `plugin/agents`, then the bundled agents. It MUST NOT read any other file in `.github/agents`. A team's own agent therefore never shadows SFlow's.
- **[AGH:REQ-005] Legacy unchanged.** On the legacy layout, discovery, validation, every writer and every reader MUST behave as at the baseline.

### 5.2 Initialization

- **[AGH:REQ-006] Both init routes.** Legacy init (`initializeDefinition`, `INITIALIZATION_MAPPINGS`) and smart init (`SMART_INITIALIZATION_ASSETS`) MUST write SFlow's agents to `singularity/agents` and write `agentPromptsRoot: singularity/agents` into a `workflow.yml` they create. Neither writes, reads or checks a file in `.github/agents`. A team agent of any name MUST NOT make either route fail or ask for a new proposal.
- **[AGH:REQ-007] Init keeps a layout.** Init run on a repository that already has a `workflow.yml` MUST keep that file's layout. A legacy repository re-initialized keeps `.github/agents`; it moves only through the migration.

### 5.3 Governance and transport

- **[AGH:REQ-008] Transport.** `configurationAssetPolicy` MUST make `.github/agents` a configuration root only on the legacy layout. On the new layout, `singularity/agents` is configuration (it is under `singularity/`), and the bound APM agent files of section 5.4 are configuration files.
- **[AGH:REQ-009] Governed roots.** `.github/agents` MUST be governed only when the layout is legacy or not known. A path context built from a configuration on the new layout MUST treat a team's `.github/agents` as application files.
- **[AGH:REQ-010] Package history.** A historical package revision registered for `.github/agents/<file>` MUST be recognized at `singularity/agents/<file>` too, so a moved, unedited packaged agent is still known as packaged.

### 5.4 APM

APM decides where it deploys, and it deploys a package's agents into `.github/agents`; `apm.lock.yaml` lists each deployed file. The owner's default ("SFlow never reads anything in `.github/agents` on the new layout") would switch off every APM step binding on a migrated repository, and APM is the standard SFlow follows (owner, 2026-10-29). This specification therefore narrows the default:

- **[AGH:REQ-011] APM agents.** On the new layout, SFlow MUST read from `.github/agents` exactly the agent files `apm.lock.yaml` lists as deployed by APM, and MUST carry as configuration exactly those that `workflow.yml` `apm.agents` binds to a step. It MUST NOT write them. An APM agent with the same ID as an agent in `singularity/agents` is shadowed by SFlow's, as REQ-004 requires.

### 5.5 Migration through the upgrade path

The upgrade path at the baseline is the package refresh: `workspace refresh-configuration` (the shell, `/sf-refresh-configuration` in Copilot, and the installer's own refresh), its per-build review pass (`product reviews`, and the pass VS Code runs when a new build loads), and `workspace reinitialize` (the VS Code **After install** guide). Each works on an isolated clone of `sflow/config`, builds one candidate commit, and either publishes it to `sflow/config` or opens it as a `sflow/config-refresh/*` review.

- **[AGH:REQ-012] One candidate.** When the approved configuration is on the legacy layout, every refresh and reinitialize candidate MUST carry the migration: each SFlow agent moved, the layout signal set, and the package's agents merged at their new paths. The receipt's asset entries and ownership move with their files, so the three-way merge after the move compares each agent with its own history.
- **[AGH:REQ-013] What moves.** A file `.github/agents/<file>` (a `.md` file directly in the folder) is SFlow's, and moves to `singularity/agents/<file>` with identical bytes, when:
  1. its front matter carries an SFlow marker (a `metadata` key starting with `sflow-`), or
  2. its bytes are a current or registered historical packaged agent (SF Guard's stamp block aside), or
  3. its agent ID is referenced by the workflow's agent references: a value of `singularity/agent-mappings.yml`, an `agents:` list in `workflow.yml`, or an agent named by the skill attachments.
- **[AGH:REQ-014] What stays.** Every other file stays, untouched, and the preview lists it as "stays: your own agent". These stay too, each with its own reason:
  - a file `apm.lock.yaml` lists ("stays: deployed by APM");
  - a file with a packaged agent's name, no marker and other bytes ("stays: your own agent; SFlow's packaged `<name>` is installed in `singularity/agents`"). Rule 3 does not move it: this is the broken case of section 2. Whatever the package still ships under that name is installed in `singularity/agents`.
  - a file that is not an agent file, and anything in a subfolder, is not listed and not touched.
- **[AGH:REQ-015] Preview.** A dry run MUST write nothing and MUST list, for each repository, every move (from, to), every stay with its reason, and every packaged agent installed. The plan ID binds the moves, so a confirmation of an older preview is refused when the moves changed.
- **[AGH:REQ-016] No silent move.** A candidate that moves at least one file MUST be published to `sflow/config` only by a run that confirmed a preview listing it (`--confirm-plan`). Any other run opens it as a review branch, as `--review-only` does. Merging that review is the approval, by whoever may merge into `sflow/config`. Nothing else may approve it, and no new authority exists. A candidate whose `.github/agents` held nothing of SFlow's moves nothing: it only installs the package's agents in their new home, and it is published like the rest of the refresh.
- **[AGH:REQ-017] Idempotent.** A repository whose approved configuration is on the new layout MUST get no migration. A rerun while the review is open joins that review. A rerun after it is merged finds the configuration current and completes the state mirror.
- **[AGH:REQ-018] Resumable.** The migration MUST work from the configuration as found, file by file, so a configuration left half moved by hand or by an interrupted run is completed, never doubled. A source whose destination has the same bytes is removed. A destination with no source is done. A source whose destination has other bytes is a conflict: the migration is held (the layout signal is not set and nothing moves), the rest of the refresh continues, and the preview names both files with the repair: keep one of them in `sflow/config`, then preview again.
- **[AGH:REQ-019] No dead end.** Every state of the migration (legacy, previewed, review open, merged, conflict held, current) MUST have a next step that its own surface names, walked by the no-dead-end walk.

### 5.6 Running Stories

- **[AGH:REQ-020] A Story keeps its layout.** A Story's layout is the one its own pinned `workflow.yml` records. Its WFA closure, captured agent blobs and recorded sources, configuration closure, readiness snapshot and sparse roots MUST keep working for a Story started before the migration until it completes after the migration.
- **[AGH:REQ-021] New Stories.** A Story started after the migration MUST read its agents from `singularity/agents`.

### 5.7 Everything else

- **[AGH:REQ-022] Writers.** Every route that writes a new agent file (Workflow Studio, `agents create|edit`, the builder, workflow markup, team import, asset import, the WCA and SKP compilers, workflow fix) MUST write it in the layout's agents root.
- **[AGH:REQ-023] Validators.** A check that a repository agent's source is an agent file MUST accept both roots.
- **[AGH:REQ-024] Transfer.** A workflow transfer bundle MUST keep `.github/agents/<id>.agent.md` as its portable, bundle-internal agent path, so bundles from either layout and from earlier builds stay readable. Import MUST place an agent in the target repository's agents root. Export reads agents from the catalog, wherever they live.
- **[AGH:REQ-025] Factory reset.** Factory reset MUST keep the repository's layout. On the legacy layout it behaves as at the baseline. On the new layout it replaces packaged agents and keeps compatible custom agents in `singularity/agents`, and never touches `.github/agents`. A repository with no `workflow.yml` is reset to the new layout.
- **[AGH:REQ-026] Exclusions.** A fixed list that keeps `.github/agents` out of specification scanning, evidence provenance, Auto's protected globs or the smart-init source snapshot MUST keep it there: legacy repositories need it, and on the new layout it keeps SFlow from reading the team's files. Classification that follows the configuration (governed roots, code explanation, a Story's change scope) follows the layout: on the new layout a team's `.github/agents` is application files, as its `.github/workflows` and its own `.github/hooks` already are.
- **[AGH:REQ-027] Copilot picker.** No SFlow route MAY depend on a step agent appearing in Copilot's agent picker. Section 7 records what was found.

## 6. Surfaces

| Surface | How a person sees the migration |
| --- | --- |
| Copilot | `/sf-refresh-configuration` previews (`--dry-run --json`). The result's `agentsHome` names each move, each stay with its reason and each packaged agent installed; the skill shows them with the other candidate changes and asks to confirm the plan. Confirmed, the candidate is published; otherwise the review branch is named. |
| Shell | `singularity-flow workspace refresh-configuration --dry-run` prints `Agents move to singularity/agents:` with one line per move, one per stay and one per install, then the confirm route. The installer's own refresh, which confirms nothing, opens the review branch and names it. `workspace reinitialize --dry-run` prints the same lines. |
| VS Code | A new build's review pass opens the review and says so ("Nothing changes until each review is merged"). **After install → Preview safe reinitialization** lists the same lines before its plan is confirmed. |

## 7. Findings: what still assumes Copilot loads SFlow's agents

Reported before anything was changed (REQ-027). Neither is changed by this specification.

1. **SF Guard's stamping hook (SPEC-SFG D4).** SF Guard writes an agent-scoped `hooks` block into each repository agent file. Copilot runs those hooks only for an agent it loaded as a custom agent, picked in its picker or with `--agent`. After the move, Copilot no longer loads SFlow's step agents, so their stamps never fire. Nothing in a Story depends on that: a Story's agent is chosen by SFlow's skill, which always runs as `agent: agent`, and SF Guard already labels a turn it cannot attribute "agent unknown". The stamps a team writes into its own `.github/agents` keep working.
2. **The agent-start hook's same-name fallback** (`src/agent-hooks.mjs` `copilotAgentStartHook`, `resolveCopilotAgent`). When Copilot starts a custom agent as a sub-agent, SFlow maps its name to a Flow agent, first through `singularity/agent-mappings.yml`, then by the same name. After the move, a same-named Copilot agent is the team's own, so the fallback would bind the team's `developer` to SFlow's `developer` for that session's audit record and route hint. It decides no step and runs nothing. An explicit mapping stays the supported way to bind a Copilot agent to a Flow agent.

No route selects a step agent by name in Copilot: every skill is `agent: agent`, no `runSubagent` or Copilot CLI `task` call names a step agent (the review sub-agent runs under the author's session and names none), VS Code opens chats with a query and never a mode, and `--agent <id>` everywhere is SFlow's own agent ID, read from the catalog.

## 8. Acceptance

| ID | Given | Then |
| --- | --- | --- |
| AGH:AC-001 | A new repository with its own `developer.agent.md` and `security-reviewer.agent.md` | Legacy init and smart init (`--smart-detect --yes`) both succeed; `.github/agents` has the same two files with the same bytes; SFlow's agents are in `singularity/agents`; `workflow.yml` says `agentPromptsRoot: singularity/agents` |
| AGH:AC-002 | An SFlow repository on the legacy layout with a Story in progress, after the SFlow update | Configuration loads as before, the Story's next step composes with the same agent, and nothing is written |
| AGH:AC-003 | The same repository, previewed | The preview lists each move and each stay, writes nothing, and its plan ID changes when the moves change |
| AGH:AC-004 | The migration confirmed | `sflow/config` has the agents in `singularity/agents` with identical bytes and the signal set; the team's files are unchanged |
| AGH:AC-005 | The Story from AC-002, after AC-004 | It continues and completes; at the steps in between, its state matches the same Story on a repository that was not migrated |
| AGH:AC-006 | A new Story after AC-004 | Its agents are read from `singularity/agents` |
| AGH:AC-007 | The migration run again | Nothing changes |
| AGH:AC-008 | A configuration left half moved | The migration completes it; a conflicting pair is held and named |
| AGH:AC-009 | An existing SFlow repository whose `developer.agent.md` is the team's own, without markers | The file stays; SFlow's `developer` is installed in `singularity/agents`; configuration loads |
| AGH:AC-010 | Factory reset on either layout | The layout is kept; on the new layout `.github/agents` is untouched |
| AGH:AC-011 | A workflow exported from a migrated repository and imported into a legacy one, and the reverse | Each agent lands in the target's agents root, and the workflow loads |
| AGH:AC-012 | A migration-carrying refresh that confirmed no preview | It opens a review branch and never pushes `sflow/config` |
| AGH:AC-013 | The no-dead-end walk over the migration states | Every state names its next step |

## 9. Delivery order

1. This specification.
2. The signal, discovery, configuration loading, transport, governed roots and package history (REQ-001 to REQ-005, REQ-008 to REQ-011).
3. Both init routes (REQ-006, REQ-007).
4. The migration in the refresh and reinitialize candidates, with its preview and publication rule and its surfaces (REQ-012 to REQ-019, section 6).
5. Writers, validators, transfer, factory reset and VS Code (REQ-022 to REQ-026).
6. Running Stories across the migration (REQ-020, REQ-021), tested at points in the middle.
7. Documentation, then the full suite on both Node versions.

## 10. What building found

- **The signal had to be read where nothing else was loaded.** Discovery (`repositoryAgentsRoot` in `src/agents.mjs`) reads the `workflow.yml` of the root it discovers in, so a Story checkout reads its own pinned file and keeps its layout (REQ-020) without any reader being told.
- **A path context with no configuration keeps `.github/agents` governed.** `GOVERNED_ROOTS` is now `singularity` alone, since both init routes write only there. `applicationPathContext` adds `.github/agents` back unless a source records its `agentPromptsRoot`. A Story pinned before this change records `.github/agents` in its resolution, so it stays governed for that Story to its end.
- **First governance no longer imports a team's agents.** Bootstrapping a configuration from an application branch with no `workflow.yml` copied `.github/agents` into `sflow/config` as configuration. It now uses the agents-home policy for such a branch (`copyConfigurationAssetsFromRef`, `bootstrap: true`).
- **The editor's path authority refused the agents home.** A first save in a repository with no committed configuration compared `singularity/agents` with the reserved `.github/agents` and refused it as an escalation. Both of SFlow's roots are now trusted for `agentPromptsRoot`, the only two `workflow.yml` accepts.
- **Factory reset decides the layout before it deletes `singularity/`.** On the new layout the valid custom agents are copied into the fresh tree that replaces `singularity/`, so the one rename installs them; an invalid one is recovered from the backup the control root moved to.
- **Tests of the legacy layout build it from init.** `test/helpers/agents-layout.mjs` `toLegacyAgentsLayout` turns a fresh configuration into what an earlier build wrote, so the legacy behaviour REQ-005 keeps stays tested (factory reset, workflow transfer, the agents lock); tests of where SFlow writes agents now expect `singularity/agents`.
- **The running-Story walk stops at the Story's last step.** `test/agents-home.test.mjs` walks a spec-driven Story started on the legacy layout across the migration of its repository, beside the same Story on a repository never migrated, and compares them at each step through the planning approval; a Story started on the migrated repository afterwards pins `singularity/agents`. Finishing the first Story needs the whole code and verification walk; the comparison shows the two are the same at every point up to it.
- **The shell's confirm route was never shown.** `workspace refresh-configuration --dry-run` (and three other commands) passed a platform-quoted line to the route printer, which accepts no such line, so it printed "could not be safely displayed" where the confirm route belonged: a dead end on the shell for the migration's preview. The routes are passed as argv now and show their confirm codes.

## 11. Open items

- **A teammate on an earlier build.** A build from before this change reads a migrated repository's `.github/agents` and its own packaged agents. It ignores customized agents in `singularity/agents` and still lets a team agent shadow SFlow's, as it did before. A repository that needs every teammate on this build can say so in `singularity/product.yml` (`minimumBuild`).
- **The two findings of section 7** wait for the owner's decision.
