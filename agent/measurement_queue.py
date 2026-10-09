"""Persistent, bounded local queue for network measurements (stdlib sqlite3).

Measurements are written here as soon as a probe finishes and are removed only
when the Sentinel server explicitly acknowledges them (or rejects them
permanently). The queue never stores the agent token or request headers: only
the whitelisted measurement fields that are sent to the server anyway.

Bounds:
- at most ``max_measurements`` rows (overflow policy: drop the oldest rows),
- rows older than ``max_age_seconds`` are purged,
- each stored payload is at most ``MAX_PAYLOAD_BYTES``,
- the SQLite file is capped with ``PRAGMA max_page_count``.

Every drop is logged as a warning; nothing is discarded silently.
"""

from __future__ import annotations

import json
import logging
import os
import sqlite3
import stat
import threading
import time
from collections.abc import Callable, Iterable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from uuid import UUID

from agent.errors import AgentError

logger = logging.getLogger("sentinel_agent")

SCHEMA_VERSION = 1
MAX_PAYLOAD_BYTES = 2048
MAX_ITEM_ATTEMPTS = 10
RETRY_BASE_SECONDS = 30.0
RETRY_MAX_SECONDS = 600.0
BUSY_TIMEOUT_MS = 5000
PAGE_SIZE_BYTES = 4096
# Generous per-row allowance (payload + index + page overhead) for the hard cap.
BYTES_PER_ROW_BUDGET = 4096
SIDECAR_SUFFIXES = ("-wal", "-shm", "-journal")

ALLOWED_FIELDS = frozenset(
    {
        "measurement_id",
        "target_id",
        "measured_at",
        "success",
        "latency_ms",
        "packet_loss_percentage",
        "probe_count",
        "successful_probes",
        "failure_reason",
    }
)

_SCHEMA = """
CREATE TABLE IF NOT EXISTS pending_measurements (
    measurement_id TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    enqueued_at REAL NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS pending_measurements_enqueued
    ON pending_measurements (enqueued_at);
"""


class QueueError(AgentError):
    """Raised when the queue cannot complete an operation."""


class QueueStorageError(QueueError):
    """Raised when the configured queue path is unsafe or unusable."""


@dataclass(frozen=True)
class RetryOutcome:
    rescheduled: int
    dropped: int


def retry_delay_seconds(attempts: int) -> float:
    """Exponential backoff for item-level retries, capped at RETRY_MAX_SECONDS."""
    exponent = max(0, attempts - 1)
    return min(RETRY_BASE_SECONDS * (2**exponent), RETRY_MAX_SECONDS)


def default_queue_path(environ: dict[str, str] | None = None) -> Path:
    env = environ if environ is not None else os.environ
    state_home = (env.get("XDG_STATE_HOME") or "").strip()
    base = Path(state_home) if state_home else Path.home() / ".local" / "state"
    return base / "ssphere-sentinel" / "network-queue.sqlite3"


def validate_queue_path(raw: str | os.PathLike[str]) -> Path:
    """Return a normalized absolute path or raise QueueStorageError."""
    text = os.path.expanduser(str(raw)).strip()
    if not text:
        raise QueueStorageError("queue path is empty")
    path = Path(text)
    if not path.is_absolute():
        raise QueueStorageError("queue path must be absolute")
    if ".." in path.parts:
        raise QueueStorageError("queue path must not contain '..'")
    if path.name in ("", ".", "/"):
        raise QueueStorageError("queue path must name a file")
    return path


