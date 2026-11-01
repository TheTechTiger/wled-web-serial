#!/usr/bin/env python3
"""Audio-reactive LED bars for WLED over USB serial.

System audio is analysed in three ways and mapped onto three WLED segments:

    left segment   -> bass (20-250 Hz by default), filled from the first LED
                       up to the current bass level
    right segment  -> treble (2-20 kHz by default), filled from the first LED
                       up to the current treble level
    top segment    -> overall amplitude; lit symmetrically around the middle
                       LED (level 0 = middle LED only, 1 = middle 3, 2 = middle 5, ...)

Segments are discovered from WLED over serial: the script looks for segments
named "left", "right" and "top" — the names used by the Web Serial control
panel's 4-segment layout — or accepts explicit --seg-left/--seg-right/--seg-top
overrides (START:STOP with stop exclusive, or id:N). If discovery fails and no
overrides were given, the four-segment layout is created on the board
automatically (Right 0:14, Top 14:35, Left 35:49, Bottom 49:end).

Each band auto-ranges: the first reading seeds both the minimum and the
maximum, and the tracked bounds then follow every new extreme
(current < min -> min = current, current > max -> max = current). The level is
the current value normalised into that window.

Each strip starts with a random color and cross-fades to a new random color
every --color-interval seconds (20 by default) over --color-fade seconds
(2 by default). Pass explicit --bass-color/--treble-color/--amp-color values
to set the starting colors, or --color-interval 0 to keep them static.

Audio is captured from the system's playback (loopback), so whatever the
computer plays drives the LEDs, other system sounds included. The capture
backend is chosen for the platform:

    Linux    PulseAudio / PipeWire through parec (falls back to soundcard)
    Windows  WASAPI loopback through the soundcard package
    macOS    a virtual loopback input (e.g. BlackHole) through soundcard

`--list-audio` shows the available capture devices and `--device` selects one;
loopback/monitor sources are marked with `*` on every platform.

Examples:
    python wled_audio.py                 # auto port, auto audio device, auto segments
    python wled_audio.py --dry-run       # analyse audio only, no serial
    python wled_audio.py --seg-left 35:49 --seg-right 0:14 --seg-top 14:35
    python wled_audio.py --protocol adalight --fps 40
"""

from __future__ import annotations

import argparse
import colorsys
import json
import os
import random
import shutil
import signal
import subprocess
import sys
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass

import numpy as np
import serial

from wled_ambient import Smoother, WledSerial, find_serial_port, print_serial_ports


# ---------------------------------------------------------------------------
# Platform detection
# ---------------------------------------------------------------------------
IS_LINUX = sys.platform.startswith("linux")
IS_WINDOWS = sys.platform.startswith("win")
IS_MACOS = sys.platform == "darwin"


# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------
DEFAULT_BASS_RANGE = (20.0, 250.0)
DEFAULT_TREBLE_RANGE = (2000.0, 20000.0)
DEFAULT_COLOR_INTERVAL = 20.0
DEFAULT_COLOR_FADE = 2.0

# Dry-run fallback ranges, from the ambilight layout.
DRY_RUN_SEGMENTS = {
    "right": (0, 14),
    "top": (14, 35),
    "left": (35, 49),
}

BAND_LABELS = ("left", "right", "top")


# ---------------------------------------------------------------------------
# Segments
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class Segment:
    id: int
    name: str
    start: int
    stop: int

    @property
    def count(self) -> int:
        return max(0, self.stop - self.start)


def extract_segments(payload: dict) -> list[Segment]:
    """Return WLED's segments from a state/info JSON payload."""
    state = payload.get("state")
    segs = state.get("seg") if isinstance(state, dict) else None
    if not isinstance(segs, list):
        info = payload.get("info")
        segs = info.get("segments") if isinstance(info, dict) else None
    if not isinstance(segs, list):
        return []

    result: list[Segment] = []
    for entry in segs:
        if not isinstance(entry, dict):
            continue
        start = int(entry.get("start", 0))
        stop = entry.get("stop")
        if stop is None:
            stop = start + int(entry.get("len", entry.get("n", 0)))
        result.append(
            Segment(
                id=int(entry.get("id", 0)),
                name=str(entry.get("n", entry.get("name", "")) or ""),
                start=start,
                stop=int(stop),
            )
        )
    return result


def describe_segments(segments: list[Segment]) -> str:
    if not segments:
        return "  (WLED reports no segments)"
    lines = []
    for seg in segments:
        name = f"'{seg.name}'" if seg.name else "(unnamed)"
        lines.append(
            f"  id {seg.id}  {name}  LEDs {seg.start}..{seg.stop - 1} ({seg.count})"
        )
    return "\n".join(lines)


def resolve_segments(
    segments: list[Segment],
    overrides: dict[str, tuple[str, object] | None],
) -> dict[str, Segment]:
    """Map the left/right/top labels to WLED segments by override or name."""
    resolved: dict[str, Segment] = {}
    problems: list[str] = []

    for label in BAND_LABELS:
        override = overrides[label]
        if override is not None:
            kind, value = override
            if kind == "id":
                seg = next((s for s in segments if s.id == value), None)
                if seg is None:
                    problems.append(f"--seg-{label} id:{value}: no segment with that id")
                    continue
            else:
                start, stop = value  # type: ignore[misc]
                seg = next(
                    (s for s in segments if s.start == start and s.stop == stop), None
                )
                if seg is None:
                    problems.append(
                        f"--seg-{label} {start}:{stop}: WLED has no segment with "
                        "that range (create it in WLED, or address it with id:N)"
                    )
                    continue
            resolved[label] = seg
        else:
            matches = [s for s in segments if label in s.name.lower()]
            if len(matches) == 1:
                resolved[label] = matches[0]
            elif len(matches) > 1:
                ids = ", ".join(f"id {s.id}" for s in matches)
                problems.append(
                    f"more than one segment matches the name '{label}' ({ids})"
                )
            else:
                problems.append(f"no segment is named '{label}'")

    if problems:
        raise RuntimeError(
            "Could not resolve the left/right/top segments:\n  "
            + "\n  ".join(problems)
            + "\nWLED reports these segments:\n"
            + describe_segments(segments)
            + "\nName three segments left/right/top in WLED's Segments panel "
            "(the control panel's '4-seg layout' button does this), or pass "
            "--seg-left START:STOP / --seg-right / --seg-top (stop exclusive, "
            "or id:N)."
        )

    for label, seg in resolved.items():
        if seg.count <= 0:
            raise RuntimeError(f"Segment for {label} is empty: {describe_segments([seg])}")
    return resolved


