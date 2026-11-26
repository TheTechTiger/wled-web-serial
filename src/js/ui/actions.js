/**
 * ui/actions.js
 * User actions: color, brightness, effects, segments, presets and tabs.
 */

'use strict';

function applyColor(r, g, b, w, opts = {}) {
  const seg = activeSegment();
  const slot = clamp(state.selectedSlot, 0, 2);
  const c = [clamp(Math.round(r), 0, 255), clamp(Math.round(g), 0, 255), clamp(Math.round(b), 0, 255), clamp(Math.round(w ?? (seg.colors?.[slot]?.[3] || 0)), 0, 255)];
  if (!Array.isArray(seg.colors)) seg.colors = [[0,0,0,0],[0,0,0,0],[0,0,0,0]];
  seg.colors[slot] = c;
  const hsv = rgbToHsv(c[0], c[1], c[2]);
  state.hsv = { h: hsv.s > 0.1 ? hsv.h : state.hsv.h, s: hsv.s };
  renderColor();
  renderEffectCurrent();
  if (opts.send !== false) {
    queueJSON('color', { seg: [{ id: seg.id, col: seg.colors.map(x => x.map(n => Math.round(n))) }] });
  }
}
function applyBrightness(value, opts = {}) {
  const b = clamp(Math.round(value), 1, 255);
  state.brightness = b;
  if (state.on === false) { state.on = true; renderPower(); }
  renderBrightness();
  if (opts.send !== false) queueJSON('brightness', { on: true, bri: b });
}
function applyEffect(id, opts = {}) {
  const seg = activeSegment();
  seg.fx = clamp(Number(id) || 0, 0, 254);
  renderEffectCurrent();
  if (opts.send !== false) sendJSON({ seg: [{ id: seg.id, fx: seg.fx }] }, { verbose: true, label: 'effect' });
}
function applyPalette(id, opts = {}) {
  const seg = activeSegment();
  seg.pal = clamp(Number(id) || 0, 0, 255);
  renderPaletteSelection();
  renderEffectCurrent();
  if (opts.send !== false) sendJSON({ seg: [{ id: seg.id, pal: seg.pal }] }, { verbose: true, label: 'palette' });
}