def prepare_queue_file(path: Path) -> None:
    """Create the queue directory/file safely and verify ownership/permissions.

    - parent directory is created with mode 0700 and must not be writable by
      group/others (prevents planting symlinks for the db or its sidecars),
    - the database file and any SQLite sidecar files must not be symlinks,
    - the database file must be a regular file owned by the current user and
      is forced to mode 0600.
    """
    parent = path.parent
    try:
        os.makedirs(parent, mode=0o700, exist_ok=True)
        parent_stat = os.stat(parent)
    except OSError as exc:
        raise QueueStorageError(f"queue directory is not usable: {exc.strerror}") from exc
    if not stat.S_ISDIR(parent_stat.st_mode):
        raise QueueStorageError("queue directory is not a directory")
    if parent_stat.st_mode & 0o022:
        raise QueueStorageError("queue directory must not be writable by group or others")
    uid = _current_uid()
    if uid is not None and parent_stat.st_uid not in (uid, 0):
        raise QueueStorageError("queue directory is owned by another user")

    for sidecar in SIDECAR_SUFFIXES:
        sidecar_path = path.with_name(path.name + sidecar)
        if sidecar_path.is_symlink():
            raise QueueStorageError("queue sidecar file must not be a symlink")

    try:
        file_stat = os.lstat(path)
    except FileNotFoundError:
        flags = os.O_RDWR | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
        try:
            fd = os.open(path, flags, 0o600)
        except OSError as exc:
            raise QueueStorageError(f"queue file cannot be created: {exc.strerror}") from exc
        os.close(fd)
        return
    except OSError as exc:
        raise QueueStorageError(f"queue file is not accessible: {exc.strerror}") from exc

    if stat.S_ISLNK(file_stat.st_mode):
        raise QueueStorageError("queue file must not be a symlink")
    if not stat.S_ISREG(file_stat.st_mode):
        raise QueueStorageError("queue file is not a regular file")
    if uid is not None and file_stat.st_uid != uid:
        raise QueueStorageError("queue file is owned by another user")
    if file_stat.st_mode & 0o077:
        try:
            os.chmod(path, 0o600)
        except OSError as exc:
            raise QueueStorageError(
                f"queue file permissions cannot be restricted: {exc.strerror}"
            ) from exc
        logger.warning("Queue file permissions were too broad; restricted to 0600")


def sanitize_measurement(measurement: dict[str, Any]) -> tuple[str, str]:
    """Return (measurement_id, json_payload) with only whitelisted fields."""
    if not isinstance(measurement, dict):
        raise QueueError("measurement must be an object")
    raw_id = measurement.get("measurement_id")
    try:
        measurement_id = str(UUID(str(raw_id)))
    except (TypeError, ValueError) as exc:
        raise QueueError("measurement_id must be a UUID") from exc
    cleaned = {key: value for key, value in measurement.items() if key in ALLOWED_FIELDS}
    cleaned["measurement_id"] = measurement_id
    payload = json.dumps(cleaned, separators=(",", ":"), sort_keys=True)
    if len(payload.encode("utf-8")) > MAX_PAYLOAD_BYTES:
        raise QueueError("measurement payload exceeds size limit")
    return measurement_id, payload


