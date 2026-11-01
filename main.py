#!/usr/bin/env python3
"""Platform-independent launcher for the WLED helper scripts.

The launcher does three things:

1. Detects the operating system, checks the modules needed by that platform,
   and (only if they are missing) creates a local ``.venv`` and installs the
   matching ``requirements-<os>.txt`` file.
2. Starts the audio-reactive script while YouTube Music is open in a browser
   window, and the screen-ambilight script otherwise. The ambilight script
   defaults to the primary/main display.
3. Keeps watching the browser window titles and switches scripts when YouTube
   Music opens or closes.

Only the Python standard library is used until the virtual environment has
been prepared, so this file itself needs no dependencies.
"""

from __future__ import annotations

import argparse
import importlib.util
import os
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
VENV_DIR = BASE_DIR / ".venv"
AUDIO_SCRIPT = BASE_DIR / "wled_audio.py"
AMBIENT_SCRIPT = BASE_DIR / "wled_ambient.py"

IS_LINUX = sys.platform.startswith("linux")
IS_WINDOWS = sys.platform.startswith("win")
IS_MACOS = sys.platform == "darwin"
PLATFORM_NAME = (
    "Windows"
    if IS_WINDOWS
    else "macOS"
    if IS_MACOS
    else "Linux"
    if IS_LINUX
    else sys.platform
)

# Import names, not pip package names. The requirements file supplies the
# corresponding distributions.
COMMON_MODULES = ("numpy", "serial", "mss", "PIL", "soundcard")
LINUX_MODULES = ("dbus_fast",)

YOUTUBE_MUSIC_HINTS = ("youtube music", "music.youtube.com")

_warned_detection = False


# ---------------------------------------------------------------------------
# Dependencies
# ---------------------------------------------------------------------------
def required_modules() -> tuple[str, ...]:
    if IS_LINUX:
        return COMMON_MODULES + LINUX_MODULES
    return COMMON_MODULES


def requirements_path() -> Path:
    if IS_LINUX:
        return BASE_DIR / "requirements-linux.txt"
    if IS_WINDOWS:
        return BASE_DIR / "requirements-windows.txt"
    if IS_MACOS:
        return BASE_DIR / "requirements-macos.txt"
    return BASE_DIR / "requirements.txt"


def venv_python() -> Path:
    if IS_WINDOWS:
        return VENV_DIR / "Scripts" / "python.exe"
    return VENV_DIR / "bin" / "python"


def missing_modules() -> list[str]:
    missing = []
    for module in required_modules():
        try:
            if importlib.util.find_spec(module) is None:
                missing.append(module)
        except (ImportError, ValueError):
            missing.append(module)
    return missing


def _install_requirements(python: Path) -> None:
    requirements = requirements_path()
    if not requirements.exists():
        raise RuntimeError(f"Requirements file not found: {requirements}")
    print(f"[main] Installing {requirements.name} into {VENV_DIR} ...", flush=True)
    subprocess.run(
        [
            str(python),
            "-m",
            "pip",
            "install",
            "--disable-pip-version-check",
            "--upgrade",
            "pip",
        ],
        cwd=str(BASE_DIR),
        check=False,
    )
    subprocess.run(
        [
            str(python),
            "-m",
            "pip",
            "install",
            "--disable-pip-version-check",
            "-r",
            str(requirements),
        ],
        cwd=str(BASE_DIR),
        check=True,
    )


def ensure_environment() -> None:
    """Prepare a local venv when the current interpreter lacks dependencies."""
    missing = missing_modules()
    if not missing:
        return

    print(
        f"[main] Missing modules on {PLATFORM_NAME}: {', '.join(missing)}",
        flush=True,
    )
    python = venv_python()
    if not python.exists():
        print(f"[main] Creating {VENV_DIR} ...", flush=True)
        subprocess.run(
            [sys.executable, "-m", "venv", str(VENV_DIR)],
            check=True,
        )

    _install_requirements(python)

    try:
        same_interpreter = Path(sys.executable).resolve() == python.resolve()
    except OSError:
        same_interpreter = False

    if same_interpreter:
        if missing_modules():
            raise RuntimeError(
                "Dependencies are still missing after installation. "
                "Check the pip output above."
            )
        return

    if os.environ.get("WLED_MAIN_BOOTSTRAPPED") == "1":
        raise RuntimeError(
            "Dependencies are still missing after bootstrapping. "
            "Check the pip output above."
        )
    os.environ["WLED_MAIN_BOOTSTRAPPED"] = "1"
    print(f"[main] Restarting with {python} ...", flush=True)
    sys.stdout.flush()
    sys.stderr.flush()
    try:
        os.execv(str(python), [str(python), str(Path(__file__).resolve()), *sys.argv[1:]])
    except OSError:
        result = subprocess.call(
            [str(python), str(Path(__file__).resolve()), *sys.argv[1:]],
            cwd=str(BASE_DIR),
        )
        raise SystemExit(result)


