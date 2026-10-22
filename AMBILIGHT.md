# WLED screen ambilight

Captures the laptop screen, derives colors from the screen edges, and sends them
to WLED using its JSON API over USB serial. No HTTP or Wi-Fi is required.

## Strip layout

The LED indices are ordered counter-clockwise, starting at the bottom-right:

| Edge   | WLED LEDs | Count | Direction       |
| ------ | --------- | ----- | --------------- |
| Right  | 0–13      | 14    | bottom → top    |
| Top    | 14–34     | 21    | right → left    |
| Left   | 35–48     | 14    | top → bottom    |
| Bottom | 49–60     | 12    | left → right    |

Total: **61 LEDs**. WLED must be configured for at least 61 LEDs and the script
uses segment 0 for the whole strip.

The screen is sampled inward from each edge (6% by default), averaged per LED,
smoothed over time, and sent at up to 20 FPS. The bottom edge also includes
whatever panel/taskbar is there; adjust `--edge-depth` if needed.

## Setup

Python 3.12 and the local virtual environment are already set up in this
directory. To recreate it:

```bash
python3.12 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

For Wayland screen capture, install the PipeWire/GStreamer tools as well:

```bash
sudo apt install gstreamer1.0-tools gstreamer1.0-pipewire
```

On X11, Windows, and macOS, the fast `mss` backend is used automatically and the
GStreamer packages are not needed.

## Run

Stop any serial monitor or other program that has the WLED port open, e.g.
`cutecom`, then:

```bash
source .venv/bin/activate
python wled_ambient.py --list-ports
python wled_ambient.py --port /dev/ttyUSB0
```

The port is auto-detected if only one likely USB serial adapter is present. On
Linux, the user normally needs to be in the `dialout` group:

```bash
sudo usermod -aG dialout "$USER"
# log out and back in for the group change to take effect
```

Useful options:

```bash
# Test screen capture and FPS without touching the WLED serial port
python wled_ambient.py --dry-run

# Force the Wayland portal backend (20 FPS, asks for screen-sharing permission once)
python wled_ambient.py --capture portal --port /dev/ttyUSB0

# Tune the look
python wled_ambient.py --brightness 0.8 --smoothing 0.25 --edge-depth 6
```

`--dry-run` still performs screen capture and prints the measured FPS.

## Wayland

On KDE Plasma Wayland, `mss` and XWayland return a black screen. The script
therefore auto-selects the XDG Desktop Portal + PipeWire backend there. The
first launch may show a screen/monitor sharing dialog; approve your laptop
display. A restore token is saved at
`~/.cache/wled-ambient/portal-restore-token` so later launches reuse the
selection without prompting.

If the portal backend is unavailable, install the GStreamer packages above.
The older Spectacle fallback can be forced with `--capture spectacle`, but it
only manages roughly 2–3 FPS on this machine and is not suitable for the 20 FPS
target.

## WLED serial notes

WLED supports the JSON API over its USB serial port. The script sends:

- one setup command that enables segment 0 and covers LEDs 0–60
- one per-frame JSON line such as `{"seg":[{"id":0,"i":["ff0000",...]}]}`

The default baud is **460800**, which is fast enough for 61 LEDs at 20 FPS. On
startup the script attempts to switch WLED to that rate using WLED's temporary
serial baud command. This works for the default WLED baud (115200) and when WLED
is already at 460800. If WLED is configured to a different baud, pass it
explicitly:

```bash
python wled_ambient.py --baud 921600
```

If you have already configured the port rate and do not want the script to send
a baud-change command, use `--no-baud-setup`. The serial warning
`No WLED version reply at 115200` can be harmless: on boards where GPIO1 is used
for LED data WLED cannot transmit a version reply, but it can still receive the
JSON commands. WLED's serial RX pin (usually GPIO3) must not be assigned to LED
output, or serial control will not work at all.

The script sends colors only; it does not change WLED's configured LED count or
Wi-Fi settings. After stopping the script, the frozen last frame remains until
WLED is turned off or another effect is selected.

## Options summary

| Option | Description |
| ------ | ----------- |
| `--port PATH` | Serial port, e.g. `/dev/ttyUSB0` or `COM5` |
| `--baud N` | Serial baud (default 460800) |
| `--no-baud-setup` | Open at `--baud` without sending WLED's baud-change command |
| `--fps N` | Target frame rate (default 20) |
| `--capture {auto,portal,mss,spectacle}` | Capture backend |
| `--monitor N` | Monitor index for `mss`; portal uses the dialog selection |
| `--edge-depth PERCENT` | Sampling depth from the screen edge (default 6) |
| `--brightness FACTOR` | Scale output colors (default 1.0) |
| `--smoothing 0..1` | Temporal smoothing (default 0.35; 0 disables) |
| `--dry-run` | Capture and compute without serial output |
| `--list-ports` | List serial ports and exit |
| `--quiet` | Suppress periodic FPS output |