class MeasurementQueue:
    """Thread-safe SQLite queue. Use :meth:`open` for file-backed queues."""

    def __init__(
        self,
        path: Path | None = None,
        *,
        max_measurements: int = 10_000,
        max_age_seconds: float = 7 * 24 * 3600,
        wall_fn: Callable[[], float] = time.time,
    ) -> None:
        if max_measurements < 1:
            raise ValueError("max_measurements must be positive")
        self.path = path
        self.max_measurements = max_measurements
        self.max_age_seconds = max_age_seconds
        self._wall_fn = wall_fn
        self._lock = threading.Lock()
        self._conn = self._connect()

    @property
    def persistent(self) -> bool:
        return self.path is not None

    @classmethod
    def open(
        cls,
        path: str | os.PathLike[str] | None,
        *,
        max_measurements: int = 10_000,
        max_age_seconds: float = 7 * 24 * 3600,
        wall_fn: Callable[[], float] = time.time,
    ) -> MeasurementQueue:
        """Open a file-backed queue, recovering from corruption.

        Falls back to an in-memory queue (logged as a warning) if the path is
        unsafe or storage is unavailable, so the agent keeps running.
        """
        kwargs = {
            "max_measurements": max_measurements,
            "max_age_seconds": max_age_seconds,
            "wall_fn": wall_fn,
        }
        if path is None:
            return cls(None, **kwargs)
        try:
            resolved = validate_queue_path(path)
            prepare_queue_file(resolved)
            try:
                return cls(resolved, **kwargs)
            except sqlite3.DatabaseError as exc:
                if not is_corruption_error(exc):
                    raise
                quarantine_corrupt_file(resolved)
                prepare_queue_file(resolved)
                return cls(resolved, **kwargs)
        except (QueueError, sqlite3.Error, OSError) as exc:
            logger.warning(
                "Network queue storage unavailable (%s); using in-memory queue. "
                "Pending measurements will not survive an agent restart.",
                _describe(exc),
            )
            return cls(None, **kwargs)

    # -- connection -----------------------------------------------------------------

    def _connect(self) -> sqlite3.Connection:
        target = str(self.path) if self.path is not None else ":memory:"
        conn = sqlite3.connect(
            target,
            timeout=BUSY_TIMEOUT_MS / 1000,
            isolation_level=None,
            check_same_thread=False,
        )
        try:
            conn.execute(f"PRAGMA busy_timeout = {BUSY_TIMEOUT_MS}")
            if self.path is not None:
                result = conn.execute("PRAGMA quick_check").fetchone()
                if not result or result[0] != "ok":
                    raise sqlite3.DatabaseError("queue integrity check failed")
            version = conn.execute("PRAGMA user_version").fetchone()[0]
            if version > SCHEMA_VERSION:
                raise QueueStorageError(
                    "queue file was created by a newer agent version"
                )
            conn.execute("PRAGMA journal_mode = WAL")
            conn.execute("PRAGMA synchronous = FULL")
            conn.execute(f"PRAGMA page_size = {PAGE_SIZE_BYTES}")
            max_pages = (
                self.max_measurements * BYTES_PER_ROW_BUDGET // PAGE_SIZE_BYTES + 256
            )
            conn.execute(f"PRAGMA max_page_count = {max_pages}")
            conn.executescript(_SCHEMA)
            conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
        except BaseException:
            conn.close()
            raise
        if self.path is not None:
            _restrict_sidecars(self.path)
        return conn

    @contextmanager
    def _write(self) -> Iterator[sqlite3.Connection]:
        """Serialize access and run the body in one IMMEDIATE transaction."""
        with self._lock:
            try:
                self._conn.execute("BEGIN IMMEDIATE")
                try:
                    yield self._conn
                except BaseException:
                    self._conn.execute("ROLLBACK")
                    raise
                self._conn.execute("COMMIT")
            except sqlite3.DatabaseError as exc:
                self._handle_database_error(exc)
                raise QueueError(f"queue write failed: {_describe(exc)}") from exc

    def _read(self, sql: str, params: Iterable[Any] = ()) -> list[tuple[Any, ...]]:
        with self._lock:
            try:
                return self._conn.execute(sql, tuple(params)).fetchall()
            except sqlite3.DatabaseError as exc:
                self._handle_database_error(exc)
                raise QueueError(f"queue read failed: {_describe(exc)}") from exc

    def _handle_database_error(self, exc: sqlite3.DatabaseError) -> None:
        """Recover from corruption detected at runtime (lock must be held)."""
        if self.path is None or not is_corruption_error(exc):
            return
        logger.warning(
            "Network queue database is corrupted (%s); moving it aside and "
            "starting a new queue. Unsent measurements in it are lost.",
            _describe(exc),
        )
        try:
            self._conn.close()
        except sqlite3.Error:
            pass
        try:
            quarantine_corrupt_file(self.path)
            prepare_queue_file(self.path)
            self._conn = self._connect()
        except (QueueError, sqlite3.Error, OSError) as reopen_exc:
            logger.warning(
                "Network queue could not be recreated (%s); using in-memory queue.",
                _describe(reopen_exc),
            )
            self.path = None
            self._conn = self._connect()

    # -- operations -----------------------------------------------------------------

    def enqueue(self, measurement: dict[str, Any]) -> bool:
        """Store a measurement. Returns False if it was already queued."""
        measurement_id, payload = sanitize_measurement(measurement)
        now = self._wall_fn()
        dropped = 0
        with self._write() as conn:
            cursor = conn.execute(
                "INSERT OR IGNORE INTO pending_measurements "
                "(measurement_id, payload, enqueued_at) VALUES (?, ?, ?)",
                (measurement_id, payload, now),
            )
            inserted = cursor.rowcount == 1
            count = conn.execute("SELECT COUNT(*) FROM pending_measurements").fetchone()[0]
            overflow = count - self.max_measurements
            if overflow > 0:
                dropped = conn.execute(
                    "DELETE FROM pending_measurements WHERE measurement_id IN ("
                    " SELECT measurement_id FROM pending_measurements"
                    " ORDER BY rowid LIMIT ?)",
                    (overflow,),
                ).rowcount
        if dropped:
            logger.warning(
                "Network queue full (limit %d); dropped %d oldest measurement(s)",
                self.max_measurements,
                dropped,
            )
        return inserted

    def pending_batch(self, limit: int) -> list[dict[str, Any]]:
        """Due measurements in insertion order (``next_attempt_at`` <= now).

        Rows scheduled implausibly far in the future (wall clock moved back)
        are treated as due so a clock jump cannot stall delivery.
        """
        now = self._wall_fn()
        rows = self._read(
            "SELECT payload FROM pending_measurements "
            "WHERE next_attempt_at <= ? OR next_attempt_at > ? "
            "ORDER BY rowid LIMIT ?",
            (now, now + RETRY_MAX_SECONDS * 2, limit),
        )
        batch: list[dict[str, Any]] = []
        for (payload,) in rows:
            try:
                batch.append(json.loads(payload))
            except ValueError:
                logger.warning("Skipping unreadable queued measurement payload")
        return batch

    def remove(self, measurement_ids: Iterable[str]) -> int:
        ids = list(dict.fromkeys(measurement_ids))
        if not ids:
            return 0
        removed = 0
        with self._write() as conn:
            for chunk in _chunks(ids, 500):
                placeholders = ",".join("?" * len(chunk))
                removed += conn.execute(
                    f"DELETE FROM pending_measurements WHERE measurement_id IN ({placeholders})",
                    chunk,
                ).rowcount
        return removed

    def mark_retry(self, measurement_ids: Iterable[str]) -> RetryOutcome:
        """Increment attempts and back off; drop rows that exhausted retries."""
        ids = list(dict.fromkeys(measurement_ids))
        if not ids:
            return RetryOutcome(0, 0)
        now = self._wall_fn()
        rescheduled = 0
        dropped = 0
        with self._write() as conn:
            for measurement_id in ids:
                row = conn.execute(
                    "SELECT attempts FROM pending_measurements WHERE measurement_id = ?",
                    (measurement_id,),
                ).fetchone()
                if row is None:
                    continue
                attempts = row[0] + 1
                if attempts >= MAX_ITEM_ATTEMPTS:
                    conn.execute(
                        "DELETE FROM pending_measurements WHERE measurement_id = ?",
                        (measurement_id,),
                    )
                    dropped += 1
                    continue
                conn.execute(
                    "UPDATE pending_measurements SET attempts = ?, next_attempt_at = ? "
                    "WHERE measurement_id = ?",
                    (attempts, now + retry_delay_seconds(attempts), measurement_id),
                )
                rescheduled += 1
        if dropped:
            logger.warning(
                "Dropped %d network measurement(s) after %d unacknowledged attempts",
                dropped,
                MAX_ITEM_ATTEMPTS,
            )
        return RetryOutcome(rescheduled, dropped)

    def purge_expired(self) -> int:
        cutoff = self._wall_fn() - self.max_age_seconds
        with self._write() as conn:
            purged = conn.execute(
                "DELETE FROM pending_measurements WHERE enqueued_at < ?", (cutoff,)
            ).rowcount
        if purged:
            logger.warning(
                "Dropped %d network measurement(s) older than %d seconds",
                purged,
                int(self.max_age_seconds),
            )
        return purged

    def count(self) -> int:
        return self._read("SELECT COUNT(*) FROM pending_measurements")[0][0]

    def attempts(self, measurement_id: str) -> int | None:
        rows = self._read(
            "SELECT attempts FROM pending_measurements WHERE measurement_id = ?",
            (measurement_id,),
        )
        return rows[0][0] if rows else None

    def close(self) -> None:
        with self._lock:
            try:
                self._conn.close()
            except sqlite3.Error:
                pass


