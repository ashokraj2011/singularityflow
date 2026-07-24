const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('singularity', {
  onboarding: () => ipcRenderer.invoke('onboarding:get'),
  saveOnboarding: (profile, complete = false) => ipcRenderer.invoke('onboarding:save', { profile, complete }),
  setExperienceMode: (experienceMode) => ipcRenderer.invoke('onboarding:experience', { experienceMode }),
  chooseOnboardingWorkspace: () => ipcRenderer.invoke('onboarding:choose-workspace'),
  chooseOnboardingRepositories: () => ipcRenderer.invoke('onboarding:choose-repositories'),
  connectOnboardingJira: (connection) => ipcRenderer.invoke('onboarding:jira-connect', { connection }),
  resetJiraCredentials: (repository = null) => ipcRenderer.invoke('jira:reset-credentials', { repository }),
  chooseRepository: () => ipcRenderer.invoke('repository:choose'),
  recentRepositories: () => ipcRenderer.invoke('repository:recent'),
  openRepository: (repository) => ipcRenderer.invoke('repository:open', { repository }),
  forgetRepository: (repository) => ipcRenderer.invoke('repository:forget', { repository }),
  recentWorkspaces: () => ipcRenderer.invoke('workspace:recent'),
  chooseWorkspace: () => ipcRenderer.invoke('workspace:choose'),
  openWorkspace: (workspace) => ipcRenderer.invoke('workspace:open', { workspace }),
  forgetWorkspace: (workspace) => ipcRenderer.invoke('workspace:forget', { workspace }),
  chooseWorkspaceBase: () => ipcRenderer.invoke('workspace:choose-base'),
  workspaceRepositoryDefaults: (repository) => ipcRenderer.invoke('workspace:repository-defaults', { repository }),
  chooseWorkspaceRepositories: () => ipcRenderer.invoke('workspace:repository-choose'),
  previewWorkspaceConfiguration: (repository, options) => ipcRenderer.invoke('workspace:configuration-preview', { repository, ...options }),
  createWorkspaceConfiguration: (repository, options) => ipcRenderer.invoke('workspace:configuration-create', { repository, ...options }),
  previewWorkspace: (repository, options) => ipcRenderer.invoke('workspace:preview', { repository, ...options }),
  createWorkspace: (repository, options) => ipcRenderer.invoke('workspace:create', { repository, ...options }),
  workspaceStatus: (workspace) => ipcRenderer.invoke('workspace:status', { workspace }),
  syncWorkspace: (workspace) => ipcRenderer.invoke('workspace:sync', { workspace }),
  repairWorkspace: (workspace) => ipcRenderer.invoke('workspace:repair', { workspace }),
  stageWorkspaceDocuments: (workspace) => ipcRenderer.invoke('workspace:documents-stage', { workspace }),
  promoteWorkspaceDocument: (repository, workspace, documentPath, workId) => ipcRenderer.invoke('workspace:documents-promote', {
    repository, workspace, documentPath, workId
  }),
  snapshot: (repository, workId, initiativeId) => ipcRenderer.invoke('repository:snapshot', { repository, workId, initiativeId }),
  refreshInbox: (repository) => ipcRenderer.invoke('inbox:refresh', { repository }),
  attachInboxItem: (repository, workId) => ipcRenderer.invoke('inbox:attach', { repository, workId }),
  validate: (repository) => ipcRenderer.invoke('configuration:validate', { repository }),
  saveFile: (repository, filePath, content) => ipcRenderer.invoke('configuration:save', { repository, filePath, content }),
  deleteTemplate: (repository, filePath) => ipcRenderer.invoke('configuration:delete-template', { repository, filePath }),
  deleteFile: (repository, filePath) => ipcRenderer.invoke('configuration:delete-file', { repository, filePath }),
  previewTemplateUrl: (repository, url) => ipcRenderer.invoke('configuration:template-url-preview', { repository, url }),
  downloadFile: (repository, filePath) => ipcRenderer.invoke('configuration:download', { repository, filePath }),
  importFile: (repository, options) => ipcRenderer.invoke('configuration:import', { repository, ...options }),
  exportBundle: (repository) => ipcRenderer.invoke('configuration:export-bundle', { repository }),
  publish: (repository, message) => ipcRenderer.invoke('configuration:publish', { repository, message }),
  bootstrapPortfolio: (repository, configuration) => ipcRenderer.invoke('configuration:bootstrap-portfolio', { repository, configuration }),
  selectPersona: (repository, workId, persona) => ipcRenderer.invoke('session:persona', { repository, workId, persona }),
  planningPreflight: (repository) => ipcRenderer.invoke('planning:preflight', { repository }),
  copilotServiceStatus: (repository) => ipcRenderer.invoke('copilot-service:status', { repository }),
  startCopilotService: (repository, model = null) => ipcRenderer.invoke('copilot-service:start', { repository, model }),
  setCopilotServiceModel: (repository, model) => ipcRenderer.invoke('copilot-service:model', { repository, model }),
  stopCopilotService: (repository) => ipcRenderer.invoke('copilot-service:stop', { repository }),
  copilotServiceLogs: (repository) => ipcRenderer.invoke('copilot-service:logs', { repository }),
  buildPlanningContext: (repository, options) => ipcRenderer.invoke('planning:context', { repository, ...options }),
  startPlanningSession: (repository, planningSessionId, model) => ipcRenderer.invoke('planning:start', { repository, planningSessionId, model }),
  promptPlanningSession: (repository, planningSessionId, text) => ipcRenderer.invoke('planning:prompt', { repository, planningSessionId, text }),
  answerPlanningQuestion: (repository, planningSessionId, questionId, content, action = 'accept') => ipcRenderer.invoke('planning:answer', { repository, planningSessionId, questionId, content, action }),
  stopPlanningSession: (repository, planningSessionId) => ipcRenderer.invoke('planning:stop', { repository, planningSessionId }),
  promotePlanningArtifact: (repository, planningSessionId, persona, content) => ipcRenderer.invoke('planning:promote', { repository, planningSessionId, persona, content }),
  previewInitiativeMaterialization: (repository, initiativeId) => ipcRenderer.invoke('initiative:materialize-preview', { repository, initiativeId }),
  materializeInitiative: (repository, initiativeId, confirmation) => ipcRenderer.invoke('initiative:materialize', { repository, initiativeId, confirmation }),
  syncInitiative: (repository, initiativeId) => ipcRenderer.invoke('initiative:sync', { repository, initiativeId }),
  openInitiative: (repository, initiativeId) => ipcRenderer.invoke('initiative:open', { repository, initiativeId }),
  refreshInitiatives: (repository) => ipcRenderer.invoke('initiative:refresh', { repository }),
  publishInitiativePhase: (repository, initiativeId, phaseId, persona) => ipcRenderer.invoke('initiative:phase-publish', {
    repository, initiativeId, phaseId, persona
  }),
  approveInitiativePhase: (repository, initiativeId, subject, confirmation, persona, selfApprovalAcknowledged = false) => ipcRenderer.invoke('initiative:phase-approve', {
    repository, initiativeId, subject, confirmation, persona, selfApprovalAcknowledged
  }),
  epicSources: (repository, initiativeId) => ipcRenderer.invoke('epic:sources', { repository, initiativeId }),
  saveEpicStorageCredential: (repository, providerId, token) => ipcRenderer.invoke('epic:storage-credential', { repository, providerId, token }),
  connectEpicSharePoint: (repository, initiativeId, providerId) => ipcRenderer.invoke('epic:sharepoint-connect', {
    repository, initiativeId, providerId
  }),
  disconnectEpicStorage: (repository, providerId) => ipcRenderer.invoke('epic:storage-disconnect', { repository, providerId }),
  uploadEpicSources: (repository, initiativeId, providerId = null, mimeType = 'application/octet-stream') => ipcRenderer.invoke('epic:sources-upload', {
    repository, initiativeId, providerId, mimeType
  }),
  addEpicSourceUrl: (repository, initiativeId, providerId, url, label, mimeType = 'application/octet-stream') => ipcRenderer.invoke('epic:sources-add-url', {
    repository, initiativeId, providerId, url, label, mimeType
  }),
  verifyEpicSources: (repository, initiativeId, providerId = null, materialize = true) => ipcRenderer.invoke('epic:sources-verify', {
    repository, initiativeId, providerId, materialize
  }),
  epicReviewInbox: (repository, initiativeId) => ipcRenderer.invoke('epic:review-inbox', { repository, initiativeId }),
  epicReview: (repository, initiativeId, storyId, packetSha256 = null) => ipcRenderer.invoke('epic:review', {
    repository, initiativeId, storyId, packetSha256
  }),
  runEpicChecks: (repository, initiativeId, storyId, packetSha256 = null) => ipcRenderer.invoke('epic:checks', {
    repository, initiativeId, storyId, packetSha256
  }),
  decideEpicReview: (repository, initiativeId, storyId, packetSha256, decision, persona, target = null, reason = null) => ipcRenderer.invoke('epic:decision', {
    repository, initiativeId, storyId, packetSha256, decision, persona, target, reason
  }),
  completeEpicDelivery: (repository, initiativeId, confirmation) => ipcRenderer.invoke('epic:complete', {
    repository, initiativeId, confirmation
  }),
  observeEpicJiraDrift: (repository, initiativeId) => ipcRenderer.invoke('epic:jira-drift', { repository, initiativeId }),
  jiraStatus: (repository) => ipcRenderer.invoke('jira:status', { repository }),
  connectJira: (repository, connection) => ipcRenderer.invoke('jira:connect', { repository, connection }),
  disconnectJira: (repository, name) => ipcRenderer.invoke('jira:disconnect', { repository, name }),
  jiraProjects: (repository, query = '', refresh = false) => ipcRenderer.invoke('jira:projects', { repository, query, refresh }),
  jiraEpics: (repository, projectKey, refresh = false) => ipcRenderer.invoke('jira:epics', { repository, projectKey, refresh }),
  jiraWorkspaceAnchors: (repository, projectKey, refresh = false) => ipcRenderer.invoke('jira:workspace-anchors', { repository, projectKey, refresh }),
  jiraHierarchy: (repository, anchorKey, refresh = false) => ipcRenderer.invoke('jira:hierarchy', { repository, anchorKey, refresh }),
  jiraChildren: (repository, epicKey, refresh = false) => ipcRenderer.invoke('jira:children', { repository, epicKey, refresh }),
  startEpicWizard: (repository, epicKey, profile, persona) => ipcRenderer.invoke('epic:start', {
    repository, epicKey, profile, persona
  }),
  previewLocalEpicId: (repository) => ipcRenderer.invoke('epic:local-id-preview', { repository }),
  startLocalEpic: (repository, title, description, goal, profile, persona) => ipcRenderer.invoke('epic:start-local', {
    repository, title, description, goal, profile, persona
  }),
  previewJiraAdoption: (repository, initiativeId, epicKey, repositoryMap = {}) => ipcRenderer.invoke('jira:adopt-preview', { repository, initiativeId, epicKey, repositoryMap }),
  adoptJiraEpic: (repository, initiativeId, epicKey, repositoryMap = {}, replace = false) => ipcRenderer.invoke('jira:adopt', { repository, initiativeId, epicKey, repositoryMap, replace }),
  createJiraWritePlan: (repository, initiativeId, artifacts = []) => ipcRenderer.invoke('jira:write-plan', { repository, initiativeId, artifacts }),
  applyJiraWritePlan: (repository, initiativeId, planSha256, confirmation) => ipcRenderer.invoke('jira:apply', { repository, initiativeId, planSha256, confirmation }),
  openJira: (repository, url) => ipcRenderer.invoke('jira:open', { repository, url }),
  onPlanningEvent: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on('planning:event', handler);
    return () => ipcRenderer.removeListener('planning:event', handler);
  },
  onCopilotServiceEvent: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on('copilot-service:event', handler);
    return () => ipcRenderer.removeListener('copilot-service:event', handler);
  },
  uploadDocuments: (repository) => ipcRenderer.invoke('documents:upload', { repository }),
  uploadDocumentDirectory: (repository) => ipcRenderer.invoke('documents:upload-directory', { repository }),
  addDocumentUrl: (repository, url, label) => ipcRenderer.invoke('documents:add-url', { repository, url, label }),
  previewDocument: (repository, workId, reference) => ipcRenderer.invoke('documents:preview', { repository, workId, reference }),
  openDocument: (repository, workId, record) => ipcRenderer.invoke('documents:open', { repository, workId, record }),
  connectDocumentSharePoint: (repository, providerId) => ipcRenderer.invoke('documents:sharepoint-connect', { repository, providerId }),
  listSharePointDocuments: (repository, providerId, path) => ipcRenderer.invoke('documents:sharepoint-list', { repository, providerId, path }),
  fetchSharePointDocument: (repository, providerId, remoteRef, name, label) => ipcRenderer.invoke('documents:sharepoint-fetch', { repository, providerId, remoteRef, name, label })
});
