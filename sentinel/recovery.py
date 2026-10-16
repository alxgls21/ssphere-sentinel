"""Recovery of the data of an existing installation into a new, dedicated, least-privilege cluster.

The old database is never changed. Its data comes into a new cluster that Sentinel
provisioned itself (``sentinel/db_roles.py``: the three roles, the record of their
activation, the tables made by the migrate login): only data crosses, never roles,
ownership, privileges or schema of the old one. The commands run on one side or the other
and never need both clusters at once; between them goes a bundle, a directory:

``export``   on the old installation, in sessions PostgreSQL keeps read-only: what the
             database holds (a manifest: migrations, tables with their columns,
             constraints and a fingerprint of every row, sequences), a data-only dump
             of schema public without ``django_migrations``, and the manifest again,
             which must be the first. The old database holds nothing of this run.
``import``   on the new installation, before its web service has ever started, with two
             logins of the installation and never a superuser: the runtime login
             (``sentinel_app``) restores the data, with no ``--disable-triggers``; the
             migration login, as the owner role, which owns the sequences the runtime
             login has no privilege on (an identity sequence is used through the INSERT
             on its table), reads the result and sets the sequences.
             It checks, in this order, and stops at the first that fails, naming it:

               bundle              the dump is the one that was exported (SHA-256, and the
                                   bundle's own, if it was pinned), the old database it
                                   was taken from is sound: foreign keys and sequences
               destination.login   it runs as the runtime login, not as a superuser
               destination.trusted the checks the web service makes at every start
                                   (``db_roles.startup_check``): the cluster is Sentinel's
                                   own, the roles and the record of their activation are
                                   what apply left, nothing may do more than it should
               destination.idle    no other session of the logins is connected
               migrations          the same ``(app, name)`` pairs, whatever their ids,
                                   times and order: the dump is data of that schema only
               tables, schema      the same tables, columns, constraints and sequences
               destination.fresh   migrated and never restored into
               dump.toc            the dump holds the data and the sequences of exactly
                                   these tables, and nothing else

             then it records ``restoring`` in the database (the comment on django_migrations,
             which only the owner role can change; every start of web and migrate refuses
             the database until ``activate`` admits it), empties what the migrations seeded (groups, content types,
             permissions: the old database's ids replace them), restores the data of the
             tables in one transaction (``pg_restore --data-only --single-transaction
             --exit-on-error``; the foreign keys are deferred and checked at its end, the
             triggers stay enabled), sets each sequence to give next what the old one would,
             and checks the result against the old database:

               verify.data         every table has the rows of the old one, by a
                                   fingerprint of each
               verify.integrity    no foreign key without its row, every constraint valid
               verify.sequences    each sequence gives next what the old one would (the
                                   value after the last one given, or the one to give
                                   if none was), which is beyond the largest in its
                                   column and within its maximum
               verify.trusted      the destination is as trusted as before, the migrations
                                   as they were
``verify-source``  on the old installation, after the application was stopped and
             before ``activate``: it is exactly what was exported. With ``--work`` the
             finding is recorded, which ``activate`` requires.
``activate`` refuses, starting nothing, unless the import verified the destination, the
             bundle is the one that was imported and ``verify-source`` found the old
             database unchanged. It then checks the destination again (login, trust,
             migrations, tables and schema, every row, the sequences, no session of the
             application), records ``activating``, admits the database and only then starts the stack
             (``docker compose up``): nothing is published before. A start that does not
             complete leaves ``activating``: the application may be running and have
             written, so ``activate`` again only starts the stack again.

A failed check rejects the destination: the work directory says which, and ``activate``
never starts it. Until the restore begins (``restore.clear``) nothing in it changed and
``import`` may be run again once the cause is gone, in a new work directory; from then on
the destination is used, and it is thrown away and made again (docs/server-deployment.md).
The restore is one transaction: what failed in it left nothing of the data. Nothing here
prints a value of a row or a password; the passwords of PostgreSQL are in its environment
(PGPASSWORD, or PGPASSFILE for the two logins) or not needed (the db container's socket),
never on a command line. Exit status: 0 done, 1 rejected or refused, 3 failed for another
reason (a program, a connection, a file).

Standard library only; PostgreSQL's own programs (psql, pg_dump, pg_restore) do the work,
directly or in the db container of a Compose project (``--compose-dir``).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
from collections.abc import Callable, Iterator, Mapping, Sequence
from contextlib import contextmanager
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
from pathlib import Path

from sentinel import database, db_roles

FORMAT = 1
SCHEMA = "public"
RECORD = "django_migrations"
RECORD_SEQUENCE = "django_migrations_id_seq"
# What the migrations of a new installation put in the tables besides django_migrations: the
# groups of the console, and the content types and permissions of every app. The old database's
# own replace them (their ids are what the rest of its data refers to). The last two are in every
# migrated database, so that a destination without them was emptied by an earlier attempt.
SEEDED = ("auth_group_permissions", "auth_group", "auth_permission", "django_content_type")
ALWAYS_SEEDED = ("django_content_type", "auth_permission")
READ_ONLY = "-c default_transaction_read_only=on"
# What a command of the db container runs with: the login and the database of the container,
# unless the caller names another login (PGUSER).
CONTAINER_SHELL = 'PGUSER="${PGUSER:-$POSTGRES_USER}" PGDATABASE="${PGDATABASE:-$POSTGRES_DB}" exec "$@"'
STATE = "state.json"
BUNDLE = "bundle.json"
DUMP = "data.dump"
SHOWN = 5  # how many of a list of differences a message names


class Rejected(Exception):
    """A check failed: which, and what it found. The destination is rejected; the old one is as it was."""

    def __init__(self, check: str, detail: str):
        super().__init__(f"{check}: {detail}")
        self.check = check
        self.detail = detail


class Refused(Rejected):
    """``activate`` is not allowed to start: a condition it needs is not met. The destination is not rejected by it."""


class Failure(Exception):
    """A program could not run, or failed in a way that is no finding about the data."""


# --- running PostgreSQL's programs ------------------------------------------------------------


def withheld(text: str) -> str:
    """What PostgreSQL said, without what could be a value of a row: DETAIL, CONTEXT and QUERY lines carry them,
    and so do some error lines (``invalid input syntax for type integer: "abc"``, ``value "x" is out of range``,
    ``invalid byte sequence ...: 0xc3``); of those only the error lines are kept, shortened, quoted values cut."""
    lines = [line.strip() for line in text.splitlines() if re.match(r"\s*(ERROR|FATAL|psql:|pg_dump:|pg_restore:)", line)]
    shown = []
    for line in lines[:4]:
        line = re.sub(r'(?<=: )".*"\s*$', '"..."', line)
        line = re.sub(r'\bvalue ".*?"', 'value "..."', line)
        line = re.sub(r"(?<=: )0x[0-9a-fA-F]{2}( 0x[0-9a-fA-F]{2})*\s*$", "0x..", line)
        shown.append(line[:600])
    return " | ".join(shown) or "(no message; see the PostgreSQL log)"


@dataclass(frozen=True)
class Endpoint:
    """One cluster, and how to run PostgreSQL's client programs against it.

    Directly, by libpq's own environment (PGHOST, PGPORT, PGDATABASE, PGPASSWORD...), or inside the db
    container of a Compose project, over its socket. ``user`` is the login (PGUSER), ``role`` the role every session
    assumes at its start (``SET ROLE``, which the login must be allowed); ``read_only`` makes
    every session of every program read-only. ``environment`` is added to the programs', never to a
    command line.
    """

    compose_dir: str | None = None
    user: str | None = None
    role: str | None = None
    read_only: bool = False
    environment: Mapping[str, str] = field(default_factory=dict)

    def settings(self) -> dict[str, str]:
        settings = dict(self.environment)
        if self.user:
            settings["PGUSER"] = self.user
        options = [settings.get("PGOPTIONS") or os.environ.get("PGOPTIONS", "")]
        if self.read_only:
            options.append(READ_ONLY)
        if self.role:
            options.append(f"-c role={self.role}")
        if self.read_only or self.role:
            settings["PGOPTIONS"] = " ".join(option for option in options if option)
        return settings

    def command(self, program: str, arguments: Sequence[str] = ()) -> tuple[list[str], dict[str, str]]:
        settings = self.settings()
        if self.compose_dir is None:
            return [program, *arguments], {**os.environ, **settings}
        if "PGPASSWORD" in settings:
            raise Failure("a password is not given to docker on a command line: the db container's socket needs none")
        flags = [word for name, value in settings.items() for word in ("-e", f"{name}={value}")]
        argv = ["docker", "compose", "--project-directory", self.compose_dir, "exec", "-T", *flags, "db",
                "sh", "-c", CONTAINER_SHELL, "sh", program, *arguments]
        return argv, dict(os.environ)

    def run(self, program: str, arguments: Sequence[str] = (), *, stdin: Path | bytes | None = None,
            stdout: Path | None = None) -> subprocess.CompletedProcess:
        argv, environment = self.command(program, arguments)
        files = []
        try:
            kwargs: dict = {}
            if isinstance(stdin, Path):
                files.append(open(stdin, "rb"))  # noqa: SIM115 - closed below
                kwargs["stdin"] = files[-1]
            elif stdin is not None:
                kwargs["input"] = stdin
            else:
                kwargs["stdin"] = subprocess.DEVNULL
            if stdout is not None:
                descriptor = os.open(stdout, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                files.append(os.fdopen(descriptor, "wb"))
                kwargs["stdout"] = files[-1]
            else:
                kwargs["stdout"] = subprocess.PIPE
            return subprocess.run(argv, stderr=subprocess.PIPE, env=environment, check=False, **kwargs)
        except FileNotFoundError as exc:
            if exc.filename not in (None, argv[0]):
                raise
            raise Failure(f"{argv[0]} is not installed or not on PATH") from exc
        finally:
            for file in files:
                file.close()

    def psql(self, script: str) -> str:
        """What ``script`` prints (psql -At: rows only), or a Failure that names the error."""
        result = self.run("psql", ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-w", "-f", "-"], stdin=script.encode())
        if result.returncode != 0:
            raise Failure(withheld(result.stderr.decode(errors="replace")))
        return result.stdout.decode()


# --- what a database holds ----------------------------------------------------------------------

# One JSON document, from one snapshot. A table is compared by its rows' count and a fingerprint
# that does not depend on their order, the order of its columns or the ids of nothing but the rows:
# each row is hashed as JSON (jsonb has the keys in one order), the 128 bits of the MD5 summed as
# two 64-bit numbers (a sum over rows is the same in any order, and takes no memory).
MANIFEST_SQL = f"""\
BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY;
SET LOCAL timezone = 'UTC';
SET LOCAL extra_float_digits = 1;
SET LOCAL intervalstyle = 'postgres';
SET LOCAL bytea_output = 'hex';
SET LOCAL datestyle = 'ISO, MDY';
SET LOCAL search_path = pg_catalog, pg_temp;
WITH tables AS (
  SELECT c.oid, c.relname FROM pg_class c
   WHERE c.relnamespace = '{SCHEMA}'::regnamespace AND c.relkind IN ('r', 'p') AND c.relname <> '{RECORD}'
), counted AS (
  SELECT t.oid, t.relname,
         (xpath('/row/n/text()', q.x))[1]::text AS n, (xpath('/row/a/text()', q.x))[1]::text AS a,
         (xpath('/row/b/text()', q.x))[1]::text AS b
    FROM tables t,
         LATERAL (SELECT query_to_xml(format(
           'SELECT count(*) AS n, coalesce(sum(a), 0) AS a, coalesce(sum(b), 0) AS b FROM ('
           'SELECT (''x'' || substr(md5(to_jsonb(r)::text), 1, 16))::bit(64)::bigint::numeric AS a, '
           '(''x'' || substr(md5(to_jsonb(r)::text), 17, 16))::bit(64)::bigint::numeric AS b FROM %I.%I r) h',
           '{SCHEMA}', t.relname), false, true, '') AS x) q
)
SELECT jsonb_build_object(
  'format', {FORMAT},
  'server', current_setting('server_version'),
  'database', current_database(),
  'migrations', (SELECT coalesce(jsonb_agg(jsonb_build_array(m.app, m.name) ORDER BY m.app, m.name), '[]')
                   FROM {SCHEMA}.{RECORD} m),
  'tables', (SELECT coalesce(jsonb_object_agg(c.relname, jsonb_build_object(
               'rows', c.n::bigint, 'fingerprint', md5(c.n || ':' || c.a || ':' || c.b),
               'columns', (SELECT jsonb_agg(jsonb_build_array(a.attname, format_type(a.atttypid, a.atttypmod),
                                                              a.attnotnull, a.attidentity::text) ORDER BY a.attname)
                             FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped))
             ), '{{}}') FROM counted c),
  'constraints', (SELECT coalesce(jsonb_agg(jsonb_build_array(t.relname, k.contype::text, pg_get_constraintdef(k.oid),
                                                              k.convalidated, k.condeferrable, k.condeferred)
                                            ORDER BY t.relname, k.contype::text, pg_get_constraintdef(k.oid)), '[]')
                    FROM pg_constraint k JOIN pg_class t ON t.oid = k.conrelid
                   WHERE t.relnamespace = '{SCHEMA}'::regnamespace AND t.relname <> '{RECORD}' AND k.contype <> 'n'),
  'foreign_keys', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                     'table', t.relname, 'parent', p.relname,
                     'columns', (SELECT jsonb_agg(a.attname ORDER BY k.n)
                                   FROM unnest(c.conkey) WITH ORDINALITY k(attnum, n)
                                   JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum),
                     'parent_columns', (SELECT jsonb_agg(a.attname ORDER BY k.n)
                                          FROM unnest(c.confkey) WITH ORDINALITY k(attnum, n)
                                          JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum))
                   ORDER BY t.relname, c.conname), '[]')
                     FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_class p ON p.oid = c.confrelid
                    WHERE c.contype = 'f' AND t.relnamespace = '{SCHEMA}'::regnamespace),
  'sequences', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                  'name', s.relname, 'table', t.relname, 'column', a.attname,
                  'increment', q.seqincrement, 'min', q.seqmin, 'max', q.seqmax, 'cycle', q.seqcycle,
                  'last_value', (xpath('/row/l/text()', x.v))[1]::text::bigint,
                  'is_called', (xpath('/row/c/text()', x.v))[1]::text = 'true',
                  'column_max', (xpath('/row/m/text()', x.m))[1]::text::bigint) ORDER BY s.relname), '[]')
                  FROM pg_class s
                  JOIN pg_sequence q ON q.seqrelid = s.oid
                  LEFT JOIN pg_depend d ON d.objid = s.oid AND d.classid = 'pg_class'::regclass
                                       AND d.refclassid = 'pg_class'::regclass AND d.deptype IN ('a', 'i')
                  LEFT JOIN pg_class t ON t.oid = d.refobjid
                  LEFT JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = d.refobjsubid
                  CROSS JOIN LATERAL (SELECT
                    query_to_xml(format('SELECT last_value AS l, is_called AS c FROM %I.%I', '{SCHEMA}', s.relname),
                                 false, true, '') AS v,
                    CASE WHEN t.relname IS NULL THEN NULL ELSE
                      query_to_xml(format('SELECT max(%I)::bigint AS m FROM %I.%I', a.attname, '{SCHEMA}', t.relname),
                                   false, true, '') END AS m) x
                 WHERE s.relkind = 'S' AND s.relnamespace = '{SCHEMA}'::regnamespace AND s.relname <> '{RECORD_SEQUENCE}'),
  'outside', (SELECT coalesce(jsonb_agg(DISTINCT n.nspname || '.' || c.relname ORDER BY n.nspname || '.' || c.relname), '[]')
                FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
               WHERE c.relkind IN ('r', 'p', 'm') AND n.nspname <> '{SCHEMA}' AND n.nspname !~ '^pg_'
                 AND n.nspname <> 'information_schema' AND n.nspname <> '{db_roles.RESTRICTED_SCHEMA}'),
  'large_objects', (SELECT count(*) FROM pg_largeobject_metadata)
)::text;
ROLLBACK;
"""

DATA_KEYS = ("rows", "fingerprint")


def quote_ident(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def read_manifest(endpoint: Endpoint) -> dict:
    output = endpoint.psql(MANIFEST_SQL).strip()
    try:
        manifest = json.loads(output)
    except ValueError as exc:
        raise Failure("the manifest of the database is not JSON") from exc
    if manifest.get("format") != FORMAT:
        raise Failure(f"the manifest has format {manifest.get('format')}, not {FORMAT}")
    return manifest


def listed(items) -> str:
    items = sorted(str(item) for item in items)
    more = f" and {len(items) - SHOWN} more" if len(items) > SHOWN else ""
    return ", ".join(items[:SHOWN]) + more


def check_migrations(source: dict, destination: dict) -> None:
    """The migrations are the same pairs (app, name): nothing of their ids, times or order is compared."""
    old = {tuple(pair) for pair in source["migrations"]}
    new = {tuple(pair) for pair in destination["migrations"]}
    if old != new:
        only_old = [f"{app}.{name}" for app, name in old - new]
        only_new = [f"{app}.{name}" for app, name in new - old]
        parts = []
        if only_old:
            parts.append(f"only the old database has {listed(only_old)}")
        if only_new:
            parts.append(f"only the new one has {listed(only_new)}")
        raise Rejected("migrations", "the migration histories differ: " + "; ".join(parts) +
                       " (the new installation must run the release the old one runs; update after the recovery)")


def check_tables(source: dict, destination: dict) -> None:
    old, new = set(source["tables"]), set(destination["tables"])
    if old != new:
        parts = []
        if old - new:
            parts.append(f"only the old database has {listed(old - new)}")
        if new - old:
            parts.append(f"only the new one has {listed(new - old)}")
        raise Rejected("tables", "the tables differ: " + "; ".join(parts))


def check_schema(source: dict, destination: dict) -> None:
    """The columns, the constraints and the sequences' own settings are the same: only data crosses."""
    differing = []
    for table, old in sorted(source["tables"].items()):
        if old["columns"] != destination["tables"][table]["columns"]:
            differing.append(f"columns of {table}")
    if sorted(map(tuple, source["constraints"])) != sorted(map(tuple, destination["constraints"])):
        old = {tuple(item) for item in map(tuple, source["constraints"])}
        new = {tuple(item) for item in map(tuple, destination["constraints"])}
        differing += [f"constraint {item[2]} of {item[0]}" for item in sorted(old ^ new)]
    shape = ("table", "column", "increment", "min", "max", "cycle")
    old_sequences = {item["name"]: tuple(item[key] for key in shape) for item in source["sequences"]}
    new_sequences = {item["name"]: tuple(item[key] for key in shape) for item in destination["sequences"]}
    if old_sequences != new_sequences:
        differing += [f"sequence {name}" for name in sorted(set(old_sequences) ^ set(new_sequences))]
        differing += [f"sequence {name}" for name in sorted(old_sequences)
                      if name in new_sequences and old_sequences[name] != new_sequences[name]]
    always = [f"identity ALWAYS column {table}.{column[0]}" for table, info in destination["tables"].items()
              for column in info["columns"] if column[3] == "a"]
    if differing or always:
        raise Rejected("schema", "the schemas differ: " + listed(differing + always))


