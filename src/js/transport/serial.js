/**
 * transport/serial.js
 * Web Serial link, JSON transmit queue, reply parsing and state sync.
 */

'use strict';

/* ------------------------------------------------------------------ *
 *  Serial bridge                                                      *
 * ------------------------------------------------------------------ */
const txQueue = [];
let txPumping = false;
let statsRenderTimer = null;

function lineEndingValue() {
  return prefs.lineEnding === 'crlf' ? '\r\n' : prefs.lineEnding === 'lf' ? '\n' : '';
}
function serialSupported() { return typeof navigator !== 'undefined' && 'serial' in navigator; }
function getPortLabel(port) {
  try {
    const info = port.getInfo ? port.getInfo() : {};
    if (info && (info.usbVendorId || info.usbProductId)) {
      const v = (info.usbVendorId || 0).toString(16).toUpperCase().padStart(4, '0');
      const p = (info.usbProductId || 0).toString(16).toUpperCase().padStart(4, '0');
      return `USB ${v}:${p}`;
    }
  } catch { /* unsupported */ }
  return 'USB serial port';
}
function scheduleStatsRender() {
  if (statsRenderTimer) return;
  statsRenderTimer = setTimeout(() => {
    statsRenderTimer = null;
    if (state.activeTab === 'info') renderInfo();
    renderConnection();
  }, 300);
}

