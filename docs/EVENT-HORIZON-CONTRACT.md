# Flow ↔ Event Horizon contract

Event Horizon is a separate execution application bundled with Singularity
Flow. Flow owns workspace configuration, Git lineage, artifacts, lifecycle
state, approvals, and publication. Event Horizon owns ACP agent processes,
transcripts, permission decisions, and live model usage.

The integration uses the versioned `FlowWorkspaceContext` contract in
`apps/event-horizon/src/shared/flowContext.ts`. Flow supplies a fresh projection
when Event Horizon opens or an existing session is activated. The projection is
passed to upstream Event Horizon as opaque `hostContext`; the Singularity
provider is the only upstream extension that interprets its work ID, kind,
phase, and persona for context selection.

It contains the selected workspace and repository; repository role, branch, and
root; current Epic or Story; phase, status, progress, parent ID, and persona;
governed document links; deterministic next actions; source revision; and
capture timestamp.

Event Horizon validates the version and requires the repository root to equal
the ACP working directory. It may display this projection but must not write it
back or treat agent activity as approval, publication, or a phase transition.

Before an ACP session is created, Event Horizon asks the registered Singularity
provider for context for that exact work ID. For an Epic it renders
`singularity-flow initiative context`; for a Story it renders
`singularity-flow wm compose --render-only --work-id <ID>`. The resulting
session grounding is injected once, immediately before the first user prompt:

1. phase contract and configured artifact template;
2. selected persona prompt;
3. mandatory phase world-model views;
4. persona-added world-model views;
5. any explicitly requested task guide and rule-selected repository files;
6. locked remote-agent skill Markdown;
7. approved upstream artifacts and evidence.

Instruction documents and evidence documents remain visibly separated.
Repository views and lifecycle artifacts are evidence, so instructions embedded
inside them are never treated as agent commands. Event Horizon displays a
**Singularity grounding active** disclosure listing the injected sources. If
the exact host-selected work item no longer exists, the provider injects
nothing rather than falling back to a different, newer item.

Flow remains the synchronization boundary. After CLI activity commits new
state, refreshing Flow and opening Event Horizon again publishes a fresh
projection. Future incompatible changes require a new version and adapter.
