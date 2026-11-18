"""Convert restored WAV output into user-selected download formats."""

from __future__ import annotations

import logging
import os
import subprocess  # nosec B404 - fixed argv, no shell, inputs validated below
import tempfile
import threading
from pathlib import Path

from app.services.artifacts import artifact_budget

logger = logging.getLogger(__name__)


class TranscodeError(Exception):
    """Raised when converting restored audio to a download format fails."""


class TranscodeBusyError(TranscodeError):
    """Raised when the single conversion slot is already occupied."""


_FFMPEG_TIMEOUT_SECONDS = 120

# At most one ffmpeg conversion at a time, mirroring inference admission:
# expensive work gets an explicit fail-fast bound instead of competing
# threadpool-wide for the instance's two vCPUs. The slot is acquired and
# released inside the worker thread that runs the subprocess, so a
# cancelled HTTP request cannot free capacity while ffmpeg still runs.
_TRANSCODE_SLOTS = threading.BoundedSemaphore(1)

# Conversions in progress, keyed by their target path. A second request for
# the same job and format waits on the owner's event instead of launching a
# competing ffmpeg or failing busy; when the owner finishes, the waiter
# re-checks the cache and serves the file the owner wrote. Different formats
# map to different keys, so they still contend for the single slot above.
_in_flight_lock = threading.Lock()
_in_flight: dict[Path, threading.Event] = {}

# Formats servable for download, mapped to media types. wav is the model's
# native output and is served directly without conversion.
DOWNLOAD_FORMATS: dict[str, str] = {
    "wav": "audio/wav",
    "mp3": "audio/mpeg",
    "flac": "audio/flac",
    "ogg": "audio/ogg",
    "m4a": "audio/mp4",
}


def transcode_output(wav_path: Path, fmt: str) -> Path:
    """Convert a restored WAV into the requested format, cached beside it.

    The encoder is inferred by ffmpeg from the output extension. Results are
    written atomically and cached, so repeat downloads of the same format
    never reconvert. The cache is valid only while its source is: a leftover
    conversion whose result WAV is gone is never served, so a cleaned-up job
    cannot leak back through its cache. Concurrent requests for the same
    target share one conversion: the first caller converts, the rest wait and
    serve its result.

    Args:
        wav_path: Path to the restored 16kHz mono WAV.
        fmt: Target format key from DOWNLOAD_FORMATS.

    Returns:
        Path to the file to serve (the WAV itself for fmt "wav").

    Raises:
        TranscodeError: If the format is unknown, ffmpeg fails, or times out.
        FileNotFoundError: If the source WAV no longer exists; nothing is held.
        OSError: If the byte budget cannot scan its directories; the slot is released.
    """
    if fmt == "wav":
        return wav_path
    if fmt not in DOWNLOAD_FORMATS:
        raise TranscodeError(f"Unsupported download format: {fmt}")

    target = wav_path.with_suffix(f".{fmt}")
    while True:
        # The source is stated before the cache is consulted, so a missing
        # source raises FileNotFoundError even when a stale cache file
        # survives it, and a source that disappears while waiting for another
        # thread's conversion is caught on the next pass.
        source_size = wav_path.stat().st_size
        if target.exists():
            return target

        with _in_flight_lock:
            event = _in_flight.get(target)
            if event is None:
                event = threading.Event()
                _in_flight[target] = event
                owner = True
            else:
                owner = False
        if not owner:
            # Another thread is already producing this exact file; wait for
            # it, then loop: serve its result, or become the owner and retry
            # if its conversion left nothing behind.
            event.wait()
            continue

        try:
            return _convert(wav_path, fmt, target, source_size)
        finally:
            # Whatever happened above, the target's waiters must be woken and
            # a later request must be able to start a fresh conversion.
            with _in_flight_lock:
                del _in_flight[target]
            event.set()


def _convert(wav_path: Path, fmt: str, target: Path, source_size: int) -> Path:
    """Run the conversion to *target* as the owner of its in-flight entry.

    The caller registered the in-flight entry and clears it afterwards.

    Raises:
        TranscodeBusyError: If the conversion slot or the byte budget is full.
        TranscodeError: If ffmpeg fails or times out.
    """
    # Deliberately conservative reservation (2x source) so no per-codec
    # output-size proof is required; released when the subprocess exits. The
    # source is read before the slot is taken, so a missing source holds nothing.
    reservation = source_size * 2
    if not _TRANSCODE_SLOTS.acquire(blocking=False):
        logger.warning("Conversion slot busy; rejecting %s to %s", wav_path.name, fmt)
        raise TranscodeBusyError("Another conversion is in progress")
    # Everything after the acquire sits in this try, so the slot is released on every
    # path, including an OSError from the budget's directory scan in try_reserve
    try:
        if not artifact_budget.try_reserve(reservation):
            raise TranscodeBusyError("Storage capacity unavailable for conversion")
        try:
            _run_conversion(wav_path, fmt, target)
        finally:
            artifact_budget.release(reservation)
    finally:
        _TRANSCODE_SLOTS.release()
    return target


def _run_conversion(wav_path: Path, fmt: str, target: Path) -> None:
    """Convert *wav_path* to *fmt* with ffmpeg and atomically place it at *target*.

    The caller holds the conversion slot and the byte reservation.

    Raises:
        TranscodeError: If ffmpeg fails or times out.
    """
    tmp_path: Path | None = None
    try:
        tmp_fd, tmp_str = tempfile.mkstemp(suffix=f".{fmt}", dir=wav_path.parent)
        os.close(tmp_fd)
        tmp_path = Path(tmp_str)
        # Single encoder thread: the admitted conversion must not itself
        # consume uncontrolled parallel CPU next to a running inference
        argv = [
            "ffmpeg",
            "-nostdin",
            "-y",
            "-loglevel",
            "error",
            "-threads",
            "1",
            "-i",
            str(wav_path),
            "-threads",
            "1",
            str(tmp_path),
        ]
        # nosec B603 - argv is fixed; paths are server-generated (UUID-derived)
        # and fmt is allowlisted above; no shell is involved
        result = subprocess.run(  # nosec
            argv,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            timeout=_FFMPEG_TIMEOUT_SECONDS,
            check=False,
        )
        if result.returncode != 0:
            stderr = result.stderr.decode(errors="replace")[:500]
            logger.error("ffmpeg failed converting %s to %s: %s", wav_path.name, fmt, stderr)
            raise TranscodeError(f"Conversion to {fmt} failed")
        # Flush ffmpeg's output to disk before the rename makes it the cached file
        with tmp_path.open("rb") as f:
            os.fsync(f.fileno())
        tmp_path.replace(target)
        logger.info("Converted %s to %s", wav_path.name, target.name)
    except subprocess.TimeoutExpired as err:
        logger.error("ffmpeg timed out converting %s to %s", wav_path.name, fmt)
        raise TranscodeError(f"Conversion to {fmt} timed out") from err
    finally:
        if tmp_path is not None:
            tmp_path.unlink(missing_ok=True)
