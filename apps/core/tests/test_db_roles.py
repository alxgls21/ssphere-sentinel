"""The PostgreSQL role provisioning program (sentinel/db_roles.py), read as text.

These tests check what the generator writes: the statements, their order, the
quoting, the values it accepts. Whether PostgreSQL 16 and 18 then do what the
program asks is not something they can show; a real server has to.
"""

import base64
import difflib
import hashlib
import hmac
import io
import json
import os
import re
import secrets
import subprocess
import sys
from pathlib import Path

from django.test import SimpleTestCase

from sentinel import db_roles
from sentinel.db_roles import InputError

ROOT = Path(__file__).resolve().parents[3]
RUNTIME = "Zq7-kP2_xW9.mN4+vB8/tR6=yL3sD1hJ5gFcU0aE"
MIGRATION = "Mm4-Tq8_Rw2.Xz6+Lp9/Nc3=Vb7Hk5jG1dSyQ0oI"
SALTS = (bytes(range(16)), bytes(range(16, 32)))
NONCE = "0123456789abcdef0123456789abcdef"
MANAGED = {'"sentinel_owner"', '"sentinel_migrate"', '"sentinel_app"'}
SHOWN = "'[[:cntrl:]]', '?', 'g')"


def program(*tables, database="sentinel", **kwargs):
    kwargs.setdefault("salts", SALTS)
    kwargs.setdefault("nonce", NONCE)
    return db_roles.apply_program(database, RUNTIME, MIGRATION, tables, **kwargs)


def programs():
    """Every shape of program: apply with and without tables to adopt, and status."""
    return (program("auth_user").sql, program().sql, db_roles.status_program("sentinel").sql)


# --- A small psql lexer: enough to tell code from quoted text ----------------


def lex(text, top_level=True):
    """Pieces of ``text`` as (kind, value): meta, comment, literal, ident, dollar, code."""
    pieces, i, line_start = [], 0, True
    while i < len(text):
        char = text[i]
        if top_level and line_start and char == "\\":
            end = text.find("\n", i)
            end = len(text) if end < 0 else end
            pieces.append(("meta", text[i:end]))
            i = end
            continue
        line_start = char == "\n"
        if text.startswith("--", i):
            end = text.find("\n", i)
            end = len(text) if end < 0 else end
            pieces.append(("comment", text[i:end]))
            i = end
        elif text.startswith("/*", i):  # PostgreSQL nests block comments
            depth, j = 1, i + 2
            while depth:
                if j >= len(text):
                    raise ValueError("unterminated block comment")
                if text.startswith("/*", j):
                    depth, j = depth + 1, j + 2
                elif text.startswith("*/", j):
                    depth, j = depth - 1, j + 2
                else:
                    j += 1
            pieces.append(("comment", text[i:j]))
            i = j
        elif char in "'\"":
            j = i + 1
            while True:
                j = text.index(char, j)
                if text.startswith(char * 2, j):
                    j += 2
                    continue
                break
            pieces.append(("literal" if char == "'" else "ident", text[i : j + 1]))
            i = j + 1
        elif char == "$" and (match := re.match(r"\$([A-Za-z_][A-Za-z0-9_]*)?\$", text[i:])):
            tag = match.group(0)
            end = text.index(tag, i + len(tag))
            pieces.append(("dollar", text[i : end + len(tag)]))
            i = end + len(tag)
        else:
            pieces.append(("code", char))
            i += 1
    merged = []
    for kind, value in pieces:
        if merged and kind == "code" and merged[-1][0] == "code":
            merged[-1] = ("code", merged[-1][1] + value)
        else:
            merged.append((kind, value))
    return merged


def body(dollar):
    tag = re.match(r"\$[A-Za-z_]*\$", dollar).group(0)
    return dollar[len(tag) : -len(tag)]


def every_piece(text):
    """The pieces of the program and of every DO body in it."""
    pieces = lex(text)
    for kind, value in list(pieces):
        if kind == "dollar":
            pieces += lex(body(value), top_level=False)
    return pieces


def statements(text):
    """Top-level SQL statements, in order (meta-commands and comments left out)."""
    result, current = [], ""
    for kind, value in lex(text):
        if kind in ("meta", "comment"):
            continue
        if kind == "code":
            for part in re.split(r"(;)", value):
                if part == ";":
                    result.append(current.strip())
                    current = ""
                else:
                    current += part
        else:
            current += value
    assert not current.strip(), current
    return result


def code_everywhere(text):
    """Code outside quotes, at top level and inside every DO body, literals blanked."""
    parts = []
    for kind, value in lex(text):
        if kind == "code":
            parts.append(value)
        elif kind == "dollar":
            parts.append(code_everywhere_body(body(value)))
        elif kind in ("literal", "ident"):
            parts.append("''" if kind == "literal" else value)
    return "".join(parts)


def code_everywhere_body(text):
    return "".join(
        value if kind in ("code", "ident") else "''"
        for kind, value in lex(text, top_level=False)
        if kind != "comment"
    )


def dynamic_sql(text):
    """The statements DO bodies build in string literals and EXECUTE."""
    found = []
    for kind, value in lex(text):
        if kind == "dollar":
            for inner_kind, inner in lex(body(value), top_level=False):
                literal = inner[1:-1].replace("''", "'")
                if inner_kind == "literal" and re.match(
                    r"(?i)(GRANT|REVOKE|ALTER|CREATE|DROP|REASSIGN|SET|RESET|TRUNCATE|INSERT|UPDATE|DELETE|COPY|COMMIT)\s",
                    literal,
                ):
                    found.append(literal)
    return found


def all_statements(text):
    """Top-level statements, the statements in DO bodies (nested ones too), and the dynamic ones."""
    inside = []
    for kind, value in lex(text):
        if kind == "dollar":
            parts = re.split(r";|\b(?:DECLARE|BEGIN|THEN|ELSE|LOOP)\b", code_everywhere_body(body(value)))
            inside += [" ".join(part.split()) for part in parts if part.strip()]
    return [s for s in statements(text) if not s.startswith("DO $")] + inside + dynamic_sql(text)


def do_blocks(text):
    return [(re.match(r"\$([A-Za-z_]*)\$", value).group(1), body(value)) for kind, value in lex(text) if kind == "dollar"]


def squash(text):
    return " ".join(text.split())


def uncommented(text):
    """A DO body without its comments: what PL/pgSQL runs."""
    return "".join(value for kind, value in lex(text, top_level=False) if kind != "comment")


def placeholders(message):
    """The % a RAISE fills in (%% is a literal percent sign)."""
    return [match for match in re.findall(r"%%|%", message) if match == "%"]


def split_arguments(text):
    """``a, f(b, 'c, d'), e`` as its top-level parts."""
    parts, depth, quoted, current = [], 0, False, ""
    for char in text:
        if char == "'":
            quoted = not quoted
        elif not quoted and char == "(":
            depth += 1
        elif not quoted and char == ")":
            depth -= 1
        if char == "," and not depth and not quoted:
            parts.append(current.strip())
            current = ""
        else:
            current += char
    return parts + [current.strip()] if current.strip() else parts


def raises(text):
    """Each RAISE of ``text`` as (format, arguments)."""
    found = []
    for match in re.finditer(r"RAISE EXCEPTION '((?:[^']|'')*)'(.*?);", squash(uncommented(text))):
        arguments = match.group(2).strip()
        found.append((match.group(1), split_arguments(arguments.removeprefix(",")) if arguments else []))
    return found


def grantees(statement, keyword):
    tail = re.split(rf"(?i)\b{keyword}\b", statement)[-1]
    tail = re.split(r"(?i)\bWITH\b|\bGRANTED\s+BY\b", tail)[0]
    return [name.strip() for name in tail.split(",")]


class ScramTests(SimpleTestCase):
    def test_the_key_derivation_matches_rfc_7677(self):
        # RFC 7677 section 3: user "user", password "pencil".
        salt = base64.b64decode("W22ZaJ0SNY7soEsUEjb6gQ==")
        stored_key, server_key = db_roles.scram_keys("pencil", salt, 4096)
        auth = (
            "n=user,r=rOprNGfwEbeRWgbNEkqO,"
            "r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096,"
            "c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0"
        ).encode()
        salted = hashlib.pbkdf2_hmac("sha256", b"pencil", salt, 4096)
        client_key = hmac.new(salted, b"Client Key", "sha256").digest()
        self.assertEqual(hashlib.sha256(client_key).digest(), stored_key)
        signature = hmac.new(stored_key, auth, "sha256").digest()
        proof = bytes(a ^ b for a, b in zip(client_key, signature))
        self.assertEqual(base64.b64encode(proof).decode(), "dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=")
        server_signature = hmac.new(server_key, auth, "sha256").digest()
        self.assertEqual(base64.b64encode(server_signature).decode(), "6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=")

    def test_a_verifier_has_postgresqls_form(self):
        verifier = db_roles.scram_verifier("pencil", salt=base64.b64decode("W22ZaJ0SNY7soEsUEjb6gQ=="))
        self.assertEqual(
            verifier,
            "SCRAM-SHA-256$4096:W22ZaJ0SNY7soEsUEjb6gQ==$WG5d8oPm3OtcPnkdi4Uo7BkeZkBFzpcXkuLmtbsT4qY=:"
            "wfPLwcE6nTWhTAmQ7tl2KeoiWGPlZqQxSrmfPwDl2dU=",
        )
        iterations, salt, stored_key, server_key = db_roles.parse_scram_verifier(verifier)
        self.assertEqual((iterations, len(salt), len(stored_key), len(server_key)), (4096, 16, 32, 32))

    def test_every_verifier_gets_a_new_salt(self):
        first, second = db_roles.scram_verifier(RUNTIME), db_roles.scram_verifier(RUNTIME)
        self.assertNotEqual(first, second)
        self.assertEqual(len(db_roles.parse_scram_verifier(first)[1]), db_roles.SCRAM_SALT_BYTES)

    def test_malformed_or_unusual_verifiers_are_refused(self):
        good = db_roles.scram_verifier(RUNTIME, salt=SALTS[0])
        head = "SCRAM-SHA-256$4096:"
        salt, keys = good.removeprefix(head).split("$")
        stored, server = keys.split(":")
        self.assertEqual(db_roles.parse_scram_verifier(f"{head}{salt}${stored}:{server}")[0], 4096)
        broken = [
            good + "\n",
            " " + good,
            good.replace("SCRAM-SHA-256", "scram-sha-256"),
            good.replace("$4096:", "$0:"),
            good.replace("$4096:", "$-1:"),
            good.replace("$4096:", "$x:"),
            good.replace("$4096:", "$4294967296:"),  # fits the pattern, not an int4
            good.replace("$4096:", "$99999999999:"),
            f"{head}{salt}${stored.rstrip('=')}:{server}",  # padding missing
            f"{head}{salt}$-{stored[1:]}:{server}",  # URL-safe alphabet
            f"{head}{salt}${stored}:_{server[1:]}",
            f"{head}{salt}${stored[:-2]}B=:{server}",  # trailing bits set: not canonical
            f"{head}{salt}${stored[:-4]}=:{server}",
            f"{head}{salt}${stored}:{server}A",
            f"{head}${stored}:{server}",  # no salt
            f"{head}{salt}${stored}",
            f"{head}{salt}${stored}:{server}:{server}",
            "md5" + "0" * 32,
            "",
            None,
        ]
        for value in broken:
            with self.subTest(value=value), self.assertRaises(InputError):
                db_roles.parse_scram_verifier(value)

    def test_only_passwords_that_saslprep_leaves_alone_are_hashed(self):
        for value in ("", "with space", "tab\there", "κωδικός", "ascii\x7f", "nul\x00"):
            with self.subTest(value=value), self.assertRaises(InputError):
                db_roles.scram_verifier(value)


class PasswordTests(SimpleTestCase):
    def check(self, value):
        return db_roles.validate_password("SENTINEL_DB_PASSWORD", value)

    def test_generated_passwords_are_accepted(self):
        for _ in range(50):
            token = secrets.token_urlsafe(48)
            self.assertEqual(self.check(token), token)
        encoded = base64.b64encode(bytes(range(40))).decode()
        self.assertEqual(self.check(encoded), encoded)

    def test_every_placeholder_is_refused(self):
        self.assertEqual(self.check("Xk7Qm4Rt9Wz2Lp8Nc3Vb6Hj5Gd1Sy0Tu4"), "Xk7Qm4Rt9Wz2Lp8Nc3Vb6Hj5Gd1Sy0Tu4")
        for placeholder in ("change-me", "change_me", "changeme", "replace-me", "replace-with", "placeholder", "example", "password"):
            for value in (f"Xk7Qm4Rt9Wz2Lp8Nc3{placeholder}Vb6Hj5Gd1Sy0Tu4", f"Xk7Qm4Rt9Wz2Lp8Nc3{placeholder.upper()}Vb6Hj5Gd1Sy0Tu4"):
                with self.subTest(value=value), self.assertRaisesMessage(InputError, "placeholder"):
                    self.check(value)

    def test_hashes_and_weak_values_are_refused(self):
        cases = {
            None: "is not set",
            "": "is empty",
            "Aa1-" * 5: "characters long",
            "a" * 40: "too few different characters",
            "abababababcdcdcdcdcd0101010101-_-_-_-_-_": "too few different characters",
            "md5" + "0123456789abcdef" * 2: "MD5 hash",
            db_roles.scram_verifier(RUNTIME, salt=SALTS[0]): "SCRAM verifier",
            "x" * 1025: "characters long",
        }
        for value, message in cases.items():
            with self.subTest(value=value), self.assertRaisesMessage(InputError, message):
                self.check(value)

    def test_characters_a_shell_an_env_file_or_saslprep_would_change_are_refused(self):
        base = "Zq7kP2xW9mN4vB8tR6yL3sD1hJ5gFcU0aEq"
        characters = (" ", "\t", "\n", "$", "`", "\\", "'", '"', "#", "!", ";", "&", "|", "*", "?", "%", "~", "é", "Ω", "\x00")
        for character in characters:
            with self.subTest(character=character), self.assertRaisesMessage(InputError, "may only contain"):
                self.check(base + character + base)
        # A shell sourcing a .env file expands a leading "~"; Compose does not.
        with self.assertRaisesMessage(InputError, "may only contain"):
            self.check("~/" + base)

    def test_messages_never_contain_the_value(self):
        for value in ("change-me-SECRETMARKER-0123456789abcdefgh", "SECRETMARKER" * 3 + "$", "SECRETMARKER"):
            with self.subTest(value=value):
                with self.assertRaises(InputError) as caught:
                    self.check(value)
                self.assertNotIn("SECRETMARKER", str(caught.exception))

    def test_the_two_logins_need_different_passwords(self):
        with self.assertRaisesMessage(InputError, "must differ"):
            db_roles.apply_program("sentinel", RUNTIME, RUNTIME)


