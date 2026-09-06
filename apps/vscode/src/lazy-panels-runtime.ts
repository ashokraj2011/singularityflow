/**
 * Panels and ceremonies loaded only after a person opens one. `[DXP:P2-002]`
 *
 * esbuild cannot split a CommonJS entry automatically. A separate explicit entry keeps these
 * modules—and the organisation, model-provider, SGOS, and configuration graphs behind them—out of
 * activation while preserving CommonJS support on the VS Code 1.90 baseline.
 */
export { HelpPanel } from './views/help.ts';
export { WorkspacePanel } from './views/workspace-panel.ts';
export { BootstrapPanel } from './views/bootstrap-panel.ts';
export { CapabilityProposalPanel } from './views/capability-proposal.ts';
export { CapabilityProposalsPanel } from './views/capability-proposals.ts';
export { WorkspacesPanel } from './views/workspaces-panel.ts';
export { DiagnosticsPanel } from './views/diagnostics.ts';
export { LocalResetPanel } from './views/local-reset.ts';
export { GoalsPanel } from './views/goals.ts';
export { FaultRepairsPanel } from './views/fault-repairs.ts';
export { JournalPanel } from './views/journal.ts';
export { AstIntelligencePanel } from './views/ast-intelligence.ts';
export { IntakePanel, intakeInFlight } from './views/intake-panel.ts';
export { EvidenceManagerPanel } from './views/evidence-manager.ts';
export { CapabilitiesPanel } from './views/capabilities.ts';
export { ConfigurationCenterPanel } from './views/configuration-center.ts';
export { ImpactPanel } from './views/impact.ts';
export { FlowImpactPanel } from './views/flow-impact.ts';
export { StoriesPanel } from './views/stories.ts';
export { ApprovalsPanel } from './views/approvals.ts';
export { InboxPanel } from './views/inbox.ts';
export { JourneyPanel } from './views/journey.ts';
export { SgosCommandCenterPanel } from './views/sgos-command-center.ts';
export { showSgosWorkflowCreator } from './sgos-workflow-create.ts';
export { showSgosMetaToolReview } from './sgos-meta-tool-review.ts';
export { showGdpLocalRunnerReview } from './gdp-local-runner-review.ts';
export { ReconciliationPanel } from './views/reconciliation.ts';
export { DashboardPanel } from './views/dashboard.ts';
export { DesignerPanel } from './views/designer.ts';
export { InstructionDesignerPanel } from './views/instruction-designer.ts';
export { WorkspaceLogsPanel } from './views/workspace-logs.ts';
export { SpecificationTracePanel } from './views/specification-trace.ts';
export { VisualAssurancePanel } from './views/visual-assurance.ts';