def check_data(source: dict, destination: dict) -> None:
    """Each table has the rows of the old one: the count and the fingerprint of all of them."""
    missing = []
    for table, old in sorted(source["tables"].items()):
        new = destination["tables"].get(table)
        if new is None:
            missing.append(f"{table} is missing")
        elif old["rows"] != new["rows"]:
            missing.append(f"{table} has {new['rows']} rows, the old one {old['rows']}")
        elif old["fingerprint"] != new["fingerprint"]:
            missing.append(f"{table} has other content than the old one ({old['rows']} rows)")
    if missing:
        raise Rejected("verify.data", "; ".join(missing[:SHOWN]) + (f" and {len(missing) - SHOWN} more" if len(missing) > SHOWN else ""))


def next_value(sequence: Mapping) -> int:
    """The value nextval gives next: last_value is the one given last, unless nothing was given yet
    (is_called false), when it is the one to give."""
    return sequence["last_value"] + sequence["increment"] if sequence["is_called"] else sequence["last_value"]


def sequence_problems(sequences: Sequence[Mapping]) -> list[str]:
    """What is wrong with each sequence: it must give values the column does not hold yet, for good."""
    problems = []
    for sequence in sequences:
        name, following = sequence["name"], next_value(sequence)
        if sequence["table"] is None:
            problems.append(f"{name} belongs to no column")
        if sequence["increment"] <= 0:
            problems.append(f"{name} does not count up")
        if sequence["cycle"]:
            problems.append(f"{name} starts again at its end")
        if following > sequence["max"]:
            problems.append(f"{name} is exhausted: its next value {following} is beyond its maximum {sequence['max']}")
        elif following < sequence["min"]:
            problems.append(f"{name} is below its minimum")
        elif sequence["column_max"] is not None and following <= sequence["column_max"]:
            problems.append(f"{name} would give {following}, which {sequence['table']}.{sequence['column']} has already "
                            f"(largest {sequence['column_max']})")
    return problems


