/**
 * core/state.js
 * Persistent preferences, live application state and shared accessors.
 */

'use strict';

/* ------------------------------------------------------------------ *
 *  State                                                              *
 * ------------------------------------------------------------------ */
const prefs = Object.assign({
  baud: 115200,
  lineEnding: 'lf',
  autoSync: true,
  effects: null,
  palettes: null
}, loadJSON(EFFECT_STORE_KEY, {}));

let effectCatalog = Array.isArray(prefs.effects) && prefs.effects.length
  ? prefs.effects.map(String) : DEFAULT_EFFECTS.slice();
let paletteCatalog = Array.isArray(prefs.palettes) && prefs.palettes.length
  ? prefs.palettes.map(String) : DEFAULT_PALETTES.slice();

const presetStore = Object.assign({ meta: {}, snapshots: {} }, loadJSON(PRESET_STORE_KEY, {}));
if (!isObj(presetStore.meta)) presetStore.meta = {};
if (!isObj(presetStore.snapshots)) presetStore.snapshots = {};

const demoInfo = {
  name: 'WLED Light', ver: '0.15.0', vid: 2503010, brand: 'WLED', product: 'FOSS',
  arch: 'esp32', core: '3.3.0', mac: 'a0b765c3d2e1',
  leds: { count: 60, rgbw: true, lc: 7, cct: true, pwr: 1420, maxpwr: 2500, maxseg: 16, fps: 42 },
  freeheap: 188416, uptime: 18423, ip: ''
};

const state = {
  mode: 'preview',
  connected: false,
  handshake: false,
  on: true,
  brightness: 160,
  transition: 0.7,
  nightlight: { on: false, dur: 60, mode: 1, tbri: 0, rem: -1 },
  currentPreset: -1,
  activeSegmentId: 0,
  selectedSlot: 0,
  segments: [{
    id: 0, name: 'Segment 1', start: 0, stop: 60, len: 60, on: true, bri: 255,
    colors: [[255,160,0,0],[0,0,0,0],[0,0,0,0]],
    fx: 0, sx: 128, ix: 128, pal: 0, rev: false, sel: true, grp: 1, spc: 0, frz: false
  }],
  info: deepClone(demoInfo),
  infoIsDemo: true,
  lastResponse: null,
  lastResponseText: '',
  lastRxAt: 0,
  lastTxAt: 0,
  hsv: { h: 32, s: 100 },
  activeTab: 'colors',
  portLabel: '',
  serialStats: { tx: 0, rx: 0 },
  terminalOpen: false,
  firstInteraction: false
};

const ui = {};
const serial = {
  port: null, writer: null, reader: null, keepReading: false,
  readLoop: null, rxBuffer: '', decoder: null, waitingForReply: false,
  handshakeAttempts: 0, handshakeTimer: null, syncTimer: null
};
let pendingChannels = new Map();
let channelFlushTimer = null;
let lastInteraction = 0;
let lastUserActivity = Date.now();
let toastTimer = null;
let confirmCallback = null;
let presetDialogSlot = 1;
let wheelDragging = false;

function activeSegment() {
  let seg = state.segments.find(s => s.id === state.activeSegmentId);
  if (!seg) seg = state.segments[0];
  if (!seg) {
    seg = { id: 0, name: 'Segment 1', start: 0, stop: totalLeds(), len: totalLeds(), on: true, bri: 255,
      colors: [[255,160,0,0],[0,0,0,0],[0,0,0,0]], fx: 0, sx: 128, ix: 128, pal: 0, rev: false, sel: true, grp: 1, spc: 0, frz: false };
    state.segments.push(seg);
  }
  return seg;
}
function activeColor() {
  const seg = activeSegment();
  const slot = clamp(state.selectedSlot, 0, 2);
  const c = (seg.colors && seg.colors[slot]) || [0,0,0,0];
  return { r: Number(c[0]) || 0, g: Number(c[1]) || 0, b: Number(c[2]) || 0, w: Number(c[3]) || 0 };
}
function effectName(id) {
  const n = effectCatalog[id];
  return n && n !== 'RSVD' && n !== '-' ? n : `Effect ${id}`;
}
function paletteName(id) {
  return paletteCatalog[id] || `Palette ${id}`;
}
function presetName(id) {
  return presetStore.meta[id]?.name || `Preset ${id}`;
}
function effectRow(id) {
  return state.segments.find(s => s.id === state.activeSegmentId)?.fx ?? state.segments[0]?.fx ?? 0;
}

function paletteGradient(id) {
  const name = paletteCatalog[id] || '';
  if (PALETTE_GRADIENTS[name]) return PALETTE_GRADIENTS[name];
  if (/rainbow|random/i.test(name)) return PALETTE_GRADIENTS['Rainbow'];
  if (/fire|lava/i.test(name)) return PALETTE_GRADIENTS['Fire'];
  if (/ocean|ice|cyan/i.test(name)) return PALETTE_GRADIENTS['Ocean'];
  if (/forest|green/i.test(name)) return PALETTE_GRADIENTS['Forest'];
  const h = Math.round((id * 137.508 + 28) % 360);
  return `linear-gradient(90deg,hsl(${h} 55% 12%),hsl(${h} 80% 42%),hsl(${(h + 62) % 360} 86% 62%))`;
}
function currentGradient() {
  const c = activeColor();
  const hex = rgbToHex(c.r, c.g, c.b);
  const dark = rgbToHex(Math.round(c.r * .2), Math.round(c.g * .2), Math.round(c.b * .2));
  const light = rgbToHex(Math.min(255, Math.round(c.r + (255 - c.r) * .5)), Math.min(255, Math.round(c.g + (255 - c.g) * .5)), Math.min(255, Math.round(c.b + (255 - c.b) * .5)));
  return `linear-gradient(90deg,${dark},${hex},${light})`;
}
function effectGradient(seg) {
  return seg && seg.pal > 0 ? paletteGradient(seg.pal) : currentGradient();
}
function updateTheme() {
  const c = activeColor();
  const root = document.documentElement;
  root.style.setProperty('--glow-rgb', `${c.r},${c.g},${c.b}`);
  root.style.setProperty('--primary', rgbToHex(c.r, c.g, c.b));
}
function setRange(input, value) {
  if (!input) return;
  input.value = value;
  const wrap = input.closest('.range-wrap');
  if (wrap) {
    const min = Number(input.min) || 0, max = Number(input.max) || 100;
    const p = max > min ? ((Number(value) - min) / (max - min)) * 100 : 0;
    wrap.style.setProperty('--p', clamp(p, 0, 100) + '%');
  }
}
function setElRange(id, value) {
  const input = ui[id];
  if (input) { setRange(input, value); }
}
