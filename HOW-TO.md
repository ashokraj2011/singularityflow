# Singularity Flow 0.8.0 — Visual How-To Guide

This guide shows how Singularity Flow turns a Jira story or manual request into approved, Git-transferable artifacts, implementation evidence, and a final specification-to-code comparison.

## The system at a glance

```mermaid
flowchart LR
  Person["Contributor chooses work type and persona"] --> Intake["Jira story or manual intake and documents"]
  Intake --> Profile["Immutable workflow profile snapshot"]

  subgraph Prompt["Prompt composition for the active phase"]
    Contract["Phase contract and artifact template"]
    Persona["Selected persona prompt"]
    World["Repository world model: required and rule-selected views"]
    Agent["Active-agent remote skill Markdown: optional and hash-pinned"]
    Inputs["Approved upstream phase artifacts: optional mode"]
  end

  Profile --> Contract
  Contract --> Generation["Generate or edit phase artifact"]
  Persona --> Generation
  World --> Generation
  Agent --> Generation
  Inputs --> Generation

  Generation --> Gate["Deterministic validation and provenance"]
  Gate --> Commit["Atomic lifecycle commit"]
  Commit --> Push["Push work-item branch"]
  Push --> Review["Reviewer selects approval persona"]
  Review -->|"Approve"| Next["Advance to next phase"]
  Review -->|"Reject"| Earlier["Return to allowed earlier phase"]
  Earlier --> Prompt
  Next --> Complete{"Conformance approved?"}
  Complete -->|"No"| Prompt
  Complete -->|"Yes"| Report["Final AC and SPEC to code/test comparison"]
```

The core rule is simple: AI helps create content, while the CLI owns workflow state, metadata, validation, commits, pushes, approvals, and recovery.

## Lifecycle and Git state transfer

```mermaid
sequenceDiagram
  actor Author as Author terminal or Copilot
  participant CLI as Singularity Flow CLI
  participant Branch as Work-item branch
  actor Reviewer as Reviewer terminal

  Author->>CLI: start WORK-123
  CLI->>Author: Choose intake, workflow, and persona
  CLI->>Branch: Commit and push immutable work-item state

  loop Every phase
    Author->>CLI: nextsteps and prepare phase
    CLI-->>Author: Template, prompt context, approved inputs
    Author->>CLI: phase publish
    CLI->>CLI: Validate scope, hashes, metadata, and usage
    CLI->>Branch: Commit and push generation
    Author->>CLI: submit
    CLI->>Branch: Commit and push approval request
    Reviewer->>CLI: approve or reject with selected persona
    CLI->>Branch: Commit and push decision
  end

  Reviewer->>Branch: Fetch from another terminal
  Reviewer->>CLI: resume WORK-123 --fetch
  CLI-->>Reviewer: Reconstructed state from branch files
```

No workflow database is required. The branch contains the transferable state; `.git/singularity-flow/session.json` contains only the current terminal's persona and optional active agent.

## 1. Install from a clone

The single supported local installer pulls, builds, tests, packages, globally installs, removes old Copilot plugin copies, and installs the current marketplace plugin:

```bash
git clone https://github.com/ashokraj2011/singularityflow.git
cd singularityflow
./install.sh
```

For a company registry or Artifactory:

```bash
./install.sh \
  --registry https://artifacts.company.com/artifactory/api/npm/npm-virtual/
```

Keep credentials in `.npmrc`; never put credentials in the registry URL. Verify installation:

```bash
singularity-flow --version
copilot plugin list
copilot skill list
```

Expected version: `0.8.0`. Start a new Copilot session after plugin installation so the refreshed skills and bundled agent are discovered.

## 2. Initialize an application repository

Run this inside the repository where the team will do the actual feature or bugfix work:

```bash
cd your-application-repository
singularity-flow init
git add .singularity
git commit -m "Initialize Singularity Flow"
git push
```

Initialization creates editable workflow YAML, artifact templates, persona prompts, and the repository world-model builder prompt.

```text
.singularity/
├── workflow.yml
├── personas/
├── prompts/
└── templates/
```

Review `.singularity/workflow.yml` before starting production work, especially `git.remote`, `git.publish`, work-type phases, personas, approvals, and protected paths.

## 3. Start a work item

From Copilot:

```text
/sflow-start WORK-123
```

Or from a terminal:

```bash
singularity-flow start WORK-123
```

