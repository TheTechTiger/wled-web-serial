/**
 * ui/render.js
 * Render functions for every panel and widget.
 */

'use strict';

/* ------------------------------------------------------------------ *
 *  Rendering: header, colors, lists                                   *
 * ------------------------------------------------------------------ */
function renderConnection() {
  document.body.dataset.mode = state.mode;
  const serialMode = state.mode === 'serial';
  ui.connLabel.textContent = serialMode ? 'USB' : 'Preview';
  if (serialMode) {
    ui.connDetail.textContent = state.handshake
      ? `${getInfo().name || 'WLED'} · v${getInfo().ver || '?'}`
      : (state.portLabel || 'waiting for reply');
  } else {
    ui.connDetail.textContent = 'no USB device';
  }
  ui.connChip.classList.toggle('waiting', serialMode && !state.handshake);
  ui.settingsConnTitle.textContent = serialMode ? (state.handshake ? 'USB device connected' : 'Serial port open') : 'No serial device';
  ui.settingsConnSub.textContent = serialMode
    ? (state.handshake ? `${getInfo().name || 'WLED'} · ${state.portLabel || 'serial port'}` : 'Port is open — waiting for a JSON reply')
    : 'Preview mode — controls update locally';
  ui.connectBtn.classList.toggle('hidden', serialMode);
  ui.disconnectBtn.classList.toggle('hidden', !serialMode);
  ui.infoConnectBtn.classList.toggle('hidden', serialMode);
  ui.infoDisconnectBtn.classList.toggle('hidden', !serialMode);
  ui.infoModeBadge.textContent = serialMode ? 'SERIAL' : 'PREVIEW';
  ui.terminalModeBadge.textContent = serialMode ? (state.handshake ? 'CONNECTED' : 'WAITING') : 'PREVIEW';
  ui.infoConnTitle.textContent = serialMode ? (state.handshake ? 'Web Serial link live' : 'Waiting for WLED') : 'No serial device';
  ui.infoConnSub.textContent = serialMode
    ? (state.portLabel || 'Serial port') + ' · ' + prefs.baud + ' baud'
    : 'Using simulated preview values';
  ui.infoModeBadge.classList.toggle('active', serialMode);
  if (ui.baudSelect) {
    ui.baudSelect.disabled = serialMode;
    ui.baudSelect.title = serialMode ? 'Disconnect before changing the baud rate' : '';
  }
}
function renderPower() {
  ui.powerBtn.classList.toggle('on', !!state.on);
  ui.powerBtn.setAttribute('aria-pressed', state.on ? 'true' : 'false');
  ui.statePower.textContent = state.on ? 'On' : 'Off';
  ui.statePowerDot.classList.toggle('on', !!state.on);
  ui.timerBtn.classList.toggle('active', !!state.nightlight.on);
}
function renderBrightness() {
  const b = clamp(Math.round(state.brightness), 1, 255);
  setElRange('topBrightness', b);
  ui.topBrightnessValue.textContent = b;
  ui.stateBrightness.textContent = b;
}
function renderColor() {
  const seg = activeSegment();
  const c = activeColor();
  const hsv = rgbToHsv(c.r, c.g, c.b);
  if (hsv.s > 0.1) state.hsv.h = hsv.h;
  state.hsv.s = hsv.s;
  const hue = Math.round(state.hsv.h || 0);
  const sat = Math.round(state.hsv.s || 0);
  const markerAngle = (state.hsv.h || 0) * Math.PI / 180;
  const radius = clamp(state.hsv.s, 0, 100) * 0.455;
  const left = 50 + Math.sin(markerAngle) * radius;
  const top = 50 - Math.cos(markerAngle) * radius;
  ui.wheelMarker.style.left = left + '%';
  ui.wheelMarker.style.top = top + '%';
  ui.wheelMarker.style.background = rgbToHex(c.r, c.g, c.b);
  ui.colorWheel.setAttribute('aria-valuetext', `Hue ${hue} degrees, saturation ${sat} percent`);
  setElRange('hueSlider', hue);
  setElRange('satSlider', sat);
  ui.hueValue.textContent = hue + '°';
  ui.satValue.textContent = sat + '%';
  const satRgb = hsvToRgb(state.hsv.h, 100, 100);
  ui.satTrack.style.setProperty('--track', `linear-gradient(90deg,#9aa0aa,${rgbToHex(satRgb.r, satRgb.g, satRgb.b)})`);
  const cct = Number(seg.cct) || 4000;
  setElRange('kelvinSlider', clamp(cct, 1900, 10091));
  ui.kelvinValue.textContent = Math.round(cct) + ' K';
  setElRange('redSlider', c.r); setElRange('greenSlider', c.g); setElRange('blueSlider', c.b); setElRange('whiteSlider', c.w);
  ui.redValue.textContent = c.r; ui.greenValue.textContent = c.g; ui.blueValue.textContent = c.b; ui.whiteValue.textContent = c.w;
  ui.hexInput.value = rgbToHex(c.r, c.g, c.b).slice(1);
  $$('.quick-color', ui.quickColors).forEach(el => {
    el.classList.toggle('active', el.dataset.color && el.dataset.color.toLowerCase() === rgbToHex(c.r, c.g, c.b));
  });
  $$('.slot-btn', ui.colorSlots).forEach((el, i) => {
    el.classList.toggle('active', i === state.selectedSlot);
    const cc = seg.colors[i] || [0,0,0,0];
    const sw = el.querySelector('.swatch');
    if (sw) sw.style.background = rgbToHex(cc[0], cc[1], cc[2]);
  });
  updateTheme();
  const segSelect = ui.colorSegSelect;
  if (segSelect && segSelect.value !== String(seg.id)) segSelect.value = String(seg.id);
  const effectSeg = ui.effectSegSelect;
  if (effectSeg && effectSeg.value !== String(seg.id)) effectSeg.value = String(seg.id);
  renderStateTiles();
  updateSegmentSummary(seg.id);
}
function renderStateTiles() {
  const seg = activeSegment();
  ui.stateEffect.textContent = effectName(seg.fx);
  ui.stateEffect.title = effectName(seg.fx);
  ui.statePalette.textContent = paletteName(seg.pal);
  ui.statePalette.title = paletteName(seg.pal);
}
function renderColorSlotsStatic() {
  ui.colorSlots.innerHTML = [0,1,2].map(i => `
    <button class="slot-btn${i === 0 ? ' active' : ''}" data-slot="${i}" type="button" title="Color slot ${i + 1}">
      <span class="swatch"></span><span>${COLOR_SLOT_NAMES[i]}</span>
    </button>`).join('');
  ui.colorSlots.addEventListener('click', e => {
    const btn = e.target.closest('[data-slot]');
    if (!btn) return;
    state.selectedSlot = Number(btn.dataset.slot);
    renderColor();
  });
}
function renderQuickColorsStatic() {
  ui.quickColors.innerHTML = QUICK_COLORS.map(c =>
    `<button class="quick-color" type="button" data-color="${c}" style="background:${c}" title="${c}"></button>`
  ).join('') + `<button class="quick-color random" type="button" data-random="1" title="Random color"><svg class="icon" aria-hidden="true"><use href="#i-dice"/></svg></button>`;
  ui.quickColors.addEventListener('click', e => {
    const btn = e.target.closest('.quick-color');
    if (!btn) return;
    if (btn.dataset.random) {
      const c = hsvToRgb(Math.random() * 360, 72 + Math.random() * 28, 100);
      applyColor(c.r, c.g, c.b, 0, { send: true });
    } else {
      const c = hexToRgb(btn.dataset.color);
      if (c) applyColor(c.r, c.g, c.b, c.w, { send: true });
    }
  });
}
function renderSegmentSelectors() {
  const opts = state.segments.map(s => `<option value="${s.id}">${escapeHtml(s.name || 'Segment ' + (s.id + 1))}${s.on ? '' : ' (off)'}</option>`).join('');
  for (const sel of [ui.colorSegSelect, ui.effectSegSelect]) {
    if (!sel) continue;
    sel.innerHTML = opts;
    sel.value = String(activeSegment().id);
  }
  renderPaletteList();
}
function renderEffectList() {
  const query = (ui.effectSearch.value || '').trim().toLowerCase();
  const scroll = ui.effectList.scrollTop;
  let visible = 0;
  const frag = document.createDocumentFragment();
  effectCatalog.forEach((name, id) => {
    if (!name || name === 'RSVD' || name === '-') return;
    if (query && !name.toLowerCase().includes(query)) return;
    visible++;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'effect-row' + (id === activeSegment().fx ? ' active' : '');
    b.dataset.fx = id;
    b.innerHTML = `<span class="effect-id">${String(id).padStart(2, '0')}</span><span class="effect-name">${escapeHtml(name)}</span><span class="effect-check"><svg class="icon" aria-hidden="true"><use href="#i-check"/></svg></span>`;
    frag.appendChild(b);
  });
  if (!visible) frag.appendChild(Object.assign(document.createElement('div'), { className: 'empty-list', textContent: 'No effects match your search.' }));
  ui.effectList.replaceChildren(frag);
  ui.effectList.scrollTop = scroll;
  ui.effectCount.textContent = `${visible} effects`;
  ui.effectIdInput.value = activeSegment().fx;
}
function renderPaletteList() {
  const query = ((ui.paletteSearch && ui.paletteSearch.value) || '').trim().toLowerCase();
  const scroll = ui.paletteList.scrollTop;
  let visible = 0;
  const frag = document.createDocumentFragment();
  paletteCatalog.forEach((name, id) => {
    if (!name) return;
    if (query && !name.toLowerCase().includes(query)) return;
    visible++;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'palette-row' + (id === activeSegment().pal ? ' active' : '');
    b.dataset.pal = id;
    b.innerHTML = `<span class="palette-swatch" style="background:${paletteGradient(id)}"></span><span class="palette-name">${escapeHtml(name)}</span><span class="palette-check"><svg class="icon" aria-hidden="true"><use href="#i-check"/></svg></span>`;
    b.title = name;
    frag.appendChild(b);
  });
  if (!visible) frag.appendChild(Object.assign(document.createElement('div'), { className: 'empty-list', textContent: 'No palettes match your search.' }));
  ui.paletteList.replaceChildren(frag);
  ui.paletteList.scrollTop = scroll;
  ui.paletteCount.textContent = `${visible} palettes`;
}
function renderEffectSelection() {
  const seg = activeSegment();
  $$('.effect-row', ui.effectList).forEach(row => row.classList.toggle('active', Number(row.dataset.fx) === seg.fx));
  for (const sel of [ui.colorSegSelect, ui.effectSegSelect]) if (sel) sel.value = String(seg.id);
}
function renderPaletteSelection() {
  const seg = activeSegment();
  $$('.palette-row', ui.paletteList).forEach(row => row.classList.toggle('active', Number(row.dataset.pal) === seg.pal));
}
function renderEffectCurrent() {
  const seg = activeSegment();
  const name = effectName(seg.fx);
  ui.currentEffectName.textContent = name;
  ui.effectIdBadge.textContent = 'ID ' + seg.fx;
  ui.effectIdInput.value = seg.fx;
  setElRange('speedSlider', seg.sx ?? 128);
  setElRange('intensitySlider', seg.ix ?? 128);
  ui.speedValue.textContent = seg.sx ?? 128;
  ui.intensityValue.textContent = seg.ix ?? 128;
  ui.freezeBtn.classList.toggle('active', !!seg.frz);
  ui.effectPreview.style.background = effectGradient(seg);
  ui.currentEffectName.title = name;
  ui.effectPalettePreview.style.background = paletteGradient(seg.pal);
  ui.effectPaletteName.textContent = paletteName(seg.pal);
  ui.effectPaletteHint.textContent = 'ID ' + seg.pal;
  updateSegmentSummary(seg.id);
  renderStateTiles();
  renderEffectSelection();
  renderPaletteSelection();
}
function renderBrightnessAll() { renderBrightness(); }

