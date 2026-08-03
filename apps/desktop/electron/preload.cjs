const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('singularity', {
  onboarding: () => ipcRenderer.invoke('onboarding:get'),
  saveOnboarding: (profile, complete = false) => ipcRenderer.invoke('onboarding:save', { profile, complete }),
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
  archiveWorkspace: (workspace, confirmation) => ipcRenderer.invoke('workspace:archive', { workspace, confirmation }),
  restoreWorkspace: (workspace) => ipcRenderer.invoke('workspace:restore', { workspace }),
  chooseWorkspaceBase: () => ipcRenderer.invoke('workspace:choose-base'),
  workspaceRepositoryDefaults: (repository) => ipcRenderer.invoke('workspace:repository-defaults', { repository }),
  chooseWorkspaceRepositories: () => ipcRenderer.invoke('workspace:repository-choose'),
  previewWorkspaceConfiguration: (repository, options) => ipcRenderer.invoke('workspace:configuration-preview', { repository, ...options }),
  createWorkspaceConfiguration: (repository, options) => ipcRenderer.invoke('workspace:configuration-create', { repository, ...options }),
  previewWorkspaceUpdate: (repository, workspace, options) => ipcRenderer.invoke('workspace:configuration-update-preview', { repository, workspace, ...options }),
  updateWorkspaceConfiguration: (repository, workspace, options) => ipcRenderer.invoke('workspace:configuration-update', { repository, workspace, ...options }),
  workspaceJiraContext: (repository, workspace) => ipcRenderer.invoke('workspace:jira-context', { repository, workspace }),
  connectWorkspaceJira: (repository, workspace, connection) => ipcRenderer.invoke('workspace:jira-connect', { repository, workspace, connection }),
  disconnectWorkspaceJira: (repository, workspace) => ipcRenderer.invoke('workspace:jira-disconnect', { repository, workspace }),
  workspaceJiraEpics: (repository, workspace, refresh = false) => ipcRenderer.invoke('workspace:jira-epics', { repository, workspace, refresh }),
  workspaceJiraStories: (repository, workspace, refresh = false) => ipcRenderer.invoke('workspace:jira-stories', { repository, workspace, refresh }),
  correctWorkspaceJiraRoute: (repository, workspace, currentProjectKey, epicReference) => ipcRenderer.invoke('workspace:jira-route-correct', {
    repository, workspace, currentProjectKey, epicReference
  }),
  workspaceJiraEpic: (repository, workspace, epicKey) => ipcRenderer.invoke('workspace:jira-epic', { repository, workspace, epicKey }),
  workspaceJiraStory: (repository, workspace, storyKey) => ipcRenderer.invoke('workspace:jira-story', { repository, workspace, storyKey }),
  startStoryWizard: (repository, workspace, repositoryId, storyKey, workType) => ipcRenderer.invoke('story:start', {
    repository, workspace, repositoryId, storyKey, workType
  }),
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
  restartInitiative: (repository, initiativeId, confirmation, reason) => ipcRenderer.invoke('initiative:restart', { repository, initiativeId, confirmation, reason }),
  selectInitiativeOutputs: (repository, initiativeId, phaseId, outputIds, reason) => ipcRenderer.invoke('initiative:outputs-select', { repository, initiativeId, phaseId, outputIds, reason }),
  recordInitiativeEvidence: (repository, initiativeId, phaseId, checkId, reason, observedState) =>
    ipcRenderer.invoke('initiative:evidence-record', { repository, initiativeId, phaseId, checkId, reason, observedState }),
  generateWorldModel: (repository, local = true, views = null, initiativeId = null) =>
    ipcRenderer.invoke('worldmodel:generate', { repository, local, views, initiativeId }),
  onWorldModelProgress: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on('worldmodel:progress', handler);
    return () => ipcRenderer.removeListener('worldmodel:progress', handler);
  },
  deleteTemplate: (repository, filePath) => ipcRenderer.invoke('configuration:delete-template', { repository, filePath }),
  deleteFile: (repository, filePath) => ipcRenderer.invoke('configuration:delete-file', { repository, filePath }),
  previewTemplateUrl: (repository, url) => ipcRenderer.invoke('configuration:template-url-preview', { repository, url }),
  downloadFile: (repository, filePath) => ipcRenderer.invoke('configuration:download', { repository, filePath }),
  importFile: (repository, options) => ipcRenderer.invoke('configuration:import', { repository, ...options }),
  exportBundle: (repository) => ipcRenderer.invoke('configuration:export-bundle', { repository }),
  publish: (repository, message) => ipcRenderer.invoke('configuration:publish', { repository, message }),
  bootstrapPortfolio: (repository, configuration) => ipcRenderer.invoke('configuration:bootstrap-portfolio', { repository, configuration }),
  bootstrapWorkspacePortfolio: (repository, workspace) => ipcRenderer.invoke('configuration:bootstrap-workspace-portfolio', { repository, workspace }),
  selectPersona: (repository, workId, agent) => ipcRenderer.invoke('session:agent', { repository, workId, agent }),
  previewInitiativeMaterialization: (repository, initiativeId) => ipcRenderer.invoke('initiative:materialize-preview', { repository, initiativeId }),
  materializeInitiative: (repository, initiativeId, confirmation) => ipcRenderer.invoke('initiative:materialize', { repository, initiativeId, confirmation }),
  syncInitiative: (repository, initiativeId) => ipcRenderer.invoke('initiative:sync', { repository, initiativeId }),
  openInitiative: (repository, initiativeId) => ipcRenderer.invoke('initiative:open', { repository, initiativeId }),
  refreshInitiatives: (repository) => ipcRenderer.invoke('initiative:refresh', { repository }),
  publishInitiativePhase: (repository, initiativeId, phaseId, agent) => ipcRenderer.invoke('initiative:phase-publish', {
    repository, initiativeId, phaseId, agent
  }),
  approveInitiativePhase: (repository, initiativeId, subject, confirmation, agent, selfApprovalAcknowledged = false) => ipcRenderer.invoke('initiative:phase-approve', {
    repository, initiativeId, subject, confirmation, agent, selfApprovalAcknowledged
  }),
  epicSources: (repository, initiativeId) => ipcRenderer.invoke('epic:sources', { repository, initiativeId }),
  saveEpicStorageCredential: (repository, providerId, token) => ipcRenderer.invoke('epic:storage-credential', { repository, providerId, token }),
  connectEpicSharePoint: (repository, initiativeId, providerId) => ipcRenderer.invoke('epic:sharepoint-connect', {
    repository, initiativeId, providerId
  }),
  disconnectEpicStorage: (repository, providerId) => ipcRenderer.invoke('epic:storage-disconnect', { repository, providerId }),
  previewEpicSource: (repository, initiativeId, sourceId) =>
    ipcRenderer.invoke('epic:sources-preview', { repository, initiativeId, sourceId }),
  pinJiraAttachments: (repository, initiativeId) =>
    ipcRenderer.invoke('epic:sources-pin-jira', { repository, initiativeId }),
  // Electron removed File.path in v32; a dropped file's location is only obtainable here.
  pathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch { return null; } },
  uploadEpicSources: (repository, initiativeId, providerId = null, mimeType = 'application/octet-stream', filePaths = null) => ipcRenderer.invoke('epic:sources-upload', {
    repository, initiativeId, providerId, mimeType, filePaths
  }),
  addEpicSourceUrl: (repository, initiativeId, providerId, url, label, mimeType = 'application/octet-stream') => ipcRenderer.invoke('epic:sources-add-url', {
    repository, initiativeId, providerId, url, label, mimeType
  }),
  addEpicTextSource: (repository, initiativeId, text, label = null, kind = 'note') => ipcRenderer.invoke('epic:sources-add-text', {
    repository, initiativeId, text, label, kind
  }),
  verifyEpicSources: (repository, initiativeId, providerId = null, materialize = true) => ipcRenderer.invoke('epic:sources-verify', {
    repository, initiativeId, providerId, materialize
  }),
  epicReviewInbox: (repository, initiativeId) => ipcRenderer.invoke('epic:review-inbox', { repository, initiativeId }),
  epicReview: (repository, initiativeId, storyId, packetSha256 = null) => ipcRenderer.invoke('epic:review', {
    repository, initiativeId, storyId, packetSha256
  }),
  updateEpicStory: (repository, initiativeId, planId, changes) => ipcRenderer.invoke('epic:story-update', {
    repository, initiativeId, planId, changes
  }),
  splitEpicStory: (repository, initiativeId, planId, changes) => ipcRenderer.invoke('epic:story-split', {
    repository, initiativeId, planId, changes
  }),
  adoptEpicStory: (repository, initiativeId, jiraKey, changes) => ipcRenderer.invoke('epic:story-adopt', {
    repository, initiativeId, jiraKey, changes
  }),
  runEpicChecks: (repository, initiativeId, storyId, packetSha256 = null) => ipcRenderer.invoke('epic:checks', {
    repository, initiativeId, storyId, packetSha256
  }),
  decideEpicReview: (repository, initiativeId, storyId, packetSha256, decision, agent, target = null, reason = null) => ipcRenderer.invoke('epic:decision', {
    repository, initiativeId, storyId, packetSha256, decision, agent, target, reason
  }),
  completeEpicDelivery: (repository, initiativeId, confirmation) => ipcRenderer.invoke('epic:complete', {
    repository, initiativeId, confirmation
  }),
  observeEpicJiraDrift: (repository, initiativeId) => ipcRenderer.invoke('epic:jira-drift', { repository, initiativeId }),
  jiraStatus: (repository) => ipcRenderer.invoke('jira:status', { repository }),
  connectJira: (repository, connection) => ipcRenderer.invoke('jira:connect', { repository, connection }),
  disconnectJira: (repository, name) => ipcRenderer.invoke('jira:disconnect', { repository, name }),
  jiraProjects: (repository, query = '', refresh = false) => ipcRenderer.invoke('jira:projects', { repository, query, refresh }),
  jiraEpic: (repository, epicKey) => ipcRenderer.invoke('jira:epic', { repository, epicKey }),
  jiraEpics: (repository, projectKey, refresh = false) => ipcRenderer.invoke('jira:epics', { repository, projectKey, refresh }),
  jiraWorkspaceAnchors: (repository, projectKey, refresh = false) => ipcRenderer.invoke('jira:workspace-anchors', { repository, projectKey, refresh }),
  jiraHierarchy: (repository, anchorKey, refresh = false) => ipcRenderer.invoke('jira:hierarchy', { repository, anchorKey, refresh }),
  jiraChildren: (repository, epicKey, refresh = false) => ipcRenderer.invoke('jira:children', { repository, epicKey, refresh }),
  startEpicWizard: (repository, epicKey, profile) => ipcRenderer.invoke('epic:start', {
    repository, epicKey, profile
  }),
  previewLocalEpicId: (repository) => ipcRenderer.invoke('epic:local-id-preview', { repository }),
  startLocalEpic: (repository, title, description, goal, profile) => ipcRenderer.invoke('epic:start-local', {
    repository, title, description, goal, profile
  }),
  chooseStoryDocuments: (repository, directory = false) => ipcRenderer.invoke('story:choose-documents', {
    repository, directory
  }),
  startManualStory: (repository, intake) => ipcRenderer.invoke('story:start-manual', {
    repository, intake
  }),
  previewJiraAdoption: (repository, initiativeId, epicKey, repositoryMap = {}) => ipcRenderer.invoke('jira:adopt-preview', { repository, initiativeId, epicKey, repositoryMap }),
  adoptJiraEpic: (repository, initiativeId, epicKey, repositoryMap = {}, replace = false) => ipcRenderer.invoke('jira:adopt', { repository, initiativeId, epicKey, repositoryMap, replace }),
  createJiraWritePlan: (repository, initiativeId, artifacts = []) => ipcRenderer.invoke('jira:write-plan', { repository, initiativeId, artifacts }),
  applyJiraWritePlan: (repository, initiativeId, planSha256, confirmation) => ipcRenderer.invoke('jira:apply', { repository, initiativeId, planSha256, confirmation }),
  openJira: (repository, url) => ipcRenderer.invoke('jira:open', { repository, url }),
  uploadDocuments: (repository) => ipcRenderer.invoke('documents:upload', { repository }),
  uploadDocumentDirectory: (repository) => ipcRenderer.invoke('documents:upload-directory', { repository }),
  addDocumentUrl: (repository, url, label) => ipcRenderer.invoke('documents:add-url', { repository, url, label }),
  previewDocument: (repository, workId, reference) => ipcRenderer.invoke('documents:preview', { repository, workId, reference }),
  openDocument: (repository, workId, record) => ipcRenderer.invoke('documents:open', { repository, workId, record }),
  connectDocumentSharePoint: (repository, providerId) => ipcRenderer.invoke('documents:sharepoint-connect', { repository, providerId }),
  listSharePointDocuments: (repository, providerId, path) => ipcRenderer.invoke('documents:sharepoint-list', { repository, providerId, path }),
  fetchSharePointDocument: (repository, providerId, remoteRef, name, label) => ipcRenderer.invoke('documents:sharepoint-fetch', { repository, providerId, remoteRef, name, label })
});
