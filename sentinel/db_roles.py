"""SQL that provisions the PostgreSQL roles of SENTINEL_DB_ROLES=separate.

The roles (names fixed in sentinel/database.py):

``sentinel_owner``
    NOLOGIN. Owns every object of the application in schema ``public``.
``sentinel_migrate``
    LOGIN, NOINHERIT. A member of ``sentinel_owner`` WITH INHERIT FALSE,
    SET TRUE: beyond CONNECT it holds no privilege of its own and becomes the
    owner only by ``SET ROLE`` (Django's ``assume_role``). Its password
    therefore carries the owner's authority over the schema and is as
    sensitive as that.
``sentinel_app``
    LOGIN, NOINHERIT, a member of no role. SELECT, INSERT, UPDATE and DELETE
    on the application's tables, SELECT only on ``django_migrations``; no
    privilege on sequences (identity columns do not need one), no DDL.

This module never connects to PostgreSQL. ``python3 -m sentinel.db_roles``
prints a psql program for the operator to run as the cluster's bootstrap
superuser, over the database container's local socket, which needs no
password. scripts/postgres-roles.sh does that with Docker Compose; by hand::

    nonce=$(python3 -c 'import secrets; print(secrets.token_hex(16))')
    docker compose config --format json |
        python3 -m sentinel.db_roles apply --compose-config - --nonce "$nonce" |
        docker compose exec -T db sh -c 'psql -X -q -U "$POSTGRES_USER" -d "$POSTGRES_DB" -f -' |
        tail -n 1 | grep -qx "sentinel-roles: committed $nonce"

psql exits with status 0 even when its input stops before COMMIT (nothing is
committed then), and when the generator refuses (exit status 2) psql gets an
empty program: success is only that last line, with the caller's nonce. The
program holds SCRAM verifiers of both logins: kept in a file, it must stay
private (umask 077) and be deleted afterwards.

``apply`` reads the cluster's provisioning history first (``LIFECYCLE``), in
its transaction and under its lock, and acts on it:

A  first activation (none of the three roles, no record of an activation):
   it creates the roles, their passwords, memberships, grants, default
   privileges and settings, adopts the tables listed, and records the
   activation: schema ``sentinel_restricted``, owned by the bootstrap
   superuser, open to no one, its comment naming this database and the three
   roles by OID (``ACTIVATION``). From then on no Sentinel process connects as
   a superuser (sentinel/database.py), whatever its environment.
B  activated (the three roles, and the record of their activation as A left
   it): it checks every invariant before it changes anything
   (``sentinel_reapply``), then sets the passwords, which is all it changes:
   run again with the same passwords, nothing changes but the verifiers'
   salts; with other passwords, it rotates them. ``--adopt-table`` is refused.
C  anything else (some of the roles only, roles without the record or the
   record without them, a record owned or opened by someone else or naming
   another database or other roles, or in B anything that differs from what
   it provisioned): it refuses, names what it found, and changes nothing. It
   never takes over a role it did not create, nor repairs what it does not
   explain: undo it by hand, or rebuild (sentinel/database.py).

Each run is one transaction that ends with a check of every invariant: it
commits all of it or nothing, so an interrupted run leaves the state as it
was (A, or B with the old passwords). It reads POSTGRES_DB,
SENTINEL_DB_PASSWORD and SENTINEL_DB_MIGRATE_PASSWORD, from the environment
or, with ``--compose-config``, as Compose gives them to the db, web and
migrate services; then it refuses a configuration that gives web or migrate
a password not its own. ``status`` reads the history and checks the
invariants in a read-only transaction, and reads POSTGRES_DB.

An existing installation, whose tables belong to the bootstrap superuser,
lists each of them, partitions included, with ``--adopt-table`` (``apply``
without it prints the list). Stop ``web`` and every other superuser session
first. A Sentinel process that connects as a superuser holds an advisory lock
for as long as its connection is open, and ``apply`` refuses while one does,
in any database of the cluster, and keeps new ones out until it ends
(sentinel/database.py); it also refuses while other superuser sessions use
the database, which it names. The runtime role has no
privilege on sequences, so adopted tables must number their rows with
identity columns, as Django does since 4.1; a ``serial`` column would stay
unwritable.

Tables the owner creates later get the runtime's privileges from the default
privileges, but ``django_migrations``, which decides the DDL the owner runs:
Sentinel's database backend takes them back in the transaction that creates
it (sentinel/database.py). A ``django_migrations`` the runtime role may write
is refused by ``status`` and ``apply`` and stops every Sentinel process
before anything runs, until the operator revokes what gives it.

The program sends SCRAM-SHA-256 verifiers, never a password, and keeps them
out of PostgreSQL's statement logging, its activity view and
pg_stat_statements. It runs no code of the database: functions and catalogs
are qualified, search_path is ``pg_catalog, pg_temp`` (where its types and
operators resolve) and no application table is written.
It refuses to change anything when the database holds what the application
never creates and other sessions could be made to run (functions,
operators, casts, types other than composite and array types, triggers,
rules, policies, views, extensions or event triggers in ``public``, or
functions, operators and such types of the three roles anywhere), when the
roles serve another database as well, when roles other than the three would
lose or gain anything, when the schema is open to everyone, or when the
runtime role could create temporary tables (TEMPORARY on a database it may
connect to, held by PUBLIC as PostgreSQL grants by default, by the role
itself or by a role it can become), or while other superuser sessions use
the database. Its final check also refuses privileges of the three roles
that it does not give, in this database or the cluster's shared catalogs
(EXECUTE on a function, SET on a parameter, TEMPORARY or grant options on
the database), and objects of the owner outside schema ``public``. It
revokes privileges only from ``sentinel_app``, and only on relations in
schema ``public``.

What needs the bootstrap superuser (``apply`` checks it is one): creating,
altering and setting passwords of roles; granting membership in a role;
reading ``pg_authid``; the logging and statistics settings; granting on the
database (owned by the bootstrap superuser) and on schema ``public`` (owned
by ``pg_database_owner``); changing the owner of tables; the owner's default
privileges; and granting and revoking the runtime role's privileges on the
tables, their columns and sequences, which belong to ``sentinel_owner``.

Roles belong to the whole cluster, so the separate logins are supported on a
cluster of Sentinel's own only, the db service of its Compose project:
``apply`` (before it changes anything), ``status`` and every start refuse a
cluster that holds another database (but ``postgres``, ``template0`` and
``template1``) or another role (but the bootstrap superuser and PostgreSQL's
predefined ``pg_`` roles) (``DEDICATED_CLUSTER``). That is a compatibility
check: it proves nothing about how the cluster was made or what a superuser
did in it.

What no check here can rule out, because the owner defines it: the column
defaults, CHECK constraints, generated columns and index expressions of the
application's tables may call built-in functions, which act with the
privileges of whoever writes a row. Whoever has the migration password can
therefore plant code that a superuser runs by writing to these tables: by
hand, in a restore, or as Django with SENTINEL_DB_ROLES=legacy. ``SET ROLE``
does not prevent that (the code can reset the role); write to them only as
``sentinel_migrate`` or ``sentinel_app``. Also not covered: the bootstrap
superuser's own sessions, which keep their own search_path (qualify names or
``SET search_path = pg_catalog, pg_temp``); logging beyond PostgreSQL's
statement logging (pgaudit, debug_print_*), which may see the verifiers.

What the checks cover (UNEXPECTED_ACCESS, FOREIGN_OBJECTS, CONNECT_ELSEWHERE),
in ``apply``'s preflight, before any role changes (PUBLIC's privileges are
everyone's, so they are checked before the roles exist), in its final check
and in ``status``: every object of the application's database and every
object the cluster shares (databases, tablespaces, parameters), whatever
gives a managed role a privilege on it: a grant to that role, to PUBLIC, or
to a role it belongs to (they belong to none but the owner, which the
migration login may only SET). What initdb made, and only that, has an OID
below 16384 (FIRST_NORMAL_OID): it keeps what initdb gave every role
(pg_init_privs); anything made later, in pg_catalog or information_schema
too, has no such baseline, and what of it runs code (functions, casts,
operators, types and the like) is refused outright, since a cast or an
operator calls its function whether its schema is usable or not. The
catalogs of another database cannot be read from this one, so the login
roles may not connect to any other database, and no session of theirs may
still be open in one (REVOKE CONNECT ends none): what those databases hold
is then out of their reach. This program ends no session; it names them.

Before the first ``apply``, the operator revokes from PUBLIC what this program
never revokes itself: TEMPORARY on the application's database, CONNECT on
every other database of the cluster (``postgres`` and ``template1``, by
default), and, in the application's database (function privileges belong to
each database), EXECUTE on the functions that create large objects, as the
bootstrap superuser, granting them back to any other role that needs them.
``apply`` refuses until then and prints the statements::

    REVOKE TEMPORARY ON DATABASE <database> FROM PUBLIC;
    REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;
    REVOKE CONNECT ON DATABASE template1 FROM PUBLIC;
    REVOKE EXECUTE ON FUNCTION pg_catalog.lo_creat(integer), pg_catalog.lo_create(oid),
        pg_catalog.lo_from_bytea(oid, bytea) FROM PUBLIC;

``apply`` (before anything changes and in its final check), ``status`` and
every start refuse while a managed role may create a large object
(``LARGE_OBJECTS``): through PUBLIC, by a grant of its own or of a role it
belongs to, by any function that creates one (an alias of one included), or
by a large-object function this program does not know.

PostgreSQL 16 to 18 only. ``GRANT ... WITH INHERIT FALSE, SET TRUE`` and the
membership options in ``pg_auth_members`` exist from 16; the MAINTAIN
privilege exists from 17 and is only ever looked for (and revoked from
``sentinel_app``) there; nothing is granted with ALL, which means a
different set of privileges in 17 and later.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import re
import secrets
import sys
from collections.abc import Mapping, Sequence
from dataclasses import dataclass

from sentinel.database import (
    BOOTSTRAP_PASSWORD,
    MIGRATION_ROLE,
    MIGRATIONS_TABLE,
    OWNER_ROLE,
    PROVISIONING_LOCK,
    RESTRICTED_SCHEMA,
    RUNTIME_ROLE,
)

DATABASE_SETTING = "POSTGRES_DB"
RUNTIME_PASSWORD_SETTING = "SENTINEL_DB_PASSWORD"
MIGRATION_PASSWORD_SETTING = "SENTINEL_DB_MIGRATE_PASSWORD"

SCHEMA = "public"
SEARCH_PATH = "public, pg_temp"

# PostgreSQL's own defaults (scram_iterations, SCRAM_DEFAULT_SALT_LEN).
SCRAM_ITERATIONS = 4096
SCRAM_SALT_BYTES = 16

MIN_SERVER_VERSION = 160000
MAX_SERVER_VERSION = 189999

# Passwords: what `secrets.token_urlsafe` and base64 produce. Nothing that a
# shell, an env file or SASLprep would change (no "~": a shell expands it
# when it sources a .env file), so the verifier computed here matches what
# libpq computes from the same setting.
PASSWORD_MIN_LENGTH = 32
PASSWORD_MAX_LENGTH = 1024
PASSWORD_MIN_DISTINCT = 10
PASSWORD_CHARACTERS = re.compile(r"[A-Za-z0-9._+/=-]+")
PLACEHOLDERS = ("change-me", "change_me", "changeme", "replace-me", "replace-with", "placeholder", "example", "password")

DATABASE_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_-]{0,62}")
RESERVED_DATABASES = frozenset({"postgres", "template0", "template1"})
TABLE_NAME = re.compile(r"[a-z_][a-z0-9_]{0,62}")
MAX_ADOPT_TABLES = 1000

# Taken exclusively for the transaction: it keeps two runs apart, and runs apart
# from Sentinel's superuser logins, which hold it shared (sentinel/database.py).
ADVISORY_LOCK_KEY = PROVISIONING_LOCK

_VERIFIER = re.compile(
    r"SCRAM-SHA-256\$([1-9][0-9]{0,9}):([A-Za-z0-9+/]+={0,2})\$([A-Za-z0-9+/]{43}=):([A-Za-z0-9+/]{43}=)"
)
_MD5_HASH = re.compile(r"md5[0-9a-f]{32}")


class InputError(ValueError):
    """An input the generator refuses. The message never contains a password."""


@dataclass(frozen=True)
class Program:
    """A psql program, and the token it prints once it has finished."""

    sql: str
    nonce: str


# --- SCRAM-SHA-256 verifiers (RFC 5802, RFC 7677) ----------------------------


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def _b64_decode(text: str) -> bytes:
    data = base64.b64decode(text, validate=True)
    if _b64(data) != text:  # only the canonical encoding
        raise InputError("not canonical base64")
    return data


def scram_keys(password: str, salt: bytes, iterations: int) -> tuple[bytes, bytes]:
    """StoredKey and ServerKey of ``password``.

    ``password`` must be printable ASCII without spaces: SASLprep, which
    PostgreSQL and libpq apply, leaves that unchanged.
    """
    if not password or any(not 0x21 <= ord(character) <= 0x7E for character in password):
        raise InputError("a SCRAM password here must be printable ASCII without spaces")
    if not salt:
        raise InputError("the salt is empty")
    if not 1 <= iterations <= 2**31 - 1:
        raise InputError("the iteration count is out of range")
    salted = hashlib.pbkdf2_hmac("sha256", password.encode("ascii"), salt, iterations)
    client_key = hmac.new(salted, b"Client Key", "sha256").digest()
    server_key = hmac.new(salted, b"Server Key", "sha256").digest()
    return hashlib.sha256(client_key).digest(), server_key


def scram_verifier(password: str, *, salt: bytes | None = None, iterations: int = SCRAM_ITERATIONS) -> str:
    """The SCRAM-SHA-256 verifier PostgreSQL stores for ``password``."""
    salt = secrets.token_bytes(SCRAM_SALT_BYTES) if salt is None else salt
    stored_key, server_key = scram_keys(password, salt, iterations)
    verifier = f"SCRAM-SHA-256${iterations}:{_b64(salt)}${_b64(stored_key)}:{_b64(server_key)}"
    parse_scram_verifier(verifier)
    return verifier


def parse_scram_verifier(text: str) -> tuple[int, bytes, bytes, bytes]:
    """Iterations, salt, StoredKey and ServerKey of a verifier, or InputError.

    A strict part of what PostgreSQL parses as a SCRAM secret: canonical
    base64, 32-byte keys, 1 to 2**31 - 1 iterations. What PostgreSQL would
    instead take for a plaintext password and hash, a URL-safe alphabet or a
    stray newline for instance, is refused with the rest: never send that.
    """
    match = _VERIFIER.fullmatch(text) if isinstance(text, str) else None
    if match is None:
        raise InputError("not a SCRAM-SHA-256 verifier")
    iterations = int(match[1])
    if iterations > 2**31 - 1:
        raise InputError("the iteration count of the verifier is out of range")
    try:
        salt, stored_key, server_key = (_b64_decode(part) for part in match.group(2, 3, 4))
    except (ValueError, InputError) as exc:
        raise InputError("the verifier is not valid base64") from exc
    if not salt or len(stored_key) != 32 or len(server_key) != 32:
        raise InputError("the verifier has keys of the wrong size")
    return iterations, salt, stored_key, server_key


# --- Inputs ------------------------------------------------------------------


def validate_password(setting: str, value: str | None) -> str:
    """``value`` as a login password, or InputError naming ``setting``."""
    if value is None:
        raise InputError(f"{setting} is not set")
    if not value:
        raise InputError(f"{setting} is empty")
    if value.upper().startswith("SCRAM-SHA-256$"):
        raise InputError(f"{setting} holds a SCRAM verifier: it must hold the password itself")
    if _MD5_HASH.fullmatch(value):
        raise InputError(f"{setting} holds an MD5 hash: it must hold the password itself")
    if not PASSWORD_CHARACTERS.fullmatch(value):
        raise InputError(
            f"{setting} may only contain letters, digits and - _ . + / = "
            "(generate one with: python3 -c 'import secrets; print(secrets.token_urlsafe(48))')"
        )
    if not PASSWORD_MIN_LENGTH <= len(value) <= PASSWORD_MAX_LENGTH:
        raise InputError(f"{setting} must be {PASSWORD_MIN_LENGTH} to {PASSWORD_MAX_LENGTH} characters long")
    lowered = value.lower()
    if any(placeholder in lowered for placeholder in PLACEHOLDERS):
        raise InputError(f"{setting} still looks like a placeholder")
    if len(set(value)) < PASSWORD_MIN_DISTINCT:
        raise InputError(f"{setting} has too few different characters to be a generated password")
    return value


def validate_database(value: str | None) -> str:
    if value is None:
        raise InputError(f"{DATABASE_SETTING} is not set")
    if not DATABASE_NAME.fullmatch(value):
        raise InputError(f"{DATABASE_SETTING} must be a name of letters, digits, _ and - (at most 63)")
    if value.lower() in RESERVED_DATABASES:
        raise InputError(f"{DATABASE_SETTING} names a database of PostgreSQL itself, not the application's")
    return value


def validate_tables(names: Sequence[str]) -> tuple[str, ...]:
    if isinstance(names, str):
        raise InputError("the tables to adopt must be a list of names")
    for name in names:
        if not isinstance(name, str) or not TABLE_NAME.fullmatch(name):
            raise InputError("a table to adopt must be a lowercase name of letters, digits and _ (at most 63)")
    tables = tuple(sorted(set(names)))
    if len(tables) > MAX_ADOPT_TABLES:
        raise InputError(f"at most {MAX_ADOPT_TABLES} tables can be adopted at once")
    return tables


def _ident(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def _literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def _shown(expression: str) -> str:
    """``expression`` for a message: names the owner chose may hold control characters."""
    return f"pg_catalog.regexp_replace({expression}, '[[:cntrl:]]', '?', 'g')"


# --- The program ---------------------------------------------------------------

OWNER, MIGRATE, APP = _ident(OWNER_ROLE), _ident(MIGRATION_ROLE), _ident(RUNTIME_ROLE)
OWNER_NAME, MIGRATE_NAME, APP_NAME = _literal(OWNER_ROLE), _literal(MIGRATION_ROLE), _literal(RUNTIME_ROLE)
MANAGED = f"{OWNER_NAME}, {MIGRATE_NAME}, {APP_NAME}"
MANAGED_OIDS = "owner_oid, migrate_oid, app_oid"
PUBLIC_SCHEMA = f"{_literal(SCHEMA)}::pg_catalog.regnamespace"
RESTRICTED_NAME = _literal(RESTRICTED_SCHEMA)


def _header(apply: bool) -> str:
    contents = "-- It holds SCRAM-SHA-256 verifiers (never a password): keep it private, delete it after use.\n"
    return (
        "-- Generated by sentinel/db_roles.py. Run with psql as the bootstrap superuser\n"
        "-- (not with --single-transaction: the program is one transaction itself).\n"
        + (contents if apply else "")
        + "\\set ON_ERROR_STOP on\n"
        + "\\set VERBOSITY terse\n"
    )


# Built-ins only, whatever an untrusted role may have created elsewhere, for
# the whole session.
SECURE_PATH = "SET search_path = pg_catalog, pg_temp;\n"

# Before BEGIN: log_transaction_sample_rate is read when a transaction starts.
# Each needs a superuser. track_activities keeps the statements out of
# pg_stat_activity and out of the deadlock reports of other sessions;
# pg_stat_statements, when loaded, would keep them.
QUIET_LOGS = """\
SET log_statement = 'none';
SET log_min_error_statement = 'panic';
SET log_min_duration_statement = -1;
SET log_min_duration_sample = -1;
SET log_transaction_sample_rate = 0;
SET track_activities = off;
SET pg_stat_statements.track = 'none';
"""

LOCK = f"""\
DO $sentinel_lock$
DECLARE
  locked boolean;
  holders text;
