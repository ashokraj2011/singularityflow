# Singularity Flow Help

Singularity Flow is a Git-native SDLC workflow for GitHub Copilot and engineering teams. It turns requirements, designs, implementation specifications, code, tests, approvals, and conformance evidence into durable branch state that another person or terminal can resume safely.

Use this manual in three places:

- Terminal: `singularity-flow help` or `singularity-flow help <topic>`
- GitHub Copilot CLI: `/sflow-help`
- Singularity Flow Desktop: open **Help** in the sidebar

The short command reference is available with `singularity-flow --help`.

For a visual end-to-end walkthrough with architecture, lifecycle, Git handoff, phase-input, and remote-agent diagrams, open `HOW-TO.md` in the repository.

## Desktop first-run onboarding

The desktop app opens a resumable five-step wizard the first time an operating-system user launches it:

1. Enter the name shown in planning and local desktop activity.
2. Select a role such as Product owner, Architect, Developer, QA, Designer, Security, Operations, or Delivery lead. This only suggests an initial planning persona; anyone can still select any configured persona.
3. Choose the local workspace directory used for isolated project workspaces and repository clones.
4. Add existing initialized Singularity repositories, or skip this optional step.
5. Connect Jira Cloud/Data Center, choose **We do not use Jira**, and review the ready summary.

Each step is saved locally and can be resumed after restarting the app. The workspace selection is resolved to a real, writable directory before it is saved. The profile is kept in Electron application data rather than Git. Jira tokens and PATs never enter the onboarding file: they are validated in Electron's main process and encrypted using the operating-system credential store. If that encrypted store becomes unreadable, the wizard and Jira workspace show an explicit reset action instead of trapping the user on a failed loading screen. Finishing a new setup always requires either a verified Jira connection or an explicit **We do not use Jira** decision. Selecting repositories does not clone, commit, push, or modify them. After setup, the first selected repository opens automatically; if none was selected, the welcome screen provides repository and workspace actions.

If the selected workspace is moved or deleted before setup finishes, the wizard
returns to **Local workspace** and asks for a replacement instead of trapping
Back/Continue navigation. Optional repositories that become unavailable are
removed with a visible notice; available selections remain intact. Future or
incompatible local profile formats recover to a reviewable first-run draft
rather than being interpreted as current settings.

Local onboarding, recent-repository, workspace-registry, and encrypted Jira
mutations are serialized and use unique atomic replacement files. Rapid or
overlapping desktop actions cannot overwrite another completed local update.
An unknown or malformed credential-store schema is never decrypted as if it
were current; use the visible reset action and reconnect.

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
git add singularity
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

## Multi-repository initiatives

Initiative orchestration is an opt-in layer above repository story workflows. `singularity/portfolio.yml` defines repositories, four- or seven-phase profiles, phase outputs, checklists, evidence assurance/freshness, authority groups, contracts, and gates. Repositories without this file retain existing behavior and make no initiative network calls.

Repository entries may include `metadata` with an `appId`, human-readable `name`, and any organization-specific scalar key/value pairs such as `owner`, `businessUnit`, `costCenter`, or `criticality`. Add these through **Initiatives → Portfolio designer → Add repository**. The app writes them beneath `repositories.<id>.metadata` in `singularity/portfolio.yml`; initiative snapshots, planning prompts, workspace manifests, and generated story seeds preserve the values.

If the file is missing, open **Initiatives** or **Jira workspace** in the desktop. The guided setup creates and validates the full editable starter portfolio, fills approval groups from the entered identity or current Git identity, optionally registers the first participating repository, and optionally adds an HTTPS Jira host/project/write policy. Credentials are never accepted into the YAML. The file stays uncommitted until **Commit & push**.

Operate an initiative inside GitHub Copilot:

```text
/sflow-initiative-start INIT-2026-001
/sflow-initiative-phase
/sflow-initiative-next
/sflow-initiative-status
/sflow-initiative-documents
/sflow-initiative-checklist
/sflow-initiative-evidence
/sflow-initiative-materialize
/sflow-initiative-approve
```

Start and approval use Copilot selectable options and one-time receipts when persistent terminal input is unavailable. Personas control prompt perspective; they never grant initiative approval authority. Authority comes from normalized local Git emails configured in `approvalAuthorities`, and reports label this `configured-local` rather than cryptographic identity.

`/sflow-initiative-phase` composes and records the complete governed Copilot prompt before generation. Its order is phase contract → selected persona prompt → required repository world-model views → active-agent remote skill Markdown → approved upstream initiative artifacts. `singularity-flow initiative context [PHASE]` prints that complete prompt; `--json` prints its hashes and provenance. With `worldModel.grounding: enforce`, publication is blocked when the prompt, world model, or an approved input is missing or changed.

For `kind: binary-bundle` outputs without a template, phase preparation prints the exact target as `awaiting upload`. Place the binary evidence at that path and run the phase command again to register its size and SHA-256 before publishing. Required missing bundles block publication with their expected paths. Downstream prompts include binary provenance, never decoded binary bytes.

