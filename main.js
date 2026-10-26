// Spouty
// Renders a web page offscreen and sends every frame out over Spout, replacing
// OBS + Browser source + Spout plugin. Settings live in config.json next to the exe.

const { app, BrowserWindow, ipcMain, session } = require('electron');
const path = require('path');
const fs = require('fs');

// ---------- settings ----------
const DEFAULTS = {
  url: 'http://localhost:8000/stage.html',
  senderName: 'spoutyfeed',
  width: 4096,
  height: 2048,
  fps: 60,
  audioOutput: '',          // device label (or part of it); '' = Windows default
  muted: false,
  gpuSharedTexture: false,  // zero-copy mode; leave off unless the CPU path is too slow
};

// config.json sits next to the exe when packaged, next to main.js when run with `npm start`
const CONFIG_DIR = app.isPackaged ? path.dirname(process.execPath) : __dirname;
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

function loadConfig() {
  let cfg = { ...DEFAULTS };
  try {
    cfg = { ...cfg, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('config.json could not be read, using defaults:', e.message);
  }
  if (!fs.existsSync(CONFIG_PATH)) {
    try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2)); } catch {}
  }
  // command-line overrides, e.g. --url=http://localhost:8000/index.html --senderName=Test
  for (const arg of process.argv) {
    const m = /^--(\w+)=(.*)$/.exec(arg);
    if (m && m[1] in DEFAULTS) {
      const d = DEFAULTS[m[1]];
      cfg[m[1]] = typeof d === 'number' ? Number(m[2]) : typeof d === 'boolean' ? m[2] === 'true' : m[2];
    }
  }
  return cfg;
}

function saveConfig() {
  try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n'); }
  catch (e) { console.error('Could not save config.json:', e.message); }
}

let cfg = loadConfig();

// ---------- Chromium switches (must be set before app is ready) ----------
app.commandLine.appendSwitch('force-device-scale-factor', '1');        // page size = exact pixel size
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required'); // her voice plays without a click
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

// ---------- Spout ----------
let SpoutOutput = null;
let spoutError = '';
try {
  // packaged: resources/app/native, dev: ./native
  ({ SpoutOutput } = require(path.join(__dirname, 'native', 'electron-spout.node')));
} catch (e) {
  spoutError = 'Spout addon failed to load: ' + e.message +
    (process.platform !== 'win32' ? ' (Spout only works on Windows)' : ' (is the Visual C++ 2015-2022 x64 runtime installed?)');
  console.error(spoutError);
}

if (process.env.SPOUT_SENDER_FAKE) {
  // test mode on machines without Spout: accept frames and log their size
  spoutError = '';
  SpoutOutput = class {
    constructor(name) { this.name = name; }
    updateFrame(buf, size) { this.last = `${size.width}x${size.height} ${buf.length}B`; }
    updateTexture() { this.last = 'texture'; }
  };
}

let spout = null;
let sceneWin = null;
let controlWin = null;
let framesSent = 0;
let lastPaint = 0;
let lastError = '';

function startSpout() {
  if (!SpoutOutput) return;
  try {
    if (!spout) spout = new SpoutOutput(cfg.senderName);
    else spout.name = cfg.senderName;
  } catch (e) {
    lastError = 'Could not create Spout sender: ' + e.message;
    console.error(lastError);
  }
}