function markActiveSegmentCards() {
  if (!ui.segmentsGrid) return;
  $$('.segment-card', ui.segmentsGrid).forEach(card => {
    card.classList.toggle('active', Number(card.dataset.segId) === activeSegment().id);
  });
}
function updateSegmentSummary(id) {
  if (!ui.segmentsGrid) return;
  const seg = state.segments.find(s => s.id === id);
  const card = ui.segmentsGrid.querySelector(`[data-seg-id="${id}"]`);
  if (!seg || !card) return;
  const c = seg.colors?.[0] || [0,0,0,0];
  const sw = card.querySelector('.seg-swatch');
  if (sw) sw.style.background = rgbToHex(c[0], c[1], c[2]);
  const sub = card.querySelector('.seg-sub');
  if (sub) sub.textContent = `${seg.start}–${seg.stop} · ${Math.max(0, seg.stop - seg.start)} LEDs`;
  const fxLabel = card.querySelector('[data-role="effect"] span');
  if (fxLabel) fxLabel.textContent = effectName(seg.fx);
  const palLabel = card.querySelector('[data-role="palette"] span');
  if (palLabel) palLabel.textContent = paletteName(seg.pal);
  const bri = card.querySelector('[data-field="bri"]');
  if (bri && document.activeElement !== bri) {
    bri.value = seg.bri ?? 255;
    setRange(bri, seg.bri ?? 255);
    const out = card.querySelector('[data-role="bri-out"]');
    if (out) out.textContent = seg.bri ?? 255;
  }
  card.classList.toggle('active', seg.id === activeSegment().id);
  const on = card.querySelector('[data-field="on"]');
  if (on) on.checked = !!seg.on;
  card.style.opacity = seg.on === false ? '.72' : '';
}
function renderSegments() {
  const active = document.activeElement;
  if (active && ui.segmentsGrid.contains(active) && active.matches('input,select,textarea')) {
    markActiveSegmentCards();
    return;
  }
  const frag = document.createDocumentFragment();
  const max = maxSegments();
  state.segments.forEach(seg => {
    const c = seg.colors?.[0] || [0,0,0,0];
    const article = document.createElement('article');
    article.className = 'segment-card' + (seg.id === activeSegment().id ? ' active' : '');
    article.dataset.segId = seg.id;
    article.style.opacity = seg.on === false ? '.72' : '';
    article.innerHTML = `
      <div class="seg-top">
        <span class="seg-swatch" style="background:${rgbToHex(c[0], c[1], c[2])}"></span>
        <div class="seg-title-wrap">
          <input class="seg-name-input" data-field="name" maxlength="24" value="${escapeHtml(seg.name || 'Segment ' + (seg.id + 1))}" aria-label="Segment name">
          <span class="seg-sub">${seg.start}–${seg.stop} · ${Math.max(0, seg.stop - seg.start)} LEDs</span>
        </div>
        <label class="switch" title="Segment power">
          <input type="checkbox" data-field="on" ${seg.on ? 'checked' : ''} aria-label="Segment power">
          <span class="track"></span>
        </label>
      </div>
      <div class="seg-summary">
        <span class="seg-pill" data-role="effect"><svg class="icon" aria-hidden="true"><use href="#i-sparkles"/></svg><span>${escapeHtml(effectName(seg.fx))}</span></span>
        <span class="seg-pill" data-role="palette"><svg class="icon" aria-hidden="true"><use href="#i-palette"/></svg><span>${escapeHtml(paletteName(seg.pal))}</span></span>
      </div>
      <div class="seg-fields">
        <div class="seg-field"><label>Start LED</label><input data-field="start" type="number" min="0" max="${totalLeds() - 1}" value="${seg.start}"></div>
        <div class="seg-field"><label>Stop LED</label><input data-field="stop" type="number" min="1" max="${totalLeds()}" value="${seg.stop}"></div>
      </div>
      <div class="seg-bri">
        <label>Brightness</label>
        <div class="range-wrap fill"><input class="range" data-field="bri" type="range" min="0" max="255" value="${seg.bri ?? 255}"></div>
        <output data-role="bri-out">${seg.bri ?? 255}</output>
      </div>
      <div class="seg-actions">
        <button class="btn" data-action="colors" type="button"><svg class="icon" aria-hidden="true"><use href="#i-palette"/></svg> Colors</button>
        <button class="btn" data-action="effects" type="button"><svg class="icon" aria-hidden="true"><use href="#i-sparkles"/></svg> Effects</button>
        <button class="icon-btn${seg.rev ? ' active' : ''}" data-action="reverse" type="button" title="Reverse segment" aria-label="Reverse segment" aria-pressed="${seg.rev ? 'true' : 'false'}"><svg class="icon" aria-hidden="true"><use href="#i-reverse"/></svg></button>
        <button class="icon-btn danger" data-action="delete" type="button" title="Delete segment" aria-label="Delete segment"><svg class="icon" aria-hidden="true"><use href="#i-trash"/></svg></button>
      </div>
      <details class="seg-details">
        <summary>Advanced</summary>
        <div class="seg-more-grid">
          <div class="seg-field"><label>Grouping</label><input data-field="grp" type="number" min="1" max="255" value="${seg.grp ?? 1}"></div>
          <div class="seg-field"><label>Spacing</label><input data-field="spc" type="number" min="0" max="255" value="${seg.spc ?? 0}"></div>
        </div>
      </details>`;
    const bri = $('[data-field="bri"]', article);
    if (bri) setRange(bri, seg.bri ?? 255);
    frag.appendChild(article);
  });
  ui.segmentsGrid.replaceChildren(frag);
  ui.addSegmentBtn.disabled = state.segments.length >= max;
  ui.addSegmentBtn.title = state.segments.length >= max ? `Maximum of ${max} segments` : 'Add a segment';
  ui.addSegmentBtn.style.opacity = state.segments.length >= max ? '.55' : '';
}