Every generation, evidence record, approval, rejection, materialization, synchronization, and transition is committed and pushed to the exact initiative branch. Append-only evidence may replay after a concurrent append; approvals and lifecycle transitions always recompute against the new branch head.

The configured default branch is only the starting baseline for a new initiative or story branch. `initiative start` does not merge into `main`, and story materialization does not merge into a participating repository's default branch. Singularity Flow never automatically merges completed work; normal pull requests and repository policies remain in control.

Use `singularity-flow initiative materialize --dry-run` before creating story branches. The real operation requires exact initiative-ID confirmation. Story seeds recommend a work type and pin approved initiative inputs/contracts without bypassing the contributor’s interactive work-type and persona selection.

`singularity-flow initiative sync` reads each child workflow from its exact
fetched commit. Invalid JSON, unsupported state, or a Work ID/branch mismatch
marks only that story stale and blocked; other repositories continue
synchronizing. Initiative-lite Build and enterprise Construction require every
blocking story to reach verification. Initiative-lite Release and enterprise
Delivery require conformance.

Initiative phase approval is valid only for the exact current bundle hash.
Dependency invalidation rewinds the lifecycle to the earliest affected phase
and resets affected later phases without deleting artifacts or unrelated
approvals. Reports combine initiative and child telemetry and label cost exact
only when every observed source supplies provider cost.

## Copilot Planning Studio

Open **Planning Studio** in the Electron app after selecting an active initiative or story. It is a governed front end for the locally installed GitHub Copilot CLI, connected through the Agent Client Protocol (ACP) and explicitly placed in Copilot's native Plan mode.

Use the **Copilot** control in the desktop top bar to start or stop the repository-scoped ACP backend and inspect its state, process ID, version, mode, active planning attachment, and transient local service log. Planning turns reuse the running backend. Releasing or promoting a planning context leaves it ready; stopping it cancels an active turn. **Start Copilot Plan mode** starts it automatically when needed.

Start, Stop, and planning attachment are serialized so repeated clicks cannot create multiple backends or revive a process after Stop. Empty and overlapping follow-ups fail visibly. Releasing a context requires the active turn to finish or cancel successfully. If shutdown reports an error, use **Retry stop**; cleanup continues through pending questions, ACP session, connection, and child process even when one step fails.

Choose the current phase output, a persona, and the decision objective. **Build governed context** deterministically composes the phase contract, persona prompt, repository world model, active remote-agent skills, approved inputs, source requirement, current draft, and exact promotion target. It records source and prompt hashes in a private pack below `.git/singularity-flow/planning/` without changing Git state. Inspect the complete prompt before selecting **Start Copilot Plan mode**.

Use follow-up turns to compare alternatives, expose assumptions, refine acceptance criteria, create cross-repository story boundaries, define interface contracts, or improve delivery sequencing. The planning lens changes for discovery, design, product gate, inception, elaboration/specification, construction, and delivery/conformance work while the profile's configured phase contract remains authoritative.

Copilot conversation remains transient. Review and edit the complete proposed artifact in the adjacent panel. **Promote, commit & push** rechecks the branch HEAD, current phase, immutable target, input readiness, and target format; it then preserves managed metadata, stores the exact prompt/artifact/manifest audit bundle, and publishes one planning commit. It does not submit, approve, materialize stories, merge, or advance the phase.

Configure it in `singularity/workflow.yml`:

```yaml
planning:
  enabled: true
  promptSource: singularity/prompts/copilot-planning.md
  maxContextBytes: 1048576
```

The prompt is editable in **Prompts & skills**. The context limit may be 16 KiB through 10 MiB. Tool permission requests are rejected, renderer sandboxing remains enabled, and a plan file is read only when it remains inside the open repository. ACP model/token usage is displayed only when Copilot supplies exact values. See `PLANNING-STUDIO.md` for the complete architecture and walkthrough.

Singularity Desktop’s **Initiatives** page displays phase flow, delivery lanes, checklist assurance/freshness, story milestones, contracts, documents, elapsed time, models, tokens, and provider cost. Its Portfolio designer edits validated YAML; runtime state and repository world models remain read-only.

The **Singularity** workspace groups daily delivery into four focused views:

- **Artifact Studio** shows the phase sequence, generation and approval state, governed outputs, and the shared artifact repository.
- **Requirements** shows a repository document tree, full Markdown preview, Git metadata, and section outline; uploaded design packages and reference links remain attached to the selected work item.
- **Planning Copilot** builds a governed, hash-recorded context pack and invokes local GitHub Copilot in Plan mode before a reviewed artifact can be promoted.
- **Impact analysis** visualizes repositories and child stories, then reports committed context freshness and interface-contract integrity without inventing unobserved dependencies.

See `INITIATIVE-ORCHESTRATION.md` for the complete configuration, evidence, contract, materialization, and recovery guide.

## Jira-anchored project workspaces

