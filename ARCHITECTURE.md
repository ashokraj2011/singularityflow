# Singularity Flow Lite architecture

## System boundary

Singularity Flow separates probabilistic generation from deterministic lifecycle control:

```mermaid
flowchart LR
  U["Contributor in Copilot or terminal"] --> S["Phase skill + selected persona"]
  S --> W["Routed world-model context"]
  S --> A["Artifact template"]
  A --> C["Deterministic CLI"]
  C --> V["Validate metadata, state, and checks"]
  V --> G["Atomic Git commit"]
  G --> R["Fast-forward push to work branch"]
  R --> O["Another terminal or GitHub decision"]
```

Skills generate content; the CLI alone owns `workflow.json`, `STATUS.md`, managed metadata, approval records, state transitions, commits, and publication.

## Repository definition and immutable resolution

`.singularity/workflow.yml` is the editable definition for new work. It declares work types, phases, templates, personas, world-model routing, approval policies, Git publication, and protected paths.

At work-item creation the CLI resolves:

1. The selected work type and its phase sequence.
2. Work-type overrides over phase defaults.
3. Every phase artifact/template path.
4. Applicable checks, views, comparison, and approval policy.
5. Configuration and template SHA-256 hashes.

This resolution is copied into `.singularity/work-items/<ID>/workflow.json`. The selected work type and snapshot are immutable. Active work therefore follows the definition committed on its branch even if the base branch later evolves.

## Persona session and prompt composition

`start` first selects Jira or manual intake, captures the story and supporting documents, and then selects a workflow template and persona; `resume` selects a persona. Selection requires an interactive terminal unless explicit Jira/manual source inputs were supplied, but template and persona selection are never bypassed. The session lives at `.git/singularity-flow/session.json` and is intentionally local and uncommitted.

For generation, context is additive:

```text
phase instructions
+ persona prompt
+ phase-required world-model views
+ persona world-model views
+ evidence ledger for verification/conformance
```

Suggested personas improve discoverability but do not authorize phase access. Any contributor may assume any configured persona. A persona's `mayApprove` list provides decision authority.

## Work-item layout

```text
.singularity/work-items/ENG-142/
├── workflow.json
├── STATUS.md
├── source.json
├── USER-STORY.md
├── documents.json
├── inputs/
│   └── DOC-001/<original-file>
├── artifacts/
│   ├── intake/intake.md
│   ├── implementation-spec/implementation-spec.md
│   └── conformance/spec-code-comparison.md
└── approvals/
    └── design/
        ├── <timestamp>-approved.json
        └── design.json
```

`workflow.json` is authoritative runtime state. `STATUS.md` is a generated human view. Artifacts contain a machine-managed metadata comment. Approval event files are append-only records; phase summary files are derived snapshots.

`documents.json` is the stable supporting-input catalog. Local files are copied under `inputs/DOC-nnn/`; external links such as Figma are recorded without being downloaded. Each input is attributed to the active identity/persona and uploaded only during the profile-snapshotted allowed phases. Uploads use the same commit/push recovery protocol as lifecycle events.

`guide` derives a read-only template walkthrough from `workflow.json`. It does not maintain separate state; `/sflow-help` reports the immutable phase sequence and selects its recommended next action from the current phase status and generation history.

`HELP.md` is the canonical product manual. The CLI parses its level-two headings into stable topic IDs for `singularity-flow help [TOPIC]`; `/sflow-help` loads those topics for general questions and uses `guide` for work-item-specific questions. The Electron renderer imports the same Markdown at build time and provides local topic search. This keeps help available offline without granting the renderer new filesystem or IPC capabilities.

## Progress model

Completion is the number of approved phases divided by the immutable total phase count. Awaiting approval and in-progress phases are not assigned guessed fractional credit. The progress view also exposes current position, generations, approval thresholds, document count, and token totals.

`report` is another read-only projection over the same committed `workflow.json`. It sorts lifecycle events, pairs each submission with its next approval/rejection, and derives wall-clock phase duration, approval waiting, rework, exact token usage, optional configured cost, and the largest approval-latency bottleneck. Open submissions accrue waiting time through the report timestamp. Markdown, JSON, and script-free HTML renderers do not introduce report state; `--out` writes an explicitly requested file but never commits it. Cost is computed only for exact usage whose exact model name has a non-negative per-million price in workflow YAML, with incomplete coverage marked partial.

## Desktop control plane

`apps/desktop` is an Electron and React control plane over the CLI. The renderer has no Node integration, runs sandboxed with context isolation, and receives only a narrow preload API. Git, configuration validation, persona sessions, document operations, commits, and pushes are executed through `singularity-flow desktop ...` or existing public CLI commands in a separate process.

The app may visualize repository state and edit workflow, template, and persona source text, but it does not write `workflow.json`, approvals, generated metadata, or other runtime state directly. Desktop configuration saves are atomic: the CLI validates the complete definition and restores the previous file if a change makes any profile, prompt, or template unresolved.

## Transaction and publication model

Each generation, submission, approval, rejection, or advancement is one local state transaction followed by one commit and one normal push. Generation subjects use:

```text
[WORK-ID][phase:<id>][generated:<n>]
```

The CLI verifies the expected branch head before mutation and relies on fast-forward push rejection for concurrent writers. It never force-pushes or rewrites work-item history.

If publication fails, the commit remains local and `.git/singularity-flow/publication-pending.json` records the pending branch/commit. Lifecycle mutation is blocked until `sync` pushes that exact history. This local marker is recovery state, not transferred workflow state.

## Approval model

An approval contains both:

- Declared persona, which supplies authority.
- Authenticated actor (GitHub login when available, plus Git identity), which supplies accountability.

Thresholds count distinct authenticated identities, not persona selections or repeated clicks. A contributor may approve their own generated content after switching personas, but matching identity produces `selfApproval: true` in the event, artifact, status, and conformance report.

Rejection validates `rejectTo` against the current phase policy. It reopens the target, invalidates approvals from the target through the downstream graph, and retains all prior artifacts and events in Git history.

## Artifact lifecycle and metadata

Template resolution is override → default → error. A generation validates current-phase write scope and minimum artifact requirements. The managed metadata records:

- Work item/type, phase, and generation.
- Generator identity and persona.
- Source/config/template hashes.
- Generation/publication commit linkage.
- Exact or unavailable token usage.
- Approval history and self-approval flags.
- Conformance source/test tree hash when applicable.

Publication commit information that is not knowable before a commit is represented in workflow state and the following lifecycle snapshot; commit hashes remain independently provable through Git.

## Traceability and final gate

Requirements establish `AC-n` identifiers. Implementation specifications establish `SPEC-nnn` items mapped to acceptance criteria. Verification supplies tests and evidence. Conformance joins these ledgers to exact file/line evidence and one of five verdicts: `matched`, `partial`, `missing`, `deviated`, or `unplanned`.

The final tree hash excludes `.singularity` state and hashes tracked source/test content. A later source/test change invalidates the conformance report. The deterministic gate also validates configuration/template snapshots, artifacts, approval identities/personas, thresholds, rejection effects, self-approval disclosure, protected paths, and—under required publication—the remote branch head.

## Migration boundary

Legacy `.singularity/config.json` and schema-v1 work items can be read and converted. `migrate-config` adds YAML, starter templates/personas, and schema-v2 state while preserving legacy input and existing commits. Migration never rebases or rewrites Git history.
