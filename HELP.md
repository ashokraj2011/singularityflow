# Singularity Flow Help

Singularity Flow is a Git-native SDLC workflow for GitHub Copilot and engineering teams. It turns requirements, designs, implementation specifications, code, tests, approvals, and conformance evidence into durable branch state that another person or terminal can resume safely.

Use this manual in three places:

- Terminal: `singularity-flow help` or `singularity-flow help <topic>`
- GitHub Copilot CLI: `/sflow-help`
- Singularity Flow Desktop: open **Help** in the sidebar

The short command reference is available with `singularity-flow --help`.

## Quick start

Install the package, initialize a repository, and commit its editable process definition:

```bash
npm install --global ./singularity-flow-0.7.1.tgz
cd your-repository
singularity-flow init
git add .singularity
git commit -m "Initialize Singularity Flow"
git push
```

Install or refresh the GitHub Copilot plugin:

```bash
singularity-flow plugin install
copilot plugin list
copilot skill list
```

Start a new Copilot session after plugin installation. Begin work from Jira or from a manual description:

```text
/sflow-start WORK-123
/sflow-help WORK-123
/sflow-phase
```

The normal phase loop is:

1. Generate or edit the current artifact.
2. Publish the generation.
3. Submit it for approval.
4. Approve it or reject it to an allowed earlier phase.
5. Continue until conformance is approved.

Use `/sflow-progress` for deterministic completion and `/sflow-report` for timing, waiting, rework, and token metrics.

## How the workflow works

The repository owns the process in `.singularity/workflow.yml`. A work type selects an ordered phase sequence. Each phase selects an artifact template, world-model views, write scope, quality checks, suggested personas, approval personas, threshold, and allowed rejection targets.

At work-item creation, Singularity Flow snapshots the selected work type, resolved phase contracts, configuration hash, and template hashes into:

```text
.singularity/work-items/<WORK-ID>/workflow.json
```

The work type cannot change after creation. This prevents later changes on the base branch from silently changing an active workflow.

Generated artifacts and lifecycle decisions are committed and pushed to the work-item branch. Git is the state-transfer protocol: another terminal fetches the branch and reconstructs the workflow from committed files. The CLI remains the only owner of runtime state, managed metadata, approvals, commits, and phase transitions.

## Starting work

Run:

```bash
singularity-flow start WORK-123
```

Start always asks for:

1. Jira story or manual intake.
2. Workflow template, such as feature, bugfix, or chore.
3. Persona for the current session.

The workflow and persona pickers are deliberately interactive. There are no public `--type` or `--persona` bypass flags. Non-interactive start fails rather than silently choosing defaults.

Useful source forms include:

```bash
# Jira
singularity-flow start ENG-142 --jira

# Structured YAML or JSON story
singularity-flow start WORK-123 --story-file ./story.yml

# Short manual story
singularity-flow start WORK-123 \
  --title "Add invoice export" \
  --description "Finance needs a repeatable filtered export." \
  --acceptance-criteria "An authorized user can export the filtered invoice set."

# Additional evidence
singularity-flow start WORK-123 \
  --story-file ./story.yml \
  --document ./brief.pdf \
  --document-url https://www.figma.com/design/example
```

Use `/sflow-start` in Copilot for conversational intake.

## Jira intake

Set Jira credentials in the shell or a protected secret manager. Do not commit credentials and do not use an Atlassian password:

```bash
export JIRA_BASE_URL="https://company.atlassian.net"
export JIRA_EMAIL="person@company.com"
export JIRA_API_TOKEN="<api-token>"
```

Discover site-specific custom fields:

```bash
singularity-flow jira fields --query "Acceptance Criteria"
singularity-flow jira fields --query "Story Points"
singularity-flow jira fields --query "Sprint"
```

Configure the discovered IDs when needed:

```bash
export SINGULARITY_FLOW_JIRA_ACCEPTANCE_FIELD=customfield_12345
export SINGULARITY_FLOW_JIRA_STORY_POINTS_FIELD=customfield_10016
export SINGULARITY_FLOW_JIRA_SPRINT_FIELD=customfield_10020
```

Verify access with `singularity-flow jira pull ENG-142` or list assigned work with `singularity-flow jira list --project ENG`.

Jira input is normalized into committed `source.json` and readable `USER-STORY.md` files. Attachments are not downloaded automatically; upload the evidence you need explicitly.

## Manual intake and documents

Jira is optional. A manual YAML or JSON story can capture the audience, problem, desired outcome, scope, out-of-scope items, stakeholders, urgency, constraints, dependencies, acceptance criteria, risks, notes, and supporting documents.

Supporting files live under:

