#!/usr/bin/env python3
"""Screen-edge ambilight for WLED over the USB serial JSON API.

The LED strip is sampled counter-clockwise, starting at the bottom-right:

    right edge   LEDs  0..13  (bottom -> top, 14)
    top edge     LEDs 14..34  (right -> left, 21)
    left edge    LEDs 35..48  (top -> bottom, 14)
    bottom edge  LEDs 49..60  (left -> right, 12)

The script captures the selected screen at up to 20 FPS, averages a strip of
pixels around each LED position, smooths the result, and sends one JSON frame
over serial. WLED's serial JSON API is used directly (no HTTP required).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import secrets
import select
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import serial
from serial.tools import list_ports

try:
    from dbus_fast import BusType, MessageType, Variant
    from dbus_fast.aio import MessageBus
except ImportError:  # pragma: no cover - optional Wayland backend
    BusType = MessageType = Variant = MessageBus = None

try:
    from mss import MSS
except ImportError:  # pragma: no cover - handled with a friendly message
    MSS = None

try:
    from PIL import Image
except ImportError:  # pragma: no cover
    Image = None


# ---------------------------------------------------------------------------
# LED layout. These are the ranges from the strip installation.
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class Edge:
    name: str
    first_led: int
    count: int


EDGES = (
    Edge("right", 0, 14),
    Edge("top", 14, 21),
    Edge("left", 35, 14),
    Edge("bottom", 49, 12),
)
LED_COUNT = sum(edge.count for edge in EDGES)  # 61

# Direction of each edge as seen from the screen, following the index order:
#   right: bottom -> top
#   top: right -> left
#   left: top -> bottom
#   bottom: left -> right


# WLED serial baud change command bytes (temporary, until reboot).
BAUD_COMMANDS = {
    230400: 0xB1,
    460800: 0xB2,
    500000: 0xB3,
    576000: 0xB4,
    921600: 0xB5,
    1000000: 0xB6,
    1500000: 0xB7,
}

USB_SERIAL_VIDS = {
    0x0403,  # FTDI
    0x0483,  # STMicroelectronics
    0x10C4,  # Silicon Labs CP210x
    0x1A86,  # WCH CH340/CH341
    0x1B4F,  # SparkFun
    0x2341,  # Arduino
    0x239A,  # Adafruit
    0x2E8A,  # Raspberry Pi
    0x303A,  # Espressif native USB
}


# ---------------------------------------------------------------------------
# Layout helpers
# ---------------------------------------------------------------------------
def validate_layout() -> None:
    expected = 0
    for edge in EDGES:
        if edge.first_led != expected:
            raise ValueError(
                f"LED layout is not contiguous: {edge.name} starts at "
                f"{edge.first_led}, expected {expected}"
            )
        expected += edge.count
    if expected != LED_COUNT:
        raise ValueError("LED layout count mismatch")


def build_edge_boxes(width: int, height: int, depth_percent: float) -> list[tuple[int, int, int, int]]:
    """Return one (left, top, right, bottom) sampling box per LED.

    The boxes are ordered by WLED index. Each edge is divided evenly between its
    LEDs, and the sampling depth follows the screen edge inward.
    """
    if width <= 0 or height <= 0:
        raise ValueError("Screen has no pixels")

    depth = max(1, round(min(width, height) * depth_percent / 100.0))
    depth = min(depth, max(1, width // 2), max(1, height // 2))

    boxes: list[tuple[int, int, int, int]] = []
    for edge in EDGES:
        for i in range(edge.count):
            if edge.name == "right":
                # LED 0 is at the bottom-right, going upward.
                y0 = height - round((i + 1) * height / edge.count)
                y1 = height - round(i * height / edge.count)
                box = (width - depth, y0, width, y1)
            elif edge.name == "top":
                # LED 14 is at the top-right, going left.
                x0 = width - round((i + 1) * width / edge.count)
                x1 = width - round(i * width / edge.count)
                box = (x0, 0, x1, depth)
            elif edge.name == "left":
                # LED 35 is at the top-left, going down.
                y0 = round(i * height / edge.count)
                y1 = round((i + 1) * height / edge.count)
                box = (0, y0, depth, y1)
            elif edge.name == "bottom":
                # LED 49 is at the bottom-left, going right.
                x0 = round(i * width / edge.count)
                x1 = round((i + 1) * width / edge.count)
                box = (x0, height - depth, x1, height)
            else:  # pragma: no cover - guarded by the fixed layout above
                raise ValueError(f"Unknown edge: {edge.name}")

            left, top, right, bottom = box
            boxes.append(
                (
                    max(0, min(width - 1, left)),
                    max(0, min(height - 1, top)),
                    max(1, min(width, right)),
                    max(1, min(height, bottom)),
                )
            )
    return boxes


def edge_colors_bgr(frame: np.ndarray, boxes: list[tuple[int, int, int, int]]) -> np.ndarray:
    """Average each box in a BGR frame and return an (N, 3) RGB array."""
    colors = np.empty((len(boxes), 3), dtype=np.float32)
    for i, (x0, y0, x1, y1) in enumerate(boxes):
        region = frame[y0:y1, x0:x1, :3]
        if region.size == 0:
            colors[i] = 0.0
            continue
        b, g, r = region.mean(axis=(0, 1), dtype=np.float32)
        colors[i] = (r, g, b)
    return colors


# ---------------------------------------------------------------------------
# Screen capture
# ---------------------------------------------------------------------------
def select_monitor(monitors: list[dict], monitor_index: int | None) -> dict:
    if len(monitors) < 2:
        raise RuntimeError("No screen monitor found")
    if monitor_index is None:
        return dict(next((m for m in monitors[1:] if m.get("is_primary")), monitors[1]))
    if monitor_index < 1 or monitor_index >= len(monitors):
        raise RuntimeError(
            f"--monitor {monitor_index} is invalid; available monitors: "
            f"1..{len(monitors) - 1}"
        )
    return dict(monitors[monitor_index])


class MssCapture:
    """Fast cross-platform capture (X11, Windows, macOS)."""

    def __init__(self, monitor_index: int | None):
        if MSS is None:
            raise RuntimeError("mss is not installed; run: pip install -r requirements.txt")
        self._mss = MSS()
        self.monitor = select_monitor(self._mss.monitors, monitor_index)

    def grab(self) -> np.ndarray:
        shot = self._mss.grab(self.monitor)
        # mss returns BGRA; the first three channels are in BGR order.
        return np.asarray(shot)[:, :, :3]

    def close(self) -> None:
        self._mss.close()


class SpectacleCapture:
    """KDE Plasma Wayland fallback using the Spectacle CLI.

    Spectacle captures the whole desktop; mss is used only to look up monitor
    geometry, then the selected monitor is cropped out of the screenshot.  This
    is slower than mss and cannot promise 20 FPS; use an X11 session for
    full-rate capture when possible.
    """

    def __init__(self, monitor_index: int | None):
        if Image is None:
            raise RuntimeError("Pillow is required for the Spectacle backend")
        if MSS is None:
            raise RuntimeError("mss is required to look up monitor geometry")
        self.spectacle = shutil.which("spectacle")
        if not self.spectacle:
            raise RuntimeError("spectacle was not found in PATH")

        with MSS() as sct:
            self.desktop = dict(sct.monitors[0])
            self.monitor = select_monitor(sct.monitors, monitor_index)
        self.path = Path(tempfile.gettempdir()) / f"wled-ambient-{os.getpid()}.png"

    def grab(self) -> np.ndarray:
        self.path.unlink(missing_ok=True)
        try:
            proc = subprocess.run(
                [self.spectacle, "-b", "-n", "-f", "-o", str(self.path)],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                timeout=5,
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            raise RuntimeError("Spectacle timed out while taking a screenshot") from exc

        if not self.path.exists():
            detail = proc.stderr.decode(errors="replace").strip()
            raise RuntimeError(
                "Spectacle did not produce a screenshot"
                + (f": {detail}" if detail else "")
            )

        try:
            with Image.open(self.path) as image:
                rgb = np.asarray(image.convert("RGB"))
        finally:
            self.path.unlink(missing_ok=True)

        height, width = rgb.shape[:2]
        desktop_w = int(self.desktop["width"])
        desktop_h = int(self.desktop["height"])
        target_w = int(self.monitor["width"])
        target_h = int(self.monitor["height"])
        if (width, height) == (desktop_w, desktop_h):
            x = int(self.monitor["left"] - self.desktop["left"])
            y = int(self.monitor["top"] - self.desktop["top"])
            rgb = rgb[y : y + target_h, x : x + target_w]
        elif (width, height) != (target_w, target_h):
            raise RuntimeError(
                f"Spectacle returned {width}x{height}; expected "
                f"{desktop_w}x{desktop_h} (whole screen) or "
                f"{target_w}x{target_h} (selected monitor)."
            )

        # Convert RGB to BGR so both capture backends share the sampler.
        return np.ascontiguousarray(rgb[:, :, ::-1])

    def close(self) -> None:
        self.path.unlink(missing_ok=True)


PORTAL_BUS = "org.freedesktop.portal.Desktop"
PORTAL_PATH = "/org/freedesktop/portal/desktop"
PORTAL_SCREENCAST = "org.freedesktop.portal.ScreenCast"
PORTAL_REQUEST = "org.freedesktop.portal.Request"
PORTAL_SESSION = "org.freedesktop.portal.Session"


class PortalCapture:
    """Wayland capture through xdg-desktop-portal + PipeWire/GStreamer.

    The portal asks the desktop for a monitor stream (the first run may show a
    screen-sharing permission dialog). The actual frames are read from
    gst-launch-1.0 as packed BGR data. A restore token is saved so subsequent
    launches can reuse the same selection without asking again.
    """

    def __init__(self, fps: float, max_width: int = 640):
        if MessageBus is None:
            raise RuntimeError(
                "dbus-fast is not installed; run: pip install -r requirements.txt"
            )
        if not shutil.which("gst-launch-1.0"):
            raise RuntimeError(
                "gst-launch-1.0 is not installed. On Debian/Ubuntu/Kali install: "
                "sudo apt install gstreamer1.0-tools gstreamer1.0-pipewire"
            )

        self._loop = asyncio.new_event_loop()
        self._thread = threading.Thread(target=self._run_event_loop, daemon=True)
        self._thread.start()
        self._bus = None
        self._session = None
        self._session_iface = None
        self._sender = ""
        self._pending: dict[str, asyncio.Future] = {}
        self._responses: dict[str, list] = {}
        self._gst: subprocess.Popen | None = None
        self._gst_err = None
        self._frame_shape: tuple[int, int] | None = None
        self._closed = False

        try:
            node_id, width, height = self._call(self._async_setup(), timeout=300)
            out_w, out_h = self._target_size(width, height, max_width)
            self._start_gst(node_id, out_w, out_h, fps)
        except BaseException:
            self.close()
            raise

    # -- small synchronous wrapper around the background asyncio loop --------
    def _run_event_loop(self) -> None:
        asyncio.set_event_loop(self._loop)
        self._loop.run_forever()

    def _call(self, coroutine, timeout: float):
        future = asyncio.run_coroutine_threadsafe(coroutine, self._loop)
        try:
            return future.result(timeout=timeout)
        except TimeoutError:
            future.cancel()
            raise RuntimeError("Timed out while waiting for the desktop portal")

    # -- portal screen-cast session -----------------------------------------
    async def _async_setup(self) -> tuple[int, int, int]:
        bus = await MessageBus(bus_type=BusType.SESSION).connect()
        self._bus = bus
        introspection = await bus.introspect(PORTAL_BUS, PORTAL_PATH)
        obj = bus.get_proxy_object(PORTAL_BUS, PORTAL_PATH, introspection)
        iface = obj.get_interface(PORTAL_SCREENCAST)
        self._sender = bus.unique_name[1:].replace(".", "_")

        def on_response(message) -> bool:
            if (
                message.message_type == MessageType.SIGNAL
                and message.interface == PORTAL_REQUEST
                and message.member == "Response"
            ):
                future = self._pending.get(message.path)
                if future is not None and not future.done():
                    future.set_result(message.body)
                else:
                    self._responses[message.path] = message.body
            return False

        bus.add_message_handler(on_response)

        restore_token = self._load_token()
        for attempt in range(2):
            token = restore_token if attempt == 0 else None
            session = await self._create_session(iface)
            try:
                await self._select_sources(iface, session, token)
            except RuntimeError:
                await self._close_session_path(session)
                if token:
                    self._clear_token()
                    continue
                raise

            try:
                results = await self._start(iface, session)
            except BaseException:
                await self._close_session_path(session)
                raise

            self._session = session
            session_intro = await bus.introspect(PORTAL_BUS, session)
            session_obj = bus.get_proxy_object(PORTAL_BUS, session, session_intro)
            self._session_iface = session_obj.get_interface(PORTAL_SESSION)

            new_token = results.get("restore_token")
            if new_token is not None:
                self._save_token(self._value(new_token))
            streams = self._value(results.get("streams", []))
            if not streams:
                raise RuntimeError("The screen-cast portal did not provide a stream")
            node_id, props = streams[0]
            props = {key: self._value(value) for key, value in props.items()}
            width, height = props.get("size", (1920, 1080))
            return int(node_id), int(width), int(height)

        raise RuntimeError("Could not create a screen-cast session")

    async def _request(self, token: str, call):
        path = f"/org/freedesktop/portal/desktop/request/{self._sender}/{token}"
        future = self._loop.create_future()
        self._pending[path] = future
        returned = None
        try:
            returned = await call
            if returned != path:
                if returned in self._responses:
                    future.set_result(self._responses.pop(returned))
                else:
                    self._pending[returned] = future
            if path in self._responses:
                future.set_result(self._responses.pop(path))
            body = await asyncio.wait_for(future, timeout=300)
        except TimeoutError as exc:
            raise RuntimeError("Timed out waiting for the desktop portal") from exc
        finally:
            self._pending.pop(path, None)
            if returned:
                self._pending.pop(returned, None)

        response_code = int(body[0])
        results = body[1] if len(body) > 1 else {}
        if response_code != 0:
            if response_code == 1:
                raise RuntimeError("Screen sharing was cancelled")
            raise RuntimeError(f"The desktop portal returned error code {response_code}")
        return results

    @staticmethod
    def _value(value):
        return value.value if isinstance(value, Variant) else value

    def _token(self, label: str) -> str:
        return f"wled_{label}_{secrets.token_hex(4)}"

    async def _create_session(self, iface) -> str:
        token = self._token("create")
        results = await self._request(
            token,
            iface.call_create_session(
                {
                    "handle_token": Variant("s", token),
                    "session_handle_token": Variant("s", token),
                }
            ),
        )
        session = self._value(results.get("session_handle"))
        if not session:
            raise RuntimeError("The desktop portal did not return a session handle")
        return str(session)

    async def _select_sources(self, iface, session: str, restore_token: str | None) -> None:
        token = self._token("select")
        options = {
            "handle_token": Variant("s", token),
            "types": Variant("u", 1),  # 1 = monitors
            "multiple": Variant("b", False),
            "persist_mode": Variant("u", 2),  # persistent while possible
        }
        if restore_token:
            options["restore_token"] = Variant("s", restore_token)
        await self._request(token, iface.call_select_sources(session, options))

    async def _start(self, iface, session: str) -> dict:
        token = self._token("start")
        return await self._request(
            token,
            iface.call_start(
                session,
                "",
                {"handle_token": Variant("s", token)},
            ),
        )

    async def _close_session_path(self, session: str) -> None:
        if not self._bus:
            return
        try:
            introspection = await self._bus.introspect(PORTAL_BUS, session)
            obj = self._bus.get_proxy_object(PORTAL_BUS, session, introspection)
            iface = obj.get_interface(PORTAL_SESSION)
            await iface.call_close()
        except Exception:
            pass

    async def _shutdown(self) -> None:
        if self._session_iface is not None:
            try:
                await self._session_iface.call_close()
            except Exception:
                pass
        if self._bus is not None:
            try:
                self._bus.disconnect()
            except Exception:
                pass

    # -- restore token --------------------------------------------------------
    @staticmethod
    def _token_path() -> Path:
        base = os.environ.get("XDG_CACHE_HOME")
        if not base:
            base = str(Path.home() / ".cache")
        return Path(base) / "wled-ambient" / "portal-restore-token"

    def _load_token(self) -> str | None:
        try:
            token = self._token_path().read_text(encoding="utf-8").strip()
        except OSError:
            return None
        return token or None

    def _save_token(self, token: str) -> None:
        if not token:
            return
        path = self._token_path()
        try:
            path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            tmp = path.with_name(path.name + ".tmp")
            tmp.write_text(token, encoding="utf-8")
            os.chmod(tmp, 0o600)
            tmp.replace(path)
        except OSError:
            pass

    def _clear_token(self) -> None:
        try:
            self._token_path().unlink(missing_ok=True)
        except OSError:
            pass

    # -- GStreamer frame reader ----------------------------------------------
    @staticmethod
    def _target_size(width: int, height: int, max_width: int) -> tuple[int, int]:
        if width <= 0 or height <= 0:
            width, height = 1920, 1080
        scale = min(1.0, max_width / max(width, height))
        out_w = max(4, int(width * scale))
        out_h = max(4, int(height * scale))
        # Keep the row stride straightforward and the data cheap to process.
        out_w -= out_w % 4
        out_h -= out_h % 2
        return max(4, out_w), max(4, out_h)

    def _start_gst(self, node_id: int, width: int, height: int, fps: float) -> None:
        fps_fraction = f"{max(1, round(fps * 1000))}/1000"
        pipeline = [
            "gst-launch-1.0",
            "-q",
            "pipewiresrc",
            f"path={node_id}",
            "!",
            "videorate",
            "!",
            f"video/x-raw,framerate={fps_fraction}",
            "!",
            "videoconvert",
            "!",
            "videoscale",
            "!",
            f"video/x-raw,format=BGR,width={width},height={height}",
            "!",
            "fdsink",
            "fd=1",
            "sync=false",
        ]
        self._frame_shape = (height, width)
        self._gst_err = tempfile.TemporaryFile()
        self._gst = subprocess.Popen(
            pipeline,
            stdout=subprocess.PIPE,
            stderr=self._gst_err,
            bufsize=0,
        )

    def _gst_error_text(self) -> str:
        if self._gst_err is None:
            return ""
        try:
            self._gst_err.seek(0)
            return self._gst_err.read().decode(errors="replace").strip()
        except OSError:
            return ""

    def grab(self) -> np.ndarray:
        if self._gst is None or self._gst.stdout is None or self._frame_shape is None:
            raise RuntimeError("Portal capture is not running")
        if self._gst.poll() is not None:
            detail = self._gst_error_text()
            raise RuntimeError("gst-launch-1.0 stopped unexpectedly" + (f": {detail}" if detail else ""))

        height, width = self._frame_shape
        size = width * height * 3
        fd = self._gst.stdout.fileno()
        buffer = bytearray()
        deadline = time.monotonic() + 5.0
        while len(buffer) < size:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise RuntimeError("Timed out waiting for a PipeWire video frame")
            ready, _, _ = select.select([fd], [], [], remaining)
            if not ready:
                raise RuntimeError("Timed out waiting for a PipeWire video frame")
            chunk = os.read(fd, min(1 << 20, size - len(buffer)))
            if not chunk:
                detail = self._gst_error_text()
                raise RuntimeError(
                    "PipeWire video stream ended" + (f": {detail}" if detail else "")
                )
            buffer.extend(chunk)
        return np.frombuffer(buffer, dtype=np.uint8).reshape(height, width, 3)

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True

        if self._gst is not None:
            if self._gst.poll() is None:
                self._gst.terminate()
                try:
                    self._gst.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    self._gst.kill()
            if self._gst.stdout is not None:
                self._gst.stdout.close()
            if self._gst_err is not None:
                self._gst_err.close()

        if self._loop.is_running():
            try:
                self._call(self._shutdown(), timeout=5)
            except Exception:
                pass
            self._loop.call_soon_threadsafe(self._loop.stop)
            self._thread.join(timeout=2)
        if not self._loop.is_closed():
            self._loop.close()


def resolve_capture_mode(requested: str) -> str:
    if requested != "auto":
        return requested

    if sys.platform.startswith("linux") and os.environ.get("XDG_SESSION_TYPE", "").lower() == "wayland":
        if MessageBus is not None and shutil.which("gst-launch-1.0"):
            return "portal"
        desktop = os.environ.get("XDG_CURRENT_DESKTOP", "").upper()
        if "KDE" in desktop and shutil.which("spectacle"):
            print(
                "Wayland portal capture is unavailable; using the slower Spectacle "
                "fallback. Install gstreamer1.0-tools, gstreamer1.0-pipewire and "
                "dbus-fast for full-rate capture.",
                file=sys.stderr,
            )
            return "spectacle"
        print(
            "Warning: Wayland screen capture can return black frames with mss. "
            "Use --capture portal after installing its dependencies.",
            file=sys.stderr,
        )
    return "mss"


def make_capture(mode: str, monitor_index: int | None, fps: float):
    if mode == "mss":
        return MssCapture(monitor_index)
    if mode == "spectacle":
        return SpectacleCapture(monitor_index)
    if mode == "portal":
        return PortalCapture(fps)
    raise ValueError(f"Unknown capture backend: {mode}")


# ---------------------------------------------------------------------------
# Serial / WLED
# ---------------------------------------------------------------------------
def describe_port(port) -> str:
    vid_pid = ""
    if port.vid is not None and port.pid is not None:
        vid_pid = f" [{port.vid:04x}:{port.pid:04x}]"
    return f"{port.device}{vid_pid} — {port.description or 'serial device'}"


def find_serial_port() -> str:
    ports = list(list_ports.comports())
    if not ports:
        raise RuntimeError("No serial ports found. Connect the WLED controller and try again.")

    likely = [p for p in ports if p.vid in USB_SERIAL_VIDS]
    if len(likely) == 1:
        return likely[0].device
    if not likely and len(ports) == 1:
        return ports[0].device

    listing = "\n".join(f"  {describe_port(p)}" for p in ports)
    raise RuntimeError(
        "Could not choose a serial port automatically. Use --port.\n"
        f"Available ports:\n{listing}"
    )


def print_serial_ports() -> None:
    ports = list(list_ports.comports())
    if not ports:
        print("No serial ports found.")
        return
    for port in ports:
        print(describe_port(port))


@dataclass
class WledSerial:
    port: str
    baudrate: int
    setup_baud: bool = True

    def __post_init__(self) -> None:
        self.serial: serial.Serial | None = None
        self._open()

    def _open(self) -> None:
        try:
            ser = serial.Serial(
                port=self.port,
                baudrate=115200 if self.setup_baud else self.baudrate,
                timeout=0,
                write_timeout=1,
            )
        except serial.SerialException as exc:
            raise RuntimeError(
                f"Could not open serial port {self.port}: {exc}. "
                "Close any serial monitor using the port and check permissions."
            ) from exc
        self.serial = ser

        if not self.setup_baud or self.baudrate == 115200:
            time.sleep(0.15)
            self._drain()
            self._send_setup()
            return

        command = BAUD_COMMANDS.get(self.baudrate)
        if command is None:
            ser.close()
            supported = ", ".join(str(value) for value in (115200, *BAUD_COMMANDS))
            raise RuntimeError(f"Unsupported serial baud rate {self.baudrate}; use one of {supported}")

        # Find WLED at the boot/default baud first. A board that resets when the
        # serial port opens needs a moment before it can answer.
        found = self._wait_for_wled(2.0)
        ser.write(bytes([command]))
        ser.flush()
        time.sleep(0.25)

        # If WLED was already at the requested rate, the command cannot be
        # parsed at 115200; reopening at the requested rate will then work.
        try:
            ser.baudrate = self.baudrate
        except (serial.SerialException, ValueError):
            pass
        time.sleep(0.1)
        self._drain()

        if found:
            print(f"WLED found on {self.port}; serial baud {self.baudrate}.", file=sys.stderr)
        else:
            print(
                f"No WLED version reply at 115200. Assuming {self.port} is ready at "
                f"{self.baudrate} baud.",
                file=sys.stderr,
            )
        self._send_setup()

    def _wait_for_wled(self, timeout: float) -> bool:
        ser = self._require_serial()
        deadline = time.monotonic() + timeout
        reply = bytearray()
        while time.monotonic() < deadline:
            try:
                ser.write(b"v\n")
                ser.flush()
            except serial.SerialException:
                return False
            time.sleep(0.1)
            if ser.in_waiting:
                reply.extend(ser.read(ser.in_waiting))
            if b"WLED" in reply:
                return True
            time.sleep(0.1)
        return False

    def _drain(self) -> None:
        ser = self.serial
        if ser is not None and ser.in_waiting:
            try:
                ser.read(ser.in_waiting)
            except serial.SerialException:
                pass

    def _send_setup(self) -> None:
        setup = {
            "on": True,
            "bri": 255,
            "transition": 0,
            "seg": [
                {
                    "id": 0,
                    "start": 0,
                    "stop": LED_COUNT,
                    "frz": True,
                }
            ],
        }
        self.send(json.dumps(setup, separators=(",", ":")) + "\n")
        time.sleep(0.05)

    def _require_serial(self) -> serial.Serial:
        if self.serial is None:
            raise RuntimeError("Serial port is not open")
        return self.serial

    def send(self, payload: str) -> None:
        ser = self._require_serial()
        data = payload.encode("ascii")
        try:
            written = ser.write(data)
        except serial.SerialTimeoutException as exc:
            raise RuntimeError(
                "Serial write timed out. Reduce --fps or increase --baud."
            ) from exc
        if written != len(data):
            raise RuntimeError(f"Only wrote {written} of {len(data)} bytes to serial")
        # WLED may emit a little debug/status text; never let it fill the OS buffer.
        self._drain()

    def send_colors(self, colors: np.ndarray) -> None:
        hex_colors = ",".join(
            f'"{int(r):02x}{int(g):02x}{int(b):02x}"' for r, g, b in colors
        )
        self.send(f'{{"seg":[{{"id":0,"i":[{hex_colors}]}}]}}\n')

    def close(self) -> None:
        if self.serial is not None:
            try:
                self.serial.close()
            finally:
                self.serial = None


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------
def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Send screen-edge ambilight colors to WLED over serial JSON.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("--port", help="Serial port, e.g. /dev/ttyUSB0 or COM5")
    parser.add_argument(
        "--baud",
        type=int,
        default=460800,
        help="Serial baud. The script temporarily switches WLED to this rate unless --no-baud-setup is used.",
    )
    parser.add_argument(
        "--no-baud-setup",
        action="store_true",
        help="Do not send WLED's temporary baud-change command; open the port at --baud directly.",
    )
    parser.add_argument("--fps", type=float, default=20.0, help="Maximum frames per second")
    parser.add_argument(
        "--monitor",
        type=int,
        default=None,
        help="mss monitor index (1 = first monitor). Portal capture uses the monitor chosen in the screen-sharing dialog.",
    )
    parser.add_argument(
        "--edge-depth",
        type=float,
        default=6.0,
        metavar="PERCENT",
        help="How far inward from each screen edge to sample",
    )
    parser.add_argument(
        "--brightness",
        type=float,
        default=1.0,
        metavar="FACTOR",
        help="Scale LED colors (0 = black, 1 = unchanged)",
    )
    parser.add_argument(
        "--smoothing",
        type=float,
        default=0.35,
        metavar="0..1",
        help="Temporal smoothing; 0 is off, higher is smoother/slower",
    )
    parser.add_argument(
        "--capture",
        choices=("auto", "portal", "mss", "spectacle"),
        default="auto",
        help="Screen capture backend. auto uses portal on Wayland and mss elsewhere.",
    )
    parser.add_argument("--dry-run", action="store_true", help="Do not open a serial port")
    parser.add_argument("--list-ports", action="store_true", help="List serial ports and exit")
    parser.add_argument("--quiet", action="store_true", help="Do not print periodic statistics")
    return parser.parse_args()


class Smoother:
    def __init__(self, factor: float):
        self.factor = factor
        self.value: np.ndarray | None = None

    def update(self, current: np.ndarray) -> np.ndarray:
        if self.value is None or self.factor <= 0:
            self.value = current.copy()
        else:
            self.value += (current - self.value) * self.factor
        return self.value


def run(args: argparse.Namespace) -> int:
    if args.fps <= 0:
        raise ValueError("--fps must be greater than zero")
    if not 0 <= args.smoothing <= 1:
        raise ValueError("--smoothing must be between 0 and 1")
    if args.brightness < 0:
        raise ValueError("--brightness must not be negative")
    if args.edge_depth <= 0:
        raise ValueError("--edge-depth must be greater than zero")

    validate_layout()

    capture = None
    wled: WledSerial | None = None
    capture_mode = args.capture
    run_start = time.perf_counter()

    try:
        capture_mode = resolve_capture_mode(args.capture)
        capture = make_capture(capture_mode, args.monitor, args.fps)

        if not args.dry_run:
            port = args.port or find_serial_port()
            wled = WledSerial(port, args.baud, setup_baud=not args.no_baud_setup)

        smoother = Smoother(args.smoothing)
        boxes: list[tuple[int, int, int, int]] | None = None
        frame_size: tuple[int, int] | None = None

        interval = 1.0 / args.fps
        deadline = time.perf_counter()
        frames = 0
        stats_start = time.perf_counter()

        if not args.quiet:
            mode = "dry run" if args.dry_run else f"serial {args.port or 'auto'}"
            print(
                f"Streaming {LED_COUNT} LEDs at up to {args.fps:g} FPS "
                f"({capture_mode} capture, {mode}). Ctrl+C to stop.",
                file=sys.stderr,
            )

        while True:
            now = time.perf_counter()
            if now < deadline:
                time.sleep(deadline - now)
            deadline += interval
            if deadline < time.perf_counter() - interval:
                # We fell behind; do not try to catch up by bursting frames.
                deadline = time.perf_counter()

            frame = capture.grab()
            height, width = frame.shape[:2]
            if (width, height) != frame_size:
                boxes = build_edge_boxes(width, height, args.edge_depth)
                frame_size = (width, height)

            raw_colors = edge_colors_bgr(frame, boxes)  # type: ignore[arg-type]
            colors = smoother.update(raw_colors)
            output = np.clip(colors * args.brightness, 0, 255).astype(np.uint8)

            if wled is not None:
                wled.send_colors(output)

            frames += 1
            now = time.perf_counter()
            if not args.quiet and now - stats_start >= 2.0:
                elapsed = now - stats_start
                print(
                    f"{frames / elapsed:5.1f} FPS  "
                    f"({width}x{height}, {capture_mode})",
                    file=sys.stderr,
                )
                frames = 0
                stats_start = now

    except KeyboardInterrupt:
        if not args.quiet:
            total = time.perf_counter() - run_start
            print(f"\nStopped after {total:.1f}s.", file=sys.stderr)
        return 0
    except serial.SerialException as exc:
        raise RuntimeError(f"Serial connection lost: {exc}") from exc
    finally:
        if capture is not None:
            capture.close()
        if wled is not None:
            wled.close()


def main() -> int:
    args = parse_args()
    if args.list_ports:
        print_serial_ports()
        return 0
    try:
        return run(args)
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
