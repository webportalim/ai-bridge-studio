const { app, BrowserWindow } = require('electron');
const path = require('path');

app.whenReady().then(() => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true
    }
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  win.webContents.once('did-finish-load', () => {
    console.log('ELECTRON_TEST_LOAD_SUCCESS');
    setTimeout(() => {
      app.quit();
      process.exit(0);
    }, 500);
  });

  win.webContents.on('did-fail-load', (e, code, desc) => {
    console.error('ELECTRON_TEST_LOAD_FAIL', code, desc);
    process.exit(1);
  });

  setTimeout(() => {
    console.error('ELECTRON_TEST_TIMEOUT');
    process.exit(1);
  }, 10000);
});
