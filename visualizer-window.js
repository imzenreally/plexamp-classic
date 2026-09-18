/* visualizer-window.js — native-mode satellite: MilkDrop via Butterchurn.
 * The leader owns the audio graph in another renderer. Butterchurn supports
 * externally supplied 1024-sample waveform frames through render({audioLevels}),
 * so the leader streams those frames here over IPC.
 */

const canvas = document.getElementById("viz");

const wave = new Uint8Array(1024).fill(128);
let receivedFrames = 0;
if (window.plex && window.plex.onVizData) {
  window.plex.onVizData((data) => {
    const incoming = data?.wave;
    if (!incoming?.length) return;
    const source = incoming instanceof Uint8Array ? incoming : new Uint8Array(incoming);
    wave.fill(128);
    wave.set(source.subarray(0, wave.length));
    receivedFrames += 1;
  });
}

// ---------- butterchurn boot (module) ----------
let visualizer = null;
let presets = {};
let presetKeys = [];
let presetIndex = 0;
let lastFrame = 0;
let renderedFrames = 0;
let renderError = null;
let bootAttempts = 0;
let bootError = null;
let loopStarted = false;
let audioContext = null;
let bootTimer = null;
let loopTimer = null;

function closeAudioContext() {
  if (audioContext) audioContext.close().catch(() => {});
  audioContext = null;
}

function scheduleBoot(delay = 250) {
  if (bootAttempts >= 8) return;
  clearTimeout(bootTimer);
  bootTimer = setTimeout(boot, delay);
}

async function boot() {
  if (loopStarted) return;
  bootAttempts += 1;
  if (!window.butterchurn || !window.butterchurnPresets) {
    bootError = "Butterchurn runtime or presets unavailable";
    scheduleBoot(100);
    return;
  }
  try {
    const ac = new AudioContext();
    audioContext = ac;
    canvas.width = canvas.clientWidth || 275;
    canvas.height = canvas.clientHeight || 116;
    visualizer = window.butterchurn.default.createVisualizer(ac, canvas, {
      width: canvas.width,
      height: canvas.height,
      pixelRatio: window.devicePixelRatio || 1,
      textureRatio: 1,
    });
    presets = window.butterchurnPresets.getPresets();
    presetKeys = Object.keys(presets);
    if (presetKeys.length) visualizer.loadPreset(presets[presetKeys[0]], 0.0);
    bootError = null;
    renderError = null;
    loopStarted = true;
    setTimeout(loop, 0);
  } catch (error) {
    bootError = error?.stack || String(error);
    closeAudioContext();
    visualizer = null;
    loopStarted = false;
    scheduleBoot();
  }
}

function loop() {
  if (!loopStarted || !visualizer) return;
  const now = performance.now();
  if (now - lastFrame < 30) {
    loopTimer = setTimeout(loop, 33);
    return;
  }
  lastFrame = now;
  try {
    if (canvas.clientWidth && (canvas.clientWidth !== canvas.width || canvas.clientHeight !== canvas.height)) {
      canvas.width = canvas.clientWidth;
      canvas.height = canvas.clientHeight;
      visualizer.setCanvasSize(canvas.width, canvas.height);
    }
    visualizer.render({
      audioLevels: {
        timeByteArray: wave,
        timeByteArrayL: wave,
        timeByteArrayR: wave,
      },
    });
    renderedFrames += 1;
    loopTimer = setTimeout(loop, 33);
  } catch (error) {
    renderError = error?.stack || String(error);
    loopStarted = false;
    visualizer = null;
    closeAudioContext();
    scheduleBoot();
  }
}

canvas.addEventListener("click", () => {
  if (!presetKeys.length || !visualizer) return;
  presetIndex = (presetIndex + 1) % presetKeys.length;
  try {
    visualizer.loadPreset(presets[presetKeys[presetIndex]], 1.0);
  } catch (error) {
    renderError = error?.stack || String(error);
    loopStarted = false;
    visualizer = null;
    clearTimeout(loopTimer);
    closeAudioContext();
    scheduleBoot();
  }
});
document.querySelector(".sys-btn.close").addEventListener("click", () => window.plex.panelToggle("milkdrop"));
window.addEventListener("beforeunload", () => {
  clearTimeout(bootTimer);
  clearTimeout(loopTimer);
  loopStarted = false;
  closeAudioContext();
});

// CDP/test-only observability; no canvas context reads (those break WebGL).
window.__vizState = () => ({
  ready: Boolean(visualizer),
  presetCount: presetKeys.length,
  receivedFrames,
  renderedFrames,
  renderError,
  bootAttempts,
  bootError,
  loopStarted,
  preset: presetKeys[presetIndex] || null,
});

boot();