A project workspace is a local isolation boundary around an existing Jira Epic
or higher-level Jira item. It is not another workflow phase, Jira issue type, or
portfolio level. Jira provides the configured issue-type hierarchy; the lead Git
branch stores governed initiative state; `workspace.json` stores only local
paths, clone URLs, and the selected lead repository.

In the desktop:

1. Open the governing lead repository.
2. Configure `singularity/portfolio.yml` and connect Jira.
3. Open **Project workspaces**.
4. Choose a storage folder and an Epic or higher Jira item.
5. Review the Jira hierarchy and repository clone plan.
6. Type the exact Jira key to create the isolated workspace.

Each selected repository is cloned separately below `repos/`. Fetch operations
skip dirty clones and never change a branch. Switching workspace stops the
previous Copilot backend and discards private planning handles before the new
lead repository becomes active.

If setup is interrupted, repeat creation with the same Jira key and unchanged
repository plan or select **Repair**. Missing clones resume and every attempt is
written to `logs/workspace-materialization.json`. A changed URL, branch, local
path, metadata set, required flag, or lead repository is refused at the same
target so stale configuration cannot be mistaken for a successful resume.
Recent locations use the canonical workspace path; `workspace.json` must be a
regular local manifest rather than a symlink.

Files placed in `documents/inbox/` are shown as **staged — not governed**.
On a resumed story branch with an active persona, **Import to work item** copies,
hashes, commits, and pushes a governed document. Initiative material instead uses
checklist-aware evidence registration so assurance and freshness are preserved.

Useful diagnostics:

```bash
singularity-flow workspace list
singularity-flow workspace status <DIRECTORY>
singularity-flow workspace sync <DIRECTORY>
singularity-flow workspace repair <DIRECTORY>
singularity-flow workspace documents <DIRECTORY>
```

For creation, offline provisioning, recovery, and safety details, open
`WORKSPACES.md`.

## How the workflow works

The repository owns the process in `singularity/workflow.yml`. A work type selects an ordered phase sequence. Each phase selects an artifact template, world-model views, write scope, quality checks, suggested personas, approval personas, threshold, and allowed rejection targets.

At work-item creation, Singularity Flow snapshots the selected work type, resolved phase contracts, configuration hash, and template hashes into:

```text
singularity/work-items/<WORK-ID>/workflow.json
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
2. Workflow template, such as feature, bugfix, chore, or Figma export to mobile app.
3. Persona for the current session.

The workflow and persona pickers are deliberately human-driven. There are no public `--type` or `--persona` bypass flags. Non-interactive start fails rather than silently choosing defaults unless `/sflow-start` supplies a valid one-time receipt containing the contributor's explicit Copilot choices.

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

For Jira Data Center, use a PAT instead of Cloud Basic authentication:

```bash
export JIRA_BASE_URL="https://jira.company.example"
export JIRA_DEPLOYMENT="data-center"
export JIRA_PAT="<personal-access-token>"
```

Connection and hierarchy commands:

```bash
singularity-flow jira status
singularity-flow jira projects
singularity-flow jira epics --project APP
singularity-flow jira children APP-100
singularity-flow jira permissions --project APP
```

The Electron **Jira workspace** is the preferred corporate setup. If no portfolio exists, its first screen is the guided `singularity/portfolio.yml` bootstrap; Jira sign-in is deliberately unavailable until governed repository policy has been created. Repository policy controls deployment, host/project allowlists, permitted authentication modes, cache duration, write operations, and owned fields. Every Jira route revalidates the repository-selected connection and project scope. Initiative adoption and write operations use the initiative's immutable policy snapshot rather than silently following later base-branch changes. The API token/PAT is validated and encrypted through Electron `safeStorage`; it is never returned to the renderer or low-level request callers, placed in Git, passed to CLI child processes, or included in Copilot context. Transport is pinned to relative paths under the configured Jira API base, redirects are rejected, and each attempt has a bounded timeout. Connection discovery makes at most one retry, so a broken URL, VPN, proxy, or firewall fails with a direct timeout message rather than leaving setup spinning. Issue searches follow Jira Cloud page tokens and Jira Data Center offsets up to the requested 500-issue ceiling; hierarchy capture therefore does not silently stop at the first 100 children.

Select an existing Epic, map each child to an owning repository, and choose an existing initiative. Preview then adopt it to create a committed source snapshot and `breakdown.yml` with separate Singularity Work IDs and Jira IDs. Outbound changes use a two-step flow:

```bash
singularity-flow initiative jira-plan
singularity-flow initiative jira-apply --plan <exact-sha256>
```

The plan is committed and pushed before review. Apply requires `jira.writeMode: approved`, an approved Plan/Elaboration phase, discovered Jira permissions, the exact plan hash, exact initiative-ID confirmation, and a plan that still matches the pinned connection, deployment, and project policy. Optimistic `updatedAt` checks reject stale updates. Operation receipts are committed and pushed; retry accepts a receipt only when its operation and reviewed plan hash still match. Status transitions, assignee, sprint, priority, and resolution are never writable through this connector.

## Manual intake and documents

Jira is optional. A manual YAML or JSON story can capture the audience, problem, desired outcome, scope, out-of-scope items, stakeholders, urgency, constraints, dependencies, acceptance criteria, risks, notes, and supporting documents.

Supporting files live under:

```text
singularity/work-items/<WORK-ID>/inputs/DOC-nnn/<filename>
```

List, inspect, or add documents:

```bash
singularity-flow documents list WORK-123
singularity-flow documents view DOC-001 --work-id WORK-123
singularity-flow documents upload ./brief.pdf ./wireframe.png
singularity-flow documents upload ./figma-export --kind figma-export
singularity-flow documents upload \
  --url https://www.figma.com/design/example \
  --label "Checkout design"
