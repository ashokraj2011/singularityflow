/**
 * Where a person finds each command, and each Navigator, Workflow Studio and Configuration destination, now that the
 * sidebar opens on the four places [FPL:REQ-035; docs/SPEC-FPL-FOUR-PLACES-v1.md §5, the map in words].
 *
 * Every command stays in the palette with its title [REQ-033]. A line says where a person also finds it: in a place (or the
 * places' header), under Advanced (today's Navigator, unchanged, and the editor's menus), or only in the palette, as today.
 * A host test (test/fpl-places-vscode.test.mjs) fails on a contributed command with no line here, and on a line for a
 * command that is no longer contributed. Pure data: nothing here runs or opens anything.
 */

/** A place, or the places' header (its workspace line and title actions). */
export type PlaceSpot = 'work' | 'needs-you' | 'rules' | 'library' | 'header';

export interface PlacesMapLine {
  /** The command, by its full ID. */
  readonly command: string;
  /** Today's group in the spec's table (§5). */
  readonly group: string;
  /** Where a person also finds it in the four places, or null when it is under Advanced or in the palette only. */
  readonly place: PlaceSpot | null;
  /** What it is there, in a person's words; null with no place. */
  readonly there: string | null;
  /** Where it is under Advanced, or "the palette" when the palette (and the editor's menus) is the only place for it. */
  readonly advanced: string;
}

type Entry = readonly [place: PlaceSpot | null, there: string | null, advanced?: string];
interface Group { readonly title: string; readonly advanced: string; readonly commands: Readonly<Record<string, Entry>> }

const NONE: Entry = [null, null];
const PALETTE = 'the palette';

