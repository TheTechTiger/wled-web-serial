# WLED Web Serial

A standalone browser-based control panel for [WLED](https://kno.wled.ge/) over the
**Web Serial JSON API**. No Wi-Fi, no HTTP server, no build step — just open
`index.html` in a Chromium-based browser.

WLED's official UI is network-based. This project is for controlling a WLED
device directly over its USB serial port from the browser, including offline.

## Features

- **Colors**: color wheel, HSV/RGBW/CCT controls, hex input, color slots, quick
  colors, 47 palettes
- **Effects**: searchable effect list, speed/intensity, freeze, palette, custom
  effect ID, random effect
- **Segments**: create/split, power, ranges, brightness, name, colors, effects,
  reverse, delete, and a one-click 4-segment frame layout
- **Presets**: 24 slots with local names/snapshots plus hardware save/apply/
  overwrite/delete
- **Info**: live device data, last JSON response, quick commands, response copy
- **Tools**: nightlight timer, reboot, live state sync, serial console, settings
- **Preview mode** for running without hardware
- **Web Serial JSON transport** with handshake, reconnect handling, unplug
  detection, and serial statistics

## Run it

Web Serial requires a Chromium-based browser and a secure context (HTTPS or
`localhost`).

```bash
cd wled-web-serial
python3 -m http.server 8000 --bind 127.0.0.1
```

Open `http://localhost:8000` (or `http://127.0.0.1:8000`), click **Connect
USB**, and select the WLED serial port. Close any other serial monitor first
(Arduino IDE, PlatformIO, etc.).

You can also open `index.html` directly with `file://` for preview mode, but
Web Serial will not be available there.

## Requirements

- Chromium-based desktop browser (Chrome, Edge, Brave, Opera)
- WLED device with serial JSON support, or preview mode
- USB serial connection to the device

## Notes

- WLED's verbose serial replies do not include effect/palette names, so the app
  ships with the classic 80-effect / 47-palette catalogs. You can paste a
  `/json/eff` or `/json/pal` array into **Settings** to import a full catalog
  for your firmware version.
- Preset names are stored locally; hardware presets are saved with brightness
  and segment bounds included.
- Reboot uses WLED's `{"rb":true}` command.
- The 4-segment layout assumes a 61-LED frame (right 0-13, top 14-34, left
  35-48, bottom 49-60). Set the LED count to 61 in WLED's LED Preferences
  first.

## Project layout

```
index.html   # entire app: inline CSS, JS, and SVG icons
```

## License

MIT