def dry_run_segments(
    overrides: dict[str, tuple[str, object] | None],
) -> dict[str, Segment]:
    resolved: dict[str, Segment] = {}
    for label in BAND_LABELS:
        override = overrides[label]
        start, stop = DRY_RUN_SEGMENTS[label]
        if override is not None and override[0] == "range":
            start, stop = override[1]  # type: ignore[misc]
        resolved[label] = Segment(id=-1, name=f"{label} (dry-run)", start=start, stop=stop)
    return resolved


# ---------------------------------------------------------------------------
# Audio capture (platform backends)
# ---------------------------------------------------------------------------
# Linux keeps using PulseAudio/PipeWire's parec so no extra Python package is
# needed there. Windows and macOS use the optional `soundcard` package: WASAPI
# loopback on Windows, a virtual loopback input (BlackHole, Soundflower, ...)
# on macOS. On Linux without parec, soundcard is used as a fallback when it is
# installed.
@dataclass(frozen=True)
class AudioDevice:
    id: str
    name: str
    description: str = ""
    monitor: bool = False


def _load_soundcard():
    """Import soundcard lazily and explain how to install it when missing."""
    try:
        import soundcard
    except ImportError:
        platform_name = "Windows" if IS_WINDOWS else "macOS" if IS_MACOS else "Linux"
        raise RuntimeError(
            "The 'soundcard' package is required for audio capture on "
            f"{platform_name}. Install it with: pip install soundcard "
            "(or run python main.py to install the matching requirements)."
        ) from None
    return soundcard


def _pulse_audio_devices() -> list[AudioDevice]:
    """Return the PulseAudio/PipeWire sources reported by pactl."""
    if shutil.which("pactl") is None:
        return []
    proc = subprocess.run(
        ["pactl", "list", "short", "sources"],
        capture_output=True,
        text=True,
        timeout=5,
    )
    if proc.returncode != 0:
        return []
    result = []
    for line in proc.stdout.splitlines():
        parts = line.split("\t")
        name = parts[1] if len(parts) > 1 else ""
        if not name:
            continue
        result.append(
            AudioDevice(
                id=name,
                name=name,
                description=parts[2] if len(parts) > 2 else "",
                monitor=name.endswith(".monitor"),
            )
        )
    return result


def _soundcard_audio_devices() -> list[AudioDevice]:
    sc = _load_soundcard()
    result = []
    for mic in sc.all_microphones(include_loopback=True):
        loopback = bool(getattr(mic, "isloopback", False))
        result.append(
            AudioDevice(
                id=str(mic.id),
                name=str(mic.name),
                description="loopback" if loopback else "",
                monitor=loopback,
            )
        )
    return result


def list_audio_devices() -> list[AudioDevice]:
    """List capture devices for this platform; monitors are marked."""
    if IS_LINUX and shutil.which("pactl"):
        return _pulse_audio_devices()
    return _soundcard_audio_devices()


def find_monitor_source() -> str:
    """Pick the PulseAudio/PipeWire monitor of the default sink."""
    if shutil.which("pactl") is None:
        raise RuntimeError(
            "pactl was not found; install pulseaudio-utils / pipewire-pulse, "
            "or pass --device with an audio source name."
        )

    def pactl_stdout(*cmd: str) -> str:
        proc = subprocess.run(
            ["pactl", *cmd], capture_output=True, text=True, timeout=5
        )
        return proc.stdout if proc.returncode == 0 else ""

    sink = pactl_stdout("get-default-sink").strip()
    if not sink:
        for line in pactl_stdout("info").splitlines():
            if line.startswith("Default Sink:"):
                sink = line.split(":", 1)[1].strip()
                break

    sources = [device.name for device in _pulse_audio_devices()]
    if sink:
        candidate = sink + ".monitor"
        if candidate in sources:
            return candidate

    monitors = [name for name in sources if name.endswith(".monitor")]
    if monitors:
        return monitors[0]

    raise RuntimeError(
        "No monitor source was found. Is PulseAudio/PipeWire running? "
        "Pass --device with an audio source (see --list-audio)."
    )


def _soundcard_microphone(spec: str):
    """Resolve --device to a soundcard microphone by name, id, or substring."""
    sc = _load_soundcard()
    microphones = list(sc.all_microphones(include_loopback=True))
    for mic in microphones:
        if spec in (str(mic.id), str(mic.name)):
            return mic

    needle = spec.lower()
    matches = [
        mic
        for mic in microphones
        if needle in str(mic.name).lower() or needle in str(mic.id).lower()
    ]
    if len(matches) == 1:
        return matches[0]
    if len(matches) > 1:
        names = ", ".join(f"'{mic.name}'" for mic in matches)
        raise RuntimeError(
            f"Audio device {spec!r} matches several devices ({names}); "
            "pass a more specific name or id (see --list-audio)."
        )

    available = ", ".join(f"'{mic.name}'" for mic in microphones) or "none"
    raise RuntimeError(
        f"No audio device matches {spec!r}. Available devices: {available}."
    )


