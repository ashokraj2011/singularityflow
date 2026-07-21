# Singularity Flow Lite 0.6

Singularity Flow Lite is a Git-native SDLC workflow for GitHub Copilot. A repository-owned YAML file defines work types, phase sequences, artifact templates, personas, world-model views, approvals, and publication policy. Generated artifacts and lifecycle decisions are committed to a work-item branch and pushed after every operation, so another terminal can safely resume from Git. Its Copilot skills use the collision-safe `sflow-` prefix.

The package contains:

- A deterministic Node.js CLI (`singularity-flow` or `sflow`).
- A secure Electron desktop studio for visual workflow, persona, approval, template, progress, and document management.
- A skills-only GitHub Copilot plugin.
- Editable feature, bugfix, and chore profiles.
- Editable persona prompts and artifact templates.
- World-model grounding, approval auditing, token accounting, and a final spec-to-code conformance gate.

## Requirements

- Node.js 20 or newer.
- Git with a configured identity.
- A Git remote when `git.publish: required` is configured.
- GitHub CLI authentication is recommended so lifecycle events can record the authenticated GitHub login as well as Git identity.

## Install and initialize

```bash
npm install --global ./singularity-flow-0.6.1.tgz
cd your-repository
singularity-flow init
git add .singularity
git commit -m "Initialize Singularity Flow"
git push
```

Initialization installs:

```text
.singularity/
├── workflow.yml
├── personas/
│   ├── architect.md
│   ├── developer.md
│   ├── product-owner.md
│   └── qa.md
├── prompts/
│   └── worldmodel-builder.md
└── templates/
    ├── common/
    ├── feature/
    ├── bugfix/
    └── chore/
```

These files are ordinary reviewed repository files and remain fully editable.

## Configuration

`.singularity/workflow.yml` is the definition for new work items. It contains:

- `workTypes`: profile-specific phase sequences, template overrides, and optional `phaseOverrides` for checks, world-model, comparison, artifact, and approval policy.
- `phases`: default templates, artifact paths, write scope, world-model views, quality commands, and approval rules.
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

Persona-to-phase mappings are suggestions, not restrictions. Any contributor may select any configured persona. Approval authority comes from the selected persona's `mayApprove` list.

## Start and resume

```bash
singularity-flow start ENG-142 --title "Add invoice export" --fetch
singularity-flow resume ENG-142 --fetch
```

`start` always prompts for a work type and persona. `resume` always prompts for a persona. There are deliberately no public `--type` or `--persona` bypass flags, and a non-interactive invocation fails clearly. The active persona is stored locally in `.git/singularity-flow/session.json`; opening a session does not create a repository commit.

On another terminal, `resume --fetch` fetches and fast-forwards the work-item branch. Committed branch state is the handoff protocol; the local session file is not part of it.

## Progress

```bash
singularity-flow progress ENG-142
singularity-flow progress ENG-142 --json
```

Progress is based on approved phases, so it is deterministic: `approved phases / total phases`. The command shows a progress bar, percentage, current phase and position, generation count, approvals received/required, uploaded-document count, and token usage. It never guesses partial completion inside an unapproved phase.

## Supporting documents and designs

Supporting inputs are managed under `.singularity/work-items/<WORK-ID>/inputs/` and cataloged in `documents.json`. Uploads are allowed only in the initial phases configured by `documents.allowedPhases`; the starter profile allows intake, requirements/design/specification, and the corresponding bugfix phases.

```bash
# Local documents, screenshots, PDFs, .fig files, or other binary files
singularity-flow documents upload ./brief.pdf ./checkout-wireframe.png

# External Figma or design link (recorded, not downloaded)
singularity-flow documents upload \
  --url https://www.figma.com/design/example \
  --label "Checkout design"

singularity-flow documents list
singularity-flow documents view DOC-001
```

Every uploaded file receives a stable `DOC-nnn` identifier, content hash, MIME type, original filename, phase, actor, and persona. Upload creates and pushes an atomic work-item commit. Text formats can be displayed directly; images, PDFs, `.fig`, and other binary files return an absolute path for the appropriate viewer. The catalog also lists generated phase artifacts, status, source context, and Jira user-story documents.

## Generate a phase

Copilot users normally invoke the appropriate skill, for example:

```text
/sflow-phase
```

The skill combines the configured phase prompt, the selected persona prompt, and routed world-model context. The equivalent deterministic CLI sequence is:

```bash
singularity-flow prepare intake
# Fill the generated template.
singularity-flow phase publish intake
singularity-flow submit
```

`phase publish` validates phase write scope and the required artifact, adds managed metadata, updates state, commits `[WORK-ID][phase:<id>][generated:<n>]`, and pushes the work-item branch. Submission and every later decision are separate atomic commit-and-push operations.

Artifacts live under:

