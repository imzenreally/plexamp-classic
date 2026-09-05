// Load the Butterchurn-enabled Webamp ES module. An optional local preset
// pack can be added at vendor/presets-og-pack.mjs; it is not distributed.
import WebampWithButterchurn from "./vendor/webamp.butterchurn-bundle.min.mjs";

window.WebampWithButterchurn = WebampWithButterchurn;
if (await window.plex.hasLocalPresetPack()) {
  const localPack = await import("./vendor/presets-og-pack.mjs");
  window.__ogPresets = localPack.default;
}
window.__webampModuleReady = true;