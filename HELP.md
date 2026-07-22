# Singularity Flow Help

Singularity Flow is a Git-native SDLC workflow for GitHub Copilot and engineering teams. It turns requirements, designs, implementation specifications, code, tests, approvals, and conformance evidence into durable branch state that another person or terminal can resume safely.

Use this manual in three places:

- Terminal: `singularity-flow help` or `singularity-flow help <topic>`
- GitHub Copilot CLI: `/sflow-help`
- Singularity Flow Desktop: open **Help** in the sidebar

The short command reference is available with `singularity-flow --help`.

For a visual end-to-end walkthrough with architecture, lifecycle, Git handoff, phase-input, and remote-agent diagrams, open `HOW-TO.md` in the repository.

## About and command namespace

**Singularity Flow** is the product under the **Singularity** brand. It is a
Git-native, configurable SDLC orchestration system that carries requirements,
designs, implementation specifications, evidence, approvals, and reports through
reviewable work-item branches.

Run `/sflow-about` in Copilot or `sflow-about` in a terminal for the concise
installed-version summary. All public Copilot commands use the short,
collision-safe `/sflow-<action>` form. Terminal shortcuts use
`sflow-<action>` where supplied. The full `singularity-flow <action>` CLI remains
available for scripts and backward compatibility; it is not a Copilot slash-command
prefix.

## Quick start

Install the package, initialize a repository, and commit its editable process definition:

```bash
npm install --global ./singularity-flow-0.8.0.tgz
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
/sflow-nextsteps WORK-123
/sflow-next
/sflow-phase
```

The normal phase loop is:

1. Generate or edit the current artifact.
2. Publish the generation.
3. Submit it for approval.
4. Review every generated phase document displayed by submission.
5. Approve it or reject it to an allowed earlier phase.
6. Continue until conformance is approved.

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

For a tab-like browser inside a canvas-capable Copilot host, enable experimental features, start a fresh session, and invoke the bundled extension:

```text
/experimental on
/documents
/documents view PHASE-DESIGN
```

The canvas separates generated artifacts, uploaded inputs, and workflow documents, with search and full text previews. It embeds a fresh snapshot directly in the canvas; run `/documents` again after generating or uploading files to reload it. If the host cannot render canvases, `/documents` falls back to deterministic terminal list/view output. This extension cannot add a fifth built-in Copilot home tab because that UI surface is not exposed to plugins.

Use `/sflow-documents` for the model-assisted upload workflow or the **Documents** page in the desktop app.

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

For a compact ordered action plan at any time—including before initialization,
without an active work item, during pending push recovery, or after workflow
completion—run:

```bash
singularity-flow nextsteps [WORK-ID]
```

In Copilot, use `/sflow-nextsteps [WORK-ID]`. It labels actions as `NOW`,
`THEN`, or `ALTERNATIVE` and never executes them automatically.

Use `/sflow-next` when you want the first valid action executed. Its terminal
equivalent is `sflow-next`, which delegates to `singularity-flow next`.

## Approved phase inputs

Phase inputs make approved upstream artifacts explicit prompt dependencies. The top-level mode is pinned when the work item starts:

```yaml
inputsMode: record          # off | record | enforce

phases:
  design:
    inputs:
      - requirements
      - phase: intake
        optional: true
        maxBytes: 16384
```

- `off`, including a missing key, validates declarations but changes no runtime behavior.
- `record` resolves and injects available approved artifacts, records hashes, and warns when required input is unavailable or tampered.
- `enforce` blocks preparation and publication when required input is unavailable or any present input fails hash verification.

String entries are required and unbounded. An omitted `maxBytes` injects the complete artifact. A work type may replace a phase declaration through `phaseOverrides.<phase>.inputs`.

Inspect or render the prospective generation:

```bash
singularity-flow inputs design --dry-run
singularity-flow inputs design
```

Normal execution updates the marker-delimited managed input block and writes `context/inputs-<phase>-gen<n>.json`. Repeating preparation replaces only that managed block. Publication recollects the approved artifacts so editing the rendered block cannot bypass enforcement. Use `/sflow-inputs` in Copilot.

## Personas and approvals

Personas add prompt perspective, world-model views, and approval capabilities. Starter personas include product owner, architect, developer, and QA.