def check_sequences_match(source: dict, destination: dict) -> None:
    """Each sequence gives next what the old one would: not the same (last_value, is_called), which says the
    same by two numbers, but the same next value."""
    old = {item["name"]: next_value(item) for item in source["sequences"]}
    new = {item["name"]: next_value(item) for item in destination["sequences"]}
    differing = [f"{name} would give {new.get(name)}, the old one {following}" for name, following in sorted(old.items())
                 if new.get(name) != following]
    if differing:
        raise Rejected("verify.sequences", "; ".join(differing[:SHOWN]))


def literal(text: str) -> str:
    return "'" + text.replace("'", "''") + "'"


def sequences_sql(manifest: dict) -> str:
    """Each sequence set to give next what the old one would (is_called false: the value is the next, not the last)."""
    return ("BEGIN;\n" + "".join(
        f"SELECT pg_catalog.setval({literal(SCHEMA + '.' + quote_ident(item['name']))}::regclass, {int(next_value(item))}, false);\n"
        for item in manifest["sequences"]) + "COMMIT;\n")


def integrity_sql(manifest: dict) -> str:
    """One query for each foreign key: the rows whose referenced row is not there (MATCH SIMPLE: a NULL in a
    column of the key means no reference)."""
    queries = []
    for index, key in enumerate(manifest["foreign_keys"]):
        child, parent = quote_ident(key["table"]), quote_ident(key["parent"])
        present = " AND ".join(f"c.{quote_ident(column)} IS NOT NULL" for column in key["columns"])
        joined = " AND ".join(f"p.{quote_ident(parent_column)} = c.{quote_ident(column)}"
                              for column, parent_column in zip(key["columns"], key["parent_columns"], strict=True))
        queries.append(f"SELECT {index}, (SELECT count(*) FROM {SCHEMA}.{child} c WHERE {present} "
                       f"AND NOT EXISTS (SELECT 1 FROM {SCHEMA}.{parent} p WHERE {joined}));")
    return ("BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY;\nSET LOCAL search_path = pg_catalog, pg_temp;\n"
            + "\n".join(queries) + "\nROLLBACK;\n")


