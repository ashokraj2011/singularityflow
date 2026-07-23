# Singularity Flow Lite 0.8.0

Singularity Flow Lite is a Git-native SDLC workflow for GitHub Copilot. A repository-owned YAML file defines work types, phase sequences, artifact templates, personas, world-model views, approvals, and publication policy. Generated artifacts and lifecycle decisions are committed to a work-item branch and pushed after every operation, so another terminal can safely resume from Git. Its Copilot skills use the collision-safe `sflow-` prefix.

**Singularity Flow** is the product under the **Singularity** brand. Public
Copilot commands are always `/sflow-<action>`—for example `/sflow-start` and
`/sflow-about`—with no `singularity` slash-command prefix. Run `sflow-about` for
the installed version and a concise capability summary. The full
`singularity-flow <action>` executable remains a compatible CLI for existing
scripts and documentation.

The package contains:

- A deterministic Node.js CLI (`singularity-flow` or `sflow`).
- A secure Electron desktop studio for visual workflow, persona, approval, template, progress, and document management.
- A GitHub Copilot plugin with collision-safe skills and a bundled workflow agent.
- A canonical searchable help manual shared by the CLI, Copilot, and Electron desktop.
- Editable feature, bugfix, chore, and Figma-export-to-mobile profiles.
- Editable persona prompts and artifact templates.
- World-model grounding, approval auditing, token accounting, and a final spec-to-code conformance gate.
- A no-argument cockpit, repository doctor, guided run mode, portable review bundles, safe recovery, workflow simulation, assignments, and read-only watching.
- Recursive design-package inventory and a local image gallery for exported Figma/mobile evidence.
- Opt-in initiative orchestration for Epics and repository-specific stories, with separate Epic/Story Work/Jira IDs, typed evidence, interface contracts, cross-repository progress, and enterprise phase gates.
- A phase-aware Planning Studio that runs the local GitHub Copilot CLI through ACP in native Plan mode, surfaces Copilot questions as answerable forms, keeps collapsible IDE-style logs, and promotes only a human-reviewed artifact into Git.

## Requirements

- Node.js 20 or newer.
- Git with a configured identity.
- A Git remote when `git.publish: required` is configured.
- GitHub CLI authentication is recommended so lifecycle events can record the authenticated GitHub login as well as Git identity.

## Install and initialize

```bash
npm install --global ./singularity-flow-0.8.0.tgz
cd your-repository
singularity-flow init
git add singularity
git commit -m "Initialize Singularity Flow"
git push
```

Initialization installs:

```text
singularity/
├── workflow.yml
├── personas/
│   ├── architect.md
│   ├── developer.md
│   ├── product-owner.md
│   └── qa.md
├── prompts/
│   ├── worldmodel-builder.md
│   └── copilot-planning.md
└── templates/
    ├── common/
    ├── feature/
    ├── bugfix/
    └── chore/
```

These files are ordinary reviewed repository files and remain fully editable.

Initialization also installs `singularity/portfolio.yml`. It is inert until an initiative is started and provides editable `initiative-lite` and `enterprise-delivery` profiles. See [INITIATIVE-ORCHESTRATION.md](INITIATIVE-ORCHESTRATION.md) for the complete multi-repository guide.

The Electron **Planning Studio** is a governed client for GitHub Copilot CLI's native Plan mode. It combines the selected phase contract, persona, repository world model, approved inputs, remote skills, requirements, and current draft into a hashed local context pack. Copilot can ask structured questions directly in the app and explore alternatives through persistent follow-up turns; only the artifact explicitly reviewed in the right-hand panel can be promoted, committed, and pushed. See [PLANNING-STUDIO.md](PLANNING-STUDIO.md).

The leading dot was intentionally removed: repository-owned configuration, prompts, templates, artifacts, and workflow state now live in the visible `singularity/` folder. Private machine/session data remains under `.git/singularity-flow/` and `~/.singularity-flow/`.

Start an initiative from GitHub Copilot:

```text
/sflow-initiative-start INIT-2026-001
/sflow-initiative-phase
/sflow-initiative-next
/sflow-initiative-status
```

Starting uses `main` (or the configured default branch) only as the source baseline for the new initiative branch. It does not merge anything into `main`; completed code still follows the repository's normal pull-request and merge process.

## Built-in help

The canonical product manual is [HELP.md](HELP.md). For an end-to-end diagram and operational walkthrough, use [HOW-TO.md](HOW-TO.md). Load all help or one focused topic from the terminal:

```bash
singularity-flow help
singularity-flow help quick-start
singularity-flow help jira-intake
singularity-flow help troubleshooting
singularity-flow help --json
```

In Copilot, `/sflow-help` loads the manual for general questions; `/sflow-help WORK-123` loads the selected work item's immutable workflow guide. Singularity Flow Desktop includes the same manual in a searchable **Help** page, bundled for offline use.