Persona suggestions are not restrictions. Anyone may choose any configured persona for any phase. Approval authority comes from the selected persona's `mayApprove` list, while accountability comes from the authenticated GitHub or Git identity.

Start and resume ask for a persona. The active session is local:

```text
.git/singularity-flow/session.json
```

Selecting a persona alone does not create a commit. The next generation, submission, approval, rejection, or document upload records the actor and persona.

Copilot uses its interactive `ask_user` facility for intake source, workflow,
and persona choices. The choices are read from the CLI's live YAML-derived menu,
so custom work types and personas appear automatically. The skill sends the
selected menu number back to the same interactive CLI process; it never invents
a default or uses hidden `--type`/`--persona` flags. If interactive questions are
disabled, the skill stops and directs the contributor to the terminal picker.

Switch the active persona at any time without changing committed workflow state:

```text
/sflow-persona
```

```bash
sflow-persona
```

The selection remains active across CLI, Copilot, and later terminal invocations in this repository until another `start`, `resume`, `/sflow-persona`, approval, or rejection selection replaces it. It is deliberately not pushed: a different clone must run `singularity-flow resume <WORK-ID> --fetch` and declare its own persona.

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

After publication succeeds and any required push completes, the command prints every generated phase document with its path, SHA-256 hash, and text content. Source files such as Java, JavaScript, TypeScript, Python, Go, and shell scripts are treated as reviewable text; true binary documents print an openable local path. This is the exact published artifact preview, not an AI-generated summary.

Copilot may collapse the Shell tool panel even though the CLI printed the content. Singularity Flow skills therefore reload the phase with `singularity-flow phase show <phase> --json` and reproduce every text document in the visible assistant response between `BEGIN` and `END` path markers. A message such as “documents shown above” without those visible bodies is incomplete and should not be used for approval.

Phase artifacts live under:

```text
.singularity/work-items/<WORK-ID>/artifacts/<phase>/
```

Publishing validates write scope, artifact requirements, hashes, traceability, and protected paths. It adds managed metadata, commits `[WORK-ID][phase:<id>][generated:<n>]`, and pushes the branch. Submission runs configured quality checks and creates its own atomic commit and push.

Artifact-only phases cannot modify application source. Implementation and verification may modify source only when their configured write scope permits it.

## Sequence enforcement

Sequence enforcement is configurable gate by gate.

Lifecycle mutations normally follow the configured order:

```text
prepare/edit → publish generation → submit → approve or reject
```

Each sequence guard is configured as `hard` or `soft` in `.singularity/workflow.yml`. A missing `sequenceGates` section means every gate is `hard`, preserving existing repository behavior. Global values may be overridden for a work type. The fully resolved policy is snapshotted at work-item creation, so changing the base branch configuration does not alter an active item.

```yaml
sequenceGates:
  default: soft
  completion: hard
  currentPhase: hard
  freshGeneration: hard
  generationCommit: hard
  remoteGeneration: hard
  publicationPending: hard

workTypes:
  feature:
    # Optional overrides for this profile.
    sequenceGates:
      phaseStatus: soft
      documentPhase: soft
```

The configurable gates are:

| Gate | Protects |
|---|---|
| `completion` | Mutating a completed workflow |
| `currentPhase` | Acting on a phase other than the active phase |
| `phaseStatus` | Acting from the wrong phase status, such as approval before submission |
| `freshGeneration` | Submitting without a new generation, including after rejection |
| `generationCommit` | Submitting without the required generation commit |
| `remoteGeneration` | Submitting before the generation reaches the configured remote |
| `publicationPending` | Mutating while a retained local commit still needs synchronization |
| `documentPhase` | Uploading supporting documents outside the configured intake phases |

A `hard` gate exits with code `2` before changing workflow files or creating a commit. A `soft` gate displays the same current state, reason, required command, and consequences, then asks:

```text
Do you want to continue anyway? Type continue to proceed:
```

Only an interactive human can confirm a soft gate. A refusal, any answer other than `continue`, or a non-interactive terminal exits with code `2` without mutation. Copilot must show the warning and leave confirmation to the person; it must never type `continue` or otherwise self-confirm.

```text
Singularity Flow error: Out of sequence [phaseStatus]: cannot approve for phase 'design'.
Current state: phase 'design' is in_progress at generation 1.
Gate mode: hard.
Required next action: Submit published phase 'design' for approval.
Run next: singularity-flow submit --phase design
See all valid actions: singularity-flow nextsteps WORK-123
No workflow files, commits, or remote state were changed.
```

