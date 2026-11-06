/**
 * Panels and ceremonies loaded only after a person opens one. `[DXP:P2-002]`
 *
 * esbuild cannot split a CommonJS entry automatically. A separate explicit entry keeps these
 * modules—and the organisation, model-provider, SGOS, and configuration graphs behind them—out of
 * activation while preserving CommonJS support on the VS Code 1.90 baseline.
 */
export { WorkspacePanel } from './views/workspace-panel.ts';
export { BootstrapPanel } from './views/bootstrap-panel.ts';
export { TeamOnboardingPanel } from './views/team-onboarding-panel.ts';
export { CapabilityProposalPanel } from './views/capability-proposal.ts';
export { CapabilityProposalsPanel } from './views/capability-proposals.ts';
export { SetupProposalPanel } from './views/setup-proposal.ts';
export { WorkspacesPanel } from './views/workspaces-panel.ts';
export { AfterInstallPanel } from './views/after-install-panel.ts';
export { AboutPanel } from './views/about-panel.ts';
export { CopilotExtensionsPanel } from './views/copilot-extensions.ts';
export { TeamImportPanel } from './views/team-import-panel.ts';
export { addUserAgentFolder } from './user-agent-folder.ts';
export { collectReviewConfirmation } from './views/review-confirmation.ts';
export { DiagnosticsPanel } from './views/diagnostics.ts';
export { ComprehensionCenterPanel } from './views/comprehension-center.ts';
export { CodeExplainerPanel } from './views/code-explainer.ts';
export { RepositoryBriefPanel } from './views/repository-brief.ts';
export { PhaseBriefPanel } from './views/phase-brief.ts';
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
export { HostRecordPanel } from './views/host-record-panel.ts';
export { showPhaseArtifacts } from './views/phase-artifacts.ts';
export { artifactPreviewMarkdown } from './views/phase-artifacts-page.ts';
export { SgosCommandCenterPanel } from './views/sgos-command-center.ts';
export { showSgosWorkflowCreator } from './sgos-workflow-create.ts';
export { showSharedWorkflowDrafts } from './views/workflow-drafts.ts';
export { showSgosMetaToolReview } from './sgos-meta-tool-review.ts';
export { showGdpLocalRunnerReview } from './gdp-local-runner-review.ts';
export { ReconciliationPanel } from './views/reconciliation.ts';
export { EvidenceMatrixPanel } from './views/evidence-matrix.ts';
export { OutcomeReviewPanel } from './views/outcome-review.ts';
export { ApmPackagesPanel } from './views/apm-packages.ts';
export { DashboardPanel } from './views/dashboard.ts';
export { WorkflowStudioPanel, STUDIO_FOCUS_VIEWS } from './views/workflow-studio.ts';
export { configurationGitFailureText } from './views/configuration-save.ts';
export { InstructionDesignerPanel } from './views/instruction-designer.ts';
export { WorkspaceLogsPanel } from './views/workspace-logs.ts';
export { SpecificationTracePanel } from './views/specification-trace.ts';
export { SpecStudioPanel } from './views/spec-studio.ts';
export { VisualAssurancePanel } from './views/visual-assurance.ts';
export { DecisionListPanel } from './views/decision-list.ts';
export { reviewWitness } from './views/decision-list.ts';
export { reviewAdjudications } from './views/adjudication.ts';
export { SfGuardPanel, SfGuardSignPanel, SfGuardStandings } from './views/sf-guard.ts';
export { RunAndTest, runAndTestCommand, editRunConfigurationsCommand } from './views/run-and-test.ts';
export { TestSummaryPanel } from './views/test-summary.ts';
export { RunWidget } from './views/run-widget.ts';
export { EnvironmentFilesPanel, environmentFilesCommand } from './views/environment-files.ts';

export { WorkspaceRuntimePanel } from './views/workspace-runtime.ts';
