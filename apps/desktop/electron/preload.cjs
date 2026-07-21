const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('singularity', {
  chooseRepository: () => ipcRenderer.invoke('repository:choose'),
  snapshot: (repository, workId) => ipcRenderer.invoke('repository:snapshot', { repository, workId }),
  validate: (repository) => ipcRenderer.invoke('configuration:validate', { repository }),
  saveFile: (repository, filePath, content) => ipcRenderer.invoke('configuration:save', { repository, filePath, content }),
  publish: (repository, message) => ipcRenderer.invoke('configuration:publish', { repository, message }),
  selectPersona: (repository, workId, persona) => ipcRenderer.invoke('session:persona', { repository, workId, persona }),
  uploadDocuments: (repository) => ipcRenderer.invoke('documents:upload', { repository }),
  addDocumentUrl: (repository, url, label) => ipcRenderer.invoke('documents:add-url', { repository, url, label }),
  previewDocument: (repository, workId, reference) => ipcRenderer.invoke('documents:preview', { repository, workId, reference }),
  openDocument: (repository, record) => ipcRenderer.invoke('documents:open', { repository, record })
});
