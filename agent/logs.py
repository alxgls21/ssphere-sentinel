"""Logging setup for the agent CLI: plain stderr, or journald-aware under systemd."""

from __future__ import annotations

import logging
import os
import sys
from collections.abc import Mapping
from typing import TextIO

LOGGER_NAME = "sentinel_agent"
ENV_LOG_LEVEL = "SENTINEL_LOG_LEVEL"
DEFAULT_LEVEL = logging.INFO
LEVELS = {
    "DEBUG": logging.DEBUG,
    "INFO": logging.INFO,
    "WARNING": logging.WARNING,
    "ERROR": logging.ERROR,
}
FORMAT = "%(levelname)s: %(message)s"


class JournalFormatter(logging.Formatter):
    """Prefix each record with its syslog priority (``<4>`` for warnings).

    journald reads the prefix from stderr lines, so ``journalctl -p warning``
    filters agent problems and the levels are highlighted.
    """

    def format(self, record: logging.LogRecord) -> str:
        if record.levelno >= logging.CRITICAL:
            priority = 2
        elif record.levelno >= logging.ERROR:
            priority = 3
        elif record.levelno >= logging.WARNING:
            priority = 4
        elif record.levelno >= logging.INFO:
            priority = 6
        else:
            priority = 7
        return f"<{priority}>{super().format(record)}"


def stream_is_journal(stream: TextIO, environ: Mapping[str, str]) -> bool:
    """Whether systemd connected ``stream`` to the journal (``JOURNAL_STREAM``)."""
    value = environ.get("JOURNAL_STREAM", "")
    try:
        device, inode = (int(part) for part in value.split(":", 1))
        stat = os.fstat(stream.fileno())
    except (ValueError, OSError, AttributeError):
        return False
    return (stat.st_dev, stat.st_ino) == (device, inode)


def configure_logging(
    environ: Mapping[str, str] | None = None,
    stream: TextIO | None = None,
) -> None:
    """(Re)configure the agent logger; safe to call more than once."""
    env = os.environ if environ is None else environ
    stream = sys.stderr if stream is None else stream
    raw_level = (env.get(ENV_LOG_LEVEL) or "").strip()
    level = LEVELS.get(raw_level.upper(), DEFAULT_LEVEL) if raw_level else DEFAULT_LEVEL

    handler = logging.StreamHandler(stream)
    formatter_class = JournalFormatter if stream_is_journal(stream, env) else logging.Formatter
    handler.setFormatter(formatter_class(FORMAT))
    handler._sentinel_agent = True  # type: ignore[attr-defined]

    logger = logging.getLogger(LOGGER_NAME)
    for previous in [h for h in logger.handlers if getattr(h, "_sentinel_agent", False)]:
        logger.removeHandler(previous)
    logger.addHandler(handler)
    logger.setLevel(level)
    logger.propagate = False

    if raw_level and raw_level.upper() not in LEVELS:
        logger.warning(
            "%s must be one of %s; using INFO", ENV_LOG_LEVEL, ", ".join(LEVELS)
        )
