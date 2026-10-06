const electron = require('electron');
const app = (electron && typeof electron === 'object' && electron.app) ? electron.app : null;
const BrowserWindow = (electron && typeof electron === 'object' && electron.BrowserWindow) ? electron.BrowserWindow : null;
const ipcMain = (electron && typeof electron === 'object' && electron.ipcMain) ? electron.ipcMain : null;
const dialog = (electron && typeof electron === 'object' && electron.dialog) ? electron.dialog : null;
const shell = (electron && typeof electron === 'object' && electron.shell) ? electron.shell : null;

const safeIpcHandle = (channel, handler) => {
  if (ipcMain && typeof ipcMain.handle === 'function') {
    ipcMain.handle(channel, handler);
  }
};

const path = require('path');
const fs = require('fs');
const cp = require('child_process');
const http = require('http');
const crypto = require('crypto');

let mainWindow = null;
let activeRunProcess = null;
let activeRunPid = null;

// Local Browser Bridge Server State
let bridgeHttpServer = null;
let bridgeServerPort = 45821;
let currentPairingCode = null;
let pairingCodeExpiresAt = 0;
let bridgeAuthToken = null;
let activeContext = null;
let detectedTabs = { chatgpt: false, claude: false, gemini: false };

// ============================================================================
// LLM Hub Desktop -> Extension Command Queue
// ----------------------------------------------------------------------------
// The Electron desktop process and the browser extension are two separate
// browser processes; the only thing connecting them is this local HTTP
// server. Commands queued here (by the llm-hub:* IPC handlers below) are
// picked up by the extension's background.js, which polls
// GET /v1/llm-hub/command.
// ============================================================================
let pendingLLMHubCommands = [];