def orphans(endpoint: Endpoint, manifest: dict) -> list[str]:
    """The foreign keys with rows that refer to nothing: 'table (columns) -> parent: n'."""
    keys = manifest["foreign_keys"]
    if not keys:
        return []
    found = []
    for line in endpoint.psql(integrity_sql(manifest)).splitlines():
        index, _, count = line.partition("|")
        if int(count):
            key = keys[int(index)]
            found.append(f"{key['table']} ({', '.join(key['columns'])}) -> {key['parent']}: {count} rows")
    return found


def not_valid(manifest: dict) -> list[str]:
    return [f"{item[2]} of {item[0]}" for item in manifest["constraints"] if not item[3]]


def soundness(endpoint: Endpoint, manifest: dict) -> list[str]:
    """What is unsound in the data of a database: orphans, constraints not validated, sequences."""
    problems = [f"foreign key {item}" for item in orphans(endpoint, manifest)]
    problems += [f"constraint not validated: {item}" for item in not_valid(manifest)]
    problems += sequence_problems(manifest["sequences"])
    return problems


# --- the dump -----------------------------------------------------------------------------------

TOC = re.compile(r"^\d+; \d+ \d+ (?P<kind>[A-Z][A-Z ]*?) (?P<schema>\S+) (?P<name>\S+) (?P<owner>\S+)$")


