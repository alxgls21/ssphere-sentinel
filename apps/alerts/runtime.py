"""What the alert workers (``run_alert_engine``, ``run_notifier``) share as processes.

* They never apply migrations. Started before the migrations are applied (by the
  web service, or the migrate service with the separate database logins), they
  wait for them; ``--once`` refuses instead.
* A liveness file for the container's health check: each loop writes the time by
  which it must have written again, and ``python -m apps.alerts.runtime PATH``
  (standard library only, no Django) exits 0 while that time has not passed. A
  worker stuck in a cycle, or gone, turns unhealthy.
* SIGTERM and SIGINT stop the loop after the cycle in progress.
"""

from __future__ import annotations

import os
import signal
import sys
import tempfile
import time
from collections.abc import Iterator
from contextlib import contextmanager


def unapplied_migrations() -> list:
    from django.db import connection
    from django.db.migrations.executor import MigrationExecutor

    executor = MigrationExecutor(connection)
    return executor.migration_plan(executor.loader.graph.leaf_nodes())


def wait_for_migrations(stop, *, logger, liveness: str | None, within: float, poll: float = 5.0) -> bool:
    """Wait until no migration is pending, still alive meanwhile; False if ``stop`` (an Event) comes first."""
    from django.db import connection

    announced = False
    while True:
        pending = unapplied_migrations()
        if not pending:
            if announced:
                logger.info("the migrations are applied: starting")
            return True
        if not announced:
            logger.warning(
                "%d migration(s) not applied yet: waiting for the web or migrate service to apply them", len(pending)
            )
            announced = True
        mark_alive(liveness, within=within)
        connection.close()  # no session held while waiting
        if stop.wait(poll):
            return False


def mark_alive(path: str | None, *, within: float) -> None:
    """Write to ``path`` the time by which the next mark is due (nothing without a path)."""
    if not path:
        return
    directory = os.path.dirname(path) or "."
    descriptor, temporary = tempfile.mkstemp(dir=directory, prefix=".alive-")
    try:
        with os.fdopen(descriptor, "w") as file:
            file.write(f"{time.time() + within:.0f}\n")
        os.replace(temporary, path)  # never a half-written file
    except BaseException:
        os.unlink(temporary)
        raise


def alive(path: str) -> bool:
    try:
        with open(path) as file:
            return time.time() < float(file.read().strip())
    except (OSError, ValueError):
        return False


@contextmanager
def stopped_by_signals(stop) -> Iterator[None]:
    """SIGTERM and SIGINT set ``stop`` (a threading.Event) for the duration; the old handlers come back."""
    previous = {sig: signal.signal(sig, lambda *_: stop.set()) for sig in (signal.SIGTERM, signal.SIGINT)}
    try:
        yield
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)


if __name__ == "__main__":  # the health check: python -m apps.alerts.runtime PATH
    sys.exit(0 if len(sys.argv) == 2 and alive(sys.argv[1]) else 1)