/** §5, one group per row of its table, in its order, and the four places' own commands last. */
const GROUPS: readonly Group[] = [
  { title: 'Starting and following work', advanced: 'Main menu and Work tools', commands: {
    startTask: ['work', 'the box: Start'],
    startWork: ['work', 'Start with a workflow…'],
    myWork: ['work', 'In progress'],
    openWorkspaceStories: ['work', 'All Stories in this workspace'],
    openJourney: ['work', 'the task page: Open in Copilot chat'],
    openStoryIntake: ['work', 'the task page: Intake'],
    openProgress: NONE,
    openPhaseArtifacts: ['work', 'the task page: Documents'],
    refresh: ['header', 'Refresh'],
    returnToWork: NONE,
    continueSafely: NONE,
    cancelWork: ['work', 'the task page: Stop the task'],
    openCopilot: ['work', 'the task page: Open in Copilot chat'],
    continueStory: ['needs-you', 'Continue, when nothing waits on you', 'the status bar\'s Continue']
  } },
  { title: 'A Story\'s step actions', advanced: 'Work tools › Current work actions & artifacts', commands: {
    // The task page's Open in Copilot chat is the daily route: the chat runs these.
    prepareStoryPhase: NONE,
    publishStoryPhase: NONE,
    submitStoryPhase: NONE,
    prefillStoryPhaseGeneration: NONE,
    prefillNextCommand: NONE,
    runAction: NONE,
    reopenCompleted: NONE,
    rollForwardRework: NONE,
    reviewStoryTestRecovery: NONE,
    changeTestScope: NONE,
    resolvePhaseIssues: NONE,
    openMeteredCopilot: NONE,
    takeoverStory: NONE,
    attachSessionToWorkspace: NONE
  } },
  { title: 'Deciding and approving', advanced: 'Main menu (Reviews) and pins (Inbox, Approvals, Configuration approvals)', commands: {
    approve: ['needs-you', 'a card: the approval page for one item'],
    decide: ['needs-you', 'a card: the Decide card for one item'],
    decisions: ['needs-you', 'a card: the decision list for one item'],
    decideStory: ['needs-you', 'a card: the workflow decision for one item', PALETTE],
    adjudicate: ['needs-you', 'a card: the adjudication for one item', PALETTE],
    reviewWitness: ['needs-you', 'a card: the evidence sign-off for one item', PALETTE],
    openApprovals: ['needs-you', 'a card for each approval'],
    openInbox: ['needs-you', 'the list'],
    openReviews: ['needs-you', 'Review items'],
    openConfigurationApprovals: ['needs-you', 'Review items'],
    reviewCapabilityProposals: ['needs-you', 'Review items', PALETTE],
    sfGuard: [null, null, PALETTE]
  } },
  { title: 'Workflows and who approves', advanced: 'Configuration › Workflow Studio, its 11 views', commands: {
    openWorkflowStudio: ['rules', 'For work a team must always do one way (Workflow Studio)'],
    openDesigner: NONE,
    configurePeople: ['rules', 'a rule\'s approver: People and approval groups'],
    openConstitution: ['rules', 'the Rules page: the Constitution'],
    importTeamWorkflow: NONE,
    publishConfiguration: NONE,
    openSharedWorkflowDrafts: NONE
  } },
  { title: 'Skills, agents and instructions', advanced: 'Workflow Studio: Instructions, Artifacts, Integrations and Library', commands: {
    marketplace: ['library', 'Open the Library'],
    allSkills: ['library', 'All skills'],
    openSkills: ['library', 'a skill or agent: Skill master or Agents'],
    openInstructionDesigner: NONE,
    openReusableInstructions: NONE,
    addUserAgent: ['library', 'Add your own agent folder…'],
    openApmPackages: [null, null, 'Agent packages'],
    configureTemplates: NONE,
    configureMcp: NONE,
    lessons: ['work', 'the task page: Lessons; the Rules page\'s guidance line', 'Lessons']
  } },
  { title: 'Configuration', advanced: 'Main menu (Configuration) and its 8 tabs, the profile button, pins and the Prompt log switch', commands: {
    openConfigurationCenter: NONE, configureTests: NONE, configureAuto: NONE, configureWorldModel: NONE,
    configureAstIntelligence: NONE, configureModels: NONE, configureModelMode: NONE, configureProfile: NONE,
    choosePersona: NONE, manageFavorites: NONE, connectJira: NONE, resetJira: NONE, configureTeams: NONE, resetTeams: NONE,
    togglePromptLog: NONE, countCopilotChatUsage: NONE, stopCountingCopilotChatUsage: NONE, openEnvironmentFiles: NONE
  } },
  { title: 'Workspaces and setup', advanced: 'Main menu (Workspaces), the context section and pins', commands: {
    openWorkspaces: NONE,
    createWorkspace: NONE,
    adoptWorkspace: NONE,
    switchWorkspace: ['header', 'the workspace line'],
    switchWorkspaceRepository: ['work', 'Another repository…'],
    openWorkspace: NONE,
    startWizard: NONE,
    openWalkthrough: NONE,
    mapCapability: NONE, onboardTeam: NONE, fastOnboardRepository: NONE, init: NONE, smartInit: NONE, addCapability: NONE,
    editCapability: NONE, openCapabilities: NONE, resumeWorkspaceBootstrap: NONE, workspaceDoctor: NONE, repairWorkspace: NONE,
    checkoutInventory: NONE, cleanupCheckouts: NONE, cleanupRetention: NONE, runRetention: NONE, executionContext: NONE,
    checkRepository: NONE, refreshAuthorityPin: NONE, bootstrapLocalAuthority: NONE, useOfflineAuthorityPin: NONE,
    configureGitAcceleration: NONE, clearDerivedCache: NONE
  } },
  { title: 'Updates, repair and help', advanced: 'Help & diagnostics', commands: {
    updateSflow: NONE, upgradeOrRepair: NONE, refreshCapability: NONE, upgradeWorkspaces: NONE, afterInstall: NONE, about: NONE,
    reinitializeWorkspaces: NONE, refreshRepositorySetup: NONE, repairRepositorySetup: NONE, factoryReset: NONE, openLocalReset: NONE,
    openHelp: NONE,
    explainTopic: NONE,
    explainError: [null, null, 'Help & diagnostics, and every refusal\'s Explain error'],
    copyHelpCommand: NONE, prefillHelpAction: NONE, openHelpTopicFromChat: NONE,
    askSFlow: ['header', 'Ask SFlow'],
    openDeveloperHome: NONE, resetGuideSession: NONE, doctor: NONE, openDiagnostics: NONE, openFaultRepairs: NONE,
    openCopilotExtensions: NONE,
    runOfficeChecks: [null, null, 'Help & diagnostics › Diagnostics']
  } },
  { title: 'Activity and logs', advanced: 'Activity & logs', commands: {
    openActivityLog: NONE, openPerformanceReport: NONE, openWorkspaceLogs: NONE, refreshWorkspaceLogs: NONE, openPromptAudit: NONE,
    showPrompts: NONE, openJournal: NONE, inspectCompositionCache: NONE, checkLedgerDeployment: NONE, openHarnessReport: NONE
  } },
  { title: 'Understanding code and changes', advanced: 'Work tools › Understand changes, and the editor\'s context menus', commands: {
    openChangeExplorer: NONE,
    openCodeExplainer: ['work', 'the task page: Explain the change'],
    openCodeExplanation: NONE, openRepositoryKnowledge: NONE, reviewRepositoryKnowledge: NONE, showPhaseBrief: NONE,
    openComprehensionCenter: NONE, explainFileChanges: NONE, explainChangeAtCursor: NONE, explainCodeAtCursor: NONE,
    previewSelectedImpact: NONE, showImpact: NONE, openImpact: NONE, impactForm: NONE, openFlowImpact: NONE, expandReference: NONE,
    openSpecificationTrace: NONE
  } },
  { title: 'Evidence, review and delivery', advanced: 'Work tools and pins', commands: {
    openEvidenceMatrix: NONE, attachEvidence: NONE, manageEvidence: NONE, detachEvidence: NONE, addSource: NONE,
    openVisualAssurance: NONE, applicationReview: NONE, openOutcomeReview: NONE, guideDeliveryValidation: NONE,
    openReconciliation: NONE, openInvestigation: NONE, openContextReceipt: NONE, openHandoff: NONE,
    openArtifact: ['work', 'the task page: a step\'s document'],
    findings: NONE, uploadFindings: NONE, openGoals: NONE, openDashboard: NONE, openStories: NONE, openSpecStudio: NONE,
    openBrowserWorkspace: NONE, openAdhocWork: NONE
  } },
  { title: 'Run and test', advanced: 'Run & Test in the context section, and the Run view', commands: {
    workspaceRunTest: NONE, startApplication: NONE, runTests: NONE, testSummary: NONE, editRunConfigurations: NONE,
    selectRunConfiguration: NONE, runSelectedConfiguration: NONE, debugSelectedConfiguration: NONE, stopRunningConfiguration: NONE,
    rerunSelectedConfiguration: NONE, runConfiguration: NONE, debugConfiguration: NONE, stopConfiguration: NONE,
    openConfigurationInBrowser: NONE, showConfigurationLog: NONE, editConfiguration: NONE, copyConfigurationCommandLine: NONE,
    runConfigurationInEnvironment: NONE, refreshRunConfigurations: NONE
  } },
  { title: 'Execution workflows', advanced: 'Work tools and pins', commands: {
    openCommandCenter: NONE, createSgosWorkflow: NONE, reviewSgosMetaTool: NONE, reviewLocalRunner: NONE
  } },
  { title: 'The four places', advanced: 'the palette and the title bar', commands: {
    'places.work': ['work', 'the Work tab'],
    'places.needsYou': ['needs-you', 'the Needs you tab'],
    'places.rules': ['rules', 'the Rules tab'],
    'places.library': ['library', 'the Library tab'],
    'places.advanced': ['header', 'Advanced, the title action and the last row of every place']
  } }
];