function renderPresets() {
  if (!ui.presetsGrid) return;
  const frag = document.createDocumentFragment();
  for (let id = 1; id <= PRESET_SLOTS; id++) {
    const meta = presetStore.meta[id];
    const card = document.createElement('div');
    card.className = 'preset-card' + (meta ? '' : ' empty') + (state.currentPreset === id ? ' playing' : '');
    card.dataset.slot = id;
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', meta ? `Apply preset ${meta.name}` : `Save to empty preset slot ${id}`);
    if (meta) {
      card.innerHTML = `
        <div class="preset-top"><span class="preset-slot">${String(id).padStart(2, '0')}</span>
          ${state.currentPreset === id ? '<span class="preset-status"><span class="state-dot on"></span>Playing</span>' : ''}
        </div>
        <span class="preset-name">${escapeHtml(meta.name || presetName(id))}</span>
        <span class="preset-meta">${escapeHtml(effectName(meta.effect ?? 0))} · ${escapeHtml(paletteName(meta.palette ?? 0))}</span>
        <span class="preset-strip" style="background:${meta.palette ? paletteGradient(meta.palette) : `linear-gradient(90deg,${rgbToHex((meta.rgb||[255,160,0])[0], (meta.rgb||[255,160,0])[1], (meta.rgb||[255,160,0])[2])},${rgbToHex((meta.rgb||[255,160,0])[0], (meta.rgb||[255,160,0])[1], (meta.rgb||[255,160,0])[2])})`}"></span>
        <div class="preset-hover-actions">
          <button class="icon-btn" data-action="overwrite" type="button" title="Overwrite with current state" aria-label="Overwrite preset"><svg class="icon" aria-hidden="true"><use href="#i-plus"/></svg></button>
          <button class="icon-btn" data-action="delete" type="button" title="Delete preset" aria-label="Delete preset"><svg class="icon" aria-hidden="true"><use href="#i-trash"/></svg></button>
        </div>`;
    } else {
      card.innerHTML = `<div class="preset-top"><span class="preset-slot">${String(id).padStart(2, '0')}</span></div>
        <div class="preset-add-through"><svg class="icon" aria-hidden="true"><use href="#i-plus"/></svg><span>Save here</span></div>`;
    }
    frag.appendChild(card);
  }
  ui.presetsGrid.replaceChildren(frag);
}