Copilot start, resume, approval, rejection, and persona flows use its
interactive question facility to show the YAML-configured choices. Choose a
label instead of typing a persona or workflow ID. During start or approval, a shell
without persistent stdin uses a short-lived one-time selection receipt, so the
contributor or reviewer can stay in Copilot. If interactive questions themselves are disabled, Singularity
Flow stops rather than choosing a default.

Use `/sflow-nextsteps [WORK-ID]` whenever you need a compact ordered plan. Its CLI equivalent, `singularity-flow nextsteps [WORK-ID]`, works before initialization, without an active work item, during pending publication recovery, throughout every phase, and after completion. It is read-only and marks actions as `NOW`, `THEN`, or `ALTERNATIVE`.

### One-command local update and installation

From a clean clone, update the tracked branch, create the distribution tarball, install it globally, remove any previous Copilot plugin identities, and install one current marketplace plugin:

```bash
./install.sh
```

`npm run install:local` is an alias for the same script.

Before dependency installation, the script asks you to choose:

1. The registry currently returned by `npm config get registry`.
2. The public npm registry.
3. A custom company registry or Artifactory URL.

For a non-interactive or repeatable company setup, pass the registry explicitly:

```bash
./install.sh \
  --registry "https://artifacts.company.com/artifactory/api/npm/npm-virtual/"
```

You can provide the same override through an environment variable:

```bash
SINGULARITY_FLOW_NPM_REGISTRY="https://artifacts.company.com/artifactory/api/npm/npm-virtual/" \
  ./install.sh
```

For an interactive installation, run `./install.sh`, choose **Custom company registry / Artifactory**, and enter the registry URL. The `--registry` option takes precedence over the environment variable and interactive selection.

Keep Artifactory authentication in your user or company `.npmrc`; do not put credentials in the registry URL. For example:

```ini
registry=https://artifacts.company.com/artifactory/api/npm/npm-virtual/
always-auth=true
//artifacts.company.com/artifactory/api/npm/npm-virtual/:_authToken=${NPM_TOKEN}
```

Export the token only in the shell or CI secret store, then run the installer:

```bash
export NPM_TOKEN="your-artifactory-token"
./install.sh \
  --registry "https://artifacts.company.com/artifactory/api/npm/npm-virtual/"
```

The selected registry is used for both `npm ci` and the global tarball installation. The script rejects credentials embedded in a URL, never prints tokens, and does not modify npm configuration.

The installer also enables GitHub Copilot CLI's metadata-only OpenTelemetry file exporter for future model, token, timing, and cost collection. Its shell wrapper explicitly selects the file exporter, selects the active repository dynamically, and keeps raw traces at `<git-dir>/singularity-flow/copilot-otel.jsonl`; prompt and response content capture remains disabled. Phase publication commits only a sanitized summary to `singularity/work-items/<WORK-ID>/telemetry/<phase>-gen<N>.json`, so model/token/cost state follows the work-item branch to another laptop without committing raw traces or conversation identifiers. Existing Copilot OTel environment configuration is preserved. Use `./install.sh --no-copilot-telemetry` or `SINGULARITY_FLOW_COPILOT_TELEMETRY=off ./install.sh` when an organization manages telemetry separately.

The single self-contained `install.sh` performs:

```text
git pull --ff-only
choose configured, public, or custom npm registry
npm ci --registry=<selected-registry>
npm run desktop:build
npm test
npm run check
npm pack --json
npm uninstall --global singularity-flow
npm install --global <generated-tarball> --registry=<selected-registry>
singularity-flow plugin install
configure metadata-only Copilot OpenTelemetry
```

The script refuses a checkout with uncommitted changes and never resets, rebases, or force-pushes. It keeps the generated `singularity-flow-<version>.tgz` in the repository root for distribution and prints the installed CLI and Copilot plugin versions. Fully exit any running Copilot CLI process, then open a new terminal and start Copilot from the repository after installation; environment variables cannot be injected into a process that was already running.

## Configuration

`singularity/workflow.yml` is the definition for new work items. It contains:

- `workTypes`: profile-specific phase sequences, template overrides, and optional `phaseOverrides` for checks, world-model, comparison, artifact, input, and approval policy.
- `inputsMode`: backward-compatible `off`, audit-oriented `record`, or blocking `enforce` phase dataflow.
- `phases`: default templates, approved upstream inputs, artifact paths, write scope, world-model views, quality commands, and approval rules.
- `personas`: prompt files, suggested phases, additional world-model views, and phases each persona may approve.
- `documents`: allowed upload phases, maximum file size, and text-preview limit; work types may override this policy.
- `git`: remote name and whether publication is required.
- `governance`: protected paths and traceability rules.

Template resolution is deterministic: a work-type override wins, then the phase default is used, and initialization fails when neither exists. At `start`, the resolved profile, configuration hash, and template hashes are stored in `workflow.json`. The selected work type is then immutable for that work item.

The bundled profiles are:

| Work type | Phase sequence |
|---|---|
| Feature | intake → requirements → design → implementation-spec → implementation → verification → conformance |
| Bugfix | intake → reproduction → fix-design → fix-spec → implementation → verification → conformance |
| Chore | intake → implementation → verification → conformance |
| Figma export to mobile app | design-intake → design-inventory → component-mapping → mobile-spec → implementation → visual-verification → conformance |

Persona-to-phase mappings are suggestions, not restrictions. Any contributor may select any configured persona. Approval authority comes from the selected persona's `mayApprove` list.

For `figma-mobile`, committed PNG exports are the canonical approval baseline. The desktop Documents page provides verified thumbnails, full-size previews, and local PDF viewing; the visual-verification Review page compares the pinned design, registered implementation screenshot, and registered diff image side by side, through an overlay slider, or as a diff highlight. Live Figma links open externally over HTTPS and are explicitly labeled as mutable convenience context.

## Start and resume

```bash
singularity-flow start ENG-142 --title "Add invoice export" --fetch
singularity-flow resume ENG-142 --fetch
```

With no source flags, `start` first asks whether intake comes from a Jira story or a manual description and documents. Manual mode asks for the title, audience, problem, outcome, acceptance criteria, and supporting file paths or HTTPS URLs. After source intake is complete, `start` always asks for a workflow template (`feature`, `bugfix`, `chore`, `figma-mobile`, or another configured work type) and persona. `resume` always prompts for a persona. There are deliberately no public `--type` or `--persona` bypass flags. A raw non-interactive invocation without proof of the contributor's choices fails clearly; `/sflow-start` can supply that proof with a one-time selection receipt when its shell has no persistent stdin bridge. The active persona is stored locally in `.git/singularity-flow/session.json`; opening a session does not create a repository commit. The optional Copilot session hook binds that declaration to the current Copilot session ID and can prevent mutating tools until the contributor selects a persona.

The receipt flow is local and auditable: `singularity-flow choices begin start <WORK-ID> --json` returns the live YAML-derived intake, workflow, and persona options; Copilot presents those options through `ask_user`; and each exact answer is recorded with `singularity-flow choices answer`. Approval uses `singularity-flow choices begin approve <WORK-ID> --fetch --json` and additionally binds the receipt to the submitted phase, generation, and artifact hashes while requiring the reviewer to type the exact phase ID. The completed token is passed as `--selection-receipt`, expires after 15 minutes, is bound to the work ID, repository HEAD, and Copilot session when available, and is deleted after one use. It never creates a commit by itself, never contains Jira credentials, and cannot be substituted for another work item or changed repository state.

New repositories enable the session hook policy in `singularity/workflow.yml`:

```yaml
session:
  workItemSelection: prompt # off | reuse | prompt
  personaSelection: prompt # off | reuse | prompt
  promptOnNewSession: true
  promptOnResume: false
  requireBeforeTools: true
```

`/sflow-session` applies this policy in order. For each new Copilot session it asks for the exact work ID or Jira ID, lists committed work-item branches from the configured Git remote, fetches the remote, checks out a missing local tracking branch, and fast-forwards to the exact remote head. Only then does it ask for or reuse a persona. A resumed conversation with the same Copilot session ID retains the binding. `/sflow-persona` changes the persona at any time.

The attach path is deliberately conservative: dirty, missing, malformed, ahead, or diverged branches stop with a clear message. It never creates a work branch, merges, rebases, resets, stashes, force-checks out, or discards local work. Run it directly with `singularity-flow session candidates` and `singularity-flow session attach ENG-142`. Copilot must already be open inside a clone of the application repository so `singularity/workflow.yml` and its configured remote are known; when the selected branch is absent locally, Git materializes it from the remote rather than cloning a duplicate repository.

Reviewers can open `/sflow-inbox` or run `singularity-flow inbox` to fetch a repository-wide queue of committed phases awaiting approval. The inbox reads workflow state directly from remote work-item branches without checking each one out. It shows the work/Jira ID, title, phase, generation, approval threshold, waiting time, allowed reviewer personas, artifact path, self-approval warning, and exact remote commit. Selecting an item uses the same conservative session-attachment flow before displaying the complete phase documents; it never approves automatically.

No ID or persona is inferred, and the declared persona never replaces the authenticated Git identity in audit records. Existing repositories without `session` behave exactly as before (`off`). The resolved policy is pinned into each work item so a base-branch YAML edit cannot weaken an active item silently.

On another terminal, `resume --fetch` fetches and fast-forwards the work-item branch. Committed branch state is the handoff protocol; the local session file is not part of it.

### Jira intake

Jira access uses Atlassian REST directly. Provide an Atlassian account email and API token; never use or commit an Atlassian password:

```bash
export JIRA_BASE_URL="https://company.atlassian.net"
export JIRA_EMAIL="person@company.com"
export JIRA_API_TOKEN="<api-token-from-atlassian>"
```

The CLI does not load `.env` files. Set these values for the current shell, inject them from a password manager, or configure them as protected CI secrets. Discover optional custom-field IDs and then export the fields used by your Jira site:

```bash
singularity-flow jira fields --query "Acceptance Criteria"
singularity-flow jira fields --query "Story Points"
singularity-flow jira fields --query "Sprint"

export SINGULARITY_FLOW_JIRA_ACCEPTANCE_FIELD="customfield_12345"
export SINGULARITY_FLOW_JIRA_STORY_POINTS_FIELD="customfield_10016"
export SINGULARITY_FLOW_JIRA_SPRINT_FIELD="customfield_10020"
# Optional comma-separated additional fields:
export SINGULARITY_FLOW_JIRA_EXTRA_FIELDS="customfield_10001,customfield_10002"
```

Verify access before starting work:

```bash
singularity-flow jira pull ENG-142
singularity-flow jira list --project ENG
singularity-flow start ENG-142 --jira
```

### Manual story intake without Jira

Manual intake has the same durable state-transfer behavior as Jira intake. Put the supplied story details in YAML or JSON; Markdown and plain-text briefs are also accepted. The structured format can capture the user, problem, desired outcome, scope, stakeholders, urgency, constraints, dependencies, acceptance criteria, risks, notes, and supporting documents. See `examples/manual-story.yml` for a complete example.

```bash
singularity-flow start WORK-123 \
  --story-file ./manual-story.yml \
  --document ./additional-context.pdf \
  --document-url https://www.figma.com/design/example
```

`--document` and `--document-url` may be repeated. A story file may also declare a `documents` list containing paths, URLs, optional labels, and kinds. Relative document paths are resolved from the story file's directory. The command creates and pushes `source.json`, a readable `USER-STORY.md`, the workflow state, and each copied document with a stable `DOC-nnn` identifier. It still asks the contributor to choose the workflow template and persona interactively.

For a short manual request without a story file:

```bash
singularity-flow start WORK-123 \
  --title "Add invoice export" \
  --description "Finance needs a repeatable export of filtered invoices." \
  --acceptance-criteria "An authorized user can export the filtered invoice set."
```

### Help for the selected workflow template

At any time after starting work, show the chosen template, its complete phase sequence, artifacts, suggested and approval-capable personas, approval thresholds, current position, and exact next action:

```bash
singularity-flow guide WORK-123
```

From Copilot, use:

```text
/sflow-help WORK-123
```

The guide is read-only. Depending on state, it recommends `/sflow-phase`, `/sflow-submit`, `/sflow-approve` or `/sflow-reject`, and `/sflow-progress` after completion.

For the complete sequence of immediate, subsequent, and alternative actions instead of the full template explanation:

```bash
singularity-flow nextsteps WORK-123
```

From Copilot, use `/sflow-nextsteps WORK-123`.

To execute one next action instead of only displaying the plan, use either form:

```text
/sflow-next
```

```bash
sflow-next --task "Current objective"
# equivalent: singularity-flow next --task "Current objective"
```

The command performs exactly one lifecycle action. It recovers a pending push, prepares and grounds the active generation, submits an already-published generation, opens the normal interactive approval flow, or runs the terminal gate after completion. Copilot completes and publishes a prepared artifact; it does not silently chain that publication into submission. Approval still requires persona selection and phase confirmation, and every approval gets its own commit and push.

## Progress

```bash
singularity-flow progress ENG-142
singularity-flow progress ENG-142 --json
```

Progress is based on approved phases, so it is deterministic: `approved phases / total phases`. The command shows an arrow-based workflow map in addition to the progress bar and detailed phase table. Completed (`✓`), current (`▶`), awaiting-approval (`◆`), and pending (`○`) phases are visually distinct. It also shows percentage, current position, generation count, approvals received/required, uploaded-document count, and token usage. It never guesses partial completion inside an unapproved phase.

## Workflow performance reports

Generate a report from the committed work-item history without changing lifecycle state:

```bash
singularity-flow report ENG-142
singularity-flow report ENG-142 --format json
singularity-flow report ENG-142 --format html --out workflow-report.html
```

From Copilot, use `/sflow-report ENG-142`. Markdown is the default; JSON exposes the derived data and HTML includes script-free inline charts. Reports show total and per-phase wall-clock duration, approval waiting, active time, generation/rework count, rejections, self-approvals, provider/model identity, exact token usage with per-model totals, quality-check duration, and the largest approval-latency bottleneck. An open approval request accumulates waiting time through report generation.

Durations include nights and weekends; they are not business-hours or developer-productivity estimates. Reports are derived views, not authoritative workflow state. Standard output is read-only, while `--out` writes only the requested report file and does not commit or push it automatically.

## Supporting documents and designs

Supporting inputs are managed under `singularity/work-items/<WORK-ID>/inputs/` and cataloged in `documents.json`. Uploads are allowed only in the initial phases configured by `documents.allowedPhases`; the starter profile allows intake, requirements/design/specification, and the corresponding bugfix phases.

