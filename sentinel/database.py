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
separate arrangement it uses: ``runtime`` (the default) or ``migrate``.

Each password belongs to one place, and with the separate logins Compose
gives each only there (compose.yml, docs/server-deployment.md):
``SENTINEL_DB_PASSWORD`` to web, ``SENTINEL_DB_MIGRATE_PASSWORD`` to the
migrate service, from a file of its own, and ``POSTGRES_PASSWORD``, the
bootstrap superuser's, to the db service alone, from a file only Compose
reads (SENTINEL_BOOTSTRAP_ENV_FILE). Provisioning is the operator's
(scripts/postgres-roles.sh), over the db container's own socket. Every
process also checks its environment before it connects (``check_passwords``):
with the separate logins, one that holds a password not its own refuses to
start, and so does one with SENTINEL_DB_ROLES=legacy that holds a password
of the separate logins (a switch made by half). The order of a start:

1. db is healthy;
2. the logins exist (provisioned beforehand: otherwise the migrate service
   cannot log in, and nothing starts);
3. the migrate service waits and checks the roles (``verify``) before it
   runs anything, with the checks of ``status`` (sentinel/db_roles.py), but
   the passwords, which only the superuser may read: that the cluster is
   Sentinel's own (no other database or role); what each role may do,
   effectively (PUBLIC and memberships included), with grant options, on
   every object of this database and of the cluster's shared catalogs, with
   only what initdb made counting as the system's; that nothing made after
   initdb runs code there; that the login roles may not connect to the other
   databases, whose catalogs no session here can read, and have no session
   left open in one. Then it migrates, and checks the same again; web starts
   only once it succeeded;
4. web waits, checks the same (``verify``), and starts.

``verify`` runs in a session PostgreSQL keeps read-only: it changes nothing,
whatever it finds, and nothing is taken back for the operator.

Django's record of the migrations (``django_migrations``) decides which DDL
the owner runs, so the runtime login may only read it, in every state another
session can see. The owner's default privileges give every table it creates
the runtime login's INSERT, UPDATE and DELETE, this one too: the database
backend (sentinel/postgresql) takes them back, and checks that the runtime
login can write it by no path, in the transaction that creates it, which
therefore commits it read-only for the runtime login or not at all. A
``django_migrations`` the runtime login may write (a grant to it, to PUBLIC,
on a column, through a role) stops every process before anything runs,
until the operator revokes it by hand, as ``status`` names it (``apply``
changes nothing while the roles differ from what it provisioned).
``manage.py migrate`` checks the record itself as
well, however it was started (without the entrypoint too), before it reads,
prunes, creates or records anything (``MIGRATIONS_TABLE_UNSAFE``).

Once the separate arrangement has been provisioned, no Sentinel process
connects as a superuser again, whatever its environment says: the database
records it. ``python -m sentinel.db_roles apply`` creates the three roles,
which belong to the whole cluster, and in the application's database the
schema ``sentinel_restricted`` (owned by the bootstrap superuser, which
neither login can drop; a dump carries it to another cluster). A connection
whose login is a superuser, or can become one, is refused when either is
found (``refusal``), in any database of the cluster: Django checks every new
connection (sentinel/postgresql: Gunicorn, every ``manage.py`` command),
and the entrypoint's wait checks before anything runs. Switching
``SENTINEL_DB_ROLES`` back to ``legacy``, another ``POSTGRES_DB``, or
``SET ROLE`` right after a superuser login (PGOPTIONS) does not get around
it: the check is on the login itself. It guards against configuration, not
against code running inside a container, which can read whatever
credentials that container was given. ``manage.py dbshell`` is disabled:
psql would open a connection of its own, to whatever its arguments,
environment, service and startup files or ``\\connect`` name, which no check
here sees.

A connection checked once must not stay open across ``apply`` either: the
evidence did not exist when it was admitted. The advisory lock
``PROVISIONING_LOCK`` keeps the two apart. Before reading the evidence, a
superuser login takes it shared, at session level, and holds it until the
session ends (``ADMISSION_QUERY``); ``apply`` takes it exclusively for its
transaction, before it changes anything, and refuses unless it gets it and
no session of the cluster holds it shared. Advisory locks belong to one
database, so each side also looks for the other in ``pg_locks``, which shows
the whole cluster, after taking its own (``PROVISIONING_QUERY``): of two
that overlap, at least one sees the other and gives up. Hence:

