/**
 * app.js
 * Startup sequence and the idle state-sync timer.
 */

'use strict';

/* ------------------------------------------------------------------ *
 *  Boot                                                               *
 * ------------------------------------------------------------------ */
function startAutoSync() {
  clearInterval(serial.syncTimer);
  serial.syncTimer = setInterval(() => {
    if (state.mode !== 'serial' || !state.handshake || !prefs.autoSync) return;
    if (document.hidden || state.terminalOpen) return;
    if (Date.now() - lastUserActivity < 4000) return;
    if (txPumping || txQueue.length || channelFlushTimer) return;
    sendJSON({ v: true }, { label: 'auto sync' });
  }, 8000);
}
function init() {
  cacheEls();
  renderColorSlotsStatic();
  renderQuickColorsStatic();
  bindEvents();
  renderAll();
  const initial = (location.hash || '').replace(/^#/, '');
  switchTab(['colors', 'effects', 'segments', 'presets', 'info'].includes(initial) ? initial : 'colors');
  startAutoSync();
  if (!serialSupported()) {
    ui.connectNowBtn.disabled = true;
    ui.connectNowBtn.title = 'Web Serial is unavailable in this browser';
    ui.connectNowBtn.style.opacity = '.55';
  }
  setTimeout(() => document.getElementById('bootLoader')?.classList.add('hidden'), 450);
}

try {
  init();
} catch (err) {
  console.error('WLED Web Serial failed to initialize:', err);
  const toast = document.getElementById('toast');
  const text = document.getElementById('toastText');
  if (toast && text) {
    text.textContent = 'UI failed to initialize: ' + (err.message || err);
    toast.classList.add('show', 'error');
  }
  const loaderText = document.querySelector('.boot-text');
  if (loaderText) loaderText.textContent = 'Initialization failed. See console.';
}
