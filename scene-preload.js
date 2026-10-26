// Runs in the scene page and in each of its frames, before the page's own scripts.
// Sends all audio (Web Audio and <audio>/<video>) to the output chosen in the control window.
const { ipcRenderer } = require('electron');

let wanted = ipcRenderer.sendSync('get-audio-output') || '';
const contexts = new Set();

// The chosen output is stored by name; device ids differ per page, so look it up here.
async function resolveSinkId() {
  if (!wanted) return '';
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const want = wanted.toLowerCase();
    const d = devices.find(x => x.kind === 'audiooutput' && x.label.toLowerCase() === want) ||
              devices.find(x => x.kind === 'audiooutput' && x.label.toLowerCase().includes(want));
    return d ? d.deviceId : '';
  } catch { return ''; }
}

async function applyEverywhere() {
  const id = await resolveSinkId();
  for (const ctx of contexts) {
    if (ctx.state !== 'closed' && ctx.setSinkId) ctx.setSinkId(id).catch(() => {});
  }
  for (const el of document.querySelectorAll('audio, video')) {
    if (el.setSinkId && el.sinkId !== id) el.setSinkId(id).catch(() => {});
  }
}

// Track every AudioContext the page makes
const NativeAC = window.AudioContext;
if (NativeAC) {
  class TrackedAudioContext extends NativeAC {
    constructor(...args) {
      super(...args);
      contexts.add(this);
      if (wanted) resolveSinkId().then(id => this.setSinkId && this.setSinkId(id).catch(() => {}));
    }
  }
  window.AudioContext = TrackedAudioContext;
  window.webkitAudioContext = TrackedAudioContext;
}

// Media elements (including `new Audio()` that isn't in the DOM) pick up the output when they play
const nativePlay = HTMLMediaElement.prototype.play;
HTMLMediaElement.prototype.play = function (...args) {
  if (wanted && this.setSinkId) {
    resolveSinkId().then(id => { if (this.sinkId !== id) this.setSinkId(id).catch(() => {}); });
  }
  return nativePlay.apply(this, args);
};

ipcRenderer.on('audio-output', (_e, label) => { wanted = label || ''; applyEverywhere(); });

// Keys pressed in the control window (replaces OBS "Interact")
ipcRenderer.on('key', (_e, key) => {
  const code = key === ' ' ? 'Space' : key.length === 1 ? 'Key' + key.toUpperCase() : key;
  for (const type of ['keydown', 'keyup']) {
    window.dispatchEvent(new KeyboardEvent(type, { key, code, bubbles: true, cancelable: true }));
  }
});
