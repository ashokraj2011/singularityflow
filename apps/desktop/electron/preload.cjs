const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('singularity', {
  chooseRepository: () => ipcRenderer.invoke('repository:choose'),
  snapshot: (repository, workId) => ipcRenderer.invoke('repository:snapshot', { repository, workId }),
  validate: (repository) => ipcRenderer.invoke('configuration:validate', { repository }),
  saveFile: (repository, filePath, content) => ipcRenderer.invoke('configuration:save', { repository, filePath, content }),
  deleteTemplate: (repository, filePath) => ipcRenderer.invoke('configuration:delete-template', { repository, filePath }),
  deleteFile: (repository, filePath) => ipcRenderer.invoke('configuration:delete-file', { repository, filePath }),
  downloadFile: (repository, filePath) => ipcRenderer.invoke('configuration:download', { repository, filePath }),
  importFile: (repository, options) => ipcRenderer.invoke('configuration:import', { repository, ...options }),
  exportBundle: (repository) => ipcRenderer.invoke('configuration:export-bundle', { repository }),
  publish: (repository, message) => ipcRenderer.invoke('configuration:publish', { repository, message }),
  selectPersona: (repository, workId, persona) => ipcRenderer.invoke('session:persona', { repository, workId, persona }),
  uploadDocuments: (repository) => ipcRenderer.invoke('documents:upload', { repository }),
  uploadDocumentDirectory: (repository) => ipcRenderer.invoke('documents:upload-directory', { repository }),
  addDocumentUrl: (repository, url, label) => ipcRenderer.invoke('documents:add-url', { repository, url, label }),
  previewDocument: (repository, workId, reference) => ipcRenderer.invoke('documents:preview', { repository, workId, reference }),
  openDocument: (repository, record) => ipcRenderer.invoke('documents:open', { repository, record })
});