GitHub Copilot CLI can also load the bundled experimental Documents extension. Enable experimental features with `/experimental on`, start a fresh session, then use `/documents` for a searchable canvas or `/documents view PHASE-DESIGN` to open a specific artifact. The extension embeds a fresh document snapshot directly in the canvas; run `/documents` again after generating or uploading files to reload it. Hosts without canvas rendering automatically fall back to terminal output. Copilot currently does not allow plugins to add another built-in home tab, so the canvas is the supported tab-like document browser.

```bash
# Local documents, screenshots, PDFs, .fig files, or other binary files
singularity-flow documents upload ./brief.pdf ./checkout-wireframe.png

# Complete exported design package; imported recursively in stable path order
singularity-flow documents upload ./figma-export --kind figma-export

# External Figma or design link (recorded, not downloaded)
singularity-flow documents upload \
  --url https://www.figma.com/design/example \
  --label "Checkout design"

singularity-flow documents list
singularity-flow documents view DOC-001
```

Every uploaded file receives a stable `DOC-nnn` identifier, content hash, MIME type, original filename, phase, actor, and persona. Directory imports preserve the package name and relative source path for every discovered regular file; symbolic links are rejected. Upload creates and pushes one atomic work-item commit. Text formats can be displayed directly; images, PDFs, `.fig`, and other binary files return an absolute path for the appropriate viewer. The catalog also lists generated phase artifacts, status, source context, and Jira user-story documents.

## Generate a phase

Copilot users normally invoke the appropriate skill, for example:

```text
/sflow-phase
```

The skill combines its phase contract with the selected persona and verified repository grounding. The equivalent deterministic CLI sequence is:

```bash
singularity-flow wm compose --phase intake --task "Capture the requested change"
# If instructed, first build with the same phase and exact task text.
singularity-flow prepare intake
# Fill the generated template.
singularity-flow phase publish intake
singularity-flow submit
```

`phase publish` validates phase write scope and the required artifact, adds managed metadata, updates state, commits `[WORK-ID][phase:<id>][generated:<n>]`, and pushes the work-item branch. After publication succeeds, it displays every published document with its path, hash, and text content so the generated result can be reviewed immediately. Source-code formats such as Java, JavaScript, TypeScript, Python, Go, and shell scripts are rendered as text. Because Copilot can collapse Shell output, the bundled lifecycle skills reload the phase as JSON and reproduce each exact text artifact between visible `BEGIN`/`END` markers in the assistant response. Submission and every later decision are separate atomic commit-and-push operations.

Artifacts live under:

```text
singularity/work-items/<WORK-ID>/artifacts/<phase>/
singularity/work-items/<WORK-ID>/inputs/DOC-nnn/<filename>
```

Managed metadata records the work type, phase, generation, actor, persona, source/config/template hashes, token usage, commit information, and approval history. Do not edit `workflow.json`, `STATUS.md`, approval records, or the managed metadata block manually.

Lifecycle commands normally follow `prepare/edit → publish → submit → approve/reject`. Named sequence gates in `singularity/workflow.yml` are independently configurable as `hard` or `soft`, globally and per work type. Hard gates exit with code `2` before mutation. Soft gates show the same state, reason, and exact next command, then require a human to type `continue`; non-interactive use stops safely. Confirmed exceptions are attributed to the authenticated identity and selected persona, recorded in workflow history and artifact metadata, and exposed in status, reports, and governance warnings. Missing gate configuration defaults to hard, and the resolved policy is immutable for each work item. See `singularity-flow help sequencing` for all gate IDs and an example.

## Approved phase inputs

Starter repositories use `inputsMode: record` and connect the full feature, bugfix, chore, and Figma-mobile phase chains. Existing repositories with no key resolve to `off`. Each work item pins its mode and normalized input declarations at creation.

```yaml
inputsMode: enforce
phases:
  design:
    inputs:
      - requirements
      - phase: intake
        optional: true
        maxBytes: 16384
```

Use `singularity-flow inputs design --dry-run` to inspect provenance without writing, or `/sflow-inputs` in Copilot. Normal preparation writes a managed artifact block and `context/inputs-design-gen<n>.json`; publication recollects inputs and the gate verifies approved hashes and rendered-block freshness.

## Token usage

With installer-managed Copilot telemetry, `prepare` opens a generation capture window. Copilot exports a chat span only after the response finishes, so `phase publish` may initially mark the current generation `pending`. The next `submit` or `/sflow-next` invocation automatically reconciles the completed span in its own commit and push before submission. The sanitized record is committed under the work item:

```text
singularity/work-items/<WORK-ID>/telemetry/<phase>-gen<N>.json
```

For another provider, or when supplying a trusted external usage record, pass it explicitly:

```bash
singularity-flow phase publish implementation --usage-json usage.json
```

The JSON may contain provider, model, input, output, cached-input, total tokens, start/end timestamps, provider cost, and collection source. When Copilot does not expose exact values, the committed record is explicitly marked `unavailable`; the CLI never estimates silently. Reports identify the provider/model for every phase and aggregate token records by model as well as phase and persona.

