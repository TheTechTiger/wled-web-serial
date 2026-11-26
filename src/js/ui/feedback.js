/**
 * ui/feedback.js
 * Serial console logging, toast notifications and clipboard copy.
 */

'use strict';

function logLine(dir, text, label = '') {
  if (!ui.terminalLog) return;
  const nearBottom = ui.terminalLog.scrollHeight - ui.terminalLog.scrollTop - ui.terminalLog.clientHeight < 60;
  const line = document.createElement('div');
  line.className = 'log-line ' + dir;
  const dirEl = document.createElement('span');
  dirEl.className = 'dir';
  dirEl.textContent = dir.toUpperCase();
  const txt = document.createElement('span');
  txt.className = 'txt';
  const out = String(text);
  txt.textContent = out.length > 5000 ? out.slice(0, 5000) + '…' : out;
  line.append(dirEl, txt);
  if (label) line.title = label;
  ui.terminalLog.appendChild(line);
  while (ui.terminalLog.children.length > 300) ui.terminalLog.firstElementChild.remove();
  if (nearBottom) ui.terminalLog.scrollTop = ui.terminalLog.scrollHeight;
}
function showToast(message, type = 'success', duration = 3000) {
  clearTimeout(toastTimer);
  ui.toastText.textContent = message;
  ui.toast.classList.remove('show', 'error', 'warn');
  if (type === 'error') ui.toast.classList.add('error');
  if (type === 'warn') ui.toast.classList.add('warn');
  ui.toast.classList.add('show');
  const icon = ui.toast.querySelector('use');
  if (icon) icon.setAttribute('href', type === 'error' ? '#i-alert' : type === 'warn' ? '#i-alert' : '#i-check');
  toastTimer = setTimeout(() => ui.toast.classList.remove('show'), duration);
}

function copyText(text, message = 'Copied to clipboard.') {
  const fallback = () => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); showToast(message); } catch { showToast('Could not copy.', 'error'); }
    ta.remove();
  };
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(() => showToast(message)).catch(fallback);
  } else fallback();
}