function enqueueLLMHubCommand(type, options) {
  const cmd = {
    id: `cmd_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    type,
    options: options || {},
    createdAt: Date.now()
  };
  pendingLLMHubCommands.push(cmd);
  return cmd;
}

// Locate Git Bash binary on Windows
function findBash() {
  if (process.env.GIT_BASH && fs.existsSync(process.env.GIT_BASH)) {
    return process.env.GIT_BASH;
  }
  const candidatePaths = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\usr\\bin\\bash.exe'
  ];
  for (const p of candidatePaths) {
    if (fs.existsSync(p)) return p;
  }
  return 'bash'; // fallback to PATH
}

// Convert Windows paths to MSYS paths for bash
function toMsysPath(p) {
  if (!p) return '';
  let norm = p.replace(/\\/g, '/');
  if (/^[A-Za-z]:/.test(norm)) {
    norm = '/' + norm[0].toLowerCase() + norm.slice(2);
  }
  return norm;
}

// Config file management in userData
function getConfigPath() {
  return path.join(app.getPath('userData'), 'ai_bridge_config.json');
}

function loadConfig() {
  const cfgPath = getConfigPath();
  const defaultCfg = {
    recentProjects: ['F:\\AI-Bridge-Test'],
    lastProject: 'F:\\AI-Bridge-Test',
    verifyCmd: 'pytest -q',
    maxTurns: 3,
    agents: { codex: true, claude: true, agy: true },
    autoApprove: false,
    agyTransport: 'stream',
    demoMode: false,
    timeouts: { codex: 1500, claude: 900, agy: 1500 },
    chatContext: {
      connected: true,
      provider: 'ChatGPT Web',
      title: 'MotionSmith V2 Debugging',
      messagesCount: 47,
      charCount: 18430,
      updatedAgo: '2m ago'
    }
  };
  try {
    if (fs.existsSync(cfgPath)) {
      const data = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      return { ...defaultCfg, ...data };
    }
  } catch (err) {
    console.error('Error reading config, using defaults:', err);
  }
  return defaultCfg;
}

function saveConfig(data) {
  try {
    const cfgPath = getConfigPath();
    fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
    fs.writeFileSync(cfgPath, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('Error saving config:', err);
    return false;
  }
}

// Safely kill process tree on Windows or POSIX
function killProcessTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    cp.exec(`taskkill /pid ${pid} /t /f`, (err) => {
      if (err && !err.message.includes('not found')) {
        console.warn(`taskkill PID ${pid}:`, err.message);
      }
    });
  } else {
    try {
      process.kill(-pid, 'SIGINT');
    } catch (_) {
      try { process.kill(pid, 'SIGKILL'); } catch (_) {}
    }
  }
}

// ============================================================================
// Local Browser Bridge Server & Context Manager
// ============================================================================

function getContextDir() {
  const baseDir = app && app.getPath ? app.getPath('userData') : path.join(process.cwd(), '.userData');
  return path.join(baseDir, 'context');
}

function formatContextDocument(data) {
  const provider = data.provider === 'chatgpt' ? 'ChatGPT' : (data.provider || 'Web');
  const title = data.title || 'Conversation';
  const captured = data.captured_at || new Date().toISOString();
  const msgCount = Array.isArray(data.messages) ? data.messages.length : 0;
  const charCount = data.char_count || 0;

  const lines = [
    '# Imported Web Conversation',
    '',
    `Provider: ${provider}`,
    `Title: ${title}`,
    `Captured: ${captured}`,
    `Messages: ${msgCount}`,
    `Chars: ${charCount}`
  ];

  if (data.truncated) {
    lines.push('Truncated: true (retaining most recent messages within safety ceiling)');
  }

  lines.push('', '---', '');

  if (Array.isArray(data.messages)) {
    for (const msg of data.messages) {
      const roleLabel = (msg.role || 'user').toUpperCase();
      lines.push(`[${roleLabel}]`);
      lines.push(msg.text || '');
      lines.push('');
    }
  }

  return lines.join('\n');
}

function saveImportedContext(data) {
  try {
    const contextDir = getContextDir();
    fs.mkdirSync(contextDir, { recursive: true });

    // Clean up older context files in userData
    try {
      const existingFiles = fs.readdirSync(contextDir);
      for (const f of existingFiles) {
        if (f.startsWith('imported_context_')) {
          try { fs.unlinkSync(path.join(contextDir, f)); } catch (_) {}
        }
      }
    } catch (_) {}

    const fileName = `imported_context_${Date.now()}.md`;
    const filePath = path.join(contextDir, fileName);
    const docContent = formatContextDocument(data);

    fs.writeFileSync(filePath, docContent, 'utf8');

    activeContext = {
      filePath,
      fileName,
      provider: data.provider === 'chatgpt' ? 'ChatGPT Web' : (data.provider || 'Web'),
      title: data.title || 'ChatGPT Conversation',
      messageCount: data.messages.length,
      charCount: data.char_count || docContent.length,
      truncated: !!data.truncated,
      capturedAt: data.captured_at || new Date().toISOString(),
      importedAt: Date.now()
    };

    const cfg = loadConfig();
    cfg.lastActiveContext = activeContext;
    saveConfig(cfg);

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('bridge:context-updated', activeContext);
    }

    return true;
  } catch (err) {
    console.error('Failed to save imported context:', err);
    return false;
  }
}

function clearActiveContext() {
  if (activeContext && activeContext.filePath) {
    try {
      if (fs.existsSync(activeContext.filePath)) {
        fs.unlinkSync(activeContext.filePath);
      }
    } catch (_) {}
  }
  activeContext = null;
  const cfg = loadConfig();
  delete cfg.lastActiveContext;
  saveConfig(cfg);

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('bridge:context-updated', null);
  }
}

function handleBridgeHttpRequest(req, res) {
  // Enforce CORS for browser extension calls
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-AI-Bridge-Token');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  let url;
  try {
    url = new URL(req.url, `http://127.0.0.1:${bridgeServerPort}`);
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid request URL.' }));
    return;
  }

  const pathname = url.pathname;

  function readJsonBody(cb) {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        const parsed = body ? JSON.parse(body) : {};
        cb(null, parsed);
      } catch (err) {
        cb(err, null);
      }
    });
  }

  function checkAuth() {
    const token = req.headers['x-ai-bridge-token'];
    if (!token || !bridgeAuthToken || token !== bridgeAuthToken) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized: Invalid or missing X-AI-Bridge-Token.' }));
      return false;
    }
    return true;
  }

  if (pathname === '/v1/status' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      port: bridgeServerPort,
      paired: !!bridgeAuthToken,
      hasContext: !!activeContext
    }));
    return;
  }

  if (pathname === '/v1/pair' && req.method === 'POST') {
    readJsonBody((err, data) => {
      if (err || !data || !data.code) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Pairing code is required.' }));
        return;
      }
      const code = String(data.code).trim();
      if (!currentPairingCode || currentPairingCode !== code || Date.now() > pairingCodeExpiresAt) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid or expired pairing code.' }));
        return;
      }

      // Successful pairing: generate crypto random token and expire code immediately
      bridgeAuthToken = crypto.randomBytes(32).toString('hex');
      currentPairingCode = null;
      pairingCodeExpiresAt = 0;

      const cfg = loadConfig();
      cfg.browserBridgeToken = bridgeAuthToken;
      saveConfig(cfg);

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('bridge:browser-paired', { paired: true });
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, token: bridgeAuthToken, port: bridgeServerPort }));
    });
    return;
  }

  if (pathname === '/v1/context/import' && req.method === 'POST') {
    if (!checkAuth()) return;

    readJsonBody((err, data) => {
      if (err || !data || !data.messages || !Array.isArray(data.messages) || !data.provider || data.messages.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Malformed import payload: provider and non-empty messages array required.' }));
        return;
      }

      const imported = saveImportedContext(data);
      if (!imported) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to write context file to disk.' }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, context: activeContext }));
    });
    return;
  }

  if (pathname === '/v1/context/current' && req.method === 'GET') {
    if (!checkAuth()) return;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ context: activeContext }));
    return;
  }

  if (pathname === '/v1/context/current' && req.method === 'DELETE') {
    if (!checkAuth()) return;
    clearActiveContext();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
    return;
  }

  if (pathname === '/v1/tabs/detect' && req.method === 'POST') {
    if (!checkAuth()) return;
    readJsonBody((err, data) => {
      if (!err && data) {
        detectedTabs = {
          chatgpt: !!data.chatgpt,
          claude: !!data.claude,
          gemini: !!data.gemini
        };
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('bridge:tabs-updated', detectedTabs);
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    });
    return;
  }

  if (pathname === '/v1/tabs/status' && req.method === 'GET') {
    if (!checkAuth()) return;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ tabs: detectedTabs }));
    return;
  }

  // ============================================================================
  // LLM Hub Web Orchestration HTTP Endpoints
  // ============================================================================

  if (pathname === '/v1/llm-hub/event' && req.method === 'POST') {
    if (!checkAuth()) return;
    readJsonBody((err, data) => {
      if (!err && data) {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('llm-hub:event', data);
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    });
    return;
  }

  // Polled by the browser extension's background.js to pick up session
  // commands (start/stop/follow-up) queued from the desktop UI. Delivers at
  // most one command per call so a slow/duplicate poll can't double-fire it.
  if (pathname === '/v1/llm-hub/command' && req.method === 'GET') {
    if (!checkAuth()) return;
    const cmd = pendingLLMHubCommands.shift() || null;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ command: cmd }));
    return;
  }

  if (pathname === '/v1/llm-hub/saved-chats' && req.method === 'GET') {
    if (!checkAuth()) return;
    const chats = listSavedChats();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, chats }));
    return;
  }

  if (pathname === '/v1/llm-hub/saved-chats' && req.method === 'POST') {
    if (!checkAuth()) return;
    readJsonBody((err, data) => {
      if (err || !data) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid chat payload.' }));
        return;
      }
      const saved = saveSavedChat(data);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, chat: saved }));
    });
    return;
  }

  if (pathname.startsWith('/v1/llm-hub/saved-chats/') && req.method === 'GET') {
    if (!checkAuth()) return;
    const id = pathname.replace('/v1/llm-hub/saved-chats/', '').trim();
    const chat = getSavedChat(id);
    if (!chat) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Saved chat not found.' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, chat }));
    return;
  }

  if (pathname.startsWith('/v1/llm-hub/saved-chats/') && req.method === 'DELETE') {
    if (!checkAuth()) return;
    const id = pathname.replace('/v1/llm-hub/saved-chats/', '').trim();
    deleteSavedChat(id);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Endpoint not found.' }));
}

function startBrowserBridgeServer(preferredPort = 45821, maxAttempts = 5) {
  stopBrowserBridgeServer();
  return new Promise((resolve, reject) => {
    let portToTry = preferredPort;
    let attempts = 0;

    function tryListen() {
      const server = http.createServer(handleBridgeHttpRequest);

      server.on('error', (err) => {
        if (err.code === 'EADDRINUSE' && attempts < maxAttempts) {
          attempts++;
          portToTry++;
          tryListen();
        } else {
          console.warn('Browser bridge server listen error:', err.message);
          reject(err);
        }
      });

      // Strict binding: 127.0.0.1 only
      server.listen(portToTry, '127.0.0.1', () => {
        bridgeHttpServer = server;
        bridgeServerPort = portToTry;
        resolve({ server, port: portToTry });
      });
    }

    tryListen();
  });
}

function stopBrowserBridgeServer() {
  if (bridgeHttpServer) {
    try {
      bridgeHttpServer.close();
    } catch (_) {}
    bridgeHttpServer = null;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1540,
    height: 960,
    minWidth: 1280,
    minHeight: 768,
    frame: false, // Frameless for custom header matching masaüstü görünümü.png
    backgroundColor: '#060c18',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    if (mainWindow && !mainWindow.isVisible()) {
      mainWindow.show();
    }
    if (process.env.ELECTRON_TEST_MODE === 'true') {
      console.log('MAIN_PROCESS_AND_WINDOW_VERIFIED');
      setTimeout(() => {
        app.quit();
      }, 500);
    }
  });

  mainWindow.webContents.once('did-finish-load', () => {
    if (mainWindow && !mainWindow.isVisible()) {
      mainWindow.show();
    }
  });

  mainWindow.on('closed', () => {
    if (activeRunPid) {
      killProcessTree(activeRunPid);
      activeRunPid = null;
    }
    mainWindow = null;
  });
}