```

Each uploaded file receives a stable ID, content hash, MIME type, actor, persona, and phase. Directories are imported recursively in deterministic relative-path order, with symbolic links rejected. Upload is allowed only during the initial phases configured by the selected profile. Local files are copied and pushed; external Figma or reference URLs are cataloged without being downloaded.

For a tab-like browser inside a canvas-capable Copilot host, enable experimental features, start a fresh session, and invoke the bundled extension:

```text
/experimental on
/documents
/documents view PHASE-DESIGN
```

The canvas separates generated artifacts, uploaded inputs, and workflow documents, with search and full text previews. It embeds a fresh snapshot directly in the canvas; run `/documents` again after generating or uploading files to reload it. If the host cannot render canvases, `/documents` falls back to deterministic terminal list/view output. This extension cannot add a fifth built-in Copilot home tab because that UI surface is not exposed to plugins.

Use `/sflow-documents` for the model-assisted upload workflow or the **Documents** page in the desktop app.

The desktop previews committed PNG/JPEG/GIF/WebP files and PDFs without network access, verifies their bytes against the recorded SHA-256, and refuses files that escape the work-item directory or have changed since registration. The Figma-mobile review screen compares the pinned design export with registered implementation and diff screenshots in side-by-side, overlay-slider, and diff-highlight modes. A Figma URL opens in the normal browser and is labeled live/mutable; it is never the approval baseline.

## Work types and phases

Starter work types are:

| Work type | Phase sequence |
|---|---|
| Feature | intake → requirements → design → implementation-spec → implementation → verification → conformance |
| Bugfix | intake → reproduction → fix-design → fix-spec → implementation → verification → conformance |
| Chore | intake → implementation → verification → conformance |
| Figma export to mobile app | design-intake → design-inventory → component-mapping → mobile-spec → implementation → visual-verification → conformance |

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

### Copilot multi-user session hook

Repositories may make Git-backed work-item and persona selection part of Copilot session startup:

```yaml
session:
  workItemSelection: prompt # off | reuse | prompt
  personaSelection: prompt # off | reuse | prompt
  promptOnNewSession: true
  promptOnResume: false
  requireBeforeTools: true
```

For work items, `off` preserves the current-branch behavior, `reuse` accepts an active work-item branch but asks when none is active, and `prompt` asks once for every distinct Copilot session ID. `/sflow-session` shows remote candidates and asks for an exact work ID or Jira ID. It then runs the equivalent of:

```bash
singularity-flow session candidates
singularity-flow session attach WORK-123
```

`candidates` fetches the configured remote and lists only branches containing a valid workflow at the expected work-item path. `attach` requires a clean tree, fetches again, checks out the exact existing local or remote branch, fast-forwards to the remote head, verifies the commit hashes are identical, and loads workflow state from that branch. A missing local branch becomes a tracking branch from Git. A missing remote branch is never created implicitly; use `/sflow-start` for new work.

Dirty, ahead, diverged, missing, or malformed state stops without history rewriting or data loss. If a pre-existing local work branch is ahead or diverged, it may remain checked out so the contributor can preserve or publish it. Singularity Flow never merges, rebases, resets, stashes, force-checks out, or deletes work during session attachment. Copilot must start inside a clone of the application repository so the configured remote is available.

Persona `off`, `reuse`, and `prompt` retain their existing meanings. `requireBeforeTools` denies mutating Copilot tools until both work-item and persona selection are complete; session status, candidate discovery, attachment, and persona selection remain available so the guard cannot deadlock initialization.

The binding is stored only under `.git/singularity-flow/` and creates no commit. It records the Copilot session ID and selected work item separately from the authenticated Git identity. Anyone may still choose any configured persona, and `/sflow-persona` can change it during the session. Run `singularity-flow session status` to inspect `workItemSelectionRequired`, `selectionRequired`, and `ready`. The policy is snapshotted into the work item at creation. If `session` is absent, both selections resolve to `off` for backward compatibility.

Persona suggestions are not restrictions. Anyone may choose any configured persona for any phase. Approval authority comes from the selected persona's `mayApprove` list, while accountability comes from the authenticated GitHub or Git identity.

Start and resume ask for a persona. The active session is local:

```text
.git/singularity-flow/session.json
```

Selecting a persona alone does not create a commit. The next generation, submission, approval, rejection, or document upload records the actor and persona.

Copilot uses its interactive `ask_user` facility for intake source, workflow,
and persona choices. The choices are read from the CLI's live YAML-derived menu,
so custom work types and personas appear automatically. With persistent terminal
stdin, the skill sends the selected menu number back to the same CLI process. If
that bridge is unavailable during start or approval, it records the exact `ask_user` answers
in a 15-minute one-time receipt under the Git directory and passes only its token
to the lifecycle command. Approval receipts additionally pin the submitted phase,
generation, and artifact hashes and require the reviewer to type the exact phase
ID. The receipt is bound to the work ID, repository HEAD, and Copilot session when
available, and is consumed once. Concurrent answer processes are serialized by
a short-lived local lock; schema, filename token, repository HEAD, and expiry
timestamps are revalidated on every read. The skill never invents a default or
uses hidden `--type`/`--persona` flags. If `ask_user` is disabled, it stops.

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
singularity/work-items/<WORK-ID>/artifacts/<phase>/
```