The interactive sequence is always:

1. Choose Jira intake or manual description/documents.
2. Choose a workflow profile: feature, bugfix, or chore.
3. Choose a persona for the current terminal.

Manual intake can also be supplied explicitly:

```bash
singularity-flow start WORK-123 \
  --title "Add invoice export" \
  --description "Finance needs a filtered invoice export." \
  --acceptance-criteria "Authorized users can export the filtered result." \
  --document ./brief.pdf \
  --document-url https://www.figma.com/design/example
```

The selected work type, resolved phases, input mode, configuration hash, and template hashes are copied into the work item. Later base-branch configuration edits cannot silently change it.

## 4. Ask what to do next

At any time:

```text
/sflow-nextsteps WORK-123
```

```bash
singularity-flow nextsteps WORK-123
```

The result labels actions as:

- `NOW`: safe current action.
- `THEN`: action after the current transition succeeds.
- `ALTERNATIVE`: valid rejection or recovery path.

It also reports pending publication, enforced input work, stale agent locks, required agent synchronization, and remote-output conflicts.

## 5. Generate and publish a phase

The normal Copilot command is:

```text
/sflow-phase
```

The equivalent terminal loop is:

```bash
singularity-flow prepare <phase>
# Complete the returned artifact and any permitted source/test changes.
singularity-flow phase publish <phase>
singularity-flow submit --phase <phase>
```

Publishing performs the following transaction:

```mermaid
flowchart LR
  Prepare["Resolve template, persona, world model, agent skills, and inputs"] --> Edit["Author artifact and permitted code or tests"]
  Edit --> Validate["Validate write scope, hashes, metadata, traceability, and quality"]
  Validate --> State["Update workflow state and audit records"]
  State --> Commit["Commit: WORK-ID phase generated N"]
  Commit --> Push["Fast-forward push"]
  Push --> Submit["Submit for approval"]
```

Artifacts are stored under:

```text
.singularity/work-items/<WORK-ID>/artifacts/<phase>/
```

Do not manually edit `workflow.json`, `STATUS.md`, approval records, or the managed metadata comment.

## 6. Use approved phase inputs

The workflow controls whether approved upstream artifacts enter later phases:

```yaml
inputsMode: record  # off | record | enforce

phases:
  design:
    inputs:
      - requirements
      - phase: intake
        optional: true
        maxBytes: 16384
```

Behavior by mode:

| Mode | Missing required input | Tampered present input | Runtime behavior |
|---|---|---|---|
| `off` | Ignored | Ignored | Declarations validate; no injection or record |
| `record` | Warning | Warning | Inject available approved content and record provenance |
| `enforce` | Error | Error | Block generation until the problem is resolved |

Preview without writing:

```bash
singularity-flow inputs design --dry-run
```

Render the managed input block and audit record:

```text
/sflow-inputs design
```

```bash
singularity-flow inputs design
```

Publication recollects and verifies the producer artifact, so changing the rendered block cannot bypass enforcement.

## 7. Use optional remote agent Markdown

Repository world models stay generated and stored in the application repository. Remote delivery is only for optional agent skills, artifact templates, and generated artifacts represented as public HTTPS Markdown.

```mermaid
flowchart LR
  AgentFile["Repository or plugin agent Markdown"] --> Tables["Exact remote dependency tables"]
  Tables --> Lock["agents lock: display hashes and confirm exact agent name"]
  Lock --> LockFile["Committed .singularity/agents.lock.yml"]
  LockFile --> Sync["agents sync: verify only, never update trust"]
  Sync --> Cache["Local atomic cache under .git/singularity-flow"]
  Cache --> Prompt["Phase and persona-scoped prompt context"]
  Cache --> Template["Explicit remote template snapshot"]
  Cache --> Output["Generation-scoped remote output snapshot"]
```

Only links inside these exact tables are processed; normal prose links are inert:

```markdown
## Remote skills

| ID | URL | Phases | Personas | Optional | Max bytes |
|---|---|---|---|---|---|
| security-review | https://example.com/security.md | design, verification | architect | false | 65536 |

## Remote artifact templates

| ID | URL | Phases | Optional | Max bytes |
|---|---|---|---|---|
| design-template | https://example.com/design.md | design | false | 65536 |

## Remote generated artifacts

| ID | URL template | Phase | Target | Optional | Max bytes |
|---|---|---|---|---|---|
| threat-model | https://example.com/{workId}/{generation}.md | design | artifacts/design/threat-model.md | false | 65536 |
```