/** Every command's line, by its full ID [REQ-035]. */
export const PLACES_MAP: ReadonlyMap<string, PlacesMapLine> = new Map(GROUPS.flatMap((group) => Object.entries(group.commands)
  .map(([id, [place, there, advanced]]): [string, PlacesMapLine] => [`singularityFlow.${id}`,
    Object.freeze({ command: `singularityFlow.${id}`, group: group.title, place, there, advanced: advanced ?? group.advanced })])));

/** The groups' titles, in the spec's order. */
export const PLACES_GROUPS: readonly string[] = Object.freeze(GROUPS.map((group) => group.title));

/**
 * Today's Navigator, Workflow Studio's views and the Configuration Center's tabs, each with the clicks that reach it from
 * Advanced [A20]. Advanced is today's Navigator, so each route is today's, unchanged; the title bar's "…" menu counts as
 * one click. Studio's views other than Workflows need a third click: today's Navigator has no row for Workflow Studio,
 * which is inside Configuration, and A21 keeps that Navigator byte for byte (an owner's question in the M5 report).
 */
export interface AdvancedRoute { readonly id: string; readonly kind: 'navigator' | 'studio' | 'configuration'; readonly clicks: readonly string[] }

const route = (kind: AdvancedRoute['kind'], id: string, ...clicks: string[]): AdvancedRoute => Object.freeze({ id, kind, clicks: Object.freeze(clicks) });
const TOOL = (group: string, ids: string[]): AdvancedRoute[] => ids.map((id) => route('navigator', id, group, id));