```text
.singularity/work-items/<WORK-ID>/artifacts/<phase>/
.singularity/work-items/<WORK-ID>/inputs/DOC-nnn/<filename>
```

Managed metadata records the work type, phase, generation, actor, persona, source/config/template hashes, token usage, commit information, and approval history. Do not edit `workflow.json`, `STATUS.md`, approval records, or the managed metadata block manually.

## Token usage

If a provider exposes exact usage, pass it when publishing:

```bash
singularity-flow phase publish implementation --usage-json usage.json
```

The JSON may contain provider, model, input, output, cached-input, total tokens, start/end timestamps, and collection source. When Copilot does not expose exact values, the record is explicitly marked `unavailable`; the CLI never estimates silently. Status and state aggregate usage by phase, persona, work type, and work item.

## Approval and rejection

From a terminal:

```bash
singularity-flow approve ENG-142 --fetch
singularity-flow reject ENG-142 --fetch --to requirements --reason "Failure behavior is missing"
```

Approval prompts for a persona, shows artifact hashes, checks, token usage, prior approvals, and any self-approval warning, then requires the phase name as confirmation. Multi-approval thresholds require distinct authenticated identities.

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
singularity-flow wm context design --concat
singularity-flow wm check
```

Phase views provide required grounding. Persona views add perspective without removing phase-required views. Verification and conformance also load the evidence ledger. The selected persona prompt is included in the generated context.

## Useful commands

| Command | Purpose |
|---|---|
| `singularity-flow init` | Install editable YAML, templates, persona prompts, and world-model builder prompt. |
| `singularity-flow start <ID>` | Interactively choose work type/persona and create/push the work branch. |
| `singularity-flow resume <ID> --fetch` | Fast-forward the branch and select a persona for this terminal. |
| `singularity-flow status [ID]` | Show phase, persona, artifacts, approvals, usage, and warnings. |
| `singularity-flow progress [ID]` | Show deterministic completion percentage and phase/approval progress. |
| `singularity-flow documents list [ID]` | List uploaded inputs and generated workflow documents. |
| `singularity-flow documents view <ID>` | Display text content or return the path/URL for a binary/external document. |
| `singularity-flow documents upload <PATH...>` | Copy, hash, catalog, commit, and push supporting files during configured initial phases. |
| `singularity-flow prepare [PHASE]` | Materialize the resolved artifact template. |
| `singularity-flow phase publish [PHASE]` | Validate, annotate, commit, and push one generation. |
| `singularity-flow submit` | Run checks and publish an approval request. |
| `singularity-flow approve [ID] --fetch` | Select an approval persona and record/push the decision. |
| `singularity-flow reject [ID] --fetch --to PHASE --reason TEXT` | Reject, reopen, invalidate downstream state, commit, and push. |
| `singularity-flow sync` | Retry a pending publication without rewriting the commit. |
| `singularity-flow gate --terminal` | Run the final deterministic/remote-state gate. |
| `singularity-flow migrate-config` | Convert legacy JSON configuration and work-item state without rewriting history. |

## Migration

From a repository using `.singularity/config.json`:

```bash
singularity-flow migrate-config
git add .singularity/workflow.yml .singularity/templates .singularity/personas .singularity/work-items
git commit -m "Migrate Singularity Flow configuration"
git push
```

The legacy JSON is preserved for audit and existing Git history is not rewritten. See [MIGRATION.md](MIGRATION.md).

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
npm run desktop:dist
```

Open an initialized repository from the app. The studio provides a progress dashboard, visual phase graph, persona and approval-rule inspection, validated YAML editing, artifact-template source/preview, supporting-document upload/view, persona selection, and configuration commit/push. Renderer sandboxing and a narrow preload API keep filesystem, Git, and CLI access outside the UI process.

Install the personal Copilot plugin with:

```bash
singularity-flow plugin install
copilot skill list
```

The installer registers the official `ashokraj2011/singularityflow` marketplace and installs `singularity-flow@singularity-flow`. The equivalent manual commands are:

```bash
copilot plugin marketplace add ashokraj2011/singularityflow
copilot plugin install singularity-flow@singularity-flow
```

The plugin package remains named `singularity-flow`, while every public skill has a globally unique command name:

```text
/sflow-start ENG-142 --title "Add invoice export"
/sflow-phase
/sflow-progress
/sflow-documents list
/sflow-status
/sflow-submit
/sflow-approve
/sflow-reject
/sflow-resume ENG-142
```

The `sflow-` prefix prevents collisions with generic skills such as `/start`, `/status`, and `/approve` from other plugins. After upgrading from v0.6.0, reinstall the plugin with `singularity-flow plugin install --force`, close existing Copilot sessions, and confirm that `copilot skill list` reports the `sflow-*` skills.

See [ARCHITECTURE.md](ARCHITECTURE.md) for invariants and [VERIFICATION.md](VERIFICATION.md) for the release checklist.
