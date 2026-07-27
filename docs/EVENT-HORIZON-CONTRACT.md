# Flow ↔ Event Horizon contract

Event Horizon is a separate execution application bundled with Singularity
Flow. Flow owns workspace configuration, Git lineage, artifacts, lifecycle
state, approvals, and publication. Event Horizon owns ACP agent processes,
transcripts, permission decisions, and live model usage.

The integration uses the versioned `FlowWorkspaceContext` contract in
`apps/event-horizon/src/shared/flowContext.ts`. Flow supplies a fresh projection
when Event Horizon opens or an existing session is activated.

It contains the selected workspace and repository; repository role, branch, and
root; current Epic or Story; phase, status, progress, parent ID, and persona;
governed document links; deterministic next actions; source revision; and
capture timestamp.

Event Horizon validates the version and requires the repository root to equal
the ACP working directory. It may display this projection but must not write it
back or treat agent activity as approval, publication, or a phase transition.

Flow remains the synchronization boundary. After CLI activity commits new
state, refreshing Flow and opening Event Horizon again publishes a fresh
projection. Future incompatible changes require a new version and adapter.