export const ADVANCED_ROUTES: readonly AdvancedRoute[] = Object.freeze([
  // The main menu's 7 rows and the Prompt log switch, open by default.
  ...['ask-sflow', 'my-work', 'work-start', 'stories', 'reviews', 'workspace-manage', 'configuration-center', 'prompt-log-toggle']
    .map((id) => route('navigator', id, id)),
  // The context section: the workspace, the intake details, Run & Test and the profile button.
  ...['workspace-switch', 'story-intake', 'workspace-run-test', 'persona-manage'].map((id) => route('navigator', id, id)),
  // Pinned shortcuts: the section, then a pin; Choose shortcuts pins any of the 40.
  route('navigator', 'pinned-shortcuts', 'pinned-shortcuts'), route('navigator', 'favorites-manage', 'pinned-shortcuts', 'favorites-manage'),
  // The three footer menus and their entries.
  ...['work-tools', 'help-tools', 'activity-tools'].map((id) => route('navigator', id, id)),
  ...TOOL('work-tools', ['current-work-actions', 'browser-workspace', 'spec-studio', 'story-intake', 'artifacts', 'story-analytics', 'understand-changes',
    'findings', 'adhoc-work', 'goals', 'impact-form', 'epic-stories', 'command-center', 'flow-impact']),
  // Understand changes: in the title bar's "…" menu with the places on (Work tools › Understand changes, as today, too).
  ...['change-explorer', 'code-explainer', 'code-explanation', 'comprehension-center', 'repository-knowledge']
    .map((id) => route('navigator', id, 'title-bar-more', id)),
  ...TOOL('help-tools', ['about', 'help-open', 'diagnostics', 'copilot-extensions', 'fault-repairs', 'update-sflow', 'after-install', 'local-reset']),
  ...TOOL('activity-tools', ['logs-open', 'activity-log', 'performance', 'prompt-audit', 'journal']),
  // Configuration Center's 8 tabs: Configuration, then the tab.
  ...['overview', 'git-policy', 'tests', 'auto', 'world-model', 'models', 'people', 'mcp'].map((id) => route('configuration', id, 'configuration-center', id)),
  // Workflow Studio's 11 views: Configuration, Workflow Studio (it opens on Workflows), then the view.
  route('studio', 'home', 'configuration-center', 'workflow-studio'),
  ...['build', 'agents', 'skills', 'instructions', 'constitution', 'artifacts', 'library', 'people', 'integrations', 'changes']
    .map((id) => route('studio', id, 'configuration-center', 'workflow-studio', id))
]);