class NameTests(SimpleTestCase):
    def test_database_names(self):
        for name in ("sentinel", "Sentinel_2", "sentinel-prod", "_x", "a" * 63):
            self.assertEqual(db_roles.validate_database(name), name)
        for name in (None, "", "a" * 64, "1sentinel", "sentinel db", 'sentinel"', "sentinel'", "sentinel;", "a$b",
                     "a%b", 'x"; DROP DATABASE sentinel; --', "postgres", "TEMPLATE1", "template0", "sentinel\n"):
            with self.subTest(name=name), self.assertRaises(InputError):
                db_roles.validate_database(name)

    def test_table_names(self):
        self.assertEqual(db_roles.validate_tables(["b", "a", "b"]), ("a", "b"))
        for name in ("Auth_user", "auth user", "x'); DROP TABLE y; --", 'a"b', "a.b", "", "a" * 64, "1abc", 7, None):
            with self.subTest(name=name), self.assertRaises(InputError):
                db_roles.validate_tables(["auth_user", name])
        with self.assertRaises(InputError):
            db_roles.validate_tables("auth_user")  # a string, not a list of names
        with self.assertRaises(InputError):
            db_roles.validate_tables([f"t{i}" for i in range(db_roles.MAX_ADOPT_TABLES + 1)])

    def test_the_nonce(self):
        for value in ("", "x" * 32, "0" * 31, "0" * 33, "0" * 31 + "G", "A" * 32):
            with self.subTest(value=value), self.assertRaises(InputError):
                db_roles.apply_program("sentinel", RUNTIME, MIGRATION, nonce=value)
            with self.subTest(value=value), self.assertRaises(InputError):
                db_roles.status_program("sentinel", nonce=value)


TRANSACTION_CONTROL = re.compile(
    r"(?i)^(BEGIN|START\s+TRANSACTION|COMMIT|END|ROLLBACK|ABORT|SAVEPOINT|RELEASE|PREPARE\s+TRANSACTION)\b"
)


class TransactionTests(SimpleTestCase):
    def test_the_program_is_one_transaction_that_ends_with_its_check(self):
        sql = program("auth_user").sql
        steps = statements(sql)
        self.assertEqual([step for step in steps if TRANSACTION_CONTROL.match(step)], ["BEGIN", "COMMIT"])
        self.assertEqual(steps[-1], "COMMIT")
        self.assertTrue(steps[-2].startswith("DO $sentinel_verify$"))
        begin = steps.index("BEGIN")
        # Taking a table from a running application waits for its locks: not forever.
        self.assertEqual(steps[begin + 1], "SET LOCAL lock_timeout = '10s'")
        # Before BEGIN: the search_path, the checks that hold no secret, and what keeps
        # the statements out of logs, the activity view and statistics.
        self.assertEqual(steps[0], "SET search_path = pg_catalog, pg_temp")
        self.assertTrue(steps[1].startswith("DO $sentinel_session$"))
        self.assertEqual(
            steps[2:begin],
            [
                "SET log_statement = 'none'",
                "SET log_min_error_statement = 'panic'",
                "SET log_min_duration_statement = -1",
                "SET log_min_duration_sample = -1",
                "SET log_transaction_sample_rate = 0",
                "SET track_activities = off",
                "SET pg_stat_statements.track = 'none'",
            ],
        )

    def test_no_do_block_ends_the_transaction(self):
        for sql in programs():
            for tag, text in do_blocks(sql):
                self.assertNotRegex(code_everywhere_body(text), r"(?i)\b(COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b", tag)

    def test_psql_stops_at_the_first_error_and_reports_completion_after_commit(self):
        sql = program().sql
        metas = [value for kind, value in lex(sql) if kind == "meta"]
        self.assertEqual(metas, ["\\set ON_ERROR_STOP on", "\\set VERBOSITY terse", f"\\echo sentinel-roles: committed {NONCE}"])
        self.assertTrue(sql.rstrip().endswith(f"COMMIT;\n\\echo sentinel-roles: committed {NONCE}"))
        self.assertLess(sql.index("\\set ON_ERROR_STOP on"), sql.index("SET search_path"))

    def test_runs_are_serialized_and_checked_before_anything_changes(self):
        steps = statements(program("auth_user").sql)
        order = [step.split("$")[1] if step.startswith("DO $") else step.split()[0] for step in steps]
        first_change = next(i for i, step in enumerate(steps) if re.match(r"(ALTER|GRANT|CREATE|REVOKE)\b", step)
                            or step.startswith("DO $sentinel_create$"))
        self.assertLess(order.index("sentinel_session"), order.index("BEGIN"))
        self.assertLess(order.index("BEGIN"), order.index("sentinel_lock"))
        self.assertLess(order.index("sentinel_lock"), order.index("sentinel_preflight"))
        self.assertLess(order.index("sentinel_preflight"), first_change)
        self.assertLess(order.index("sentinel_adopt"), order.index("sentinel_ownership"))
        self.assertLess(order.index("sentinel_ownership"), order.index("sentinel_grants"))
        lock = squash(uncommented(dict(do_blocks(program().sql))["sentinel_lock"]))
        self.assertIn(f"locked := pg_catalog.pg_try_advisory_xact_lock({db_roles.ADVISORY_LOCK_KEY});", lock)
        # The lock first, then who else holds it: neither alone can be skipped.
        self.assertLess(lock.index("pg_try_advisory_xact_lock"), lock.index("FROM pg_catalog.pg_locks"))
        self.assertIn("IF NOT locked OR holders IS NOT NULL THEN RAISE EXCEPTION", lock)
        self.assertNotIn("pg_advisory_lock(", program().sql)  # a session lock would outlive the transaction

    def test_the_lock_names_who_holds_it(self):
        # Any role may take an advisory lock; pg_locks shows a bigint key as two halves.
        self.assertEqual(db_roles.ADVISORY_LOCK_KEY, int.from_bytes(b"SENTINEL", "big"))
        high, low = int.from_bytes(b"SENT", "big"), int.from_bytes(b"INEL", "big")
        lock = squash(uncommented(dict(do_blocks(program().sql))["sentinel_lock"]))
        # Every database of the cluster (Sentinel's superuser logins hold it shared in their
        # own), every session but this one.
        self.assertIn(
            "FROM pg_catalog.pg_locks l LEFT JOIN pg_catalog.pg_stat_activity a ON a.pid = l.pid"
            " LEFT JOIN pg_catalog.pg_database d ON d.oid = l.database"
            " WHERE l.locktype = 'advisory' AND l.granted"
            f" AND l.classid = {high} AND l.objid = {low} AND l.objsubid = 1"
            " AND l.pid IS DISTINCT FROM pg_catalog.pg_backend_pid();",
            lock,
        )
        self.assertNotIn("current_database", lock)
        self.assertIn("CASE l.mode WHEN 'ShareLock' THEN 'a Sentinel superuser login' ELSE 'another run' END", lock)
        # A prepared transaction holds its locks without a session.
        self.assertIn("CASE WHEN l.pid IS NULL THEN 'a prepared transaction (pg_prepared_xacts)'", lock)
        self.assertIn("COALESCE(holders, 'a session that has just let it go')", lock)

    def test_status_is_read_only(self):
        sql = db_roles.status_program("sentinel", nonce=NONCE).sql
        steps = statements(sql)
        self.assertEqual(steps[0], "SET search_path = pg_catalog, pg_temp")
        self.assertTrue(steps[1].startswith("DO $sentinel_session$"))
        self.assertEqual([step for step in steps if TRANSACTION_CONTROL.match(step)], ["BEGIN READ ONLY", "ROLLBACK"])
        self.assertEqual(steps[2], "BEGIN READ ONLY")
        self.assertEqual(steps[-1], "ROLLBACK")
        self.assertNotRegex(
            code_everywhere(sql),
            r"(?i)\b(ALTER|GRANT|REVOKE|CREATE|DROP|EXECUTE|PERFORM|INSERT|UPDATE|DELETE|TRUNCATE|COMMIT|log_\w+)\b",
        )
        # 'ALTER SYSTEM' is the name of a privilege on parameters, asked of has_parameter_privilege.
        self.assertIn("pg_catalog.unnest(ARRAY['SET', 'ALTER SYSTEM']) asked", sql)
        self.assertEqual([statement for statement in dynamic_sql(sql) if statement != "ALTER SYSTEM"], [])
        self.assertTrue(sql.rstrip().endswith(f"\\echo sentinel-roles: verified {NONCE}"))

    def test_each_do_block_has_its_own_closing_tag(self):
        for sql in programs():
            tags = [tag for tag, _ in do_blocks(sql)]
            self.assertEqual(len(tags), len(set(tags)))
            for tag in tags:
                self.assertEqual(sql.count(f"${tag}$"), 2, tag)


class RoleTests(SimpleTestCase):
    def alter_role(self, sql, role):
        (statement,) = [s for s in statements(sql) if s.startswith(f'ALTER ROLE "{role}" WITH ')]
        return statement

    def test_roles_attributes(self):
        sql = program().sql
        never = "NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT"
        self.assertEqual(
            self.alter_role(sql, "sentinel_owner"),
            f'ALTER ROLE "sentinel_owner" WITH NOLOGIN {never} PASSWORD NULL VALID UNTIL \'infinity\'',
        )
        for role in ("sentinel_migrate", "sentinel_app"):
            statement = self.alter_role(sql, role)
            self.assertTrue(statement.startswith(f'ALTER ROLE "{role}" WITH LOGIN {never} PASSWORD \'SCRAM-SHA-256$'))
            self.assertTrue(statement.endswith(" VALID UNTIL 'infinity'"))

    def test_roles_are_created_without_any_privilege_and_only_when_missing(self):
        sql = program().sql
        create = squash(dict(do_blocks(sql))["sentinel_create"])
        for role in ("sentinel_owner", "sentinel_migrate", "sentinel_app"):
            self.assertIn(
                f"IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = '{role}') THEN "
                f'CREATE ROLE "{role}" NOLOGIN; END IF;',
                create,
            )
        creates = [s for s in all_statements(sql) if re.match(r"(?i)CREATE\b", s)]
        self.assertEqual(
            sorted(creates),
            sorted([f'CREATE ROLE "{role}" NOLOGIN' for role in ("sentinel_owner", "sentinel_migrate", "sentinel_app")]
                   + ['CREATE SCHEMA "sentinel_restricted"']),
        )

    def test_nothing_is_dropped_or_reassigned(self):
        for sql in programs():
            text = code_everywhere(sql) + "\n" + "\n".join(dynamic_sql(sql))
            self.assertNotRegex(text, r"(?i)\b(DROP|REASSIGN|SET\s+ROLE|SET\s+SESSION\s+AUTHORIZATION)\b")

    def test_no_privileged_attribute_is_ever_granted(self):
        sql = program("auth_user").sql
        code = code_everywhere(sql) + "\n" + "\n".join(dynamic_sql(sql))
        for attribute in ("SUPERUSER", "CREATEDB", "CREATEROLE", "REPLICATION", "BYPASSRLS"):
            # Only the NO... forms: a bare attribute, in any case, would grant it.
            self.assertEqual(re.findall(rf"(?i)(?<![A-Za-z_]){attribute}(?![A-Za-z_])", code), [], attribute)
            self.assertEqual(len(re.findall(rf"(?i)\bNO{attribute}\b", code)), 3, attribute)
        self.assertEqual(len(re.findall(r"(?i)\bNOINHERIT\b", code)), 3)
        # Dynamic statements are whole literals (or format strings), so the scan above sees them.
        for tag, text in do_blocks(sql):
            for statement in re.findall(r"(?i)\bEXECUTE\b([^;]*);", squash(uncommented(text))):
                self.assertNotIn("||", statement, tag)
        self.assertEqual(re.findall(r"(?i)(?<![A-Za-z_])INHERIT \w+", code), ["INHERIT FALSE"])

    def test_the_only_membership_lets_the_migration_role_switch_to_the_owner(self):
        for sql in programs()[:2]:
            every = all_statements(sql)
            self.assertFalse([s for s in every if re.match(r"(?i)ALTER\s+(GROUP|USER)\b", s)])
            memberships = [s for s in every if re.match(r"(?i)GRANT\b", s) and not re.search(r"(?i)\bON\b", s)]
            self.assertEqual(memberships, ['GRANT "sentinel_owner" TO "sentinel_migrate" WITH INHERIT FALSE, SET TRUE, ADMIN FALSE'])

    def test_settings_are_reset_and_only_the_search_path_is_set(self):
        sql = program(database="sentinel-prod").sql
        steps = statements(sql)
        for role in ("sentinel_owner", "sentinel_migrate", "sentinel_app"):
            self.assertIn(f'ALTER ROLE "{role}" RESET ALL', steps)
            self.assertIn(f'ALTER ROLE "{role}" IN DATABASE "sentinel-prod" RESET ALL', steps)
        settings = [s for s in all_statements(sql) if re.match(r"(?i)ALTER\s+ROLE\b.*\bSET\b", s)]
        self.assertEqual(
            settings,
            [f'ALTER ROLE "{role}" IN DATABASE "sentinel-prod" SET search_path = public, pg_temp'
             for role in ("sentinel_migrate", "sentinel_app")],
        )
        for setting in settings:
            role = setting.split('"')[1]
            self.assertLess(steps.index(f'ALTER ROLE "{role}" IN DATABASE "sentinel-prod" RESET ALL'), steps.index(setting))