_SQLITE_CORRUPT = 11
_SQLITE_NOTADB = 26
_CORRUPTION_MARKERS = ("malformed", "not a database", "integrity check failed")


def is_corruption_error(exc: sqlite3.Error) -> bool:
    """True only for real corruption; locks, closed handles, etc. are not."""
    code = getattr(exc, "sqlite_errorcode", None)
    if isinstance(code, int) and (code & 0xFF) in (_SQLITE_CORRUPT, _SQLITE_NOTADB):
        return True
    message = str(exc).lower()
    return any(marker in message for marker in _CORRUPTION_MARKERS)


def quarantine_corrupt_file(path: Path) -> Path | None:
    """Move a corrupted queue (and sidecars) aside instead of deleting it."""
    suffix = f".corrupt-{int(time.time())}"
    moved: Path | None = None
    for candidate in (path, *(path.with_name(path.name + s) for s in SIDECAR_SUFFIXES)):
        if candidate.exists() and not candidate.is_symlink():
            destination = candidate.with_name(candidate.name + suffix)
            os.replace(candidate, destination)
            if candidate == path:
                moved = destination
    if moved is not None:
        logger.warning("Corrupted network queue moved to %s", moved.name)
    return moved


def _restrict_sidecars(path: Path) -> None:
    for sidecar in SIDECAR_SUFFIXES:
        sidecar_path = path.with_name(path.name + sidecar)
        try:
            if sidecar_path.exists() and not sidecar_path.is_symlink():
                os.chmod(sidecar_path, 0o600)
        except OSError:
            pass


def _current_uid() -> int | None:
    getuid = getattr(os, "getuid", None)
    return getuid() if getuid is not None else None


def _chunks(items: list[str], size: int) -> Iterator[list[str]]:
    for index in range(0, len(items), size):
        yield items[index : index + size]


def _describe(exc: BaseException) -> str:
    text = str(exc) or type(exc).__name__
    return text[:200]
