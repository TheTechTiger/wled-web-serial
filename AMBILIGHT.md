# WLED screen ambilight

Captures the laptop screen, derives colors from the screen edges, and streams
them to WLED over USB serial. No Wi-Fi or HTTP is required.

## Strip layout

The LED indices are ordered counter-clockwise, starting at the bottom-right:

| Edge   | WLED LEDs | Count | Direction       |
| ------ | --------- | ----- | --------------- |
| Right  | 0–13      | 14    | bottom → top    |
| Top    | 14–34     | 21    | right → left    |
| Left   | 35–48     | 14    | top → bottom    |
| Bottom | 49–60     | 12    | left → right    |

Total: **61 LEDs**. WLED must be configured for **61 LEDs**. The script asks
WLED for its LED count at startup and prints a warning if it is different. If
WLED is set to 49 LEDs, the bottom 12 LEDs (indices 49–60) will never update.

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

## Capture backends

| Platform        | Auto backend | Other available backend |
| --------------- | ------------ | ----------------------- |
| Windows         | `mss`        | —                       |
| macOS           | `mss`        | —                       |
| Linux X11       | `mss`        | —                       |
| Linux Wayland   | `portal`     | `spectacle` (KDE fallback) |

Only the selected backend loads its optional Python dependencies. The portal
and Spectacle backends are rejected at startup on Windows and macOS, where the
GStreamer packages are not needed. On macOS, grant the terminal (or the Python
app) **Screen Recording** permission the first time it captures the screen.

On Linux, the user normally needs to be in the `dialout` group:

```bash
sudo usermod -aG dialout "$USER"
# log out and back in for the group change to take effect
```

## Run

Stop any serial monitor or other program that has the WLED port open, then:

```bash
source .venv/bin/activate
python wled_ambient.py --list-ports
python wled_ambient.py --port /dev/ttyUSB0
```

The port is auto-detected if only one likely USB serial adapter is present.

For the smooth realtime behavior used by most Ambilight setups, use Adalight:

```bash
python wled_ambient.py --port /dev/ttyUSB0 --protocol adalight --fps 20
```

To capture the portal at full 1920×1080 instead of the default 640-wide frame:

```bash
python wled_ambient.py --port /dev/ttyUSB0 --protocol adalight \
  --capture-width 1920 --fps 20
```

The 1920-wide portal uses noticeably more CPU. On this laptop it measured about
12.7–20.1 FPS with occasional dips, while 640 measured close to 20 FPS. Edge
colors do not need full resolution; 640 (default), 960, or 1280 is usually both
smoother and visually equivalent. Try 1920 if you specifically want full-HD
capture.

Useful options:

```bash
# Test screen capture and FPS without touching the WLED serial port
python wled_ambient.py --dry-run

# Force the Wayland portal backend
python wled_ambient.py --capture portal --port /dev/ttyUSB0

# Tune the look
python wled_ambient.py --brightness 0.8 --smoothing 0.35 --edge-depth 6
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

## Serial protocols

WLED accepts two serial protocols:

| Protocol | Frame size for 61 LEDs | Default baud | Notes |
| -------- | ---------------------- | ------------ | ----- |
| `json` (default) | ~600–700 bytes | 460800 | Uses WLED's JSON API; easy to inspect; more ESP parsing time. |
| `adalight` | 189 bytes | 115200 | Recommended for smooth realtime output; binary, low overhead. |

Adalight is the better choice for ambilight. JSON remains available with
`--protocol json`. JSON mode uses segment 0 for the whole strip; Adalight
writes pixels directly and leaves your existing segment layout (for example,
the Web Serial control panel's four segments) untouched.

### Baud handling

The script probes the common rates (115200, the requested rate, 230400, 460800,
and 921600) for WLED's version reply. It verifies a temporary baud switch and
falls back to the rate that answered, rather than leaving the host at a rate
WLED is not using.

For Adalight the default is **115200**, which is WLED's normal boot rate. No
temporary baud change is needed: 61 LEDs at 20 FPS need only about 38 kbit/s,
and the larger timing margin is much more tolerant of USB/ESP stalls. A WLED
reboot also returns to 115200, so the next frames resume automatically.

For JSON the default remains **460800** because a JSON frame is much larger.
If you want to override either default:

```bash
python wled_ambient.py --baud 230400 --protocol adalight
python wled_ambient.py --baud 921600 --protocol json
```

`--no-baud-setup` opens the port directly at the chosen rate and skips WLED's
temporary baud-change command. Use it when you have already configured WLED
and the serial port for the same rate.

### Reset lines

The script releases DTR and RTS after opening the port. On CP210x/CH340 ESP
boards those lines drive the auto-reset circuit; leaving them asserted can hold
the board in reset or download mode, or fill the host's receive buffer with
bootloader noise.

### LED count and startup check

After opening the port the script sends a verbose `{"v":true}` query and prints
WLED's version and configured LED count. It does not change WLED's settings.
If WLED reports a count other than 61, set **Config → LED Preferences → Length**
to 61. The Web Serial control panel's four-segment layout also requires 61 LEDs.

### Shutdown and older builds

In Adalight mode, on exit the script sends only `{"live":false}`; WLED leaves
realtime mode and its normal effect can resume. An earlier version used `lor:2`
(`realtimeOverride=2`) to defeat WLED's 2.5-second realtime timeout; that made
WLED ignore all later Adalight pixels until a reboot. It has been removed.

If the strip stays dark after upgrading from that build, power-cycle WLED once
to clear the old override.

### Serial TX unavailable

On a board whose LED data pin is GPIO1, WLED cannot also use GPIO1 for serial
TX. The script will report that no version reply was received, but it can still
send frames. Use `--no-baud-setup` if WLED is already at the correct rate. On
this controller the LED pin is GPIO13, so serial replies work.

## Power and stability

61 LEDs at full white can draw roughly 3 A at 5 V. A laptop USB port, a thin
cable, or a marginal hub may brown out the ESP or the strip. Symptoms include
all LEDs going dark, WLED rebooting, and occasionally a truncated configuration
file. If that happens:

- use a powered USB hub or a separate 5 V supply with a common ground;
- lower `--brightness` (for example `--brightness 0.8`);
- try a shorter, thicker USB cable;
- keep WLED's automatic brightness limiter enabled and set a realistic current
  limit in WLED's LED Preferences.

The controller examined during development had `cfg.json` at 0 bytes with a
valid `bkp.cfg.json` backup reporting 49 LEDs. That pattern is consistent with
an interrupted config write. Re-save the configuration and check the power
path if it recurs. Its automatic brightness limit was also set to 1000 mA,
which will noticeably dim a 61-LED strip at full white; raise the limit only if
the power supply can deliver the current.

## Troubleshooting

### LEDs turn off after a few seconds or minutes

The serial link was probably lost or WLED rebooted. At the Adalight default of
115200, WLED comes back at the same rate and the next frames resume. At 460800,
a reboot leaves WLED at 115200 while the host is still at 460800, so the LEDs
stay off until the script is restarted. Use the default 115200 for Adalight
first.

If the stop still happens at 115200, check power and the USB connection. Also
look for the startup LED-count warning; a WLED configuration of 49 LEDs leaves
the bottom 12 LEDs dark, which can look like a partial failure.

### Bottom 12 LEDs never light

WLED is configured for 49 LEDs. Set the LED count to 61 in WLED's LED
Preferences and make sure the segment length covers all 61. The Web Serial
control panel's **Configure segments** button creates the expected four
segments after the count is 61.

### No WLED version reply

Either WLED's serial TX pin is used by LED data, or the port is at a different
baud. The script still streams; check the startup message. If you know the
port's rate, pass `--baud` and `--no-baud-setup`.

### Full HD capture drops frames

Use the 640 default, or try `--capture-width 960`. The LED colors are averages
of screen-edge regions, so a 640-wide capture produces essentially the same
colors with much less CPU. Use 1920 only when you specifically need full-HD
capture and can accept occasional frame drops.

### WLED is in AP mode

WLED broadcasts `WLED-AP` when it cannot join its configured Wi-Fi network.
That does not affect USB serial control. To use the HTTP API or the Web Serial
panel without a cable, configure WLED's Wi-Fi in its web UI or connect to its
AP.

## Options summary

| Option | Description |
| ------ | ----------- |
| `--port PATH` | Serial port, e.g. `/dev/ttyUSB0` or `COM5` |
| `--protocol {json,adalight}` | Serial LED protocol (default `json`) |
| `--baud N` | Serial baud (auto: 115200 for `adalight`, 460800 for `json`) |
| `--no-baud-setup` | Open at `--baud` without sending WLED's baud-change command |
| `--fps N` | Target frame rate (default 20) |
| `--capture {auto,portal,mss,spectacle}` | Capture backend (Linux offers all; Windows/macOS offer `auto` and `mss`) |
| `--capture-width PIXELS` | Portal capture width (default 640; 1920 for full HD) |
| `--monitor N` | Monitor index for `mss`/Spectacle; portal uses the dialog selection |
| `--edge-depth PERCENT` | Sampling depth from the screen edge (default 6) |
| `--brightness FACTOR` | Scale output colors (default 1.0) |
| `--smoothing 0..1` | Temporal smoothing (default 0.35; 0 disables) |
| `--dry-run` | Capture and compute without serial output |
| `--list-ports` | List serial ports and exit |
| `--quiet` | Suppress periodic FPS output |