// App lifecycle
if (app && typeof app.whenReady === 'function') {
  app.whenReady().then(async () => {
    // Restore saved bridge auth token & active context if valid
    const cfg = loadConfig();
    if (cfg.browserBridgeToken) {
      bridgeAuthToken = cfg.browserBridgeToken;
    }
    if (cfg.lastActiveContext && cfg.lastActiveContext.filePath && fs.existsSync(cfg.lastActiveContext.filePath)) {
      activeContext = cfg.lastActiveContext;
    }

    if (!bridgeHttpServer) {
      try {
        await startBrowserBridgeServer();
      } catch (err) {
        console.warn('Browser bridge server startup warning:', err.message);
      }
    }

    createWindow();

    app.on('activate', () => {
      if (BrowserWindow && BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('before-quit', () => {
    stopBrowserBridgeServer();
    if (activeRunPid) {
      killProcessTree(activeRunPid);
      activeRunPid = null;
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
}

// Window controls IPC
safeIpcHandle('window:minimize', () => {
  if (mainWindow) mainWindow.minimize();
});

safeIpcHandle('window:maximize', () => {
  if (mainWindow) {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  }
  return mainWindow ? mainWindow.isMaximized() : false;
});

safeIpcHandle('window:close', () => {
  if (mainWindow) mainWindow.close();
});

safeIpcHandle('window:is-maximized', () => {
  return mainWindow ? mainWindow.isMaximized() : false;
});

// File dialog IPC
safeIpcHandle('dialog:select-project', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Git Repository Directory',
    properties: ['openDirectory']
  });
  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }
  const selectedPath = result.filePaths[0];

  // Update recent projects
  const cfg = loadConfig();
  if (!cfg.recentProjects.includes(selectedPath)) {
    cfg.recentProjects.unshift(selectedPath);
    if (cfg.recentProjects.length > 8) cfg.recentProjects.pop();
  }
  cfg.lastProject = selectedPath;
  saveConfig(cfg);

  return selectedPath;
});

safeIpcHandle('dialog:select-file', async (event, defaultDir) => {
  if (!mainWindow) return [];
  const startDir = defaultDir || loadConfig().lastProject || process.cwd();
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select File(s) for Task',
    defaultPath: fs.existsSync(startDir) ? startDir : undefined,
    properties: ['openFile', 'multiSelections']
  });
  if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
    return [];
  }
  return result.filePaths.map(filePath => {
    let size = 0;
    try {
      size = fs.statSync(filePath).size;
    } catch (_) {}
    const rel = path.relative(startDir, filePath);
    const isInside = !rel.startsWith('..') && !path.isAbsolute(rel);
    return {
      filePath,
      name: path.basename(filePath),
      relativePath: isInside ? rel.replace(/\\/g, '/') : null,
      size
    };
  });
});

safeIpcHandle('dialog:save-text', async (event, defaultName, content) => {
  if (!mainWindow) return { success: false, error: 'No window' };
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export Markdown',
    defaultPath: defaultName || 'ai-bridge-session.md',
    filters: [{ name: 'Markdown', extensions: ['md'] }]
  });
  if (result.canceled || !result.filePath) return { success: false, canceled: true };
  fs.writeFileSync(result.filePath, String(content || ''), 'utf8');
  return { success: true, filePath: result.filePath };
});

