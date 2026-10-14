"""The PostgreSQL login each server process uses.

``SENTINEL_DB_ROLES`` chooses between two arrangements:

``legacy`` (the default, and every installation that predates the setting)
    One role does everything: ``POSTGRES_USER`` with ``POSTGRES_PASSWORD``. In
    Docker Compose that is the superuser the PostgreSQL image creates, and the
    ``web`` container applies the migrations when it starts.

``separate``
    No process connects as a superuser. ``sentinel_owner`` (no login) owns the
    schema objects, ``sentinel_migrate`` may only switch to it (``SET ROLE``)
    and applies the migrations in the one-shot ``migrate`` service, and
    ``sentinel_app`` reads and writes the application's data. The roles must
    exist before this arrangement is selected.

``SENTINEL_DB_ACCESS`` (set by compose.yml) tells a process which login of the
separate arrangement it uses: ``runtime`` (the default) or ``migrate``. Each
login's password is read from its own variable; compose.yml gives the
migration password to the migrate service only, never to web.

This module does not import Django: the container entrypoint runs it before
the application starts (``python -m sentinel.database mode|wait``).
"""

from __future__ import annotations

import sys
import time
from collections.abc import Mapping
from dataclasses import dataclass, field

LEGACY = "legacy"
SEPARATE = "separate"
RUNTIME = "runtime"
MIGRATE = "migrate"

OWNER_ROLE = "sentinel_owner"
MIGRATION_ROLE = "sentinel_migrate"
RUNTIME_ROLE = "sentinel_app"

# The entrypoint's wait for the database: attempts, connect timeout and pause
# (seconds), about two minutes in all.
WAIT_ATTEMPTS = 30
WAIT_CONNECT_TIMEOUT = 3
WAIT_PAUSE = 1


@dataclass(frozen=True)
class Login:
    user: str
    password: str
    # Database OPTIONS for Django: the role a migration session switches to.
    options: dict[str, str] = field(default_factory=dict)


def _choice(environ: Mapping[str, str], name: str, choices: tuple[str, ...]) -> str:
    """The value of ``name``, the first choice when unset or empty."""
    value = environ.get(name, "")
    if not value:
        return choices[0]
    if value not in choices:
        raise RuntimeError(f"Environment variable {name} must be one of: {', '.join(choices)}")
    return value


def roles(environ: Mapping[str, str]) -> str:
    return _choice(environ, "SENTINEL_DB_ROLES", (LEGACY, SEPARATE))


def access(environ: Mapping[str, str]) -> str:
    return _choice(environ, "SENTINEL_DB_ACCESS", (RUNTIME, MIGRATE))


def _required(environ: Mapping[str, str], name: str) -> str:
    value = environ.get(name)
    if value is None:
        raise RuntimeError(f"Required environment variable {name} is not set")
    return value


def _secret(environ: Mapping[str, str], name: str) -> str:
    value = _required(environ, name)
    if not value.strip():
        raise RuntimeError(f"Required environment variable {name} is empty")
    return value


def login(environ: Mapping[str, str]) -> Login:
    """The user, password and Django options of this process's connection."""
    arrangement, use = roles(environ), access(environ)
    if arrangement == LEGACY:
        # Exactly what the settings read before the arrangements existed (an
        # empty password stays allowed: trust authentication, as in CI).
        return Login(_required(environ, "POSTGRES_USER"), _required(environ, "POSTGRES_PASSWORD"))
    if use == MIGRATE:
        return Login(
            MIGRATION_ROLE,
            _secret(environ, "SENTINEL_DB_MIGRATE_PASSWORD"),
            {"assume_role": OWNER_ROLE},
        )
    return Login(RUNTIME_ROLE, _secret(environ, "SENTINEL_DB_PASSWORD"))


def wait(environ: Mapping[str, str]) -> int:
    """Wait until the database accepts this process's login; 0 when it does."""
    import psycopg

    credentials = login(environ)
    for attempt in range(1, WAIT_ATTEMPTS + 1):
        try:
            with psycopg.connect(
                host=environ.get("POSTGRES_HOST", "db"),
                port=environ.get("POSTGRES_PORT", "5432"),
                dbname=_required(environ, "POSTGRES_DB"),
                user=credentials.user,
                password=credentials.password,
                connect_timeout=WAIT_CONNECT_TIMEOUT,
            ):
                return 0
        except psycopg.OperationalError as exc:
            if attempt == WAIT_ATTEMPTS:
                print(f"entrypoint: database unavailable: {exc}", file=sys.stderr)
                return 1
            time.sleep(WAIT_PAUSE)
    return 1


def main(argv: list[str], environ: Mapping[str, str]) -> int:
    command = argv[1] if len(argv) == 2 else ""
    try:
        if command == "mode":
            print(roles(environ), access(environ))
            return 0
        if command == "wait":
            return wait(environ)
    except RuntimeError as exc:
        print(f"entrypoint: {exc}", file=sys.stderr)
        return 2 if command == "mode" else 1
    print("usage: python -m sentinel.database mode|wait", file=sys.stderr)
    return 2


if __name__ == "__main__":  # pragma: no cover - exercised through the entrypoint
    import os

    sys.exit(main(sys.argv, os.environ))