Publishing validates write scope, artifact requirements, hashes, traceability, and protected paths. It adds managed metadata, commits `[WORK-ID][phase:<id>][generated:<n>]`, and pushes the branch. Submission runs configured quality checks and creates its own atomic commit and push.

Artifact-only phases cannot modify application source. Implementation and verification may modify source only when their configured write scope permits it.

## Sequence enforcement

Sequence enforcement is configurable gate by gate.

Lifecycle mutations normally follow the configured order:

```text
prepare/edit → publish generation → submit → approve or reject
```

Each sequence guard is configured as `hard` or `soft` in `singularity/workflow.yml`. A missing `sequenceGates` section means every gate is `hard`, preserving existing repository behavior. Global values may be overridden for a work type. The fully resolved policy is snapshotted at work-item creation, so changing the base branch configuration does not alter an active item.

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

Use `/sflow-inbox` or `singularity-flow inbox` before choosing a work item when reviewing across a team. It fetches the configured remote and lists only valid committed work-item branches whose current phase is `awaiting_approval`, oldest first. Each row includes the work/Jira ID, phase, generation, approvals received/required, waiting time, reviewer personas, artifact path, self-approval warning, and remote commit. `singularity-flow inbox --offline` reads cached remote refs without network access.

Selecting an inbox item invokes the existing safe session attachment path. The branch must fast-forward exactly to the fetched remote commit; dirty, ahead, diverged, malformed, or missing states stop without merging, rebasing, resetting, stashing, or discarding work. The reviewer then selects a persona and sees the complete generated documents before separately choosing approval or rejection. The inbox itself is read-only and never approves automatically.

Approve from a terminal:

```bash
singularity-flow approve WORK-123 --fetch
```

The command fetches the branch, asks for a persona, displays hashes, checks, token usage, prior approvals, and any self-approval warning, then requires explicit phase confirmation. If Copilot cannot write to a persistent shell, `/sflow-approve` issues a 15-minute receipt after fetching, asks for the approval-capable persona and exact typed phase ID, then invokes `approve --selection-receipt` itself. The CLI revalidates the branch HEAD, submitted generation, artifact hashes, identity threshold, and receipt before committing and pushing the decision.

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

Durations are wall-clock time and include nights and weekends. They are not business-hours or productivity estimates. Token counts are exact only when the provider supplied them. Reports prefer exact provider cost captured by Copilot telemetry and fall back to configured model pricing; incomplete coverage is marked partial.

Use `/sflow-report` in Copilot.

## Token usage and optional cost

Installer-managed Copilot sessions are captured automatically from phase preparation onward. Copilot writes the current chat span only after its response finishes, so publication can initially show `pending`. The next `submit` or `/sflow-next` action reconciles that completed span in a separate commit and push before submission. Raw traces remain inside the repository Git directory, while each generation commits a sanitized record at:

```text
singularity/work-items/<WORK-ID>/telemetry/<phase>-gen<N>.json
```

The committed record excludes prompt/response content, conversation identifiers, and raw traces. For another provider, save exact usage as JSON and publish with:

```bash
singularity-flow phase publish implementation --usage-json usage.json
```

The usage record may contain provider, model, input, output, cached-input and total tokens, timestamps, provider cost, and collection source. Missing values are recorded as `unavailable`; they are never estimated silently. Markdown, HTML, and JSON reports identify the models used per phase and aggregate records and tokens by provider/model. Exact provider cost is used when present; configured per-model pricing is the fallback.

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

Use `singularity-flow telemetry status` to see whether the current Copilot process inherited the repository file exporter, the raw-file path and size, completed chat spans, and pending generations. Use `singularity-flow telemetry reconcile [PHASE]` to retry a delayed generation explicitly. Reconciliation commits and pushes only the sanitized record, never the raw trace.

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
  # Governed view IDs. A view cannot be removed while a phase, persona,
  # workflow override, injection rule, or Markdown prompt still references it.
  views: [business, architecture, development, testing, release, operations, security]
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
`singularity/work-items/<WORK-ID>/context/<phase>-gen<n>.json` with the persona,
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

