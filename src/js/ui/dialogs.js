/**
 * ui/dialogs.js
 * Modal dialogs: settings, confirmations, console and nightlight.
 */

'use strict';

function openSettings() {
  if (!ui.settingsDialog) return;
  renderConnection();
  ui.baudSelect.value = String(prefs.baud);
  ui.lineEndingSelect.value = prefs.lineEnding;
  ui.autoSyncToggle.checked = !!prefs.autoSync;
  if (!serialSupported()) {
    ui.browserSupportNote.className = 'callout';
    ui.browserSupportNote.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-alert"/></svg><span>Web Serial is not available in this browser. Use Chrome, Edge or Opera on desktop and serve the file from HTTPS or localhost.</span>';
    ui.connectBtn.disabled = true;
    ui.connectBtn.style.opacity = '.5';
  } else {
    ui.browserSupportNote.className = 'callout info';
    ui.browserSupportNote.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-info"/></svg><span>Web Serial works in Chromium-based desktop browsers over HTTPS or localhost. Close any other serial monitor before connecting.</span>';
    ui.connectBtn.disabled = false;
    ui.connectBtn.style.opacity = '';
  }
  if (!ui.settingsDialog.open) ui.settingsDialog.showModal();
}
function confirmAction({ title, message, okLabel = 'Confirm', danger = false, onConfirm }) {
  confirmCallback = onConfirm || null;
  ui.confirmTitle.textContent = title;
  ui.confirmSub.textContent = danger ? 'This action cannot be undone.' : 'Please confirm.';
  ui.confirmMessage.textContent = message || '';
  ui.confirmOkBtn.textContent = okLabel;
  ui.confirmOkBtn.classList.toggle('btn-danger', !!danger);
  ui.confirmOkBtn.classList.toggle('btn-primary', !danger);
  ui.confirmDialog.showModal();
}

function openTerminal() {
  state.terminalOpen = true;
  ui.terminal.classList.add('open');
  ui.terminal.setAttribute('aria-hidden', 'false');
  if (!ui.terminalLog.children.length) {
    logLine('sys', 'WLED Web Serial console ready. Commands are sent as raw JSON text.');
    logLine('sys', serialSupported() ? 'Web Serial API detected.' : 'Web Serial API unavailable in this browser.');
  }
  setTimeout(() => ui.terminalInput.focus(), 80);
}
function closeTerminal() {
  state.terminalOpen = false;
  ui.terminal.classList.remove('open');
  ui.terminal.setAttribute('aria-hidden', 'true');
}

function openTimerDialog() {
  renderNightlight();
  if (!ui.timerDialog.open) ui.timerDialog.showModal();
}