function addSegment() {
  if (state.segments.length >= maxSegments()) {
    showToast(`This build supports ${maxSegments()} segments.`, 'warn');
    return;
  }
  const seg = activeSegment();
  const nextId = Math.max(...state.segments.map(s => s.id), -1) + 1;
  const count = state.segments.length;
  let start = 0, stop = totalLeds();
  if (seg.stop - seg.start >= 2) {
    const mid = Math.floor((seg.start + seg.stop) / 2);
    start = mid; stop = seg.stop;
    seg.stop = mid; seg.len = mid - seg.start;
    queueJSON('seg-edit', { seg: [{ id: seg.id, start: seg.start, stop: seg.stop }] });
  } else {
    const maxStop = Math.max(...state.segments.map(s => s.stop), 0);
    start = Math.min(maxStop, totalLeds() - 1);
    stop = totalLeds();
  }
  const newSeg = {
    ...deepClone(seg), id: nextId, name: 'Segment ' + (count + 1), start, stop, len: stop - start,
    sel: true, colors: seg.colors.map(c => c.slice()), frz: false
  };
  if (state.mode === 'serial') {
    const cmd = { seg: [{ id: nextId, start, stop, name: newSeg.name, col: newSeg.colors, fx: newSeg.fx, pal: newSeg.pal, sx: newSeg.sx, ix: newSeg.ix, on: true }] };
    sendJSON(cmd, { verbose: true, label: 'add segment' });
  }
  state.segments.push(newSeg);
  state.activeSegmentId = nextId;
  renderSegments();
  renderSegmentSelectors();
  renderColor();
  renderEffectCurrent();
  showToast(`Segment ${count + 1} added.`);
}
function deleteSegment(id) {
  if (state.segments.length <= 1) {
    showToast('At least one segment is required.', 'warn');
    return;
  }
  const seg = state.segments.find(s => s.id === id);
  if (!seg) return;
  confirmAction({
    title: `Delete ${seg.name || 'segment'}?`,
    message: 'The LED range will be released. This sends stop:0 to the device.',
    okLabel: 'Delete segment',
    danger: true,
    onConfirm: () => {
      sendJSON({ seg: [{ id: seg.id, stop: 0 }] }, { label: 'delete segment' });
      state.segments = state.segments.filter(s => s.id !== id);
      if (state.activeSegmentId === id) state.activeSegmentId = state.segments[0]?.id ?? 0;
      renderSegments();
      renderSegmentSelectors();
      renderColor();
      renderEffectCurrent();
      showToast('Segment deleted.');
    }
  });
}
function resetSegments() {
  confirmAction({
    title: 'Reset all segments?',
    message: 'WLED will replace the current zones with one full-strip segment.',
    okLabel: 'Reset segments',
    danger: false,
    onConfirm: () => {
      sendJSON({ rSeg: true }, { verbose: true, label: 'reset segments' });
      const c = activeColor();
      state.segments = [{
        id: 0, name: 'Segment 1', start: 0, stop: totalLeds(), len: totalLeds(), on: true, bri: 255,
        colors: [[c.r, c.g, c.b, c.w],[0,0,0,0],[0,0,0,0]], fx: activeSegment().fx, sx: 128, ix: 128, pal: 0,
        rev: false, sel: true, grp: 1, spc: 0, frz: false
      }];
      state.activeSegmentId = 0;
      state.selectedSlot = 0;
      renderSegments();
      renderSegmentSelectors();
      renderColor();
      renderEffectCurrent();
      showToast('Segments reset.');
    }
  });
}
function configureFourSegments() {
  const total = totalLeds();
  const names = ['Bottom', 'Left', 'Top', 'Right'];
  const ranges = [[0, 11], [11, 25], [25, 46], [46, 60]];
  const message = total === 60
    ? 'Create four segments for the 60-LED ambilight frame: bottom 0-10, left 11-24, top 25-45, right 46-59. Existing segments will be replaced.'
    : `Your strip currently reports ${total} LEDs, not 60. Set LED count to 60 in WLED LED Preferences first, or the ranges may be rejected.`;
  confirmAction({
    title: 'Configure 4-segment layout?',
    message,
    okLabel: 'Configure',
    danger: false,
    onConfirm: () => {
      if (state.mode === 'serial') {
        sendJSON({ rSeg: true }, { label: 'reset segments' });
        setTimeout(() => {
          sendJSON({ seg: ranges.map((r, i) => ({ id: i, start: r[0], stop: r[1], n: names[i] })) }, { verbose: true, label: 'configure 4 segments' });
        }, 250);
      }
      const c = activeColor();
      state.segments = ranges.map((r, i) => ({
        id: i, name: `Segment ${i + 1}`, start: r[0], stop: r[1], len: r[1] - r[0], on: true, bri: 255,
        colors: [[c.r, c.g, c.b, c.w],[0,0,0,0],[0,0,0,0]], fx: activeSegment().fx, sx: 128, ix: 128, pal: 0,
        rev: false, sel: i === 0, grp: 1, spc: 0, frz: false
      }));
      state.activeSegmentId = 0;
      state.selectedSlot = 0;
      renderSegments();
      renderSegmentSelectors();
      renderColor();
      renderEffectCurrent();
      showToast(state.mode === 'serial' ? '4-segment layout sent to WLED.' : 'Preview: 4-segment layout applied.');
    }
  });
}

