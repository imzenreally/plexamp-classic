/* equalizer-window.js — native-mode satellite: 10-band EQ + preamp.
 * Values are webamp store state (0-100, 50 = neutral); writes go through
 * panel:action as SET_BAND_VALUE / SET_EQ_ON / SET_EQ_AUTO.
 */
(() => {
  const FREQS = ["60", "170", "310", "600", "1000", "3000", "6000", "12000", "14000", "16000"];
  const bandsEl = document.getElementById("bands");
  const preampEl = document.getElementById("preamp");
  const onBtn = document.getElementById("tg-on");
  const autoBtn = document.getElementById("tg-auto");
  let currentEq = { on: true, auto: false };

  for (const f of FREQS) {
    const band = document.createElement("div");
    band.className = "band";
    const input = document.createElement("input");
    input.type = "range"; input.min = "0"; input.max = "100"; input.value = "50";
    input.dataset.freq = f;
    const label = document.createElement("span");
    label.className = "freq";
    label.textContent = f.startsWith("1") || f.startsWith("14") || f.startsWith("16") ? `${Number(f) / 1000}k` : f;
    band.append(input, label);
    bandsEl.appendChild(band);
    input.addEventListener("input", () => {
      window.plex.panelAction({ type: "SET_BAND_VALUE", band: f, value: Number(input.value) });
    });
  }
  preampEl.addEventListener("input", () => {
    window.plex.panelAction({ type: "SET_BAND_VALUE", band: "preamp", value: Number(preampEl.value) });
  });
  onBtn.addEventListener("click", () => {
    window.plex.panelAction({ type: currentEq.on ? "SET_EQ_OFF" : "SET_EQ_ON" });
  });
  // Webamp deliberately does not implement AUTO; keep its state explicitly off.
  autoBtn.addEventListener("click", () => window.plex.panelAction({ type: "SET_EQ_AUTO", value: false }));
  document.querySelector(".sys-btn.close").addEventListener("click", () => window.plex.panelToggle("equalizer"));

  function render(eq) {
    if (!eq) return;
    currentEq = eq;
    onBtn.classList.toggle("on", Boolean(eq.on));
    autoBtn.classList.toggle("on", Boolean(eq.auto));
    if (eq.sliders) {
      for (const input of bandsEl.querySelectorAll("input")) {
        const v = eq.sliders[input.dataset.freq];
        if (v != null && document.activeElement !== input) input.value = v;
      }
      if (eq.sliders.preamp != null && document.activeElement !== preampEl) preampEl.value = eq.sliders.preamp;
    }
  }

  async function pull() {
    const eq = await window.plex.panelGetState("equalizer");
    render(eq);
  }
  window.plex.onPanelState((s) => render(s && s.equalizer));

  pull();
  const poll = setInterval(pull, 2500);
  window.addEventListener("beforeunload", () => clearInterval(poll));
})();