```text
.singularity/work-items/<WORK-ID>/inputs/DOC-nnn/<filename>
```

List, inspect, or add documents:

```bash
singularity-flow documents list WORK-123
singularity-flow documents view DOC-001 --work-id WORK-123
singularity-flow documents upload ./brief.pdf ./wireframe.png
singularity-flow documents upload \
  --url https://www.figma.com/design/example \
  --label "Checkout design"
```

Each uploaded file receives a stable ID, content hash, MIME type, actor, persona, and phase. Upload is allowed only during the initial phases configured by the selected profile. Local files are copied and pushed; external Figma or reference URLs are cataloged without being downloaded.

Use `/sflow-documents` in Copilot or the **Documents** page in the desktop app.

## Work types and phases

Starter work types are:

| Work type | Phase sequence |
|---|---|
| Feature | intake → requirements → design → implementation-spec → implementation → verification → conformance |
| Bugfix | intake → reproduction → fix-design → fix-spec → implementation → verification → conformance |
| Chore | intake → implementation → verification → conformance |

Feature work produces stable `AC-n` acceptance criteria and `SPEC-nnn` implementation items. Bugfix work uses a smaller fix specification but retains the same traceability model. Verification links tests and source evidence. Conformance compares approved requirements and specifications with exact code/test evidence.

View the immutable phase contract and exact next action for an active work item:

```bash
singularity-flow guide WORK-123
```

In Copilot, `/sflow-help WORK-123` gives the same work-item guidance.

## Personas and approvals

Personas add prompt perspective, world-model views, and approval capabilities. Starter personas include product owner, architect, developer, and QA.

Persona suggestions are not restrictions. Anyone may choose any configured persona for any phase. Approval authority comes from the selected persona's `mayApprove` list, while accountability comes from the authenticated GitHub or Git identity.

Start and resume ask for a persona. The active session is local:

```text
.git/singularity-flow/session.json
```

Selecting a persona alone does not create a commit. The next generation, submission, approval, rejection, or document upload records the actor and persona.

Multi-approval thresholds require distinct authenticated identities. Switching persona does not create another identity.

## Generating and publishing a phase

In Copilot, use `/sflow-phase`. It loads the current phase contract, selected persona prompt, required world-model views, persona views, and evidence ledger when needed.

The equivalent CLI sequence is:

```bash
singularity-flow prepare intake
# Complete the generated template.
singularity-flow phase publish intake
singularity-flow submit
```

Phase artifacts live under:

```text
.singularity/work-items/<WORK-ID>/artifacts/<phase>/
```

Publishing validates write scope, artifact requirements, hashes, traceability, and protected paths. It adds managed metadata, commits `[WORK-ID][phase:<id>][generated:<n>]`, and pushes the branch. Submission runs configured quality checks and creates its own atomic commit and push.

Artifact-only phases cannot modify application source. Implementation and verification may modify source only when their configured write scope permits it.

## Approval, rejection, and self-approval

Approve from a terminal:

```bash
singularity-flow approve WORK-123 --fetch
```

The command fetches the branch, asks for a persona, displays hashes, checks, token usage, prior approvals, and any self-approval warning, then requires explicit phase confirmation.

Reject to an allowed target:

```bash
singularity-flow reject WORK-123 --fetch \
  --to requirements \
  --reason "Failure behavior is missing"
```

Rejection reopens the target, invalidates target and downstream approvals, and preserves prior artifacts and decisions in Git history.

Self-approval is allowed when the same authenticated person generated and approved a phase, but it is marked `selfApproval: true`. It appears in artifacts, decision records, status, reports, and conformance, and is never described as independent review.

Use `/sflow-approve` and `/sflow-reject` in Copilot. These commands are explicitly user-invoked and must not run silently.

## Progress and status

Use status for detailed state and progress for deterministic completion:

```bash
singularity-flow status WORK-123
singularity-flow progress WORK-123
singularity-flow progress WORK-123 --json
```

Progress is `approved phases / total phases`. Singularity Flow never invents fractional credit inside an unapproved phase. The view includes the current phase and position, generations, approval threshold, document count, and token totals.

Use `/sflow-status` for full state and `/sflow-progress` for a concise completion view.

## Workflow performance reports

Reports are read-only projections over committed workflow history:

```bash
singularity-flow report WORK-123
singularity-flow report WORK-123 --format json
singularity-flow report WORK-123 --format html --out workflow-report.html
```

Reports show phase duration, active time, approval waiting, open approval latency, generations, rework, rejections, self-approvals, exact tokens, optional cost, quality-check duration, and the largest approval-latency bottleneck.

Durations are wall-clock time and include nights and weekends. They are not business-hours or productivity estimates. Token counts are exact only when the provider supplied them. Cost appears only when exact model pricing is configured; incomplete coverage is marked partial.