First trust and every `--update` display hashes and require typing the exact agent name. The committed `singularity/agents.lock.yml` pins agent-file and dependency hashes. Sync never updates trust: it verifies the lock, writes an atomic cache under `.git/singularity-flow/`, and records the active agent while preserving the selected persona. No authentication, cookies, or bearer tokens are sent.

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

Edit `singularity/workflow.yml` directly or use Singularity Flow Desktop. The definition controls:

- `workTypes`: phase sequences and profile overrides
- `inputsMode`: off, warning/audit recording, or enforced approved-artifact dataflow
- `phases`: artifact contracts, approved inputs, write scope, views, checks, and approvals
- `personas`: prompts, views, suggested phases, and approval capability
- repository agent Markdown and `singularity/agents.lock.yml`: optional trust-pinned remote prompt/template/output sources
- `documents`: allowed upload phases and size limits
- `git`: remote and publication policy
- `tokens`: exact-or-unavailable mode and optional pricing
- `governance`: protected paths and traceability rules

Template resolution is work-type override, then phase default, then configuration error. Keep templates in `singularity/templates/` and persona prompts in `singularity/personas/`.

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

Create a production renderer build with `npm run desktop:build`. Package the current host with `npm run desktop:package:current`, a universal Mac DMG with `npm run desktop:package:mac`, or a Windows x64 NSIS executable with `npm run desktop:package:win`. `npm run desktop:dist` remains a current-host compatibility alias.

Local packages are written below `apps/desktop/release/local/<version>/` and are visibly labelled `-unsigned` when signing credentials are unavailable. Official packages require Apple Developer ID signing plus notarization on macOS and Authenticode signing on Windows. The GitHub desktop-release workflow verifies both native builds and creates a draft release for human publication. Use `npm run desktop:verify -- --dir <directory>` to recheck a package, or `npm run desktop:publish:artifactory -- --dir <official-directory> --dry-run` to preview internal publication. Complete credential, installation, silent-uninstall, checksum, and Artifactory instructions are in `DISTRIBUTION.md`; the file is bundled with the desktop CLI resources. Installing the desktop does not install the global CLI or Copilot plugin.

The desktop app provides:

- Overview and progress dashboard with committed AI cost, exact-token, provider/model, phase-spend, and pricing-coverage views
- Visual workflow profiles: create a profile by copying an existing workflow, rename it, or remove it
- Stage designer: create stages, add shared stages, reorder or remove them, and select upstream artifact inputs
- Artifact contracts: configure each stage's output path, kind, minimum size, write scope, template, quality commands, personas, approvals, and world-model views
- Persona creation, editing, prompt selection, phase recommendations, and approval-capability design
- Artifact-template library with guided creation, source/preview editing, and safe deletion when unreferenced
- Repository prompt and skill Markdown editors, including guided repository-skill creation
- Repository agent Markdown editor and read-only remote lock status
- A repository-only world-model control plane with a governed view registry, editable builder prompt, dependency references, and downloadable generated views
- Individual YAML/Markdown downloads plus a portable configuration-folder export
- Supporting-document catalog and upload
- Searchable help manual
- Validated configuration save, commit, and push

Open an initialized repository. The desktop is a control plane over the same CLI and Git state; it does not maintain a second workflow database. Renderer sandboxing, context isolation, and a narrow preload API keep filesystem and Git access outside the UI.

The welcome screen remembers up to ten repository locations in local Electron application data. Select any available recent repository to reopen it, use the repository card in the sidebar to switch locations, or remove stale history entries. This list is local UI history only: it is never committed and removing an entry does not delete or change the repository.

Select a work item and open **Overview** to see total elapsed, active, and approval-wait time plus the wall-clock breakdown for every phase. These durations include nights and weekends. The cost dashboard prefers provider-reported cost from committed phase telemetry and falls back to exact model-name prices under `tokens.pricing`. Phase and model breakdowns show tokens, priced-record coverage, and whether each amount came from the provider or configured pricing. Exact, partial, and unavailable states are visibly distinct. When coverage is missing, the dashboard checks repository capture health and explains whether Copilot telemetry was inactive, the installed wrapper is outdated, an export is pending, exact token components are missing, or a matching model price is needed. It never displays an invented estimate or treats unavailable cost as zero. Past turns cannot be reconstructed when Copilot produced no raw telemetry; rerun `install.sh`, fully exit Copilot, and start a new session for future capture.

Use **Workflow** for the visual designer. Changes update the YAML draft shown beside it, so advanced users can inspect or refine the exact source before selecting **Save**. The save operation validates profile IDs, stage order, artifact paths, templates, personas, inputs, and approval capabilities atomically. Use **Artifact templates** to create the Markdown structure first, then return to **Workflow** and assign it to a stage. Template deletion is refused while any default or workflow override still references it.