// ---------- the offscreen scene ----------
function createScene() {
  sceneWin = new BrowserWindow({
    width: cfg.width,
    height: cfg.height,
    useContentSize: true,
    show: false,
    frame: false,
    enableLargerThanScreen: true,
    webPreferences: {
      offscreen: cfg.gpuSharedTexture ? { useSharedTexture: true } : true,
      backgroundThrottling: false,
      preload: path.join(__dirname, 'scene-preload.js'),
      contextIsolation: false,          // lets the preload patch AudioContext before the page runs
      nodeIntegration: false,
      nodeIntegrationInSubFrames: true, // stage.html loads scenes in iframes; preload runs in those too
      sandbox: true,
    },
  });
  sceneWin.setContentSize(cfg.width, cfg.height);
  sceneWin.webContents.setFrameRate(Math.max(1, Math.min(240, cfg.fps)));
  sceneWin.webContents.setAudioMuted(!!cfg.muted);

  sceneWin.webContents.on('paint', (event, dirty, image) => {
    if (!spout) {
      if (event.texture) event.texture.release();
      return;
    }
    try {
      if (event.texture) {
        // zero-copy GPU path
        spout.updateTexture(event.texture.textureInfo);
        event.texture.release();
      } else {
        const size = image.getSize();
        spout.updateFrame(new Uint8Array(image.getBitmap()), { width: size.width, height: size.height });
      }
      framesSent++;
      lastPaint = Date.now();
    } catch (e) {
      lastError = 'Spout send failed: ' + e.message;
      if (event.texture) try { event.texture.release(); } catch {}
    }
  });

  sceneWin.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame) return;
    lastError = `Could not load ${url} (${desc}). Is the scene server running? Retrying in 3 s…`;
    const failedUrl = cfg.url;
    setTimeout(() => { if (cfg.url === failedUrl) loadScene(); }, 3000);  // don't retry a URL you've since changed
  });
  sceneWin.webContents.on('did-finish-load', () => { lastError = ''; });
  sceneWin.webContents.on('render-process-gone', (_e, d) => {
    lastError = 'Scene crashed (' + d.reason + '), reloading…';
    setTimeout(loadScene, 1000);
  });

  loadScene();
}

function normaliseUrl(u) {
  u = String(u || '').trim();
  if (/^[a-z]:[\\/]/i.test(u) || u.startsWith('\\\\')) return 'file:///' + u.replace(/\\/g, '/');  // D:\folder\page.html
  if (!/^(https?|file|about|data):/i.test(u)) return 'http://' + u;                                              // localhost:8000/page.html
  return u;
}

function loadScene() {
  if (!sceneWin || sceneWin.isDestroyed()) return;
  lastError = '';
  const url = normaliseUrl(cfg.url);
  sceneWin.webContents.loadURL(url, { extraHeaders: 'pragma: no-cache\n' }).catch(() => {}); // failures go to did-fail-load
}

function sendSinkToScene() {
  if (!sceneWin || sceneWin.isDestroyed()) return;
  for (const f of sceneWin.webContents.mainFrame.framesInSubtree) {
    try { f.send('audio-output', cfg.audioOutput); } catch {}
  }
}

