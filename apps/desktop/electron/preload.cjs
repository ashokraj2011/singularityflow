const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('singularity', {
  chooseRepository: () => ipcRenderer.invoke('repository:choose'),
  recentRepositories: () => ipcRenderer.invoke('repository:recent'),
  openRepository: (repository) => ipcRenderer.invoke('repository:open', { repository }),
  forgetRepository: (repository) => ipcRenderer.invoke('repository:forget', { repository }),
  snapshot: (repository, workId, initiativeId) => ipcRenderer.invoke('repository:snapshot', { repository, workId, initiativeId }),
  refreshInbox: (repository) => ipcRenderer.invoke('inbox:refresh', { repository }),
  attachInboxItem: (repository, workId) => ipcRenderer.invoke('inbox:attach', { repository, workId }),
  validate: (repository) => ipcRenderer.invoke('configuration:validate', { repository }),
  saveFile: (repository, filePath, content) => ipcRenderer.invoke('configuration:save', { repository, filePath, content }),
  deleteTemplate: (repository, filePath) => ipcRenderer.invoke('configuration:delete-template', { repository, filePath }),
  deleteFile: (repository, filePath) => ipcRenderer.invoke('configuration:delete-file', { repository, filePath }),
  downloadFile: (repository, filePath) => ipcRenderer.invoke('configuration:download', { repository, filePath }),
  importFile: (repository, options) => ipcRenderer.invoke('configuration:import', { repository, ...options }),
  exportBundle: (repository) => ipcRenderer.invoke('configuration:export-bundle', { repository }),
  publish: (repository, message) => ipcRenderer.invoke('configuration:publish', { repository, message }),
  selectPersona: (repository, workId, persona) => ipcRenderer.invoke('session:persona', { repository, workId, persona }),
  planningPreflight: (repository) => ipcRenderer.invoke('planning:preflight', { repository }),
  buildPlanningContext: (repository, options) => ipcRenderer.invoke('planning:context', { repository, ...options }),
  startPlanningSession: (repository, planningSessionId, model) => ipcRenderer.invoke('planning:start', { repository, planningSessionId, model }),
  promptPlanningSession: (repository, planningSessionId, text) => ipcRenderer.invoke('planning:prompt', { repository, planningSessionId, text }),
  answerPlanningQuestion: (repository, planningSessionId, questionId, content, action = 'accept') => ipcRenderer.invoke('planning:answer', { repository, planningSessionId, questionId, content, action }),
  stopPlanningSession: (repository, planningSessionId) => ipcRenderer.invoke('planning:stop', { repository, planningSessionId }),
  promotePlanningArtifact: (repository, planningSessionId, persona, content) => ipcRenderer.invoke('planning:promote', { repository, planningSessionId, persona, content }),
  previewInitiativeMaterialization: (repository, initiativeId) => ipcRenderer.invoke('initiative:materialize-preview', { repository, initiativeId }),
  materializeInitiative: (repository, initiativeId, confirmation) => ipcRenderer.invoke('initiative:materialize', { repository, initiativeId, confirmation }),
  syncInitiative: (repository, initiativeId) => ipcRenderer.invoke('initiative:sync', { repository, initiativeId }),
  onPlanningEvent: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on('planning:event', handler);
    return () => ipcRenderer.removeListener('planning:event', handler);
  },
  uploadDocuments: (repository) => ipcRenderer.invoke('documents:upload', { repository }),
  uploadDocumentDirectory: (repository) => ipcRenderer.invoke('documents:upload-directory', { repository }),
  addDocumentUrl: (repository, url, label) => ipcRenderer.invoke('documents:add-url', { repository, url, label }),
  previewDocument: (repository, workId, reference) => ipcRenderer.invoke('documents:preview', { repository, workId, reference }),
  openDocument: (repository, workId, record) => ipcRenderer.invoke('documents:open', { repository, workId, record })
});
