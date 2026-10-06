const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('aiBridge', {
  // Core backend operations
  selectProject: () => ipcRenderer.invoke('dialog:select-project'),
  selectFile: (defaultDir) => ipcRenderer.invoke('dialog:select-file', defaultDir),
  getModelCatalog: () => ipcRenderer.invoke('models:catalog'),
  saveTextFile: (defaultName, content) => ipcRenderer.invoke('dialog:save-text', defaultName, content),
  run: (options) => ipcRenderer.invoke('bridge:run', options),
  stop: () => ipcRenderer.invoke('bridge:stop'),
  accept: (projectPath) => ipcRenderer.invoke('bridge:accept', projectPath),
  rollback: (projectPath) => ipcRenderer.invoke('bridge:rollback', projectPath),
  status: (projectPath, runId) => ipcRenderer.invoke('bridge:status', projectPath, runId),
  report: (projectPath, runId) => ipcRenderer.invoke('bridge:report', projectPath, runId),
  history: (projectPath) => ipcRenderer.invoke('bridge:history', projectPath),
  doctor: () => ipcRenderer.invoke('bridge:doctor'),
  openLog: (projectPath) => ipcRenderer.invoke('bridge:open-log', projectPath),

  // Backward-compatible get* aliases
  getStatus: (projectPath, runId) => ipcRenderer.invoke('bridge:status', projectPath, runId),
  getReport: (projectPath, runId) => ipcRenderer.invoke('bridge:report', projectPath, runId),
  getHistory: (projectPath) => ipcRenderer.invoke('bridge:history', projectPath),
  getDoctor: () => ipcRenderer.invoke('bridge:doctor'),

  // Storage and environment helpers
  getStorage: () => ipcRenderer.invoke('storage:get'),
  setStorage: (cfg) => ipcRenderer.invoke('storage:set', cfg),
  getBranchInfo: (projectPath) => ipcRenderer.invoke('git:branch-info', projectPath),

  windowControl: (action) => ipcRenderer.invoke(`window:${action}`),
  isMaximized: () => ipcRenderer.invoke('window:is-maximized'),

  onEvent: (callback) => {
    const subscription = (event, data) => callback(data);
    ipcRenderer.on('bridge:event', subscription);
    return () => ipcRenderer.removeListener('bridge:event', subscription);
  },

  onStderr: (callback) => {
    const subscription = (event, data) => callback(data);
    ipcRenderer.on('bridge:stderr', subscription);
    return () => ipcRenderer.removeListener('bridge:stderr', subscription);
  },

  // Browser Extension Bridge APIs
  browserBridgeStatus: () => ipcRenderer.invoke('bridge:browser-status'),
  getBrowserBridgeStatus: () => ipcRenderer.invoke('bridge:browser-status'),
  createPairingCode: () => ipcRenderer.invoke('bridge:create-pairing-code'),
  getChatContext: () => ipcRenderer.invoke('bridge:get-chat-context'),
  clearChatContext: () => ipcRenderer.invoke('bridge:clear-chat-context'),
  unpairBrowserExtension: () => ipcRenderer.invoke('bridge:unpair-extension'),

  onChatContextImported: (callback) => {
    const sub = (event, data) => callback(data);
    ipcRenderer.on('bridge:context-updated', sub);
    return () => ipcRenderer.removeListener('bridge:context-updated', sub);
  },
  onChatContextUpdated: (callback) => {
    const sub = (event, data) => callback(data);
    ipcRenderer.on('bridge:context-updated', sub);
    return () => ipcRenderer.removeListener('bridge:context-updated', sub);
  },
  onBrowserPaired: (callback) => {
    const sub = (event, data) => callback(data);
    ipcRenderer.on('bridge:browser-paired', sub);
    return () => ipcRenderer.removeListener('bridge:browser-paired', sub);
  },
  onDetectedTabsUpdated: (callback) => {
    const sub = (event, data) => callback(data);
    ipcRenderer.on('bridge:tabs-updated', sub);
    return () => ipcRenderer.removeListener('bridge:tabs-updated', sub);
  },

  // LLM Hub Web Orchestration APIs
  startLLMSession: (options) => ipcRenderer.invoke('llm-hub:start-session', options),
  stopLLMSession: () => ipcRenderer.invoke('llm-hub:stop-session'),
  sendLLMFollowUp: (options) => ipcRenderer.invoke('llm-hub:follow-up', options),
  getSavedChats: () => ipcRenderer.invoke('llm-hub:get-saved-chats'),
  getSavedChat: (id) => ipcRenderer.invoke('llm-hub:get-saved-chat', id),
  saveLLMChat: (chatData) => ipcRenderer.invoke('llm-hub:save-chat', chatData),
  deleteSavedChat: (id) => ipcRenderer.invoke('llm-hub:delete-saved-chat', id),
  exportSavedChat: (id, format) => ipcRenderer.invoke('llm-hub:export-chat', id, format),
  getConnectedTabsStatus: () => ipcRenderer.invoke('llm-hub:get-tabs-status'),

  onLLMHubEvent: (callback) => {
    const sub = (event, data) => callback(data);
    ipcRenderer.on('llm-hub:event', sub);
    return () => ipcRenderer.removeListener('llm-hub:event', sub);
  }
});