def contents(endpoint: Endpoint, dump: Path) -> dict[str, list[str]]:
    """What a dump holds, by ``pg_restore --list``: the tables whose data it has, the sequences it sets, and
    whatever else it has (which a dump of data alone does not)."""
    result = endpoint.run("pg_restore", ["--list"], stdin=dump)
    if result.returncode != 0:
        raise Rejected("dump.toc", "the dump cannot be read: " + withheld(result.stderr.decode(errors="replace")))
    found: dict[str, list[str]] = {"tables": [], "sequences": [], "other": []}
    for line in result.stdout.decode(errors="replace").splitlines():
        if not line.strip() or line.startswith(";"):
            continue
        match = TOC.match(line)
        if match and match["kind"] == "TABLE DATA" and match["schema"] == SCHEMA:
            found["tables"].append(match["name"])
        elif match and match["kind"] == "SEQUENCE SET" and match["schema"] == SCHEMA:
            found["sequences"].append(match["name"])
        else:
            found["other"].append(line.strip()[:80])
    return found


def check_contents(found: Mapping[str, list[str]], manifest: dict) -> None:
    """The dump has the data of exactly the application's tables (each once) and sets exactly its sequences."""
    problems = []
    tables, sequences = set(manifest["tables"]), {item["name"] for item in manifest["sequences"]}
    present = set(found["tables"])
    if tables - present:
        problems.append(f"it has no data of {listed(tables - present)}")
    if present - tables:
        problems.append(f"it has data of {listed(present - tables)}, which are not application tables")
    if len(found["tables"]) != len(present):
        problems.append("it has the data of a table twice")
    if set(found["sequences"]) != sequences:
        problems.append(f"the sequences it sets are not the application's ({listed(set(found['sequences']) ^ sequences)})")
    if found["other"]:
        problems.append(f"it holds more than data: {listed(found['other'])}")
    if problems:
        raise Rejected("dump.toc", "; ".join(problems))


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as file:
        for block in iter(lambda: file.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


# --- the bundle -----------------------------------------------------------------------------------


def private_directory(path: Path) -> None:
    path.mkdir(mode=0o700, parents=True, exist_ok=False)
    path.chmod(0o700)


def write_json(path: Path, data: Mapping) -> None:
    """Atomically: written to a file of its own, then renamed over."""
    temporary = path.with_name(path.name + ".part")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w") as file:
        json.dump(data, file, indent=1, sort_keys=True)
        file.write("\n")
        file.flush()
        os.fsync(file.fileno())
    os.replace(temporary, path)


def read_json(path: Path) -> dict:
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError) as exc:
        raise Rejected("bundle", f"{path} cannot be read: {exc}") from exc


def source_problems(manifest: dict) -> list[str]:
    """What stops a database from being recovered, which its own data would not show."""
    problems = []
    if manifest["outside"]:
        problems.append(f"it has tables outside schema {SCHEMA}: {listed(manifest['outside'])}")
    if manifest["large_objects"]:
        problems.append(f"it has {manifest['large_objects']} large objects, which a dump of schema {SCHEMA} does not carry")
    return problems


def export_bundle(source: Endpoint, bundle: Path, log: Callable[[str], None] = print) -> dict:
    """Read the old database, in read-only sessions, into ``bundle`` (a new directory). It is the old
    database's own data and holds hashes of its passwords: private to the one who runs this."""
    if not source.read_only:
        raise Failure("the old database is read in read-only sessions only")
    private_directory(bundle)
    try:
        before = read_manifest(source)
        log(f"recovery: the old database {before['database']} (PostgreSQL {before['server']}) holds "
            f"{len(before['tables'])} tables and {sum(item['rows'] for item in before['tables'].values())} rows")
        problems = source_problems(before)
        if problems:
            raise Rejected("source", "; ".join(problems))
        dump = bundle / DUMP
        result = source.run("pg_dump", ["--data-only", "--format=custom", f"--schema={SCHEMA}", f"--exclude-table={RECORD}",
                                        f"--exclude-table={RECORD_SEQUENCE}"], stdout=dump)
        if result.returncode != 0:
            raise Failure("pg_dump failed: " + withheld(result.stderr.decode(errors="replace")))
        found = contents(source, dump)
        check_contents(found, before)
        integrity = soundness(source, before)
        after = read_manifest(source)
        if comparable(after) != comparable(before):
            changed = [name for name in before["tables"] if before["tables"][name] != after["tables"].get(name)]
            raise Rejected("source", "the old database changed while it was being read" +
                           (f" (tables: {listed(changed)})" if changed else "") + ": stop the application and export again")
        write_json(bundle / BUNDLE, {
            "format": FORMAT, "created": datetime.now(UTC).isoformat(timespec="seconds"),
            "source": {"manifest": before, "unsound": integrity},
            "dump": {"file": DUMP, "sha256": sha256(dump), "bytes": dump.stat().st_size, **found},
        })
    except BaseException:
        shutil.rmtree(bundle, ignore_errors=True)  # the directory made above, and what was written into it
        raise
    log(f"recovery: exported to {bundle}; the old database was read, never written"
        + (f"; it is not sound: {listed(integrity)}" if integrity else ""))
    log(f"recovery: bundle SHA-256 {bundle_digest(bundle)} (give it to import as --bundle-sha256 if the bundle travels)")
    return {"manifest": before, "unsound": integrity}


def comparable(manifest: dict) -> dict:
    """A manifest without what a minor release of the server changes."""
    return {key: value for key, value in manifest.items() if key != "server"}


def bundle_digest(bundle: Path) -> str:
    """The SHA-256 of the bundle's record, which holds the dump's: what a bundle is pinned by."""
    return sha256(bundle / BUNDLE)


