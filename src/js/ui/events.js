/**
 * ui/events.js
 * DOM element cache and every event binding.
 */

'use strict';

/* ------------------------------------------------------------------ *
 *  UI helpers                                                         *
 * ------------------------------------------------------------------ */
const EXAMPLE_COMMAND = '{"seg":[{"id":0,"col":[[255,160,0,0]]}],"v":true}';

function cacheEls() {
  $$('[id]').forEach(el => {
    if (el.namespaceURI === 'http://www.w3.org/2000/svg') return;
    ui[el.id] = el;
  });
}

/* ------------------------------------------------------------------ *
 *  Event bindings                                                     *
 * ------------------------------------------------------------------ */
function bindEvents() {
  ui.connChip.addEventListener('click', openSettings);
  ui.settingsBtn.addEventListener('click', openSettings);
  ui.connectNowBtn.addEventListener('click', connectSerial);
  ui.powerBtn.addEventListener('click', togglePower);
  ui.timerBtn.addEventListener('click', openTimerDialog);
  ui.consoleBtn.addEventListener('click', openTerminal);
  ui.topInfoBtn.addEventListener('click', () => switchTab('info'));

  ui.topBrightness.addEventListener('input', e => applyBrightness(Number(e.target.value)));

  /* color wheel */
  ui.colorWheel.addEventListener('pointerdown', e => {
    e.preventDefault();
    lastUserActivity = Date.now();
    try { ui.colorWheel.focus({ preventScroll: true }); } catch { /* ignore */ }
    wheelDragging = true;
    ui.colorWheel.classList.add('dragging');
    try { ui.colorWheel.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    updateFromWheel(e);
  });
  ui.colorWheel.addEventListener('pointermove', e => {
    if (!wheelDragging) return;
    lastUserActivity = Date.now();
    updateFromWheel(e);
  });
  const endWheelDrag = e => {
    if (!wheelDragging) return;
    wheelDragging = false;
    ui.colorWheel.classList.remove('dragging');
    try { ui.colorWheel.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  };
  ui.colorWheel.addEventListener('pointerup', endWheelDrag);
  ui.colorWheel.addEventListener('pointercancel', endWheelDrag);
  ui.colorWheel.addEventListener('keydown', e => {
    const step = e.shiftKey ? 1 : 4;
    let h = state.hsv.h || 0;
    let s = state.hsv.s || 0;
    if (e.key === 'ArrowLeft') h -= step;
    else if (e.key === 'ArrowRight') h += step;
    else if (e.key === 'ArrowUp') s += step;
    else if (e.key === 'ArrowDown') s -= step;
    else return;
    e.preventDefault();
    applyHsvColor(h, s);
  });

  /* color inputs */
  ui.hueSlider.addEventListener('input', () => {
    applyHsvColor(Number(ui.hueSlider.value), state.hsv.s || 100);
  });
  ui.satSlider.addEventListener('input', () => {
    applyHsvColor(state.hsv.h || 0, Number(ui.satSlider.value));
  });
  ui.kelvinSlider.addEventListener('input', () => {
    const seg = activeSegment();
    const cct = clamp(Math.round(Number(ui.kelvinSlider.value) || 4000), 1900, 10091);
    seg.cct = cct;
    setRange(ui.kelvinSlider, cct);
    ui.kelvinValue.textContent = cct + ' K';
    queueJSON('cct-' + seg.id, { seg: [{ id: seg.id, cct }] });
  });
  const applyRgbSliders = () => {
    const r = Number(ui.redSlider.value);
    const g = Number(ui.greenSlider.value);
    const b = Number(ui.blueSlider.value);
    const w = Number(ui.whiteSlider.value);
    applyColor(r, g, b, w, { send: true });
  };
  [ui.redSlider, ui.greenSlider, ui.blueSlider, ui.whiteSlider].forEach(slider => {
    slider.addEventListener('input', applyRgbSliders);
  });
  ui.hexApplyBtn.addEventListener('click', applyHexInput);
  ui.hexInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); applyHexInput(); }
  });

  /* palettes */
  ui.paletteSearch.addEventListener('input', renderPaletteList);
  ui.paletteList.addEventListener('click', e => {
    const row = e.target.closest('.palette-row');
    if (row) applyPalette(Number(row.dataset.pal));
  });

  /* effects */
  ui.effectSearch.addEventListener('input', renderEffectList);
  ui.effectList.addEventListener('click', e => {
    const row = e.target.closest('.effect-row');
    if (row) applyEffect(Number(row.dataset.fx));
  });
  ui.speedSlider.addEventListener('input', () => {
    const seg = activeSegment();
    const value = Number(ui.speedSlider.value);
    seg.sx = value;
    setRange(ui.speedSlider, value);
    ui.speedValue.textContent = value;
    queueJSON('speed-' + seg.id, { seg: [{ id: seg.id, sx: value }] });
  });
  ui.intensitySlider.addEventListener('input', () => {
    const seg = activeSegment();
    const value = Number(ui.intensitySlider.value);
    seg.ix = value;
    setRange(ui.intensitySlider, value);
    ui.intensityValue.textContent = value;
    queueJSON('intensity-' + seg.id, { seg: [{ id: seg.id, ix: value }] });
  });
  ui.freezeBtn.addEventListener('click', () => {
    const seg = activeSegment();
    seg.frz = !seg.frz;
    sendJSON({ seg: [{ id: seg.id, frz: seg.frz }] }, { label: 'freeze' });
    renderEffectCurrent();
  });
  ui.randomEffectBtn.addEventListener('click', () => {
    const valid = effectCatalog.map((name, id) => ({ name, id }))
      .filter(row => row.name && row.name !== 'RSVD' && row.name !== '-');
    if (!valid.length) return;
    const row = valid[Math.floor(Math.random() * valid.length)];
    applyEffect(row.id);
    showToast(`Effect: ${row.name}`);
  });
  ui.paletteJumpBtn.addEventListener('click', () => {
    switchTab('colors');
    setTimeout(() => ui.paletteList.scrollIntoView({ behavior: 'smooth', block: 'center' }), 60);
  });
  const setEffectId = () => applyEffect(clamp(Math.round(Number(ui.effectIdInput.value) || 0), 0, 254));
  ui.setEffectIdBtn.addEventListener('click', setEffectId);
  ui.effectIdInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); setEffectId(); }
  });

  /* segment selectors */
  for (const sel of [ui.colorSegSelect, ui.effectSegSelect]) {
    sel.addEventListener('change', () => setActiveSegment(Number(sel.value)));
  }
  ui.addSegmentBtn.addEventListener('click', addSegment);
  ui.resetSegmentsBtn.addEventListener('click', resetSegments);
  ui.configureSegmentsBtn.addEventListener('click', configureFourSegments);

  /* segment cards */
  ui.segmentsGrid.addEventListener('focusin', e => {
    const card = e.target.closest('.segment-card');
    if (!card) return;
    const id = Number(card.dataset.segId);
    if (id !== state.activeSegmentId) setActiveSegment(id);
  });
  ui.segmentsGrid.addEventListener('input', e => {
    const target = e.target;
    if (!target.matches('[data-field]')) return;
    const card = target.closest('.segment-card');
    if (!card) return;
    const id = Number(card.dataset.segId);
    const seg = state.segments.find(s => s.id === id);
    if (!seg) return;
    if (target.dataset.field === 'bri') {
      const value = clamp(Math.round(Number(target.value) || 0), 0, 255);
      seg.bri = value;
      setRange(target, value);
      const out = card.querySelector('[data-role="bri-out"]');
      if (out) out.textContent = value;
      queueJSON('seg-bri-' + id, { seg: [{ id, bri: value }] });
    }
  });
  ui.segmentsGrid.addEventListener('change', e => {
    const target = e.target;
    if (!target.matches('[data-field]')) return;
    const card = target.closest('.segment-card');
    if (!card) return;
    const id = Number(card.dataset.segId);
    const seg = state.segments.find(s => s.id === id);
    if (!seg) return;
    const field = target.dataset.field;
    if (field === 'on') {
      seg.on = !!target.checked;
      card.style.opacity = seg.on === false ? '.72' : '';
      sendJSON({ seg: [{ id, on: seg.on }] }, { label: 'segment power' });
    } else if (field === 'name') {
      const name = (target.value || '').trim() || `Segment ${id + 1}`;
      target.value = name;
      seg.name = name;
      sendJSON({ seg: [{ id, n: name }] }, { label: 'segment name' });
      renderSegmentSelectors();
    } else if (field === 'start' || field === 'stop') {
      const startInput = card.querySelector('[data-field="start"]');
      const stopInput = card.querySelector('[data-field="stop"]');
      let start = clamp(Math.round(Number(startInput.value) || 0), 0, totalLeds() - 1);
      let stop = clamp(Math.round(Number(stopInput.value) || 0), 1, totalLeds());
      if (stop <= start) {
        if (field === 'start') stop = Math.min(totalLeds(), start + 1);
        else start = Math.max(0, stop - 1);
      }
      startInput.value = start;
      stopInput.value = stop;
      seg.start = start;
      seg.stop = stop;
      seg.len = stop - start;
      sendJSON({ seg: [{ id, start, stop }] }, { label: 'segment range' });
      updateSegmentSummary(id);
      if (state.activeSegmentId === id) renderColor();
    } else if (field === 'grp' || field === 'spc') {
      const value = clamp(Math.round(Number(target.value) || 0), field === 'grp' ? 1 : 0, 255);
      target.value = value;
      seg[field] = value;
      queueJSON(`seg-${field}-` + id, { seg: [{ id, [field]: value }] });
    }
  });
  ui.segmentsGrid.addEventListener('click', e => {
    const card = e.target.closest('.segment-card');
    if (!card) return;
    const id = Number(card.dataset.segId);
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (action === 'delete') { deleteSegment(id); return; }
    if (action === 'colors' || action === 'effects') {
      setActiveSegment(id);
      switchTab(action);
      return;
    }
    if (action === 'reverse') {
      const seg = state.segments.find(s => s.id === id);
      if (!seg) return;
      seg.rev = !seg.rev;
      sendJSON({ seg: [{ id, rev: seg.rev }] }, { label: 'reverse segment' });
      renderSegments();
      return;
    }
    if (!e.target.closest('button, input, select, textarea, label, summary, details')) {
      setActiveSegment(id);
    }
  });

  /* global segment settings */
  ui.transitionSlider.addEventListener('input', () => {
    const value = clamp(Number(ui.transitionSlider.value) || 0, 0, 65.5);
    state.transition = value;
    setRange(ui.transitionSlider, value);
    ui.transitionValue.textContent = value.toFixed(1) + ' s';
    queueJSON('transition', { transition: Math.round(value * 10) });
  });

  /* presets */
  ui.savePresetBtn.addEventListener('click', () => openPresetDialog(firstEmptyPresetSlot()));
  ui.presetsGrid.addEventListener('click', e => {
    const card = e.target.closest('.preset-card');
    if (!card) return;
    const id = Number(card.dataset.slot);
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (action === 'delete') { deletePreset(id); return; }
    if (action === 'overwrite') { openPresetDialog(id); return; }
    presetCardAction(card);
  });
  ui.presetsGrid.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    if (e.target.closest('[data-action]')) return;
    const card = e.target.closest('.preset-card');
    if (!card) return;
    e.preventDefault();
    presetCardAction(card);
  });
  ui.presetSlotSelect.addEventListener('change', () => {
    presetDialogSlot = clamp(Number(ui.presetSlotSelect.value) || 1, 1, PRESET_SLOTS);
    ui.presetNameInput.value = presetStore.meta[presetDialogSlot]?.name || effectName(activeSegment().fx);
    updatePresetOverwriteNote();
  });
  ui.presetNameInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); savePresetFromDialog(); }
  });
  ui.confirmSavePresetBtn.addEventListener('click', savePresetFromDialog);

  /* info */
  ui.stateRefreshBtn.addEventListener('click', requestState);
  ui.infoRefreshBtn.addEventListener('click', requestState);
  ui.infoConnectBtn.addEventListener('click', connectSerial);
  ui.infoDisconnectBtn.addEventListener('click', () => disconnectSerial());
  ui.infoConsoleBtn.addEventListener('click', openTerminal);
  ui.apiConsoleBtn.addEventListener('click', openTerminal);
  ui.rebootBtn.addEventListener('click', () => {
    confirmAction({
      title: 'Reboot WLED?',
      message: 'The controller will restart and the serial port will close.',
      okLabel: 'Reboot',
      danger: true,
      onConfirm: () => {
        flushChannels();
        sendJSON({ rb: true }, { label: 'reboot' });
        showToast(state.mode === 'serial' ? 'Reboot command sent.' : 'Preview: reboot requested.', 'warn');
      }
    });
  });
  ui.copyRawBtn.addEventListener('click', () => {
    const text = state.lastResponse ? JSON.stringify(state.lastResponse, null, 2) : state.lastResponseText;
    if (!text) { showToast('No response to copy yet.', 'warn'); return; }
    copyText(text, 'Response copied.');
  });
  ui.copyExampleBtn.addEventListener('click', () => copyText(EXAMPLE_COMMAND, 'Example command copied.'));
  $$('[data-command]').forEach(btn => {
    btn.addEventListener('click', () => {
      const command = btn.dataset.command;
      try { JSON.parse(command); }
      catch { showToast('Invalid JSON command.', 'error'); return; }
      sendRawText(command);
      showToast('Command sent.');
    });
  });

  /* settings */
  ui.baudSelect.addEventListener('change', () => {
    prefs.baud = Number(ui.baudSelect.value) || 115200;
    savePrefs();
    renderInfo();
    showToast(`Baud rate set to ${prefs.baud}.`);
  });
  ui.lineEndingSelect.addEventListener('change', () => {
    prefs.lineEnding = ui.lineEndingSelect.value;
    savePrefs();
    renderInfo();
    showToast('Command terminator updated.');
  });
  ui.autoSyncToggle.addEventListener('change', () => {
    prefs.autoSync = !!ui.autoSyncToggle.checked;
    savePrefs();
    showToast(prefs.autoSync ? 'Live state sync enabled.' : 'Live state sync disabled.');
  });
  ui.connectBtn.addEventListener('click', connectSerial);
  ui.disconnectBtn.addEventListener('click', () => disconnectSerial());
  ui.applyEffectsCatalog.addEventListener('click', () => applyCatalog('effects'));
  ui.applyPalettesCatalog.addEventListener('click', () => applyCatalog('palettes'));
  ui.resetEffectsCatalog.addEventListener('click', () => resetCatalog('effects'));
  ui.resetPalettesCatalog.addEventListener('click', () => resetCatalog('palettes'));

  /* nightlight */
  ui.nlEnabled.addEventListener('change', () => {
    state.nightlight.on = !!ui.nlEnabled.checked;
    renderNightlight();
  });
  ui.nlDuration.addEventListener('input', () => {
    const dur = clamp(Math.round(Number(ui.nlDuration.value) || 60), 1, 240);
    setRange(ui.nlDuration, dur);
    ui.nlDurationValue.textContent = dur + ' min';
    state.nightlight.dur = dur;
    $$('.chip', ui.nlChips).forEach(c => c.classList.toggle('active', Number(c.dataset.dur) === dur));
  });
  ui.nlChips.addEventListener('click', e => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    const dur = Number(chip.dataset.dur);
    state.nightlight.dur = dur;
    setRange(ui.nlDuration, dur);
    ui.nlDurationValue.textContent = dur + ' min';
    $$('.chip', ui.nlChips).forEach(c => c.classList.toggle('active', c === chip));
  });
  ui.applyTimerBtn.addEventListener('click', applyNightlight);

  /* confirm dialog */
  ui.confirmOkBtn.addEventListener('click', () => {
    const callback = confirmCallback;
    confirmCallback = null;
    ui.confirmDialog.close();
    if (callback) {
      try { callback(); }
      catch (err) { showToast('Action failed: ' + (err.message || err), 'error', 5000); }
    }
  });
  ui.confirmCancelBtn.addEventListener('click', () => {
    confirmCallback = null;
    ui.confirmDialog.close();
  });
  ui.confirmDialog.addEventListener('close', () => { confirmCallback = null; });

  /* dialog close buttons and backdrop */
  $$('dialog [data-close]').forEach(btn => {
    btn.addEventListener('click', () => btn.closest('dialog')?.close());
  });
  $$('dialog').forEach(dialog => {
    dialog.addEventListener('click', e => {
      if (e.target === dialog) dialog.close();
    });
  });

  /* terminal */
  ui.terminalClose.addEventListener('click', closeTerminal);
  ui.terminalClear.addEventListener('click', () => {
    ui.terminalLog.replaceChildren();
    logLine('sys', 'Console cleared.');
  });
  ui.terminalRefresh.addEventListener('click', requestState);
  ui.terminalForm.addEventListener('submit', e => {
    e.preventDefault();
    const text = ui.terminalInput.value.trim();
    if (!text) return;
    lastUserActivity = Date.now();
    sendRawText(text);
    ui.terminalInput.value = '';
    ui.terminalInput.focus();
  });

  /* navigation */
  $$('.tabbtn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
  window.addEventListener('hashchange', () => {
    const tab = (location.hash || '').replace(/^#/, '');
    if (['colors', 'effects', 'segments', 'presets', 'info'].includes(tab)) switchTab(tab);
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && state.terminalOpen && !document.querySelector('dialog[open]')) {
      closeTerminal();
    }
  });
  ['pointerdown', 'keydown', 'input'].forEach(type => {
    document.addEventListener(type, () => { lastUserActivity = Date.now(); }, { capture: true, passive: true });
  });

  if (serialSupported()) {
    navigator.serial.addEventListener('disconnect', e => {
      if (!serial.port) return;
      const gone = e.port || (e.target && e.target !== navigator.serial ? e.target : null);
      if (!gone || gone === serial.port) handleSerialLoss();
    });
  }
}