Use `/sflow-report` in Copilot.

## Token usage and optional cost

When a provider exposes exact usage, save its values as JSON and publish with:

```bash
singularity-flow phase publish implementation --usage-json usage.json
```

The usage record may contain provider, model, input, output, cached-input and total tokens, timestamps, and collection source. Missing values are recorded as `unavailable`; they are never estimated silently.

Optional report pricing uses rates per million tokens keyed by the exact provider model name:

```yaml
tokens:
  mode: exact-or-unavailable
  pricing:
    provider-model-name:
      input: 3
      output: 15
      cachedInput: 0.3
```

No model prices are bundled because prices change over time. Exact total tokens without an input/output breakdown cannot be priced safely and remain unavailable for cost calculation.

## Git state transfer and recovery

Every successful generation and lifecycle decision is committed and pushed when `git.publish: required` is configured. Resume work from another terminal with:

```bash
singularity-flow resume WORK-123 --fetch
```

Resume performs fetch plus fast-forward-only checkout and asks for a persona. It reconstructs work state from the branch rather than copying a local session.

If push fails, the local commit is retained and transitions are blocked. Fix connectivity or authentication and run:

```bash
singularity-flow sync
```

Sync retries the existing history without rebasing, resetting, or force-pushing. A normal non-fast-forward rejection protects concurrent terminal decisions from overwriting one another.

## World model

The world model grounds phase generation in repository facts:

```bash
singularity-flow wm build --phase design --task "Design invoice export"
singularity-flow wm context design --concat
singularity-flow wm check
```

Context composition is additive:

```text
phase instructions
+ selected persona prompt
+ phase-required world-model views
+ persona world-model views
+ evidence ledger for verification and conformance
```

Persona views never remove phase-required views. Verification and conformance load test/source evidence. Use the relevant phase skill in Copilot; it builds and reads routed context before generating content.

## Conformance and final gate

The final conformance artifact compares every approved `AC-n` and `SPEC-nnn` with source and test evidence. Verdicts are `matched`, `partial`, `missing`, `deviated`, or `unplanned`. Evidence uses exact files and lines, and approved deviations and self-approvals are disclosed.

Run the final deterministic gate:

```bash
singularity-flow gate --terminal
```

The gate validates configuration and template snapshots, artifact hashes and metadata, generation publication, approval personas and identities, thresholds, rejection cascades, AC/SPEC/test traceability, conformance freshness, protected paths, and remote branch state.

Conformance stores a source/test tree hash. Later code or test changes make the report stale and require regeneration.

## Configuring workflows

Edit `.singularity/workflow.yml` directly or use Singularity Flow Desktop. The definition controls:

- `workTypes`: phase sequences and profile overrides
- `phases`: artifact contracts, write scope, views, checks, and approvals
- `personas`: prompts, views, suggested phases, and approval capability
- `documents`: allowed upload phases and size limits
- `git`: remote and publication policy
- `tokens`: exact-or-unavailable mode and optional pricing
- `governance`: protected paths and traceability rules

Template resolution is work-type override, then phase default, then configuration error. Keep templates in `.singularity/templates/` and persona prompts in `.singularity/personas/`.

Validate changes before publishing:

```bash
singularity-flow desktop validate --json
singularity-flow validate
```

Process files are protected during phase generation. Change them in a dedicated configuration commit, review them like code, and avoid changing active work-item state manually.

## Electron desktop

Start the desktop studio from a clone:

```bash
npm install
npm run desktop:dev
```

Create a production renderer build with `npm run desktop:build` or packaged installers with `npm run desktop:dist`.

The desktop app provides:

- Overview and progress dashboard
- Visual workflow and approval-rule designer
- Persona and approval-capability inspection
- Artifact-template source and preview
- Supporting-document catalog and upload
- Searchable help manual
- Validated configuration save, commit, and push

Open an initialized repository. The desktop is a control plane over the same CLI and Git state; it does not maintain a second workflow database. Renderer sandboxing, context isolation, and a narrow preload API keep filesystem and Git access outside the UI.

## Copilot commands

All public skills use the collision-safe `sflow-` prefix:

| Copilot command | Purpose |
|---|---|
| `/sflow-start` | Guided Jira or manual intake, workflow selection, and persona selection |
| `/sflow-resume` | Fetch, fast-forward, and select a persona |
| `/sflow-help` | Load this manual or explain the selected work-item workflow |
| `/sflow-phase` | Generate the current phase using its contract and world model |
| `/sflow-requirements` | Requirements-focused generation |
| `/sflow-design` | Architecture/design-focused generation |
| `/sflow-implement` | Implementation-focused generation |
| `/sflow-verify` | Verification and evidence generation |
| `/sflow-submit` | Submit the current generated phase |
| `/sflow-approve` | Explicitly review and approve a submitted phase |
| `/sflow-reject` | Explicitly reject to an allowed earlier phase |
| `/sflow-status` | Show detailed work-item state and warnings |
| `/sflow-progress` | Show deterministic phase completion |
| `/sflow-report` | Show timing, waiting, rework, token, and bottleneck metrics |
| `/sflow-documents` | List, view, and upload supporting documents |
| `/sflow-review` | Review current artifacts and evidence |
| `/sflow-release` | Prepare final release/conformance activities |
| `/sflow-jira-story` | Inspect or import one Jira story |
| `/sflow-jira-work` | Find assigned Jira work |
| `/sflow-workflow-rules` | Explain deterministic workflow rules |

If commands do not appear, run `singularity-flow plugin install`, close existing Copilot sessions, start a new session, and check `copilot skill list`.

## Installation and company registries

From a clean clone, the supported local update/install workflow is:

```bash
npm run install:local
```

It performs a fast-forward-only pull, asks for the npm registry, installs dependencies, creates the tarball, installs it globally, removes old plugin identities, and installs the current marketplace plugin.

For a company Artifactory or registry:

```bash
npm run install:local -- \
  --registry https://artifacts.company.com/artifactory/api/npm/npm-virtual/
```

Or set `SINGULARITY_FLOW_NPM_REGISTRY`. Authentication remains in `.npmrc`; do not embed credentials or tokens in the URL. The installer rejects dirty checkouts and never resets, rebases, or force-pushes.

## Troubleshooting

### Copilot plugin is installed but commands are missing

Run:

```bash
singularity-flow plugin install
copilot plugin list
copilot skill list
```

Only `singularity-flow@singularity-flow` should remain. Close existing Copilot sessions because sessions do not always reload newly installed skills.

### Start or resume says an interactive terminal is required

Work type and persona selection require an interactive terminal. Run the command directly in a terminal or invoke `/sflow-start` or `/sflow-resume` from Copilot with terminal interaction available.

### A transition is blocked after push failure

The local lifecycle commit is intentionally retained. Fix remote access, then run `singularity-flow sync`. Do not rewrite or force-push the branch.

### Artifact-only phase reports source changes

Move source changes to implementation or verification. Intake, requirements, design, and specification phases normally permit only their phase artifact and managed state.

### Approval persona is rejected

Select a persona listed by the phase approval policy and confirm that persona lists the phase in `mayApprove`. Persona suggestions do not grant approval authority by themselves.

### Jira fields are empty or wrong

Use `singularity-flow jira fields --query <name>` against the Jira site and configure the returned custom-field IDs in the documented environment variables.

### Report token or cost values are unavailable

Copilot or the provider did not expose exact usage, the exact model name has no configured price, or the record has only total tokens without a safe input/output breakdown. Singularity Flow does not estimate these values.

### Desktop cannot open a repository

Confirm the directory is a Git repository and contains `.singularity/workflow.yml`. Run `singularity-flow init` and commit the initialized files first.

## CLI command reference

```text
singularity-flow help [TOPIC] [--json]
singularity-flow init
singularity-flow start <WORK-ID> [--jira | --story-file FILE]
singularity-flow resume <WORK-ID> [--fetch]
singularity-flow guide [WORK-ID] [--json]
singularity-flow status [WORK-ID] [--json]
singularity-flow progress [WORK-ID] [--json]
singularity-flow report [WORK-ID] [--format md|html|json] [--out FILE]
singularity-flow documents list [WORK-ID] [--json]
singularity-flow documents view <DOCUMENT-ID|PATH> [--work-id ID]
singularity-flow documents upload <PATH...> [--url URL]
singularity-flow prepare [PHASE]
singularity-flow phase publish [PHASE] [--usage-json FILE]
singularity-flow artifact add <PATH...> [--kind KIND] [--phase PHASE]
singularity-flow artifact scan [--phase PHASE]
singularity-flow submit [--phase PHASE]
singularity-flow approve [WORK-ID] [--fetch]
singularity-flow reject [WORK-ID] [--fetch] --reason TEXT [--to PHASE]
singularity-flow sync
singularity-flow validate [--strict]
singularity-flow gate [--terminal]
singularity-flow wm build|context|check
singularity-flow jira list|pull|fields
singularity-flow plugin install|uninstall|list|path
singularity-flow desktop snapshot|validate|save|publish|session
```

Run `singularity-flow --help` for the current terse usage list and `singularity-flow help <topic>` for one section of this manual.