Every confirmed soft override records the gate, action, reason, prior state, authenticated identity, selected persona, and time in workflow history and artifact metadata. `status`, the work-item report, and the governance gate expose these overrides; governance reports them as warnings. A soft override is an audited exception, not a successful independent control.

Starter repositories use soft gates for phase-status and document-phase mistakes while keeping completion, cross-phase actions, generation integrity, remote publication, and pending synchronization hard. Teams may change those defaults before starting a work item. Never bypass either mode by editing `workflow.json`, status files, metadata, or approvals directly.

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

Each approval—including each partial decision toward a multi-approval threshold—creates and pushes a separate atomic commit before the command succeeds. If publication fails, the approval commit remains local, publication is marked pending, and later decisions are blocked until `singularity-flow sync` publishes it.

Use `/sflow-approve` and `/sflow-reject` in Copilot. These commands are explicitly user-invoked and must not run silently.

Submission automatically displays every generated current-phase document before
recommending approval. It includes the stable document ID, repository path, kind,
byte count, SHA-256, and Markdown/text content. Binary and image artifacts are
shown as absolute paths with metadata. Approval displays the same documents again
before the exact phase-name confirmation. Review them at any time with:

```bash
singularity-flow phase show requirements
singularity-flow phase show requirements --json
singularity-flow documents view PHASE-REQUIREMENTS
```

Use `/sflow-next` or `sflow-next --task "<objective>"` to execute exactly one
next valid action. Depending on state, it synchronizes a retained commit,
prepares and grounds the current generation, submits a published generation,
opens the interactive approval flow, or runs the final terminal gate. Generation
and submission remain separate invocations. Approval never bypasses persona
selection or confirmation, and its decision commit must be pushed before success.

## Progress and status

Use status for detailed state and progress for deterministic completion:

```bash
singularity-flow status WORK-123
singularity-flow progress WORK-123
singularity-flow progress WORK-123 --json
```

Progress is `approved phases / total phases`. Singularity Flow never invents fractional credit inside an unapproved phase. The view includes a vertical arrow-based phase map, with distinct markers for completed (`✓`), current (`▶`), awaiting-approval (`◆`), and pending (`○`) phases, followed by the detailed table. It also includes the current position, generations, approval threshold, document count, and token totals.

Use `/sflow-status` for full state and `/sflow-progress` for a concise completion view.

## Workflow performance reports

Reports are read-only projections over committed workflow history:

```bash
singularity-flow report WORK-123
singularity-flow report WORK-123 --format json
singularity-flow report WORK-123 --format html --out workflow-report.html
```

Reports show phase duration, active time, approval waiting, open approval latency, generations, rework, rejections, self-approvals, provider/model identity, exact tokens with per-model totals, optional cost, quality-check duration, and the largest approval-latency bottleneck.

Durations are wall-clock time and include nights and weekends. They are not business-hours or productivity estimates. Token counts are exact only when the provider supplied them. Cost appears only when exact model pricing is configured; incomplete coverage is marked partial.

Use `/sflow-report` in Copilot.

## Token usage and optional cost

When a provider exposes exact usage, save its values as JSON and publish with:

```bash
singularity-flow phase publish implementation --usage-json usage.json
```

The usage record may contain provider, model, input, output, cached-input and total tokens, timestamps, and collection source. Missing values are recorded as `unavailable`; they are never estimated silently. Markdown, HTML, and JSON reports identify the models used per phase and aggregate records and tokens by provider/model.

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
singularity-flow wm compose --phase design --task "Design invoice export" --dry-run
singularity-flow wm compose --phase design --task "Design invoice export"
singularity-flow wm check
```

`wm build` runs the configured generator in a detached analysis worktree. Only
its isolated output is accepted. Singularity Flow validates the manifest and
every declared regular file, rejects escaping paths/symlinks and unexpected
repository writes, records a source-tree hash, atomically installs the output,
commits it, and publishes it according to `git.publish`.

`wm compose` renders the active persona prompt with mandatory phase/persona
views, an exact task guide when `--task` is supplied, applicable evidence,
focused `worldModel.injection.rules`, and verified active-agent skills. Rules may
match the active persona, phase, immutable work type, committed or pending
changed-path globs, and Jira/manual source labels. `wm inject` is a compatibility
alias for the same command.

```yaml
worldModel:
  grounding: enforce        # off | warn | enforce; absent means off
  staleness: warn           # warn | fail | ignore
  injection:
    placeholder: "{{WORLD_MODEL}}"
    mode: append             # replace | append | off
    maxBytes: 32768
    rules:
      - when: { persona: architect, phase: design }
        include: [domains/payments.md]
      - when: { changedPaths: "src/api/**" }
        include: [domains/api.md]
      - when: { labels: security }
        include: [views/security.md]