def load_bundle(bundle: Path) -> dict:
    data = read_json(bundle / BUNDLE)
    if data.get("format") != FORMAT or "source" not in data or "dump" not in data:
        raise Rejected("bundle", f"{bundle / BUNDLE} is not a bundle of this format")
    if data["dump"].get("file") != DUMP:
        raise Rejected("bundle", f"the dump is {DUMP}, in the bundle's own directory")
    dump = bundle / DUMP
    if dump.is_symlink() or not dump.is_file():
        raise Rejected("bundle", "the dump is missing, or is not a regular file")
    if sha256(dump) != data["dump"]["sha256"]:
        raise Rejected("bundle", "the dump is not the one that was exported (its SHA-256 differs)")
    return data


def verify_source(source: Endpoint, bundle: Path, log: Callable[[str], None] = print, work: Path | None = None) -> None:
    """The old database is still what the bundle was made from: nothing in it changed since. With ``work``, the
    import's work directory, the finding is recorded there: ``activate`` starts nothing without it."""
    record = Work.open(work) if work is not None else None
    if record is not None:  # the earlier finding ends here: only this verification, if it passes, authorizes
        record.data.pop("source_verified", None)
        record.save()
    data = load_bundle(bundle)
    now = read_manifest(source)
    old = data["source"]["manifest"]
    changed = [name for name in old["tables"] if old["tables"][name] != now["tables"].get(name)]
    changed += [f"sequence {item['name']}" for item in old["sequences"] if item not in now["sequences"]]
    if comparable(now) != comparable(old):
        raise Rejected("source", "the old database is not what was exported" + (f" ({listed(changed)})" if changed else ""))
    log("recovery: the old database is exactly what was exported")
    if record is not None:
        record.data["source_verified"] = bundle_digest(bundle)
        record.save()


# --- the work directory --------------------------------------------------------------------------


class Work:
    """The record of one import: what state it reached and what it found, kept in a private directory."""

    def __init__(self, path: Path):
        self.path = path
        self.data: dict = {}

    @classmethod
    def new(cls, path: Path, bundle: Path) -> Work:
        work = cls(path)
        private_directory(path)
        work.data = {"format": FORMAT, "state": "checking", "bundle": str(bundle.resolve()), "checks": [], "failed": None}
        work.save()
        return work

    @classmethod
    def open(cls, path: Path) -> Work:
        work = cls(path)
        work.data = read_json(path / STATE)
        return work

    def save(self) -> None:
        write_json(self.path / STATE, self.data)

    def passed(self, check: str) -> None:
        self.data["checks"].append(check)
        self.save()

    def to(self, state: str, **extra) -> None:
        self.data["state"] = state
        self.data.update(extra)
        self.save()


# --- the destination -------------------------------------------------------------------------------


def trusted(destination: Endpoint, check: str) -> str:
    """The checks of every start of the web service, as the runtime login, in a read-only session: that the
    cluster is Sentinel's own and the roles, their record and what each may do are what ``apply`` left.
    Returns the database's name."""
    who = destination.psql("SELECT current_user, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user), "
                           "current_database();").strip()
    user, superuser, database = who.split("|")
    if user != db_roles.RUNTIME_ROLE or superuser != "f":
        raise Rejected("destination.login", f"the restore runs as {db_roles.RUNTIME_ROLE}, not as {user}"
                       + (" (a superuser)" if superuser == "t" else ""))
    script = ("BEGIN READ ONLY;\nSELECT pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', true);\n"
              + db_roles.startup_check(database) + "\nROLLBACK;\n")
    try:
        destination.psql(script)
    except Failure as exc:
        found = re.search(r"sentinel-roles: (.*?)(?: \||$)", str(exc))
        if not found:
            raise  # the program or the connection failed: no finding about the destination
        raise Rejected(check, found[1]) from exc
    return database


def identity(destination: Endpoint) -> dict:
    """What tells a destination from another, and from the same one made again."""
    line = destination.psql(
        "SELECT (SELECT oid FROM pg_database WHERE datname = current_database()), "
        "coalesce(obj_description(to_regnamespace('" + db_roles.RESTRICTED_SCHEMA + "'), 'pg_namespace'), '');").strip()
    oid, _, record = line.partition("|")
    return {"database_oid": int(oid), "record": record}


def check_idle(destination: Endpoint, grace: float = 3.0, interval: float = 0.25) -> None:
    """No other session of the application's logins: the backend of a program that has just ended may take a
    moment to leave, so a session is looked for again for ``grace`` seconds before it counts."""
    deadline = time.monotonic() + grace
    while True:
        others = destination.psql(
            "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() "
            f"AND usename IN ('{db_roles.RUNTIME_ROLE}', '{db_roles.MIGRATION_ROLE}');").strip()
        if not int(others):
            return
        if time.monotonic() >= deadline:
            raise Rejected("destination.idle", f"{others} other sessions of the application's logins are connected: "
                           "the application must not run before the recovery has been verified")
        time.sleep(interval)


def check_fresh(destination: dict) -> None:
    """Migrated, and nothing restored: the only rows are the ones the migrations seed."""
    own = [f"{table} ({info['rows']} rows)" for table, info in sorted(destination["tables"].items())
           if info["rows"] and table not in SEEDED]
    unseeded = [table for table in ALWAYS_SEEDED if not destination["tables"].get(table, {}).get("rows")]
    if own:
        raise Rejected("destination.fresh", f"it holds data of its own: {listed(own)}; a destination is used once: make a new one")
    if unseeded:
        raise Rejected("destination.fresh", f"{listed(unseeded)} was emptied, by an earlier restore that did not finish; "
                       "a destination is used once: make a new one")


def restore_arguments(database: str, tables: Sequence[str]) -> list[str]:
    """One transaction, the first error ends it, the foreign keys and the triggers as they are (nothing here bypasses
    them, nor needs a superuser), and the tables named: the sequences the dump also sets are the ones the runtime
    login has no privilege on, and are set apart (``sequences_sql``)."""
    return ["--data-only", "--single-transaction", "--exit-on-error", "--no-password", f"--schema={SCHEMA}",
            *(f"--table={table}" for table in sorted(tables)), f"--dbname={database}"]


