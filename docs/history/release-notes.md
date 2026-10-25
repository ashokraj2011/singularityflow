# Delivered release notes

Consolidated delivery and qualification records. Each entry retains its original feature scope, measurements, validation and limitations; these records do not establish a new release certificate or change current product defaults.

Use the [documentation map](../DOCUMENTATION-MAP.md) for current guides and the [pending-work roadmap](../PENDING-WORK-ROADMAP.md) for outstanding work.

## Contents

- [Singularity Flow 0.8.0 — Phase Inputs and Remote Agent Markdown](#singularity-flow-080--phase-inputs-and-remote-agent-markdown)
- [Initiative orchestration delivery](#initiative-orchestration-delivery)
- [Epic-to-Story Planning and Lifecycle Lineage](#epic-to-story-planning-and-lifecycle-lineage)
- [Epic Branch Lineage, Merge Sequence, and Story Pull Requests](#epic-branch-lineage-merge-sequence-and-story-pull-requests)
- [Epic Lifecycle Wizard](#epic-lifecycle-wizard)
- [Singularity Flow 0.9.0 — Epic-to-Stories Business Experience](#singularity-flow-090--epic-to-stories-business-experience)

## Singularity Flow 0.8.0 — Phase Inputs and Remote Agent Markdown

> Current behavior document. The 0.8 label identifies the feature's origin; only current state
> schemas are accepted, no migration command is shipped, and the guidance below is maintained for
> the current product.

This delivery combines deterministic next-action guidance, the one-script local installer, opt-in approved-artifact dataflow, and trust-pinned public Markdown dependencies for Copilot agents. Package, marketplace, desktop, and plugin versions remain `0.8.0`; `install.sh` deliberately uninstalls and reinstalls the same version so local and Copilot caches receive this build.

### phase inputs — Shipped in this delivery

#### phase inputs — Workflow guidance and installation

- `/sflow-about` and `sflow-about` identify Singularity Flow as the product under the Singularity brand and document `/sflow-<action>` as the only public Copilot command namespace.
- Start mirrors durable YAML-derived source/workflow choices through Copilot's interactive selection UI; phase agents activate automatically.
- Submission and approval display every generated phase document with content or binary path, stable ID, size, and hash; `singularity-flow phase show` provides the same review view on demand.
- `/sflow-nextsteps` and `singularity-flow nextsteps` return valid `NOW`, `THEN`, and `ALTERNATIVE` actions before initialization, throughout lifecycle/recovery, and after completion.
- `/sflow-next`, `sflow-next`, and `singularity-flow next` execute one valid lifecycle action at a time while preserving explicit approval and atomic decision publication.
- `install.sh` performs fast-forward pull, selectable npm/Artifactory registry use, locked dependency install, desktop build, tests/checks, package creation, global CLI replacement, and forced Copilot plugin replacement.
- Registry credentials remain in `.npmrc`; credential-bearing URLs are rejected.

#### phase inputs — Approved phase-input dataflow

- `inputsMode: off | record | enforce`, with missing mode equal to `off`.
- Validated shorthand/object declarations, profile ordering and membership, override replacement, optional inputs, and explicit byte budgets.
- Immutable normalized input paths and mode in each new work-item resolution.
- Approved-hash verification, marker-delimited injection, per-generation audit JSON, managed artifact provenance, publish-time recollection, and mode-aware governance.
- `/sflow-inputs` and `singularity-flow inputs [PHASE] [--dry-run]`.
- Starter `record` chains for feature, bugfix, and chore through conformance.

#### phase inputs — Remote agent Markdown delivery

- Standard repository agents and bundled plugin agents through `"agents": "agents/"`.
- Exact Markdown dependency tables for remote skills, artifact templates, and generated artifacts. Prose links are inert.
- Public HTTPS, UTF-8/non-empty validation, bounded redirects/timeouts, a 1 MiB default, and a 10 MiB ceiling.
- Interactive trust-on-first-use and deliberate updates in `singularity/agents.lock.yml`.
- Hash-verified atomic cache under `.git/singularity-flow/`, with sync preserving the active work item and agent.
- Phase/agent-scoped prompt dependencies, explicit `agent:<agent>/<template>` precedence, immutable work-item template copies, and per-generation context records.
- Allowlisted URL variables and phase-contained generated targets, snapshot reuse, local-edit conflict protection, and explicit refresh/replace.
- CLI list/lock/sync/status/refresh commands, nextsteps diagnostics, governance checks, and Electron agent/lock visibility.
- Bundled `sflow-workflow` agent with empty tables. No live remote URL ships in `0.8.0`.

#### phase inputs — Earlier 0.8.0 capabilities included in the release arc

- Workflow performance report and searchable shared help, merged in PR #5.
- Rule-selected repository world-model prompt injection, merged in PR #7.
- Repository world models remain generated and stored in the repository. Remote agent Markdown is an additive prompt/template/output source, never a world-model replacement.
- World-model generation is isolated, manifest-validated, source-hashed, atomically installed, and committed/published. `wm compose` is now the single audited phase path; `wm inject` remains an alias.
- Grounding policy is configurable as `off`, `warn`, or `enforce`. The starter profile uses `warn`; `enforce` verifies any World-Model bytes and exact prompt snapshots before use. Missing or unreachable intelligence, plus stale intelligence under staleness `fail`, records an unavailable receipt and does not block lifecycle work. Staleness `warn` or `ignore` may consume a verified stale snapshot, while missing legacy configuration remains off.

#### phase inputs — Configurable lifecycle sequence gates

- Eight named guards can be configured independently as `hard` or `soft`, globally or per work type.
- Missing configuration remains hard for backward compatibility; each resolved policy is pinned into the work item.
- Soft violations show actionable state and require an exact interactive `continue`; non-interactive use stops safely.
- Confirmed exceptions are attributed to identity and governed agent and disclosed in state, artifacts, reports, Electron, and governance warnings.
- Integrity and state-transfer controls remain hard in the starter profile, while recoverable phase-status and document-timing mistakes default to soft.

### phase inputs — Starter configuration

```yaml
inputsMode: record

workTypes:
  feature:
    phases: [intake, requirements, design, implementation-spec, implementation, verification, conformance]
    phaseOverrides:
      design:
        inputs: [requirements]
      implementation-spec:
        inputs: [design, requirements]

phases:
  design:
    inputs:
      - requirements
      - phase: intake
        optional: true
        maxBytes: 16384
```

Agent Markdown accepts only these table locations:

```markdown
## Remote skills

| ID | URL | Phases | Optional | Max bytes |

## Remote artifact templates

| ID | URL | Phases | Optional | Max bytes |

## Remote generated artifacts

| ID | URL template | Phase | Target | Optional | Max bytes |
```

### phase inputs — Prompt composition

Generation now composes:

```text
+ phase skill contract
+ phase-default governed Agent Markdown
+ required repository world-model views
+ exact task guide when requested
+ rule-selected repository world-model files
+ active-agent remote skill Markdown
+ evidence when applicable
```

Approved phase-input artifacts continue to be injected into the managed artifact
template by `prepare`; their independent audit record remains unchanged.

Verification and conformance additionally load the repository evidence ledger.

### phase inputs — Compatibility matrix

| Repository or work-item state | 0.8.0 behavior |
|---|---|
| Workflow YAML without `inputsMode` | Resolves to `off`; declarations validate but runtime is unchanged |
| Existing schema-v2 work item without input fields | Resolves immutably to `off`; no state rewrite required |
| Legacy JSON configuration/state | Existing loader/migration path remains supported |
| Agent without dependency headings | Local-only; no lock and no network access required |
| Repository without agents | Bundled local-only agent remains available; normal skills/workflows are unchanged |
| Local artifact templates | Existing precedence and behavior remain unchanged |
| Remote template URL changes | Cannot change active work; the selected content is copied and pinned at work-item creation |
| Rejected/regenerated downstream phase | Historical records remain; a new generation receives new input and agent records |

### phase inputs — Upgrade and installation

From a clean clone:

```bash
./install.sh
```

For a company registry:

```bash
./install.sh --registry https://artifacts.company.com/artifactory/api/npm/npm-virtual/
```

The script's forced uninstall/reinstall is required because the public version remains `0.8.0`. Start a new Copilot session after installation. Existing repositories do not opt into input behavior until workflow YAML is changed; new repositories initialized by this build use `record`.

### phase inputs — Verification completed

- Full Node test suite, including parser, trust, cache, routing, template/output, session, desktop, installer, phase-input, lifecycle, and resume tests.
- Deterministic source/plugin/schema checks.
- Electron renderer production build.
- Shell syntax, mocked installer, package dry run, and fresh-clone installation/plugin smoke test are part of final release verification.

### phase inputs — Security and operating limits

- This release supports no authentication, cookies, or bearer tokens for remote Markdown.
- Only public HTTPS Markdown is accepted. Redirects must remain HTTPS.
- First trust and updates require human confirmation; sync never mutates the lock.
- Remote skills are not slash commands and cannot escape active phase/agent routing.
- Generated outputs cannot escape the current phase artifact directory or imply submission/approval.
- Workflow, lock, Agent Markdown, template, prompt, and skill paths are protected during generation.

### phase inputs — Known gaps and next work

- Rejection preserves historical records and invalidates lifecycle approvals, but explicit invalidation markers inside older input/agent context records are deferred.
- Portfolio reporting across every work item (`report --all`) is not implemented.
- Release verification runs through the local test, check, packaging, and Artifactory commands.
- DNS resolution is delegated to the Node HTTPS stack; literal local/private hosts are rejected, while enterprise egress policy should remain the authoritative network control.

## Initiative orchestration delivery

> Current behavior document. The original delivery name is retained for stable links; the
> Initiative, workspace, Story, and repository guidance below describes the current product.

This delivery adds an opt-in portfolio layer above Singularity Flow’s existing story workflows.

### initiative orchestration — Shipped

- Editable `singularity/portfolio.yml` schema and starter configuration.
- `initiative-lite` and `enterprise-delivery` profiles.
- Initiative outputs, inputs, checklists, gates, assurance tiers, freshness, and exact-hash approvals.
- Append-only content-addressed evidence, approval, and invalidation records.
- Dependency-cone invalidation and versioned interface contracts.
- Story DAG validation, dry-run materialization, safe branch seeding, retry journals, and Jira/Git modes.
- Cross-repository milestone synchronization.
- Reports for duration, evidence, self-approval, models, tokens, and cost.
- GitHub Copilot `/sflow-initiative-*` skills with selection receipts.
- Governed Copilot phase prompts combining phase-default Agent Markdown, repository world model, remote dependencies, and approved initiative inputs with committed hash records.
- Flow Studio initiative dashboard and portfolio designer.

### initiative orchestration — Compatibility

- Existing story workflows and `singularity/work-items` are unchanged.
- Repositories without `singularity/portfolio.yml` perform no initiative work or extra network access.
- Governed agents remain execution behavior. Initiative approval authority is a separate local Git email registry.
- Package, desktop, marketplace, and plugin versions remain `0.8.0`.

### initiative orchestration — Security and assurance

Initiative authorization is labeled `configured-local`. It is not cryptographic identity because local Git name/email can be changed. Every decision records actor, governed agent, channel, exact subject hash, and self-approval status.

External evidence is an observed snapshot, not a competing source of truth. Git branch state remains canonical.

### initiative orchestration — Known boundaries

- No separate web service or automatic application update is introduced.
- Approvals and lifecycle transitions are never automatically replayed after concurrent changes.
- Jira Align and other enterprise systems require an adapter or are stored as linked/uploaded evidence.
- Model, token, and cost history cannot be reconstructed for Copilot sessions that did not expose telemetry.

## Epic-to-Story Planning and Lifecycle Lineage

> Current behavior document. The original release title is retained for stable links; commands,
> surfaces, lineage rules, and safety guidance below are maintained against the current product.

This 0.8.0 delivery adds an opt-in Epic experience above the existing Story and
initiative engines without changing existing work items.

### epic story lineage — Shipped

- Default four-phase `epic-planning` profile with editable intake,
  requirements, Story-plan, Jira-plan, and materialization templates.
- Secure source adapter contract for Jira attachments, Artifactory,
  SharePoint, S3/AWS SSO, and public HTTPS references.
- SharePoint delegated OAuth 2.0 PKCE sign-in through the system browser, with
  OS-encrypted access/refresh tokens and automatic renewal in Electron main.
- Hash-pinned local source cache and source-aware governed Copilot prompts.
- `REQ-nnn`/`AC-nnn` source traceability and Story allocation validation.
- Story plan schema version 2 with immutable temporary plan IDs, Jira numeric
  issue IDs, returned Jira keys, aliases, canonical Work IDs, and repository
  policies.
- Explicit canonical/child branch registration, fast-forward-only direct
  promotion, and PR/either completion policies.
- Hash-bound review packets and isolated cross-repository Product Owner review.
- Optional exact-SHA GitHub repository-check and PR evidence through the authenticated `gh` CLI.
- Timestamped Jira drift observations with explicit adopt or restore-plan
  choices.
- Focused CLI commands, seven Copilot skills, and an Epic desktop workspace for
  Sources, Requirements, Planning, Stories, Review, and Configuration.

### epic story lineage — Compatibility

- Existing Story workflows and schema-v1 initiative breakdowns are unchanged.
- Repositories without an active Epic profile do not use source adapters or
  perform new Epic network access.
- Existing canonical Work-ID branches remain valid.
- Package, plugin, marketplace, and desktop versions remain `0.8.0`.

### epic story lineage — Security and trust

- Source and Jira credentials never enter Git or Copilot prompt records.
- Electron stores Artifactory tokens and SharePoint OAuth access/refresh
  tokens through OS-backed `safeStorage`; S3 uses the AWS default credential
  chain.
- Git identity remains `configured-local`; Jira and GitHub identities are
  displayed independently.
- No lifecycle operation force-pushes or automatically overwrites Jira from Git
  (or Git from Jira).

## Epic Branch Lineage, Merge Sequence, and Story Pull Requests

> Current behavior document. The original release title is retained for stable links; commands,
> surfaces, merge rules, and safety guidance below are maintained against the current product.

This `0.9.0` delivery closes the single-repository Epic case: Story branches now
descend from the Epic branch, merge in dependency order, and land the Epic
through one final pull request.

### epic branch lineage — Shipped

- **Epic-parented Story branches.** A Story in the Epic's own repository is cut
  from `origin/<EPIC-ID>` instead of the default branch. The seed records
  `story.parentBranch` and `story.baseCommit`, and `singularity-flow start`
  follows `parentBranch` so a fresh clone forks from the same commit. Stories in
  other repositories are unchanged, and an Epic branch is never created in a
  repository that does not already have one.
- **Dependency-ordered merge sequence.** `singularity-flow epic merge-plan`
  topologically sorts the `dependsOn` graph already committed in `breakdown.yml`
  and reports each Story as `merged`, `ready`, `blocked` (naming its blockers),
  or `in-progress`, plus the next Story to merge and whether the Epic may land.
  It observes Git and mutates nothing.
- **Story pull requests.** `singularity-flow pr` builds the pull request from
  committed governed state only — identity, lineage, acceptance criteria,
  approved artifacts with approval-time hashes, required checks, and merge
  position. Preview is the default; `--create` requires typing the exact Work ID,
  refuses a Story whose dependencies have not merged, reports an existing pull
  request rather than opening a duplicate, honours `branchCompletionPolicy`, and
  prints the body when the GitHub CLI is unavailable.
- **Grounded impact map.** Publishing the planning phase validates the repository
  map against committed state: every named repository must exist in
  `portfolio.repositories`; when a World-Model manifest is available, every referenced view must
  exist in it. A missing model records degraded evidence and does not block the phase. An invalid
  view reference against an available manifest is carried by the `impact-grounded` checklist item,
  blocking under `grounding: enforce` and warning otherwise.
- **Repository-scoped world model (current behavior).** Epic Intake accepts Jira identity
  and pinned source material without requiring repository grounding. After Story intake,
  Flow resolves the repository source snapshot and scope and reads or publishes the operational
  World-Model projection through the configured state-branch authority and materialization policy;
  Story lifecycle files are not part of the application-source identity. If intelligence remains
  unavailable, phase authoring continues with a zero-World-Model receipt. The newer WMP immutable
  exact-history lookup is an additive pending optimization, not a prerequisite for this behavior.
- **Initiative template self-healing.** Starting an initiative and preparing a
  phase install any packaged template the repository lacks — into the templates
  root the portfolio declares — and commit what they installed. A profile that
  references templates which are neither present nor packaged now reports every
  one of them in a single error instead of failing on the first.

### epic branch lineage — Fixed

- Story seeds in a single-repository Epic cited approved artifacts by path and
  hash that did not exist on the Story branch, because the branch was cut from
  the default branch. The approved specification was neither readable nor
  verifiable from the Story.
- Repositories initialized before the `initiatives/` template subtree shipped
  could not start an initiative: directory-level template installation skips a
  templates directory that already exists, so later package additions never
  reached them, and the self-heal ran only during desktop portfolio bootstrap.
- Self-healed templates were left unstaged, so the next command failed on an
  unclean working tree.
- `git commit` and `git push` progress was written to standard output ahead of
  CLI JSON, so the desktop reported invalid data.

### epic branch lineage — Compatibility

- Multi-repository initiatives are unchanged: Story branches outside the Epic's
  own repository still base on that repository's `defaultBranch`.
- Existing seeds without `parentBranch` fall back to the configured default base
  branch; an explicit `--base` still wins.
- The immutable resolution is preserved. A restored template is compared against
  the hash recorded at creation, so an altered template still fails.
- Package, plugin, marketplace, and desktop versions remain `0.9.0`.

### epic branch lineage — Security and trust

- Opening a pull request is an outward action: preview is the default and
  creation requires explicit confirmation of the exact Work ID.
- Pull-request bodies are assembled only from committed state; no content is
  generated or inferred.
- Self-healing installs only templates packaged with Singularity Flow, never
  overwrites an existing file, and commits what it installs.

## Epic Lifecycle Wizard

> Current behavior document. The original delivery name is retained for stable links; the workflow,
> VS Code surfaces, and command guidance below are maintained against the current product.

This `0.8.0` delivery turns the existing Git-native Epic capabilities into one
guided desktop journey without introducing a second workflow state model.

### epic wizard — General flow

```text
Jira Epic
→ pinned source intake
→ approved REQ/AC requirements
→ reviewed generated User Stories
→ approved high-level solution specification
→ selected artifacts + Stories published to Jira
→ canonical repository Story delivery
→ exact-SHA Product Owner review
→ committed Epic completion
```

### epic wizard — Shipped

- A seven-step Electron Epic wizard with direct Jira Epic selection.
- A generated-Story review board showing repository ownership, requirements,
  acceptance criteria, dependencies, and blocking status before publication.
- A distinct, configurable `epic-spec` phase and high-level specification
  template for repository boundaries, interfaces, security, observability,
  test expectations, and final comparison instructions.
- Explicit Jira artifact selection. The reviewed write plan pins each file,
  target, byte count, MIME type, and SHA-256 before upload.
- Retry-safe Jira attachments with hash-stamped filenames and append-only
  receipts.
- A final Product Owner gate that requires complete canonical blocking Stories,
  approved conformance, a submitted review packet, and passing exact-SHA
  evidence.
- A content-addressed completion record and
  `artifacts/delivery/spec-to-code-completion.md`, committed and pushed.

### epic wizard — Compatibility

- Existing active Epics keep their immutable four-phase resolution and remain
  usable; the wizard hides the new phase when it is absent.
- New `epic-planning` Epics use the five-phase profile.
- Existing Story workflows and version-1 breakdowns are unchanged.
- Jira attachments are opt-in per reviewed write plan and require
  `attach-artifact` in the pinned Jira write policy.
- Package, plugin, marketplace, and desktop versions remain `0.8.0`.

## Singularity Flow 0.9.0 — Epic-to-Stories Business Experience

> Current behavior document. The version in the title identifies the feature's origin; navigation,
> commands, and lifecycle behavior below describe the current product.

### epic ui 0.9 — Outcome

Version 0.9.0 makes Epic planning the primary business journey while preserving
the complete configurable Story and initiative engines.

The new Business experience has three navigation destinations:

- Epics
- Reviews
- Help

The selected Epic stays on one five-stage page:

```text
Sources → Requirements → Planning → Stories → Complete
```

Planning visually combines Story decomposition and the high-level
specification. They remain separate hash-pinned governance phases underneath.

### epic ui 0.9 — Jira and local identity

Users can start by selecting an existing Jira Epic or by describing the work
without Jira. Local mode reserves the next Epic identity by committing and
pushing a dedicated reservation branch, preventing two planners from silently
claiming the same ID. Defaults are:

```yaml
identity:
  local:
    epicPrefix: SF-E
    storyPrefix: SF-S
    pad: 3
    scopeStoriesByEpic: true
```

`STORY-nnn` remains the immutable planning identity. Jira Stories use the key
returned by Jira. Local Stories use scoped IDs such as `SF-S-001-001`. The
authority selected at Epic creation is immutable.

Repository entries can independently route Stories to Jira projects/boards and
carry App IDs plus arbitrary scalar metadata. The entire repository registry is
snapshotted into the Epic resolution.

### epic ui 0.9 — Governed desktop actions

Each Epic stage displays its generated documents before any decision. Desktop
publish and approval actions call the same engine used by the CLI, bind the
decision to exact hashes, commit the result, and push it. Self-approval requires
an explicit acknowledgement and remains visibly non-independent.

The Epics home shows current stage, stage status, progress, elapsed waiting
time, identity authority, and approved-stage count from committed state. It is
not a separate database.

### epic ui 0.9 — Compatibility

- Existing Story workflows are unchanged.
- Existing initiative profiles remain available in Engineer mode.
- Existing Jira-backed Epics keep Jira authority.
- Existing repositories without initiative activity perform no new network
  access.
- Onboarding profiles without an experience value are migrated in memory:
  Product Owner, Business Analyst, Product Designer, and Delivery Manager use
  Business mode; other roles use Engineer mode.
- The visible repository control directory remains `singularity/`.

### epic ui 0.9 — Upgrade

Build and reinstall the package so the CLI, desktop, plugin, and marketplace
metadata all use 0.9.0:

```bash
git pull
npm ci
npm test
npm pack
npm install --global ./singularity-flow-0.9.0.tgz
singularity-flow plugin install
```