* a superuser connection admitted before ``apply`` makes it refuse, with
  the session named, and nothing changes;
* one that arrives while ``apply`` runs is refused at once;
* one that arrives after ``apply`` has ended finds the exclusive lock gone,
  and what ``apply`` committed visible to its next statement, so it is
  refused (or admitted, if ``apply`` rolled back and nothing changed).

PostgreSQL releases a session's locks when the session ends, however its
process ended, and a transaction's when it commits or rolls back: an
interrupted ``apply`` leaves no lock, and a client that vanishes leaves its
lock with its backend until PostgreSQL notices (``apply`` names the pid,
for ``pg_terminate_backend``). Every failure to take or read the lock
refuses the connection. The lock binds a session, not a client: a pooler
that hands one PostgreSQL session to several clients (PgBouncer in
transaction or statement mode) defeats it and is not supported, nor is
code that lets session locks go (``pg_advisory_unlock_all``, ``DISCARD
ALL``), which Django never runs.

Recovery, by an operator, never by the application:

* The passwords of the separate logins are lost or wrong: put new ones in
  ``.env`` (SENTINEL_DB_PASSWORD) and in the file SENTINEL_MIGRATE_ENV_FILE
  names (SENTINEL_DB_MIGRATE_PASSWORD), set them in the database with
  ``scripts/postgres-roles.sh apply``, then ``docker compose up -d``.
* ``apply`` was interrupted: it is one transaction, so nothing changed (no
  roles, no schema, no ownership, or the passwords as they were); run it
  again.
* The roles differ from what ``apply`` provisioned, or the cluster's history
  is partial or unknown (state C of sentinel/db_roles.py): every process and
  ``apply`` refuse, and name what differs. Undo it by hand, as ``status``
  names it; when roles or the record of their activation are missing,
  partial or another activation's, rebuild as below. Nothing in Sentinel
  takes over roles it did not create.