Use **Prompts & skills** for repository persona prompts, the world-model builder prompt, and repository-specific Copilot skills under `.github/skills/<id>/SKILL.md`. Use **Agents & remote Markdown** for repository agent files and their explicit remote skill/template/output tables. Installed plugin skills remain product defaults; repository skills and agents are the portable project overrides.

Use **Repository world model** to manage the declared view registry, edit or import the builder prompt in place, and inspect or download generated grounding files. Each view shows every structured dependency (phase, persona, workflow override, or injection rule) and each Markdown file containing an explicit `views/<id>.md` reference. The **Remove** action stays disabled until those references are removed. Manual YAML or prompt edits receive the same validation; invalid saves are rolled back atomically.

World-model content is never imported from an agent or remote URL: it is built from the open repository and remains read-only in the desktop. Select **Download config** to export the workflow YAML, artifact templates, prompts, repository skills, repository agents, and current world-model snapshots as an ordinary folder tree. Imports accept `.yml`, `.yaml`, and `.md` files and stay uncommitted until **Commit & push**.

## Copilot commands

All public skills use the collision-safe `sflow-` prefix:

| Copilot command | Purpose |
|---|---|
| `/sflow-about` | Explain the Singularity Flow brand, installed version, capabilities, and command namespace |
| `/sflow-start` | Guided Jira or manual intake, workflow selection, and persona selection |
| `/sflow-resume` | Fetch, fast-forward, and select a persona |
| `/sflow-persona` | Select or change the persona for the current local work-item session |
| `/sflow-session` | Select a work/Jira ID, synchronize its remote branch, then bind the session persona |
| `/sflow-inbox` | Fetch pending approvals across committed remote work-item branches and open a selected review safely |
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
| `/sflow-jira-initiative` | Browse Epics, adopt child stories into an initiative, and prepare reviewed Jira write plans |
| `/sflow-workflow-rules` | Explain deterministic workflow rules |

If commands do not appear, run `singularity-flow plugin install`, close existing Copilot sessions, start a new session, and check `copilot skill list`.

## Installation and company registries

From a clean clone, the supported local update/install workflow is:

```bash
./install.sh
```

`npm run install:local` invokes the same script.

It performs a fast-forward-only pull, asks for the npm registry, installs locked dependencies, builds the desktop renderer, runs tests and checks, creates the tarball, replaces the global CLI, removes old plugin identities, installs the current marketplace plugin, and enables the metadata-only Copilot OpenTelemetry file exporter in the active shell profile. Raw telemetry stays at `<git-dir>/singularity-flow/copilot-otel.jsonl`; prompt and response content capture remains disabled. Publication commits sanitized phase summaries under `singularity/work-items/<WORK-ID>/telemetry/` for Git state transfer.

For a company Artifactory or registry:

```bash
./install.sh --registry https://artifacts.company.com/artifactory/api/npm/npm-virtual/
```

Or set `SINGULARITY_FLOW_NPM_REGISTRY`. Authentication remains in `.npmrc`; do not embed credentials or tokens in the URL. The installer rejects dirty checkouts and never resets, rebases, or force-pushes.

If Copilot telemetry is managed centrally, opt out of the local file exporter:

```bash
./install.sh --no-copilot-telemetry
# or
SINGULARITY_FLOW_COPILOT_TELEMETRY=off ./install.sh
```

The generated shell entry does not override an existing `COPILOT_OTEL_FILE_EXPORTER_PATH`, `OTEL_EXPORTER_OTLP_ENDPOINT`, or explicit `COPILOT_OTEL_ENABLED` setting. Fully exit any currently running Copilot CLI process, open a new terminal in the repository, verify `type copilot`, and start a new session. An existing process cannot inherit newly installed environment variables.

## Low-friction cockpit, diagnostics, and guided execution

Run `singularity-flow` with no arguments, or `singularity-flow cockpit`, to open the terminal cockpit. It shows the current work item, persona, assignment, progress, current phase, blockers, and deterministic next actions without changing state. In Copilot use `/sflow-home`.

```bash
singularity-flow doctor
singularity-flow doctor WORK-123 --offline
singularity-flow run --task "Implement the approved screen contract"
```

Doctor checks Node and Git, YAML and workflow state, local persona, assignment policy, pending publication, working-tree safety, upstream configuration, and remote reachability. Guided execution may prepare grounding/artifacts or offer submission, but always stops for authoring and approval. It never assumes an approval persona and never approves automatically.

## Workflow catalog and preflight simulation

```bash
singularity-flow workflow list
singularity-flow workflow simulate figma-mobile
singularity-flow workflow diff figma-mobile
singularity-flow workflow add figma-mobile --dry-run
```

`workflow add` copies the profile plus missing Markdown templates/persona prompts and validates the resulting YAML. Customized profiles are never overwritten unless `--replace` is explicit. Changes remain uncommitted for normal configuration review. Active work items keep their immutable resolution snapshots.

## Review bundles, assignments, and watching

```bash
singularity-flow review design
singularity-flow review design --format html --out singularity/reviews/WORK-123-design.html
singularity-flow assign design "mobile-team"
singularity-flow watch WORK-123 --once
```