BEGIN
  locked := pg_catalog.pg_try_advisory_xact_lock({ADVISORY_LOCK_KEY});
  -- Advisory locks belong to one database: a Sentinel superuser login of another
  -- database holds its shared lock there, and pg_locks shows the whole cluster.
  -- Read after the lock is taken (sentinel/database.py PROVISIONING_QUERY).
  SELECT pg_catalog.string_agg(CASE WHEN l.pid IS NULL THEN 'a prepared transaction (pg_prepared_xacts)'
                                    ELSE pg_catalog.format('%s (pid %s, database %s, %s)', a.usename, l.pid, d.datname,
                                                           CASE l.mode WHEN 'ShareLock' THEN 'a Sentinel superuser login' ELSE 'another run' END)
                               END, ', ' ORDER BY l.pid) INTO holders
    FROM pg_catalog.pg_locks l LEFT JOIN pg_catalog.pg_stat_activity a ON a.pid = l.pid
         LEFT JOIN pg_catalog.pg_database d ON d.oid = l.database
   WHERE l.locktype = 'advisory' AND l.granted
     AND l.classid = {ADVISORY_LOCK_KEY >> 32} AND l.objid = {ADVISORY_LOCK_KEY & 0xFFFFFFFF} AND l.objsubid = 1
     AND l.pid IS DISTINCT FROM pg_catalog.pg_backend_pid();
  IF NOT locked OR holders IS NOT NULL THEN
    -- Any role may take an advisory lock: say who holds this one.
    RAISE EXCEPTION 'sentinel-roles: the lock of this program is held by %: stop web, the migrate service and every manage.py command that connects as a superuser, let another run finish, or end those sessions (pg_terminate_backend), and run this again', {_shown("COALESCE(holders, 'a session that has just let it go')")};
  END IF;
END
$sentinel_lock$;
"""

# What the application never creates, and other sessions (a superuser's by
# hand, a restore) could be made to run: refused before anything changes,
# and again in the final check.
TRIPWIRE = f"""\
  SELECT pg_catalog.string_agg(item, ', ' ORDER BY item) INTO found FROM (
    SELECT 'function ' || p.oid::pg_catalog.regprocedure::text AS item
      FROM pg_catalog.pg_proc p
      WHERE p.pronamespace = {PUBLIC_SCHEMA} OR p.proowner IN ({MANAGED_OIDS})
    UNION ALL SELECT 'operator ' || o.oid::pg_catalog.regoperator::text
      FROM pg_catalog.pg_operator o
      WHERE o.oprnamespace = {PUBLIC_SCHEMA} OR o.oprowner IN ({MANAGED_OIDS})
    UNION ALL SELECT 'cast ' || pg_catalog.format('(%s AS %s)', k.castsource::pg_catalog.regtype, k.casttarget::pg_catalog.regtype)
      FROM pg_catalog.pg_cast k
      JOIN pg_catalog.pg_type s ON s.oid = k.castsource JOIN pg_catalog.pg_type t ON t.oid = k.casttarget
      WHERE s.typnamespace = {PUBLIC_SCHEMA} OR t.typnamespace = {PUBLIC_SCHEMA}
    UNION ALL SELECT 'type ' || ty.oid::pg_catalog.regtype::text
      FROM pg_catalog.pg_type ty
      WHERE (ty.typnamespace = {PUBLIC_SCHEMA} OR ty.typowner IN ({MANAGED_OIDS}))
        AND (ty.typtype IN ('d', 'e', 'r', 'm', 'p') OR (ty.typtype = 'b' AND ty.typelem = 0))
    UNION ALL SELECT 'trigger ' || t.tgname || ' on ' || t.tgrelid::pg_catalog.regclass::text
      FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
      WHERE c.relnamespace = {PUBLIC_SCHEMA} AND NOT t.tgisinternal
    UNION ALL SELECT 'rule ' || r.rulename || ' on ' || r.ev_class::pg_catalog.regclass::text
      FROM pg_catalog.pg_rewrite r JOIN pg_catalog.pg_class c ON c.oid = r.ev_class
      WHERE c.relnamespace = {PUBLIC_SCHEMA} AND r.rulename <> '_RETURN'
    UNION ALL SELECT 'policy ' || pol.polname || ' on ' || pol.polrelid::pg_catalog.regclass::text
      FROM pg_catalog.pg_policy pol JOIN pg_catalog.pg_class c ON c.oid = pol.polrelid
      WHERE c.relnamespace = {PUBLIC_SCHEMA}
    UNION ALL SELECT CASE c.relkind WHEN 'v' THEN 'view ' WHEN 'm' THEN 'materialized view ' ELSE 'foreign table ' END
                     || c.oid::pg_catalog.regclass::text
      FROM pg_catalog.pg_class c
      WHERE c.relnamespace = {PUBLIC_SCHEMA} AND c.relkind IN ('v', 'm', 'f')
    UNION ALL SELECT 'extension ' || x.extname
      FROM pg_catalog.pg_extension x WHERE x.extnamespace = {PUBLIC_SCHEMA}
    UNION ALL SELECT 'event trigger ' || e.evtname FROM pg_catalog.pg_event_trigger e
  ) objects;
  IF found IS NOT NULL THEN
    RAISE EXCEPTION 'sentinel-roles: the database holds objects the application never creates, which other sessions could be made to run; remove them (an extension can move out of schema public instead: ALTER EXTENSION ... SET SCHEMA) and run this again: %', {_shown('found')};
  END IF;
"""

# The roles are the cluster's: anything of theirs in another database means
# they serve another installation, which apply would take over.
OTHER_DATABASES = f"""\
  SELECT pg_catalog.string_agg(d.datname, ', ' ORDER BY d.datname) INTO found
    FROM pg_catalog.pg_database d
   WHERE d.datname <> pg_catalog.current_database()
     AND (EXISTS (SELECT FROM pg_catalog.pg_shdepend s
                   WHERE s.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
                     AND s.refobjid IN ({MANAGED_OIDS})
                     AND (s.dbid = d.oid
                          OR (s.dbid = 0 AND s.classid = 'pg_catalog.pg_database'::pg_catalog.regclass AND s.objid = d.oid)))
          OR EXISTS (SELECT FROM pg_catalog.pg_db_role_setting r
                      WHERE r.setdatabase = d.oid AND r.setrole IN ({MANAGED_OIDS})));
  IF found IS NOT NULL THEN
    RAISE EXCEPTION 'sentinel-roles: the roles also serve database(s) %; a cluster holds one Sentinel database', {_shown('found')};
  END IF;
