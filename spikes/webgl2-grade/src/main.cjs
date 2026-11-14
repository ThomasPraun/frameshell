// PROTOTYPE (#384 G0). Electron main: one visible window whose worker runs the WebGL2 grade
// parity and cost tests; writes results/ and quits.
// Usage: electron src/main.cjs [--only=parity|bench]
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const root = path.resolve(__dirname, '..');
const out = path.join(root, 'results');
fs.mkdirSync(out, { recursive: true });
const only = (process.argv.find((a) => a.startsWith('--only=')) ?? '').slice(7);

app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1000,
    height: 600,
    title: 'spike #384 webgl2 grade',
    webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false },
  });
  win.loadFile(path.join(__dirname, 'index.html'), { search: new URLSearchParams({ media: path.join(root, 'media'), only }).toString() });
  ipcMain.on('log', (_e, msg) => console.log(msg));
  ipcMain.on('raw', (_e, name, bytes) => fs.writeFileSync(path.join(out, name), Buffer.from(bytes)));
  ipcMain.on('json', (_e, name, data) => fs.writeFileSync(path.join(out, name), JSON.stringify(data, null, 1)));
  ipcMain.on('done', (_e, code) => app.exit(code || 0));
  console.log(`electron ${process.versions.electron} chrome ${process.versions.chrome}`);
});
