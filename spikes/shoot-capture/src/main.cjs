// Spike main process: runs one config (--cfg=<json file>) in a single hidden-ish window.
const { app, BrowserWindow, ipcMain, session, desktopCapturer } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const cfgArg = process.argv.find((a) => a.startsWith('--cfg='));
const cfg = JSON.parse(fs.readFileSync(cfgArg.slice(6), 'utf8'));

if (cfg.fakeUi !== false) app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
if (cfg.fakeDevices !== false) app.commandLine.appendSwitch('use-fake-device-for-media-stream', cfg.fakeArgs ?? 'fps=30');
for (const s of cfg.switches ?? []) app.commandLine.appendSwitch(...s);

let quitting = false;
const cpu = [];
let cpuTimer = null;

ipcMain.handle('chunk', (_e, file, buf) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, Buffer.from(buf));
  fs.appendFileSync(file + '.chunks.log', `${Date.now()} ${buf.byteLength}\n`);
  return true;
});
ipcMain.handle('mark', (_e, file, label) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${Date.now()} ${label}\n`);
});
ipcMain.handle('cpu-begin', () => {
  cpu.length = 0;
  cpuTimer = setInterval(() => {
    const m = app.getAppMetrics();
    cpu.push(m.reduce((a, p) => a + p.cpu.percentCPUUsage, 0));
  }, 1000);
});
ipcMain.handle('cpu-end', () => {
  clearInterval(cpuTimer);
  const s = cpu.slice(2); // skip warm-up
  const avg = s.reduce((a, b) => a + b, 0) / Math.max(1, s.length);
  return { avgPercentOfOneCore: +avg.toFixed(1), maxPercentOfOneCore: +Math.max(0, ...s).toFixed(1), samples: s.length };
});
ipcMain.handle('write-json', (_e, file, obj) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
});
ipcMain.handle('sources', async () => {
  try {
    const s = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
    return s.map((x) => ({ id: x.id, name: x.name }));
  } catch (e) {
    return { error: String(e) };
  }
});
ipcMain.handle('quit', () => {
  quitting = true;
  setTimeout(() => app.exit(0), 200);
  return true;
});
ipcMain.handle('cfg', () => cfg);
ipcMain.handle('screen-id', async () => (await desktopCapturer.getSources({ types: ['screen'] }))[0]?.id);

app.whenReady().then(() => {
  const { systemPreferences } = require('electron');
  console.log('TCC status', ['camera','microphone','screen'].map(k=>k+'='+systemPreferences.getMediaAccessStatus(k)).join(' '));
  // Auto-pick the first screen for getDisplayMedia; loopback audio only if cfg asks (macOS 13+ ScreenCaptureKit).
  session.defaultSession.setDisplayMediaRequestHandler(
    async (_req, callback) => {
      try {
        const sources = await desktopCapturer.getSources({ types: ['screen'] });
        callback(cfg.loopbackAudio ? { video: sources[0], audio: 'loopback' } : { video: sources[0] });
      } catch (e) {
        console.log('display handler error', e);
        callback({});
      }
    },
    { useSystemPicker: !!cfg.systemPicker },
  );
  const win = new BrowserWindow({
    width: 700,
    height: 420,
    show: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false },
  });
  win.webContents.on('console-message', (e) => console.log('[page]', e.message));
  win.on('close', (e) => { if (!quitting) e.preventDefault(); }); // a stray click must not end a long run
  win.showInactive();
  win.loadFile(path.join(__dirname, 'page.html'));
});