def _find_loopback_device() -> str:
    """Pick the default speaker's loopback (or a macOS virtual loopback)."""
    sc = _load_soundcard()
    microphones = list(sc.all_microphones(include_loopback=True))
    loopbacks = [mic for mic in microphones if getattr(mic, "isloopback", False)]

    try:
        speaker = sc.default_speaker()
    except Exception:
        speaker = None

    if speaker is not None:
        speaker_id = str(speaker.id)
        speaker_name = str(speaker.name)
        for mic in loopbacks:
            if str(mic.id) == speaker_id:
                return str(mic.id)
        for mic in loopbacks:
            if speaker_name in str(mic.name):
                return str(mic.id)

    if loopbacks:
        return str(loopbacks[0].id)

    if IS_MACOS:
        for mic in microphones:
            name = str(mic.name).lower()
            if any(
                key in name
                for key in ("blackhole", "soundflower", "loopback", "virtual")
            ):
                return str(mic.id)
        raise RuntimeError(
            "No system-audio loopback device was found. macOS needs a virtual "
            "audio device such as BlackHole: install it, route the output to it "
            "(or to a Multi-Output Device), then pass --device or pick it from "
            "--list-audio."
        )

    raise RuntimeError(
        "No loopback/monitor audio device was found. Enable a playback device, "
        "or pass --device with a capture source (see --list-audio)."
    )


def find_audio_device() -> str:
    """Return the default system-audio source for the current platform."""
    if IS_LINUX and shutil.which("parec") is not None:
        return find_monitor_source()
    return _find_loopback_device()


class AudioStream:
    """Common buffered-window interface shared by the capture backends."""

    # Keep a few windows of history so a slow frame can never see a gap.
    _HISTORY_WINDOWS = 4
    # If the capture thread stops delivering samples, replaying the last
    # window would freeze the LEDs at stale levels. Treat that as silence.
    _STALE_AFTER_SECONDS = 0.6

    def __init__(self, rate: int):
        self.rate = rate
        self.device = ""
        self.tail = bytearray()
        self._lock = threading.Lock()
        self._window_bytes = 0  # set by the first read_window call
        self._last_append = 0.0
        self._stall_reported = False

    def _append(self, data: bytes) -> None:
        if not data:
            return
        with self._lock:
            self._last_append = time.monotonic()
            self.tail.extend(data)
            cap = max(self._window_bytes * self._HISTORY_WINDOWS, 1 << 16)
            if len(self.tail) > cap:
                del self.tail[:-cap]

    def _check_healthy(self) -> None:
        """Raise RuntimeError if the backend stopped producing audio."""

    def read_window(self, samples: int) -> np.ndarray:
        """Return the newest `samples` float32 samples, zero-padded if short.

        Non-blocking: the newest samples were staged by the reader thread.
        """
        self._check_healthy()
        with self._lock:
            self._window_bytes = samples * 4
            stale = (
                self._last_append > 0.0
                and time.monotonic() - self._last_append
                > self._STALE_AFTER_SECONDS
            )
            if stale:
                self.tail.clear()
                buf = b""
            else:
                buf = bytes(self.tail[-self._window_bytes:])

        if stale and not self._stall_reported:
            print(
                "Warning: audio capture stalled; outputting silence until it "
                "recovers.",
                file=sys.stderr,
            )
            self._stall_reported = True
        elif not stale:
            self._stall_reported = False

        if len(buf) < self._window_bytes:
            buf = b"\x00" * (self._window_bytes - len(buf)) + buf
        return np.frombuffer(buf, dtype="<f4").astype(np.float32)

    def close(self) -> None:
        raise NotImplementedError