* The data of an installation is to come into a new, dedicated cluster
  that is provisioned like a new installation: ``python3 -m
  sentinel.recovery`` (docs/server-deployment.md, "Recover the data of an
  installation into a new cluster") restores it as the runtime login, never
  as a superuser and without ``--disable-triggers``, verifies it, and starts
  nothing until it has: until ``activate`` admits it, a record only the owner
  role can change makes every start of web and migrate refuse the database.
  The old cluster is only read.
* Running as a superuser again is not supported in place: the tables'
  defaults and constraints were the owner's to define, and a superuser who
  writes rows runs them; and while the roles exist, every database of the
  cluster refuses the superuser login. The way back is a new cluster, which
  Sentinel migrates itself and into which only the data comes. The old one
  is never changed: it stays the way back until it is removed by hand.

  1. Stop web. As the bootstrap superuser, take a full dump
     (``pg_dump --format=custom``; ``pg_restore --list`` must read it), a
     dump of the data (``pg_dump --format=custom --data-only
     --exclude-table-data=django_migrations``) and the row count of every
     table in schema public (docs/server-deployment.md shows a query). Keep
     copies of ``.env`` and of the files SENTINEL_MIGRATE_ENV_FILE and
     SENTINEL_BOOTSTRAP_ENV_FILE name.
  2. ``docker compose down`` (never ``--volumes``). In ``.env`` set a new
     ``COMPOSE_PROJECT_NAME`` (a new project gets new volumes),
     ``SENTINEL_POSTGRES_INITIALIZE=true``, ``SENTINEL_DB_ROLES=legacy`` and
     a new ``POSTGRES_PASSWORD``, and remove the separate passwords,
     SENTINEL_MIGRATE_ENV_FILE and SENTINEL_BOOTSTRAP_ENV_FILE. Start the new
     database alone: ``docker compose up -d --wait db``.
  3. Let Sentinel create its tables with the superuser login
     (``docker compose run --rm --no-deps web python manage.py check``: the
     entrypoint migrates first). Empty them but ``django_migrations``
     (``TRUNCATE ... RESTART IDENTITY CASCADE``: the migrations add rows of
     their own), then ``pg_restore --data-only --disable-triggers
     --single-transaction --exit-on-error`` the data dump into the database.
  4. Before anything else runs, check the new database: its row counts equal
     those of step 1, table by table (``django_migrations`` too: both are at
     the same migrations), ``manage.py migrate --check`` succeeds, and it has
     neither the schema ``sentinel_restricted`` nor the three roles. Should
     anything differ, roll back.
  5. Remove ``SENTINEL_POSTGRES_INITIALIZE`` from ``.env``, start everything
     (``docker compose up -d``) and check the console.

  Rolling back, at any point: ``docker compose down``, restore the copies of
  step 1 and ``docker compose up -d``. That starts the old project on its own
  volume, exactly as step 1 left it; whatever the new one accepted since is
  not in it. Remove the old project's volume only once a backup of the new
  database has been restored elsewhere and checked.

This module does not import Django: the container entrypoint runs it before
the application starts (``python -m sentinel.database mode|wait|verify``).
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

# The password variables. With the separate logins each belongs to one place:
# the bootstrap superuser's to the db service and the operator, the runtime
# login's to web, the migration login's to the migrate service.
BOOTSTRAP_PASSWORD = "POSTGRES_PASSWORD"
RUNTIME_PASSWORD = "SENTINEL_DB_PASSWORD"
MIGRATION_PASSWORD = "SENTINEL_DB_MIGRATE_PASSWORD"

# Created by sentinel/db_roles.py when it provisions the separate logins.
RESTRICTED_SCHEMA = "sentinel_restricted"

# The advisory lock ("SENTINEL") that keeps provisioning and superuser logins
# apart. ``apply`` holds it exclusively for its whole transaction; a superuser
# login admitted here holds it shared for as long as its session lasts.
PROVISIONING_LOCK = 0x53454E54494E454C

# Whether the login can act as a superuser.
SUPERUSER = """EXISTS (SELECT FROM pg_catalog.pg_roles r
                WHERE r.rolsuper AND pg_catalog.pg_has_role(session_user, r.oid, 'MEMBER'))"""

# NULL for a login that cannot act as a superuser; otherwise whether its
# session now holds the lock (in its own database, as advisory locks are).
ADMISSION_QUERY = f"SELECT CASE WHEN {SUPERUSER} THEN pg_catalog.pg_try_advisory_lock_shared({PROVISIONING_LOCK}) END"

# Whether ``apply`` holds the lock in any database of the cluster. Read after
# the admission and before the evidence: either ``apply`` finds this session's
# lock, or this finds ``apply``'s, or ``apply`` has finished and the evidence
# shows what it committed.
PROVISIONING_QUERY = f"""
SELECT EXISTS (SELECT FROM pg_catalog.pg_locks
                WHERE locktype = 'advisory' AND mode = 'ExclusiveLock' AND objsubid = 1
                  AND classid = {PROVISIONING_LOCK >> 32} AND objid = {PROVISIONING_LOCK & 0xFFFFFFFF})
"""

# Whether the login can act as a superuser, and the evidence of the separate
# arrangement: the schema in this database, and the roles in the cluster.
# Catalogs only, qualified, so nothing a database owner defined runs in a
# superuser session.
GUARD_QUERY = f"""
SELECT {SUPERUSER},
       session_user,
       EXISTS (SELECT FROM pg_catalog.pg_namespace WHERE nspname = '{RESTRICTED_SCHEMA}'),
       (SELECT pg_catalog.string_agg(rolname, ', ' ORDER BY rolname) FROM pg_catalog.pg_roles
         WHERE rolname IN ('{OWNER_ROLE}', '{MIGRATION_ROLE}', '{RUNTIME_ROLE}'))
"""

# Django's record of the migrations. The owner's default privileges give it the
# runtime's DML when migrate creates it; the owner (the migrate service's
# session) takes them back in the same transaction (sentinel/postgresql), then
# checks that no path is left, its own SET memberships and PUBLIC included.
MIGRATIONS_TABLE = "django_migrations"
MIGRATIONS_TABLE_PRIVILEGES = (
    f"REVOKE ALL ON TABLE public.{MIGRATIONS_TABLE} FROM {RUNTIME_ROLE}",
    f"GRANT SELECT ON TABLE public.{MIGRATIONS_TABLE} TO {RUNTIME_ROLE}",
)
# What the runtime login could do to the record beyond reading it, as "<privilege> as
# <role>": as itself (which includes PUBLIC and the roles it inherits from) or as a
# role it may SET ROLE to, on the table or on any column; changing rows, attaching a
# trigger to the owner's writes, or handing a privilege on. NULL when there is no
# record or no runtime login, or nothing of the kind. Read before every migrate
# (sentinel/postgresql ``prepare_database``) and when migrate creates the record.
MIGRATIONS_TABLE_UNSAFE = f"""
SELECT pg_catalog.string_agg(DISTINCT pg_catalog.format('%s as %s', p.privilege, r.rolname), ', '
                             ORDER BY pg_catalog.format('%s as %s', p.privilege, r.rolname))
  FROM (SELECT pg_catalog.to_regclass('public.{MIGRATIONS_TABLE}') AS record) m,
       pg_catalog.pg_roles a, pg_catalog.pg_roles r,
       pg_catalog.unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'TRIGGER',
                               'SELECT WITH GRANT OPTION', 'REFERENCES WITH GRANT OPTION']) p(privilege)
 WHERE a.rolname = '{RUNTIME_ROLE}' AND pg_catalog.pg_has_role(a.oid, r.oid, 'SET')
   AND CASE WHEN p.privilege IN ('INSERT', 'UPDATE', 'SELECT WITH GRANT OPTION', 'REFERENCES WITH GRANT OPTION')
            THEN pg_catalog.has_any_column_privilege(r.oid, m.record, p.privilege)
            ELSE pg_catalog.has_table_privilege(r.oid, m.record, p.privilege) END
"""

# The sessions that only check: PostgreSQL refuses every write in them.
READ_ONLY = "-c default_transaction_read_only=on"
# A recovery into this database (sentinel/recovery.py) records its state as the comment on django_migrations, which
# only the owner role may change: the runtime login cannot. Until the recovery admits the database, every start of
# web and migrate refuses it; a database nothing was recovered into has no such comment.
RECOVERY_RECORD = "public.django_migrations"
RECOVERY_MARK = "sentinel-recovery: "
RECOVERY_ADMITTED = RECOVERY_MARK + "admitted"
RECOVERY_QUERY = f"SELECT pg_catalog.obj_description(pg_catalog.to_regclass('{RECOVERY_RECORD}'), 'pg_class')"

# The entrypoint's wait for the database: attempts, connect timeout and pause
# (seconds), about two minutes in all.
WAIT_ATTEMPTS = 30
WAIT_CONNECT_TIMEOUT = 3
WAIT_PAUSE = 1


class SuperuserRefused(RuntimeError):
    """A superuser login where the separate logins were provisioned."""


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


def password_setting(environ: Mapping[str, str]) -> str:
    """The environment variable that holds this process's password."""
    if roles(environ) == LEGACY:
        return BOOTSTRAP_PASSWORD
    return MIGRATION_PASSWORD if access(environ) == MIGRATE else RUNTIME_PASSWORD


def foreign_passwords(environ: Mapping[str, str]) -> list[str]:
    """The variables of passwords this process holds but must not have (an empty
    value is no password: compose.yml blanks what a service must not get)."""
    if roles(environ) == LEGACY:
        # Separate passwords where SENTINEL_DB_ROLES says legacy: half a switch.
        foreign = (RUNTIME_PASSWORD, MIGRATION_PASSWORD)
    elif access(environ) == MIGRATE:
        foreign = (BOOTSTRAP_PASSWORD, RUNTIME_PASSWORD)
    else:
        foreign = (BOOTSTRAP_PASSWORD, MIGRATION_PASSWORD)
    return [name for name in foreign if environ.get(name, "").strip()]


def check_passwords(environ: Mapping[str, str]) -> None:
    """Refuse to go on with a password this process must not have. The message
    names variables, never values."""
    names = foreign_passwords(environ)
    if not names:
        return
    listed = " and ".join(names)
    verb = "is" if len(names) == 1 else "are"
    if roles(environ) == LEGACY:
        raise RuntimeError(
            f"{listed} {verb} set, but SENTINEL_DB_ROLES is legacy: set SENTINEL_DB_ROLES=separate "
            "to use the separate logins, or remove the separate passwords (docs/server-deployment.md)"
        )
    raise RuntimeError(
        f"{listed} {verb} set, but with SENTINEL_DB_ROLES=separate a process with SENTINEL_DB_ACCESS="
        f"{access(environ)} may only hold {password_setting(environ)}: keep the other passwords out of "
        "the env files of this service (docs/server-deployment.md)"
    )


def login(environ: Mapping[str, str]) -> Login:
    """The user, password and Django options of this process's connection."""
    check_passwords(environ)
    arrangement, use = roles(environ), access(environ)
    if arrangement == LEGACY:
        # Exactly what the settings read before the arrangements existed (an
        # empty password stays allowed: trust authentication, as in CI).
        return Login(_required(environ, "POSTGRES_USER"), _required(environ, BOOTSTRAP_PASSWORD))
    if use == MIGRATE:
        return Login(
            MIGRATION_ROLE,
            _secret(environ, MIGRATION_PASSWORD),
            {"assume_role": OWNER_ROLE},
        )
    return Login(RUNTIME_ROLE, _secret(environ, RUNTIME_PASSWORD))


def _fetch(connection, query):
    """The row ``query`` returns, in a transaction of its own (a snapshot of its own,
    whatever the isolation level), with the catalog first on the search path."""
    try:
        connection.execute("SELECT pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', true)")
        return connection.execute(query).fetchone()
    finally:
        connection.rollback()


def refusal(connection) -> str | None:
    """Why a new psycopg ``connection`` must not be used, or None.

    Run before the connection does anything else; it leaves no transaction
    and no setting behind. A superuser login it admits keeps the shared
    provisioning lock until its session ends, so ``apply`` cannot commit
    while the connection is open; the caller closes a refused connection,
    which lets the lock go.
    """
    (admitted,) = _fetch(connection, ADMISSION_QUERY)
    if admitted is not None and (not admitted or _fetch(connection, PROVISIONING_QUERY)[0]):
        return (
            "python -m sentinel.db_roles apply is provisioning the separate logins in this cluster, "
            "and a superuser login is not admitted while it runs; once it has committed, set "
            "SENTINEL_DB_ROLES=separate with the passwords of the separate logins (see sentinel/database.py)"
        )
    superuser, user, schema, roles = _fetch(connection, GUARD_QUERY)
    if not superuser or not (schema or roles):
        return None
    evidence = f"schema {RESTRICTED_SCHEMA} exists in this database" if schema else f"the cluster has the roles {roles}"
    return (
        f"the separate logins are provisioned ({evidence}), and {user}, a superuser login, "
        "may not be used for Sentinel there. Set SENTINEL_DB_ROLES=separate with the passwords of "
        f"{RUNTIME_ROLE} (SENTINEL_DB_PASSWORD) and {MIGRATION_ROLE} (SENTINEL_DB_MIGRATE_PASSWORD); "
        "if they are lost, set new ones with python -m sentinel.db_roles apply (see sentinel/database.py)"
    )


def check(connection) -> None:
    """Raise SuperuserRefused when ``connection`` may not be used."""
    reason = refusal(connection)
    if reason is not None:
        raise SuperuserRefused(reason)


def wait(environ: Mapping[str, str]) -> int:
    """Wait until the database accepts this process's login, and may be used
    with it; 0 when it does."""
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
            ) as connection:
                reason = refusal(connection)
        except psycopg.OperationalError as exc:
            # A wrong password does not get better by waiting.
            refused = "authentication failed" in str(exc)
            if attempt == WAIT_ATTEMPTS or refused:
                print(f"entrypoint: database unavailable: {exc}", file=sys.stderr)
                if refused:
                    print(
                        f"entrypoint: check {password_setting(environ)} for {credentials.user}; "
                        "python -m sentinel.db_roles apply sets new passwords for the separate logins",
                        file=sys.stderr,
                    )
                return 1
            time.sleep(WAIT_PAUSE)
            continue
        except psycopg.Error as exc:
            # The check itself failed: nothing runs unchecked.
            print(f"entrypoint: the database could not be checked: {exc}", file=sys.stderr)
            return 1
        if reason is not None:
            print(f"entrypoint: {reason}", file=sys.stderr)
            return 1
        return 0
    return 1