class PrivilegeTests(SimpleTestCase):
    def test_database_and_schema_grants(self):
        steps = statements(program(database="sentinel-prod").sql)
        self.assertIn('GRANT CONNECT ON DATABASE "sentinel-prod" TO "sentinel_migrate", "sentinel_app"', steps)
        self.assertIn('GRANT USAGE, CREATE ON SCHEMA public TO "sentinel_owner"', steps)
        self.assertIn('GRANT USAGE ON SCHEMA public TO "sentinel_app"', steps)
        self.assertFalse([s for s in steps if re.match(r"(?i)GRANT .*CREATE.* TO .*\"sentinel_(app|migrate)\"", s)])

    def test_grants_go_only_to_the_managed_roles_and_never_all_privileges(self):
        grants = 0
        for statement in all_statements(program("auth_user").sql):
            if re.match(r"(?i)(GRANT|ALTER DEFAULT PRIVILEGES .* GRANT)\b", statement):
                grants += 1
                self.assertLessEqual(set(grantees(statement, "TO")), MANAGED, statement)
            self.assertNotRegex(statement, r"(?i)\bGRANT\s+ALL\b|\bALL\s+PRIVILEGES\b|WITH GRANT OPTION")
            self.assertNotRegex(statement, r"(?i)\bGRANT\b[^;]*\bMAINTAIN\b")
        # Membership, database, two on the schema, the default privileges, and the table loop.
        self.assertEqual(grants, 6)

    def test_privileges_are_revoked_from_the_runtime_role_only(self):
        revokes = [s for s in all_statements(program("auth_user").sql) if re.search(r"(?i)\bREVOKE\b", s)]
        # Two on the default privileges, tables, grant options, columns, sequences.
        self.assertEqual(len(revokes), 6)
        for statement in revokes:
            self.assertEqual(grantees(statement, "FROM"), ['"sentinel_app"'], statement)
        self.assertNotRegex(code_everywhere(program("auth_user").sql), r"(?i)\bFROM\s+PUBLIC\b")

    def test_default_privileges_of_the_owner(self):
        steps = statements(program().sql)
        self.assertIn(
            'ALTER DEFAULT PRIVILEGES FOR ROLE "sentinel_owner" IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "sentinel_app"',
            steps,
        )
        defaults = [s for s in steps if s.startswith("ALTER DEFAULT PRIVILEGES")]
        self.assertEqual(len(defaults), 2)
        self.assertTrue(defaults[0].endswith('REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLES FROM "sentinel_app"'))
        self.assertNotIn("ON SEQUENCES", program().sql)
        self.assertNotIn("ON FUNCTIONS", program().sql)

    def test_existing_tables_get_exactly_the_runtime_privileges(self):
        grants = squash(dict(do_blocks(program().sql))["sentinel_grants"])
        self.assertIn("wanted := ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'];", grants)
        self.assertIn("extra text[] := ARRAY['TRUNCATE', 'REFERENCES', 'TRIGGER'];", grants)
        self.assertIn("c.relkind IN ('r', 'p')", grants)
        # Missing privileges are granted, and only directly held ones are revoked: a rerun changes nothing.
        self.assertIn(
            "IF NOT EXISTS (SELECT FROM pg_catalog.aclexplode(relation.acl) a WHERE a.grantee = app_oid "
            "AND a.privilege_type = privilege) THEN EXECUTE pg_catalog.format('GRANT %s ON TABLE %s TO \"sentinel_app\"'",
            grants,
        )
        self.assertIn(
            "IF EXISTS (SELECT FROM pg_catalog.aclexplode(relation.acl) a WHERE a.grantee = app_oid "
            "AND a.privilege_type = privilege AND (a.is_grantable OR privilege = ANY (unwanted))) THEN",
            grants,
        )
        self.assertIn("REVOKE GRANT OPTION FOR %s ON TABLE %s FROM \"sentinel_app\"", grants)
        self.assertIn("c.relkind = 'S'", grants)
        self.assertIn("FOREACH privilege IN ARRAY ARRAY['USAGE', 'SELECT', 'UPDATE'] LOOP", grants)  # sequences: none
        self.assertIn("'REVOKE %s ON SEQUENCE %s FROM \"sentinel_app\"'", grants)
        self.assertNotRegex(grants, r"GRANT %s ON SEQUENCE")

    def test_column_privileges_of_the_runtime_role_are_removed(self):
        # INSERT on the columns of django_migrations would be INSERT into it, and no table ACL shows it.
        grants = squash(dict(do_blocks(program().sql))["sentinel_grants"])
        self.assertIn(
            "SELECT DISTINCT a.attrelid::pg_catalog.regclass AS oid, a.attname AS name"
            " FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid,"
            " pg_catalog.aclexplode(a.attacl) x"
            f" WHERE c.relnamespace = {PUBLIC_OID} AND NOT a.attisdropped AND x.grantee = app_oid ORDER BY 1, 2"
            " LOOP EXECUTE pg_catalog.format('REVOKE ALL (%I) ON TABLE %s FROM \"sentinel_app\"', relation.name, relation.oid);"
            " END LOOP;",
            grants,
        )

    def test_the_runtime_role_may_only_read_django_migrations(self):
        sql = program().sql
        grants = squash(dict(do_blocks(sql))["sentinel_grants"])
        self.assertIn(
            "IF relation.name = 'django_migrations' THEN"
            " -- The runtime reads which migrations ran; writing would let it choose the DDL the owner runs."
            " wanted := ARRAY['SELECT']; unwanted := extra || ARRAY['INSERT', 'UPDATE', 'DELETE']; ELSE",
            grants,
        )
        verify = squash(dict(do_blocks(sql))["sentinel_verify"])
        self.assertIn("CASE WHEN relation.name = 'django_migrations' THEN ARRAY['SELECT'] ELSE ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] END", verify)
        self.assertIn(
            "CASE WHEN relation.name = 'django_migrations' THEN ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']",
            verify,
        )
        # A django_migrations the runtime role may write, by whatever grant: status reports that.
        status = squash(dict(do_blocks(db_roles.status_program("sentinel").sql))["sentinel_verify"])
        self.assertIn("THEN ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']", status)

    def test_ownership_is_taken_explicitly_never_assumed_from_grants(self):
        sql = program().sql
        self.assertNotIn("OWNER TO", code_everywhere(sql) + "".join(dynamic_sql(sql)))
        ownership = squash(uncommented(dict(do_blocks(sql))["sentinel_ownership"]))
        self.assertIn(
            f"IF EXISTS (SELECT FROM pg_catalog.pg_class c WHERE c.relnamespace = {PUBLIC_OID} AND c.relowner <> owner_oid) {RAISE}",
            ownership,
        )
        self.assertIn(
            f"FROM pg_catalog.pg_type ty WHERE ty.typnamespace = {PUBLIC_OID} AND ty.typowner <> owner_oid;"
            f" IF found IS NOT NULL {RAISE}",
            ownership,
        )
        # The refusal names tables, which an operator can list to adopt.
        self.assertIn(
            "pg_catalog.format('%s (%s)', c.relname, c.relowner::pg_catalog.regrole)", ownership,
        )
        # Indexes, and sequences of identity or serial columns, follow their tables; partitions do not.
        self.assertIn(
            "AND c.relkind NOT IN ('i', 'I') AND NOT (c.relkind = 'S' AND EXISTS (SELECT FROM pg_catalog.pg_depend d",
            ownership,
        )

    def test_adoption_takes_only_the_listed_tables_of_the_bootstrap_superuser(self):
        sql = program("django_migrations", "auth_user", "auth_user").sql
        adopt = squash(dict(do_blocks(sql))["sentinel_adopt"])
        self.assertIn("c.relkind IN ('r', 'p') AND c.relowner = 10", adopt)
        self.assertIn("c.relname = ANY (ARRAY['auth_user', 'django_migrations']::pg_catalog.name[])", adopt)
        self.assertEqual(dynamic_sql(sql).count('ALTER TABLE %s OWNER TO "sentinel_owner"'), 1)
        # A table in use: the error says which, and what to stop.
        self.assertIn(
            "EXCEPTION WHEN lock_not_available THEN RAISE EXCEPTION 'sentinel-roles: table % is in use; stop web",
            adopt,
        )
        preflight = dict(do_blocks(sql))["sentinel_preflight"]
        self.assertNotIn("belong to the bootstrap superuser", preflight)
        without = dict(do_blocks(program().sql))
        self.assertNotIn("sentinel_adopt", without)
        self.assertIn("belong to the bootstrap superuser", without["sentinel_preflight"])

    def test_an_existing_installation_is_told_what_to_adopt(self):
        preflight = squash(dict(do_blocks(program().sql))["sentinel_preflight"])
        self.assertIn(
            "SELECT pg_catalog.string_agg('--adopt-table ' || c.relname, ' ' ORDER BY c.relname) INTO found"
            f" FROM pg_catalog.pg_class c WHERE c.relnamespace = {PUBLIC_OID} AND c.relowner = 10 AND c.relkind IN ('r', 'p');",
            preflight,
        )


class RestrictedSchemaTests(SimpleTestCase):
    """apply records the separate logins in the database (sentinel/database.py reads it)."""

    def test_it_is_created_in_the_same_transaction_as_everything_else(self):
        steps = statements(program("auth_user").sql)
        marker = [index for index, step in enumerate(steps) if step.startswith("DO $sentinel_marker$")]
        self.assertEqual(len(marker), 1)
        self.assertLess(steps.index("BEGIN"), marker[0])
        self.assertTrue(steps[marker[0] - 1].startswith("DO $sentinel_grants$"))
        self.assertTrue(steps[marker[0] + 1].startswith("DO $sentinel_verify$"))
        self.assertEqual(steps[marker[0] + 2], "COMMIT")
        self.assertEqual(db_roles.RESTRICTED_SCHEMA, "sentinel_restricted")

    def test_it_records_the_activation_once(self):
        # Created, with the record of this database and these roles, only at the first activation
        # (state A); a later apply (state B) finds them as they were and leaves them.
        marker = squash(uncommented(dict(do_blocks(program().sql))["sentinel_marker"]))
        self.assertIn(
            "IF pg_catalog.current_setting('sentinel.state') = 'A' THEN CREATE SCHEMA \"sentinel_restricted\";"
            " EXECUTE pg_catalog.format('COMMENT ON SCHEMA \"sentinel_restricted\" IS %L', pg_catalog.format("
            "'sentinel-roles activation 1: database=%s owner=%s migrate=%s app=%s', db_oid, owner_oid, migrate_oid,"
            " app_oid)); ELSIF pg_catalog.current_setting('sentinel.state') <> 'B' THEN RAISE EXCEPTION",
            marker,
        )
        self.assertEqual(db_roles.ACTIVATION, "sentinel-roles activation 1: database=%s owner=%s migrate=%s app=%s")

    def test_the_session_owns_it_and_nothing_else_is_granted_on_it(self):
        # CREATE SCHEMA without AUTHORIZATION: the bootstrap superuser running apply owns it.
        sql = program().sql
        self.assertNotIn("AUTHORIZATION", code_everywhere(sql))
        for statement in all_statements(sql):
            if re.search(r"(?i)\b(GRANT|ALTER\s+SCHEMA)\b", statement):
                self.assertNotIn("sentinel_restricted", statement)

    def test_status_does_not_create_it(self):
        self.assertNotIn("CREATE SCHEMA", db_roles.status_program("sentinel").sql)


class SafetyTests(SimpleTestCase):
    def test_no_cleartext_password_and_each_verifier_is_sent_once(self):
        sql = program().sql
        self.assertNotIn(RUNTIME, sql)
        self.assertNotIn(MIGRATION, sql)
        runtime = db_roles.scram_verifier(RUNTIME, salt=SALTS[0])
        migration = db_roles.scram_verifier(MIGRATION, salt=SALTS[1])
        self.assertEqual(re.findall(r"SCRAM-SHA-256\$[^']+", sql), [migration, runtime])
        for role, verifier in (("sentinel_migrate", migration), ("sentinel_app", runtime)):
            (statement,) = [s for s in statements(sql) if verifier in s]
            self.assertTrue(statement.startswith(f'ALTER ROLE "{role}" WITH LOGIN'), statement)
        # The final check compares digests, so no query plan or error context holds a verifier.
        verify = dict(do_blocks(sql))["sentinel_verify"]
        for verifier in (runtime, migration):
            self.assertIn(f"'{hashlib.sha256(verifier.encode()).hexdigest()}'", verify)

    def test_the_header_says_what_the_program_holds(self):
        self.assertIn("keep it private, delete it after use", program().sql.split("\\set")[0])
        status = db_roles.status_program("sentinel").sql
        self.assertNotIn("verifiers", status.split("\\set")[0])
        self.assertNotIn("SCRAM-SHA-256$4096", status)

    def test_statements_stay_out_of_logs_and_activity_before_any_verifier_is_sent(self):
        sql = program().sql
        first_verifier = sql.index("SCRAM-SHA-256$")
        for setting in ("log_statement = 'none'", "log_min_error_statement = 'panic'", "log_min_duration_statement = -1",
                        "log_min_duration_sample = -1", "log_transaction_sample_rate = 0", "track_activities = off",
                        "pg_stat_statements.track = 'none'"):
            self.assertLess(sql.index(f"SET {setting};"), first_verifier)

    def test_privileged_sql_uses_only_the_catalog(self):
        for sql in programs():
            self.assertEqual(statements(sql)[0], "SET search_path = pg_catalog, pg_temp")
            code = code_everywhere(sql)
            # Every call is qualified with pg_catalog; what is left before a parenthesis is SQL syntax.
            calls = re.findall(r"(?:(\"[^\"]*\"|[A-Za-z_]\w*)\s*\.\s*)?(\"[^\"]*\"|[A-Za-z_]\w*)\s*\(", code)
            self.assertEqual({schema for schema, _ in calls if schema}, {"pg_catalog"})
            self.assertLessEqual(
                {name for schema, name in calls if not schema},
                {"IN", "EXISTS", "ANY", "COALESCE", "NOT", "AND", "OR", "IF", "WHERE", "FROM"},
            )
            self.assertEqual(re.findall(r"\b(?:FROM|JOIN)\s+(?!pg_catalog\.)(pg_\w+)", code), [])
            self.assertEqual(re.findall(r"::(?!pg_catalog\.)(reg\w+)", code), [])

    def test_no_sql_hides_in_a_nested_dollar_quote(self):
        # The statement tests read string literals; a dollar-quoted string in a DO body they would not.
        for sql in programs():
            for tag, text in do_blocks(sql):
                self.assertEqual([value for kind, value in lex(text, top_level=False) if kind == "dollar"], [], tag)

    def test_psql_finds_no_variable_or_command_in_the_program(self):
        for sql in (*programs(), db_roles.status_program("sentinel-prod").sql):
            pieces = lex(sql)
            code = "".join(value for kind, value in pieces if kind == "code")
            # :name, :{?name}, and :'name' or :"name" (a colon right before a quoted piece).
            self.assertEqual(re.findall(r"(?<!:):(?!:)[A-Za-z_{]", code), [])
            for (kind, value), (next_kind, _) in zip(pieces, pieces[1:]):
                if kind == "code" and next_kind in ("literal", "ident"):
                    self.assertNotRegex(value, r"(?<!:):$")
            self.assertNotIn("\\", code)
            for kind, value in pieces:
                if kind == "literal":
                    self.assertNotIn("\\", value)

    def test_no_block_comment_hides_anything(self):
        for sql in programs():
            for kind, value in every_piece(sql):
                if kind == "comment":
                    self.assertTrue(value.startswith("--"), value)

    def test_inputs_cannot_break_out_of_their_quotes(self):
        self.assertEqual(db_roles._ident('a"b'), '"a""b"')
        self.assertEqual(db_roles._literal("a'b"), "'a''b'")
        sql = program(database="sentinel-prod").sql
        self.assertIn('"sentinel-prod"', sql)
        self.assertIn("pg_catalog.current_database() <> 'sentinel-prod'", sql)
        for hostile in ('x"; DROP DATABASE sentinel; --', "x'; DROP ROLE sentinel_app; --", "x$sentinel_verify$"):
            with self.subTest(hostile=hostile), self.assertRaises(InputError):
                program(database=hostile)
            with self.subTest(hostile=hostile), self.assertRaises(InputError):
                program(hostile)

    def test_quoting_keeps_a_name_whole_even_past_validation(self):
        # Quotes and % stay inside one literal or identifier. A dollar-quote tag inside a
        # DO body is kept out by validation alone, which refuses "$".
        hostile = "a'b\"c%d"
        verifier = db_roles.scram_verifier(RUNTIME, salt=SALTS[0])
        for sql in (db_roles._session_checks(hostile), db_roles._roles(hostile, verifier, verifier), db_roles._verify(hostile, None)):
            pieces = every_piece(sql)
            self.assertFalse([value for kind, value in pieces if kind == "code" and ("c%d" in value or "b\"c" in value)])
            quoted = [value for kind, value in pieces if kind in ("literal", "ident")]
            self.assertTrue([value for value in quoted if value in ("'a''b\"c%d'", '"a\'b""c%d"')])
            for text in [body(value) for kind, value in lex(sql) if kind == "dollar"]:
                for message, arguments in raises(text):
                    self.assertEqual(len(placeholders(message)), len(arguments), message)

    def test_names_in_messages_lose_their_control_characters(self):
        allowed = re.compile(r"privilege|pg_catalog\.current_setting\('server_version'\)|pg_catalog\.current_database\(\)|'[^']*'")
        for sql in programs():
            for tag, text in do_blocks(sql):
                self.assertEqual(len(raises(text)), len(re.findall(r"(?i)\bRAISE\b", code_everywhere_body(text))), tag)
                for message, arguments in raises(text):
                    self.assertEqual(len(placeholders(message)), len(arguments), message)
                    for argument in arguments:
                        if not allowed.fullmatch(argument):
                            self.assertTrue(
                                argument.startswith("pg_catalog.regexp_replace(") and argument.endswith(SHOWN),
                                f"{tag}: {argument}",
                            )