class PulseAudioStream(AudioStream):
    """Reads mono float32 PCM from parec (PulseAudio / PipeWire).

    A background thread drains parec's pipe continuously at production rate.
    Consuming a fixed-size chunk per frame instead would read audio slower
    than realtime (e.g. 4096 B every 33 ms vs ~5880 B produced), the pipe
    would fill up, and parec/PipeWire would queue ever more audio behind it —
    the LEDs end up reacting many seconds late.
    """

    def __init__(self, device: str, rate: int):
        if shutil.which("parec") is None:
            raise RuntimeError(
                "parec was not found; install pulseaudio-utils / pipewire-pulse."
            )
        super().__init__(rate)
        self.device = device
        self._proc = subprocess.Popen(
            [
                "parec",
                "--format=float32le",
                f"--rate={rate}",
                "--channels=1",
                "--raw",
                f"--device={device}",
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        self._stdout = self._proc.stdout
        self._reader = threading.Thread(target=self._drain, daemon=True)
        self._reader.start()

    def _drain(self) -> None:
        """Continuously consume parec's pipe so audio never backs up."""
        try:
            while True:
                chunk = self._stdout.read1(1 << 16)
                if not chunk:  # EOF
                    return
                self._append(chunk)
        except (OSError, ValueError):
            return

    def _check_healthy(self) -> None:
        if self._proc.poll() is not None:
            detail = self._stderr_text()
            raise RuntimeError(
                "parec exited unexpectedly" + (f": {detail}" if detail else "")
            )

    def _stderr_text(self) -> str:
        try:
            self._proc.wait(timeout=1)
            data = self._proc.stderr.read() if self._proc.stderr else b""
            return data.decode(errors="replace").strip()
        except Exception:
            return ""

    def close(self) -> None:
        if self._proc.poll() is None:
            self._proc.terminate()
            try:
                self._proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self._proc.kill()


class SoundCardStream(AudioStream):
    """Reads mono float32 PCM through the cross-platform soundcard package.

    Windows captures the default speaker's WASAPI loopback; macOS captures a
    virtual loopback input such as BlackHole. A background thread drains the
    recorder so the LED loop always sees the newest audio instead of a backlog.
    """

    _BLOCK_FRAMES = 1024

    def __init__(self, device: str, rate: int):
        super().__init__(rate)
        self._error: str | None = None
        self._ready = threading.Event()
        self._stop = threading.Event()
        self._microphone = _soundcard_microphone(device)
        self.device = str(self._microphone.name)
        self._recorder = self._microphone.recorder(
            samplerate=rate,
            channels=1,
            blocksize=self._BLOCK_FRAMES,
        )
        self._reader = threading.Thread(target=self._drain, daemon=True)
        self._reader.start()
        if not self._ready.wait(timeout=5):
            raise RuntimeError(f"Timed out opening audio device {self.device!r}")
        if self._error is not None:
            raise RuntimeError(
                f"Could not capture from {self.device!r}: {self._error}"
            )

    def _drain(self) -> None:
        try:
            with self._recorder as recorder:
                self._ready.set()
                while not self._stop.is_set():
                    chunk = recorder.record(numframes=self._BLOCK_FRAMES)
                    if chunk is None or len(chunk) == 0:
                        continue
                    samples = np.asarray(chunk, dtype=np.float32)
                    if samples.ndim > 1:
                        samples = samples.mean(axis=1)
                    self._append(samples.astype("<f4", copy=False).tobytes())
        except Exception as exc:  # soundcard surfaces backend errors this way
            self._error = f"{type(exc).__name__}: {exc}"
        finally:
            self._ready.set()

    def _check_healthy(self) -> None:
        if self._error is not None:
            raise RuntimeError(
                f"Audio capture from {self.device!r} stopped: {self._error}"
            )

    def close(self) -> None:
        self._stop.set()
        if self._reader.is_alive():
            self._reader.join(timeout=2)


def open_audio_stream(device: str, rate: int) -> AudioStream:
    """Open the capture backend that belongs to this platform."""
    if IS_LINUX and shutil.which("parec") is not None:
        return PulseAudioStream(device, rate)
    return SoundCardStream(device, rate)


# ---------------------------------------------------------------------------
# Analysis
# ---------------------------------------------------------------------------
class AutoRange:
    """Dynamic min/max tracker: seeds both bounds with the first reading,
    then follows every new extreme."""

    def __init__(self) -> None:
        self.lo: float | None = None
        self.hi: float | None = None

    def update(self, current: float) -> float:
        if self.lo is None or self.hi is None:
            self.lo = self.hi = current
        else:
            if current < self.lo:
                self.lo = current
            if current > self.hi:
                self.hi = current
        span = self.hi - self.lo
        if span <= 1e-12:
            return 0.0
        return max(0.0, min(1.0, (current - self.lo) / span))


def analyze(
    samples: np.ndarray,
    window: np.ndarray,
    freqs: np.ndarray,
    bass_range: tuple[float, float],
    treble_range: tuple[float, float],
) -> tuple[float, float, float]:
    """Return (bass, treble) band levels and overall time-domain RMS."""
    x = np.nan_to_num(samples, nan=0.0, posinf=0.0, neginf=0.0)
    amp = float(np.sqrt(np.mean(x * x)))
    spec = np.abs(np.fft.rfft(x * window)) * (2.0 / window.sum())

    def band(lo: float, hi: float) -> float:
        mask = (freqs >= lo) & (freqs <= hi)
        if not mask.any():
            return 0.0
        return float(np.sqrt(np.mean(spec[mask] ** 2)))

    return band(*bass_range), band(*treble_range), amp


# ---------------------------------------------------------------------------
# LED mapping
# ---------------------------------------------------------------------------
def fill_linear(count: int, level: float, color: tuple[int, int, int]) -> np.ndarray:
    """Light LEDs from the first LED up to the level: 0 -> 1 LED, 1 -> all."""
    out = np.zeros((count, 3), dtype=np.uint8)
    if count <= 0:
        return out
    lit = 1 + int(round(level * (count - 1)))
    out[: min(max(lit, 1), count)] = color
    return out


def fill_centered(count: int, level: float, color: tuple[int, int, int]) -> np.ndarray:
    """Light LEDs symmetrically around the middle: 0 -> middle 1, 1 -> middle 3, ..."""
    out = np.zeros((count, 3), dtype=np.uint8)
    if count <= 0:
        return out
    center = (count - 1) / 2.0
    radius = int(round(level * (count - 1) / 2.0))
    idx = np.arange(count, dtype=np.float32)
    out[np.abs(idx - center) <= radius + 0.5] = color
    return out


def scale_color(
    color: tuple[int, int, int], brightness: float
) -> tuple[int, int, int]:
    return tuple(
        int(round(max(0.0, min(255.0, channel * brightness))))
        for channel in color
    )  # type: ignore[return-value]


def random_color() -> tuple[int, int, int]:
    """Return a vivid random RGB colour."""
    r, g, b = colorsys.hsv_to_rgb(random.random(), 0.85, 1.0)
    return (round(r * 255), round(g * 255), round(b * 255))


class ColorCycler:
    """One strip colour that cross-fades to a new random colour periodically."""

    def __init__(
        self,
        initial: tuple[int, int, int],
        interval: float,
        fade: float,
        start: float | None = None,
    ):
        self.interval = max(0.0, interval)
        self.fade = (
            max(0.0, min(fade, self.interval)) if self.interval > 0 else 0.0
        )
        self.current = np.asarray(initial, dtype=np.float32)
        self._from = self.current.copy()
        self._to = self.current.copy()
        self._fade_started = 0.0
        self._fading = False
        self._next_change = (
            start if start is not None else time.perf_counter()
        ) + self.interval

    def update(self, now: float) -> tuple[int, int, int]:
        if self.interval <= 0:
            return tuple(int(round(v)) for v in self.current)  # type: ignore[return-value]

        if now >= self._next_change:
            self._from = self.current.copy()
            self._to = np.asarray(random_color(), dtype=np.float32)
            self._fade_started = now
            self._fading = True
            self._next_change = now + self.interval

        if self._fading:
            if self.fade <= 0:
                progress = 1.0
            else:
                progress = min(
                    1.0, max(0.0, (now - self._fade_started) / self.fade)
                )
            self.current = self._from + (self._to - self._from) * progress
            if progress >= 1.0:
                self._fading = False

        return tuple(int(round(v)) for v in self.current)  # type: ignore[return-value]


# ---------------------------------------------------------------------------
# Serial / WLED
# ---------------------------------------------------------------------------
class AudioWledSerial(WledSerial):
    """WledSerial that leaves the user's segments alone and tracks frozen ids."""

    def __post_init__(self) -> None:
        self.frozen_ids: list[int] = []
        super().__post_init__()

    def _send_setup(self) -> None:
        # Unlike the ambilight script this must not rewrite segment 0: the
        # whole point is to drive the segments the user already configured.
        setup = {"on": True, "bri": 255, "transition": 0, "live": False}
        self.send(json.dumps(setup, separators=(",", ":")) + "\n")
        time.sleep(0.02)

    def _report_wled_info(self) -> None:
        info = self.query_info()
        if not info:
            return
        obj = info.get("info")
        if not isinstance(obj, dict):
            return
        details = []
        if obj.get("ver") is not None:
            details.append(f"WLED {obj['ver']}")
        leds = obj.get("leds")
        count = leds.get("count") if isinstance(leds, dict) else None
        if isinstance(count, int):
            details.append(f"{count} LEDs configured")
        if details:
            print("; ".join(details) + ".", file=sys.stderr)

    def freeze(self, segments: list[Segment]) -> None:
        self.frozen_ids = [seg.id for seg in segments]
        payload = {"seg": [{"id": seg.id, "frz": True} for seg in segments]}
        self.send(json.dumps(payload, separators=(",", ":")) + "\n")

    def _segment_names(self) -> dict[int, str]:
        """Return {segment id: name} from WLED's current state."""
        payload = self.query_info() or {}
        result: dict[int, str] = {}
        for seg in extract_segments(payload):
            if seg.name:
                result[seg.id] = seg.name
        return result

    def setup_four_segments(self, led_count: int) -> None:
        """Replace WLED's segments with the four named ambilight/audio ranges.

        Right 0:14, Top 14:35, Left 35:49, Bottom 49:<led count> — the same
        layout the Web Serial control panel's "4-seg layout" button creates.

        Retries until the names land: WLED sometimes needs a moment between the
        reset-segments command and the new segment descriptors.
        """
        if led_count < 49:
            raise RuntimeError(
                f"WLED reports only {led_count} LEDs; the four-segment layout "
                "needs at least 49. Set the LED count in WLED's LED Preferences."
            )
        targets = {
            0: "Right",
            1: "Top",
            2: "Left",
            3: "Bottom",
        }
        ranges = [
            (0, 14, "Right"),
            (14, 35, "Top"),
            (35, 49, "Left"),
            (49, led_count, "Bottom"),
        ]
        segs = [
            {"id": i, "start": start, "stop": stop, "n": name}
            for i, (start, stop, name) in enumerate(ranges)
        ]
        for attempt in range(4):
            self.send(json.dumps({"rSeg": True}, separators=(",", ":")) + "\n")
            time.sleep(0.25)
            self.send(json.dumps({"seg": segs}, separators=(",", ":")) + "\n")
            time.sleep(0.15)
            names = self._segment_names()
            if all(names.get(i) == name for i, name in targets.items()):
                return
            print(
                f"Segment names not applied yet (attempt {attempt + 1}/4), retrying.",
                file=sys.stderr,
            )
            time.sleep(0.3 * (attempt + 1))
        raise RuntimeError(
            "Could not apply names to WLED's segments. Create them manually in "
            "WLED's Segments panel (Right/Top/Left/Bottom) or pass explicit "
            "--seg-left/--seg-right/--seg-top overrides."
        )

    def close(self) -> None:
        if self.serial is not None and self.protocol == "json" and self.frozen_ids:
            try:
                payload = {
                    "seg": [{"id": seg_id, "frz": False} for seg_id in self.frozen_ids]
                }
                self.send(json.dumps(payload, separators=(",", ":")) + "\n")
            except (serial.SerialException, OSError):
                pass
        super().close()


def send_segments_json(
    wled: AudioWledSerial, entries: list[tuple[Segment, np.ndarray]]
) -> None:
    """Write per-segment LED colors in one JSON command."""
    parts = []
    for seg, colors in entries:
        hexes = ",".join(
            f'"{int(r):02x}{int(g):02x}{int(b):02x}"' for r, g, b in colors
        )
        parts.append(f'{{"id":{seg.id},"i":[{hexes}]}}')
    wled.send('{"transition":0,"seg":[' + ",".join(parts) + "]}\n")


class LatestFrameSender:
    """Write serial frames on a background thread, keeping only the newest.

    A blocked USB write (or a slow WLED JSON parser) used to stall the whole
    audio loop, freezing the LEDs for a second or two. The audio loop now
    hands over the latest frame and immediately continues analysing audio;
    stale frames are dropped instead of queued.
    """

    def __init__(self):
        self._lock = threading.Lock()
        self._event = threading.Event()
        self._stop = False
        self._pending: Callable[[], None] | None = None
        self._error: Exception | None = None
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def send(self, job: Callable[[], None]) -> None:
        if self._error is not None:
            return
        with self._lock:
            self._pending = job
        self._event.set()

    def _run(self) -> None:
        while True:
            self._event.wait()
            self._event.clear()
            if self._stop:
                return
            with self._lock:
                job = self._pending
                self._pending = None
            if job is None:
                continue
            try:
                job()
            except Exception as exc:
                self._error = exc
                return

    def check(self) -> None:
        if self._error is not None:
            raise RuntimeError(f"Serial write failed: {self._error}") from self._error

    def close(self) -> None:
        self._stop = True
        self._event.set()
        self._thread.join(timeout=2)


def raise_process_priority() -> None:
    """Best-effort priority bump so capture/analysis threads are not starved."""
    try:
        if IS_WINDOWS:
            import ctypes

            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
            kernel32.GetCurrentProcess.restype = ctypes.c_void_p
            kernel32.SetPriorityClass.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
            kernel32.SetPriorityClass.restype = ctypes.c_int
            # ABOVE_NORMAL_PRIORITY_CLASS; avoids starving the rest of the system.
            kernel32.SetPriorityClass(kernel32.GetCurrentProcess(), 0x00008000)
        elif hasattr(os, "nice"):
            os.nice(-5)
    except (AttributeError, OSError):
        pass


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def parse_color(value: str) -> tuple[int, int, int]:
    v = value.strip().lstrip("#")
    try:
        if "," in v:
            parts = v.split(",")
            if len(parts) != 3:
                raise ValueError
            r, g, b = (int(p.strip()) for p in parts)
        elif len(v) == 6:
            r, g, b = int(v[0:2], 16), int(v[2:4], 16), int(v[4:6], 16)
        else:
            raise ValueError
    except ValueError:
        raise argparse.ArgumentTypeError(
            f"invalid color {value!r}; use RRGGBB or R,G,B"
        ) from None
    for channel in (r, g, b):
        if not 0 <= channel <= 255:
            raise argparse.ArgumentTypeError(f"color channel out of range in {value!r}")
    return (r, g, b)


def parse_freq_range(value: str) -> tuple[float, float]:
    try:
        lo_str, hi_str = value.split(":")
        lo, hi = float(lo_str), float(hi_str)
    except ValueError:
        raise argparse.ArgumentTypeError(
            f"invalid range {value!r}; expected LO:HI in Hz, e.g. 20:250"
        ) from None
    if lo < 0 or hi <= lo:
        raise argparse.ArgumentTypeError(f"invalid range {value!r}; need 0 <= LO < HI")
    return (lo, hi)


def parse_seg_spec(value: str) -> tuple[str, object]:
    v = value.strip()
    if v.startswith("id:"):
        try:
            return ("id", int(v[3:]))
        except ValueError:
            raise argparse.ArgumentTypeError(
                f"invalid segment id in {value!r}; expected id:N"
            ) from None
    try:
        start_str, stop_str = v.split(":")
        start, stop = int(start_str), int(stop_str)
    except ValueError:
        raise argparse.ArgumentTypeError(
            f"invalid segment spec {value!r}; expected START:STOP (stop exclusive) "
            "or id:N"
        ) from None
    if stop <= start:
        raise argparse.ArgumentTypeError(f"invalid segment spec {value!r}; need STOP > START")
    return ("range", (start, stop))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Audio-reactive WLED bars over USB serial: bass on the left strip, "
            "treble on the right strip, overall amplitude on the top strip."
        ),
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("--port", help="Serial port, e.g. /dev/ttyUSB0 or COM5")
    parser.add_argument(
        "--protocol",
        choices=("json", "adalight"),
        default="json",
        help="Serial LED protocol. json drives your segments; adalight streams the whole strip.",
    )
    parser.add_argument(
        "--baud",
        type=int,
        default=argparse.SUPPRESS,
        help=(
            "Serial baud. Defaults to 115200 for adalight (WLED's boot rate, "
            "no temporary baud switch) and 460800 for json."
        ),
    )
    parser.add_argument(
        "--no-baud-setup",
        action="store_true",
        help="Do not send WLED's temporary baud-change command; open the port at --baud directly.",
    )
    parser.add_argument("--fps", type=float, default=30.0, help="Maximum frames per second")
    parser.add_argument(
        "--fft",
        type=int,
        default=4096,
        metavar="SAMPLES",
        help="FFT window size; larger is more precise but adds latency (4096 @ 44.1 kHz is ~93 ms)",
    )
    parser.add_argument(
        "--rate",
        type=int,
        default=44100,
        metavar="HZ",
        help="Audio sample rate requested from the capture backend",
    )
    parser.add_argument(
        "--device",
        help=(
            "Capture device name or id (default: the default speaker's "
            "loopback/monitor source); see --list-audio"
        ),
    )
    parser.add_argument(
        "--list-audio",
        action="store_true",
        help="List capture devices (loopback/monitor sources marked *) and exit",
    )
    parser.add_argument(
        "--bass-range",
        type=parse_freq_range,
        default=DEFAULT_BASS_RANGE,
        metavar="LO:HI",
        help="Bass band in Hz (drives the left strip)",
    )
    parser.add_argument(
        "--treble-range",
        type=parse_freq_range,
        default=DEFAULT_TREBLE_RANGE,
        metavar="LO:HI",
        help="Treble band in Hz (drives the right strip)",
    )
    parser.add_argument(
        "--bass-color",
        type=parse_color,
        default=None,
        metavar="COLOR",
        help=(
            "Initial color of the bass bar (RRGGBB or R,G,B); defaults to a "
            "random color"
        ),
    )
    parser.add_argument(
        "--treble-color",
        type=parse_color,
        default=None,
        metavar="COLOR",
        help="Initial color of the treble bar (default: random)",
    )
    parser.add_argument(
        "--amp-color",
        type=parse_color,
        default=None,
        metavar="COLOR",
        help="Initial color of the amplitude bar on the top strip (default: random)",
    )
    parser.add_argument(
        "--color-interval",
        type=float,
        default=DEFAULT_COLOR_INTERVAL,
        metavar="SECONDS",
        help=(
            "Seconds between random color changes for each strip; 0 keeps the "
            "initial colors"
        ),
    )
    parser.add_argument(
        "--color-fade",
        type=float,
        default=DEFAULT_COLOR_FADE,
        metavar="SECONDS",
        help="Cross-fade time from the current color to the next random color",
    )
    parser.add_argument(
        "--seg-left",
        type=parse_seg_spec,
        default=None,
        metavar="SEG",
        help="Left strip segment as START:STOP (stop exclusive) or id:N",
    )
    parser.add_argument(
        "--seg-right",
        type=parse_seg_spec,
        default=None,
        metavar="SEG",
        help="Right strip segment as START:STOP or id:N",
    )
    parser.add_argument(
        "--seg-top",
        type=parse_seg_spec,
        default=None,
        metavar="SEG",
        help="Top strip segment as START:STOP or id:N",
    )
    parser.add_argument(
        "--reverse-right",
        action="store_true",
        default=False,
        help="Invert the right strip: level 0 lights its last LED instead of its first",
    )
    parser.add_argument(
        "--reverse-top",
        action="store_true",
        default=False,
        help="Invert the top strip: mirrored fill grows from the outer edges inward",
    )
    parser.add_argument(
        "--brightness",
        type=float,
        default=1.0,
        metavar="FACTOR",
        help="Scale lit LED colors (0 = black, 1 = unchanged)",
    )
    parser.add_argument(
        "--smoothing",
        type=float,
        default=0.35,
        metavar="0..1",
        help="Temporal smoothing of the levels; 0 is off, higher is smoother/slower",
    )
    parser.add_argument(
        "--noise-floor",
        type=float,
        default=1e-3,
        metavar="LEVEL",
        help=(
            "Band levels below this count as silence (keeps FFT leakage and "
            "noise floors from lighting the strips; 0 disables the gate)"
        ),
    )
    parser.add_argument("--dry-run", action="store_true", help="Do not open a serial port")
    parser.add_argument("--list-ports", action="store_true", help="List serial ports and exit")
    parser.add_argument("--quiet", action="store_true", help="Do not print periodic statistics")
    return parser.parse_args()


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------
def run(args: argparse.Namespace) -> int:
    if args.fps <= 0:
        raise ValueError("--fps must be greater than zero")
    if not 0 <= args.smoothing <= 1:
        raise ValueError("--smoothing must be between 0 and 1")
    if args.brightness < 0:
        raise ValueError("--brightness must not be negative")
    if args.noise_floor < 0:
        raise ValueError("--noise-floor must not be negative")
    if args.fft < 256:
        raise ValueError("--fft must be at least 256 samples")
    if args.rate < 8000:
        raise ValueError("--rate must be at least 8000 Hz")
    if args.color_interval < 0:
        raise ValueError("--color-interval must not be negative")
    if args.color_fade < 0:
        raise ValueError("--color-fade must not be negative")

    raise_process_priority()

    nyquist = args.rate / 2.0
    for name, (lo, hi) in (
        ("--bass-range", args.bass_range),
        ("--treble-range", args.treble_range),
    ):
        if lo >= nyquist:
            raise ValueError(f"{name} starts at {lo:g} Hz, above the Nyquist limit {nyquist:g} Hz")

    baud = getattr(args, "baud", None)
    if baud is None:
        baud = 115200 if args.protocol == "adalight" else 460800
    if baud <= 0:
        raise ValueError("--baud must be greater than zero")

    wled: AudioWledSerial | None = None
    stream: AudioStream | None = None
    sender: LatestFrameSender | None = None

    try:
        # -- segments --------------------------------------------------------
        overrides = {
            "left": args.seg_left,
            "right": args.seg_right,
            "top": args.seg_top,
        }
        strip_len: int | None = None
        if args.dry_run:
            resolved = dry_run_segments(overrides)
            strip_len = max(seg.stop for seg in resolved.values())
        else:
            port = args.port or find_serial_port()
            wled = AudioWledSerial(
                port,
                baud,
                setup_baud=not args.no_baud_setup,
                protocol=args.protocol,
            )
            payload = wled.query_info() or {}
            segments = extract_segments(payload)
            try:
                resolved = resolve_segments(segments, overrides)
            except RuntimeError:
                if any(overrides.values()):
                    # The user pointed at specific segments; never clobber them.
                    raise
                leds = payload.get("info", {}).get("leds", {})
                count = leds.get("count") if isinstance(leds, dict) else None
                if not isinstance(count, int):
                    raise RuntimeError(
                        "Segment discovery failed and WLED did not report its "
                        "LED count, so the four-segment layout cannot be created."
                    )
                print(
                    "No left/right/top segments found; creating the named "
                    "four-segment layout on WLED.",
                    file=sys.stderr,
                )
                wled.setup_four_segments(count)
                payload = wled.query_info() or {}
                segments = extract_segments(payload)
                resolved = resolve_segments(segments, overrides)

            leds = payload.get("info", {}).get("leds", {})
            count = leds.get("count") if isinstance(leds, dict) else None
            strip_len = count if isinstance(count, int) else None
            if strip_len is None:
                strip_len = max(seg.stop for seg in resolved.values())
            for label, seg in resolved.items():
                if seg.stop > strip_len:
                    print(
                        f"Warning: the {label} segment covers LEDs "
                        f"{seg.start}..{seg.stop - 1} but WLED reports only "
                        f"{strip_len} LEDs.",
                        file=sys.stderr,
                    )
            if args.protocol == "json":
                wled.freeze(list(resolved.values()))

        if not args.quiet:
            print("Audio segments:", file=sys.stderr)
            roles = {"left": "bass", "right": "treble", "top": "amplitude"}
            for label in BAND_LABELS:
                seg = resolved[label]
                print(
                    f"  {label:<5} -> {roles[label]:<9} "
                    f"(seg {seg.id}, LEDs {seg.start}..{seg.stop - 1})",
                    file=sys.stderr,
                )

        # -- audio -----------------------------------------------------------
        device = args.device or find_audio_device()
        stream = open_audio_stream(device, args.rate)
        if wled is not None:
            sender = LatestFrameSender()
        if not args.quiet:
            mode = "dry run" if args.dry_run else f"{args.protocol} serial"
            print(
                f"Audio from {stream.device} at {args.rate} Hz; streaming at up to "
                f"{args.fps:g} FPS ({mode}). Ctrl+C to stop.",
                file=sys.stderr,
            )

        window = np.hanning(args.fft)
        freqs = np.fft.rfftfreq(args.fft, 1.0 / args.rate)
        ranges = {"bass": AutoRange(), "treble": AutoRange(), "amp": AutoRange()}
        smoother = Smoother(args.smoothing)
        color_start = time.perf_counter()
        cyclers = {
            "bass": ColorCycler(
                args.bass_color or random_color(),
                args.color_interval,
                args.color_fade,
                color_start,
            ),
            "treble": ColorCycler(
                args.treble_color or random_color(),
                args.color_interval,
                args.color_fade,
                color_start,
            ),
            "amp": ColorCycler(
                args.amp_color or random_color(),
                args.color_interval,
                args.color_fade,
                color_start,
            ),
        }

        interval = 1.0 / args.fps
        deadline = time.perf_counter()
        frames = 0
        stats_start = time.perf_counter()
        last_levels = (0.0, 0.0, 0.0)

        while True:
            now = time.perf_counter()
            if now < deadline:
                time.sleep(deadline - now)
            deadline += interval
            if deadline < time.perf_counter() - interval:
                # We fell behind; do not try to catch up by bursting frames.
                deadline = time.perf_counter()

            samples = stream.read_window(args.fft)
            bass_raw, treble_raw, amp_raw = analyze(
                samples, window, freqs, args.bass_range, args.treble_range
            )
            # Silence the noise floor: FFT leakage of a loud band into a quiet
            # one must not stretch that band's min/max range to full scale.
            floor = args.noise_floor
            gate = (lambda v: v if v >= floor else 0.0) if floor > 0 else (lambda v: v)
            levels = np.array(
                [
                    ranges["bass"].update(gate(bass_raw)),
                    ranges["treble"].update(gate(treble_raw)),
                    ranges["amp"].update(gate(amp_raw)),
                ],
                dtype=np.float32,
            )
            b, t, a = (float(v) for v in smoother.update(levels))
            last_levels = (b, t, a)

            color_now = time.perf_counter()
            bass_color = scale_color(cyclers["bass"].update(color_now), args.brightness)
            treble_color = scale_color(
                cyclers["treble"].update(color_now), args.brightness
            )
            amp_color = scale_color(cyclers["amp"].update(color_now), args.brightness)

            left = fill_linear(resolved["left"].count, b, bass_color)
            right = fill_linear(resolved["right"].count, t, treble_color)
            top = fill_centered(resolved["top"].count, a, amp_color)
            # The left strip wraps around the screen, so it always fills
            # from its last LED backward (level 0 -> LED 48, not 35).
            left = left[::-1]
            if args.reverse_right:
                right = right[::-1]
            if args.reverse_top:
                top = top[::-1]

            if wled is not None and sender is not None:
                sender.check()
                if args.protocol == "adalight":
                    frame = np.zeros((strip_len, 3), dtype=np.uint8)
                    for seg, colors in (
                        (resolved["left"], left),
                        (resolved["right"], right),
                        (resolved["top"], top),
                    ):
                        end = min(seg.start + colors.shape[0], strip_len)
                        if seg.start < end:
                            frame[seg.start:end] = colors[: end - seg.start]
                    sender.send(lambda frame=frame: wled.send_colors(frame))
                else:
                    entries = [
                        (resolved["left"], left),
                        (resolved["right"], right),
                        (resolved["top"], top),
                    ]
                    sender.send(
                        lambda entries=entries: send_segments_json(wled, entries)
                    )

            frames += 1
            now = time.perf_counter()
            if not args.quiet and now - stats_start >= 2.0:
                elapsed = now - stats_start
                b_lo, b_hi = ranges["bass"].lo, ranges["bass"].hi
                t_lo, t_hi = ranges["treble"].lo, ranges["treble"].hi
                a_lo, a_hi = ranges["amp"].lo, ranges["amp"].hi
                print(
                    f"{frames / elapsed:5.1f} FPS  "
                    f"bass {b:.2f} [{b_lo:.3g}..{b_hi:.3g}]  "
                    f"treble {t:.2f} [{t_lo:.3g}..{t_hi:.3g}]  "
                    f"amp {a:.2f} [{a_lo:.3g}..{a_hi:.3g}]",
                    file=sys.stderr,
                )
                frames = 0
                stats_start = now

    except KeyboardInterrupt:
        if not args.quiet:
            b, t, a = last_levels  # type: ignore[misc]
            print(f"\nStopped (last levels: bass {b:.2f}, treble {t:.2f}, amp {a:.2f}).", file=sys.stderr)
        return 0
    except serial.SerialException as exc:
        raise RuntimeError(f"Serial connection lost: {exc}") from exc
    finally:
        if sender is not None:
            sender.close()
        if stream is not None:
            stream.close()
        if wled is not None:
            wled.close()


def print_audio_sources() -> int:
    try:
        devices = list_audio_devices()
    except RuntimeError as exc:
        print(f"Could not list audio devices: {exc}")
        return 1
    if not devices:
        print(
            "No audio devices found"
            + (
                " (is pactl installed and PulseAudio/PipeWire running?)"
                if IS_LINUX
                else "."
            )
        )
        return 1
    for device in devices:
        marker = "*" if device.monitor else " "
        detail = f"  — {device.description}" if device.description else ""
        print(f" {marker} {device.name}{detail}")
    print("\n* = loopback/monitor source (captures what the computer outputs)")
    return 0


def main() -> int:
    if sys.platform.startswith("win") and hasattr(signal, "SIGBREAK"):
        # main.py stops the script with CTRL_BREAK_EVENT; turn it into the
        # same KeyboardInterrupt path as Ctrl+C so serial cleanup runs.
        signal.signal(signal.SIGBREAK, signal.default_int_handler)
    args = parse_args()
    if args.list_ports:
        print_serial_ports()
        return 0
    if args.list_audio:
        return print_audio_sources()
    try:
        return run(args) or 0
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