def deviation(connection, database: str) -> str | None:
    """How the roles differ from what Sentinel provisions, or None: the first
    deviation that ``status`` of sentinel/db_roles.py would report, by the same
    checks, but the passwords. Readable by any login; it leaves no transaction
    behind."""
    import psycopg

    from sentinel import db_roles  # it imports this module

    try:
        check = db_roles.startup_check(database)
    except db_roles.InputError as exc:
        return str(exc)
    try:
        connection.execute("SELECT pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', true)")
        connection.execute(check)
    except psycopg.errors.RaiseException as exc:
        message = exc.diag.message_primary or str(exc)
        if not message.startswith("sentinel-roles: "):
            raise
        return message.removeprefix("sentinel-roles: ")
    finally:
        connection.rollback()
    return None


def recovery_state(connection) -> str | None:
    """None when the database may start: nothing was recovered into it, or the recovery admitted it. Otherwise the
    state its record gives (a recovery that is under way, interrupted, rejected or not yet activated)."""
    try:
        row = connection.execute(RECOVERY_QUERY).fetchone()
    finally:
        connection.rollback()  # like the check before it: no transaction is left behind
    comment = row[0] if row else None
    if comment is None or not comment.startswith(RECOVERY_MARK) or comment == RECOVERY_ADMITTED:
        return None
    return comment.removeprefix(RECOVERY_MARK)