PUBLIC_OID = "'public'::pg_catalog.regnamespace"
RAISE = "THEN RAISE EXCEPTION"
OIDS = "owner_oid, migrate_oid, app_oid"

SESSION_GUARDS = (
    f"IF pg_catalog.current_setting('server_version_num')::integer NOT BETWEEN 160000 AND 189999 {RAISE}",
    f"IF pg_catalog.current_setting('is_superuser') <> 'on' {RAISE}",
    f"IF pg_catalog.current_database() <> 'sentinel' {RAISE}",
    f"IF session_user IN ('sentinel_owner', 'sentinel_migrate', 'sentinel_app') {RAISE}",
)

TRIPWIRE_GUARDS = (
    "SELECT 'function ' || p.oid::pg_catalog.regprocedure::text AS item"
    f" FROM pg_catalog.pg_proc p WHERE p.pronamespace = {PUBLIC_OID} OR p.proowner IN ({OIDS})",
    "UNION ALL SELECT 'operator ' || o.oid::pg_catalog.regoperator::text"
    f" FROM pg_catalog.pg_operator o WHERE o.oprnamespace = {PUBLIC_OID} OR o.oprowner IN ({OIDS})",
    "UNION ALL SELECT 'cast ' || pg_catalog.format('(%s AS %s)', k.castsource::pg_catalog.regtype, k.casttarget::pg_catalog.regtype)"
    " FROM pg_catalog.pg_cast k"
    " JOIN pg_catalog.pg_type s ON s.oid = k.castsource JOIN pg_catalog.pg_type t ON t.oid = k.casttarget"
    f" WHERE s.typnamespace = {PUBLIC_OID} OR t.typnamespace = {PUBLIC_OID}",
    "UNION ALL SELECT 'type ' || ty.oid::pg_catalog.regtype::text FROM pg_catalog.pg_type ty"
    f" WHERE (ty.typnamespace = {PUBLIC_OID} OR ty.typowner IN ({OIDS}))"
    " AND (ty.typtype IN ('d', 'e', 'r', 'm', 'p') OR (ty.typtype = 'b' AND ty.typelem = 0))",
    "UNION ALL SELECT 'trigger ' || t.tgname || ' on ' || t.tgrelid::pg_catalog.regclass::text"
    " FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid"
    f" WHERE c.relnamespace = {PUBLIC_OID} AND NOT t.tgisinternal",
    "UNION ALL SELECT 'rule ' || r.rulename || ' on ' || r.ev_class::pg_catalog.regclass::text"
    " FROM pg_catalog.pg_rewrite r JOIN pg_catalog.pg_class c ON c.oid = r.ev_class"
    f" WHERE c.relnamespace = {PUBLIC_OID} AND r.rulename <> '_RETURN'",
    "UNION ALL SELECT 'policy ' || pol.polname || ' on ' || pol.polrelid::pg_catalog.regclass::text"
    " FROM pg_catalog.pg_policy pol JOIN pg_catalog.pg_class c ON c.oid = pol.polrelid"
    f" WHERE c.relnamespace = {PUBLIC_OID}",
    "UNION ALL SELECT CASE c.relkind WHEN 'v' THEN 'view ' WHEN 'm' THEN 'materialized view ' ELSE 'foreign table ' END"
    f" || c.oid::pg_catalog.regclass::text FROM pg_catalog.pg_class c WHERE c.relnamespace = {PUBLIC_OID}"
    " AND c.relkind IN ('v', 'm', 'f')",
    "UNION ALL SELECT 'extension ' || x.extname"
    f" FROM pg_catalog.pg_extension x WHERE x.extnamespace = {PUBLIC_OID}",
    "UNION ALL SELECT 'event trigger ' || e.evtname FROM pg_catalog.pg_event_trigger e"
    f" ) objects; IF found IS NOT NULL {RAISE}",
)

OTHER_DATABASES_GUARD = (
    "FROM pg_catalog.pg_database d WHERE d.datname <> pg_catalog.current_database()"
    " AND (EXISTS (SELECT FROM pg_catalog.pg_shdepend s WHERE s.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass"
    f" AND s.refobjid IN ({OIDS}) AND (s.dbid = d.oid"
    " OR (s.dbid = 0 AND s.classid = 'pg_catalog.pg_database'::pg_catalog.regclass AND s.objid = d.oid)))"
    f" OR EXISTS (SELECT FROM pg_catalog.pg_db_role_setting r WHERE r.setdatabase = d.oid AND r.setrole IN ({OIDS})));"
    f" IF found IS NOT NULL {RAISE}"
)

PUBLIC_CREATE_GUARD = (
    "IF EXISTS (SELECT FROM pg_catalog.pg_namespace n, pg_catalog.aclexplode(n.nspacl) a"
    f" WHERE n.oid = {PUBLIC_OID} AND a.grantee = 0 AND a.privilege_type = 'CREATE') {RAISE}"
)

# TEMPORARY on any database the runtime role may connect to: from PUBLIC (by default too: a
# NULL datacl means PostgreSQL's default ACL), from the role itself, or from a role it can
# become; each entry is named with its grantor, who alone can revoke it.
TEMPORARY_GUARDS = (
    "SELECT DISTINCT pg_catalog.format('as %s: REVOKE TEMPORARY ON DATABASE %I FROM %s', a.grantor::pg_catalog.regrole,"
    " d.datname, CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::pg_catalog.regrole::text END) AS remedy"
    " FROM pg_catalog.pg_database d, pg_catalog.aclexplode(COALESCE(d.datacl, pg_catalog.acldefault('d', d.datdba))) a"
    " WHERE d.datallowconn AND a.privilege_type = 'TEMPORARY'"
    " AND (a.grantee = 0 OR pg_catalog.pg_has_role(app_oid, a.grantee, 'MEMBER'))"
    " AND CASE WHEN app_oid IS NULL"
    " THEN EXISTS (SELECT FROM pg_catalog.aclexplode(COALESCE(d.datacl, pg_catalog.acldefault('d', d.datdba))) c"
    " WHERE c.grantee = 0 AND c.privilege_type = 'CONNECT')"
    " ELSE pg_catalog.has_database_privilege(app_oid, d.oid, 'CONNECT') END ) remedies;",
    "IF found IS NOT NULL OR EXISTS (SELECT FROM pg_catalog.pg_database d, pg_catalog.pg_roles r"
    " WHERE d.datallowconn AND pg_catalog.has_database_privilege(app_oid, d.oid, 'CONNECT')"
    " AND pg_catalog.pg_has_role(app_oid, r.oid, 'MEMBER') AND pg_catalog.has_database_privilege(r.oid, d.oid, 'TEMPORARY'))"
    f" {RAISE} 'sentinel-roles: the runtime role could create temporary tables,",
)

PREFLIGHT_GUARDS = (
    "IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE oid = 10"
    f" AND rolname IN ('sentinel_owner', 'sentinel_migrate', 'sentinel_app')) {RAISE}",
    f"FROM pg_catalog.pg_roles WHERE oid IN ({OIDS}) AND rolsuper;"
    f" IF found IS NOT NULL {RAISE}",
    "FROM pg_catalog.pg_auth_members m WHERE m.member IN (app_oid, owner_oid) OR m.roleid IN (app_oid, migrate_oid)"
    " OR (m.member = migrate_oid AND m.roleid IS DISTINCT FROM owner_oid)"
    " OR (m.roleid = owner_oid AND m.member IS DISTINCT FROM migrate_oid);"
    f" IF found IS NOT NULL {RAISE}",
    OTHER_DATABASES_GUARD,
    # A superuser session open before apply commits is never checked by sentinel/database.py.
    "FROM pg_catalog.pg_stat_activity a WHERE a.datname = pg_catalog.current_database() AND a.backend_type = 'client backend'"
    " AND a.pid <> pg_catalog.pg_backend_pid() AND EXISTS (SELECT FROM pg_catalog.pg_roles r"
    f" WHERE r.rolsuper AND pg_catalog.pg_has_role(a.usesysid, r.oid, 'MEMBER')); IF found IS NOT NULL {RAISE}",
    # An unknown or partial history (LIFECYCLE), before anything changes.
    f"IF state = 'C' {RAISE} 'sentinel-roles: the cluster holds a partial or unknown provisioning history (state C): %;",
    "PERFORM pg_catalog.set_config('sentinel.state', state, true);",
    "SELECT d.datdba::pg_catalog.regrole::text INTO found FROM pg_catalog.pg_database d"
    f" WHERE d.datname = pg_catalog.current_database() AND d.datdba IN ({OIDS}); IF found IS NOT NULL {RAISE}",
    PUBLIC_CREATE_GUARD,
    *TEMPORARY_GUARDS,
    f"FROM pg_catalog.pg_class c WHERE c.relnamespace = {PUBLIC_OID}"
    f" AND c.relowner IS DISTINCT FROM owner_oid AND c.relowner <> 10; IF found IS NOT NULL {RAISE}",
)

BOOTSTRAP_RELATIONS_GUARD = (
    f"IF EXISTS (SELECT FROM pg_catalog.pg_class c WHERE c.relnamespace = {PUBLIC_OID} AND c.relowner = 10) {RAISE}"
)

