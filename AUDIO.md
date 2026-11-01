# WLED audio-reactive bars

Captures the computer's system audio, splits it into bass and treble bands
plus overall amplitude, and streams the result to WLED over USB serial.

| Strip | WLED segment | Driven by |
| ----- | ------------ | --------- |
| Left  | `left`       | bass (20–250 Hz by default) |
| Right | `right`      | treble (2–20 kHz by default) |
| Top   | `top`        | overall amplitude, centred on the strip |

The script looks for segments named `left`, `right`, and `top` (the names used
by the Web Serial control panel's four-segment layout), or accepts explicit
`--seg-left` / `--seg-right` / `--seg-top` overrides. If no segments match and
no overrides were given, the four-segment layout is created on the board.

## Audio capture by platform

| Platform | Backend | Requirements |
| -------- | ------- | ------------ |
| Linux    | PulseAudio / PipeWire `parec` | `pulseaudio-utils` or `pipewire-pulse` (falls back to `soundcard` if `parec` is missing) |
| Windows  | WASAPI loopback | the `soundcard` Python package (installed by `requirements.txt`) |
| macOS    | virtual loopback input | `soundcard` plus a loopback device such as [BlackHole](https://existential.audio/blackhole/) |

## Setup

```bash
python3.12 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
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
| `--bass-color COLOR`, `--treble-color`, `--amp-color` | Bar colors (RRGGBB or R,G,B) |
| `--seg-left`, `--seg-right`, `--seg-top` | Segment as `START:STOP` or `id:N` |
| `--reverse-right`, `--reverse-top` | Grow those bars from the opposite end |
| `--brightness FACTOR` | Scale lit colors (default 1.0) |
| `--smoothing 0..1` | Temporal smoothing (default 0.35) |
| `--noise-floor LEVEL` | Treat band levels below this as silence (default 0.001) |
| `--dry-run` | Analyse audio without serial output |
| `--list-audio` | List capture devices and exit |
| `--list-ports` | List serial ports and exit |
| `--quiet` | Suppress periodic statistics |
