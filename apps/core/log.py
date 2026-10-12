"""Logging helpers referenced from settings.LOGGING."""

import logging


class DisallowedHostFilter(logging.Filter):
    """Log rejected Host headers as one-line warnings.

    Internet scanners send arbitrary Host headers. Django logs each one as an
    ERROR with a full traceback, which buries real server errors; the message
    alone still shows the rejected host for ALLOWED_HOSTS troubleshooting.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        record.exc_info = None
        record.exc_text = None
        record.levelno = logging.WARNING
        record.levelname = logging.getLevelName(logging.WARNING)
        return True