VERIFY_GUARDS = (
    f"IF db_oid IS NULL OR pg_catalog.current_database() <> 'sentinel' {RAISE}",
    f"IF state = 'A' {RAISE} 'sentinel-roles: the roles are not provisioned in this cluster (state A: run apply)';",
    f"IF state = 'C' {RAISE} 'sentinel-roles: the cluster holds a partial or unknown provisioning history (state C): %;",
    f"IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE oid IN ({OIDS})"
    " AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR rolinherit"
    f" OR (rolvaliduntil IS NOT NULL AND rolvaliduntil <> 'infinity'))) {RAISE}",
    "IF (SELECT rolcanlogin FROM pg_catalog.pg_roles WHERE oid = owner_oid)"
    " OR NOT (SELECT rolcanlogin FROM pg_catalog.pg_roles WHERE oid = migrate_oid)"
    f" OR NOT (SELECT rolcanlogin FROM pg_catalog.pg_roles WHERE oid = app_oid) {RAISE}",
    f"IF (SELECT rolpassword FROM pg_catalog.pg_authid WHERE oid = owner_oid) IS NOT NULL {RAISE}",
    "IF EXISTS (SELECT FROM pg_catalog.pg_auth_members m"
    " WHERE m.member IN (app_oid, owner_oid) OR m.roleid IN (app_oid, migrate_oid)"
    " OR (m.member = migrate_oid AND (m.roleid <> owner_oid OR m.admin_option OR m.inherit_option OR NOT m.set_option))"
    " OR (m.roleid = owner_oid AND m.member <> migrate_oid))"
    " OR NOT EXISTS (SELECT FROM pg_catalog.pg_auth_members m WHERE m.member = migrate_oid AND m.roleid = owner_oid)"
    f" {RAISE}",
    "IF NOT pg_catalog.pg_has_role(migrate_oid, owner_oid, 'SET') OR pg_catalog.pg_has_role(migrate_oid, owner_oid, 'USAGE')"
    " OR pg_catalog.pg_has_role(app_oid, owner_oid, 'MEMBER') OR pg_catalog.pg_has_role(app_oid, migrate_oid, 'MEMBER')"
    f" OR pg_catalog.pg_has_role(app_oid, 10, 'MEMBER') OR pg_catalog.pg_has_role(migrate_oid, 10, 'MEMBER') {RAISE}",
    OTHER_DATABASES_GUARD,
    *TEMPORARY_GUARDS,
    "IF NOT pg_catalog.has_database_privilege(app_oid, db_oid, 'CONNECT')"
    " OR NOT pg_catalog.has_database_privilege(migrate_oid, db_oid, 'CONNECT')"
    " OR pg_catalog.has_database_privilege(app_oid, db_oid, 'CREATE')"
    " OR pg_catalog.has_database_privilege(migrate_oid, db_oid, 'CREATE')"
    " OR pg_catalog.has_database_privilege(owner_oid, db_oid, 'CREATE')"
    f" OR (SELECT datdba FROM pg_catalog.pg_database WHERE oid = db_oid) IN ({OIDS}) {RAISE}",
    # The database's and the schema's ACL entries for the roles, exactly, none grantable.
    "IF EXISTS (SELECT FROM pg_catalog.pg_database d, pg_catalog.aclexplode(d.datacl) a"
    f" WHERE d.oid = db_oid AND a.grantee IN ({OIDS})"
    " AND NOT (a.grantee IN (migrate_oid, app_oid) AND a.privilege_type = 'CONNECT' AND NOT a.is_grantable))"
    " OR EXISTS (SELECT FROM pg_catalog.pg_namespace n, pg_catalog.aclexplode(n.nspacl) a"
    f" WHERE n.oid = {PUBLIC_OID} AND a.grantee IN ({OIDS})"
    " AND NOT (NOT a.is_grantable AND ((a.grantee = owner_oid AND a.privilege_type IN ('USAGE', 'CREATE'))"
    f" OR (a.grantee = app_oid AND a.privilege_type = 'USAGE')))) {RAISE}",
    f"IF NOT pg_catalog.has_schema_privilege(owner_oid, {PUBLIC_OID}, 'USAGE')"
    f" OR NOT pg_catalog.has_schema_privilege(owner_oid, {PUBLIC_OID}, 'CREATE')"
    f" OR NOT pg_catalog.has_schema_privilege(app_oid, {PUBLIC_OID}, 'USAGE') {RAISE}",
    # Another session's temporary schema answers CREATE for whoever may create temporary tables.
    "FROM pg_catalog.pg_namespace n WHERE n.nspname !~ '^pg_(toast_)?temp_[0-9]+$'"
    " AND (pg_catalog.has_schema_privilege(app_oid, n.oid, 'CREATE') OR pg_catalog.has_schema_privilege(migrate_oid, n.oid, 'CREATE')"
    f" OR (n.oid <> {PUBLIC_OID} AND pg_catalog.has_schema_privilege(owner_oid, n.oid, 'CREATE')));"
    f" IF found IS NOT NULL {RAISE}",
    "IF EXISTS (SELECT FROM pg_catalog.pg_shdepend d WHERE d.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass"
    f" AND d.refobjid IN (migrate_oid, app_oid) AND d.deptype = 'o') {RAISE}",
    # Privileges and objects of the roles in this database and the shared catalogs, but what apply gives.
    "FROM pg_catalog.pg_shdepend d WHERE d.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass"
    f" AND d.refobjid IN ({OIDS}) AND d.dbid IN (0, db_oid)"
    " AND NOT (d.refobjid = owner_oid AND d.deptype = 'o' AND d.dbid = db_oid AND ("
    " (d.classid = 'pg_catalog.pg_class'::pg_catalog.regclass"
    " AND EXISTS (SELECT FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace"
    f" WHERE c.oid = d.objid AND (n.oid = {PUBLIC_OID} OR n.nspname ~ '^pg_temp_[0-9]+$')))"
    " OR (d.classid = 'pg_catalog.pg_type'::pg_catalog.regclass"
    " AND EXISTS (SELECT FROM pg_catalog.pg_type ty JOIN pg_catalog.pg_namespace n ON n.oid = ty.typnamespace"
    f" WHERE ty.oid = d.objid AND (n.oid = {PUBLIC_OID} OR n.nspname ~ '^pg_temp_[0-9]+$')))"
    " OR (d.classid = 'pg_catalog.pg_default_acl'::pg_catalog.regclass"
    f" AND EXISTS (SELECT FROM pg_catalog.pg_default_acl a WHERE a.oid = d.objid AND a.defaclnamespace = {PUBLIC_OID}))))"
    " AND NOT (d.deptype = 'a' AND ("
    " (d.classid = 'pg_catalog.pg_database'::pg_catalog.regclass AND d.objid = db_oid AND d.refobjid IN (migrate_oid, app_oid))"
    f" OR (d.classid = 'pg_catalog.pg_namespace'::pg_catalog.regclass AND d.objid = {PUBLIC_OID} AND d.refobjid IN (owner_oid, app_oid))"
    " OR (d.refobjid = app_oid AND d.classid = 'pg_catalog.pg_class'::pg_catalog.regclass"
    f" AND EXISTS (SELECT FROM pg_catalog.pg_class c WHERE c.oid = d.objid AND c.relnamespace = {PUBLIC_OID}))"
    " OR (d.refobjid = app_oid AND d.classid = 'pg_catalog.pg_default_acl'::pg_catalog.regclass"
    " AND EXISTS (SELECT FROM pg_catalog.pg_default_acl a"
    f" WHERE a.oid = d.objid AND a.defaclrole = owner_oid AND a.defaclnamespace = {PUBLIC_OID})))) ) granted;"
    f" IF found IS NOT NULL {RAISE}",
    f"IF EXISTS (SELECT FROM pg_catalog.pg_class c WHERE c.relnamespace = {PUBLIC_OID} AND c.relowner <> owner_oid) {RAISE}",
    "IF pg_catalog.has_sequence_privilege(app_oid, relation.oid, 'USAGE')"
    " OR pg_catalog.has_sequence_privilege(app_oid, relation.oid, 'SELECT')"
    f" OR pg_catalog.has_sequence_privilege(app_oid, relation.oid, 'UPDATE') {RAISE}",
    "IF NOT pg_catalog.has_table_privilege(app_oid, relation.oid, privilege)"
    f" OR pg_catalog.has_table_privilege(app_oid, relation.oid, privilege || ' WITH GRANT OPTION') {RAISE}",
    "IF (CASE WHEN privilege IN ('INSERT', 'UPDATE', 'REFERENCES')"
    " THEN pg_catalog.has_any_column_privilege(app_oid, relation.oid, privilege)"
    f" ELSE pg_catalog.has_table_privilege(app_oid, relation.oid, privilege) END) {RAISE}",
    "IF EXISTS (SELECT FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid,"
    f" pg_catalog.aclexplode(a.attacl) x WHERE c.relnamespace = {PUBLIC_OID} AND NOT a.attisdropped AND x.grantee = app_oid)"
    f" {RAISE}",
    "IF EXISTS (SELECT FROM pg_catalog.pg_default_acl d, pg_catalog.aclexplode(d.defaclacl) a"
    " WHERE d.defaclrole = owner_oid AND a.grantee <> owner_oid"
    f" AND NOT (d.defaclnamespace = {PUBLIC_OID} AND d.defaclobjtype = 'r' AND a.grantee = app_oid"
    " AND a.privilege_type IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE') AND NOT a.is_grantable))"
    " OR (SELECT pg_catalog.count(DISTINCT a.privilege_type)"
    " FROM pg_catalog.pg_default_acl d, pg_catalog.aclexplode(d.defaclacl) a"
    f" WHERE d.defaclrole = owner_oid AND d.defaclnamespace = {PUBLIC_OID} AND d.defaclobjtype = 'r'"
    f" AND a.grantee = app_oid) <> 4 {RAISE}",
    f"IF EXISTS (SELECT FROM pg_catalog.pg_db_role_setting s WHERE s.setrole IN ({OIDS})"
    " AND (s.setdatabase = 0 OR s.setdatabase = db_oid)"
    " AND NOT (s.setdatabase = db_oid AND s.setrole IN (migrate_oid, app_oid)"
    " AND s.setconfig = ARRAY['search_path=public, pg_temp']::text[]))"
    " OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_db_role_setting s"
    f" WHERE s.setdatabase = db_oid AND s.setrole IN (migrate_oid, app_oid)) <> 2 {RAISE}",
    PUBLIC_CREATE_GUARD,
)


class TemporaryPrivilegeTests(SimpleTestCase):
    """The runtime role may not create temporary tables. Text only: running the
    program against a server is what test_db_roles_postgres.py does."""

    def test_apply_and_status_check_the_same_before_anything_changes(self):
        apply = dict(do_blocks(program("auth_user").sql))
        status = dict(do_blocks(db_roles.status_program("sentinel").sql))
        for name, block in (("preflight", apply["sentinel_preflight"]), ("apply", apply["sentinel_verify"]),
                            ("status", status["sentinel_verify"])):
            with self.subTest(name):
                code = squash(uncommented(block))
                for guard in TEMPORARY_GUARDS:
                    self.assertIn(guard, code)
        # Preflight runs before the first change; the final check before COMMIT.
        steps = statements(program("auth_user").sql)
        tags = [step.split("$")[1] for step in steps if step.startswith("DO $")]
        self.assertLess(tags.index("sentinel_preflight"), tags.index("sentinel_create"))

    def test_the_default_grant_to_public_is_seen(self):
        # A database's ACL is NULL until someone changes it, and then means PostgreSQL's
        # default, which gives PUBLIC CONNECT and TEMPORARY: aclexplode(NULL) shows nothing.
        blocks = [text for sql in programs() for tag, text in do_blocks(sql) if "remedies;" in text]
        # Preflight, check before reapplying and final check of both applies; final check of status.
        self.assertEqual(len(blocks), 7)
        for text in blocks:
            # Twice for TEMPORARY, once for CONNECT to the other databases.
            self.assertEqual(text.count("COALESCE(d.datacl, pg_catalog.acldefault('d', d.datdba))"), 3)

    def test_every_database_the_runtime_role_may_connect_to_counts(self):
        # Not only the application's: by default PUBLIC may connect to postgres and create
        # temporary tables there. template0 refuses connections (datallowconn).
        verify = squash(uncommented(dict(do_blocks(db_roles.status_program("sentinel").sql))["sentinel_verify"]))
        self.assertIn("WHERE d.datallowconn AND a.privilege_type = 'TEMPORARY'", verify)
        self.assertNotIn("d.datname = pg_catalog.current_database() AND a.privilege_type = 'TEMPORARY'", verify)

    def test_public_is_never_revoked_from(self):
        for sql in programs():
            text = code_everywhere(sql) + "\n" + "\n".join(dynamic_sql(sql))
            self.assertNotRegex(text, r"(?i)\bFROM\s+PUBLIC\b")
            self.assertNotRegex(text, r"(?i)\bREVOKE\b[^;]*\bTEMP(ORARY)?\b")

    def test_the_operator_is_told_what_to_run_and_as_whom(self):
        # Only the grantor of an ACL entry, or a role acting as it, can revoke that entry: the
        # database owner's REVOKE leaves a grant to PUBLIC made by another role in place.
        preflight = squash(uncommented(dict(do_blocks(program().sql))["sentinel_preflight"]))
        self.assertIn("pg_catalog.format('as %s: REVOKE TEMPORARY ON DATABASE %I FROM %s', a.grantor::pg_catalog.regrole,", preflight)
        self.assertIn(
            "this program never revokes from PUBLIC: run first, each as the role named (for a database the application"
            " does not use, revoking CONNECT from PUBLIC does as well): %', pg_catalog.regexp_replace(COALESCE(found,"
            " 'end the membership of sentinel_app in the role that holds it'),",
            preflight,
        )
        # On the other databases CONNECT goes (CONNECT_ELSEWHERE), which keeps TEMPORARY out of reach there too.
        for line in ("REVOKE TEMPORARY ON DATABASE <database> FROM PUBLIC;", "REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;",
                     "REVOKE CONNECT ON DATABASE template1 FROM PUBLIC;"):
            self.assertIn(line, db_roles.__doc__)

    def test_the_effective_privilege_is_checked_for_every_role_the_runtime_can_become(self):
        # has_database_privilege counts PUBLIC; pg_has_role MEMBER counts the role itself and every
        # role it belongs to, whether it inherits their privileges or may only SET ROLE to them.
        verify = squash(uncommented(dict(do_blocks(db_roles.status_program("sentinel").sql))["sentinel_verify"]))
        self.assertIn("AND pg_catalog.pg_has_role(app_oid, r.oid, 'MEMBER') AND pg_catalog.has_database_privilege(r.oid, d.oid, 'TEMPORARY')", verify)
        self.assertIn("AND (a.grantee = 0 OR pg_catalog.pg_has_role(app_oid, a.grantee, 'MEMBER'))", verify)
        self.assertNotIn("'USAGE')", verify.split("remedies;")[0].split("pg_catalog.string_agg(remedy")[-1])


class GuardTests(SimpleTestCase):
    """Each check the program makes, and that a failed one stops it.

    Text only: that each condition means in PostgreSQL what it says here is
    what running the program against a server shows.
    """

    def assertGuards(self, block, guards):
        code = squash(uncommented(block))
        for guard in guards:
            with self.subTest(guard=guard[:80]):
                self.assertIn(guard, code)

    def test_every_failed_check_raises_an_error(self):
        for sql in programs():
            code = code_everywhere(sql)
            self.assertTrue(re.findall(r"(?i)\bRAISE\s+EXCEPTION\b", code))
            # RAISE without a level is an EXCEPTION too, but would slip past the message checks.
            self.assertEqual(re.findall(r"(?i)\bRAISE\b(?!\s+EXCEPTION\b)", code), [])

    def test_no_check_can_be_skipped(self):
        # A handler, an early RETURN or EXIT would let a block end without its RAISE. The one
        # handler turns a lock timeout into a clearer error, and raises it.
        for sql in programs():
            for tag, text in do_blocks(sql):
                code = squash(code_everywhere_body(text))
                self.assertNotRegex(code, r"(?i)\b(RETURN|EXIT|GOTO|GET\s+(STACKED\s+)?DIAGNOSTICS)\b", tag)
                handlers = len(re.findall(r"(?i)\bEXCEPTION\s+WHEN\b", squash(uncommented(text))))
                self.assertEqual(handlers, 1 if tag == "sentinel_adopt" else 0, tag)
                self.assertEqual(len(re.findall(r"(?i)\bCONTINUE\b", code)),
                                 1 if tag in ("sentinel_verify", "sentinel_reapply") else 0, tag)
        # The one handler: a lock timeout, raised again with the table's name, and nothing else.
        adopt = squash(uncommented(dict(do_blocks(program("auth_user").sql))["sentinel_adopt"]))
        self.assertIn(
            "EXCEPTION WHEN lock_not_available THEN RAISE EXCEPTION 'sentinel-roles: table % is in use; stop web and"
            " whatever else uses the database, and run this again', pg_catalog.regexp_replace(relation::text,"
            f" {SHOWN}; END; END LOOP;",
            adopt,
        )
        # The one CONTINUE skips the table checks for a sequence, after its own.
        verify = squash(dict(do_blocks(program().sql))["sentinel_verify"])
        self.assertIn(
            f"OR pg_catalog.has_sequence_privilege(app_oid, relation.oid, 'UPDATE') {RAISE}"
            " 'sentinel-roles: the runtime role has privileges on sequence %',"
            f" pg_catalog.regexp_replace(relation.name, {SHOWN}; END IF; CONTINUE; END IF;",
            verify,
        )

    def test_plpgsql_can_find_where_each_condition_ends(self):
        # PL/pgSQL reads the condition of IF and ELSIF up to the first THEN outside
        # parentheses: a CASE there would be cut at its own THEN.
        for sql in programs():
            for tag, text in do_blocks(sql):
                tokens = re.findall(r"\(|\)|\bEND\s+IF\b|\b(?:ELSIF|IF|THEN|CASE)\b", code_everywhere_body(text))
                depth, condition = 0, False
                for token in tokens:
                    if token == "(":
                        depth += 1
                    elif token == ")":
                        depth -= 1
                    elif token in ("IF", "ELSIF") and depth == 0:
                        condition = True
                    elif token == "THEN" and depth == 0:
                        condition = False
                    elif token == "CASE" and condition:
                        self.assertGreater(depth, 0, f"a CASE in a condition of {tag} needs parentheses")
                self.assertEqual(depth, 0, tag)

    def test_the_session_is_checked_before_anything_else(self):
        for sql in (program().sql, db_roles.status_program("sentinel").sql):
            tags = [tag for tag, _ in do_blocks(sql)]
            self.assertEqual(tags[0], "sentinel_session")
            self.assertGuards(dict(do_blocks(sql))["sentinel_session"], SESSION_GUARDS)

    def test_preflight(self):
        self.assertGuards(dict(do_blocks(program("auth_user").sql))["sentinel_preflight"], PREFLIGHT_GUARDS + TRIPWIRE_GUARDS)
        preflight = dict(do_blocks(program().sql))["sentinel_preflight"]
        self.assertGuards(preflight, PREFLIGHT_GUARDS + TRIPWIRE_GUARDS + (BOOTSTRAP_RELATIONS_GUARD,))

    def test_final_check_of_apply(self):
        runtime = db_roles.scram_verifier(RUNTIME, salt=SALTS[0])
        migration = db_roles.scram_verifier(MIGRATION, salt=SALTS[1])
        stored = "pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to((SELECT rolpassword FROM pg_catalog.pg_authid WHERE oid = {}), 'UTF8')), 'hex')"
        passwords = (
            f"IF {stored.format('app_oid')} IS DISTINCT FROM '{hashlib.sha256(runtime.encode()).hexdigest()}'"
            f" OR {stored.format('migrate_oid')} IS DISTINCT FROM '{hashlib.sha256(migration.encode()).hexdigest()}'"
            f" {RAISE}"
        )
        verify = dict(do_blocks(program().sql))["sentinel_verify"]
        self.assertGuards(verify, VERIFY_GUARDS + TRIPWIRE_GUARDS + (passwords,))

    def test_status_checks_the_same(self):
        passwords = (
            "IF EXISTS (SELECT FROM pg_catalog.pg_authid WHERE oid IN (migrate_oid, app_oid)"
            f" AND (rolpassword IS NULL OR rolpassword NOT LIKE 'SCRAM-SHA-256$%')) {RAISE}"
        )
        verify = dict(do_blocks(db_roles.status_program("sentinel").sql))["sentinel_verify"]
        self.assertGuards(verify, VERIFY_GUARDS + TRIPWIRE_GUARDS + (passwords,))