# ---------------------------------------------------------------------------
# YouTube Music detection (window titles)
# ---------------------------------------------------------------------------
def _windows_window_titles() -> list[str]:
    import ctypes
    from ctypes import wintypes

    user32 = ctypes.WinDLL("user32", use_last_error=True)
    enum_proc = ctypes.WINFUNCTYPE(
        wintypes.BOOL, wintypes.HWND, wintypes.LPARAM
    )
    user32.IsWindowVisible.argtypes = [wintypes.HWND]
    user32.IsWindowVisible.restype = wintypes.BOOL
    user32.GetWindowTextLengthW.argtypes = [wintypes.HWND]
    user32.GetWindowTextLengthW.restype = ctypes.c_int
    user32.GetWindowTextW.argtypes = [
        wintypes.HWND,
        wintypes.LPWSTR,
        ctypes.c_int,
    ]
    user32.GetWindowTextW.restype = ctypes.c_int

    titles: list[str] = []

    def callback(hwnd, _lparam) -> bool:
        if not user32.IsWindowVisible(hwnd):
            return True
        length = user32.GetWindowTextLengthW(hwnd)
        if length <= 0:
            return True
        buffer = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, buffer, length + 1)
        if buffer.value:
            titles.append(buffer.value)
        return True

    user32.EnumWindows(enum_proc(callback), 0)
    return titles


_MACOS_WINDOW_SCRIPT = """
tell application "System Events"
    set output to ""
    repeat with proc in (every application process whose background only is false)
        try
            repeat with win in windows of proc
                set output to output & (name of win) & linefeed
            end repeat
        end try
    end repeat
    return output
end tell
"""


def _macos_window_titles() -> list[str]:
    global _warned_detection
    if shutil.which("osascript") is None:
        return []
    proc = subprocess.run(
        ["osascript", "-e", _MACOS_WINDOW_SCRIPT],
        capture_output=True,
        text=True,
        timeout=8,
    )
    if proc.returncode != 0:
        if not _warned_detection:
            detail = proc.stderr.strip().splitlines()
            reason = detail[-1] if detail else "osascript failed"
            print(
                f"[main] Could not read macOS window titles ({reason}). "
                "Allow Accessibility access for your terminal to enable "
                "YouTube Music detection.",
                file=sys.stderr,
                flush=True,
            )
            _warned_detection = True
        return []
    return [line.strip() for line in proc.stdout.splitlines() if line.strip()]