"""


# No managed role may create schemas in a database of the cluster, held by itself or
# through PUBLIC (whose privileges every role has), whatever database it connects to.
CREATE_ANYWHERE = f"""\
  SELECT pg_catalog.string_agg(d.datname, ', ' ORDER BY d.datname) INTO found
    FROM pg_catalog.pg_database d
   WHERE d.datallowconn
     AND (pg_catalog.has_database_privilege(app_oid, d.oid, 'CREATE')
          OR pg_catalog.has_database_privilege(migrate_oid, d.oid, 'CREATE')
          OR pg_catalog.has_database_privilege(owner_oid, d.oid, 'CREATE'));
  IF found IS NOT NULL THEN
    RAISE EXCEPTION 'sentinel-roles: a managed role may create schemas in database(s) %; revoke CREATE on them from it, or from PUBLIC', {_shown('found')};
  END IF;
"""


# The separate logins are supported on a cluster of Sentinel's own only: the db service of
# its Compose project, which holds Sentinel's database, the three that initdb makes, the
# bootstrap superuser, the three roles and PostgreSQL's predefined roles (CREATE ROLE refuses
# the pg_ prefix, which PostgreSQL reserves for them). A compatibility check: it says nothing
# of how the cluster was made, or what a superuser did in it.
DEDICATED_CLUSTER = f"""\
  SELECT pg_catalog.string_agg(item, ', ' ORDER BY item) INTO found FROM (
    SELECT 'database ' || pg_catalog.quote_ident(d.datname) AS item FROM pg_catalog.pg_database d
     WHERE d.datname NOT IN (pg_catalog.current_database(), 'postgres', 'template0', 'template1')
    UNION ALL
    SELECT 'role ' || pg_catalog.quote_ident(r.rolname) FROM pg_catalog.pg_roles r
     WHERE r.oid <> 10 AND r.rolname NOT IN ({MANAGED}) AND r.rolname !~ '^pg_'
  ) extra;
  IF found IS NOT NULL THEN
    RAISE EXCEPTION 'sentinel-roles: the separate logins are supported on a PostgreSQL cluster of their own only (the db service of this Compose project), and this cluster also has %; move them to another cluster, or Sentinel to a cluster of its own', {_shown('found')};
  END IF;
"""


# What initdb made has an OID below FirstNormalObjectId (src/include/access/transam.h,
# 16384 in every release since long before 16): PostgreSQL gives every object created
# later, by anyone, a higher one, and starts again from it when the counter wraps
# around. pg_dump draws the line between built-in and user objects at the same place.
# Only single-user mode and binary-upgrade mode, both out of reach of a session, assign
# lower ones. Where an object sits (pg_catalog, information_schema) proves nothing.
FIRST_NORMAL_OID = 16384

# The login roles connect to the application's database only: an object of another
# database is out of their reach then, whatever it grants, through PUBLIC or to them.
# The catalogs of other databases cannot be read from here; pg_database can (shared),
# and so can pg_stat_activity, which shows the sessions REVOKE CONNECT leaves open:
# it only keeps new ones out. Only superusers could act as a login role in another
# session (SET ROLE; no other role may be a member of them, checked above).
CONNECT_ELSEWHERE = f"""\
  SELECT pg_catalog.string_agg(remedy, '; ' ORDER BY remedy) INTO found FROM (
    SELECT DISTINCT pg_catalog.format('as %s: REVOKE CONNECT ON DATABASE %I FROM %s',
                                      a.grantor::pg_catalog.regrole, d.datname,
                                      CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::pg_catalog.regrole::text END) AS remedy
      FROM pg_catalog.pg_database d,
           pg_catalog.aclexplode(COALESCE(d.datacl, pg_catalog.acldefault('d', d.datdba))) a
     WHERE d.datallowconn AND d.datname <> pg_catalog.current_database() AND a.privilege_type = 'CONNECT'
       AND (a.grantee = 0 OR a.grantee IN (app_oid, migrate_oid))
  ) remedies;
  IF found IS NOT NULL
     OR EXISTS (SELECT FROM pg_catalog.pg_database d
                 WHERE d.datallowconn AND d.datname <> pg_catalog.current_database()
                   AND (pg_catalog.has_database_privilege(app_oid, d.oid, 'CONNECT')
                        OR pg_catalog.has_database_privilege(migrate_oid, d.oid, 'CONNECT'))) THEN
    RAISE EXCEPTION 'sentinel-roles: the login roles could connect to other databases of the cluster, whose objects no check here can see (PostgreSQL lets every role connect to every database by default); this program never revokes from PUBLIC: run first, each as the role named, granting CONNECT back to any other role that needs it: %', {_shown("COALESCE(found, 'end the membership that gives it')")};
  END IF;
  SELECT pg_catalog.string_agg(pg_catalog.format('pid %s (%s in database %s, %s): SELECT pg_catalog.pg_terminate_backend(%s)',
                                                 a.pid, a.usename, a.datname, COALESCE(a.state, 'state not shown'), a.pid),
                               '; ' ORDER BY a.pid) INTO found
    FROM pg_catalog.pg_stat_activity a
   WHERE a.usesysid IN (app_oid, migrate_oid) AND a.datname <> pg_catalog.current_database()
     AND a.pid <> pg_catalog.pg_backend_pid();
  IF found IS NOT NULL THEN
    RAISE EXCEPTION 'sentinel-roles: sessions of the login roles are open in other databases, which revoking CONNECT does not end; this program ends no session: find out what they are, end them as a superuser, and run this again: %', {_shown('found')};
  END IF;