# Every catalog object the program names, each one present in PostgreSQL 16. The
# recent ones: pg_has_role's 'SET' and the membership options (16), sha256 (11),
# regrole and regnamespace (9.5). A new name here needs that check too.
CATALOG = {
    "acldefault", "pg_attribute", "pg_auth_members", "pg_authid", "pg_cast", "pg_class", "pg_database", "pg_db_role_setting",
    "pg_default_acl", "pg_depend", "pg_event_trigger", "pg_extension", "pg_locks", "pg_namespace", "pg_operator",
    "pg_policy", "pg_proc", "pg_rewrite", "pg_roles", "pg_shdepend", "pg_stat_activity", "pg_trigger", "pg_type",
    "aclexplode", "convert_to", "count", "current_database", "current_setting", "encode", "format",
    "has_any_column_privilege", "has_database_privilege", "has_schema_privilege", "has_sequence_privilege",
    "has_table_privilege", "pg_backend_pid", "pg_describe_object", "pg_has_role", "pg_try_advisory_xact_lock", "regexp_replace", "sha256", "string_agg",
    # The provisioning history (LIFECYCLE): in PostgreSQL long before 16.
    "num_nonnulls", "obj_description", "set_config",
    # Who may create large objects (LARGE_OBJECTS): long before 16 too.
    "pg_language", "lo_unlink",
    "name", "regclass", "regnamespace", "regoperator", "regprocedure", "regrole", "regtype",
    # What else the roles could be given, checked by UNEXPECTED_ACCESS: in PostgreSQL 16 since 15
    # (pg_parameter_acl, has_parameter_privilege) or long before.
    "pg_init_privs", "pg_largeobject_metadata", "pg_parameter_acl", "pg_foreign_data_wrapper", "pg_foreign_server",
    "pg_tablespace", "has_foreign_data_wrapper_privilege", "has_server_privilege", "has_tablespace_privilege",
    "has_parameter_privilege", "quote_ident", "unnest",
    # What runs code, made after initdb (FOREIGN_OBJECTS); sessions left open elsewhere (CONNECT_ELSEWHERE).
    "pg_am", "pg_collation", "pg_conversion", "pg_language", "pg_opclass", "pg_opfamily", "pg_transform",
    "pg_ts_config", "pg_ts_dict", "pg_ts_parser", "pg_ts_template", "pg_terminate_backend",
}


class VersionTests(SimpleTestCase):
    def test_postgresql_16_to_18_only(self):
        session = dict(do_blocks(program().sql))["sentinel_session"]
        self.assertIn("NOT BETWEEN 160000 AND 189999", session)
        self.assertEqual((db_roles.MIN_SERVER_VERSION, db_roles.MAX_SERVER_VERSION), (160000, 189999))

    def test_every_catalog_object_named_is_one_checked_for_postgresql_16(self):
        named = set()
        for sql in programs():
            named |= set(re.findall(r"pg_catalog\.(\w+)", sql))
        self.assertEqual(named, CATALOG)

    def test_maintain_is_only_looked_for_where_it_exists(self):
        sql = program("auth_user").sql
        self.assertNotIn("MAINTAIN", code_everywhere(sql))
        for tag, text in do_blocks(sql):
            if "MAINTAIN" in text:
                self.assertIn("pg_catalog.current_setting('server_version_num')::integer >= 170000", text, tag)
        blocks = {tag: squash(uncommented(text)) for tag, text in do_blocks(sql)}
        # Only under the version check: PostgreSQL 16 has no MAINTAIN, and a bare 'MAINTAIN'
        # would be read as an array literal.
        self.assertIn(
            "IF pg_catalog.current_setting('server_version_num')::integer >= 170000 THEN"
            " extra := extra || ARRAY['MAINTAIN'];"
            " EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE \"sentinel_owner\" IN SCHEMA public REVOKE MAINTAIN ON TABLES FROM \"sentinel_app\"';"
            " END IF;",
            blocks["sentinel_grants"],
        )
        self.assertIn(
            "|| CASE WHEN pg_catalog.current_setting('server_version_num')::integer >= 170000"
            " THEN ARRAY['MAINTAIN'] ELSE ARRAY[]::text[] END LOOP",
            blocks["sentinel_verify"],
        )
        self.assertIn(
            "|| CASE WHEN pg_catalog.current_setting('server_version_num')::integer >= 170000"
            " THEN ARRAY['MAINTAIN'] ELSE ARRAY[]::text[] END) asked",
            blocks["sentinel_verify"],
        )
        self.assertEqual({tag: text.count("MAINTAIN") for tag, text in blocks.items() if "MAINTAIN" in text},
                         {"sentinel_preflight": 1, "sentinel_reapply": 2, "sentinel_grants": 2, "sentinel_verify": 2})

    def test_known_names_of_postgresql_17_and_18_are_not_used(self):
        sql = "".join(programs())
        # 17: pg_maintain, transaction_timeout, allow_alter_system, event_triggers; 18: the rest.
        for newer in ("pg_maintain", "transaction_timeout", "allow_alter_system", "event_triggers",
                      "ON LARGE OBJECTS", "md5_password_warnings", "oauth", "pg_get_acl"):
            self.assertNotIn(newer, sql)
        # Membership options per grant, and pg_auth_members columns for them, exist from 16.
        self.assertIn("WITH INHERIT FALSE, SET TRUE, ADMIN FALSE", sql)
        self.assertIn("m.inherit_option", sql)


class GenerationTests(SimpleTestCase):
    def test_same_inputs_same_program(self):
        self.assertEqual(program("auth_user").sql, program("auth_user").sql)

    def test_runs_differ_only_in_salts_and_nonce(self):
        def normalize(sql):
            sql = re.sub(r"SCRAM-SHA-256\$[^']+", "V", sql)
            sql = re.sub(r"'[0-9a-f]{64}'", "'D'", sql)
            return re.sub(r"[0-9a-f]{32}$", "N", sql, flags=re.M)

        first = db_roles.apply_program("sentinel", RUNTIME, MIGRATION)
        second = db_roles.apply_program("sentinel", RUNTIME, MIGRATION)
        self.assertNotEqual(first.sql, second.sql)
        self.assertNotEqual(first.nonce, second.nonce)
        self.assertTrue(first.sql.endswith(f"committed {first.nonce}\n"))
        self.assertEqual(normalize(first.sql), normalize(second.sql))

    def test_the_module_does_not_need_django(self):
        result = subprocess.run(
            [sys.executable, "-c", "import sys, json, sentinel.db_roles; print(json.dumps(sorted(m for m in sys.modules if m.split('.')[0] == 'django')))"],
            cwd=ROOT, env={"PATH": os.defpath, "PYTHONDONTWRITEBYTECODE": "1"}, capture_output=True, text=True, check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), [])

    def test_the_command_runs_as_a_module(self):
        result = subprocess.run(
            [sys.executable, "-m", "sentinel.db_roles", "status", "--nonce", NONCE],
            cwd=ROOT, env={"PATH": os.defpath, "PYTHONDONTWRITEBYTECODE": "1", "POSTGRES_DB": "sentinel"},
            capture_output=True, text=True, check=False,
        )
        self.assertEqual((result.returncode, result.stderr), (0, ""))
        self.assertEqual(result.stdout, db_roles.status_program("sentinel", nonce=NONCE).sql)


class CommandTests(SimpleTestCase):
    ENV = {"POSTGRES_DB": "sentinel", "SENTINEL_DB_PASSWORD": RUNTIME, "SENTINEL_DB_MIGRATE_PASSWORD": MIGRATION}

    def run_command(self, argv, environ):
        out, err = io.StringIO(), io.StringIO()
        original = sys.stderr
        sys.stderr = io.StringIO()  # argparse writes its usage errors there
        try:
            status = db_roles.main(argv, environ, out, err)
        finally:
            sys.stderr = original
        return status, out.getvalue(), err.getvalue()

    def test_apply_and_status(self):
        status, out, err = self.run_command(["apply", "--adopt-table", "auth_user", "--adopt-table", "django_migrations"], self.ENV)
        self.assertEqual((status, err), (0, ""))
        self.assertIn("ARRAY['auth_user', 'django_migrations']", out)
        self.assertNotIn(RUNTIME, out)
        self.assertNotIn(MIGRATION, out)
        # Each login gets the verifier of its own password.
        for role, password in (("sentinel_app", RUNTIME), ("sentinel_migrate", MIGRATION)):
            (verifier,) = re.findall(rf"ALTER ROLE \"{role}\" WITH LOGIN .* PASSWORD '([^']+)'", out)
            iterations, salt, stored_key, server_key = db_roles.parse_scram_verifier(verifier)
            self.assertEqual(db_roles.scram_keys(password, salt, iterations), (stored_key, server_key))
        status, out, err = self.run_command(["status"], {"POSTGRES_DB": "sentinel"})
        self.assertEqual((status, err), (0, ""))
        self.assertTrue(out.startswith("-- Generated"))

    def test_the_caller_chooses_the_nonce(self):
        for argv, last in ((["apply", "--nonce", NONCE], f"committed {NONCE}"), (["status", "--nonce", NONCE], f"verified {NONCE}")):
            with self.subTest(argv=argv):
                status, out, err = self.run_command(argv, self.ENV)
                self.assertEqual((status, err), (0, ""))
                self.assertEqual(out.splitlines()[-1], f"\\echo sentinel-roles: {last}")
        status, out, err = self.run_command(["apply", "--nonce", "not-hex"], self.ENV)
        self.assertEqual((status, out), (2, ""))
        self.assertIn("nonce", err)

    def test_refused_inputs_print_no_program_and_no_secret(self):
        cases = (
            (["apply"], {**self.ENV, "POSTGRES_DB": "postgres"}),
            (["apply"], {k: v for k, v in self.ENV.items() if k != "SENTINEL_DB_MIGRATE_PASSWORD"}),
            (["apply"], {**self.ENV, "SENTINEL_DB_PASSWORD": "change-me-SECRETMARKER-0123456789abcdef"}),
            (["apply"], {**self.ENV, "SENTINEL_DB_MIGRATE_PASSWORD": RUNTIME}),
            (["apply", "--adopt-table", "x'; DROP TABLE y; --"], self.ENV),
            (["status"], {}),
        )
        for argv, environ in cases:
            with self.subTest(argv=argv, environ=sorted(environ)):
                status, out, err = self.run_command(argv, environ)
                self.assertEqual((status, out), (2, ""))
                self.assertTrue(err.startswith("sentinel-roles: "))
                self.assertNotIn("SECRETMARKER", err)
                self.assertNotIn(RUNTIME, err)

    def test_usage_errors(self):
        for argv in ([], ["drop"], ["apply", "--adopt"], ["status", "--adopt-table", "x"], ["apply", "--nonce"]):
            with self.subTest(argv=argv):
                status, out, _ = self.run_command(argv, self.ENV)
                self.assertEqual((status, out), (2, ""))


class ComposeConfigTests(SimpleTestCase):
    """--compose-config: the passwords as Compose gives them to the services."""

    BOOTSTRAP = "Bq5-Hs3_Kd8.Wn1+Zr6/Tm9=Xf2Lc7vP4gJ0yA"

    def config(self, web=None, migrate=None, db=None):
        return {"services": {
            "db": {"environment": {"POSTGRES_DB": "sentinel", "POSTGRES_USER": "postgres",
                                   "POSTGRES_PASSWORD": self.BOOTSTRAP, **(db or {})}},
            "web": {"environment": {"POSTGRES_DB": "sentinel", "SENTINEL_DB_ROLES": "separate",
                                    "SENTINEL_DB_PASSWORD": RUNTIME, "SENTINEL_DB_MIGRATE_PASSWORD": "", **(web or {})}},
            "migrate": {"environment": {"POSTGRES_DB": "sentinel", "SENTINEL_DB_ROLES": "separate",
                                        "SENTINEL_DB_PASSWORD": "", "SENTINEL_DB_MIGRATE_PASSWORD": MIGRATION,
                                        **(migrate or {})}},
        }}

    def run_with(self, argv, config):
        stdin = sys.stdin
        sys.stdin = io.StringIO(config if isinstance(config, str) else json.dumps(config))
        try:
            return CommandTests.run_command(self, ["apply", "--compose-config", "-", *argv], {"POSTGRES_DB": "not_this_database"})
        finally:
            sys.stdin = stdin

    def test_the_passwords_of_web_and_migrate_go_to_their_logins(self):
        self.assertEqual(db_roles.compose_settings(self.config()), {
            "POSTGRES_DB": "sentinel", "SENTINEL_DB_PASSWORD": RUNTIME, "SENTINEL_DB_MIGRATE_PASSWORD": MIGRATION,
        })
        status, out, err = self.run_with(["--nonce", NONCE], self.config())
        self.assertEqual((status, err), (0, ""))
        # The environment is not read: the database is the db service's.
        self.assertIn("'sentinel'", out)
        self.assertNotIn("not_this_database", out)
        for role, password in (("sentinel_app", RUNTIME), ("sentinel_migrate", MIGRATION)):
            (verifier,) = re.findall(rf"ALTER ROLE \"{role}\" WITH LOGIN .* PASSWORD '([^']+)'", out)
            iterations, salt, stored_key, server_key = db_roles.parse_scram_verifier(verifier)
            self.assertEqual(db_roles.scram_keys(password, salt, iterations), (stored_key, server_key))
        for secret in (RUNTIME, MIGRATION, self.BOOTSTRAP):
            self.assertNotIn(secret, out)

    def test_a_password_given_to_the_wrong_service_is_refused(self):
        cases = (
            ({"web": {"POSTGRES_PASSWORD": self.BOOTSTRAP}}, "the web service would get POSTGRES_PASSWORD"),
            ({"web": {"SENTINEL_DB_MIGRATE_PASSWORD": MIGRATION}}, "the web service would get SENTINEL_DB_MIGRATE_PASSWORD"),
            ({"migrate": {"POSTGRES_PASSWORD": self.BOOTSTRAP}}, "the migrate service would get POSTGRES_PASSWORD"),
            ({"migrate": {"SENTINEL_DB_PASSWORD": RUNTIME}}, "the migrate service would get SENTINEL_DB_PASSWORD"),
            ({"web": {"POSTGRES_DB": "other"}}, "POSTGRES_DB of the web service differs"),
            ({"migrate": {"POSTGRES_DB": None}}, "POSTGRES_DB of the migrate service differs"),
        )
        for overrides, message in cases:
            with self.subTest(message=message):
                status, out, err = self.run_with([], self.config(**overrides))
                self.assertEqual((status, out), (2, ""))
                self.assertIn(f"sentinel-roles: {message}", err)
                for secret in (RUNTIME, MIGRATION, self.BOOTSTRAP):
                    self.assertNotIn(secret, err)

    def test_the_workers_log_in_like_web(self):
        def with_workers(**overrides):
            config = self.config()
            for worker in db_roles.COMPOSE_WORKERS:
                environment = {**config["services"]["web"]["environment"], **overrides.get(worker, {})}
                config["services"][worker] = {"environment": environment}
            return config

        self.assertEqual(db_roles.compose_settings(with_workers())["SENTINEL_DB_PASSWORD"], RUNTIME)
        cases = (
            ({"POSTGRES_PASSWORD": self.BOOTSTRAP}, "the {} service would get POSTGRES_PASSWORD"),
            ({"SENTINEL_DB_MIGRATE_PASSWORD": MIGRATION}, "the {} service would get SENTINEL_DB_MIGRATE_PASSWORD"),
            ({"SENTINEL_DB_PASSWORD": MIGRATION}, "the {} service would log in with another SENTINEL_DB_PASSWORD than web"),
            ({"SENTINEL_DB_PASSWORD": ""}, "the {} service would log in with another SENTINEL_DB_PASSWORD than web"),
            ({"POSTGRES_DB": "other"}, "POSTGRES_DB of the {} service differs"),
        )
        for worker in db_roles.COMPOSE_WORKERS:
            for overrides, message in cases:
                with self.subTest(worker=worker, message=message):
                    status, out, err = self.run_with([], with_workers(**{worker: overrides}))
                    self.assertEqual((status, out), (2, ""))
                    self.assertIn(f"sentinel-roles: {message.format(worker)}", err)
                    for secret in (RUNTIME, MIGRATION, self.BOOTSTRAP):
                        self.assertNotIn(secret, err)

    def test_a_configuration_without_the_services_or_their_passwords_is_refused(self):
        without_web = self.config()
        del without_web["services"]["web"]
        unresolved = self.config()
        unresolved["services"]["web"]["environment"] = ["SENTINEL_DB_PASSWORD"]
        no_password = self.config(web={"SENTINEL_DB_PASSWORD": None})
        for config, message in (
            (without_web, "has no db, web and migrate services"),
            ([], "has no db, web and migrate services"),
            (unresolved, "environment of the web service is not resolved"),
            (no_password, "SENTINEL_DB_PASSWORD"),
            ('{"services": {"web": "' + RUNTIME, "could not be read (JSONDecodeError)"),
        ):
            with self.subTest(message=message):
                status, out, err = self.run_with([], config)
                self.assertEqual((status, out), (2, ""))
                self.assertIn(message, err)
                self.assertNotIn(RUNTIME, err)

    def test_status_reads_the_database_of_the_db_service(self):
        stdin = sys.stdin
        sys.stdin = io.StringIO(json.dumps(self.config()))
        try:
            status, out, err = CommandTests.run_command(self, ["status", "--compose-config", "-", "--nonce", NONCE], {})
        finally:
            sys.stdin = stdin
        self.assertEqual((status, err), (0, ""))
        self.assertEqual(out, db_roles.status_program("sentinel", nonce=NONCE).sql)