```

Preview rule matching without writing an audit record:

```bash
singularity-flow wm compose --phase design --task "Design invoice export" --dry-run
```

Every non-dry-run composition writes
`.singularity/work-items/<WORK-ID>/context/<phase>-gen<n>.json` with the persona,
committed model revision, manifest/source hashes, required views, selected files,
SHA-256 hashes, byte counts, and truncation flags. It also writes the exact
rendered prompt to `context/prompts/<phase>-gen<n>.md`. The next `phase publish`
commit carries both files with the generation.

In `enforce` mode, publication fails if composition is absent, stale, uncommitted,
uses the wrong persona, omits a required view, or differs from its committed
manifest/prompt snapshot. `warn` reports the same problems without blocking.
`off` skips the grounding gate and is the default for configurations created
before this feature. The mode is pinned into work-item resolution at start, so
later configuration changes cannot weaken or strengthen an in-flight item.

Context composition is additive:

```text
+ phase skill contract
+ selected persona prompt
+ phase-required world-model views
+ persona world-model views
+ exact task guide (when requested)
+ rule-selected repository world-model files
+ active-agent remote skill Markdown
+ evidence ledger for verification and conformance
```

Approved phase inputs are injected separately by `prepare` into the managed
artifact template. Persona views never remove phase-required views. Verification
and conformance load test/source evidence. Phase skills use `wm compose` once,
building first with the same exact task text when needed.

## Remote agent Markdown

Repository world models always remain repository-generated and repository-owned. Copilot agents may additionally declare plain public HTTPS Markdown dependencies in exact tables under these headings:

```markdown
## Remote skills

| ID | URL | Phases | Personas | Optional | Max bytes |

## Remote artifact templates

| ID | URL | Phases | Optional | Max bytes |

## Remote generated artifacts

| ID | URL template | Phase | Target | Optional | Max bytes |
```

Only table links are processed; links in prose are inert. Content must be non-empty UTF-8 Markdown. The default limit is 1 MiB and the hard ceiling is 10 MiB. URLs must be public HTTPS without credentials. Dynamic output URLs support only URL-encoded `{workId}`, `{workType}`, `{phase}`, and `{generation}`. Output targets must remain under `artifacts/<phase>/`.

Discover, trust, and activate an agent:

```bash
singularity-flow agents list
singularity-flow agents lock architecture
singularity-flow agents sync architecture
singularity-flow agents status architecture
```

First trust and every `--update` display hashes and require typing the exact agent name. The committed `.singularity/agents.lock.yml` pins agent-file and dependency hashes. Sync never updates trust: it verifies the lock, writes an atomic cache under `.git/singularity-flow/`, and records the active agent while preserving the selected persona. No authentication, cookies, or bearer tokens are sent.

Remote skills are prompt context for the active agent, not global slash commands. Reference a remote artifact template explicitly with `agent:architecture/design-template`; it is copied into the work item and pinned before use. Dynamic generated output is fetched once per prospective generation and reused. If the remote result changed, refresh deliberately:

```bash
singularity-flow agents refresh-output threat-model
# Add --replace only after deciding to discard local edits.
```

The bundled `sflow-workflow` Copilot agent contains empty dependency tables, so installation alone performs no remote download. Teams add their own URLs later. The desktop **Agents & remote Markdown** page edits repository agent Markdown, shows lock status, and keeps the lock read-only.

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
- `inputsMode`: off, warning/audit recording, or enforced approved-artifact dataflow
- `phases`: artifact contracts, approved inputs, write scope, views, checks, and approvals
- `personas`: prompts, views, suggested phases, and approval capability
- repository agent Markdown and `.singularity/agents.lock.yml`: optional trust-pinned remote prompt/template/output sources
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
- Repository agent Markdown editor and read-only remote lock status
- Supporting-document catalog and upload
- Searchable help manual
- Validated configuration save, commit, and push

Open an initialized repository. The desktop is a control plane over the same CLI and Git state; it does not maintain a second workflow database. Renderer sandboxing, context isolation, and a narrow preload API keep filesystem and Git access outside the UI.

## Copilot commands

All public skills use the collision-safe `sflow-` prefix:

| Copilot command | Purpose |
|---|---|
| `/sflow-about` | Explain the Singularity Flow brand, installed version, capabilities, and command namespace |
| `/sflow-start` | Guided Jira or manual intake, workflow selection, and persona selection |
| `/sflow-resume` | Fetch, fast-forward, and select a persona |
| `/sflow-persona` | Select or change the persona for the current local work-item session |
| `/sflow-help` | Load this manual or explain the selected work-item workflow |
| `/sflow-nextsteps` | Show the ordered next, subsequent, and alternative actions at any time |
| `/sflow-next` | Execute exactly one next valid lifecycle action |
| `/sflow-inputs` | Preview or render approved upstream artifact inputs |
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
./install.sh
```