"""


# The temporary schemas PostgreSQL makes as sessions need them have OIDs above
# FIRST_NORMAL_OID, but reserved names: no role may create a schema whose name begins
# with pg_. Other sessions' temporary tables are out of every session's reach.
# Who holds a privilege: each managed role that exists, and PUBLIC, whose privileges
# every role holds (so they are checked before the roles exist, in the preflight).
HOLDERS = f"""(SELECT rolname::text AS name FROM pg_catalog.pg_roles WHERE oid IN ({MANAGED_OIDS})
                 UNION ALL SELECT 'public') h"""

# What initdb gave an object: its ACL as pg_init_privs recorded it, or the owner's
# defaults where it recorded none; nothing for an object made after initdb.
def _initial(classid: str, oid: str, owner: str, kind: str) -> str:
    return f"""pg_catalog.aclexplode(COALESCE(
                             (SELECT i.initprivs FROM pg_catalog.pg_init_privs i
                               WHERE i.classoid = '{classid}'::pg_catalog.regclass AND i.objoid = {oid} AND i.objsubid = 0),
                             pg_catalog.acldefault('{kind}', {owner}))) b
                            WHERE {oid} < {FIRST_NORMAL_OID} AND"""


# Nothing of this database or of the cluster's shared objects is open to a managed
# role, or to PUBLIC, but what the application uses and what initdb gave every role
# in the system catalogs: not by a grant to it, not through PUBLIC, not through a role
# it belongs to (the check of memberships comes first). Privileges are asked of
# PostgreSQL itself (has_*_privilege) wherever it answers for any object; the system
# catalogs, which every role reads, are compared with what initdb gave them, and only
# what initdb made gets that baseline (FIRST_NORMAL_OID); large objects with their
# ACL, which is all a role without memberships holds on them. Other databases are out
# of reach (CONNECT_ELSEWHERE). What could run code without a privilege of its own
# (a cast, an operator, a type) is in FOREIGN_OBJECTS.
#
# Narrowing this check, or FOREIGN_OBJECTS, must keep what only they hold, in every check
# they are in (apply's preflight and final check, status, every start); LARGE_OBJECTS checks
# the creation of large objects and who owns them, and no more:
# - large objects: no ACL entry for PUBLIC or a managed role on any of them;
# - lo_compat_privileges off, which would skip the check of every large object's ACL;
# - parameters: no SET or ALTER SYSTEM for PUBLIC or a managed role (pg_parameter_acl);
# - functions: no EXECUTE beyond initdb's on the system's functions, and no function owned by
#   a managed role (TRIPWIRE, anywhere);
# - code: nothing that runs code made after initdb (FOREIGN_OBJECTS; TRIPWIRE in public).
# DependencyTests (apps/core/tests/test_db_roles.py) fails while one of them is missing.
UNEXPECTED_ACCESS = f"""\
  SELECT pg_catalog.string_agg(item, '; ' ORDER BY item) INTO found FROM (
    SELECT pg_catalog.format('%s %s: %s for %s', x.kind, x.object,
                             pg_catalog.string_agg(DISTINCT x.privilege, ', ' ORDER BY x.privilege), x.holder) AS item
      FROM (
        -- Schemas but public (checked below) and the sessions' temporary ones: of the
        -- system's, every role may use pg_catalog and information_schema as initdb made
        -- them, and nothing more (not pg_toast, which holds every table's out-of-line data).
        SELECT 'schema' AS kind, pg_catalog.quote_ident(n.nspname) AS object, asked AS privilege,
               CASE WHEN pg_catalog.has_schema_privilege('public', n.oid, asked) THEN 'PUBLIC' ELSE h.name END AS holder
          FROM pg_catalog.pg_namespace n, {HOLDERS}, pg_catalog.unnest(ARRAY['USAGE', 'CREATE']) asked
         WHERE n.oid <> {PUBLIC_SCHEMA} AND n.nspname !~ '^pg_(temp_[0-9]+|toast_temp_[0-9]+)$'
           AND NOT (n.oid < {FIRST_NORMAL_OID} AND n.nspname IN ('pg_catalog', 'information_schema') AND asked = 'USAGE')
           AND pg_catalog.has_schema_privilege(h.name, n.oid, asked)
        UNION ALL
        -- Relations, but the application's tables and sequences in public (checked below)
        -- and the system catalogs (below). (CASE: PostgreSQL evaluates the conditions of
        -- WHERE in any order, and has_sequence_privilege fails on anything but a sequence.)
        SELECT CASE c.relkind WHEN 'S' THEN 'sequence' WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized view'
                              WHEN 'f' THEN 'foreign table' WHEN 't' THEN 'TOAST table' ELSE 'table' END,
               c.oid::pg_catalog.regclass::text, asked,
               CASE WHEN CASE WHEN c.relkind = 'S' THEN pg_catalog.has_sequence_privilege('public', c.oid, asked)
                              WHEN asked IN ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
                              THEN pg_catalog.has_any_column_privilege('public', c.oid, asked)
                              ELSE pg_catalog.has_table_privilege('public', c.oid, asked) END
                    THEN 'PUBLIC' ELSE h.name END
          FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace, {HOLDERS},
               pg_catalog.unnest(ARRAY['USAGE', 'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']
                                 || CASE WHEN pg_catalog.current_setting('server_version_num')::integer >= 170000
                                         THEN ARRAY['MAINTAIN'] ELSE ARRAY[]::text[] END) asked
         WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f', 't', 'S') AND n.nspname NOT IN ('pg_catalog', 'information_schema')
           AND NOT (n.oid = {PUBLIC_SCHEMA} AND c.relkind IN ('r', 'p', 'S'))
           -- Its owner holds what it owns (the owner role, the TOAST tables of its tables;
           -- what it owns elsewhere is refused below, for being there).
           AND h.name IS DISTINCT FROM (SELECT o.rolname::text FROM pg_catalog.pg_roles o WHERE o.oid = c.relowner)
           AND CASE WHEN c.relkind = 'S'
                    THEN asked IN ('USAGE', 'SELECT', 'UPDATE') AND pg_catalog.has_sequence_privilege(h.name, c.oid, asked)
                    WHEN asked = 'USAGE' THEN false
                    WHEN asked IN ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
                    THEN pg_catalog.has_any_column_privilege(h.name, c.oid, asked)
                    ELSE pg_catalog.has_table_privilege(h.name, c.oid, asked) END
        UNION ALL
        -- The system catalogs: what PUBLIC or a managed role holds beyond what initdb gave.
        -- information_schema has no record in pg_init_privs: there, PUBLIC may read what
        -- initdb made, and nothing more.
        SELECT CASE WHEN c.relkind = 'S' THEN 'sequence' WHEN c.relkind IN ('v', 'm') THEN 'view' ELSE 'table' END,
               c.oid::pg_catalog.regclass::text, a.privilege_type,
               CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::pg_catalog.regrole::text END
          FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace,
               pg_catalog.aclexplode(COALESCE(c.relacl, pg_catalog.acldefault('r', c.relowner))) a
         WHERE n.nspname IN ('pg_catalog', 'information_schema') AND (a.grantee = 0 OR a.grantee IN ({MANAGED_OIDS}))
           AND NOT (n.nspname = 'information_schema' AND c.oid < {FIRST_NORMAL_OID}
                    AND a.grantee = 0 AND a.privilege_type = 'SELECT' AND NOT a.is_grantable)
           AND NOT EXISTS (SELECT FROM {_initial('pg_catalog.pg_class', 'c.oid', 'c.relowner', 'r')} b.grantee = a.grantee AND b.privilege_type = a.privilege_type
                              AND b.is_grantable >= a.is_grantable)
        UNION ALL
        SELECT 'column', pg_catalog.format('%s.%I', c.oid::pg_catalog.regclass, t.attname), a.privilege_type,
               CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::pg_catalog.regrole::text END
          FROM pg_catalog.pg_attribute t JOIN pg_catalog.pg_class c ON c.oid = t.attrelid
               JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace,
               pg_catalog.aclexplode(t.attacl) a
         WHERE n.nspname IN ('pg_catalog', 'information_schema') AND NOT t.attisdropped
           AND (a.grantee = 0 OR a.grantee IN ({MANAGED_OIDS}))
           AND NOT EXISTS (SELECT FROM pg_catalog.pg_init_privs i, pg_catalog.aclexplode(i.initprivs) b
                            WHERE c.oid < {FIRST_NORMAL_OID}
                              AND i.classoid = 'pg_catalog.pg_class'::pg_catalog.regclass AND i.objoid = c.oid
                              AND i.objsubid = t.attnum AND b.grantee = a.grantee AND b.privilege_type = a.privilege_type
                              AND b.is_grantable >= a.is_grantable)
        UNION ALL
        -- Functions in the system schemas; elsewhere, whatever made after initdb is refused
        -- for being there (FOREIGN_OBJECTS).
        SELECT CASE WHEN f.prosecdef THEN 'security definer function' ELSE 'function' END,
               f.oid::pg_catalog.regprocedure::text, a.privilege_type,
               CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::pg_catalog.regrole::text END
          FROM pg_catalog.pg_proc f JOIN pg_catalog.pg_namespace n ON n.oid = f.pronamespace,
               pg_catalog.aclexplode(COALESCE(f.proacl, pg_catalog.acldefault('f', f.proowner))) a
         WHERE n.nspname IN ('pg_catalog', 'information_schema') AND (a.grantee = 0 OR a.grantee IN ({MANAGED_OIDS}))
           AND NOT EXISTS (SELECT FROM {_initial('pg_catalog.pg_proc', 'f.oid', 'f.proowner', 'f')} b.grantee = a.grantee AND b.privilege_type = a.privilege_type
                              AND b.is_grantable >= a.is_grantable)
        UNION ALL
        SELECT 'large object', l.oid::text, a.privilege_type,
               CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::pg_catalog.regrole::text END
          FROM pg_catalog.pg_largeobject_metadata l,
               pg_catalog.aclexplode(COALESCE(l.lomacl, pg_catalog.acldefault('L', l.lomowner))) a
         WHERE a.grantee = 0 OR a.grantee IN ({MANAGED_OIDS})
        UNION ALL
        SELECT 'setting', 'lo_compat_privileges', 'on', 'every role'
         WHERE pg_catalog.current_setting('lo_compat_privileges')::boolean
        UNION ALL
        SELECT 'foreign-data wrapper', pg_catalog.quote_ident(w.fdwname), 'USAGE',
               CASE WHEN pg_catalog.has_foreign_data_wrapper_privilege('public', w.oid, 'USAGE') THEN 'PUBLIC' ELSE h.name END
          FROM pg_catalog.pg_foreign_data_wrapper w, {HOLDERS}
         WHERE pg_catalog.has_foreign_data_wrapper_privilege(h.name, w.oid, 'USAGE')
        UNION ALL
        SELECT 'server', pg_catalog.quote_ident(s.srvname), 'USAGE',
               CASE WHEN pg_catalog.has_server_privilege('public', s.oid, 'USAGE') THEN 'PUBLIC' ELSE h.name END
          FROM pg_catalog.pg_foreign_server s, {HOLDERS}
         WHERE pg_catalog.has_server_privilege(h.name, s.oid, 'USAGE')
        UNION ALL
        -- Shared by the cluster.
        SELECT 'tablespace', pg_catalog.quote_ident(s.spcname), 'CREATE',
               CASE WHEN pg_catalog.has_tablespace_privilege('public', s.oid, 'CREATE') THEN 'PUBLIC' ELSE h.name END
          FROM pg_catalog.pg_tablespace s, {HOLDERS}
         WHERE pg_catalog.has_tablespace_privilege(h.name, s.oid, 'CREATE')
        UNION ALL
        SELECT 'parameter', s.parname, asked,
               CASE WHEN pg_catalog.has_parameter_privilege('public', s.parname, asked) THEN 'PUBLIC' ELSE h.name END
          FROM pg_catalog.pg_parameter_acl s, {HOLDERS}, pg_catalog.unnest(ARRAY['SET', 'ALTER SYSTEM']) asked
         WHERE pg_catalog.has_parameter_privilege(h.name, s.parname, asked)
      ) x
     GROUP BY x.kind, x.object, x.holder
  ) items;
  IF found IS NOT NULL THEN
    RAISE EXCEPTION 'sentinel-roles: in database %, the managed roles may use what the application does not: %; revoke it, as the role that granted it (from PUBLIC too: this program never revokes from PUBLIC), and run this again', pg_catalog.current_database(), {_shown('found')};
  END IF;
"""


# What runs code in the application's database was made by initdb, or by nobody: the
# application creates none of it (TRIPWIRE refuses it in public). Anything of the kind
# made after initdb, wherever it sits (pg_catalog included), nobody here can vouch
# for, granted to anyone or not: PUBLIC may run every function unless that was revoked,
# and a cast or an operator calls its function without the caller using, or being
# allowed to use, the schema the function is in (a cast between two built-in types
# reaches a function in a schema hidden from the caller); a SECURITY DEFINER function
# runs with its owner's privileges. Data (schemas, tables, sequences, views) is refused
# only where a managed role may use it (UNEXPECTED_ACCESS).
FOREIGN_OBJECTS = f"""\
  SELECT pg_catalog.string_agg(item, ', ' ORDER BY item) INTO found FROM (
    SELECT CASE WHEN p.prosecdef THEN 'security definer function ' ELSE 'function ' END || p.oid::pg_catalog.regprocedure::text AS item
      FROM pg_catalog.pg_proc p WHERE p.oid >= {FIRST_NORMAL_OID}
    UNION ALL
    SELECT 'type ' || ty.oid::pg_catalog.regtype::text
      FROM pg_catalog.pg_type ty JOIN pg_catalog.pg_namespace n ON n.oid = ty.typnamespace
     WHERE ty.oid >= {FIRST_NORMAL_OID} AND n.oid <> {PUBLIC_SCHEMA}
       AND n.nspname !~ '^pg_(temp_[0-9]+|toast_temp_[0-9]+)$'
       -- The row type of a relation, which the relations are checked for, and its array.
       AND ty.typrelid = 0
       AND NOT EXISTS (SELECT FROM pg_catalog.pg_type e WHERE e.oid = ty.typelem AND e.typrelid <> 0 AND e.typarray = ty.oid)
    UNION ALL SELECT 'operator ' || o.oid::pg_catalog.regoperator::text FROM pg_catalog.pg_operator o WHERE o.oid >= {FIRST_NORMAL_OID}
    UNION ALL SELECT 'cast ' || pg_catalog.format('(%s AS %s)', k.castsource::pg_catalog.regtype, k.casttarget::pg_catalog.regtype)
      FROM pg_catalog.pg_cast k WHERE k.oid >= {FIRST_NORMAL_OID}
    UNION ALL SELECT 'conversion ' || pg_catalog.quote_ident(v.conname) FROM pg_catalog.pg_conversion v WHERE v.oid >= {FIRST_NORMAL_OID}
    UNION ALL SELECT 'collation ' || pg_catalog.quote_ident(l.collname) FROM pg_catalog.pg_collation l WHERE l.oid >= {FIRST_NORMAL_OID}
    UNION ALL SELECT 'operator class ' || pg_catalog.quote_ident(o.opcname) FROM pg_catalog.pg_opclass o WHERE o.oid >= {FIRST_NORMAL_OID}
    UNION ALL SELECT 'operator family ' || pg_catalog.quote_ident(o.opfname) FROM pg_catalog.pg_opfamily o WHERE o.oid >= {FIRST_NORMAL_OID}
    UNION ALL SELECT 'access method ' || pg_catalog.quote_ident(m.amname) FROM pg_catalog.pg_am m WHERE m.oid >= {FIRST_NORMAL_OID}
    UNION ALL SELECT 'language ' || pg_catalog.quote_ident(g.lanname) FROM pg_catalog.pg_language g WHERE g.oid >= {FIRST_NORMAL_OID}
    UNION ALL SELECT 'transform ' || r.oid::text FROM pg_catalog.pg_transform r WHERE r.oid >= {FIRST_NORMAL_OID}
    UNION ALL SELECT 'extension ' || pg_catalog.quote_ident(x.extname) FROM pg_catalog.pg_extension x WHERE x.oid >= {FIRST_NORMAL_OID}
    UNION ALL SELECT 'text search parser ' || pg_catalog.quote_ident(s.prsname) FROM pg_catalog.pg_ts_parser s WHERE s.oid >= {FIRST_NORMAL_OID}
    UNION ALL SELECT 'text search template ' || pg_catalog.quote_ident(s.tmplname) FROM pg_catalog.pg_ts_template s WHERE s.oid >= {FIRST_NORMAL_OID}
    UNION ALL SELECT 'text search dictionary ' || pg_catalog.quote_ident(s.dictname) FROM pg_catalog.pg_ts_dict s WHERE s.oid >= {FIRST_NORMAL_OID}
    UNION ALL SELECT 'text search configuration ' || pg_catalog.quote_ident(s.cfgname) FROM pg_catalog.pg_ts_config s WHERE s.oid >= {FIRST_NORMAL_OID}
    UNION ALL SELECT 'foreign-data wrapper ' || pg_catalog.quote_ident(w.fdwname) FROM pg_catalog.pg_foreign_data_wrapper w WHERE w.oid >= {FIRST_NORMAL_OID}
    UNION ALL SELECT 'server ' || pg_catalog.quote_ident(s.srvname) FROM pg_catalog.pg_foreign_server s WHERE s.oid >= {FIRST_NORMAL_OID}
  ) objects;
  IF found IS NOT NULL THEN
    RAISE EXCEPTION 'sentinel-roles: database % holds what runs code, which the application never creates and initdb did not make, so nothing here can vouch for it: %; remove it (or keep it in another database) and run this again', pg_catalog.current_database(), {_shown('found')};
  END IF;
"""


# The runtime role may not create temporary tables, in any database it may connect to,
# by any path: PUBLIC holds TEMPORARY on every database unless that was revoked (a NULL
# datacl is the default ACL, which grants it), and the role could hold it itself or through
# a role it can become. This program never revokes from PUBLIC, which other roles may rely
# on: the operator does, as the role that granted it, and the refusal says what to run.
TEMPORARY = f"""\
  SELECT pg_catalog.string_agg(remedy, '; ' ORDER BY remedy) INTO found FROM (
    SELECT DISTINCT pg_catalog.format('as %s: REVOKE TEMPORARY ON DATABASE %I FROM %s',
                                      a.grantor::pg_catalog.regrole, d.datname,
                                      CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::pg_catalog.regrole::text END) AS remedy
      FROM pg_catalog.pg_database d,
           pg_catalog.aclexplode(COALESCE(d.datacl, pg_catalog.acldefault('d', d.datdba))) a
     WHERE d.datallowconn AND a.privilege_type = 'TEMPORARY'
       AND (a.grantee = 0 OR pg_catalog.pg_has_role(app_oid, a.grantee, 'MEMBER'))
       -- Before the role exists, the databases PUBLIC may connect to.
       AND CASE WHEN app_oid IS NULL
                THEN EXISTS (SELECT FROM pg_catalog.aclexplode(COALESCE(d.datacl, pg_catalog.acldefault('d', d.datdba))) c
                              WHERE c.grantee = 0 AND c.privilege_type = 'CONNECT')
                ELSE pg_catalog.has_database_privilege(app_oid, d.oid, 'CONNECT') END
  ) remedies;
  IF found IS NOT NULL
     OR EXISTS (SELECT FROM pg_catalog.pg_database d, pg_catalog.pg_roles r
                 WHERE d.datallowconn AND pg_catalog.has_database_privilege(app_oid, d.oid, 'CONNECT')
                   AND pg_catalog.pg_has_role(app_oid, r.oid, 'MEMBER')
                   AND pg_catalog.has_database_privilege(r.oid, d.oid, 'TEMPORARY')) THEN
    RAISE EXCEPTION 'sentinel-roles: the runtime role could create temporary tables, which PostgreSQL lets every role do in every database by default; this program never revokes from PUBLIC: run first, each as the role named (for a database the application does not use, revoking CONNECT from PUBLIC does as well): %', {_shown("COALESCE(found, 'end the membership of " + RUNTIME_ROLE + " in the role that holds it')")};
  END IF;
"""

# Large objects. Every SQL function PostgreSQL has for them calls a C function whose name begins
# with be_lo (src/backend/libpq/be-fsstubs.c), and so does every way a client creates one: libpq's
# lo_creat, lo_create and lo_import (psql's lo_import command) call the same functions through the
# fast-path interface, which checks EXECUTE on them. These create a large object; the others only
# use one that exists, which the roles own none of and may be given none of (UNEXPECTED_ACCESS).
# PUBLIC may execute lo_creat, lo_create and lo_from_bytea by default; lo_import only the
# bootstrap superuser.
LARGE_OBJECT_CREATORS = ("be_lo_creat", "be_lo_create", "be_lo_from_bytea", "be_lo_import", "be_lo_import_with_oid")
LARGE_OBJECT_OTHERS = (
    "be_lo_close", "be_lo_export", "be_lo_get", "be_lo_get_fragment", "be_lo_lseek", "be_lo_lseek64", "be_lo_open",
    "be_lo_put", "be_lo_tell", "be_lo_tell64", "be_lo_truncate", "be_lo_truncate64", "be_lo_unlink", "be_loread",
    "be_lowrite",
)


def _large_objects(creators: Sequence[str] = LARGE_OBJECT_CREATORS, others: Sequence[str] = LARGE_OBJECT_OTHERS) -> str:
    """No managed role may create a large object, by any function that does, held through PUBLIC,
    by itself or by a role it belongs to; a large-object function of PostgreSQL's that is in
    neither list (a later version) is refused until it is classified."""
    creating = ", ".join(_literal(name) for name in creators)
    known = ", ".join(_literal(name) for name in (*creators, *others))
    return f"""\
  SELECT pg_catalog.string_agg(pg_catalog.format('%s (%s)', p.oid::pg_catalog.regprocedure, p.prosrc), ', '
                               ORDER BY p.oid::pg_catalog.regprocedure::text) INTO found
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_language g ON g.oid = p.prolang
   WHERE g.lanname = 'internal' AND p.prosrc LIKE 'be\\_lo%' AND p.prosrc NOT IN ({known});
  IF found IS NOT NULL THEN
    RAISE EXCEPTION 'sentinel-roles: PostgreSQL has large-object functions this program does not know, which may create large objects: %; this PostgreSQL version is not supported until they are classified', {_shown('found')};
  END IF;
  -- Who holds EXECUTE on a creating function: PUBLIC, a managed role, or a role one belongs to
  -- (MEMBER: inherited or SET). That covers every way PostgreSQL gives it: a superuser is a
  -- member of the owner, whose own entry each function's ACL has.
  SELECT pg_catalog.string_agg(remedy, '; ' ORDER BY remedy) INTO found FROM (
    SELECT DISTINCT pg_catalog.format('as %s: REVOKE EXECUTE ON FUNCTION %s FROM %s', a.grantor::pg_catalog.regrole,
                                      p.oid::pg_catalog.regprocedure,
                                      CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::pg_catalog.regrole::text END) AS remedy
      FROM pg_catalog.pg_proc p, pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
     WHERE p.prosrc IN ({creating}) AND a.privilege_type = 'EXECUTE'
       AND (a.grantee = 0 OR EXISTS (SELECT FROM pg_catalog.pg_roles m
                                      WHERE m.oid IN ({MANAGED_OIDS}) AND pg_catalog.pg_has_role(m.oid, a.grantee, 'MEMBER')))
  ) remedies;
  IF found IS NOT NULL THEN
    RAISE EXCEPTION 'sentinel-roles: the managed roles could create large objects (PostgreSQL lets every role do it by default, through lo_creat, lo_create and lo_from_bytea); this program never revokes from PUBLIC: run first, in Sentinel''s database, each as the role named: %', {_shown('found')};
  END IF;
  SELECT pg_catalog.string_agg(pg_catalog.format('%s (%s)', l.oid, l.lomowner::pg_catalog.regrole), ', ' ORDER BY l.oid) INTO found
    FROM pg_catalog.pg_largeobject_metadata l WHERE l.lomowner IN ({MANAGED_OIDS});
  IF found IS NOT NULL THEN
    RAISE EXCEPTION 'sentinel-roles: large objects belong to a managed role: %; look at what they hold, then remove them (SELECT pg_catalog.lo_unlink(oid))', {_shown('found')};
  END IF;
"""


LARGE_OBJECTS = _large_objects()

ROLE_OIDS = f"""\
  SELECT oid INTO owner_oid FROM pg_catalog.pg_roles WHERE rolname = {OWNER_NAME};
  SELECT oid INTO migrate_oid FROM pg_catalog.pg_roles WHERE rolname = {MIGRATE_NAME};
  SELECT oid INTO app_oid FROM pg_catalog.pg_roles WHERE rolname = {APP_NAME};
  SELECT oid INTO db_oid FROM pg_catalog.pg_database WHERE datname = pg_catalog.current_database();
"""

DECLARE = """\
DECLARE
  found text;
  state text;
  db_oid oid;
  owner_oid oid;
  migrate_oid oid;
  app_oid oid;
"""

# The record of an activation: the comment of schema sentinel_restricted, which apply writes in
# the transaction that creates the three roles. It names this database and the three roles by
# OID: a local identity, which tells these roles from roles made later under the same names, and
# this database from one restored elsewhere. A copy of the cluster's files carries it, as the
# same installation; it proves nothing about where the cluster came from.
ACTIVATION = "sentinel-roles activation 1: database=%s owner=%s migrate=%s app=%s"

# The provisioning history, as every check reads it before anything else (state):
#   A  first activation: none of the three roles, and no record of an activation;
#   B  activated: the three roles, and the record of their activation (schema sentinel_restricted)
#      owned by the bootstrap superuser, open to no other role (PUBLIC included), naming this
#      database and these roles;
#   C  anything else (found says what): a partial or unknown history, roles made or remade by
#      someone else, a record of another activation. Nothing is changed in it, and no role this
#      program did not create is ever taken over.
LIFECYCLE = f"""\
  SELECT pg_catalog.string_agg(problem, '; ' ORDER BY position) INTO found FROM (
    SELECT 1 AS position,
           pg_catalog.format('only %s of the roles {OWNER_ROLE}, {MIGRATION_ROLE} and {RUNTIME_ROLE} exist',
                             pg_catalog.num_nonnulls(owner_oid, migrate_oid, app_oid)) AS problem
     WHERE pg_catalog.num_nonnulls(owner_oid, migrate_oid, app_oid) IN (1, 2)
    UNION ALL
    SELECT 2, 'the roles exist, but schema {RESTRICTED_SCHEMA}, the record of their activation, does not'
     WHERE pg_catalog.num_nonnulls(owner_oid, migrate_oid, app_oid) = 3
       AND NOT EXISTS (SELECT FROM pg_catalog.pg_namespace WHERE nspname = {RESTRICTED_NAME})
    UNION ALL
    SELECT 3, 'schema {RESTRICTED_SCHEMA}, the record of an activation, exists without the roles'
     WHERE pg_catalog.num_nonnulls(owner_oid, migrate_oid, app_oid) = 0
       AND EXISTS (SELECT FROM pg_catalog.pg_namespace WHERE nspname = {RESTRICTED_NAME})
    UNION ALL
    SELECT 4, pg_catalog.format('schema {RESTRICTED_SCHEMA} belongs to %s, not to the bootstrap superuser',
                                n.nspowner::pg_catalog.regrole)
      FROM pg_catalog.pg_namespace n WHERE n.nspname = {RESTRICTED_NAME} AND n.nspowner <> 10
    UNION ALL
    SELECT 5, 'schema {RESTRICTED_SCHEMA} is open to other roles than its owner'
      FROM pg_catalog.pg_namespace n WHERE n.nspname = {RESTRICTED_NAME}
       AND EXISTS (SELECT FROM pg_catalog.aclexplode(n.nspacl) a WHERE a.grantee <> n.nspowner)
    UNION ALL
    SELECT 6, pg_catalog.format('schema {RESTRICTED_SCHEMA} records %s, not this database and these roles (%s)',
                                COALESCE('"' || pg_catalog.obj_description(n.oid, 'pg_namespace') || '"', 'no activation'),
                                pg_catalog.format({_literal(ACTIVATION)}, db_oid, owner_oid, migrate_oid, app_oid))
      FROM pg_catalog.pg_namespace n
     WHERE n.nspname = {RESTRICTED_NAME} AND pg_catalog.num_nonnulls(owner_oid, migrate_oid, app_oid) = 3
       AND pg_catalog.obj_description(n.oid, 'pg_namespace')
           IS DISTINCT FROM pg_catalog.format({_literal(ACTIVATION)}, db_oid, owner_oid, migrate_oid, app_oid)
  ) problems;
  state := CASE WHEN found IS NOT NULL THEN 'C' WHEN owner_oid IS NULL THEN 'A' ELSE 'B' END;
"""

UNKNOWN_HISTORY = (
    "sentinel-roles: the cluster holds a partial or unknown provisioning history (state C): %; this program "
    "changes nothing in it and takes over no role it did not create: rebuild Sentinel''s database in a new "
    "cluster, or undo what differs by hand in a maintenance window (docs/server-deployment.md)"
)


def _session_checks(database: str) -> str:
    """The server version, a superuser session and the database, before anything else."""
    return f"""\
DO $sentinel_session$
BEGIN
  IF pg_catalog.current_setting('server_version_num')::integer NOT BETWEEN {MIN_SERVER_VERSION} AND {MAX_SERVER_VERSION} THEN
    RAISE EXCEPTION 'sentinel-roles: PostgreSQL % is not supported (16 to 18)', pg_catalog.current_setting('server_version');
  END IF;
  IF pg_catalog.current_setting('is_superuser') <> 'on' THEN
    RAISE EXCEPTION 'sentinel-roles: run this as the bootstrap superuser (docker compose exec db psql)';
  END IF;
  IF pg_catalog.current_database() <> {_literal(database)} THEN
    RAISE EXCEPTION 'sentinel-roles: connected to database %, but the program is for database %', pg_catalog.current_database(), {_literal(database)};
  END IF;
  IF session_user IN ({MANAGED}) THEN
    RAISE EXCEPTION 'sentinel-roles: run this as the bootstrap superuser, not as a role it manages';
  END IF;
END
$sentinel_session$;
"""


def _preflight(adopt: bool) -> str:
    adoption = (
        """\
  IF state = 'B' THEN
    RAISE EXCEPTION 'sentinel-roles: the separate logins are activated already (state B): there is nothing to adopt; run apply without --adopt-table';
  END IF;
"""
        if adopt
        else ""
    )
    bootstrap_relations = (
        ""
        if adopt
        else f"""\
  SELECT pg_catalog.string_agg('--adopt-table ' || c.relname, ' ' ORDER BY c.relname) INTO found
    FROM pg_catalog.pg_class c WHERE c.relnamespace = {PUBLIC_SCHEMA} AND c.relowner = 10 AND c.relkind IN ('r', 'p');
  IF EXISTS (SELECT FROM pg_catalog.pg_class c WHERE c.relnamespace = {PUBLIC_SCHEMA} AND c.relowner = 10) THEN
    RAISE EXCEPTION 'sentinel-roles: relations in schema public belong to the bootstrap superuser (an existing installation); stop web and run apply with: %', {_shown("COALESCE(found, '(none of them is a table: remove them)')")};
  END IF;
"""
    )
    return f"""\
DO $sentinel_preflight$
{DECLARE}BEGIN
  IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE oid = 10 AND rolname IN ({MANAGED})) THEN
    RAISE EXCEPTION 'sentinel-roles: the bootstrap superuser has the name of a role this program manages';
  END IF;
{DEDICATED_CLUSTER}{ROLE_OIDS}{LIFECYCLE}  IF state = 'C' THEN
    RAISE EXCEPTION '{UNKNOWN_HISTORY}', {_shown('found')};
  END IF;
{adoption}  -- What the blocks after this one do depends on it (sentinel_reapply, sentinel_marker).
  PERFORM pg_catalog.set_config('sentinel.state', state, true);
  SELECT pg_catalog.string_agg(rolname, ', ' ORDER BY rolname) INTO found
    FROM pg_catalog.pg_roles WHERE oid IN ({MANAGED_OIDS}) AND rolsuper;
  IF found IS NOT NULL THEN
    RAISE EXCEPTION 'sentinel-roles: refusing to change superuser role(s) %; they are not this program''s', {_shown('found')};
  END IF;
  -- Memberships are never revoked here: they may be an operator's.
  SELECT pg_catalog.string_agg(pg_catalog.format('%s in %s', m.member::pg_catalog.regrole, m.roleid::pg_catalog.regrole), ', '
                               ORDER BY m.member::pg_catalog.regrole::text, m.roleid::pg_catalog.regrole::text) INTO found
    FROM pg_catalog.pg_auth_members m
   WHERE m.member IN (app_oid, owner_oid)
      OR m.roleid IN (app_oid, migrate_oid)
      OR (m.member = migrate_oid AND m.roleid IS DISTINCT FROM owner_oid)
      OR (m.roleid = owner_oid AND m.member IS DISTINCT FROM migrate_oid);
  IF found IS NOT NULL THEN
    RAISE EXCEPTION 'sentinel-roles: unexpected role memberships, revoke them first: %', {_shown('found')};
  END IF;
{OTHER_DATABASES}  -- The lock keeps Sentinel's superuser logins out; a superuser session opened otherwise
  -- (psql by hand) would outlive this commit unchecked.
  SELECT pg_catalog.string_agg(pg_catalog.format('%s (pid %s)', a.usename, a.pid), ', ' ORDER BY a.pid) INTO found
    FROM pg_catalog.pg_stat_activity a
   WHERE a.datname = pg_catalog.current_database() AND a.backend_type = 'client backend'
     AND a.pid <> pg_catalog.pg_backend_pid()
     AND EXISTS (SELECT FROM pg_catalog.pg_roles r WHERE r.rolsuper AND pg_catalog.pg_has_role(a.usesysid, r.oid, 'MEMBER'));
  IF found IS NOT NULL THEN
    RAISE EXCEPTION 'sentinel-roles: other superuser sessions use this database: %; stop web and any shell, or end them (pg_terminate_backend), and run this again', {_shown('found')};
  END IF;
  SELECT d.datdba::pg_catalog.regrole::text INTO found FROM pg_catalog.pg_database d
   WHERE d.datname = pg_catalog.current_database() AND d.datdba IN ({MANAGED_OIDS});
  IF found IS NOT NULL THEN
    RAISE EXCEPTION 'sentinel-roles: the database belongs to %, a role this program manages; give it back to the bootstrap superuser first (ALTER DATABASE ... OWNER TO ...)', {_shown('found')};
  END IF;
  IF EXISTS (SELECT FROM pg_catalog.pg_namespace n, pg_catalog.aclexplode(n.nspacl) a
              WHERE n.oid = {PUBLIC_SCHEMA} AND a.grantee = 0 AND a.privilege_type = 'CREATE') THEN
    RAISE EXCEPTION 'sentinel-roles: every role may create objects in schema public (a database from PostgreSQL 14 or older); revoke that first: REVOKE CREATE ON SCHEMA public FROM PUBLIC';
  END IF;
{TEMPORARY}{CONNECT_ELSEWHERE}{LARGE_OBJECTS}{UNEXPECTED_ACCESS}{FOREIGN_OBJECTS}{TRIPWIRE}  SELECT pg_catalog.string_agg(pg_catalog.format('%s (%s)', c.oid::pg_catalog.regclass, c.relowner::pg_catalog.regrole), ', '
                               ORDER BY c.oid::pg_catalog.regclass::text) INTO found
    FROM pg_catalog.pg_class c
   WHERE c.relnamespace = {PUBLIC_SCHEMA}
     AND c.relowner IS DISTINCT FROM owner_oid AND c.relowner <> 10;
  IF found IS NOT NULL THEN
    RAISE EXCEPTION 'sentinel-roles: relations in schema public belong to other roles; this program never takes them: %', {_shown('found')};
  END IF;
{bootstrap_relations}END
$sentinel_preflight$;
"""


def _roles(database: str, runtime_verifier: str, migration_verifier: str) -> str:
    db = _ident(database)
    return f"""\
