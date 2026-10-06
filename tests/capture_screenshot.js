const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

app.whenReady().then(async () => {
  ipcMain.handle('storage:get', () => ({
    lastProject: 'D:\\Projects\\Kimodo2\\MotionSmithV2',
    recentProjects: ['D:\\Projects\\Kimodo2\\MotionSmithV2'],
    demoMode: true,
    maxTurns: 3,
    verifyCmd: 'pytest -q'
  }));

  ipcMain.handle('git:branch-info', () => ({
    branch: 'ai-bridge/active',
    clean: true,
    exists: true
  }));

  ipcMain.handle('bridge:status', () => ({
    success: true,
    status: { status: 'ready_for_approval' }
  }));

  ipcMain.handle('bridge:browser-status', () => ({
    port: 45821,
    paired: true,
    hasContext: true,
    activeContext: {
      provider: 'ChatGPT Web',
      title: 'MotionSmith V2 Debugging',
      messageCount: 47,
      charCount: 18430,
      importedAt: Date.now() - 120000
    },
    detectedTabs: { chatgpt: true, claude: true, gemini: false }
  }));

  const win = new BrowserWindow({
    width: 1920,
    height: 1080,
    show: false,
    frame: false,
    backgroundColor: '#060c18',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  setTimeout(async () => {
    const image = await win.webContents.capturePage();
    const outPath = path.join(__dirname, '..', 'screenshot_final_desktop.png');
    fs.writeFileSync(outPath, image.toPNG());
    console.log('SCREENSHOT_CAPTURED:', outPath);
    app.quit();
    process.exit(0);
  }, 1500);
});