class StartupCheckTests(SimpleTestCase):
    """Every start checks the roles with the checks of status (sentinel/database.py verify)."""

    def test_it_is_status_without_what_only_a_superuser_may_read(self):
        startup = db_roles.startup_check("sentinel")
        self.assertTrue(startup.startswith("DO $sentinel_startup$\n"))
        self.assertTrue(startup.endswith("$sentinel_startup$;\n"))
        self.assertNotIn("pg_authid ", startup.replace("'pg_catalog.pg_authid'::", ""))
        for verifiers in (None, ("SCRAM-SHA-256$4096:" + "A" * 24 + "$" + "B" * 43 + "=:" + "C" * 43 + "=",) * 2):
            with self.subTest(verifiers=verifiers is not None):
                status = db_roles._verify("sentinel", verifiers)
                same = startup.replace("$sentinel_startup$", "$sentinel_verify$").splitlines()
                diff = list(difflib.ndiff(same, status.splitlines()))
                self.assertEqual([line for line in diff if line.startswith("- ")], [])
                added = "\n".join(line[2:] for line in diff if line.startswith("+ "))
                # What status checks besides: the passwords, in pg_authid, and nothing else.
                conditions = re.findall(r"IF (.*?) THEN", added, re.S)
                self.assertEqual(len(conditions), 2)
                for condition in conditions:
                    self.assertIn("pg_catalog.pg_authid", condition)

    def test_it_holds_every_least_privilege_invariant(self):
        check = squash(db_roles.startup_check("sentinel"))
        for text in (
            squash(db_roles.TEMPORARY),
            squash(db_roles.CREATE_ANYWHERE),
            squash(db_roles.CONNECT_ELSEWHERE),
            squash(db_roles.UNEXPECTED_ACCESS),
            squash(db_roles.OTHER_DATABASES),
            squash(db_roles.TRIPWIRE),
            "pg_catalog.has_database_privilege(app_oid, db_oid, 'CREATE')",
            "pg_catalog.has_table_privilege(app_oid, relation.oid, privilege || ' WITH GRANT OPTION')",
            "pg_catalog.aclexplode(a.attacl) x",
            "NOT a.is_grantable",
            "pg_catalog.has_sequence_privilege(app_oid, relation.oid, 'USAGE')",
            "pg_catalog.has_schema_privilege(app_oid, n.oid, 'CREATE')",
        ):
            self.assertIn(text, check)

    def test_no_managed_role_may_create_schemas_in_any_database(self):
        create = squash(db_roles.CREATE_ANYWHERE)
        for role in ("app_oid", "migrate_oid", "owner_oid"):
            self.assertIn(f"pg_catalog.has_database_privilege({role}, d.oid, 'CREATE')", create)
        self.assertIn("WHERE d.datallowconn", create)
        for program in (db_roles.status_program("sentinel", nonce=NONCE).sql,
                        db_roles.apply_program("sentinel", RUNTIME, MIGRATION, (), nonce=NONCE).sql):
            self.assertIn(create, squash(program))

    def test_the_database_name_is_checked(self):
        for name in ("postgres", "a'b", ""):
            with self.subTest(name=name), self.assertRaises(InputError):
                db_roles.startup_check(name)


class LifecycleTests(SimpleTestCase):
    """The provisioning history (LIFECYCLE): A, nothing provisioned; B, what an apply of this
    program activated, recorded in schema sentinel_restricted; C, anything else, refused by
    apply before it changes anything, by status and by every start."""

    def test_every_kind_of_partial_or_foreign_history_is_c(self):
        lifecycle = squash(db_roles.LIFECYCLE)
        for text in (
            # Some of the roles only.
            "WHERE pg_catalog.num_nonnulls(owner_oid, migrate_oid, app_oid) IN (1, 2)",
            # The roles without the record, the record without the roles.
            "WHERE pg_catalog.num_nonnulls(owner_oid, migrate_oid, app_oid) = 3"
            " AND NOT EXISTS (SELECT FROM pg_catalog.pg_namespace WHERE nspname = 'sentinel_restricted')",
            "WHERE pg_catalog.num_nonnulls(owner_oid, migrate_oid, app_oid) = 0"
            " AND EXISTS (SELECT FROM pg_catalog.pg_namespace WHERE nspname = 'sentinel_restricted')",
            # The record: the bootstrap superuser's, open to no one, of this database and these roles.
            "WHERE n.nspname = 'sentinel_restricted' AND n.nspowner <> 10",
            "WHERE n.nspname = 'sentinel_restricted'"
            " AND EXISTS (SELECT FROM pg_catalog.aclexplode(n.nspacl) a WHERE a.grantee <> n.nspowner)",
            "AND pg_catalog.obj_description(n.oid, 'pg_namespace') IS DISTINCT FROM pg_catalog.format("
            "'sentinel-roles activation 1: database=%s owner=%s migrate=%s app=%s', db_oid, owner_oid, migrate_oid, app_oid)",
            "state := CASE WHEN found IS NOT NULL THEN 'C' WHEN owner_oid IS NULL THEN 'A' ELSE 'B' END;",
        ):
            self.assertIn(text, lifecycle)

    def test_the_history_is_read_before_anything_changes_and_in_every_check(self):
        lifecycle = squash(db_roles.LIFECYCLE)
        for tables in ((), ("auth_user",)):
            with self.subTest(tables=tables):
                sql = program(*tables).sql
                tags = [tag for tag, _ in do_blocks(sql)]
                # Classified in the preflight; checked as a whole in state B before anything changes.
                self.assertEqual(tags[:4], ["sentinel_session", "sentinel_lock", "sentinel_preflight", "sentinel_reapply"])
                self.assertEqual(tags[-2:], ["sentinel_marker", "sentinel_verify"])
                blocks = {tag: squash(text) for tag, text in do_blocks(sql)}
                for tag in ("sentinel_preflight", "sentinel_reapply", "sentinel_verify"):
                    self.assertIn(lifecycle, blocks[tag], tag)
                # The state the later blocks act on is the preflight's, set before any change.
                preflight = blocks["sentinel_preflight"]
                self.assertLess(preflight.index(lifecycle), preflight.index("PERFORM pg_catalog.set_config('sentinel.state', state, true);"))
                self.assertLess(preflight.index("IF state = 'C' THEN RAISE EXCEPTION"),
                                preflight.index("PERFORM pg_catalog.set_config('sentinel.state', state, true);"))
                self.assertLess(sql.index("DO $sentinel_reapply$"), sql.index("DO $sentinel_create$"))
        for text in (db_roles.status_program("sentinel").sql, db_roles.startup_check("sentinel")):
            self.assertIn(lifecycle, squash(text))

    def test_an_activated_installation_is_checked_as_a_whole_before_it_is_reapplied(self):
        # The B pre-check holds the checks of every start, and that the owner has no password:
        # all the final check reads but the passwords of the two logins, which apply sets. It
        # runs in state B only: before the first activation the roles do not exist.
        reapply = dict(do_blocks(program().sql))["sentinel_reapply"]
        inner = squash(uncommented(reapply))
        self.assertTrue(inner.startswith("DECLARE found text; state text; db_oid oid; owner_oid oid; migrate_oid oid;"
                                         " app_oid oid; relation record; privilege text;"
                                         " BEGIN IF pg_catalog.current_setting('sentinel.state') = 'B' THEN"), inner[:300])
        self.assertTrue(inner.endswith("END IF; END"), inner[-100:])

        def inside(block):
            return block.split("BEGIN\n", 1)[1].rsplit("END\n", 1)[0].splitlines()

        diff = list(difflib.ndiff(inside(db_roles.startup_check("sentinel")), inside(reapply)))
        self.assertEqual([line for line in diff if line.startswith("- ")], [])
        self.assertEqual(sorted(line[2:] for line in diff if line.startswith("+ ")),
                         sorted(["  IF pg_catalog.current_setting('sentinel.state') = 'B' THEN", "  END IF;",
                                 *db_roles.OWNER_WITHOUT_PASSWORD.splitlines()]))
        # The final checks hold it too, status and apply alike.
        for sql in programs():
            self.assertIn(squash(db_roles.OWNER_WITHOUT_PASSWORD), squash(dict(do_blocks(sql))["sentinel_verify"]))

    def test_nothing_is_adopted_in_an_activated_installation(self):
        preflight = squash(dict(do_blocks(program("auth_user").sql))["sentinel_preflight"])
        self.assertIn("IF state = 'B' THEN RAISE EXCEPTION 'sentinel-roles: the separate logins are activated already"
                      " (state B): there is nothing to adopt; run apply without --adopt-table';", preflight)
        self.assertNotIn("there is nothing to adopt", squash(dict(do_blocks(program().sql))["sentinel_preflight"]))

    def test_the_refusal_of_state_c_says_what_differs_and_what_to_do(self):
        message = db_roles.UNKNOWN_HISTORY
        self.assertEqual(placeholders(message), ["%"])
        self.assertIn("changes nothing in it and takes over no role it did not create", message)
        self.assertIn("rebuild Sentinel''s database in a new cluster, or undo what differs by hand", message)
        for sql in programs():
            self.assertIn(f"RAISE EXCEPTION '{message}', pg_catalog.regexp_replace(found, {SHOWN};", squash(sql))


class LargeObjectTests(SimpleTestCase):
    """No managed role may create a large object (LARGE_OBJECTS): the functions that do, known
    by the C function they call, and every large-object function PostgreSQL has classified."""

    def test_every_large_object_function_of_postgresql_is_classified(self):
        # PostgreSQL 18.6 has these 20 (test_database_startup_postgres compares them with the
        # server's own); a function in neither list is refused.
        self.assertEqual(set(db_roles.LARGE_OBJECT_CREATORS),
                         {"be_lo_creat", "be_lo_create", "be_lo_from_bytea", "be_lo_import", "be_lo_import_with_oid"})
        self.assertEqual(len(db_roles.LARGE_OBJECT_OTHERS), 15)
        self.assertFalse(set(db_roles.LARGE_OBJECT_CREATORS) & set(db_roles.LARGE_OBJECT_OTHERS))
        objects = squash(db_roles.LARGE_OBJECTS)
        known = ", ".join(f"'{name}'" for name in (*db_roles.LARGE_OBJECT_CREATORS, *db_roles.LARGE_OBJECT_OTHERS))
        self.assertIn(f"WHERE g.lanname = 'internal' AND p.prosrc LIKE 'be\\_lo%' AND p.prosrc NOT IN ({known});"
                      f" IF found IS NOT NULL {RAISE}", objects)

    def test_execute_on_a_creating_function_is_refused_however_it_is_held(self):
        objects = squash(db_roles.LARGE_OBJECTS)
        creating = ", ".join(f"'{name}'" for name in db_roles.LARGE_OBJECT_CREATORS)
        # By the C function called: an alias of a creating function counts, wherever it is.
        self.assertIn(f"WHERE p.prosrc IN ({creating}) AND a.privilege_type = 'EXECUTE'", objects)
        # PUBLIC, and every role a managed role belongs to (itself included), inherited or SET.
        self.assertIn(f"AND (a.grantee = 0 OR EXISTS (SELECT FROM pg_catalog.pg_roles m WHERE m.oid IN ({OIDS})"
                      " AND pg_catalog.pg_has_role(m.oid, a.grantee, 'MEMBER')))", objects)
        self.assertIn(f"AND pg_catalog.pg_has_role(m.oid, a.grantee, 'MEMBER'))) ) remedies; IF found IS NOT NULL {RAISE}",
                      objects)
        # The ACL as PostgreSQL reads it: NULL is the default, which gives PUBLIC EXECUTE.
        self.assertIn("pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) a", objects)
        self.assertIn("'as %s: REVOKE EXECUTE ON FUNCTION %s FROM %s'", objects)
        self.assertIn(f"FROM pg_catalog.pg_largeobject_metadata l WHERE l.lomowner IN ({OIDS}); IF found IS NOT NULL {RAISE}",
                      objects)

    def test_it_refuses_before_anything_changes_and_in_every_check(self):
        objects = squash(db_roles.LARGE_OBJECTS)
        for tables in ((), ("auth_user",)):
            sql = program(*tables).sql
            blocks = {tag: squash(text) for tag, text in do_blocks(sql)}
            for tag in ("sentinel_preflight", "sentinel_reapply", "sentinel_verify"):
                self.assertIn(objects, blocks[tag], tag)
            self.assertLess(sql.index(db_roles.LARGE_OBJECTS), sql.index("DO $sentinel_create$"))
        self.assertIn(objects, squash(db_roles.status_program("sentinel").sql))
        self.assertIn(objects, squash(db_roles.startup_check("sentinel")))
        # Never revoked by the program: the operator does, as the refusal says.
        for sql in programs():
            text = code_everywhere(sql) + "\n" + "\n".join(dynamic_sql(sql))
            self.assertNotRegex(text, r"(?i)\bREVOKE\s+EXECUTE\b")
        self.assertIn("REVOKE EXECUTE ON FUNCTION pg_catalog.lo_creat(integer), pg_catalog.lo_create(oid),\n"
                      "        pg_catalog.lo_from_bytea(oid, bytea) FROM PUBLIC;", db_roles.__doc__)