DO $sentinel_create$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = {OWNER_NAME}) THEN
    CREATE ROLE {OWNER} NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = {MIGRATE_NAME}) THEN
    CREATE ROLE {MIGRATE} NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = {APP_NAME}) THEN
    CREATE ROLE {APP} NOLOGIN;
  END IF;
END
$sentinel_create$;
ALTER ROLE {OWNER} WITH NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT PASSWORD NULL VALID UNTIL 'infinity';
ALTER ROLE {MIGRATE} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT PASSWORD {_literal(migration_verifier)} VALID UNTIL 'infinity';
ALTER ROLE {APP} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT PASSWORD {_literal(runtime_verifier)} VALID UNTIL 'infinity';
ALTER ROLE {OWNER} RESET ALL;
ALTER ROLE {MIGRATE} RESET ALL;
ALTER ROLE {APP} RESET ALL;
ALTER ROLE {OWNER} IN DATABASE {db} RESET ALL;
ALTER ROLE {MIGRATE} IN DATABASE {db} RESET ALL;
ALTER ROLE {APP} IN DATABASE {db} RESET ALL;
ALTER ROLE {MIGRATE} IN DATABASE {db} SET search_path = {SEARCH_PATH};
ALTER ROLE {APP} IN DATABASE {db} SET search_path = {SEARCH_PATH};
GRANT {OWNER} TO {MIGRATE} WITH INHERIT FALSE, SET TRUE, ADMIN FALSE;
GRANT CONNECT ON DATABASE {db} TO {MIGRATE}, {APP};
GRANT USAGE, CREATE ON SCHEMA {SCHEMA} TO {OWNER};
GRANT USAGE ON SCHEMA {SCHEMA} TO {APP};
"""


def _adopt(tables: Sequence[str]) -> str:
    if not tables:
        return ""
    names = ", ".join(_literal(name) for name in tables)
    # ALTER TABLE ... OWNER TO also moves the indexes, the identity sequences
    # and the row types, not the partitions; only tables of the bootstrap
    # superuser are taken.
    return f"""\
