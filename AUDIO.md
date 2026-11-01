# WLED audio-reactive bars

Captures the computer's system audio, splits it into bass and treble bands
plus overall amplitude, and streams the result to WLED over USB serial. The
bottom strip flashes in time with the beat.

| Strip  | WLED segment | Driven by |
| ------ | ------------ | --------- |
| Left   | `left`       | bass (20–250 Hz by default) |
| Right  | `right`      | treble (2–20 kHz by default) |
| Top    | `top`        | left/right channel levels split at the middle (mono: overall amplitude centred) |
| Bottom | `bottom`     | beat flash, with an accent on the last beat of each bar |

The script looks for segments named `left`, `right`, `top`, and `bottom` (the
names used by the Web Serial control panel's four-segment layout), or accepts
explicit `--seg-left` / `--seg-right` / `--seg-top` / `--seg-bottom` overrides.
If the four segments are not found and no overrides were given, the full
four-segment layout is created on the board.

The three bars start with a random color and cross-fade to a new random color
every `--color-interval` seconds (20 by default). The bottom beat colors switch
at the same time. Use `--color-fade` to control the bar transition time,
explicit `--bass-color` / `--treble-color` / `--amp-color` values for the
starting colors, or `--color-interval 0` to keep colors static:

```bash
# Static orange bass, blue treble, white amplitude
python wled_audio.py --color-interval 0 \
  --bass-color FF5000 --treble-color 00B4FF --amp-color FFFFFF

# Fast color show: a new color every 5 seconds, 1-second cross-fade
python wled_audio.py --color-interval 5 --color-fade 1
```

## Beat flash

The bottom strip flashes on detected kicks/onsets:

- Beats 1–3 of a 4/4 bar use the current main color.
- Beat 4 uses a different random accent color.
- In 3/4, the first two beats use the main color and beat 3 is the accent.
- The main and accent colors are random and guaranteed to be visibly
  different. They change when the three bars change colors, not every bar.
- Each hit is held at full brightness and then fades, so beats remain clearly
  visible without a hard blink.

`--beats-per-bar auto` (the default) estimates 3/4 vs 4/4 from the accent
pattern. It takes a few bars to settle and works best with a clear downbeat.
Force the meter when needed:

```bash
python wled_audio.py --beats-per-bar 3     # waltz
python wled_audio.py --beats-per-bar 4     # common time
python wled_audio.py --beat-sensitivity 2  # fewer false triggers
python wled_audio.py --beat-hold 0.12 --beat-fade 0.35
```

If beat detection is too eager or too quiet, adjust `--beat-sensitivity`,
`--beat-min-interval`, or `--noise-floor`. The periodic statistics show the
current bar position and estimated BPM.

When the capture device reports two channels, the top strip splits at its
middle: from the middle toward one end shows the left channel, and toward the
other end shows the right channel. Mono input keeps the original centred fill.
Use `--reverse-top` to swap which end shows which channel.

## Auto-scaling

Each band is mapped to its strip using the minimum and maximum seen in the
last `--range-window` seconds (60 by default). Old extremes expire, so after a
quiet song has been playing for a minute, its own quiet peaks become the new
full-scale range instead of the louder song's peaks owning the strip forever.

For example, if the last minute contains values from 20 to 80, those become the
new bounds and the strip spans that range. The periodic statistics show the
current bounds for each band.

## Audio capture by platform

| Platform | Backend | Requirements |
| -------- | ------- | ------------ |
| Linux    | PulseAudio / PipeWire `parec` | `pulseaudio-utils` or `pipewire-pulse` (falls back to `soundcard` if `parec` is missing) |
| Windows  | WASAPI loopback | the `soundcard` Python package (installed by the Windows requirements) |
| macOS    | virtual loopback input | `soundcard` plus a loopback device such as [BlackHole](https://existential.audio/blackhole/) |

## Setup

The easiest way is the platform-independent launcher, which creates `.venv`
and installs the matching requirements automatically:

```bash
python main.py
```

To set up manually:

```bash
python3.12 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements-linux.txt   # or -windows.txt / -macos.txt
```

On macOS, install BlackHole and either select it as the output device or create
a Multi-Output Device so you still hear the audio. Then pass it with
`--device` or pick it from `--list-audio`.

## Run

```bash
# List capture devices; loopback/monitor sources are marked with *
python wled_audio.py --list-audio

# Auto-detect the serial port and the system-audio loopback source
python wled_audio.py

# Analyse audio without touching the WLED serial port
python wled_audio.py --dry-run

# Pick a specific audio device and the smooth Adalight protocol
python wled_audio.py --device "Speakers (Realtek(R) Audio)" \
  --protocol adalight --fps 40

# Explicit segment ranges (stop exclusive) when the names do not exist
python wled_audio.py --seg-left 35:49 --seg-right 0:14 --seg-top 14:35
```

The serial port can also be forced with `--port COM5` (Windows) or
`--port /dev/ttyUSB0` (Linux/macOS).

## Automatic switching with the ambilight

`main.py` watches browser window titles and runs this script while YouTube
Music is open, then switches to `wled_ambient.py` when it closes:

```bash
python main.py
```

Detection uses the active browser tab/window title, so YouTube Music in a
background tab is not detected. On Linux, install `wmctrl` or `xdotool` so the
launcher can enumerate windows.

## Responsiveness

Serial frames are written on a background thread and only the newest frame is
kept, so a slow USB write cannot stall audio analysis. If the capture backend
stops delivering samples, the output drops to silence instead of freezing the
LEDs at stale levels.

## Options summary

| Option | Description |
| ------ | ----------- |
| `--port PATH` | Serial port, e.g. `/dev/ttyUSB0` or `COM5` |
| `--protocol {json,adalight}` | Serial LED protocol (default `json`) |
| `--fps N` | Maximum frames per second (default 30) |
| `--rate HZ` | Requested audio sample rate (default 44100) |
| `--fft SAMPLES` | FFT window size (default 4096) |
| `--device NAME` | Capture device name or id (see `--list-audio`) |
| `--bass-range LO:HI` | Bass band in Hz (default `20:250`) |
| `--treble-range LO:HI` | Treble band in Hz (default `2000:20000`) |
| `--bass-color COLOR`, `--treble-color`, `--amp-color` | Initial bar colors (RRGGBB or R,G,B; default random) |
| `--color-interval SECONDS` | Time between random color changes (default 20; 0 disables) |
| `--color-fade SECONDS` | Cross-fade time to the next color (default 2) |
| `--beats-per-bar {auto,3,4}` | Beat grouping; auto detects 3/4 vs 4/4 (default auto) |
| `--beat-sensitivity FACTOR` | Higher values require a stronger transient (default 1.5) |
| `--beat-min-interval SECONDS` | Refractory period between beats (default 0.18) |
| `--beat-hold SECONDS` | Full-brightness beat hold (default 0.10) |
| `--beat-fade SECONDS` | Beat fade time after the hold (default 0.30) |
| `--seg-left`, `--seg-right`, `--seg-top`, `--seg-bottom` | Segment as `START:STOP` or `id:N` |
| `--reverse-right`, `--reverse-top` | Grow those bars from the opposite end |
| `--brightness FACTOR` | Scale lit colors (default 1.0) |
| `--smoothing 0..1` | Temporal smoothing (default 0.35) |
| `--range-window SECONDS` | Rolling min/max history for auto-scaling (default 60) |
| `--noise-floor LEVEL` | Treat band levels below this as silence (default 0.001) |
| `--dry-run` | Analyse audio without serial output |
| `--list-audio` | List capture devices and exit |
| `--list-ports` | List serial ports and exit |
| `--quiet` | Suppress periodic statistics |