class DependencyTests(SimpleTestCase):
    """What UNEXPECTED_ACCESS, FOREIGN_OBJECTS and TRIPWIRE hold that no other check does (the
    comment above UNEXPECTED_ACCESS): narrowing them must keep each of these, in every check,
    wherever it moves."""

    PROTECTIONS = {
        "large-object ACL entries": "FROM pg_catalog.pg_largeobject_metadata l, pg_catalog.aclexplode(COALESCE(l.lomacl,"
                                    " pg_catalog.acldefault('L', l.lomowner))) a WHERE a.grantee = 0 OR a.grantee IN"
                                    f" ({OIDS})",
        "lo_compat_privileges off": "SELECT 'setting', 'lo_compat_privileges', 'on', 'every role'"
                                    " WHERE pg_catalog.current_setting('lo_compat_privileges')::boolean",
        "parameter authority": "FROM pg_catalog.pg_parameter_acl s, (SELECT rolname::text AS name FROM pg_catalog.pg_roles"
                               f" WHERE oid IN ({OIDS}) UNION ALL SELECT 'public') h, pg_catalog.unnest(ARRAY['SET', 'ALTER"
                               " SYSTEM']) asked WHERE pg_catalog.has_parameter_privilege(h.name, s.parname, asked)",
        "EXECUTE on the system's functions": "FROM pg_catalog.pg_proc f JOIN pg_catalog.pg_namespace n ON n.oid ="
                                             " f.pronamespace, pg_catalog.aclexplode(COALESCE(f.proacl,"
                                             " pg_catalog.acldefault('f', f.proowner))) a WHERE n.nspname IN"
                                             f" ('pg_catalog', 'information_schema') AND (a.grantee = 0 OR a.grantee IN ({OIDS}))",
        "functions owned by a managed role": f"FROM pg_catalog.pg_proc p WHERE p.pronamespace = {PUBLIC_OID} OR p.proowner IN ({OIDS})",
        "code made after initdb": "FROM pg_catalog.pg_proc p WHERE p.oid >= 16384",
    }

    def test_every_check_keeps_them(self):
        blocks = [(tag, text) for sql in programs() for tag, text in do_blocks(sql)
                  if tag in ("sentinel_preflight", "sentinel_reapply", "sentinel_verify")]
        blocks += do_blocks(db_roles.startup_check("sentinel"))
        self.assertEqual(sorted({tag for tag, _ in blocks}),
                         ["sentinel_preflight", "sentinel_reapply", "sentinel_startup", "sentinel_verify"])
        for tag, text in blocks:
            code = squash(uncommented(text))
            for name, protection in self.PROTECTIONS.items():
                with self.subTest(block=tag, protection=name):
                    self.assertIn(protection, code)


class DedicatedClusterTests(SimpleTestCase):
    """The separate logins run on a cluster of Sentinel's own (DEDICATED_CLUSTER): a
    compatibility check of what the cluster's shared catalogs hold, nothing more."""

    def test_only_sentinel_s_and_initdb_s_databases_and_the_known_roles_are_allowed(self):
        topology = squash(db_roles.DEDICATED_CLUSTER)
        self.assertIn("SELECT 'database ' || pg_catalog.quote_ident(d.datname) AS item FROM pg_catalog.pg_database d"
                      " WHERE d.datname NOT IN (pg_catalog.current_database(), 'postgres', 'template0', 'template1')",
                      topology)
        self.assertIn("SELECT 'role ' || pg_catalog.quote_ident(r.rolname) FROM pg_catalog.pg_roles r"
                      " WHERE r.oid <> 10 AND r.rolname NOT IN ('sentinel_owner', 'sentinel_migrate', 'sentinel_app')"
                      " AND r.rolname !~ '^pg_'", topology)
        self.assertIn("RAISE EXCEPTION 'sentinel-roles: the separate logins are supported on a PostgreSQL cluster of"
                      " their own only (the db service of this Compose project), and this cluster also has %;", topology)
        # Only names: no claim about how the cluster was made (no OIDs, no initdb baseline).
        self.assertNotIn("16384", topology)
        self.assertNotIn("pg_init_privs", topology)

    def test_it_refuses_before_anything_changes_and_in_every_check(self):
        topology = squash(db_roles.DEDICATED_CLUSTER)
        for tables in ((), ("auth_user",)):
            with self.subTest(tables=tables):
                sql = program(*tables).sql
                preflight = squash(dict(do_blocks(sql))["sentinel_preflight"])
                self.assertIn(topology, preflight)
                self.assertLess(sql.index(db_roles.DEDICATED_CLUSTER), sql.index("DO $sentinel_create$"))
                # First of what the preflight judges, so that the cause is named first.
                self.assertLess(preflight.index(topology), preflight.index(squash(db_roles.TEMPORARY)))
        for text in programs():
            verify = squash(dict(do_blocks(text))["sentinel_verify"])
            self.assertIn(topology, verify)
            self.assertLess(verify.index("the roles are not provisioned in this cluster"), verify.index(topology))
        startup = squash(db_roles.startup_check("sentinel"))
        self.assertIn(topology, startup)
        self.assertLess(startup.index(topology), startup.index(squash(db_roles.OTHER_DATABASES)))


class ReachTests(SimpleTestCase):
    """What the roles may reach: the application's database alone (CONNECT_ELSEWHERE), and
    in it nothing but the application's objects and the system catalogs (UNEXPECTED_ACCESS)."""

    def test_the_logins_may_connect_to_no_other_database(self):
        connect = squash(db_roles.CONNECT_ELSEWHERE)
        self.assertIn("WHERE d.datallowconn AND d.datname <> pg_catalog.current_database() AND a.privilege_type = 'CONNECT'"
                      " AND (a.grantee = 0 OR a.grantee IN (app_oid, migrate_oid))", connect)
        for role in ("app_oid", "migrate_oid"):
            self.assertIn(f"pg_catalog.has_database_privilege({role}, d.oid, 'CONNECT')", connect)
        self.assertIn("COALESCE(d.datacl, pg_catalog.acldefault('d', d.datdba))", connect)
        self.assertIn("'as %s: REVOKE CONNECT ON DATABASE %I FROM %s'", connect)
        # Refused before anything changes, and in every final check.
        preflight = squash(dict(do_blocks(program().sql))["sentinel_preflight"])
        self.assertIn(connect, preflight)
        for sql in programs():
            for tag, text in do_blocks(sql):
                if tag in ("sentinel_verify", "sentinel_startup"):
                    self.assertIn(connect, squash(text))
        self.assertIn(connect, squash(db_roles.startup_check("sentinel")))

    def test_every_kind_of_object_is_looked_at(self):
        access = squash(db_roles.UNEXPECTED_ACCESS)
        for text in (
            "has_schema_privilege(h.name, n.oid, asked)",
            "c.relkind IN ('r', 'p', 'v', 'm', 'f', 't', 'S')",
            "NOT (n.oid = 'public'::pg_catalog.regnamespace AND c.relkind IN ('r', 'p', 'S'))",
            "has_any_column_privilege(h.name, c.oid, asked)",
            "pg_catalog.pg_init_privs i WHERE i.classoid = 'pg_catalog.pg_class'::pg_catalog.regclass",
            "i.classoid = 'pg_catalog.pg_proc'::pg_catalog.regclass",
            "i.objsubid = t.attnum",
            "pg_catalog.pg_largeobject_metadata l",
            "pg_catalog.current_setting('lo_compat_privileges')::boolean",
            "has_foreign_data_wrapper_privilege(h.name, w.oid, 'USAGE')",
            "has_server_privilege(h.name, s.oid, 'USAGE')",
            "has_tablespace_privilege(h.name, s.oid, 'CREATE')",
            "has_parameter_privilege(h.name, s.parname, asked)",
        ):
            self.assertIn(text, access)
        # Every role it manages and PUBLIC, before the roles exist too; whoever holds it is named.
        holders = squash(db_roles.HOLDERS)
        self.assertEqual(holders, "(SELECT rolname::text AS name FROM pg_catalog.pg_roles WHERE oid IN"
                                  " (owner_oid, migrate_oid, app_oid) UNION ALL SELECT 'public') h")
        self.assertEqual(access.count(holders), 6)
        self.assertEqual(access.count("THEN 'PUBLIC'"), 10)
        self.assertIn("'sentinel-roles: in database %, the managed roles may use what the application does not: %;", access)

    def test_has_sequence_privilege_is_only_asked_of_sequences(self):
        # It fails on anything else, and PostgreSQL evaluates the conditions of WHERE in any order.
        access = squash(db_roles.UNEXPECTED_ACCESS)
        for match in re.finditer(r"pg_catalog\.has_sequence_privilege\(", access):
            self.assertRegex(access[:match.start()][-90:], r"CASE WHEN c\.relkind = 'S' THEN (asked IN \('USAGE', 'SELECT', 'UPDATE'\) AND )?$")

    def test_the_system_catalogs_are_compared_with_what_initdb_gave(self):
        access = squash(db_roles.UNEXPECTED_ACCESS)
        # Relations, columns and functions, each against what initdb gave it, and only what
        # initdb made gets a baseline: placement in a system schema proves nothing.
        self.assertEqual(access.count("pg_catalog.pg_init_privs"), 3)
        self.assertEqual(access.count("< 16384"), 5)  # and the USAGE on the system's schemas
        self.assertEqual(db_roles.FIRST_NORMAL_OID, 16384)
        self.assertIn("AND b.is_grantable >= a.is_grantable", access)
        # information_schema has no record in pg_init_privs: PUBLIC may read the relations initdb made there.
        self.assertIn("NOT (n.nspname = 'information_schema' AND c.oid < 16384 AND a.grantee = 0"
                      " AND a.privilege_type = 'SELECT' AND NOT a.is_grantable)", access)
        # Of the system's schemas, only the USAGE initdb gave on pg_catalog and information_schema.
        self.assertIn("AND NOT (n.oid < 16384 AND n.nspname IN ('pg_catalog', 'information_schema') AND asked = 'USAGE')",
                      access)


class PrivilegeModelTests(SimpleTestCase):
    """The privilege model as a whole: every kind of privilege a role could hold, and every
    path to one, has a check here and a test against PostgreSQL that refuses it."""

    KINDS = {
        "database privileges", "schema privileges", "table and view privileges", "column privileges",
        "sequence privileges", "function privileges", "large-object privileges",
        "foreign-data wrapper and server privileges", "tablespace privileges", "parameter privileges",
        "role memberships", "PUBLIC-derived privileges", "cross-database CONNECT", "retained cross-database sessions",
        "system-object provenance", "code made after initdb", "temporary tables",
        "writes to the record of the migrations", "large-object creation", "what other sessions could be made to run",
    }

    def test_every_kind_has_a_runtime_test_that_exists(self):
        import inspect

        from apps.core.tests import test_database_startup_postgres as startup

        self.assertEqual(set(startup.PRIVILEGE_MODEL), self.KINDS)
        for kind, (test, case) in startup.PRIVILEGE_MODEL.items():
            with self.subTest(kind):
                cls, method = test.split(".")
                source = inspect.getsource(getattr(getattr(startup, cls), method))
                self.assertIn(case, source)

    def test_the_preflight_refuses_before_anything_changes(self):
        # PUBLIC's privileges are checked before the roles exist, so apply refuses them
        # before it creates or changes a role; its final check, and status, again.
        preflight = squash(dict(do_blocks(program().sql))["sentinel_preflight"])
        first_change = program().sql.index("DO $sentinel_create$")
        for fragment in (db_roles.TEMPORARY, db_roles.CONNECT_ELSEWHERE, db_roles.UNEXPECTED_ACCESS,
                         db_roles.FOREIGN_OBJECTS, db_roles.TRIPWIRE):
            self.assertIn(squash(fragment), preflight)
            self.assertLess(program().sql.index(fragment), first_change)
        for sql in programs():
            for tag, text in do_blocks(sql):
                if tag == "sentinel_verify":
                    for fragment in (db_roles.CONNECT_ELSEWHERE, db_roles.UNEXPECTED_ACCESS, db_roles.FOREIGN_OBJECTS):
                        self.assertIn(squash(fragment), squash(text))

    def test_code_made_after_initdb_is_looked_for_in_every_catalog_of_it(self):
        objects = squash(db_roles.FOREIGN_OBJECTS)
        for catalog in ("pg_proc", "pg_type", "pg_operator", "pg_cast", "pg_conversion", "pg_collation", "pg_opclass",
                        "pg_opfamily", "pg_am", "pg_language", "pg_transform", "pg_extension", "pg_ts_parser",
                        "pg_ts_template", "pg_ts_dict", "pg_ts_config", "pg_foreign_data_wrapper", "pg_foreign_server"):
            self.assertRegex(objects, rf"FROM pg_catalog\.{catalog} \w+ (JOIN [^)]* )?WHERE \w+\.oid >= 16384", catalog)
        # The function check is everywhere, pg_catalog included; no schema is trusted for code.
        self.assertIn("FROM pg_catalog.pg_proc p WHERE p.oid >= 16384 UNION ALL", objects)

    def test_sessions_left_open_elsewhere_are_named_never_ended(self):
        connect = squash(db_roles.CONNECT_ELSEWHERE)
        self.assertIn("FROM pg_catalog.pg_stat_activity a WHERE a.usesysid IN (app_oid, migrate_oid)"
                      " AND a.datname <> pg_catalog.current_database() AND a.pid <> pg_catalog.pg_backend_pid();", connect)
        self.assertIn("'pid %s (%s in database %s, %s): SELECT pg_catalog.pg_terminate_backend(%s)'", connect)
        # Printed for the operator, inside a literal: never run.
        for sql in programs():
            self.assertNotIn("pg_terminate_backend", code_everywhere(sql))