DO $sentinel_adopt$
DECLARE
  relation pg_catalog.regclass;
BEGIN
  FOR relation IN
    SELECT c.oid FROM pg_catalog.pg_class c
     WHERE c.relnamespace = {PUBLIC_SCHEMA} AND c.relkind IN ('r', 'p') AND c.relowner = 10
       AND c.relname = ANY (ARRAY[{names}]::pg_catalog.name[])
     ORDER BY c.relname
  LOOP
    BEGIN
      EXECUTE pg_catalog.format('ALTER TABLE %s OWNER TO {OWNER}', relation);
    EXCEPTION WHEN lock_not_available THEN
      RAISE EXCEPTION 'sentinel-roles: table % is in use; stop web and whatever else uses the database, and run this again', {_shown('relation::text')};
    END;
  END LOOP;
END
$sentinel_adopt$;
"""


OWNERSHIP = f"""\
DO $sentinel_ownership$
{DECLARE}BEGIN
{ROLE_OIDS}  -- Named by table, partitions included: indexes and the sequences of identity or serial
  -- columns follow their tables.
  SELECT pg_catalog.string_agg(pg_catalog.format('%s (%s)', c.relname, c.relowner::pg_catalog.regrole), ', ' ORDER BY c.relname) INTO found
    FROM pg_catalog.pg_class c
   WHERE c.relnamespace = {PUBLIC_SCHEMA} AND c.relowner <> owner_oid AND c.relkind NOT IN ('i', 'I')
     AND NOT (c.relkind = 'S' AND EXISTS (SELECT FROM pg_catalog.pg_depend d
                                          WHERE d.classid = 'pg_catalog.pg_class'::pg_catalog.regclass AND d.objid = c.oid
                                            AND d.refclassid = 'pg_catalog.pg_class'::pg_catalog.regclass AND d.deptype IN ('a', 'i')));
  IF EXISTS (SELECT FROM pg_catalog.pg_class c WHERE c.relnamespace = {PUBLIC_SCHEMA} AND c.relowner <> owner_oid) THEN
    RAISE EXCEPTION 'sentinel-roles: relations in schema public that are not part of the application, or were not listed to adopt: %', {_shown("COALESCE(found, 'indexes or sequences of other tables')")};
  END IF;
  SELECT pg_catalog.string_agg(ty.oid::pg_catalog.regtype::text, ', ' ORDER BY ty.oid::pg_catalog.regtype::text) INTO found
    FROM pg_catalog.pg_type ty WHERE ty.typnamespace = {PUBLIC_SCHEMA} AND ty.typowner <> owner_oid;
  IF found IS NOT NULL THEN
    RAISE EXCEPTION 'sentinel-roles: types in schema public that do not belong to the owner role: %', {_shown('found')};
  END IF;
END
$sentinel_ownership$;
"""

# What tells every Sentinel process that the separate logins exist here (sentinel/database.py),
# and the record of their activation (ACTIVATION): a schema of the session's, the bootstrap
# superuser's, which neither login may drop, alter or comment on. Written at the first
# activation, in its transaction; a later apply finds it as it was (state B) and leaves it.
MARKER = f"""\
DO $sentinel_marker$
{DECLARE}BEGIN
{ROLE_OIDS}  IF pg_catalog.current_setting('sentinel.state') = 'A' THEN
    CREATE SCHEMA {_ident(RESTRICTED_SCHEMA)};
    EXECUTE pg_catalog.format('COMMENT ON SCHEMA {_ident(RESTRICTED_SCHEMA)} IS %L',
                              pg_catalog.format({_literal(ACTIVATION)}, db_oid, owner_oid, migrate_oid, app_oid));
  ELSIF pg_catalog.current_setting('sentinel.state') <> 'B' THEN
    RAISE EXCEPTION 'sentinel-roles: the preflight recorded no provisioning state';
  END IF;
END
$sentinel_marker$;
"""

# Exactly the runtime's privileges: missing ones granted, others revoked, from
# sentinel_app only. ALTER DEFAULT PRIVILEGES covers the tables the owner
# creates from now on; the loop covers the tables that exist.
GRANTS = f"""\
ALTER DEFAULT PRIVILEGES FOR ROLE {OWNER} IN SCHEMA {SCHEMA} REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLES FROM {APP};
ALTER DEFAULT PRIVILEGES FOR ROLE {OWNER} IN SCHEMA {SCHEMA} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO {APP};
DO $sentinel_grants$
DECLARE
  relation record;
  privilege text;
  app_oid oid := {APP_NAME}::pg_catalog.regrole;
  extra text[] := ARRAY['TRUNCATE', 'REFERENCES', 'TRIGGER'];
  wanted text[];
  unwanted text[];
BEGIN
  IF pg_catalog.current_setting('server_version_num')::integer >= 170000 THEN
    extra := extra || ARRAY['MAINTAIN'];
    EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE {OWNER} IN SCHEMA {SCHEMA} REVOKE MAINTAIN ON TABLES FROM {APP}';
  END IF;
  FOR relation IN
    SELECT c.oid::pg_catalog.regclass AS oid, c.relname AS name, c.relacl AS acl
      FROM pg_catalog.pg_class c
     WHERE c.relnamespace = {PUBLIC_SCHEMA} AND c.relkind IN ('r', 'p')
     ORDER BY c.relname
  LOOP
    IF relation.name = {_literal(MIGRATIONS_TABLE)} THEN
      -- The runtime reads which migrations ran; writing would let it choose the DDL the owner runs.
      wanted := ARRAY['SELECT'];
      unwanted := extra || ARRAY['INSERT', 'UPDATE', 'DELETE'];
    ELSE
      wanted := ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'];
      unwanted := extra;
    END IF;
    FOREACH privilege IN ARRAY wanted LOOP
      IF NOT EXISTS (SELECT FROM pg_catalog.aclexplode(relation.acl) a
                      WHERE a.grantee = app_oid AND a.privilege_type = privilege) THEN
        EXECUTE pg_catalog.format('GRANT %s ON TABLE %s TO {APP}', privilege, relation.oid);
      END IF;
    END LOOP;
    FOREACH privilege IN ARRAY wanted || unwanted LOOP
      IF EXISTS (SELECT FROM pg_catalog.aclexplode(relation.acl) a
                  WHERE a.grantee = app_oid AND a.privilege_type = privilege
                    AND (a.is_grantable OR privilege = ANY (unwanted))) THEN
        IF privilege = ANY (unwanted) THEN
          EXECUTE pg_catalog.format('REVOKE %s ON TABLE %s FROM {APP}', privilege, relation.oid);
        ELSE
          EXECUTE pg_catalog.format('REVOKE GRANT OPTION FOR %s ON TABLE %s FROM {APP}', privilege, relation.oid);
        END IF;
      END IF;
    END LOOP;
  END LOOP;
  -- Column privileges: the runtime role needs none, and the table ACLs above do not show them
  -- (INSERT on the columns of django_migrations is INSERT into it). Dropped columns keep
  -- theirs in PostgreSQL 16, where they no longer matter.
  FOR relation IN
    SELECT DISTINCT a.attrelid::pg_catalog.regclass AS oid, a.attname AS name
      FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid,
           pg_catalog.aclexplode(a.attacl) x
     WHERE c.relnamespace = {PUBLIC_SCHEMA} AND NOT a.attisdropped AND x.grantee = app_oid
     ORDER BY 1, 2
  LOOP
    EXECUTE pg_catalog.format('REVOKE ALL (%I) ON TABLE %s FROM {APP}', relation.name, relation.oid);
  END LOOP;
  FOR relation IN
    SELECT c.oid::pg_catalog.regclass AS oid, c.relacl AS acl
      FROM pg_catalog.pg_class c WHERE c.relnamespace = {PUBLIC_SCHEMA} AND c.relkind = 'S'
     ORDER BY c.relname
  LOOP
    FOREACH privilege IN ARRAY ARRAY['USAGE', 'SELECT', 'UPDATE'] LOOP
      IF EXISTS (SELECT FROM pg_catalog.aclexplode(relation.acl) a
                  WHERE a.grantee = app_oid AND a.privilege_type = privilege) THEN
        EXECUTE pg_catalog.format('REVOKE %s ON SEQUENCE %s FROM {APP}', privilege, relation.oid);
      END IF;
    END LOOP;
  END LOOP;