function applyPreset(id) {
  const meta = presetStore.meta[id];
  state.currentPreset = id;
  if (state.mode === 'preview') {
    const snap = presetStore.snapshots[id];
    if (snap) restoreSnapshot(snap);
    showToast(meta ? `Preview: ${meta.name}` : `Preview: preset ${id}`);
  } else {
    sendJSON({ ps: id }, { verbose: true, label: 'preset ' + id });
    showToast(`Applying ${meta?.name || 'preset ' + id}…`);
  }
  renderPresets();
  renderColor();
  renderEffectCurrent();
  renderSegmentSelectors();
  renderSegments();
}
function snapshotState() {
  return {
    on: state.on,
    brightness: state.brightness,
    transition: state.transition,
    nightlight: deepClone(state.nightlight),
    segments: deepClone(state.segments),
    activeSegmentId: state.activeSegmentId,
    selectedSlot: state.selectedSlot
  };
}
function restoreSnapshot(snap) {
  if (!snap) return;
  if (typeof snap.on === 'boolean') state.on = snap.on;
  if (Number.isFinite(snap.brightness)) state.brightness = snap.brightness;
  if (Number.isFinite(snap.transition)) state.transition = snap.transition;
  if (snap.nightlight) state.nightlight = deepClone(snap.nightlight);
  if (Array.isArray(snap.segments) && snap.segments.length) state.segments = deepClone(snap.segments);
  if (Number.isFinite(snap.activeSegmentId)) state.activeSegmentId = snap.activeSegmentId;
  if (Number.isFinite(snap.selectedSlot)) state.selectedSlot = snap.selectedSlot;
  renderPower(); renderBrightness(); renderColor(); renderEffectCurrent(); renderSegmentSelectors(); renderSegments(); renderTransition();
}
function openPresetDialog(slot) {
  presetDialogSlot = clamp(Number(slot) || 1, 1, PRESET_SLOTS);
  const select = ui.presetSlotSelect;
  select.innerHTML = Array.from({ length: PRESET_SLOTS }, (_, i) => i + 1)
    .map(i => `<option value="${i}">${String(i).padStart(2, '0')} — ${escapeHtml(presetName(i))}</option>`).join('');
  select.value = String(presetDialogSlot);
  ui.presetNameInput.value = presetStore.meta[presetDialogSlot]?.name || effectName(activeSegment().fx);
  updatePresetOverwriteNote();
  ui.presetDialog.showModal();
  setTimeout(() => ui.presetNameInput.select(), 30);
}
function updatePresetOverwriteNote() {
  ui.presetOverwriteNote.style.display = presetStore.meta[presetDialogSlot] ? 'flex' : 'none';
}
function savePresetFromDialog() {
  const id = clamp(Number(ui.presetSlotSelect.value) || 1, 1, PRESET_SLOTS);
  const name = (ui.presetNameInput.value || '').trim() || effectName(activeSegment().fx) || `Preset ${id}`;
  const seg = activeSegment();
  const c = activeColor();
  presetStore.meta[id] = {
    name, effect: seg.fx, palette: seg.pal, rgb: [c.r, c.g, c.b], savedAt: Date.now()
  };
  presetStore.snapshots[id] = snapshotState();
  saveJSON(PRESET_STORE_KEY, presetStore);
  state.currentPreset = id;
  if (state.mode === 'serial') {
    sendJSON({ psave: id, n: name, ib: true, sb: true }, { verbose: true, label: `save preset ${id}` });
  }
  ui.presetDialog.close();
  renderPresets();
  showToast(`Saved “${name}” to slot ${id}.`);
}
function deletePreset(id) {
  confirmAction({
    title: `Delete preset ${id}?`,
    message: presetStore.meta[id] ? `“${presetStore.meta[id].name}” will be removed.` : 'The preset slot will be erased on the device.',
    okLabel: 'Delete preset',
    danger: true,
    onConfirm: () => {
      delete presetStore.meta[id];
      delete presetStore.snapshots[id];
      saveJSON(PRESET_STORE_KEY, presetStore);
      if (state.currentPreset === id) state.currentPreset = -1;
      if (state.mode === 'serial') sendJSON({ pdel: id }, { label: 'delete preset' });
      renderPresets();
      showToast('Preset deleted.');
    }
  });
}