Trust and activate the agent:

```bash
singularity-flow agents list
singularity-flow agents lock architecture
singularity-flow agents sync architecture
singularity-flow agents status architecture
```

Rules:

- First trust and every update require typing the exact agent name.
- Sync never changes lock hashes.
- Remote skills do not become slash commands.
- A remote template replaces a workflow template only through an explicit reference such as `agent:architecture/design-template`.
- Generated output must stay under the configured phase artifact directory.
- Locally edited output is never overwritten automatically.

To deliberately fetch a changed generated result:

```bash
singularity-flow agents refresh-output threat-model
# Add --replace only after deciding to discard local edits.
```

## 8. Approve or reject

Approve from another terminal:

```bash
singularity-flow approve WORK-123 --fetch
```

The command fetches the branch, asks for a persona, shows hashes/checks/usage/prior approvals, warns about self-approval, and requires typing the exact phase name.

Reject to an allowed earlier phase:

```bash
singularity-flow reject WORK-123 --fetch \
  --to requirements \
  --reason "Failure behavior is missing"
```

Approval authority comes from the selected persona. Accountability comes from the authenticated GitHub/Git identity. Multi-approval thresholds require distinct authenticated identities.

## 9. Resume from another terminal

```bash
git clone <application-repository-url>
cd <application-repository>
singularity-flow resume WORK-123 --fetch
```

Resume performs fetch plus fast-forward-only checkout and asks for a persona. It reconstructs the work item from committed branch state.

If a push previously failed:

```bash
singularity-flow sync
```

The existing local commit is retried; history is not rebased or rewritten.

## 10. Finish with verification and conformance

The final conformance artifact compares approved `AC-n` and `SPEC-nnn` identifiers with exact source and test evidence. Verdicts are `matched`, `partial`, `missing`, `deviated`, or `unplanned`.

```bash
singularity-flow progress WORK-123
singularity-flow report WORK-123
singularity-flow gate --terminal
```

The terminal gate verifies all phases, publication, artifact and approval hashes, input/agent provenance, traceability, conformance freshness, and remote branch state.

## Command map

| Goal | Copilot | Terminal |
|---|---|---|
| Start work | `/sflow-start WORK-123` | `singularity-flow start WORK-123` |
| Resume work | `/sflow-resume WORK-123` | `singularity-flow resume WORK-123 --fetch` |
| Get next actions | `/sflow-nextsteps` | `singularity-flow nextsteps` |
| Generate current phase | `/sflow-phase` | `singularity-flow prepare <phase>` |
| Inspect phase inputs | `/sflow-inputs <phase>` | `singularity-flow inputs <phase> --dry-run` |
| Publish generation | `/sflow-phase` | `singularity-flow phase publish <phase>` |
| Submit | `/sflow-submit` | `singularity-flow submit` |
| Approve | `/sflow-approve` | `singularity-flow approve WORK-123 --fetch` |
| Reject | `/sflow-reject` | `singularity-flow reject WORK-123 --fetch --to <phase> --reason <reason>` |
| Check completion | `/sflow-progress` | `singularity-flow progress WORK-123` |
| View performance | `/sflow-report` | `singularity-flow report WORK-123` |
| Read full help | `/sflow-help` | `singularity-flow help` |

## Operational checklist

Before starting:

- The application repository has committed `.singularity/` configuration.
- Git identity and the configured remote work.
- The Copilot plugin was reinstalled and the Copilot session restarted.
- The intended workflow profile and persona policies were reviewed.

Before approval:

- The generation commit is present on the remote work-item branch.
- Required quality checks passed.
- Input and remote-agent provenance warnings were reviewed.
- The reviewer selected an approval-capable persona.
- Any self-approval is understood to be non-independent review.

Before completion:

- Every phase is approved.
- Verification maps acceptance criteria to tests and source evidence.
- Conformance covers every `AC-n` and `SPEC-nnn`.
- `singularity-flow gate --terminal` passes.

## Where to get help

```bash
singularity-flow help
singularity-flow help approved-phase-inputs
singularity-flow help remote-agent-markdown
singularity-flow guide WORK-123
singularity-flow nextsteps WORK-123
```

The same manual is available through `/sflow-help` and the desktop **Help** page.
