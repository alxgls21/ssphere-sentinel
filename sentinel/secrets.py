"""The secrets of a Compose installation that nobody has to write: ``./secrets`` of the installation, mounted
read-only at /run/sentinel/secrets.

    python -m sentinel.secrets init

runs before the database starts, at every start (the init service, deploy/postgres/postgres-18.yml):

- .env sets the database password (an installation that keeps its secrets there): nothing to do.
- A new installation, with no secrets and no database: it creates the three secrets, each a file of its own,

      django_secret_key    DJANGO_SECRET_KEY
      agent_token_pepper   AGENT_TOKEN_PEPPER
      postgres_password    POSTGRES_PASSWORD (the database's single login)

  owned by the application's user (10001) and readable by it alone, and authorizes the database to be created
  (the role SENTINEL_POSTGRES_INITIALIZE=true has otherwise), until it exists.
- All three exist: nothing changes.
- Some, but not all, or none while the database exists: it refuses. A new pepper would silently invalidate every
  agent token, and a new database password would not open the database: restore the directory from the backup.

Every Sentinel process calls ``load`` before it reads its settings: a variable the environment (.env) leaves
unset or empty is taken from its file. The environment always wins, so an installation that keeps its secrets in
.env runs exactly as before. The database password is only taken for the single login: with the separate
logins (SENTINEL_DB_ROLES=separate) each process gets its own password from its env files, and the checks of
sentinel/database.py refuse any other.

Standard library only: it runs before Django, and in the init service.
"""

from __future__ import annotations

import os
import secrets
import sys
from collections.abc import MutableMapping
from pathlib import Path

DIRECTORY = Path("/run/sentinel/secrets")
FILES = {
    "DJANGO_SECRET_KEY": "django_secret_key",
    "AGENT_TOKEN_PEPPER": "agent_token_pepper",
    "POSTGRES_PASSWORD": "postgres_password",
}
DATABASE_PASSWORD = "POSTGRES_PASSWORD"
# Written with the secrets of a new installation; the database's initialization guard reads it as the
# authorization SENTINEL_POSTGRES_INITIALIZE=true gives (deploy/postgres/postgres-18.yml).
INITIALIZE_MARKER = "initialize-database"
# The PostgreSQL 18 image's data directory, below the volume the init service mounts read-only.
DATABASE_DIR = Path("/var/lib/postgresql/18/docker")
# The user and group the application image runs as (Dockerfile).
OWNER = 10001
SECRET_BYTES = 48


def directory(environ: MutableMapping[str, str]) -> Path:
    return Path(environ.get("SENTINEL_SECRETS_DIR") or DIRECTORY)


def load(environ: MutableMapping[str, str]) -> list[str]:
    """Fill each secret the environment leaves unset or empty from its file, when there is one; the names filled."""
    folder = directory(environ)
    single_login = environ.get("SENTINEL_DB_ROLES", "") in ("", "legacy")
    if not single_login and (folder / FILES[DATABASE_PASSWORD]).exists():
        # With the separate logins, no Sentinel container may hold the superuser's password, not even unread.
        raise RuntimeError(
            f"{folder / FILES[DATABASE_PASSWORD]} holds the database superuser's password, which no Sentinel "
            "process may hold with SENTINEL_DB_ROLES=separate: move it to the bootstrap env file and delete it "
            "from ./secrets (docs/server-deployment.md, Separate database logins)"
        )
    loaded = []
    for name, file in FILES.items():
        if environ.get(name, "").strip() or (name == DATABASE_PASSWORD and not single_login):
            continue
        path = folder / file
        try:
            value = path.read_text().strip()
        except FileNotFoundError:
            continue
        except OSError as error:
            raise RuntimeError(f"{name} is not set and {path} cannot be read ({error.strerror})") from None
        if value:
            environ[name] = value
            loaded.append(name)
    return loaded


def initialize(folder: Path, cluster: Path, owner: int = OWNER, group: int | None = None) -> str:
    """Create the secrets in ``folder`` for a new installation: "created", or "kept" when they all exist.

    ``cluster`` is the database's data directory. A new installation has neither secrets nor a database: then
    the secrets are created, with the authorization to create the database (INITIALIZE_MARKER), which goes again
    once the database exists. A database without its secrets is refused: secrets made now would not open it.
    """
    present = sorted(file for file in FILES.values() if (folder / file).exists())
    database = (cluster / "PG_VERSION").exists()
    marker = folder / INITIALIZE_MARKER
    if len(present) == len(FILES):
        if database and marker.exists():
            marker.unlink()
        return "kept"
    if present:
        missing = sorted(set(FILES.values()) - set(present))
        raise RuntimeError(
            f"{folder} holds {', '.join(present)} but not {', '.join(missing)}: new secrets would not match the "
            "database and the agents of this installation. Restore the directory from the backup of the "
            "installation (docs/server-deployment.md, Backups); only a new installation that holds no data yet "
            "may delete it and start again"
        )
    if database:
        raise RuntimeError(
            f"the database exists, but {folder} holds none of its secrets and .env does not set POSTGRES_PASSWORD: "
            "restore the directory from the backup of the installation (docs/server-deployment.md, Backups), or "
            "set the secrets of this installation in .env"
        )
    temporary = []
    for file in FILES.values():
        path = folder / f".{file}.new"
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o400)
        with os.fdopen(descriptor, "w") as stream:
            stream.write(secrets.token_urlsafe(SECRET_BYTES) + "\n")
        os.chown(path, owner, owner if group is None else group)
        temporary.append((path, folder / file))
    marker.write_text("The secrets were created for a new installation: its database may be created.\n")
    for path, final in temporary:
        os.replace(path, final)
    return "created"


def main(argv: list[str], environ: MutableMapping[str, str]) -> int:
    if argv[1:] != ["init"]:
        print("usage: python -m sentinel.secrets init", file=sys.stderr)
        return 2
    if environ.get("SENTINEL_ENV_SETS_DATABASE_PASSWORD") == "yes":
        print("secrets: .env sets the database password: the secrets are those of .env, nothing to do")
        return 0
    folder = directory(environ)
    cluster = Path(environ.get("SENTINEL_DATABASE_DIR") or DATABASE_DIR)
    try:
        outcome = initialize(folder, cluster)
    except (RuntimeError, OSError) as error:
        print(f"secrets: {error}", file=sys.stderr)
        return 1
    print(f"secrets: {outcome} in {folder}" if outcome == "created" else f"secrets: {folder} is complete, kept")
    return 0


if __name__ == "__main__":  # pragma: no cover - exercised through the init service
    sys.exit(main(sys.argv, os.environ))