function switchTab(tab) {
  if (!['colors','effects','segments','presets','info'].includes(tab)) tab = 'colors';
  state.activeTab = tab;
  $$('.panel').forEach(p => p.classList.toggle('active', p.id === 'panel-' + tab));
  $$('.tabbtn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  try { history.replaceState(null, '', '#' + tab); } catch { /* file URL may reject */ }
  if (tab === 'presets') renderPresets();
  if (tab === 'info') renderInfo();
  if (tab === 'segments') renderSegments();
  if (tab === 'effects') { renderEffectList(); renderEffectCurrent(); }
  if (tab === 'colors') { renderPaletteList(); renderColor(); }
  window.scrollTo({ top: 0, behavior: 'auto' });
}

function setActiveSegment(id) {
  if (!state.segments.some(s => s.id === Number(id))) return;
  flushChannels();
  state.activeSegmentId = Number(id);
  state.selectedSlot = 0;
  renderSegments();
  renderSegmentSelectors();
  renderColor();
  renderEffectCurrent();
}
function togglePower() {
  flushChannels();
  state.on = !state.on;
  renderPower();
  sendJSON({ on: state.on }, { label: 'power' });
  if (state.mode === 'preview') showToast(state.on ? 'Preview: light on' : 'Preview: light off');
}

function applyCatalog(kind) {
  const isEffects = kind === 'effects';
  const textarea = isEffects ? ui.effectsCatalogInput : ui.palettesCatalogInput;
  let parsed;
  try { parsed = JSON.parse(textarea.value); }
  catch { showToast('Catalog must be valid JSON.', 'error'); return; }
  if (!Array.isArray(parsed) || !parsed.every(v => typeof v === 'string')) {
    showToast('Catalog must be a JSON array of strings.', 'error'); return;
  }
  if (!parsed.length) { showToast('Catalog is empty.', 'error'); return; }
  if (isEffects) {
    effectCatalog = parsed.slice(0, 255);
    renderEffectList();
    renderEffectCurrent();
  } else {
    paletteCatalog = parsed.slice(0, 256);
    renderPaletteList();
    renderEffectCurrent();
  }
  savePrefs();
  textarea.value = JSON.stringify(isEffects ? effectCatalog : paletteCatalog);
  showToast(`${isEffects ? 'Effect' : 'Palette'} catalog updated.`);
}

function applyNightlight() {
  const on = !!ui.nlEnabled.checked;
  const dur = clamp(Math.round(Number(ui.nlDuration.value) || 60), 1, 240);
  const mode = clamp(Math.round(Number(ui.nlMode.value) || 0), 0, 4);
  const tbri = clamp(Math.round(Number(ui.nlTarget.value) || 0), 0, 255);
  flushChannels();
  state.nightlight = { on, dur, mode, tbri, rem: on ? dur * 60 : -1 };
  sendJSON({ nl: on ? { on: true, dur, mode, tbri } : { on: false } }, { label: 'nightlight' });
  renderNightlight();
  ui.timerDialog.close();
  showToast(on ? `Nightlight set for ${dur} minutes.` : 'Nightlight disabled.');
}

function resetCatalog(kind) {
  const isEffects = kind === 'effects';
  if (isEffects) {
    effectCatalog = DEFAULT_EFFECTS.slice();
    ui.effectsCatalogInput.value = JSON.stringify(effectCatalog);
    renderEffectList();
    renderEffectCurrent();
  } else {
    paletteCatalog = DEFAULT_PALETTES.slice();
    ui.palettesCatalogInput.value = JSON.stringify(paletteCatalog);
    renderPaletteList();
    renderEffectCurrent();
  }
  savePrefs();
  showToast(`Default ${isEffects ? 'effect' : 'palette'} catalog restored.`);
}

function requestState() {
  lastUserActivity = Date.now();
  if (state.mode === 'serial') {
    sendJSON({ v: true }, { label: 'state refresh' });
    showToast('State requested from WLED.');
  } else {
    renderAll();
    showToast('Preview state refreshed.');
  }
}
function firstEmptyPresetSlot() {
  for (let id = 1; id <= PRESET_SLOTS; id++) {
    if (!presetStore.meta[id]) return id;
  }
  return 1;
}

function applyHexInput() {
  const c = hexToRgb(ui.hexInput.value);
  if (!c) {
    showToast('Enter a 6- or 8-digit hex color.', 'error');
    ui.hexInput.focus();
    ui.hexInput.select();
    return;
  }
  applyColor(c.r, c.g, c.b, c.w, { send: true });
}
function applyHsvColor(h, s) {
  const sat = clamp(s, 0, 100);
  const hue = ((h % 360) + 360) % 360;
  state.hsv = { h: hue, s: sat };
  const rgb = hsvToRgb(hue, sat, 100);
  applyColor(rgb.r, rgb.g, rgb.b, activeColor().w, { send: true });
}
function updateFromWheel(e) {
  const rect = ui.colorWheel.getBoundingClientRect();
  const radius = rect.width / 2;
  if (!radius) return;
  const dx = e.clientX - (rect.left + radius);
  const dy = e.clientY - (rect.top + radius);
  const dist = Math.min(Math.hypot(dx, dy), radius);
  const hue = (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360;
  const sat = clamp((dist / radius) * 100, 0, 100);
  applyHsvColor(hue, sat);
}
function presetCardAction(card) {
  if (!card) return;
  const id = Number(card.dataset.slot);
  if (presetStore.meta[id]) applyPreset(id);
  else openPresetDialog(id);
}