// ---------- the small control window ----------
function createControl() {
  controlWin = new BrowserWindow({
    width: 460,
    height: 650,
    resizable: true,
    title: 'Spouty',
    autoHideMenuBar: true,
    backgroundColor: '#1b1d22',
    webPreferences: {
      preload: path.join(__dirname, 'control-preload.js'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  controlWin.loadFile(path.join(__dirname, 'control.html'));
  controlWin.on('closed', () => app.quit());
}

// ---------- IPC ----------
ipcMain.handle('get-config', () => ({ cfg, spoutError, configPath: CONFIG_PATH }));
ipcMain.on('get-audio-output', (e) => { e.returnValue = cfg.audioOutput; });

ipcMain.handle('set-config', (_e, changes) => applyConfig(changes));

function applyConfig(changes, { save = true, forceLoad = false } = {}) {
  const old = { ...cfg };
  for (const k of Object.keys(changes)) if (k in DEFAULTS) cfg[k] = changes[k];
  cfg.width = Math.max(64, Math.round(Number(cfg.width) || DEFAULTS.width));
  cfg.height = Math.max(64, Math.round(Number(cfg.height) || DEFAULTS.height));
  cfg.fps = Math.max(1, Math.min(240, Math.round(Number(cfg.fps) || DEFAULTS.fps)));
  if (save) saveConfig();

  if (cfg.gpuSharedTexture !== old.gpuSharedTexture) {
    // offscreen mode can only be set when the window is made
    sceneWin.destroy();
    createScene();
  } else {
    if (cfg.width !== old.width || cfg.height !== old.height) sceneWin.setContentSize(cfg.width, cfg.height);
    if (cfg.fps !== old.fps) sceneWin.webContents.setFrameRate(cfg.fps);
    if (cfg.url !== old.url || forceLoad) loadScene();
    if (cfg.muted !== old.muted) sceneWin.webContents.setAudioMuted(!!cfg.muted);
    if (cfg.audioOutput !== old.audioOutput) sendSinkToScene();
  }
  if (cfg.senderName !== old.senderName) startSpout();
  if (controlWin && !controlWin.isDestroyed()) controlWin.webContents.send('config', cfg);
  return cfg;
}

// Load button: apply whatever URL is typed and load it fresh (even if it hasn't changed)
ipcMain.handle('load-url', (_e, url) => applyConfig({ url: String(url || '').trim() || cfg.url }, { forceLoad: true }));

ipcMain.on('reload', () => sceneWin && sceneWin.webContents.reloadIgnoringCache());
ipcMain.on('devtools', () => sceneWin && sceneWin.webContents.openDevTools({ mode: 'detach' }));

// keys typed in the control window go to the scene (replaces OBS "Interact")
// (sent to every frame, because stage.html shows the scene inside an iframe that may not have focus)
ipcMain.on('key', (_e, key) => {
  if (!sceneWin || sceneWin.isDestroyed()) return;
  for (const f of sceneWin.webContents.mainFrame.framesInSubtree) {
    try { f.send('key', key); } catch {}
  }
});
ipcMain.on('click', () => {
  // a click in the middle of the scene, e.g. to wake up audio
  if (!sceneWin || sceneWin.isDestroyed()) return;
  const x = Math.round(cfg.width / 2), y = Math.round(cfg.height / 2);
  sceneWin.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
  sceneWin.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
});

// status for the control window, once a second
let lastFrames = 0;
setInterval(() => {
  const fps = framesSent - lastFrames;
  lastFrames = framesSent;
  if (process.env.SPOUT_SENDER_FAKE) fs.appendFileSync(process.env.SPOUT_SENDER_FAKE, `[status] fps=${fps} last=${spout && spout.last} err=${lastError}\n`);
  if (controlWin && !controlWin.isDestroyed()) {
    controlWin.webContents.send('status', {
      fps,
      sending: !!spout && fps > 0,
      spoutReady: !!spout,
      error: spoutError || lastError,
      showing: sceneWin && !sceneWin.isDestroyed() ? sceneWin.webContents.getURL() : '',
    });
  }
}, 1000);

// ---------- start ----------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (controlWin) { controlWin.show(); controlWin.focus(); } });

  app.whenReady().then(() => {
    // allow the pages to see audio device names, so the chosen output can be matched by name
    session.defaultSession.setPermissionCheckHandler(() => true);
    session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(true));

    startSpout();
    createScene();
    createControl();

    // A still page stops painting after a frame or two. Ask for a fresh frame every 250 ms so
    // receivers that only redraw on new frames always get the current page.
    setInterval(() => {
      if (sceneWin && !sceneWin.isDestroyed() && Date.now() - lastPaint > 250) sceneWin.webContents.invalidate();
    }, 250);

    // Pick up hand edits to config.json while running
    let lastJson = '';
    try { lastJson = fs.readFileSync(CONFIG_PATH, 'utf8'); } catch {}
    fs.watchFile(CONFIG_PATH, { interval: 1000 }, () => {
      let text;
      try { text = fs.readFileSync(CONFIG_PATH, 'utf8'); } catch { return; }
      if (text === lastJson) return;
      lastJson = text;
      try { applyConfig(JSON.parse(text), { save: false }); } catch {}
    });
    if (process.env.SPOUT_SENDER_FAKE) {
      // test mode: press Y in the scene after a few seconds
      setTimeout(() => ipcMain.emit('key', {}, 'y'), 6000);
      setTimeout(async () => {
        const img = await controlWin.capturePage();
        fs.writeFileSync(process.env.SPOUT_SENDER_FAKE + '.png', img.toPNG());
      }, 4000);
    }
  });

  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => { spout = null; });
}