function kvRow(k, v, cls = '') {
  return `<div class="kv-row"><span class="k">${escapeHtml(k)}</span><span class="v ${cls}">${escapeHtml(String(v))}</span></div>`;
}
function renderInfo() {
  if (!ui.connKv) return;
  const info = getInfo();
  const leds = getLedInfo();
  const serialMode = state.mode === 'serial';
  renderConnection();
  ui.connKv.innerHTML = [
    kvRow('Mode', serialMode ? 'Web Serial' : 'Preview', serialMode ? 'good' : 'warn'),
    kvRow('Port', state.portLabel || '—'),
    kvRow('Baud rate', prefs.baud + ' bps'),
    kvRow('Terminator', prefs.lineEnding === 'lf' ? 'LF' : prefs.lineEnding === 'crlf' ? 'CRLF' : 'None'),
    kvRow('Received', formatBytes(state.serialStats.rx)),
    kvRow('Sent', formatBytes(state.serialStats.tx)),
    kvRow('Last reply', timeAgo(state.lastRxAt))
  ].join('');
  ui.deviceKv.innerHTML = [
    kvRow('Name', info.name || 'WLED'),
    kvRow('Firmware', (info.ver || '?') + (info.vid ? ' · ' + info.vid : '')),
    kvRow('Architecture', info.arch || '—'),
    kvRow('Core', info.core || '—'),
    kvRow('LED count', leds.count != null ? leds.count : '—'),
    kvRow('Max segments', leds.maxseg != null ? leds.maxseg : '—'),
    kvRow('Color', leds.rgbw ? 'RGBW' : (leds.lc & 4 ? 'CCT' : 'RGB')),
    kvRow('Uptime', info.uptime != null ? formatUptime(info.uptime) : '—'),
    kvRow('MAC', info.mac || '—')
  ].join('');
  ui.powerKv.innerHTML = [
    kvRow('Current draw', leds.pwr != null ? `${leds.pwr} mA` : '—'),
    kvRow('Power budget', leds.maxpwr != null ? `${leds.maxpwr} mA` : '—'),
    kvRow('Frame rate', leds.fps != null ? `${leds.fps} fps` : '—'),
    kvRow('Free heap', info.freeheap != null ? formatBytes(info.freeheap) : '—'),
    kvRow('Build ID', info.vid || '—')
  ].join('');
  ui.deviceHint.textContent = state.infoIsDemo ? 'sample data' : 'from device';
  ui.rawResponse.textContent = state.lastResponse
    ? JSON.stringify(state.lastResponse, null, 2)
    : (state.lastResponseText || 'No response yet. Connect a device and send {"v":true} to read state and info.');
  renderConnection();
}
function renderTransition() {
  const t = clamp(Number(state.transition) || 0, 0, 65.5);
  setElRange('transitionSlider', t);
  ui.transitionValue.textContent = t.toFixed(1) + ' s';
}
function renderNightlight() {
  ui.timerBtn.classList.toggle('active', !!state.nightlight.on);
  if (ui.nlEnabled) ui.nlEnabled.checked = !!state.nightlight.on;
  if (ui.nlDuration) {
    setElRange('nlDuration', state.nightlight.dur || 60);
    ui.nlDurationValue.textContent = (state.nightlight.dur || 60) + ' min';
    $$('.chip', ui.nlChips).forEach(c => c.classList.toggle('active', Number(c.dataset.dur) === Number(state.nightlight.dur)));
  }
  if (ui.nlMode) ui.nlMode.value = String(state.nightlight.mode ?? 1);
  if (ui.nlTarget) ui.nlTarget.value = state.nightlight.tbri ?? 0;
}

function renderAll() {
  renderConnection();
  renderPower();
  renderBrightness();
  renderSegmentSelectors();
  renderSegments();
  renderColor();
  renderEffectList();
  renderEffectCurrent();
  renderPaletteList();
  renderTransition();
  renderNightlight();
  renderPresets();
  renderStateTiles();
  renderInfo();
  if (ui.effectsCatalogInput) ui.effectsCatalogInput.value = JSON.stringify(effectCatalog);
  if (ui.palettesCatalogInput) ui.palettesCatalogInput.value = JSON.stringify(paletteCatalog);
}