// Model catalog: real Codex models/efforts from the local Codex CLI cache,
// plus the user's current Codex default (config.toml) so the UI can mirror it.
const CLAUDE_MODELS = [
  { slug: 'opus', label: 'Opus' },
  { slug: 'sonnet', label: 'Sonnet' },
  { slug: 'haiku', label: 'Haiku' }
];
const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const AGY_MODELS = [
  { slug: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
  { slug: 'gemini-3.8-flash-medium', label: 'Gemini 3.8 Flash (Medium)' },
  { slug: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash (Low)' },
  { slug: 'gemini-3.1-pro-high', label: 'Gemini 3.1 Pro (High)' },
  { slug: 'gemini-3.1-pro-low', label: 'Gemini 3.1 Pro (Low)' },
  { slug: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (Thinking)' },
  { slug: 'claude-opus-4-6-thinking', label: 'Claude Opus 4.6 (Thinking)' },
  { slug: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)' }
];

function readTomlValue(text, key) {
  const m = new RegExp('^\s*' + key + '\s*=\s*"([^"]*)"', 'm').exec(text || '');
  return m ? m[1] : '';
}

safeIpcHandle('models:catalog', async () => {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const codexDir = process.env.CODEX_HOME || path.join(home, '.codex');
  const out = {
    codex: { models: [], defaultModel: '', defaultEffort: '' },
    claude: { models: CLAUDE_MODELS, efforts: CLAUDE_EFFORTS, defaultModel: '', defaultEffort: '' },
    agy: { models: AGY_MODELS, efforts: ['low', 'medium', 'high'], defaultModel: '', defaultEffort: '' }
  };
  try {
    const cfg = fs.readFileSync(path.join(codexDir, 'config.toml'), 'utf8');
    out.codex.defaultModel = readTomlValue(cfg, 'model');
    out.codex.defaultEffort = readTomlValue(cfg, 'model_reasoning_effort');
  } catch (_) { /* no codex config */ }
  try {
    const cache = JSON.parse(fs.readFileSync(path.join(codexDir, 'models_cache.json'), 'utf8'));
    const list = Array.isArray(cache) ? cache : (cache.models || []);
    out.codex.models = list
      .filter(m => m && m.slug && m.visibility !== 'hide')
      .map(m => ({
        slug: m.slug,
        label: m.display_name || m.slug,
        efforts: (m.supported_reasoning_levels || []).map(x => x.effort).filter(Boolean),
        defaultEffort: m.default_reasoning_level || ''
      }));
  } catch (_) { /* no cache: renderer falls back to free text */ }
  try {
    const cs = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
    if (cs.model) out.claude.defaultModel = cs.model;
    if (cs.effortLevel) out.claude.defaultEffort = cs.effortLevel;
  } catch (_) { /* optional */ }
  return out;
});

// Storage IPC
safeIpcHandle('storage:get', () => {
  return loadConfig();
});

safeIpcHandle('storage:set', (event, newConfig) => {
  const current = loadConfig();
  const merged = { ...current, ...newConfig };
  saveConfig(merged);
  return merged;
});

// Git status inspection IPC
safeIpcHandle('git:branch-info', async (event, projectPath) => {
  if (!projectPath || !fs.existsSync(projectPath)) {
    return { exists: false, isRepo: false, branch: '', detached: false, sha: '', clean: true };
  }
  const git = (args) => new Promise((resolve) => {
    cp.execFile('git', args, { cwd: projectPath, windowsHide: true }, (err, stdout) => {
      resolve({ ok: !err, out: (stdout || '').trim() });
    });
  });

  const inside = await git(['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok || inside.out !== 'true') {
    return { exists: true, isRepo: false, branch: '', detached: false, sha: '', clean: true };
  }

  // symbolic-ref succeeds on a branch (even before the first commit) and fails on a detached HEAD.
  const sym = await git(['symbolic-ref', '--short', '-q', 'HEAD']);
  const detached = !sym.ok || !sym.out;
  const sha = detached ? (await git(['rev-parse', '--short', 'HEAD'])).out : '';
  const status = await git(['status', '--porcelain']);
  const clean = status.ok ? status.out === '' : true;

  return { exists: true, isRepo: true, branch: detached ? '' : sym.out, detached, sha, clean };
});

// Open log in external viewer IPC
safeIpcHandle('bridge:open-log', async (event, projectPath) => {
  const p = projectPath || loadConfig().lastProject;
  if (!p) return false;

  const bridgeDir = path.join(p, '.git', 'ai_bridge');

  // 1. Direct candidate: bridge_latest.log
  const candidateLatest = path.join(bridgeDir, 'bridge_latest.log');
  if (fs.existsSync(candidateLatest)) {
    await shell.openPath(candidateLatest);
    return true;
  }

  // 2. Read from last_run.json
  const lastRunFile = path.join(bridgeDir, 'last_run.json');
  if (fs.existsSync(lastRunFile)) {
    try {
      const lr = JSON.parse(fs.readFileSync(lastRunFile, 'utf8'));
      if (lr && lr.run_id) {
        const runLog = path.join(bridgeDir, `bridge_${lr.run_id}.log`);
        if (fs.existsSync(runLog)) {
          await shell.openPath(runLog);
          return true;
        }
      }
    } catch (_) {}
  }

  // 3. Find the newest bridge_*.log in .git/ai_bridge
  if (fs.existsSync(bridgeDir)) {
    try {
      const files = fs.readdirSync(bridgeDir)
        .filter(f => f.startsWith('bridge_') && f.endsWith('.log'))
        .map(f => ({ name: f, fullPath: path.join(bridgeDir, f), mtime: fs.statSync(path.join(bridgeDir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      if (files.length > 0) {
        await shell.openPath(files[0].fullPath);
        return true;
      }
    } catch (_) {}
  }

  // 4. Fallback in project root or cwd
  const cwdCandidates = [
    path.join(p, 'ai_bridge.log'),
    path.join(process.cwd(), 'ai_bridge.log')
  ];
  for (const c of cwdCandidates) {
    if (fs.existsSync(c)) {
      await shell.openPath(c);
      return true;
    }
  }

  return false;
});

// Doctor command IPC
safeIpcHandle('bridge:doctor', async () => {
  return new Promise((resolve) => {
    const bashPath = findBash();
    const scriptPath = toMsysPath(path.join(__dirname, 'ai_bridge.sh'));
    const child = cp.spawn(bashPath, [scriptPath, 'doctor'], {
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => {
      try {
        const parsed = JSON.parse(stdout.trim());
        resolve({ success: code === 0, data: parsed });
      } catch (err) {
        resolve({ success: code === 0, raw: stdout, error: stderr });
      }
    });
    child.on('error', (err) => {
      resolve({ success: false, error: err.message });
    });
  });
});

// History command IPC
safeIpcHandle('bridge:history', async (event, projectPath) => {
  return new Promise((resolve) => {
    const targetPath = projectPath || loadConfig().lastProject;
    const historyFile = path.join(targetPath, '.git', 'ai_bridge', 'run_history.log');
    
    // First try direct file read if exists
    if (fs.existsSync(historyFile)) {
      try {
        const content = fs.readFileSync(historyFile, 'utf8');
        const lines = content.trim().split(/\r?\n/).filter(Boolean);
        const runs = lines.map(line => {
          try { return JSON.parse(line); } catch (_) { return null; }
        }).filter(Boolean);
        return resolve({ success: true, runs: runs.reverse() });
      } catch (_) {}
    }

    // Otherwise invoke CLI
    const bashPath = findBash();
    const scriptPath = toMsysPath(path.join(__dirname, 'ai_bridge.sh'));
    const msysProject = toMsysPath(targetPath);
    const child = cp.spawn(bashPath, [scriptPath, 'history', '--project', msysProject], {
      windowsHide: true
    });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.on('close', (code) => {
      try {
        const parsed = JSON.parse(stdout.trim());
        resolve({ success: code === 0, runs: Array.isArray(parsed) ? parsed : [] });
      } catch {
        resolve({ success: false, runs: [] });
      }
    });
    child.on('error', () => {
      resolve({ success: false, runs: [] });
    });
  });
});

// Status & Report IPC
safeIpcHandle('bridge:report', async (event, projectPath, runId) => {
  const targetPath = projectPath || loadConfig().lastProject;
  const reportPath = path.join(targetPath, '.git', 'ai_bridge', 'final_report.json');
  if (fs.existsSync(reportPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
      return { success: true, report: data };
    } catch (_) {}
  }

  // Fallback to CLI report command
  return new Promise((resolve) => {
    const bashPath = findBash();
    const scriptPath = toMsysPath(path.join(__dirname, 'ai_bridge.sh'));
    const msysProject = toMsysPath(targetPath);
    const args = [scriptPath, 'report', '--project', msysProject];
    if (runId) args.push('--run-id', runId);

    const child = cp.spawn(bashPath, args, { windowsHide: true });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.on('close', (code) => {
      try {
        const parsed = JSON.parse(stdout.trim());
        resolve({ success: code === 0, report: parsed });
      } catch {
        resolve({ success: false, raw: stdout });
      }
    });
    child.on('error', (err) => {
      resolve({ success: false, error: err.message });
    });
  });
});

// Status IPC
safeIpcHandle('bridge:status', async (event, projectPath, runId) => {
  const targetPath = projectPath || loadConfig().lastProject;
  const statePath = path.join(targetPath, '.git', 'ai_bridge', 'state.json');
  if (fs.existsSync(statePath)) {
    try {
      const data = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      return { success: true, status: data };
    } catch (_) {}
  }

  return new Promise((resolve) => {
    const bashPath = findBash();
    const scriptPath = toMsysPath(path.join(__dirname, 'ai_bridge.sh'));
    const msysProject = toMsysPath(targetPath);
    const args = [scriptPath, 'status', '--project', msysProject];
    if (runId) args.push('--run-id', runId);

    const child = cp.spawn(bashPath, args, { windowsHide: true });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.on('close', (code) => {
      try {
        const parsed = JSON.parse(stdout.trim());
        resolve({ success: code === 0, status: parsed });
      } catch {
        resolve({ success: false, raw: stdout });
      }
    });
    child.on('error', (err) => {
      resolve({ success: false, error: err.message });
    });
  });
});

// Run Bridge Process IPC
safeIpcHandle('bridge:run', async (event, options) => {
  if (activeRunProcess) {
    return { error: 'A run is already in progress.' };
  }

  const {
    projectPath,
    task,
    attachedFiles = [],
    turns = 3,
    agents = 'codex,claude,agy',
    verifyCmd = 'pytest -q',
    autoApprove = false,
    agyTransport = 'stream',
    contextText = null,
    models = {}
  } = options;

  let finalTask = task;
  if (Array.isArray(attachedFiles) && attachedFiles.length > 0) {
    let filesContext = '\n\n[USER ATTACHED TARGET / REFERENCE FILES]:\n';
    for (const f of attachedFiles) {
      const p = f.filePath || f.path;
      if (!p) continue;
      const targetRef = f.relativePath ? `${f.relativePath} (in project)` : `${p} (external file)`;
      filesContext += `\n● File: ${targetRef}\n`;
      try {
        if (fs.existsSync(p)) {
          const stat = fs.statSync(p);
          if (stat.size <= 80 * 1024) {
            const content = fs.readFileSync(p, 'utf8');
            filesContext += `--- FILE CONTENT START (${f.name}) ---\n${content}\n--- FILE CONTENT END (${f.name}) ---\n`;
          } else {
            filesContext += `(File size: ${Math.round(stat.size / 1024)} KB - large file, read directly from repo/filesystem if needed)\n`;
          }
        }
      } catch (err) {
        filesContext += `(File read error: ${err.message})\n`;
      }
    }
    filesContext += '\nINSTRUCTION: Please perform the requested task on the file(s) specified above or prioritize their contents.\n';
    finalTask = finalTask + filesContext;
  }

  const bashPath = findBash();
  const scriptPath = toMsysPath(path.join(__dirname, 'ai_bridge.sh'));
  const msysProject = toMsysPath(projectPath);

  let tempTaskFile = null;
  const args = [
    scriptPath,
    'run',
    '--project', msysProject,
    '--turns', String(turns),
    '--agents', agents,
    '--verify-cmd', verifyCmd,
    '--json-events'
  ];

  if ((Array.isArray(attachedFiles) && attachedFiles.length > 0) || finalTask.length > 500) {
    try {
      tempTaskFile = path.join(app.getPath('temp'), `ai_bridge_task_${Date.now()}.txt`);
      fs.writeFileSync(tempTaskFile, finalTask, 'utf8');
      args.push('--task-file', toMsysPath(tempTaskFile));
    } catch (e) {
      console.warn('Failed to write temp task file, falling back to --task argument:', e);
      args.push('--task', finalTask);
    }
  } else {
    args.push('--task', finalTask);
  }

  if (autoApprove) {
    args.push('--auto-approve', 'true');
  }
  if (agyTransport) {
    args.push('--agy-transport', agyTransport);
  }

  // Per-agent model / reasoning-effort selection (empty = CLI default)
  const safeVal = (v) => (typeof v === 'string' && /^[A-Za-z0-9._:\-\/]{1,80}$/.test(v.trim())) ? v.trim() : '';
  for (const agent of ['codex', 'claude', 'agy']) {
    const cfgAgent = (models && models[agent]) || {};
    const m = safeVal(cfgAgent.model);
    const e = safeVal(cfgAgent.effort);
    if (m) args.push(`--${agent}-model`, m);
    if (e) args.push(`--${agent}-effort`, e);
  }

  // Pass imported chat context file if available, or fallback to temporary text
  let tempContextFile = null;
  if (activeContext && activeContext.filePath && fs.existsSync(activeContext.filePath)) {
    args.push('--context-file', toMsysPath(activeContext.filePath));
  } else if (contextText && contextText.trim()) {
    try {
      tempContextFile = path.join(app.getPath('temp'), `ai_bridge_ctx_${Date.now()}.txt`);
      fs.writeFileSync(tempContextFile, contextText, 'utf8');
      args.push('--context-file', toMsysPath(tempContextFile));
    } catch (e) {
      console.warn('Failed to write temp context file:', e);
    }
  }

  try {
    const child = cp.spawn(bashPath, args, {
      cwd: projectPath,
      windowsHide: true,
      env: {
        ...process.env,
        PAGER: 'cat'
      }
    });

    activeRunProcess = child;
    activeRunPid = child.pid;

    // Line buffering for NDJSON stream purity
    let stdoutBuffer = '';

    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk.toString('utf8');
      const lines = stdoutBuffer.split(/\r?\n/);
      // Keep last incomplete segment in buffer
      stdoutBuffer = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed);
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('bridge:event', parsed);
          }
        } catch (e) {
          // Send raw non-JSON text gracefully
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('bridge:event', {
              event: 'raw_log',
              message: trimmed
            });
          }
        }
      }
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('bridge:stderr', text);
      }
    });

    child.on('close', (code, signal) => {
      // Flush any remaining buffer
      if (stdoutBuffer && stdoutBuffer.trim()) {
        try {
          const parsed = JSON.parse(stdoutBuffer.trim());
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('bridge:event', parsed);
          }
        } catch (_) {}
      }

      // Cleanup temp task and context files
      if (tempTaskFile && fs.existsSync(tempTaskFile)) {
        try { fs.unlinkSync(tempTaskFile); } catch (_) {}
      }
      if (tempContextFile && fs.existsSync(tempContextFile)) {
        try { fs.unlinkSync(tempContextFile); } catch (_) {}
      }

      activeRunProcess = null;
      activeRunPid = null;

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('bridge:event', {
          event: code === 130 ? 'interrupted' : 'process_exit',
          exit_code: code,
          signal
        });
      }
    });

    child.on('error', (err) => {
      if (tempTaskFile && fs.existsSync(tempTaskFile)) {
        try { fs.unlinkSync(tempTaskFile); } catch (_) {}
      }
      if (tempContextFile && fs.existsSync(tempContextFile)) {
        try { fs.unlinkSync(tempContextFile); } catch (_) {}
      }
      activeRunProcess = null;
      activeRunPid = null;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('bridge:event', {
          event: 'error',
          message: err.message
        });
      }
    });

    return { started: true, pid: child.pid };
  } catch (err) {
    if (tempTaskFile && fs.existsSync(tempTaskFile)) {
      try { fs.unlinkSync(tempTaskFile); } catch (_) {}
    }
    if (tempContextFile && fs.existsSync(tempContextFile)) {
      try { fs.unlinkSync(tempContextFile); } catch (_) {}
    }
    activeRunProcess = null;
    activeRunPid = null;
    return { started: false, error: err.message };
  }
});

