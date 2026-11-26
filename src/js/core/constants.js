/**
 * core/constants.js
 * Built-in effect/palette catalogs, palette gradients and static UI data.
 */

'use strict';

/* ------------------------------------------------------------------ *
 *  Catalogs                                                           *
 * ------------------------------------------------------------------ */
const DEFAULT_EFFECTS = [
  'Solid','Blink','Breathe','Wipe','Wipe Random','Random Colors','Sweep','Dynamic','Colorloop','Rainbow',
  'Scan','Dual Scan','Fade','Chase','Chase Rainbow','Running','Saw','Twinkle','Dissolve','Dissolve Rnd',
  'Sparkle','Dark Sparkle','Sparkle+','Strobe','Strobe Rainbow','Mega Strobe','Blink Rainbow','Android','Chase','Chase Random',
  'Chase Rainbow','Chase Flash','Chase Flash Rnd','Rainbow Runner','Colorful','Traffic Light','Sweep Random','Running 2','Red & Blue','Stream',
  'Scanner','Lighthouse','Fireworks','Rain','Merry Christmas','Fire Flicker','Gradient','Loading','In Out','In In',
  'Out Out','Out In','Circus','Halloween','Tri Chase','Tri Wipe','Tri Fade','Lightning','ICU','Multi Comet',
  'Dual Scanner','Stream 2','Oscillate','Pride 2015','Juggle','Palette','Fire 2012','Colorwaves','BPM','Fill Noise',
  'Noise 1','Noise 2','Noise 3','Noise 4','Colortwinkle','Lake','Meteor','Smooth Meteor','Railway','Ripple'
];
const DEFAULT_PALETTES = [
  'Default','Random Cycle','Primary Color','Based on Primary','Set Colors','Based on Set','Party','Cloud','Lava','Ocean',
  'Forest','Rainbow','Rainbow Bands','Sunset','Rivendell','Breeze','Red & Blue','Yellowout','Analogous','Splash',
  'Pastel','Sunset 2','Beech','Vintage','Departure','Landscape','Beach','Sherbet','Hult','Hult 64',
  'Drywet','Jul','Grintage','Rewhi','Tertiary','Fire','Icefire','Cyane','Light Pink','Autumn',
  'Magenta','Magred','Yelmag','Yelblu','Orange & Teal','Tiamat','April Night'
];
const PALETTE_GRADIENTS = {
  'Default':'linear-gradient(90deg,#1c1f24,#3c414a,#ff9d2e)',
  'Random Cycle':'linear-gradient(90deg,#ff3366,#ff9d2e,#ffe14d,#4be08b,#4da9ff,#a26bff,#ff3366)',
  'Primary Color':'linear-gradient(90deg,#14161a,var(--primary))',
  'Based on Primary':'linear-gradient(90deg,#14161a,var(--primary),#f4f6fa)',
  'Set Colors':'linear-gradient(90deg,#ff4d6d,#4da9ff,#4be08b)',
  'Based on Set':'linear-gradient(90deg,#1a1d22,#ff4d6d,#4da9ff)',
  'Party':'linear-gradient(90deg,#ff2d75,#ffd84d,#31e981,#3fa9ff,#b06bff)',
  'Cloud':'linear-gradient(90deg,#49525e,#a8b5c4,#eef4fb,#8d9aab)',
  'Lava':'linear-gradient(90deg,#1a0604,#7a1205,#ff4a0a,#ffd23f,#ff7b00)',
  'Ocean':'linear-gradient(90deg,#03141f,#064663,#0a8fa8,#37d5d6,#b9f8f6)',
  'Forest':'linear-gradient(90deg,#071d12,#0c4a28,#2a8a45,#9ac94e,#f2e69a)',
  'Rainbow':'linear-gradient(90deg,#ff0040,#ff9d00,#ffee00,#35e05f,#00c8ff,#415bff,#c236ff)',
  'Rainbow Bands':'linear-gradient(90deg,#ff0040 0 16%,#ff9d00 16% 32%,#ffee00 32% 48%,#35e05f 48% 64%,#00c8ff 64% 80%,#c236ff 80% 100%)',
  'Sunset':'linear-gradient(90deg,#1b0b2e,#7d1f63,#f04b57,#ff9a44,#ffe08a)',
  'Rivendell':'linear-gradient(90deg,#12271f,#376b4b,#9ab36a,#e4d7a1,#6a8caf)',
  'Breeze':'linear-gradient(90deg,#0b1d2a,#146a7a,#40c9c0,#c6f7e2,#4d8dff)',
  'Red & Blue':'linear-gradient(90deg,#ff263f,#5a0a14,#0a1d5a,#2c6bff)',
  'Yellowout':'linear-gradient(90deg,#2a2100,#d7a700,#ffe75c,#fff9c4)',
  'Analogous':'linear-gradient(90deg,#ff3d81,#ff7c43,#ffb347,#ff9ac1,#b54dff)',
  'Splash':'linear-gradient(90deg,#0b1f33,#00a3c4,#ffe36e,#ff5470,#6d3cff)',
  'Pastel':'linear-gradient(90deg,#ffc2d1,#ffe0b5,#d9f7be,#bde0fe,#d7c6ff)',
  'Sunset 2':'linear-gradient(90deg,#2b0b20,#8d1b3d,#e63946,#ff9f1c,#ffd166)',
  'Beech':'linear-gradient(90deg,#1f1609,#6b4c1e,#c79a4a,#f2d7a0,#6e8b3d)',
  'Vintage':'linear-gradient(90deg,#261a12,#8c5a2b,#d9ad6a,#7d9c78,#4c5c6b)',
  'Departure':'linear-gradient(90deg,#071b22,#0b6e6e,#44c8a8,#f8e07c,#ff6b57)',
  'Landscape':'linear-gradient(90deg,#07140f,#1e6a45,#8bc34a,#f5d76e,#78909c)',
  'Beach':'linear-gradient(90deg,#041d2e,#0a98c9,#66e0dc,#ffe6b8,#f7b267)',
  'Sherbet':'linear-gradient(90deg,#ff7aa2,#ffb36b,#ffe66d,#9ee493,#69c9ff)',
  'Hult':'linear-gradient(90deg,#061426,#0e6f8f,#46c1b6,#f6e27a,#ff5c8a)',
  'Hult 64':'linear-gradient(90deg,#061426,#0e6f8f,#46c1b6,#f6e27a,#ff5c8a)',
  'Drywet':'linear-gradient(90deg,#3a2e18,#a8853d,#79a6a1,#2b6f8f)',
  'Jul':'linear-gradient(90deg,#2a0509,#a30f1c,#ff3b30,#f8e7c9,#3f7a3a)',
  'Grintage':'linear-gradient(90deg,#0b1a12,#2d5a2d,#8fbf5f,#c9b37e)',
  'Rewhi':'linear-gradient(90deg,#190707,#9c1b1b,#ff4d2e,#ffd1a8,#fff6ea)',
  'Tertiary':'linear-gradient(90deg,#4c1d95,#db2777,#f59e0b,#10b981)',
  'Fire':'linear-gradient(90deg,#190502,#6e1204,#e33203,#ffb000,#fff0b3)',
  'Icefire':'linear-gradient(90deg,#021b2e,#0a79a8,#e6fbff,#ff8c42,#a81111)',
  'Cyane':'linear-gradient(90deg,#021118,#006b7f,#00d4ff,#b8f7ff)',
  'Light Pink':'linear-gradient(90deg,#2a0c18,#c85c86,#ffb3c9,#ffe3ec)',
  'Autumn':'linear-gradient(90deg,#1c0903,#7a2d08,#d76a19,#f2b134,#6b3f1d)',
  'Magenta':'linear-gradient(90deg,#1c0619,#8e0b7a,#ff21d0,#ff9eea)',
  'Magred':'linear-gradient(90deg,#1e0610,#8b0b32,#ff1f5a,#ff9f9f)',
  'Yelmag':'linear-gradient(90deg,#251b00,#d3a000,#ffe23d,#ff46c8)',
  'Yelblu':'linear-gradient(90deg,#242000,#d5bb00,#fff06a,#2f7bff)',
  'Orange & Teal':'linear-gradient(90deg,#07252b,#0e8f8f,#37d5c8,#ff9f43,#ff6b35)',
  'Tiamat':'linear-gradient(90deg,#04141d,#0b7b8a,#44d6c4,#ffe082,#f06292)',
  'April Night':'linear-gradient(90deg,#080817,#3b2b73,#8c5bd8,#f7a8d8,#ffd6a5)'
};
const QUICK_COLORS = ['#ff4d4d','#ff9d2e','#ffd93d','#7ee787','#4dd7b8','#4da9ff','#7c6bff','#e879f9','#ffffff','#000000'];
const COLOR_SLOT_NAMES = ['Fx','Bg','Cs'];
const PRESET_SLOTS = 24;
const EFFECT_STORE_KEY = 'wled.webserial.prefs.v1';
const PRESET_STORE_KEY = 'wled.webserial.presets.v1';
const sleep = ms => new Promise(r => setTimeout(r, ms));