Workflow reports prefer the exact provider cost emitted by Copilot telemetry. When provider cost is absent, they can calculate cost from exact usage and optional prices configured by exact model name. Rates are currency units per million tokens; no fallback prices are bundled because provider pricing changes over time:

```yaml
tokens:
  mode: exact-or-unavailable
  pricing:
    provider-model-name:
      input: 3
      output: 15
      cachedInput: 0.3
```

Missing usage or pricing remains visibly `unavailable`; a mixture of priced and unpriced records is labeled `partial`.

Diagnose the local exporter or explicitly retry a delayed generation with:

```bash
singularity-flow telemetry status
singularity-flow telemetry reconcile implementation
```

`telemetry status` shows whether this Copilot process inherited the file exporter, the repository trace path and byte count, completed chat spans, and pending generations. Reconciliation never commits raw traces—only the sanitized phase record.

## Approval and rejection

From a terminal:

```bash
singularity-flow approve ENG-142 --fetch
singularity-flow reject ENG-142 --fetch --to requirements --reason "Failure behavior is missing"
```

Approval prompts for a persona, shows artifact hashes, checks, token usage, prior approvals, and any self-approval warning, then requires the phase name as confirmation. When Copilot lacks persistent shell stdin, `/sflow-approve` collects both explicit answers with a one-time approval receipt and runs the same approval itself; it never uses `--yes`. Multi-approval thresholds require distinct authenticated identities.

Every individual approval is an atomic lifecycle decision: it updates the decision ledger and workflow state, creates its own `[WORK-ID][phase:<id>][approve] <persona>` commit, and pushes that commit before reporting success. This also applies to approvals that do not yet satisfy a multi-approval threshold. A failed push retains the local commit and blocks further decisions until `singularity-flow sync` succeeds.

Anyone may switch to an approval-capable persona and decide a phase. If the authenticated generator and approver are the same person, the approval is allowed but is visibly recorded as `selfApproval: true`; it is never represented as independent review.

GitHub PR comments are also supported by installing `examples/singularity-flow-approve.yml`:

```text
/approve design as architect
/reject design as architect --to requirements --reason "Missing failure behavior"
```

Rejection may target only a phase allowed by that phase's YAML policy. It reopens the target and invalidates target/downstream approvals while preserving old artifacts in Git history.

## Publication and recovery

With `git.publish: required`, generation and lifecycle commands are successful only after a normal fast-forward push. If a push fails, the local commit is retained and an untracked work-item publication sidecar is marked pending. Further transitions are blocked until:

```bash
singularity-flow sync
```

`sync` retries the existing commit without rewriting history. Optimistic branch-head checks prevent concurrent decisions from silently overwriting each other.

For isolated tests only, `git.publish: off` disables remote publication. Do not use it when Git is the state-transfer channel.

## Implementation specification and conformance

Feature work includes an `implementation-spec` after design. It uses stable `SPEC-nnn` identifiers mapped to approved `AC-n` acceptance criteria and captures APIs, schemas, affected files/components, security, observability, migration, and test expectations. Bugfixes use the smaller `fix-spec` template with the same identifiers.

The final `conformance` artifact compares every approved `AC-n` and `SPEC-nnn` with exact source/test file-and-line evidence. Each item must be classified as `matched`, `partial`, `missing`, `deviated`, or `unplanned`. Approved deviations and all self-approvals are disclosed. The report stores a source/test tree hash; later code changes make it stale and fail the gate.

```bash
singularity-flow gate --terminal
```

The deterministic gate checks profile/template snapshots, remote publication, artifact integrity, personas and identities, approval thresholds, rejection cascades, AC/SPEC traceability, conformance freshness, and protected workflow/template/persona/skill/GitHub-workflow files.

## World model

```bash
singularity-flow wm build --phase design --task "Design invoice export"
singularity-flow wm compose --phase design --task "Design invoice export" --dry-run
singularity-flow wm compose --phase design --task "Design invoice export"
singularity-flow wm check
```

`wm build` runs the model generator in a detached analysis worktree, rejects writes outside its isolated output, validates every manifest entry, records a repository source-tree hash, commits the model, and follows the configured Git publication policy. Work-item lifecycle commits and the model commit itself do not make the model stale; repository source/configuration changes do.

`wm compose` is the single phase entry point. It combines the selected persona prompt, mandatory phase and persona views, the exact task guide, applicable evidence, rule-selected files, and active-agent remote skills. `wm inject` remains an alias for compatibility. Rules can match persona, phase, immutable work type, committed or pending changed paths, and source labels.

Non-dry-run composition writes both a JSON provenance record and the exact rendered prompt under the work item's `context/` directory. With `worldModel.grounding: enforce` (the starter setting), generation cannot publish until the committed model, source hash, required views, file hashes, manifest, persona, and prompt snapshot verify. The selected mode is pinned when the work item starts. Use `warn` for an adoption period or `off` for legacy behavior; missing configuration and older in-flight work items mean `off`.

## Remote agent Markdown