// Stop Bridge Process IPC
safeIpcHandle('bridge:stop', async () => {
  if (!activeRunProcess && !activeRunPid) {
    return { stopped: false, reason: 'No active process' };
  }
  const pid = activeRunPid;
  killProcessTree(pid);
  activeRunProcess = null;
  activeRunPid = null;
  return { stopped: true, pid };
});

// Accept Changes IPC
safeIpcHandle('bridge:accept', async (event, projectPath) => {
  return new Promise((resolve) => {
    const bashPath = findBash();
    const scriptPath = toMsysPath(path.join(__dirname, 'ai_bridge.sh'));
    const targetPath = projectPath || loadConfig().lastProject;
    const msysProject = toMsysPath(targetPath);

    const child = cp.spawn(bashPath, [scriptPath, 'accept', '--project', msysProject, '--json-events'], {
      cwd: targetPath,
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d.toString('utf8');
      // Stream events live to UI as well
      const lines = d.toString('utf8').split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line.trim());
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('bridge:event', parsed);
          }
        } catch (_) {}
      }
    });
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });

    child.on('close', (code) => {
      try {
        const lastLine = stdout.trim().split(/\r?\n/).pop();
        const parsed = JSON.parse(lastLine);
        resolve({ success: code === 0, data: parsed });
      } catch {
        resolve({ success: code === 0, raw: stdout, error: stderr });
      }
    });
  });
});