The review bundle contains the artifact in full, input provenance, checks, approvals/self-approval warnings, model/token records, source changes, and supporting evidence. The desktop **Review bundle** page renders the same data. Assignments are committed/pushed coordination metadata, not persona restrictions. Configure `collaboration.assignmentMode` as `off`, `suggested`, or `required`; required assignments block publication and submission.

## Design package inventory and gallery

`singularity-flow documents upload ./figma-export` recursively preserves paths and hashes and creates committed `PKG-nnn` package records with `manifest.json`, `inventory.md`, and a local `gallery.html`. The inventory reports types, sizes, empty files, and duplicate hashes. The desktop Documents page has separate file and folder actions.

## Safe recovery and Copilot session guidance

```bash
singularity-flow recover WORK-123 --fetch
singularity-flow recover WORK-123 --fetch --apply
```

Recovery is plan-first. Apply only retries retained publication or performs a clean fast-forward; it never resets, rebases, force-pushes, stashes, or discards work. The bundled Copilot `sessionStart` command hook records local session context and applies the immutable work-item/persona policy; it does not change committed workflow state and never approves. A prompt hook opens `/sflow-session` in new interactive sessions, and the optional `preToolUse` guard holds mutating tools until the chosen remote branch is synchronized and required persona selection is complete.

## Troubleshooting

### Copilot plugin is installed but commands are missing

Run:

```bash
singularity-flow plugin install
copilot plugin list
copilot skill list
```

Only `singularity-flow@singularity-flow` should remain. Close existing Copilot sessions because sessions do not always reload newly installed skills.

### Start or approval says an interactive terminal is required

Updated `/sflow-start` and `/sflow-approve` skills keep you inside Copilot even when `write_bash` or persistent stdin is unavailable. Start uses `singularity-flow choices begin start <WORK-ID> --json`; approval uses `singularity-flow choices begin approve <WORK-ID> --fetch --json`. Each asks you for the returned choices and invokes the lifecycle command with a one-time receipt. If an installed skill still directs you to a terminal immediately, update the repository, run `./install.sh`, open a new terminal, and start a new Copilot session so the refreshed skill is loaded. Raw non-interactive start or approval without either a TTY or a valid receipt still fails safely.

Resume, persona switching, and rejection continue to require their interactive picker when invoked without a dedicated UI bridge; they never reuse a start or approval receipt.

### A transition is blocked after push failure

The local lifecycle commit is intentionally retained. Fix remote access, then run `singularity-flow sync`. Do not rewrite or force-push the branch.

### Artifact-only phase reports source changes

Move source changes to implementation or verification. Intake, requirements, design, and specification phases normally permit only their phase artifact and managed state.

### Approval persona is rejected

Select a persona listed by the phase approval policy and confirm that persona lists the phase in `mayApprove`. Persona suggestions do not grant approval authority by themselves.

### Jira fields are empty or wrong

Use `singularity-flow jira fields --query <name>` against the Jira site and configure the returned custom-field IDs in the documented environment variables.

### Report token or cost values are unavailable

Run `singularity-flow telemetry status`. If it says the exporter is not active, fully exit Copilot, open a new terminal in the repository, verify `type copilot`, and start a new Copilot session. If a generation is pending, finish the current Copilot response and let the next `submit` or `/sflow-next` reconcile it, or run `singularity-flow telemetry reconcile <PHASE>` explicitly. Older turns created before telemetry was enabled cannot be reconstructed. If token data exists but cost does not, the provider did not expose exact cost or the exact model name has no configured price. Singularity Flow does not estimate these values.

### Desktop cannot open a repository

Confirm the directory is a Git repository and contains `singularity/workflow.yml`. If Singularity Desktop finds the former `.singularity/` or `.sdlc/` control folder, it offers a guarded migration before opening the repository. The migration changes only the current branch working tree; review the rename and use **Commit & push** when ready. It never merges into `main`. For a repository with no control folder, run `singularity-flow init` and commit the initialized files first.

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
singularity-flow run [--task TEXT] [--yes]
singularity-flow cockpit
singularity-flow doctor [WORK-ID] [--offline] [--json]
singularity-flow review [PHASE] [--format md|html|json] [--out FILE]
singularity-flow workflow list|simulate|diff|add|upgrade
singularity-flow assign <PHASE> <ASSIGNEE>
singularity-flow watch [WORK-ID] [--once] [--fetch] [--interval SECONDS]
singularity-flow recover [WORK-ID] [--fetch] [--apply]
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
singularity-flow telemetry status [--json]
singularity-flow telemetry reconcile [PHASE] [--json]
singularity-flow documents list [WORK-ID] [--json]
singularity-flow documents view <DOCUMENT-ID|PATH> [--work-id ID]
singularity-flow documents upload <FILE-OR-DIRECTORY...> [--url URL]
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
singularity-flow desktop snapshot|validate|save|delete-template|publish|session
```

Run `singularity-flow --help` for the current terse usage list and `singularity-flow help <topic>` for one section of this manual.