def _linux_window_titles() -> list[str] | None:
    wmctrl = shutil.which("wmctrl")
    if wmctrl:
        proc = subprocess.run(
            [wmctrl, "-l"], capture_output=True, text=True, timeout=5
        )
        if proc.returncode == 0:
            titles = []
            for line in proc.stdout.splitlines():
                parts = line.split(None, 3)
                if len(parts) >= 4:
                    titles.append(parts[3])
            return titles

    xdotool = shutil.which("xdotool")
    if xdotool:
        proc = subprocess.run(
            [xdotool, "search", "--onlyvisible", "--name", "."],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if proc.returncode == 0:
            titles = []
            for window_id in proc.stdout.split():
                name = subprocess.run(
                    [xdotool, "getwindowname", window_id],
                    capture_output=True,
                    text=True,
                    timeout=2,
                )
                if name.returncode == 0 and name.stdout.strip():
                    titles.append(name.stdout.strip())
            return titles
    return None


def window_titles() -> list[str] | None:
    """Return visible window titles, or None when enumeration is unavailable."""
    global _warned_detection
    try:
        if IS_WINDOWS:
            return _windows_window_titles()
        if IS_MACOS:
            return _macos_window_titles()
        return _linux_window_titles()
    except Exception as exc:
        if not _warned_detection:
            print(
                f"[main] Could not enumerate windows ({exc}); YouTube Music "
                "detection will report 'not open'.",
                file=sys.stderr,
                flush=True,
            )
            _warned_detection = True
        return None


def youtube_music_open() -> bool:
    global _warned_detection
    titles = window_titles()
    if titles is None:
        if IS_LINUX and not _warned_detection:
            print(
                "[main] Install wmctrl or xdotool to detect YouTube Music "
                "browser windows on Linux.",
                file=sys.stderr,
                flush=True,
            )
            _warned_detection = True
        return False
    for title in titles:
        lowered = title.lower()
        if any(hint in lowered for hint in YOUTUBE_MUSIC_HINTS):
            return True
    return False


# ---------------------------------------------------------------------------
# Child process management
# ---------------------------------------------------------------------------
def _popen_kwargs() -> dict:
    if IS_WINDOWS:
        return {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP}
    return {"start_new_session": True}


class Runner:
    def __init__(self, monitor: int | None):
        self.monitor = monitor
        self.proc: subprocess.Popen | None = None
        self.mode: str | None = None

    def command(self, mode: str) -> list[str]:
        script = AUDIO_SCRIPT if mode == "audio" else AMBIENT_SCRIPT
        command = [sys.executable, str(script)]
        if mode == "ambient" and self.monitor is not None:
            command.extend(["--monitor", str(self.monitor)])
        return command

    def start(self, mode: str) -> None:
        self.stop()
        command = self.command(mode)
        print(f"[main] Starting {mode}: {' '.join(command)}", flush=True)
        self.proc = subprocess.Popen(
            command,
            cwd=str(BASE_DIR),
            **_popen_kwargs(),
        )
        self.mode = mode

    def stop(self) -> None:
        proc = self.proc
        if proc is None or proc.poll() is not None:
            self.proc = None
            return
        print(f"[main] Stopping {self.mode} ...", flush=True)
        try:
            if IS_WINDOWS:
                proc.send_signal(signal.CTRL_BREAK_EVENT)
            else:
                proc.send_signal(signal.SIGINT)
        except (OSError, ValueError):
            proc.terminate()
        try:
            proc.wait(timeout=4)
        except subprocess.TimeoutExpired:
            proc.terminate()
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
        self.proc = None


def run(args: argparse.Namespace) -> int:
    runner = Runner(args.monitor)
    current_mode = "audio" if youtube_music_open() else "ambient"
    print(
        f"[main] {PLATFORM_NAME}; YouTube Music is "
        f"{'open' if current_mode == 'audio' else 'closed'}; starting "
        f"{current_mode}.",
        flush=True,
    )
    runner.start(current_mode)

    restart_at: float | None = None
    try:
        while True:
            time.sleep(args.poll_interval)

            desired = "audio" if youtube_music_open() else "ambient"
            proc = runner.proc
            if proc is not None and proc.poll() is not None:
                print(
                    f"[main] {current_mode} exited with code "
                    f"{proc.returncode}; restarting in 5 seconds.",
                    file=sys.stderr,
                    flush=True,
                )
                runner.proc = None
                restart_at = time.monotonic() + 5.0

            if desired != current_mode:
                print(
                    f"[main] YouTube Music "
                    f"{'opened; switching to audio' if desired == 'audio' else 'closed; switching to ambient'}.",
                    flush=True,
                )
                current_mode = desired
                runner.start(current_mode)
                restart_at = None
                continue

            if (
                restart_at is not None
                and runner.proc is None
                and time.monotonic() >= restart_at
            ):
                runner.start(current_mode)
                restart_at = None
    except KeyboardInterrupt:
        print("\n[main] Stopping.", flush=True)
        return 0
    finally:
        runner.stop()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Run wled_audio.py while YouTube Music is open and "
            "wled_ambient.py otherwise, switching automatically."
        ),
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument(
        "--monitor",
        type=int,
        default=None,
        help=(
            "Monitor index passed to wled_ambient.py (1 = first monitor). "
            "The default lets the ambient script choose the primary display."
        ),
    )
    parser.add_argument(
        "--poll-interval",
        type=float,
        default=2.0,
        metavar="SECONDS",
        help="How often to check whether YouTube Music is open",
    )
    parser.add_argument(
        "--status",
        action="store_true",
        help="Report whether YouTube Music is open and exit",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Check dependencies and print the selected script, then exit",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    if args.poll_interval <= 0:
        print("[main] --poll-interval must be greater than zero.", file=sys.stderr)
        return 2

    if args.status:
        song_open = youtube_music_open()
        print(f"YouTube Music is {'open' if song_open else 'not open'}.")
        return 0

    try:
        ensure_environment()
    except Exception as exc:
        print(f"[main] Could not prepare the environment: {exc}", file=sys.stderr)
        return 1

    if args.dry_run:
        mode = "audio" if youtube_music_open() else "ambient"
        command = Runner(args.monitor).command(mode)
        print(f"[main] YouTube Music is {'open' if mode == 'audio' else 'not open'}.")
        print(f"[main] Would run: {' '.join(command)}")
        return 0

    try:
        return run(args)
    except Exception as exc:
        print(f"[main] Error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