// Rollback Changes IPC
safeIpcHandle('bridge:rollback', async (event, projectPath) => {
  return new Promise((resolve) => {
    const bashPath = findBash();
    const scriptPath = toMsysPath(path.join(__dirname, 'ai_bridge.sh'));
    const targetPath = projectPath || loadConfig().lastProject;
    const msysProject = toMsysPath(targetPath);

    const child = cp.spawn(bashPath, [scriptPath, 'rollback', '--project', msysProject, '--json-events'], {
      cwd: targetPath,
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d.toString('utf8');
      const lines = d.toString('utf8').split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line.trim());
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('bridge:event', parsed);
          }
        } catch (_) {}
      }
    });
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });

    child.on('close', (code) => {
      try {
        const lastLine = stdout.trim().split(/\r?\n/).pop();
        const parsed = JSON.parse(lastLine);
        resolve({ success: code === 0, data: parsed });
      } catch {
        resolve({ success: code === 0, raw: stdout, error: stderr });
      }
    });
  });
});

// ============================================================================
// Browser Bridge IPC Handlers
// ============================================================================

safeIpcHandle('bridge:browser-status', () => {
  return {
    port: bridgeServerPort,
    paired: !!bridgeAuthToken,
    hasContext: !!activeContext,
    activeContext,
    detectedTabs
  };
});

safeIpcHandle('bridge:create-pairing-code', () => {
  const code = crypto.randomInt(100000, 999999).toString();
  currentPairingCode = code;
  pairingCodeExpiresAt = Date.now() + 5 * 60 * 1000; // 5 mins TTL
  return {
    code,
    expiresAt: pairingCodeExpiresAt,
    port: bridgeServerPort
  };
});

safeIpcHandle('bridge:get-chat-context', () => {
  return activeContext;
});

safeIpcHandle('bridge:clear-chat-context', () => {
  clearActiveContext();
  return { success: true };
});

safeIpcHandle('bridge:unpair-extension', () => {
  bridgeAuthToken = null;
  const cfg = loadConfig();
  delete cfg.browserBridgeToken;
  saveConfig(cfg);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('bridge:browser-paired', { paired: false });
  }
  return { success: true };
});

// ============================================================================
// LLM Hub Saved Chats Storage & Management
// ============================================================================

function getSavedChatsDir() {
  const baseDir = (app && typeof app.getPath === 'function')
    ? app.getPath('userData')
    : path.join(process.cwd(), '.userData');
  return path.join(baseDir, 'saved_chats');
}

function listSavedChats() {
  try {
    const dir = getSavedChatsDir();
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      return [];
    }

    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    const chats = [];

    for (const file of files) {
      try {
        const filePath = path.join(dir, file);
        const content = fs.readFileSync(filePath, 'utf8');
        const data = JSON.parse(content);
        chats.push({
          id: data.id || data.sessionId || path.basename(file, '.json'),
          sessionId: data.sessionId || data.id,
          topic: data.topic || 'Untitled Discussion',
          mode: data.mode || 'collaborative',
          totalRounds: data.totalRounds || (data.history ? Math.max(...data.history.map(h => h.round || 1)) : 1),
          providers: data.providers || ['chatgpt', 'claude', 'gemini'],
          messageCount: Array.isArray(data.history) ? data.history.length : 0,
          hasConsensus: Boolean(data.consensus),
          startedAt: data.startedAt || 0,
          finishedAt: data.finishedAt || 0,
          status: data.status || 'completed'
        });
      } catch (_) {}
    }

    return chats.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  } catch (err) {
    console.error('listSavedChats error:', err);
    return [];
  }
}

function getSavedChat(id) {
  try {
    const dir = getSavedChatsDir();
    const filePath = path.join(dir, `${id}.json`);
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (err) {
    console.error('getSavedChat error:', err);
  }
  return null;
}

function saveSavedChat(sessionData) {
  try {
    const dir = getSavedChatsDir();
    fs.mkdirSync(dir, { recursive: true });

    const id = sessionData.id || sessionData.sessionId || `chat_${Date.now()}`;
    const cleanData = {
      ...sessionData,
      id,
      sessionId: sessionData.sessionId || id,
      savedAt: Date.now()
    };

    const filePath = path.join(dir, `${id}.json`);
    fs.writeFileSync(filePath, JSON.stringify(cleanData, null, 2), 'utf8');
    return cleanData;
  } catch (err) {
    console.error('saveSavedChat error:', err);
    return sessionData;
  }
}

function deleteSavedChat(id) {
  try {
    const dir = getSavedChatsDir();
    const filePath = path.join(dir, `${id}.json`);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      return true;
    }
  } catch (err) {
    console.error('deleteSavedChat error:', err);
  }
  return false;
}

function exportSavedChat(id, format = 'markdown') {
  const chat = getSavedChat(id);
  if (!chat) return null;

  if (format === 'json') {
    return JSON.stringify(chat, null, 2);
  }

  // Markdown format
  const lines = [
    `# AI Bridge — Multi-LLM Discussion Report`,
    ``,
    `**Topic:** ${chat.topic || 'Untitled'}`,
    `**Mode:** ${(chat.mode || 'collaborative').toUpperCase()}`,
    `**Date:** ${new Date(chat.startedAt || Date.now()).toLocaleString()}`,
    `**Participants:** ${(chat.providers || []).map(p => p.toUpperCase()).join(', ')}`,
    `**Total Rounds:** ${chat.totalRounds || 1}`,
    ``,
    `---`,
    ``,
    `## Discussion Transcript`,
    ``
  ];

  if (Array.isArray(chat.history)) {
    for (const msg of chat.history) {
      const provider = (msg.provider || 'MODEL').toUpperCase();
      const roundLabel = msg.round === 'follow-up' ? 'Follow-Up' : `Round ${msg.round || 1}`;
      lines.push(`### [${provider} — ${roundLabel}]`);
      lines.push(``);
      lines.push(msg.text || '');
      lines.push(``);
      lines.push(`---`);
      lines.push(``);
    }
  }

  if (chat.consensus) {
    lines.push(`## Final Consensus Synthesis`);
    lines.push(``);
    lines.push(chat.consensus);
    lines.push(``);
  }

  return lines.join('\n');
}

// ============================================================================
// Demo Mode Simulated Session Runner
// ============================================================================