END
$sentinel_grants$;
"""


def _digest(verifier: str) -> str:
    return hashlib.sha256(verifier.encode("ascii")).hexdigest()


# The owner logs in with nothing: only the bootstrap superuser may read pg_authid.
OWNER_WITHOUT_PASSWORD = """\
  IF (SELECT rolpassword FROM pg_catalog.pg_authid WHERE oid = owner_oid) IS NOT NULL THEN
    RAISE EXCEPTION 'sentinel-roles: the owner role has a password';
  END IF;
"""


def _verify(database: str, verifiers: tuple[str, str] | None) -> str:
    """Every invariant, as one block that raises on the first deviation."""
    if verifiers is None:
        passwords = """\
  IF EXISTS (SELECT FROM pg_catalog.pg_authid WHERE oid IN (migrate_oid, app_oid)
              AND (rolpassword IS NULL OR rolpassword NOT LIKE 'SCRAM-SHA-256$%')) THEN
    RAISE EXCEPTION 'sentinel-roles: a login role has no SCRAM-SHA-256 password';
  END IF;
"""
    else:
        # Digests: a plan or an error context of this query (auto_explain) then shows no verifier.
        runtime_verifier, migration_verifier = verifiers
        stored = (
            "pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to("
            "(SELECT rolpassword FROM pg_catalog.pg_authid WHERE oid = {}), 'UTF8')), 'hex')"
        )
        passwords = f"""\
  IF {stored.format('app_oid')} IS DISTINCT FROM {_literal(_digest(runtime_verifier))}
     OR {stored.format('migrate_oid')} IS DISTINCT FROM {_literal(_digest(migration_verifier))} THEN
    RAISE EXCEPTION 'sentinel-roles: a password was not stored as the verifier that was sent';
  END IF;
"""
    return _check_block("sentinel_verify", database, OWNER_WITHOUT_PASSWORD + passwords)


def startup_check(database: str) -> str:
    """A DO block that raises on the first deviation from the invariants, as
    ``status`` checks them, but the passwords, which only the bootstrap
    superuser may read (pg_authid): Sentinel runs it as the login it uses,
    on every start (sentinel/database.py ``verify``)."""
    return _check_block("sentinel_startup", validate_database(database), "")


def _reapply(database: str) -> str:
    """Before apply changes anything in an activated installation (state B): every invariant,
    as the final check reads it, but the passwords of the two logins, which apply sets. What
    differs is not this program's to repair: it refuses, and changes nothing."""
    return _check_block("sentinel_reapply", database, OWNER_WITHOUT_PASSWORD, only_in_state="B")


def _check_block(name: str, database: str, superuser_checks: str, *, only_in_state: str | None = None) -> str:
    db = _literal(database)
    checks = f"""\
{ROLE_OIDS}  IF db_oid IS NULL OR pg_catalog.current_database() <> {db} THEN
    RAISE EXCEPTION 'sentinel-roles: connected to the wrong database';
  END IF;
{LIFECYCLE}  IF state = 'A' THEN
    RAISE EXCEPTION 'sentinel-roles: the roles are not provisioned in this cluster (state A: run apply)';
  END IF;
  IF state = 'C' THEN
    RAISE EXCEPTION '{UNKNOWN_HISTORY}', {_shown('found')};
  END IF;
{DEDICATED_CLUSTER}  IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE oid IN ({MANAGED_OIDS})
              AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR rolinherit
                   OR (rolvaliduntil IS NOT NULL AND rolvaliduntil <> 'infinity'))) THEN
    RAISE EXCEPTION 'sentinel-roles: a managed role has an attribute it must not have';
  END IF;
  IF (SELECT rolcanlogin FROM pg_catalog.pg_roles WHERE oid = owner_oid)
     OR NOT (SELECT rolcanlogin FROM pg_catalog.pg_roles WHERE oid = migrate_oid)
     OR NOT (SELECT rolcanlogin FROM pg_catalog.pg_roles WHERE oid = app_oid) THEN
    RAISE EXCEPTION 'sentinel-roles: the owner role must not log in, the others must';
  END IF;
{superuser_checks}  IF EXISTS (SELECT FROM pg_catalog.pg_auth_members m
              WHERE m.member IN (app_oid, owner_oid) OR m.roleid IN (app_oid, migrate_oid)
                 OR (m.member = migrate_oid AND (m.roleid <> owner_oid OR m.admin_option OR m.inherit_option OR NOT m.set_option))
                 OR (m.roleid = owner_oid AND m.member <> migrate_oid))
     OR NOT EXISTS (SELECT FROM pg_catalog.pg_auth_members m WHERE m.member = migrate_oid AND m.roleid = owner_oid) THEN
    RAISE EXCEPTION 'sentinel-roles: role memberships differ from: {MIGRATION_ROLE} in {OWNER_ROLE} WITH INHERIT FALSE, SET TRUE, ADMIN FALSE, and nothing else';
  END IF;
  IF NOT pg_catalog.pg_has_role(migrate_oid, owner_oid, 'SET') OR pg_catalog.pg_has_role(migrate_oid, owner_oid, 'USAGE')
     OR pg_catalog.pg_has_role(app_oid, owner_oid, 'MEMBER') OR pg_catalog.pg_has_role(app_oid, migrate_oid, 'MEMBER')
     OR pg_catalog.pg_has_role(app_oid, 10, 'MEMBER') OR pg_catalog.pg_has_role(migrate_oid, 10, 'MEMBER') THEN
    RAISE EXCEPTION 'sentinel-roles: a managed role could act as another role';
  END IF;
{OTHER_DATABASES}{TEMPORARY}{CREATE_ANYWHERE}{CONNECT_ELSEWHERE}{LARGE_OBJECTS}  IF NOT pg_catalog.has_database_privilege(app_oid, db_oid, 'CONNECT')
     OR NOT pg_catalog.has_database_privilege(migrate_oid, db_oid, 'CONNECT')
     OR pg_catalog.has_database_privilege(app_oid, db_oid, 'CREATE')
     OR pg_catalog.has_database_privilege(migrate_oid, db_oid, 'CREATE')
     OR pg_catalog.has_database_privilege(owner_oid, db_oid, 'CREATE')
     OR (SELECT datdba FROM pg_catalog.pg_database WHERE oid = db_oid) IN ({MANAGED_OIDS}) THEN
    RAISE EXCEPTION 'sentinel-roles: database privileges differ: CONNECT for the login roles, CREATE for none, owned by none of them';
  END IF;
  -- Exactly these entries, none of them grantable: no TEMPORARY, nothing to pass on.
  IF EXISTS (SELECT FROM pg_catalog.pg_database d, pg_catalog.aclexplode(d.datacl) a
              WHERE d.oid = db_oid AND a.grantee IN ({MANAGED_OIDS})
                AND NOT (a.grantee IN (migrate_oid, app_oid) AND a.privilege_type = 'CONNECT' AND NOT a.is_grantable))
     OR EXISTS (SELECT FROM pg_catalog.pg_namespace n, pg_catalog.aclexplode(n.nspacl) a
                 WHERE n.oid = {PUBLIC_SCHEMA} AND a.grantee IN ({MANAGED_OIDS})
                   AND NOT (NOT a.is_grantable AND ((a.grantee = owner_oid AND a.privilege_type IN ('USAGE', 'CREATE'))
                                                    OR (a.grantee = app_oid AND a.privilege_type = 'USAGE')))) THEN
    RAISE EXCEPTION 'sentinel-roles: the roles hold other privileges on the database or on schema public than CONNECT for the login roles, USAGE and CREATE for the owner, USAGE for the runtime role, none of them grantable';
  END IF;
  IF NOT pg_catalog.has_schema_privilege(owner_oid, {PUBLIC_SCHEMA}, 'USAGE')
     OR NOT pg_catalog.has_schema_privilege(owner_oid, {PUBLIC_SCHEMA}, 'CREATE')
     OR NOT pg_catalog.has_schema_privilege(app_oid, {PUBLIC_SCHEMA}, 'USAGE') THEN
    RAISE EXCEPTION 'sentinel-roles: the owner role must use and create in schema public, the runtime role use it';
  END IF;
  -- Another session's temporary schema answers CREATE for whoever may create temporary tables.
  SELECT pg_catalog.string_agg(n.nspname, ', ' ORDER BY n.nspname) INTO found
    FROM pg_catalog.pg_namespace n
   WHERE n.nspname !~ '^pg_(toast_)?temp_[0-9]+$'
     AND (pg_catalog.has_schema_privilege(app_oid, n.oid, 'CREATE') OR pg_catalog.has_schema_privilege(migrate_oid, n.oid, 'CREATE')
          OR (n.oid <> {PUBLIC_SCHEMA} AND pg_catalog.has_schema_privilege(owner_oid, n.oid, 'CREATE')));
  IF found IS NOT NULL THEN
    RAISE EXCEPTION 'sentinel-roles: a managed role may create objects in schema(s) %', {_shown('found')};
  END IF;
{UNEXPECTED_ACCESS}{FOREIGN_OBJECTS}  IF EXISTS (SELECT FROM pg_catalog.pg_shdepend d
              WHERE d.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
                AND d.refobjid IN (migrate_oid, app_oid) AND d.deptype = 'o') THEN
    RAISE EXCEPTION 'sentinel-roles: a login role owns objects (in some database of the cluster)';
  END IF;
  -- Everything the roles hold in this database or the cluster's shared catalogs, but what this
  -- program gives and what the owner owns in public (or in a session's temporary schema):
  -- EXECUTE on a function, SET on a parameter, a table elsewhere would show up here.
  SELECT pg_catalog.string_agg(item, ', ' ORDER BY item) INTO found FROM (
    SELECT DISTINCT COALESCE(pg_catalog.pg_describe_object(d.classid, d.objid, d.objsubid), d.classid::pg_catalog.regclass::text)
                    || ' (' || d.refobjid::pg_catalog.regrole::text || ')' AS item
      FROM pg_catalog.pg_shdepend d
     WHERE d.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass AND d.refobjid IN ({MANAGED_OIDS})
       AND d.dbid IN (0, db_oid)
       AND NOT (d.refobjid = owner_oid AND d.deptype = 'o' AND d.dbid = db_oid AND (
             (d.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
              AND EXISTS (SELECT FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                           WHERE c.oid = d.objid AND (n.oid = {PUBLIC_SCHEMA} OR n.nspname ~ '^pg_temp_[0-9]+$')))
          OR (d.classid = 'pg_catalog.pg_type'::pg_catalog.regclass
              AND EXISTS (SELECT FROM pg_catalog.pg_type ty JOIN pg_catalog.pg_namespace n ON n.oid = ty.typnamespace
                           WHERE ty.oid = d.objid AND (n.oid = {PUBLIC_SCHEMA} OR n.nspname ~ '^pg_temp_[0-9]+$')))
          OR (d.classid = 'pg_catalog.pg_default_acl'::pg_catalog.regclass
              AND EXISTS (SELECT FROM pg_catalog.pg_default_acl a WHERE a.oid = d.objid AND a.defaclnamespace = {PUBLIC_SCHEMA}))))
       AND NOT (d.deptype = 'a' AND (
             (d.classid = 'pg_catalog.pg_database'::pg_catalog.regclass AND d.objid = db_oid AND d.refobjid IN (migrate_oid, app_oid))
          OR (d.classid = 'pg_catalog.pg_namespace'::pg_catalog.regclass AND d.objid = {PUBLIC_SCHEMA} AND d.refobjid IN (owner_oid, app_oid))
          OR (d.refobjid = app_oid AND d.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
              AND EXISTS (SELECT FROM pg_catalog.pg_class c WHERE c.oid = d.objid AND c.relnamespace = {PUBLIC_SCHEMA}))
          OR (d.refobjid = app_oid AND d.classid = 'pg_catalog.pg_default_acl'::pg_catalog.regclass
              AND EXISTS (SELECT FROM pg_catalog.pg_default_acl a
                           WHERE a.oid = d.objid AND a.defaclrole = owner_oid AND a.defaclnamespace = {PUBLIC_SCHEMA}))))
  ) granted;
  IF found IS NOT NULL THEN
    RAISE EXCEPTION 'sentinel-roles: the roles hold privileges or objects this program neither gives nor takes back (it revokes only privileges of sentinel_app on relations in public); revoke or remove them and run this again: %', {_shown('found')};
  END IF;
  IF EXISTS (SELECT FROM pg_catalog.pg_class c WHERE c.relnamespace = {PUBLIC_SCHEMA} AND c.relowner <> owner_oid) THEN
    RAISE EXCEPTION 'sentinel-roles: a relation in schema public does not belong to the owner role';
  END IF;
  FOR relation IN
    SELECT c.oid, c.relname AS name, c.relkind AS kind FROM pg_catalog.pg_class c
     WHERE c.relnamespace = {PUBLIC_SCHEMA} AND c.relkind IN ('r', 'p', 'S')
  LOOP
    IF relation.kind = 'S' THEN
      IF pg_catalog.has_sequence_privilege(app_oid, relation.oid, 'USAGE')
         OR pg_catalog.has_sequence_privilege(app_oid, relation.oid, 'SELECT')
         OR pg_catalog.has_sequence_privilege(app_oid, relation.oid, 'UPDATE') THEN
        RAISE EXCEPTION 'sentinel-roles: the runtime role has privileges on sequence %', {_shown('relation.name')};
      END IF;
      CONTINUE;
    END IF;
    FOREACH privilege IN ARRAY CASE WHEN relation.name = {_literal(MIGRATIONS_TABLE)}
                                    THEN ARRAY['SELECT'] ELSE ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] END LOOP
      IF NOT pg_catalog.has_table_privilege(app_oid, relation.oid, privilege)
         OR pg_catalog.has_table_privilege(app_oid, relation.oid, privilege || ' WITH GRANT OPTION') THEN
        RAISE EXCEPTION 'sentinel-roles: the runtime role lacks %, or may grant it, on %', privilege, {_shown('relation.name')};
      END IF;
    END LOOP;
    FOREACH privilege IN ARRAY CASE WHEN relation.name = {_literal(MIGRATIONS_TABLE)}
                                    THEN ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']
                                    ELSE ARRAY['TRUNCATE', 'REFERENCES', 'TRIGGER'] END
                            || CASE WHEN pg_catalog.current_setting('server_version_num')::integer >= 170000
                                    THEN ARRAY['MAINTAIN'] ELSE ARRAY[]::text[] END LOOP
      -- On some of the columns is enough for INSERT, UPDATE and REFERENCES. (PL/pgSQL ends
      -- the condition of IF at the first THEN outside parentheses: the CASE needs them.)
      IF (CASE WHEN privilege IN ('INSERT', 'UPDATE', 'REFERENCES')
               THEN pg_catalog.has_any_column_privilege(app_oid, relation.oid, privilege)
               ELSE pg_catalog.has_table_privilege(app_oid, relation.oid, privilege) END) THEN
        RAISE EXCEPTION 'sentinel-roles: the runtime role has % on %', privilege, {_shown('relation.name')};
      END IF;
    END LOOP;
  END LOOP;
  IF EXISTS (SELECT FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid,
                         pg_catalog.aclexplode(a.attacl) x
              WHERE c.relnamespace = {PUBLIC_SCHEMA} AND NOT a.attisdropped AND x.grantee = app_oid) THEN
    RAISE EXCEPTION 'sentinel-roles: the runtime role has column privileges in schema public';
  END IF;
  IF EXISTS (SELECT FROM pg_catalog.pg_default_acl d, pg_catalog.aclexplode(d.defaclacl) a
              WHERE d.defaclrole = owner_oid AND a.grantee <> owner_oid
                AND NOT (d.defaclnamespace = {PUBLIC_SCHEMA} AND d.defaclobjtype = 'r' AND a.grantee = app_oid
                         AND a.privilege_type IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE') AND NOT a.is_grantable))
     OR (SELECT pg_catalog.count(DISTINCT a.privilege_type)
           FROM pg_catalog.pg_default_acl d, pg_catalog.aclexplode(d.defaclacl) a
          WHERE d.defaclrole = owner_oid AND d.defaclnamespace = {PUBLIC_SCHEMA} AND d.defaclobjtype = 'r'
            AND a.grantee = app_oid) <> 4 THEN
    RAISE EXCEPTION 'sentinel-roles: the default privileges of the owner role differ from SELECT, INSERT, UPDATE, DELETE on new tables in public for the runtime role';
  END IF;
  IF EXISTS (SELECT FROM pg_catalog.pg_db_role_setting s
              WHERE s.setrole IN ({MANAGED_OIDS})
                AND (s.setdatabase = 0 OR s.setdatabase = db_oid)
                AND NOT (s.setdatabase = db_oid AND s.setrole IN (migrate_oid, app_oid)
                         AND s.setconfig = ARRAY[{_literal('search_path=' + SEARCH_PATH)}]::text[]))
     OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_db_role_setting s
          WHERE s.setdatabase = db_oid AND s.setrole IN (migrate_oid, app_oid)) <> 2 THEN
    RAISE EXCEPTION 'sentinel-roles: the settings of the managed roles differ from search_path = {SEARCH_PATH} for the login roles in this database';
  END IF;
  IF EXISTS (SELECT FROM pg_catalog.pg_namespace n, pg_catalog.aclexplode(n.nspacl) a
              WHERE n.oid = {PUBLIC_SCHEMA} AND a.grantee = 0 AND a.privilege_type = 'CREATE') THEN
    RAISE EXCEPTION 'sentinel-roles: every role may create objects in schema public';
  END IF;
{TRIPWIRE}"""
    if only_in_state is not None:
        # In state A there is nothing to check yet: the roles do not exist (sentinel_preflight).
        checks = f"  IF pg_catalog.current_setting('sentinel.state') = {_literal(only_in_state)} THEN\n{checks}  END IF;\n"
    return f"""\
DO ${name}$
{DECLARE}  relation record;
  privilege text;
BEGIN
{checks}END
${name}$;
"""