def verify(environ: Mapping[str, str]) -> int:
    """Check, after the wait, that the roles are what Sentinel provisions (the
    invariants of ``status``): the runtime login holds what Sentinel gives it and
    nothing more. The migrate service checks before it runs anything and after
    the migrations, web before it starts; in a read-only session, so nothing
    changes, whatever the check finds. 0 when they are."""
    import psycopg

    if roles(environ) != SEPARATE:
        print("entrypoint: there is nothing to verify with SENTINEL_DB_ROLES=legacy", file=sys.stderr)
        return 2
    credentials = login(environ)
    database = _required(environ, "POSTGRES_DB")
    try:
        with psycopg.connect(
            host=environ.get("POSTGRES_HOST", "db"),
            port=environ.get("POSTGRES_PORT", "5432"),
            dbname=database,
            user=credentials.user,
            password=credentials.password,
            connect_timeout=WAIT_CONNECT_TIMEOUT,
            options=READ_ONLY,
        ) as connection:
            check(connection)
            problem = deviation(connection, database)
            recovering = None if problem is not None else recovery_state(connection)
    except psycopg.Error as exc:
        print(f"entrypoint: the database roles could not be checked: {exc}", file=sys.stderr)
        return 1
    if recovering is not None:
        print(
            f"entrypoint: a recovery into this database has not been admitted ({recovering}): it is not started. "
            "python -m sentinel.recovery activate admits a verified one; a rejected or interrupted one is thrown away "
            "and made again (docs/server-deployment.md)",
            file=sys.stderr,
        )
        return 1
    if problem is not None:
        print(
            f"entrypoint: the database roles differ from what Sentinel provisions: {problem}. "
            "Correct that by hand, as scripts/postgres-roles.sh status names it (apply changes nothing "
            "while the roles differ from what it provisioned), then start again",
            file=sys.stderr,
        )
        return 1
    return 0


def main(argv: list[str], environ: Mapping[str, str]) -> int:
    command = argv[1] if len(argv) == 2 else ""
    try:
        if command == "mode":
            # Before anything runs: a process with a password it must not have stops here.
            check_passwords(environ)
            print(roles(environ), access(environ))
            return 0
        if command == "wait":
            return wait(environ)
        if command == "verify":
            return verify(environ)
    except RuntimeError as exc:
        print(f"entrypoint: {exc}", file=sys.stderr)
        return 2 if command == "mode" else 1
    print("usage: python -m sentinel.database mode|wait|verify", file=sys.stderr)
    return 2


if __name__ == "__main__":  # pragma: no cover - exercised through the entrypoint
    import os

    sys.exit(main(sys.argv, os.environ))
