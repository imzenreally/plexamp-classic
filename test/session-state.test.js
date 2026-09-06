const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DEFAULT_SESSION,
  normalizeSession,
  repairedBounds,
} = require("../session-state");

test("first-run session opens only the main player tile", () => {
  assert.deepEqual(DEFAULT_SESSION, {
    version: 1,
    player: { mode: "desktop", zoomFactor: 1, bounds: null },
    panels: { main: true, playlist: false, equalizer: false, milkdrop: false },
    library: { open: false, bounds: null },
  });
});

test("normalizes malformed saved session state without reopening closed surfaces", () => {
  const state = normalizeSession({
    version: 1,
    player: { mode: "bogus", zoomFactor: 99 },
    panels: { main: 1, playlist: false, equalizer: "yes", milkdrop: null },
    library: { open: false, bounds: { x: "nope", y: 4, width: 0, height: 10 } },
  });

  assert.deepEqual(state, {
    version: 1,
    player: { mode: "desktop", zoomFactor: 1, bounds: null },
    panels: { main: true, playlist: false, equalizer: false, milkdrop: false },
    library: { open: false, bounds: null },
  });
});

test("preserves valid session state and clamps zoom", () => {
  const state = normalizeSession({
    version: 1,
    player: { mode: "windowed", zoomFactor: 1.25, bounds: { x: 30, y: 40, width: 800, height: 600 } },
    panels: { main: true, playlist: true, equalizer: false, milkdrop: true },
    library: { open: true, bounds: { x: 20, y: 30, width: 1100, height: 720 } },
  });

  assert.equal(state.player.mode, "windowed");
  assert.equal(state.player.zoomFactor, 1.25);
  assert.deepEqual(state.player.bounds, { x: 30, y: 40, width: 800, height: 600 });
  assert.equal(state.panels.playlist, true);
  assert.equal(state.panels.milkdrop, true);
  assert.deepEqual(state.library.bounds, { x: 20, y: 30, width: 1100, height: 720 });
});

test("repairs invalid and off-screen library bounds into the visible work area", () => {
  const workArea = { x: 0, y: 0, width: 1440, height: 900 };
  assert.deepEqual(repairedBounds({ x: -5000, y: -5000, width: 1100, height: 720 }, workArea), {
    x: 20, y: 20, width: 1100, height: 720,
  });
  assert.deepEqual(repairedBounds({ x: 100, y: 50, width: 4000, height: 30 }, workArea), {
    x: 20, y: 20, width: 1100, height: 720,
  });
});