let activeDemoTimer = null;
let activeDemoSession = null;

function runDemoLLMSession(options) {
  const {
    sessionId = `demo_${Date.now()}`,
    topic = 'How can we make camera motion in 3D games feel more natural and cinematic?',
    mode = 'collaborative',
    rounds = 2,
    providers = ['chatgpt', 'claude', 'gemini']
  } = options;

  const roundCount = Math.max(1, Math.min(5, parseInt(rounds, 10) || 2));
  let isCancelled = false;

  const session = {
    sessionId,
    topic: topic.trim(),
    mode,
    totalRounds: roundCount,
    providers,
    history: [],
    consensus: null,
    startedAt: Date.now(),
    status: 'running',
    isDemo: true
  };
  activeDemoSession = session;

  const emit = (eventData) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('llm-hub:event', {
        sessionId,
        timestamp: Date.now(),
        ...eventData
      });
    }
  };

  const delay = (ms) => new Promise((res) => {
    activeDemoTimer = setTimeout(res, ms);
  });

  const generateResponse = (provider, round, currentMode) => {
    const p = provider.toLowerCase();
    const m = (currentMode || 'collaborative').toLowerCase();

    if (m === 'debate') {
      if (p === 'chatgpt') {
        return `I argue that a spring-damper physical simulation model is the superior foundation for cinematic cameras. By treating the camera position as a physical mass connected via critically damped springs to the target anchor, we naturally eliminate high-frequency jitter while preserving immediate player steering responsiveness. Deterministic lerp curves fail when framerates fluctuate or when instantaneous collisions occur.`;
      }
      if (p === 'claude') {
        return `While ChatGPT's spring-damper model is elegant for single-player games, it introduces severe state synchronization challenges in networked multiplayer environments. I counter that a dual-layer approach — a deterministic spline-based framing baseline with local procedural damping on the client — offers higher predictability without desynchronizing spectator cameras or replay systems.`;
      }
      return `Balancing ChatGPT's physical responsiveness with Claude's deterministic network requirement: the optimal architecture utilizes hierarchical decouplers. The primary framing vector is calculated deterministically via hermite splines, while rotational look-ahead is passed through an asymptotic filter with dynamic damping coefficients based on camera angular velocity.`;
    }

    if (m === 'code_review') {
      if (p === 'chatgpt') {
        return `\`\`\`python
# ChatGPT Architectural Review:
# 1. Replace naive lerp with spherical linear interpolation (slerp) for orientation.
# 2. Use a rolling-window keyframe buffer with Catmull-Rom spline evaluation.

def evaluate_camera_pose(t: float, k0, k1, k2, k3) -> Pose:
    pos = catmull_rom(k0.pos, k1.pos, k2.pos, k3.pos, t)
    rot = Quaternion.slerp(k1.rot, k2.rot, t)
    return Pose(position=pos, rotation=rot)
\`\`\`
This resolves keyframe boundary velocity discontinuities.`;
      }
      if (p === 'claude') {
        return `\`\`\`python
# Claude Code Review & Verification:
# Critical edge-case: Quaternion slerp antipodal handling.
# If dot(q1, q2) < 0, slerp takes the long path, causing a 360-degree flip!

def safe_slerp(q1: Quaternion, q2: Quaternion, t: float) -> Quaternion:
    dot = Quaternion.dot(q1, q2)
    if dot < 0.0:
        q2 = -q2
        dot = -dot
    return Quaternion.slerp_normalized(q1, q2, t, dot)
\`\`\`
Also verify zero-duration keyframe transitions in unit tests.`;
      }
      return `\`\`\`python
# Gemini Performance & SIMD Optimization:
# Vectorized evaluation for keyframe tracks to minimize allocation overhead.
# Cache the tangent vectors between adjacent keyframes during track compilation.
\`\`\`
Architecture verified: Zero regressions found, safe quaternion math confirmed.`;
    }

    if (m === 'brainstorm') {
      if (p === 'chatgpt') {
        return `Here are 3 innovative camera mechanics:
1. **Dynamic Emotional Framing**: Camera focal length tightens automatically when player stamina or health drops, inducing subtle tunnel vision.
2. **Horizon Anchor Lock**: In high-speed parkour, the camera maintains an artificial horizon line to reduce motion sickness while tilting dynamically during wall-runs.
3. **Audio-Driven Camera Jitter**: Bass frequencies from nearby explosions inject micro-shakes sampled from real handheld film cameras.`;
      }
      if (p === 'claude') {
        return `Complementary high-leverage concepts:
4. **Cinematic Rule-of-Thirds Snapping**: When the player halts movement near points of interest, the camera subtly shifts the character to the left/right third of the screen.
5. **Contextual Obstacle Ghosting**: Instead of hard zooming through geometry, foreground occluders become dithered/translucent, preserving shot composition.`;
      }
      return `Synthesizing the creative vision:
6. **Multi-Track Blending Pipeline**: A unified director system that blends gameplay framing, emotional presets, and collision avoidance into a single composite transform vector with adaptive damping.`;
    }

    // Default: Collaborative
    if (p === 'chatgpt') {
      return `Natural camera motion in 3D games relies on three core pillars:
1. **Intentional Look-Ahead**: Tracking not just where the character is, but where they are looking and heading.
2. **Spring-Based Damping**: Critically damped spring calculations prevent rigid snapping without introducing sluggish lag.
3. **Dynamic Framing**: Contextual adjustment of FOV and camera distance based on speed and scene complexity.`;
    }
    if (p === 'claude') {
      return `Building constructively on ChatGPT's outline, predictability and cinematic composition are equally vital:
- Use smooth easing curves (e.g., cubic hermite splines) across keyframe transitions to guarantee continuous first-order velocity.
- Introduce subtle dead-zones so minor character micro-movements don't cause jittery camera compensation.
- Apply rule-of-thirds framing to emphasize points of interest in exploration.`;
    }
    return `Synthesizing the discussion into an actionable architecture:
We combine the spring look-ahead from ChatGPT with Claude's hermite velocity continuity. Implementing a 3-layer stack (Kinematic Anchor $\\to$ Damping Spring $\\to$ Cinematic Framing Filter) delivers responsive yet filmic camera behavior across all gameplay states.`;
  };

  const generateConsensus = (currentMode) => {
    return `### 1. Core Consensus
All models agree that natural camera motion requires eliminating velocity discontinuities across keyframes through cubic spline interpolation and critically damped spring-damper physics, paired with subtle look-ahead tracking.

### 2. Key Disagreements & Trade-offs
- **Physics vs. Determinism**: Pure spring-damper models feel more natural in single-player, whereas deterministic spline baselines with local client-side smoothing are preferred for networked multiplayer.
- **Responsiveness vs. Cinematic Weight**: Aggressive damping enhances cinematic quality but increases perceived input lag during twitch reflex actions.

### 3. Recommended Approach
Adopt a 3-layer camera controller:
1. **Target Anchor Layer**: Evaluates position and forward vector using Catmull-Rom splines.
2. **Smoothing Layer**: Employs safe quaternion slerp with antipodal sign correction and dynamic damping coefficients.
3. **Contextual Framing Layer**: Adapts FOV and framing offset according to gameplay state (combat, exploration, dialog).

### 4. Important Caveats & Action Items
- Handle zero-delta keyframes and antipodal quaternion flips explicitly.
- Implement camera dead-zones to prevent micro-jitter during idle turns.`;
  };

  (async () => {
    try {
      emit({
        event: 'session_started',
        sessionId,
        topic: session.topic,
        mode: session.mode,
        totalRounds: session.totalRounds,
        providers: session.providers
      });

      for (let r = 1; r <= roundCount; r++) {
        if (isCancelled) break;

        emit({
          event: 'round_started',
          sessionId,
          round: r,
          totalRounds: roundCount
        });

        for (let i = 0; i < providers.length; i++) {
          if (isCancelled) break;

          const p = providers[i].toLowerCase();
          emit({
            event: 'provider_started',
            sessionId,
            round: r,
            provider: p
          });

          await delay(1200);
          if (isCancelled) break;

          const text = generateResponse(p, r, mode);
          session.history.push({
            round: r,
            provider: p,
            text,
            timestamp: Date.now()
          });

          emit({
            event: 'provider_finished',
            sessionId,
            round: r,
            provider: p,
            text
          });

          await delay(600);
        }

        if (!isCancelled) {
          emit({
            event: 'round_finished',
            sessionId,
            round: r
          });
        }
      }

      if (!isCancelled) {
        const lastP = providers[providers.length - 1].toLowerCase();
        emit({
          event: 'consensus_started',
          sessionId,
          provider: lastP
        });

        await delay(1500);
        if (isCancelled) return;

        const consensus = generateConsensus(mode);
        session.consensus = consensus;
        session.status = 'completed';
        session.finishedAt = Date.now();

        emit({
          event: 'consensus_finished',
          sessionId,
          provider: lastP,
          consensus
        });

        emit({
          event: 'session_finished',
          sessionId,
          session
        });

        saveSavedChat(session);
      } else {
        emit({ event: 'session_cancelled', sessionId });
      }
    } catch (err) {
      emit({ event: 'session_error', sessionId, error: err.message });
    } finally {
      activeDemoSession = null;
      activeDemoTimer = null;
    }
  })();

  return {
    sessionId,
    cancel: () => {
      isCancelled = true;
      if (activeDemoTimer) clearTimeout(activeDemoTimer);
      emit({ event: 'session_cancelled', sessionId });
    }
  };
}

