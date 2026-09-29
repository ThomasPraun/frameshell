// PROTOTYPE. Electron main: opens one visible window that plays the cut list with one technique,
// samples per-process CPU, then quits when the renderer reports done.
// Usage: electron . --technique=A1|A2|B [--audio=worklet|bufsrc] [--cuts=N] [--out=out]
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const arg = (name, def) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
};
const technique = arg('technique', 'A1');
const cuts = arg('cuts', '');
const audio = arg('audio', 'worklet');
const run = technique + (technique !== 'A1' && audio !== 'worklet' ? '-' + audio : '');
const outDir = path.resolve(__dirname, '..', arg('out', 'out'));
fs.mkdirSync(outDir, { recursive: true });

// Keep timers, rAF and media running at full rate even if the window loses focus.
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const cpu = [];
app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1000,
    height: 640,
    title: `spike #2 ${run}`,
    webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false },
  });
  const q = new URLSearchParams({ technique, audio, cuts, out: outDir, media: path.resolve(__dirname, '..', 'media') });
  win.loadFile(path.join(__dirname, 'index.html'), { search: q.toString() });
  const timer = setInterval(() => {
    const m = app.getAppMetrics();
    cpu.push({ t: Date.now(), total: m.reduce((s, p) => s + p.cpu.percentCPUUsage, 0), byType: Object.fromEntries(m.map((p) => [p.type + ':' + p.pid, p.cpu.percentCPUUsage])) });
  }, 2000);
  ipcMain.on('log', (_e, msg) => console.log(`[${run}]`, msg));
  ipcMain.on('done', (_e, code) => {
    clearInterval(timer);
    fs.writeFileSync(path.join(outDir, `${run}.cpu.json`), JSON.stringify(cpu));
    app.exit(code || 0);
  });
});