function sendRawText(text) {
  if (state.mode !== 'serial' || !serial.port) {
    logLine('tx', text, 'preview');
    return;
  }
  txQueue.push(text + lineEndingValue());
  pumpTx();
}
async function pumpTx() {
  if (txPumping) return;
  txPumping = true;
  try {
    while (txQueue.length && state.mode === 'serial' && serial.port) {
      const text = txQueue.shift();
      try {
        if (!serial.writer) serial.writer = serial.port.writable.getWriter();
        const bytes = new TextEncoder().encode(text);
        await serial.writer.write(bytes);
        state.serialStats.tx += bytes.byteLength;
        state.lastTxAt = Date.now();
        logLine('tx', text.replace(/\r?\n$/, ''), 'serial');
        scheduleStatsRender();
        await sleep(16);
      } catch (err) {
        logLine('err', 'Write failed: ' + (err.message || err));
        showToast('Serial write failed. The device may have disconnected.', 'error', 5000);
        break;
      }
    }
  } finally {
    txPumping = false;
    if (txQueue.length && state.mode === 'serial') setTimeout(pumpTx, 30);
  }
}
function sendJSON(obj, opts = {}) {
  const payload = { ...obj };
  if (opts.verbose) payload.v = true;
  let text;
  try { text = JSON.stringify(payload); }
  catch (err) { logLine('err', 'Could not encode JSON: ' + err.message); return; }
  lastInteraction = Date.now();
  sendRawText(text);
}
function queueJSON(channel, obj, opts = {}) {
  pendingChannels.set(channel, { obj, opts });
  if (channelFlushTimer) return;
  channelFlushTimer = setTimeout(() => {
    channelFlushTimer = null;
    const entries = Array.from(pendingChannels.values());
    pendingChannels.clear();
    for (const entry of entries) sendJSON(entry.obj, entry.opts);
  }, 85);
}
function flushChannels() {
  if (channelFlushTimer) { clearTimeout(channelFlushTimer); channelFlushTimer = null; }
  const entries = Array.from(pendingChannels.values());
  pendingChannels.clear();
  for (const entry of entries) sendJSON(entry.obj, entry.opts);
}
async function connectSerial() {
  if (state.mode === 'serial') { showToast('A serial port is already open.'); return; }
  if (!serialSupported()) {
    showToast('Web Serial is not available in this browser.', 'error', 5000);
    if (ui.settingsDialog && !ui.settingsDialog.open) ui.settingsDialog.showModal();
    return;
  }
  let port;
  try {
    port = await navigator.serial.requestPort();
  } catch (err) {
    if (err && err.name === 'NotFoundError') return;
    showToast('Could not select a serial port: ' + (err.message || err), 'error', 5000);
    return;
  }
  try {
    await openPort(port);
  } catch (err) {
    showToast('Could not open the port: ' + (err.message || err), 'error', 6000);
    logLine('err', 'Open failed: ' + (err.message || err));
    serial.keepReading = false;
    serial.port = null;
    state.portLabel = '';
    try { if (port) await port.close(); } catch { /* ignore */ }
    state.mode = 'preview';
    state.connected = false;
    renderConnection();
    renderInfo();
  }
}
async function openPort(port) {
  serial.port = port;
  state.portLabel = getPortLabel(port);
  state.mode = 'serial';
  state.connected = true;
  state.handshake = false;
  state.serialStats = { tx: 0, rx: 0 };
  serial.rxBuffer = '';
  serial.decoder = new TextDecoder();
  serial.keepReading = true;
  txQueue.length = 0;
  clearTimeout(serial.handshakeTimer);
  renderConnection();
  renderInfo();
  logLine('sys', `Opening ${state.portLabel} at ${prefs.baud} baud…`);
  await port.open({
    baudRate: Number(prefs.baud) || 115200,
    dataBits: 8,
    stopBits: 1,
    parity: 'none',
    flowControl: 'none',
    bufferSize: 4096
  });
  serial.waitingForReply = true;
  serial.readLoop = readSerialPort(port);
  beginHandshake();
  showToast('USB port open. Waiting for WLED…', 'warn', 3500);
}
function beginHandshake() {
  clearTimeout(serial.handshakeTimer);
  serial.handshakeAttempts = 0;
  const attempt = () => {
    if (state.mode !== 'serial') return;
    if (state.handshake) return;
    serial.handshakeAttempts++;
    logLine('sys', `Requesting state (attempt ${serial.handshakeAttempts})…`);
    sendJSON({ v: true }, { label: 'handshake' });
    if (serial.handshakeAttempts < 3) {
      serial.handshakeTimer = setTimeout(attempt, 2600);
    } else {
      serial.handshakeTimer = setTimeout(() => {
        if (state.mode === 'serial' && !state.handshake) {
          showToast('Port open, but WLED did not reply. Check that GPIO3 is free and serial JSON is enabled.', 'warn', 6500);
          logLine('err', 'No JSON response. WLED needs serial RX/TX available and a JSON-capable firmware.');
          renderConnection();
        }
      }, 2600);
    }
  };
  serial.handshakeTimer = setTimeout(attempt, 700);
}
async function readSerialPort(port) {
  while (port.readable && serial.keepReading) {
    const reader = port.readable.getReader();
    serial.reader = reader;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value && value.byteLength) {
          state.serialStats.rx += value.byteLength;
          state.lastRxAt = Date.now();
          const text = serial.decoder.decode(value, { stream: true });
          if (text) {
            serial.rxBuffer += text;
            parseRxBuffer();
          }
          scheduleStatsRender();
        }
      }
    } catch (err) {
      if (serial.keepReading && err && err.name !== 'NetworkError') {
        logLine('err', 'Read failed: ' + (err.message || err));
      }
    } finally {
      try { reader.releaseLock(); } catch { /* ignore */ }
      serial.reader = null;
    }
  }
  if (serial.keepReading) handleSerialLoss();
}
function handleSerialLoss() {
  if (state.mode !== 'serial') return;
  serial.keepReading = false;
  state.mode = 'preview';
  state.connected = false;
  state.handshake = false;
  clearTimeout(serial.handshakeTimer);
  state.portLabel = '';
  try { if (serial.writer) serial.writer.releaseLock(); } catch { /* ignore */ }
  serial.writer = null;
  const port = serial.port;
  serial.port = null;
  if (port) { port.close().catch(() => { /* already gone */ }); }
  renderConnection();
  renderInfo();
  logLine('sys', 'Serial connection lost.');
  showToast('USB device disconnected. Switched to preview.', 'warn', 4500);
}
async function disconnectSerial(silent = false) {
  if (state.mode !== 'serial') return;
  serial.keepReading = false;
  clearTimeout(serial.handshakeTimer);
  try { if (serial.reader) await serial.reader.cancel(); } catch { /* ignore */ }
  try { if (serial.writer) serial.writer.releaseLock(); } catch { /* ignore */ }
  serial.writer = null;
  const port = serial.port;
  serial.port = null;
  state.mode = 'preview';
  state.connected = false;
  state.handshake = false;
  state.portLabel = '';
  if (port) { try { await port.close(); } catch { /* ignore */ } }
  renderConnection();
  renderInfo();
  logLine('sys', 'Serial port closed.');
  if (!silent) showToast('Disconnected.');
}
function parseRxBuffer() {
  let guard = 0;
  while (serial.rxBuffer.length && guard++ < 50) {
    const start = serial.rxBuffer.search(/[{[]/);
    if (start < 0) {
      const noise = serial.rxBuffer.trim();
      if (noise) logLine('sys', noise);
      serial.rxBuffer = '';
      break;
    }
    if (start > 0) {
      const noise = serial.rxBuffer.slice(0, start).trim();
      if (noise) logLine('sys', noise);
      serial.rxBuffer = serial.rxBuffer.slice(start);
    }
    const end = findJsonEnd(serial.rxBuffer);
    if (end < 0) {
      if (serial.rxBuffer.length > 250000) serial.rxBuffer = serial.rxBuffer.slice(-4096);
      break;
    }
    const candidate = serial.rxBuffer.slice(0, end + 1);
    serial.rxBuffer = serial.rxBuffer.slice(end + 1);
    try {
      const data = JSON.parse(candidate);
      handleParsedJSON(data, candidate);
    } catch (err) {
      logLine('err', 'Bad JSON: ' + candidate.slice(0, 300));
    }
  }
  if (serial.rxBuffer.length > 400000) serial.rxBuffer = serial.rxBuffer.slice(-8192);
}
function findJsonEnd(text) {
  let depth = 0, inString = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) return i;
      if (depth < 0) return -1;
    }
  }
  return -1;
}
function markHandshake() {
  if (state.handshake) return;
  state.handshake = true;
  state.infoIsDemo = false;
  serial.waitingForReply = false;
  clearTimeout(serial.handshakeTimer);
  renderConnection();
  renderInfo();
  const info = getInfo();
  showToast(`Connected to ${info.name || 'WLED'}${info.ver ? ' · v' + info.ver : ''}.`, 'success', 3500);
}
function handleParsedJSON(data, raw) {
  logLine('rx', raw.length > 2000 ? raw.slice(0, 2000) + '…' : raw, 'serial response');
  if (Array.isArray(data)) {
    if (data.length && data.every(v => typeof v === 'number')) {
      logLine('sys', `LED frame data received (${data.length} pixels).`);
    }
    return;
  }
  if (!isObj(data)) return;
  state.lastResponse = data;
  state.lastResponseText = raw;
  if (data.error != null) {
    showToast('WLED error: ' + data.error, 'error', 5000);
    logLine('err', 'Device error: ' + data.error);
  }
  if (data.success === true) logLine('sys', 'Device reported success.');
  if (Array.isArray(data.effects) && data.effects.every(x => typeof x === 'string')) {
    effectCatalog = data.effects.slice(0, 255);
    savePrefs();
    renderEffectList();
    renderEffectCurrent();
  }
  if (Array.isArray(data.palettes) && data.palettes.every(x => typeof x === 'string')) {
    paletteCatalog = data.palettes.slice(0, 256);
    savePrefs();
    renderPaletteList();
    renderEffectCurrent();
  }
  if (isObj(data.info)) {
    state.info = data.info;
    state.infoIsDemo = false;
    markHandshake();
  }
  if (isObj(data.state)) {
    applyDeviceState(data.state);
    markHandshake();
  }
  renderInfo();
  if (state.activeTab === 'presets') renderPresets();
}
function parseColorValue(v) {
  if (Array.isArray(v)) {
    const out = [0,0,0,0];
    for (let i = 0; i < 4; i++) out[i] = clamp(Math.round(Number(v[i]) || 0), 0, 255);
    return out;
  }
  if (typeof v === 'string') {
    const c = hexToRgb(v);
    if (c) return [c.r, c.g, c.b, c.w];
  }
  if (typeof v === 'number') {
    return [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >> 24) & 255];
  }
  return [0,0,0,0];
}
function applyDeviceState(st) {
  if (typeof st.on === 'boolean') state.on = st.on;
  if (st.bri != null) state.brightness = clamp(Number(st.bri) || 0, 0, 255) || state.brightness;
  if (st.transition != null) state.transition = clamp((Number(st.transition) || 0) / 10, 0, 65.5);
  if (st.ps != null) state.currentPreset = Number(st.ps);
  if (isObj(st.nl)) {
    state.nightlight = {
      on: !!st.nl.on,
      dur: st.nl.dur != null ? Number(st.nl.dur) : state.nightlight.dur,
      mode: st.nl.mode != null ? Number(st.nl.mode) : state.nightlight.mode,
      tbri: st.nl.tbri != null ? Number(st.nl.tbri) : state.nightlight.tbri,
      rem: st.nl.rem != null ? Number(st.nl.rem) : -1
    };
  }
  if (Array.isArray(st.seg)) {
    const authoritativeIds = st.seg.map((s, i) => s && s.id != null ? Number(s.id) : i);
    st.seg.forEach((s, index) => {
      if (!isObj(s)) return;
      const id = s.id != null ? Number(s.id) : index;
      let seg = state.segments.find(x => x.id === id);
      if (!seg) {
        seg = {
          id, name: `Segment ${id + 1}`, start: 0, stop: totalLeds(), len: totalLeds(), on: true, bri: 255,
          colors: [[255,160,0,0],[0,0,0,0],[0,0,0,0]], fx: 0, sx: 128, ix: 128, pal: 0,
          rev: false, sel: false, grp: 1, spc: 0, frz: false
        };
        state.segments.push(seg);
      }
      if (s.n != null) seg.name = String(s.n);
      if (s.start != null) seg.start = Number(s.start);
      if (s.stop != null) seg.stop = Number(s.stop);
      if (s.len != null) seg.len = Number(s.len);
      else seg.len = Math.max(0, seg.stop - seg.start);
      if (typeof s.on === 'boolean') seg.on = s.on;
      if (s.bri != null) seg.bri = Number(s.bri);
      if (s.fx != null) seg.fx = Number(s.fx);
      if (s.sx != null) seg.sx = Number(s.sx);
      if (s.ix != null) seg.ix = Number(s.ix);
      if (s.pal != null) seg.pal = Number(s.pal);
      if (s.cct != null) seg.cct = Number(s.cct);
      if (typeof s.rev === 'boolean') seg.rev = s.rev;
      if (typeof s.sel === 'boolean') seg.sel = s.sel;
      if (s.grp != null) seg.grp = Number(s.grp);
      if (s.spc != null) seg.spc = Number(s.spc);
      if (typeof s.frz === 'boolean') seg.frz = s.frz;
      if (Array.isArray(s.col)) {
        const cols = [[0,0,0,0],[0,0,0,0],[0,0,0,0]];
        s.col.slice(0, 3).forEach((c, idx) => { cols[idx] = parseColorValue(c); });
        seg.colors = cols;
      }
    });
    const keep = new Set(authoritativeIds);
    if (keep.size) state.segments = state.segments.filter(s => keep.has(s.id));
    if (!state.segments.some(s => s.id === state.activeSegmentId)) {
      const selected = state.segments.find(s => s.sel);
      state.activeSegmentId = (selected || state.segments[0] || { id: 0 }).id;
    }
    state.selectedSlot = clamp(state.selectedSlot, 0, 2);
  }
  renderPower();
  renderBrightness();
  renderTransition();
  renderNightlight();
  renderSegmentSelectors();
  renderSegments();
  renderColor();
  renderEffectCurrent();
  renderEffectSelection();
  renderPaletteSelection();
  renderStateTiles();
  renderPresets();
  renderInfo();
}
function savePrefs() {
  prefs.effects = effectCatalog;
  prefs.palettes = paletteCatalog;
  saveJSON(EFFECT_STORE_KEY, prefs);
}