def set_admission(owner: Endpoint, state: str) -> None:
    """Record in the database, as the owner role (the runtime login cannot), what a start of web or migrate is to
    find: anything but ``admitted`` refuses it (``database.recovery_state``)."""
    owner.psql(f"COMMENT ON TABLE {database.RECOVERY_RECORD} IS {literal(database.RECOVERY_MARK + state)};")


def clear_sql() -> str:
    return "BEGIN;\n" + "\n".join(f"DELETE FROM {SCHEMA}.{quote_ident(table)};" for table in SEEDED) + "\nCOMMIT;\n"


@contextmanager
def step(work: Work, name: str, log: Callable[[str], None]) -> Iterator[None]:
    """A check: logged when it passed, and recorded; when it fails, the destination is rejected, by it."""
    try:
        yield
    except Rejected as exc:
        work.to("rejected", failed={"check": exc.check, "detail": exc.detail})
        raise
    work.passed(name)
    log(f"recovery: {name}: passed")


def import_bundle(runtime: Endpoint, owner: Endpoint, bundle: Path, work_directory: Path,
                  log: Callable[[str], None] = print, expected_sha256: str | None = None) -> Work:
    """Restore the data of ``bundle`` into the destination, and verify it: the data as ``runtime`` (the runtime
    login), what ``runtime`` has no privilege on (the sequences) as ``owner`` (the migration login, as the owner
    role). ``expected_sha256`` pins the bundle (``bundle_digest``, which export prints). Returns the work, in state
    ``verified``; raises Rejected, the work in state ``rejected``, at the first check that fails."""
    work = Work.new(work_directory, bundle)
    try:
        return _import(runtime, owner, bundle, work, log, expected_sha256)
    except Rejected:
        raise
    except BaseException as exc:
        # Whatever else stops it, the destination is not accepted: a restore that was under way is no use.
        work.to("rejected", failed={"check": "import", "detail": f"{type(exc).__name__}: {str(exc)[:200]}"})
        raise


def _import(runtime: Endpoint, owner: Endpoint, bundle: Path, work: Work, log: Callable[[str], None],
            expected_sha256: str | None) -> Work:
    reader = replace(owner, read_only=True)
    with step(work, "bundle", log):
        data = load_bundle(bundle)
        digest = bundle_digest(bundle)
        if expected_sha256 is not None and digest != expected_sha256.strip().lower():
            raise Rejected("bundle", "the bundle is not the one whose SHA-256 was given")
        work.data["bundle_sha256"] = digest  # saved with the step: what activate compares
        source = data["source"]["manifest"]
        if data["source"]["unsound"]:
            raise Rejected("bundle", "the old database is not sound: " + listed(data["source"]["unsound"]))
        problems = source_problems(source)
        if problems:
            raise Rejected("bundle", "; ".join(problems))
    with step(work, "destination.login", log):
        trusted_database = trusted(runtime, "destination.trusted")  # the login first, then the cluster
    work.passed("destination.trusted")
    log("recovery: destination.trusted: passed")
    with step(work, "destination.idle", log):
        check_idle(reader)
    with step(work, "destination.manifest", log):
        before = read_manifest(reader)
        if before["database"] != trusted_database:
            raise Rejected("destination.trusted", "the database changed while it was read")
    with step(work, "migrations", log):
        check_migrations(source, before)
    with step(work, "tables", log):
        check_tables(source, before)
    with step(work, "schema", log):
        check_schema(source, before)
    with step(work, "destination.fresh", log):
        check_fresh(before)
    with step(work, "dump.toc", log):
        check_contents(contents(reader, bundle / data["dump"]["file"]), source)
    who = identity(reader)

    # From here the destination is changed: an attempt that is interrupted leaves it used, and says so. In the
    # database first: whatever stops this, from here on, web and migrate refuse it until activate admits it.
    set_admission(owner, "restoring")
    work.to("restoring", destination=who)
    with step(work, "restore.clear", log):
        try:
            runtime.psql(clear_sql())
        except Failure as exc:
            raise Rejected("restore.clear", f"the rows of the migrations could not be replaced: {exc}") from exc
    with step(work, "restore.data", log):
        result = runtime.run("pg_restore", restore_arguments(trusted_database, source["tables"]),
                             stdin=bundle / data["dump"]["file"])
        if result.returncode != 0:
            raise Rejected("restore.data", "the restore failed, in one transaction, and left nothing of the data: "
                           + withheld(result.stderr.decode(errors="replace")))
    with step(work, "restore.sequences", log):
        try:
            owner.psql(sequences_sql(source))
        except Failure as exc:
            raise Rejected("restore.sequences", f"the sequences could not be set: {exc}") from exc
    work.to("restored")

    after = read_manifest(reader)
    with step(work, "verify.data", log):
        check_data(source, after)
    with step(work, "verify.integrity", log):
        problems = [f"foreign key {item}" for item in orphans(reader, after)] + \
                   [f"constraint not validated: {item}" for item in not_valid(after)]
        if problems:
            raise Rejected("verify.integrity", listed(problems))
        check_schema(source, after)
    with step(work, "verify.sequences", log):
        check_sequences_match(source, after)
        problems = sequence_problems(after["sequences"])
        if problems:
            raise Rejected("verify.sequences", "; ".join(problems[:SHOWN]))
    with step(work, "verify.trusted", log):
        trusted(runtime, "verify.trusted")
        if identity(reader) != who:
            raise Rejected("verify.trusted", "the database is not the one that was restored into")
        if after["migrations"] != before["migrations"]:
            raise Rejected("verify.trusted", "the record of the migrations changed")
    work.to("verified")
    log("recovery: VERIFIED: the destination holds exactly the data of the old database; nothing is started until it is activated")
    return work


# --- the cutover ---------------------------------------------------------------------------------