def apply_program(
    database: str,
    runtime_password: str,
    migration_password: str,
    adopt_tables: Sequence[str] = (),
    *,
    salts: tuple[bytes, bytes] | None = None,
    nonce: str | None = None,
) -> Program:
    """The psql program that provisions the roles for ``database``.

    ``nonce`` is what the program prints last, once it has committed
    (random by default); ``salts`` (runtime, migration) are for tests.
    """
    database = validate_database(database)
    validate_password(RUNTIME_PASSWORD_SETTING, runtime_password)
    validate_password(MIGRATION_PASSWORD_SETTING, migration_password)
    if runtime_password == migration_password:
        raise InputError(f"{RUNTIME_PASSWORD_SETTING} and {MIGRATION_PASSWORD_SETTING} must differ")
    tables = validate_tables(adopt_tables)
    runtime_salt, migration_salt = salts or (None, None)
    runtime_verifier = scram_verifier(runtime_password, salt=runtime_salt)
    migration_verifier = scram_verifier(migration_password, salt=migration_salt)
    nonce = _nonce(nonce)
    sql = "".join(
        [
            _header(apply=True),
            SECURE_PATH,
            # First: it holds no secret, and tells another role why it may not run this.
            _session_checks(database),
            QUIET_LOGS,
            "BEGIN;\n",
            "SET LOCAL lock_timeout = '10s';\n",
            "SET LOCAL client_min_messages = warning;\n",
            LOCK,
            _preflight(adopt=bool(tables)),
            _reapply(database),
            _roles(database, runtime_verifier, migration_verifier),
            _adopt(tables),
            OWNERSHIP,
            GRANTS,
            MARKER,
            _verify(database, (runtime_verifier, migration_verifier)),
            "COMMIT;\n",
            f"\\echo sentinel-roles: committed {nonce}\n",
        ]
    )
    return Program(sql, nonce)


def status_program(database: str, *, nonce: str | None = None) -> Program:
    """A read-only psql program that checks every invariant of ``database``."""
    database = validate_database(database)
    nonce = _nonce(nonce)
    sql = "".join(
        [
            _header(apply=False),
            SECURE_PATH,
            _session_checks(database),
            "BEGIN READ ONLY;\n",
            _verify(database, None),
            "ROLLBACK;\n",
            f"\\echo sentinel-roles: verified {nonce}\n",
        ]
    )
    return Program(sql, nonce)


def compose_settings(config: Mapping) -> dict[str, str | None]:
    """POSTGRES_DB and the two passwords as Docker Compose gives them to the db,
    web and migrate services (``docker compose config --format json``), so that
    the roles get exactly the passwords the services will log in with. Refuses
    a configuration that gives web or migrate a password not its own; never
    names a value."""
    services = config.get("services") if isinstance(config, Mapping) else None
    if not isinstance(services, Mapping) or not {"db", "web", "migrate"} <= set(services):
        raise InputError("the Compose configuration has no db, web and migrate services")

    def environment(service: str) -> Mapping:
        values = services[service].get("environment") or {}
        if not isinstance(values, Mapping):
            raise InputError(f"the environment of the {service} service is not resolved")
        return values

    def value(service: str, name: str) -> str:
        found = environment(service).get(name)
        return found if isinstance(found, str) else ""

    owned = {"web": RUNTIME_PASSWORD_SETTING, "migrate": MIGRATION_PASSWORD_SETTING}
    for service, own in owned.items():
        for name in (BOOTSTRAP_PASSWORD, *owned.values()):
            if name != own and value(service, name).strip():
                raise InputError(f"the {service} service would get {name}, which belongs elsewhere (docs/server-deployment.md)")
    database = value("db", DATABASE_SETTING)
    for service in owned:
        if value(service, DATABASE_SETTING) != database:
            raise InputError(f"{DATABASE_SETTING} of the {service} service differs from the db service's")
    return {
        DATABASE_SETTING: database or None,
        RUNTIME_PASSWORD_SETTING: value("web", RUNTIME_PASSWORD_SETTING) or None,
        MIGRATION_PASSWORD_SETTING: value("migrate", MIGRATION_PASSWORD_SETTING) or None,
    }


def _nonce(value: str | None) -> str:
    value = secrets.token_hex(16) if value is None else value
    if not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{32}", value):
        raise InputError("the nonce must be 32 lowercase hexadecimal characters")
    return value


def main(argv: Sequence[str], environ: Mapping[str, str], stdout=None, stderr=None) -> int:
    stdout = sys.stdout if stdout is None else stdout
    stderr = sys.stderr if stderr is None else stderr
    parser = argparse.ArgumentParser(
        prog="python3 -m sentinel.db_roles",
        description="Print a psql program that provisions (apply) or checks (status) the database roles.",
    )
    commands = parser.add_subparsers(dest="command", required=True)
    apply = commands.add_parser(
        "apply", help="activate the roles, or set their passwords once activated, in one transaction"
    )
    apply.add_argument(
        "--adopt-table",
        action="append",
        default=[],
        metavar="NAME",
        help="a table of the bootstrap superuser to hand to the owner role; repeat it for each table "
        "and partition, with web stopped",
    )
    status = commands.add_parser("status", help="check the roles in a read-only transaction")
    for command in (apply, status):
        command.add_argument(
            "--nonce",
            metavar="HEX",
            help="32 lowercase hexadecimal characters the program prints last, once it has finished (default: random)",
        )
        command.add_argument(
            "--compose-config",
            metavar="FILE",
            help="read POSTGRES_DB and the passwords from `docker compose config --format json` (- for standard "
            "input) instead of the environment",
        )
    try:
        arguments = parser.parse_args(list(argv))
    except SystemExit as exc:
        return 2 if exc.code else 0
    try:
        if arguments.compose_config is not None:
            environ = compose_settings(_read_config(arguments.compose_config))
        if arguments.command == "apply":
            program = apply_program(
                environ.get(DATABASE_SETTING),
                environ.get(RUNTIME_PASSWORD_SETTING),
                environ.get(MIGRATION_PASSWORD_SETTING),
                arguments.adopt_table,
                nonce=arguments.nonce,
            )
        else:
            program = status_program(environ.get(DATABASE_SETTING), nonce=arguments.nonce)
    except InputError as exc:
        print(f"sentinel-roles: {exc}", file=stderr)
        return 2
    stdout.write(program.sql)
    return 0


def _read_config(path: str) -> Mapping:
    try:
        if path == "-":
            return json.load(sys.stdin)
        with open(path, encoding="utf-8") as config:
            return json.load(config)
    except (OSError, ValueError) as exc:
        # Neither error quotes the document, which holds the passwords.
        raise InputError(f"the Compose configuration could not be read ({type(exc).__name__})") from None


if __name__ == "__main__":  # pragma: no cover - exercised through main() and a subprocess test
    import os

    sys.exit(main(sys.argv[1:], os.environ))