`npm run install:local` invokes the same script.

It performs a fast-forward-only pull, asks for the npm registry, installs locked dependencies, builds the desktop renderer, runs tests and checks, creates the tarball, replaces the global CLI, removes old plugin identities, and installs the current marketplace plugin.

For a company Artifactory or registry:

```bash
./install.sh --registry https://artifacts.company.com/artifactory/api/npm/npm-virtual/
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

### Agent sync reports stale or changed content

Run `singularity-flow agents status <AGENT>`. If the agent Markdown or a remote hash changed, use `singularity-flow agents lock <AGENT> --update`, inspect the old/new hashes, type the exact agent name, commit the lock, and sync again. Never edit the lock by hand.

### Remote generated output has local edits

Review the local artifact first. `singularity-flow agents refresh-output <RESOURCE-ID>` will preserve conflicting local edits and explain the conflict. Add `--replace` only when you intentionally want the newly fetched Markdown to overwrite them.

## CLI command reference

```text
singularity-flow about
sflow-about
singularity-flow help [TOPIC] [--json]
singularity-flow init
singularity-flow start <WORK-ID> [--jira | --story-file FILE]
singularity-flow resume <WORK-ID> [--fetch]
singularity-flow persona [WORK-ID]
sflow-persona [WORK-ID]
singularity-flow guide [WORK-ID] [--json]
singularity-flow nextsteps [WORK-ID] [--json]
singularity-flow next [--task TEXT] [--fetch] [--yes] [--skip-checks]
sflow-next [--task TEXT] [--fetch] [--yes] [--skip-checks]
singularity-flow inputs [PHASE] [--dry-run]
singularity-flow agents list
singularity-flow agents lock <AGENT> [--update]
singularity-flow agents sync <AGENT>
singularity-flow agents status [AGENT]
singularity-flow agents refresh-output <RESOURCE-ID> [--replace]
singularity-flow status [WORK-ID] [--json]
singularity-flow progress [WORK-ID] [--json]
singularity-flow report [WORK-ID] [--format md|html|json] [--out FILE]
singularity-flow documents list [WORK-ID] [--json]
singularity-flow documents view <DOCUMENT-ID|PATH> [--work-id ID]
singularity-flow documents upload <PATH...> [--url URL]
singularity-flow prepare [PHASE]
singularity-flow phase show [PHASE] [--json]
singularity-flow phase publish [PHASE] [--usage-json FILE]
singularity-flow artifact add <PATH...> [--kind KIND] [--phase PHASE]
singularity-flow artifact scan [--phase PHASE]
singularity-flow submit [--phase PHASE]
singularity-flow approve [WORK-ID] [--fetch]
singularity-flow reject [WORK-ID] [--fetch] --reason TEXT [--to PHASE]
singularity-flow sync
singularity-flow validate [--strict]
singularity-flow gate [--terminal]
singularity-flow wm build|context|inject|check
singularity-flow jira list|pull|fields
singularity-flow plugin install|uninstall|list|path
singularity-flow desktop snapshot|validate|save|publish|session
```

Run `singularity-flow --help` for the current terse usage list and `singularity-flow help <topic>` for one section of this manual.