Agents under `.github/agents`, `.claude/agents`, or the plugin's `agents/` directory may declare public HTTPS Markdown skills, templates, and generated outputs in exact dependency tables. No URLs ship in the bundled agent, and local-only repositories perform no network access.

```bash
singularity-flow agents list
singularity-flow agents lock architecture
singularity-flow agents sync architecture
singularity-flow agents status architecture
```

First trust and updates require exact agent-name confirmation. `singularity/agents.lock.yml` pins hashes; sync only verifies and caches them. Remote skills are scoped prompt context, remote templates require an explicit `agent:<agent>/<resource>` workflow reference, and generated Markdown stays under the current phase artifact directory. See [HELP.md](HELP.md#remote-agent-markdown) for table schemas and refresh behavior.

## Useful commands

| Command | Purpose |
|---|---|
| `sflow-about` | Describe the Singularity Flow product, version, capabilities, and `sflow-` namespace. |
| `singularity-flow init` | Install editable YAML, templates, persona prompts, and world-model builder prompt. |
| `singularity-flow start <ID> [--jira \| --story-file FILE]` | Import Jira or manual story details, attach optional documents, choose workflow template/persona, and create/push the work branch. |
| `singularity-flow choices begin\|answer\|status` | Bridge explicit Copilot start and approval choices through a short-lived one-time receipt when persistent terminal stdin is unavailable. |
| `singularity-flow resume <ID> --fetch` | Fast-forward the branch and select a persona for this terminal. |
| `sflow-persona [ID]` | Select or change the persona for the current local work-item session. |
| `singularity-flow session candidates` | Fetch and list committed remote work-item branches available for session attachment. |
| `singularity-flow session attach <ID>` | Safely fast-forward to the exact remote work-item head before persona selection. |
| `singularity-flow session status` | Inspect work-item and persona binding readiness for the current Copilot session. |
| `sflow-inbox [--offline] [--json]` | Fetch and list committed remote phases awaiting approval; equivalent to `singularity-flow inbox`. |
| `singularity-flow status [ID]` | Show phase, persona, artifacts, approvals, usage, and warnings. |
| `singularity-flow progress [ID]` | Show deterministic completion percentage and phase/approval progress. |
| `singularity-flow report [ID] [--format md\|html\|json]` | Derive wall-clock timing, approval latency, rework, token, cost, and bottleneck metrics. |
| `singularity-flow guide [ID]` | Explain the selected workflow template and show the exact next valid skill and CLI command. |
| `singularity-flow nextsteps [ID]` | Show ordered `NOW`, `THEN`, and `ALTERNATIVE` actions without changing state. |
| `sflow-next [--task TEXT]` | Execute exactly one next valid action; alias for `singularity-flow next`. |
| `singularity-flow inputs [PHASE] [--dry-run]` | Inspect or render approved phase-input dataflow. |
| `singularity-flow agents list\|lock\|sync\|status\|refresh-output` | Trust, materialize, inspect, and refresh remote agent Markdown. |
| `singularity-flow documents list [ID]` | List uploaded inputs and generated workflow documents. |
| `singularity-flow documents view <ID>` | Display text content or return the path/URL for a binary/external document. |
| `singularity-flow documents upload <FILE-OR-DIRECTORY...>` | Recursively copy, hash, catalog, commit, and push supporting evidence during configured initial phases. |
| `singularity-flow jira pull <ID>` | Read and normalize one Jira issue using configured REST credentials. |
| `singularity-flow jira list` | List assigned Jira work with optional project, type, limit, and JQL filters. |
| `singularity-flow jira fields --query <TEXT>` | Discover Jira custom-field IDs for acceptance criteria, points, sprint, or other metadata. |
| `singularity-flow prepare [PHASE]` | Materialize the resolved artifact template. |
| `singularity-flow phase show [PHASE]` | Display every generated phase document, its review metadata, and text content. |
| `singularity-flow phase publish [PHASE]` | Validate, annotate, commit, and push one generation. |
| `singularity-flow submit` | Run checks and publish an approval request. |
| `singularity-flow approve [ID] --fetch` | Select an approval persona and record/push the decision. |
| `singularity-flow reject [ID] --fetch --to PHASE --reason TEXT` | Reject, reopen, invalidate downstream state, commit, and push. |
| `singularity-flow sync` | Retry a pending publication without rewriting the commit. |
| `singularity-flow gate --terminal` | Run the final deterministic/remote-state gate. |
| `singularity-flow migrate-config` | Convert legacy JSON configuration and work-item state without rewriting history. |

## Migration

From a repository using the former `.singularity/` folder, `.sdlc/` folder, or legacy JSON configuration:

```bash
singularity-flow migrate-config
git add -A
git commit -m "Move Singularity Flow files to visible folder"
git push
```

Singularity Desktop offers the same guarded migration when an older repository is opened. It reopens the migrated repository and treats the complete rename as publishable configuration, so the desktop **Commit & push** action can finish it. The legacy JSON is preserved for audit and existing Git history is not rewritten. See [MIGRATION.md](MIGRATION.md).

## Development and packaging

```bash
npm install
npm test
npm run check
npm pack --dry-run
```

### Desktop studio

The Electron app is a visual control plane over the same CLI and Git-backed state. It does not maintain a second workflow database or write runtime state directly.

```bash
npm run desktop:dev
npm run desktop:build
npm run desktop:package:current
```

Create a universal macOS DMG with `npm run desktop:package:mac` on a Mac, or a Windows x64 NSIS installer with `npm run desktop:package:win` on Windows. Local packages are visibly marked unsigned when signing credentials are unavailable. Official signed/notarized installers are built by the tag-driven GitHub workflow and published first as a supervised draft release; verified output can also be uploaded to an internal Artifactory repository. See [DISTRIBUTION.md](DISTRIBUTION.md) for signing secrets, commands, installation, and release verification. `npm run desktop:dist` remains a compatibility alias for current-host packaging.

Open an initialized repository from the app. The studio keeps up to ten recently opened repository locations in its local application data, ordered by last use, so the welcome screen and repository switcher can reopen them with one click; missing locations are identified and entries can be removed without changing the repository. Older hidden control folders are detected and can be migrated to visible `singularity/` after an explicit confirmation. The studio provides a progress dashboard, a remote pending-approval inbox, and a visual designer for workflow profiles, stage sequencing, artifact contracts, approvals, phase inputs, and Markdown artifact templates. The initiative page explicitly shows that default branches are starting baselines and that Singularity never merges initiative or story branches automatically. For the selected work item, **Overview** shows total wall-clock, active, and approval-wait time with a per-phase timing breakdown. It also includes a committed AI cost dashboard with exact/partial/unavailable coverage, total tokens and cost, phase allocation, provider/model attribution, provider-versus-configured pricing sources, and actionable capture diagnostics; it identifies a missing or outdated Copilot telemetry setup and never estimates unavailable values. The inbox fetches committed submissions and safely attaches the selected work-item branch before opening its review bundle. Users can create, copy, reorder, configure, or safely remove workflow elements while inspecting the exact YAML draft. The app also provides supporting-document upload/view, searchable offline help, persona selection, and configuration commit/push. Renderer sandboxing and a narrow preload API keep filesystem and Git access outside the UI process.

The daily workspace uses the **Singularity** product identity throughout. **Artifact Studio** visualizes the complete phase sequence, generation state, approvals, governed deliverables, and shared artifact repository. **Requirements** provides a three-pane repository tree, full document preview, Git metadata, and Markdown outline. **Impact analysis** renders the current repository/initiative dependency topology and derives risk signals from committed story freshness and interface-contract integrity. These screens are projections of the same Git state; they do not create a parallel state store.

**Planning Studio** adds an intentional reasoning workspace above those deterministic controls. It exposes every profile phase for orientation, allows planning only on the active in-progress phase, and adapts the prompt to discovery, design, inception, elaboration, construction, delivery, or story-level work. It invokes the locally authenticated `copilot` executable through ACP, explicitly switches the ACP session to native Plan mode, streams conversation and structured plan updates, renders ACP clarification forms inline, and rejects permission requests. A collapsed IDE-style console retains tool, status, and diagnostic events. Story-plan output receives a dedicated Epic/Story Work ID analysis before promotion. The context manifest stays private under `.git/singularity-flow/planning/`; a promoted artifact copies its exact context and provenance into the work item or initiative before one commit/push. Promotion never submits, approves, materializes stories, or merges a branch.

Install the personal Copilot plugin with:

```bash
singularity-flow plugin install
copilot skill list
```

The installer removes both the legacy direct installation (`singularity-flow`) and any existing marketplace installation (`singularity-flow@singularity-flow`), refreshes the official `ashokraj2011/singularityflow` marketplace, and installs exactly one current marketplace copy. Running the command again is a safe replacement operation; `--force` is not required. The equivalent manual commands are:

```bash
copilot plugin marketplace add ashokraj2011/singularityflow
copilot plugin install singularity-flow@singularity-flow
```

The plugin package remains named `singularity-flow`, while every public skill has a globally unique command name:

```text
/sflow-about
/sflow-start ENG-142 --title "Add invoice export"
/sflow-persona
/sflow-phase
/sflow-progress
/sflow-nextsteps
/sflow-next
/sflow-report
/sflow-help
/sflow-documents list
/sflow-status
/sflow-submit
/sflow-approve
/sflow-reject
/sflow-resume ENG-142
```

The `sflow-` prefix prevents collisions with generic skills such as `/start`, `/status`, and `/approve` from other plugins. After upgrading from v0.6.0 or v0.6.1, run `singularity-flow plugin install`, close existing Copilot sessions, and confirm that `copilot plugin list` contains only `singularity-flow@singularity-flow` and `copilot skill list` reports the `sflow-*` skills.

See [ARCHITECTURE.md](ARCHITECTURE.md) for invariants and [VERIFICATION.md](VERIFICATION.md) for the release checklist.