def activate(runtime: Endpoint, owner: Endpoint, work_directory: Path, start: Callable[[], None] | None,
             log: Callable[[str], None] = print) -> None:
    """Start the stack on a destination that is verified, and is still exactly that. Refused, and nothing
    started, unless the work directory says it was verified, the bundle is the one that was imported, and
    ``verify-source`` found the old database unchanged since. The destination is checked again (the login, the
    trust, the migrations, tables and schema, every row, the sequences, no session of the application) and the
    state becomes ``activating`` before anything is started. A start that does not complete leaves it there:
    the stack may be partly up, and running this again only starts it again."""
    reader = replace(owner, read_only=True)
    work = Work.open(work_directory)
    state = work.data.get("state")
    if state not in ("verified", "activating"):
        failed = work.data.get("failed")
        raise Refused("activate", f"the destination is {state}, not verified"
                       + (f" ({failed['check']}: {failed['detail']})" if failed else "") + ": it is not started")
    bundle = Path(work.data["bundle"])
    data = load_bundle(bundle)
    digest = bundle_digest(bundle)
    if digest != work.data.get("bundle_sha256"):
        raise Refused("activate", "the bundle is not the one that was imported: it is not started")
    if work.data.get("source_verified") != digest:
        raise Refused("activate", "the old database was not found unchanged since the export: run verify-source with "
                      "--work, with the old installation stopped; nothing is started")
    source = data["source"]["manifest"]
    if state == "verified":
        try:
            trusted(runtime, "activate.trusted")
            if identity(reader) != work.data["destination"]:
                raise Rejected("activate.trusted", "the database is not the one that was verified")
            now = read_manifest(reader)
            check_migrations(source, now)
            check_tables(source, now)
            check_schema(source, now)  # the constraints too, validated or not: with the rows, no row without its parent
            check_data(source, now)
            check_sequences_match(source, now)
            problems = sequence_problems(now["sequences"])
            if problems:
                raise Rejected("verify.sequences", "; ".join(problems[:SHOWN]))
            check_idle(reader)  # last: after the slowest read, the application must still not be there
        except Rejected as exc:
            work.to("rejected", failed={"check": exc.check, "detail": exc.detail})
            raise
        log("recovery: activate: the destination is still what was verified")
        work.to("activating")
    else:
        log("recovery: activate: an earlier start did not complete; starting again, without the checks (the application "
            "may be running and have written)")
    set_admission(owner, "admitted")
    if start is not None:
        start()
    work.to("activated")
    log("recovery: ACTIVATED" if start is not None else "recovery: AUTHORIZED: start the application")


def compose_start(directory: str) -> Callable[[], None]:
    def start() -> None:
        result = subprocess.run(["docker", "compose", "--project-directory", directory, "up", "--detach", "--wait"],
                                check=False)
        if result.returncode != 0:
            raise Failure("docker compose up did not complete: the destination is verified and the stack may be partly "
                          "up. Look at docker compose ps and the logs, then run activate again: it starts the stack again "
                          "without the checks, since the application may already have written. Never discard this destination")

    return start


# --- the command line -----------------------------------------------------------------------------


def parser() -> argparse.ArgumentParser:
    commands = argparse.ArgumentParser(prog="python3 -m sentinel.recovery", description=__doc__.split("\n\n")[0])
    sub = commands.add_subparsers(dest="command", required=True)

    def common(command: argparse.ArgumentParser, *, logins: bool) -> None:
        command.add_argument(
            "--compose-dir", help="the Compose project whose db container is the cluster (its socket: no password) "
            "(default: libpq's environment: PGHOST, PGPORT, PGDATABASE" + (
                "; the passwords of the two logins of the new installation by PGPASSFILE, the logins are fixed"
                if logins else ", PGUSER, PGPASSWORD") + ")")

    export = sub.add_parser("export", help="read the old database into a bundle (never writes it)")
    export.add_argument("--bundle", required=True, type=Path, help="a directory that does not exist yet")
    common(export, logins=False)
    verify = sub.add_parser("verify-source", help="check that the old database is still what the bundle was made from")
    verify.add_argument("--bundle", required=True, type=Path)
    verify.add_argument("--work", type=Path, help="the import's work directory: records that the old database was found unchanged "
                        "(activate requires it)")
    common(verify, logins=False)
    restore = sub.add_parser("import", help="restore a bundle into a new installation and verify it")
    restore.add_argument("--bundle", required=True, type=Path)
    restore.add_argument("--bundle-sha256", help="the SHA-256 export printed: the bundle must be that one")
    restore.add_argument("--work", required=True, type=Path, help="a directory that does not exist yet: the record of this import")
    common(restore, logins=True)
    start = sub.add_parser("activate", help="start the stack on a verified destination")
    start.add_argument("--work", required=True, type=Path)
    common(start, logins=True)
    return commands


def main(argv: Sequence[str]) -> int:
    arguments = parser().parse_args(argv)
    directory = arguments.compose_dir
    try:
        if arguments.command in ("export", "verify-source"):
            source = Endpoint(compose_dir=directory, read_only=True)
            if arguments.command == "export":
                export_bundle(source, arguments.bundle)
            else:
                verify_source(source, arguments.bundle, work=arguments.work)
        else:
            runtime = Endpoint(compose_dir=directory, user=db_roles.RUNTIME_ROLE)
            owner = Endpoint(compose_dir=directory, user=db_roles.MIGRATION_ROLE, role=db_roles.OWNER_ROLE)
            if arguments.command == "import":
                import_bundle(runtime, owner, arguments.bundle, arguments.work, expected_sha256=arguments.bundle_sha256)
            else:
                activate(runtime, owner, arguments.work, compose_start(directory) if directory else None)
    except Refused as exc:
        print(f"recovery: REFUSED: {exc.check}: {exc.detail}", file=sys.stderr)
        return 1
    except Rejected as exc:
        print(f"recovery: REJECTED: {exc.check}: {exc.detail}", file=sys.stderr)
        if arguments.command in ("import", "activate"):
            print("recovery: the destination is rejected and is not started; the old installation was not touched. "
                  "When the restore had begun (restore.clear and after) the destination is used: make a new one "
                  "(docs/server-deployment.md).", file=sys.stderr)
        return 1
    except (Failure, OSError) as exc:
        print(f"recovery: failed: {exc}", file=sys.stderr)
        return 3
    except Exception as exc:  # a bundle or a record that is not what it should be: never the status of a rejection
        print(f"recovery: failed: {type(exc).__name__}: {str(exc)[:200]}", file=sys.stderr)
        return 3
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main(sys.argv[1:]))