// ============================================================================
// LLM Hub IPC Handlers
// ============================================================================

safeIpcHandle('llm-hub:start-session', async (event, options) => {
  const cfg = loadConfig();
  if (cfg.demoMode || options.demo) {
    runDemoLLMSession(options);
    return { success: true, mode: 'demo' };
  }

  // Real Extension Mode: Verify connection & tab detection
  const selectedProviders = options.providers || ['chatgpt', 'claude', 'gemini'];
  const missing = [];
  for (const p of selectedProviders) {
    const k = p.toLowerCase();
    if (!detectedTabs[k]) {
      missing.push(p.charAt(0).toUpperCase() + p.slice(1));
    }
  }

  if (missing.length > 0) {
    const err = `${missing.join(' and ')} browser tab is not connected. Please open ${missing[0].toLowerCase()} in your browser.`;
    return { success: false, error: err };
  }

  // Real mode: the desktop process cannot reach into the extension's browser
  // directly, so the start command is queued for the extension to pick up
  // via its GET /v1/llm-hub/command poll (see the queue defined near the top
  // of this file). Session progress then flows back through the existing
  // POST /v1/llm-hub/event -> 'llm-hub:event' path.
  enqueueLLMHubCommand('START_LLM_SESSION', options);

  return { success: true, mode: 'real' };
});

safeIpcHandle('llm-hub:stop-session', () => {
  const cfg = loadConfig();
  if (activeDemoTimer) {
    clearTimeout(activeDemoTimer);
    activeDemoTimer = null;
  }
  if (activeDemoSession) {
    activeDemoSession.status = 'cancelled';
    activeDemoSession = null;
  }
  if (!cfg.demoMode) {
    enqueueLLMHubCommand('STOP_LLM_SESSION', {});
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('llm-hub:event', { event: 'session_cancelled' });
  }
  return { success: true };
});

safeIpcHandle('llm-hub:follow-up', (event, options) => {
  const cfg = loadConfig();
  if (cfg.demoMode) {
    const { text, targetProvider = 'chatgpt' } = options;
    const p = targetProvider === 'all' ? 'chatgpt' : targetProvider;

    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('llm-hub:event', {
          event: 'provider_started',
          round: 'follow-up',
          provider: p
        });

        setTimeout(() => {
          mainWindow.webContents.send('llm-hub:event', {
            event: 'provider_finished',
            round: 'follow-up',
            provider: p,
            text: `Direct answer to "${text}": Implementing dynamic damping multipliers directly addresses your concern by scaling down inertia when rapid input changes occur.`
          });
        }, 1000);
      }
    }, 300);
    return { success: true };
  }

  // Real mode: queue it for the extension the same way session start works.
  enqueueLLMHubCommand('FOLLOW_UP_LLM', options);
  return { success: true };
});

safeIpcHandle('llm-hub:get-saved-chats', () => {
  return listSavedChats();
});

safeIpcHandle('llm-hub:get-saved-chat', (event, id) => {
  return getSavedChat(id);
});

safeIpcHandle('llm-hub:save-chat', (event, chatData) => {
  return saveSavedChat(chatData);
});

safeIpcHandle('llm-hub:delete-saved-chat', (event, id) => {
  return { success: deleteSavedChat(id) };
});

safeIpcHandle('llm-hub:export-chat', (event, id, format) => {
  return exportSavedChat(id, format);
});

safeIpcHandle('llm-hub:get-tabs-status', () => {
  return { tabs: detectedTabs };
});

module.exports = {
  formatContextDocument,
  saveImportedContext,
  clearActiveContext,
  handleBridgeHttpRequest,
  startBrowserBridgeServer,
  stopBrowserBridgeServer,
  getBridgePort: () => bridgeServerPort,
  getBridgeToken: () => bridgeAuthToken,
  setBridgeToken: (tok) => { bridgeAuthToken = tok; },
  setPairingCode: (code, expiresAt) => {
    currentPairingCode = code;
    pairingCodeExpiresAt = expiresAt || (Date.now() + 300000);
  },
  getActiveContext: () => activeContext,
  setActiveContext: (ctx) => { activeContext = ctx; },
  setDetectedTabs: (t) => { detectedTabs = { ...detectedTabs, ...t }; },
  getDetectedTabs: () => detectedTabs,
  getSavedChatsDir,
  listSavedChats,
  getSavedChat,
  saveSavedChat,
  deleteSavedChat,
  exportSavedChat,
  runDemoLLMSession,
  enqueueLLMHubCommand,
  getPendingLLMHubCommandCount: () => pendingLLMHubCommands.length
};


