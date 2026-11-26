# WLED Web Serial

A browser-based control panel for [WLED](https://kno.wled.ge/) over the
**Web Serial JSON API**. No Wi-Fi, no HTTP server, no build step to *use* it —
open a single HTML file in a Chromium-based browser and talk to the light over
USB.

WLED's official UI is network-based. This project is for controlling a WLED
controller directly over its USB serial port, including offline.

---

## Contents

- [Quick start](#quick-start)
- [Repository layout](#repository-layout)
- [Working on the UI](#working-on-the-ui)
- [Releases](#releases)
- [Features](#features)
- [Requirements](#requirements)
- [Notes](#notes)
- [License](#license)

---

## Quick start

**Just want to use it?** Download `wled-web-serial.html` from the
[latest release](https://github.com/TheTechTiger/wled-web-serial/releases),
open it in Chrome/Edge, and click **Connect USB**.

Web Serial requires a Chromium-based browser and a secure context (HTTPS or
`localhost`). When serving from this checkout:

```bash
cd wled-web-serial
python3 -m http.server 8000 --bind 127.0.0.1
```

Then open <http://localhost:8000>, click **Connect USB**, and select the WLED
serial port. Close any other serial monitor first (Arduino IDE, PlatformIO,
etc.).

Opening `index.html` via `file://` also works for **preview mode**, but Web
Serial is unavailable there.

---

## Repository layout

The application source is split by concern. The root `index.html` is a
**generated, self-contained build** of that source and is what the browser
loads.

```text
.
├── index.html                  # generated single-file app (do not edit)
├── tools/
│   └── build.js                # inlines src/ into index.html
├── src/
│   ├── index.html              # markup only; links the CSS/JS below
│   ├── styles/
│   │   ├── base.css            # design tokens, reset, boot loader
│   │   ├── layout.css          # top bar, panels, grids, cards
│   │   ├── controls.css        # buttons, forms, switches, sliders
│   │   ├── features.css        # color wheel, lists, effects, segments, presets
│   │   ├── overlays.css        # tabs, toast, dialogs, terminal
│   │   └── responsive.css      # breakpoints, reduced motion
│   └── js/
│       ├── core/
│       │   ├── constants.js    # effect/palette catalogs, gradients, keys
│       │   ├── utils.js        # DOM, color and formatting helpers
│       │   └── state.js        # preferences and application state
│       ├── ui/
│       │   ├── feedback.js     # console log, toast, clipboard
│       │   ├── render.js       # one render function per panel/widget
│       │   ├── actions.js      # user actions (color, effects, segments…)
│       │   ├── dialogs.js      # settings, confirm, console, nightlight
│       │   └── events.js       # element cache and event bindings
│       ├── transport/
│       │   └── serial.js       # Web Serial link and JSON queue
│       └── app.js              # startup and idle sync timer
├── .github/workflows/pages.yml # rebuilds the app before deploying
├── README.md
└── LICENSE
```

### Source map

| Area | Files | Responsibility |
| --- | --- | --- |
| Markup | `src/index.html` | Panels, dialogs, terminal, icon symbols |
| Styling | `src/styles/*.css` | Theme, layout, components, responsive rules |
| Core | `src/js/core/*.js` | Static data, helpers, shared state |
| Interface | `src/js/ui/*.js` | Rendering, actions, dialogs, events |
| Transport | `src/js/transport/serial.js` | Port lifecycle, TX queue, reply parsing |
| Bootstrap | `src/js/app.js` | Initial render and background sync |

---

## Working on the UI

1. Edit files under `src/`.
2. Rebuild the single-file app:
   ```bash
   node tools/build.js
   ```
3. Open the regenerated root `index.html` (or serve it as shown above).

`tools/build.js` reads the `<link>` and `<script src>` tags in `src/index.html`
in order, inlines the referenced CSS and JavaScript, and wraps the scripts in a
single IIFE. That means the source files can also be opened directly via
`src/index.html` while developing — they are plain scripts sharing global
scope — while the release stays one self-contained file with no external
requests.

The GitHub Pages workflow runs the same build step, so the deployed site and
the release asset are produced from identical source.

---

## Releases

Every release ships one standalone HTML file with all CSS and JavaScript
inlined. It has no external assets or dependencies: download it, open it, and
you're done. Version `v0.0.1` is built from `src/` with `node tools/build.js`.

---

## Features

- **Colors** — color wheel, HSV/RGBW/CCT controls, hex input, color slots,
  quick colors, 47 palettes
- **Effects** — searchable effect list, speed/intensity, freeze, palette,
  custom effect ID, random effect
- **Segments** — create/split, power, ranges, brightness, name, colors,
  effects, reverse, delete, and a one-click 4-segment frame layout
- **Presets** — 24 slots with local names/snapshots plus hardware
  save/apply/overwrite/delete
- **Info** — live device data, last JSON response, quick commands, response
  copy
- **Tools** — nightlight timer, reboot, live state sync, serial console,
  settings
- **Preview mode** for running without hardware
- **Web Serial JSON transport** with handshake, reconnect handling, unplug
  detection, and serial statistics

---

## Requirements

- Chromium-based desktop browser (Chrome, Edge, Brave, Opera)
- WLED device with serial JSON support, or preview mode
- USB serial connection to the device

---

## Notes

- WLED's verbose serial replies do not include effect/palette names, so the app
  ships with the classic 80-effect / 47-palette catalogs. You can paste a
  `/json/eff` or `/json/pal` array into **Settings** to import a full catalog
  for your firmware version.
- Preset names are stored locally; hardware presets are saved with brightness
  and segment bounds included.
- Reboot uses WLED's `{"rb":true}` command.
- The 4-segment layout assumes a 60-LED frame (bottom 0-10, left 11-24, top
  25-45, right 46-59). Set the LED count to 60 in WLED's LED Preferences
  first. The bottom strip does not cover the full bottom edge.

---

## License

MIT
