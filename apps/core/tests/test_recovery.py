"""The recovery of an existing installation's data (sentinel/recovery.py), without a database: what it compares,
what it refuses, the commands it gives PostgreSQL's programs, and that it checks before it touches anything.
Against real PostgreSQL: test_recovery_postgres.py."""

import contextlib
import io
import json
import re
import shlex
import shutil
import subprocess
import tempfile
from pathlib import Path
from unittest import mock

from django.test import SimpleTestCase

from sentinel import db_roles, recovery

ROOT = Path(__file__).resolve().parents[3]


def sequence(name="t_id_seq", *, last_value=5, is_called=True, increment=1, minimum=1, maximum=2147483647, cycle=False,
             table="t", column="id", column_max=5):
    return {"name": name, "table": table, "column": column, "increment": increment, "min": minimum, "max": maximum,
            "cycle": cycle, "last_value": last_value, "is_called": is_called, "column_max": column_max}


def manifest(**parts):
    base = {"format": recovery.FORMAT, "server": "18.0", "database": "d", "migrations": [["auth", "0001_initial"]],
            "tables": {"t": {"rows": 3, "fingerprint": "f", "columns": [["id", "integer", True, "d"]]}},
            "constraints": [["t", "p", "PRIMARY KEY (id)", True, False, False]], "foreign_keys": [],
            "sequences": [sequence()], "outside": [], "large_objects": 0}
    return {**base, **parts}


class FakeEndpoint(recovery.Endpoint):
    """An endpoint that runs nothing: it says what it was asked."""

    def run(self, program, arguments=(), *, stdin=None, stdout=None):
        raise AssertionError(f"{program} was run")

    def psql(self, script):
        raise AssertionError("psql was run")


class EndpointTests(SimpleTestCase):
    def test_programs_are_run_directly_with_libpq_s_environment(self):
        endpoint = recovery.Endpoint(user="u", environment={"PGHOST": "h", "PGPASSWORD": "secret"})
        with mock.patch.dict("os.environ", {"PGOPTIONS": ""}):
            argv, environment = endpoint.command("psql", ["-c", "SELECT 1"])
        self.assertEqual(argv, ["psql", "-c", "SELECT 1"])
        self.assertEqual((environment["PGUSER"], environment["PGHOST"], environment["PGPASSWORD"]), ("u", "h", "secret"))
        self.assertNotIn("secret", " ".join(argv))

    def test_read_only_and_the_role_are_options_of_every_session(self):
        with mock.patch.dict("os.environ", {"PGOPTIONS": "-c statement_timeout=5s"}):
            options = lambda **settings: recovery.Endpoint(**settings).settings().get("PGOPTIONS")  # noqa: E731
            self.assertEqual(options(read_only=True), "-c statement_timeout=5s -c default_transaction_read_only=on")
            self.assertEqual(options(role="sentinel_owner"), "-c statement_timeout=5s -c role=sentinel_owner")
            self.assertEqual(options(read_only=True, role="sentinel_owner"),
                             "-c statement_timeout=5s -c default_transaction_read_only=on -c role=sentinel_owner")
            self.assertIsNone(options())
        with mock.patch.dict("os.environ", {}, clear=True):
            self.assertEqual(recovery.Endpoint(read_only=True).settings(), {"PGOPTIONS": recovery.READ_ONLY})

    def test_in_a_compose_project_the_programs_run_in_the_db_container_over_its_socket(self):
        endpoint = recovery.Endpoint(compose_dir="/srv/old", user="sentinel_migrate", role="sentinel_owner", read_only=True)
        argv, _ = endpoint.command("pg_dump", ["--data-only"])
        self.assertEqual(argv[:6], ["docker", "compose", "--project-directory", "/srv/old", "exec", "-T"])
        self.assertEqual(argv[argv.index("db") + 1:], ["sh", "-c", recovery.CONTAINER_SHELL, "sh", "pg_dump", "--data-only"])
        flags = argv[6:argv.index("db")]
        self.assertEqual(flags, ["-e", "PGUSER=sentinel_migrate", "-e",
                                 "PGOPTIONS=-c default_transaction_read_only=on -c role=sentinel_owner"])
        # The container's own login and database unless one is named.
        self.assertIn('PGUSER="${PGUSER:-$POSTGRES_USER}"', recovery.CONTAINER_SHELL)
        self.assertIn('PGDATABASE="${PGDATABASE:-$POSTGRES_DB}"', recovery.CONTAINER_SHELL)

    def test_a_password_is_never_given_to_docker(self):
        endpoint = recovery.Endpoint(compose_dir="/srv/old", environment={"PGPASSWORD": "secret"})
        with self.assertRaises(recovery.Failure):
            endpoint.command("psql")

    def test_programs_that_are_missing_are_a_failure_not_a_traceback(self):
        with mock.patch.dict("os.environ", {"PATH": "/nonexistent"}), self.assertRaises(recovery.Failure) as caught:
            recovery.Endpoint().run("psql")
        self.assertIn("not installed", str(caught.exception))


class WithheldTests(SimpleTestCase):
    def test_what_could_be_a_value_of_a_row_is_left_out(self):
        text = ('pg_restore: error: COPY failed for table "auth_group": ERROR:  duplicate key value violates unique constraint '
                '"auth_group_name_key"\nDETAIL:  Key (name)=(Operators) already exists.\nCONTEXT:  COPY auth_group, line 3: "3\\tOperators"\n')
        shown = recovery.withheld(text)
        self.assertIn("duplicate key value violates unique constraint", shown)
        for hidden in ("Operators", "DETAIL", "CONTEXT", "line 3"):
            self.assertNotIn(hidden, shown)

    def test_a_value_an_error_line_quotes_is_left_out_too(self):
        for line, hidden in (
            ('ERROR:  invalid input syntax for type integer: "4711-secret"', "4711-secret"),
            ('pg_restore: error: COPY failed: ERROR:  value "s3cr3t" is out of range for type smallint', "s3cr3t"),
            ('ERROR:  invalid byte sequence for encoding "UTF8": 0xc3 0x28', "0xc3"),
        ):
            with self.subTest(line):
                shown = recovery.withheld(line)
                self.assertNotIn(hidden, shown)
                self.assertTrue(shown.startswith(("ERROR", "pg_restore")), shown)
        # What names a constraint, or a column, stays: it is no row's value.
        self.assertIn('"auth_group_name_key"', recovery.withheld(
            'ERROR:  duplicate key value violates unique constraint "auth_group_name_key"'))

    def test_a_message_is_shortened_and_what_has_none_says_so(self):
        self.assertLessEqual(len(recovery.withheld("ERROR: " + "x" * 5000)), 600)
        self.assertIn("see the PostgreSQL log", recovery.withheld("DETAIL: Key (a)=(b)"))
        self.assertEqual(recovery.withheld(""), "(no message; see the PostgreSQL log)")


class ComparisonTests(SimpleTestCase):
    def test_migrations_are_pairs_and_nothing_else(self):
        old = manifest(migrations=[["auth", "0001_initial"], ["core", "0001_initial"]])
        # The order they are listed in is no part of it.
        recovery.check_migrations(old, manifest(migrations=[["core", "0001_initial"], ["auth", "0001_initial"]]))
        with self.assertRaises(recovery.Rejected) as caught:
            recovery.check_migrations(old, manifest(migrations=[["auth", "0001_initial"], ["core", "0002_more"]]))
        self.assertEqual(caught.exception.check, "migrations")
        self.assertIn("only the old database has core.0001_initial", caught.exception.detail)
        self.assertIn("only the new one has core.0002_more", caught.exception.detail)

    def test_tables_columns_constraints_and_sequences_are_the_same(self):
        recovery.check_tables(manifest(), manifest())
        recovery.check_schema(manifest(), manifest())
        other_table = {"u": manifest()["tables"]["t"]}
        for new, check in ((manifest(tables=other_table), recovery.check_tables),
                           (manifest(tables={"t": {**manifest()["tables"]["t"], "columns": [["id", "bigint", True, "d"]]}}),
                            recovery.check_schema),
                           (manifest(constraints=[]), recovery.check_schema),
                           (manifest(sequences=[sequence(maximum=10)]), recovery.check_schema),
                           (manifest(sequences=[sequence(name="other_seq")]), recovery.check_schema)):
            with self.subTest(check=check.__name__), self.assertRaises(recovery.Rejected):
                check(manifest(), new)

    def test_a_column_that_is_always_generated_is_refused(self):
        always = manifest(tables={"t": {**manifest()["tables"]["t"], "columns": [["id", "integer", True, "a"]]}})
        with self.assertRaises(recovery.Rejected) as caught:
            recovery.check_schema(always, always)
        self.assertIn("identity ALWAYS column t.id", caught.exception.detail)

    def test_rows_are_compared_by_count_and_by_content(self):
        recovery.check_data(manifest(), manifest())
        for changed, mention in (({"rows": 2}, "t has 2 rows, the old one 3"), ({"fingerprint": "g"}, "t has other content")):
            new = manifest(tables={"t": {**manifest()["tables"]["t"], **changed}})
            with self.subTest(mention), self.assertRaises(recovery.Rejected) as caught:
                recovery.check_data(manifest(), new)
            self.assertEqual(caught.exception.check, "verify.data")
            self.assertIn(mention, caught.exception.detail)
        with self.assertRaises(recovery.Rejected):
            recovery.check_data(manifest(), manifest(tables={}))

    def test_a_destination_is_fresh_when_only_what_the_migrations_seed_is_in_it(self):
        def destination(**rows):
            tables = {name: {"rows": 0} for name in (*recovery.SEEDED, "auth_user", "t")}
            for name in recovery.ALWAYS_SEEDED:
                tables[name] = {"rows": 5}
            for name, count in rows.items():
                tables[name] = {"rows": count}
            return {"tables": tables}

        recovery.check_fresh(destination())
        recovery.check_fresh(destination(auth_group=2, auth_group_permissions=3))
        with self.assertRaises(recovery.Rejected) as caught:
            recovery.check_fresh(destination(auth_user=1))
        self.assertIn("holds data of its own: auth_user (1 rows)", caught.exception.detail)
        with self.assertRaises(recovery.Rejected) as caught:
            recovery.check_fresh(destination(django_content_type=0))
        self.assertIn("did not finish", caught.exception.detail)
        self.assertEqual(caught.exception.check, "destination.fresh")

    def test_a_list_of_differences_is_cut_short_and_says_how_many_more(self):
        self.assertEqual(recovery.listed(["b", "a"]), "a, b")
        self.assertEqual(recovery.listed(str(n) for n in range(8)), "0, 1, 2, 3, 4 and 3 more")


class SequenceTests(SimpleTestCase):
    def test_the_next_value_depends_on_whether_the_last_one_was_given(self):
        # last_value is the value given last, unless none was (is_called false): then it is the one to give.
        self.assertEqual(recovery.next_value(sequence(last_value=5, is_called=True)), 6)
        self.assertEqual(recovery.next_value(sequence(last_value=5, is_called=False)), 5)
        self.assertEqual(recovery.next_value(sequence(last_value=1, is_called=False)), 1)
        self.assertEqual(recovery.next_value(sequence(last_value=5, is_called=True, increment=10)), 15)

    def test_a_sequence_is_sound_when_it_gives_values_its_column_does_not_hold_yet_for_good(self):
        self.assertEqual(recovery.sequence_problems([sequence()]), [])
        self.assertEqual(recovery.sequence_problems([sequence(column_max=None, last_value=1, is_called=False)]), [])
        # The last value left to give is not exhausted; the one after it is.
        top = 2147483647
        self.assertEqual(recovery.sequence_problems([sequence(last_value=top, is_called=False, column_max=3)]), [])
        for item, mention in (
            (sequence(last_value=top, is_called=True, column_max=3), "is exhausted"),
            (sequence(last_value=5, is_called=True, column_max=9), "would give 6, which t.id has already (largest 9)"),
            (sequence(last_value=5, is_called=False, column_max=5), "would give 5"),
            (sequence(cycle=True), "starts again at its end"),
            (sequence(increment=-1), "does not count up"),
            (sequence(table=None, column=None, column_max=None), "belongs to no column"),
            (sequence(last_value=0, is_called=False, minimum=1, column_max=None), "below its minimum"),
        ):
            with self.subTest(mention):
                self.assertIn(mention, " ".join(recovery.sequence_problems([item])))

    def test_sequences_are_compared_by_their_next_value_and_not_by_how_it_is_said(self):
        # (5, called) and (6, not called) are the same sequence: both give 6.
        old = manifest(sequences=[sequence(last_value=5, is_called=True)])
        recovery.check_sequences_match(old, manifest(sequences=[sequence(last_value=6, is_called=False)]))
        for new in (sequence(last_value=5, is_called=False), sequence(last_value=6, is_called=True)):
            with self.subTest(new), self.assertRaises(recovery.Rejected) as caught:
                recovery.check_sequences_match(old, manifest(sequences=[new]))
            self.assertEqual(caught.exception.check, "verify.sequences")
        with self.assertRaises(recovery.Rejected):
            recovery.check_sequences_match(old, manifest(sequences=[]))

    def test_each_sequence_is_set_to_give_next_what_the_old_one_would(self):
        script = recovery.sequences_sql(manifest(sequences=[
            sequence(name="a_id_seq", last_value=5, is_called=True), sequence(name="b_id_seq", last_value=1, is_called=False),
            sequence(name='odd"name', last_value=9, is_called=True, increment=2)]))
        self.assertEqual(script.splitlines(), [
            "BEGIN;",
            "SELECT pg_catalog.setval('public.\"a_id_seq\"'::regclass, 6, false);",
            "SELECT pg_catalog.setval('public.\"b_id_seq\"'::regclass, 1, false);",
            "SELECT pg_catalog.setval('public.\"odd\"\"name\"'::regclass, 11, false);",
            "COMMIT;"])

    def test_a_name_with_a_quote_cannot_leave_its_literal(self):
        script = recovery.sequences_sql(manifest(sequences=[sequence(name="x'; DROP TABLE t; --")]))
        self.assertIn("'public.\"x''; DROP TABLE t; --\"'::regclass", script)
        with self.assertRaises((TypeError, ValueError)):
            recovery.sequences_sql(manifest(sequences=[sequence(last_value="1; DROP TABLE t")]))


class IntegrityTests(SimpleTestCase):
    def test_a_foreign_key_is_checked_by_the_rows_that_refer_to_nothing(self):
        keys = [{"table": "child", "parent": "par ent", "columns": ["a", "b"], "parent_columns": ["x", "y"]}]
        script = recovery.integrity_sql(manifest(foreign_keys=keys))
        self.assertTrue(script.startswith("BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY;"))
        self.assertTrue(script.endswith("ROLLBACK;\n"))
        # A NULL in a column of the key means no reference (MATCH SIMPLE); the columns pair up in order.
        self.assertIn('c."a" IS NOT NULL AND c."b" IS NOT NULL', script)
        self.assertIn('p."x" = c."a" AND p."y" = c."b"', script)
        self.assertIn('public."par ent" p', script)

    def test_orphans_are_named_by_their_key_and_counted(self):
        keys = [{"table": "c", "parent": "p", "columns": ["a"], "parent_columns": ["id"]},
                {"table": "d", "parent": "p", "columns": ["a"], "parent_columns": ["id"]}]

        class Counting(FakeEndpoint):
            def psql(self, script):
                return "0|0\n1|4\n"

        self.assertEqual(recovery.orphans(Counting(), manifest(foreign_keys=keys)), ["d (a) -> p: 4 rows"])
        self.assertEqual(recovery.orphans(FakeEndpoint(), manifest()), [])  # no key: nothing to ask

    def test_what_is_unsound_is_everything_that_would_stop_the_application(self):
        unvalidated = manifest(constraints=[["t", "c", "CHECK (x > 0)", False, False, False]], sequences=[sequence(cycle=True)])
        problems = recovery.soundness(FakeEndpoint(), unvalidated)
        self.assertIn("constraint not validated: CHECK (x > 0) of t", problems)
        self.assertTrue(any("starts again" in problem for problem in problems))


class IdleTests(SimpleTestCase):
    def endpoint(self, counts):
        answers = iter(counts)

        class Counting(FakeEndpoint):
            def psql(self, script):
                return f"{next(answers)}\n"

        return Counting()

    def test_a_session_that_is_only_leaving_is_waited_for(self):
        recovery.check_idle(self.endpoint([1, 1, 0]), grace=5, interval=0)

    def test_a_session_that_stays_is_a_finding(self):
        with self.assertRaises(recovery.Rejected) as caught:
            recovery.check_idle(self.endpoint([2] * 100), grace=0.05, interval=0.01)
        self.assertEqual(caught.exception.check, "destination.idle")
        self.assertIn("2 other sessions", caught.exception.detail)


class TrustedTests(SimpleTestCase):
    def endpoint(self, who, error=None):
        class Asked(FakeEndpoint):
            def psql(self, script):
                if "current_user" in script:
                    return who
                if error:
                    raise recovery.Failure(error)
                return ""

        return Asked()

    def test_the_login_is_the_runtime_login_and_not_a_superuser(self):
        self.assertEqual(recovery.trusted(self.endpoint("sentinel_app|f|db\n"), "destination.trusted"), "db")
        for who, mention in (("postgres|t|db\n", "a superuser"), ("sentinel_migrate|f|db\n", "not as sentinel_migrate")):
            with self.subTest(who), self.assertRaises(recovery.Rejected) as caught:
                recovery.trusted(self.endpoint(who), "destination.trusted")
            self.assertEqual(caught.exception.check, "destination.login")
            self.assertIn(mention, caught.exception.detail)

    def test_what_the_start_checks_refuse_is_a_finding_and_a_failure_to_ask_is_not(self):
        with self.assertRaises(recovery.Rejected) as caught:
            recovery.trusted(self.endpoint("sentinel_app|f|db\n", "psql: ERROR: sentinel-roles: the runtime role may create | x"),
                             "activate.trusted")
        self.assertEqual((caught.exception.check, caught.exception.detail), ("activate.trusted", "the runtime role may create"))
        with self.assertRaises(recovery.Failure):
            recovery.trusted(self.endpoint("sentinel_app|f|db\n", "psql: error: connection to server failed"), "activate.trusted")


class RestoreTests(SimpleTestCase):
    def test_the_restore_is_one_transaction_that_stops_at_the_first_error_and_bypasses_nothing(self):
        arguments = recovery.restore_arguments("sentinel", ["b", "a"])
        self.assertEqual(arguments, ["--data-only", "--single-transaction", "--exit-on-error", "--no-password", "--schema=public",
                                     "--table=a", "--table=b", "--dbname=sentinel"])
        for bypass in ("--disable-triggers", "--superuser", "--clean", "--create", "--role", "--use-set-session-authorization",
                       "--section"):
            self.assertFalse(any(argument.startswith(bypass) for argument in arguments), bypass)

    def test_what_the_migrations_seeded_is_replaced_children_before_parents(self):
        statements = [line for line in recovery.clear_sql().splitlines() if line.startswith("DELETE")]
        self.assertEqual(statements, [f'DELETE FROM public."{name}";' for name in recovery.SEEDED])
        self.assertLess(recovery.SEEDED.index("auth_group_permissions"), recovery.SEEDED.index("auth_group"))
        self.assertLess(recovery.SEEDED.index("auth_group_permissions"), recovery.SEEDED.index("auth_permission"))


class DumpTests(SimpleTestCase):
    LISTING = """\
;
; Archive created at 2026-01-01 00:00:00 UTC
;     dbname: sentinel
;
2570; 0 16427 TABLE DATA public auth_group sentinel_owner
2571; 0 16431 TABLE DATA public auth_user sentinel_owner
2600; 0 0 SEQUENCE SET public auth_group_id_seq sentinel_owner
2601; 0 0 SEQUENCE SET public auth_user_id_seq sentinel_owner
"""

    def listing(self, text):
        class Listing(recovery.Endpoint):
            def run(self, program, arguments=(), *, stdin=None, stdout=None):
                return subprocess.CompletedProcess([program], 0, stdout=text.encode(), stderr=b"")

        return recovery.contents(Listing(), Path("dump"))

    def test_what_a_dump_holds_is_read_from_its_table_of_contents(self):
        self.assertEqual(self.listing(self.LISTING), {"tables": ["auth_group", "auth_user"],
                                                      "sequences": ["auth_group_id_seq", "auth_user_id_seq"], "other": []})
        found = self.listing(self.LISTING + "10; 1259 16400 TABLE public auth_group sentinel_owner\n"
                             "11; 0 0 FK CONSTRAINT public x y sentinel_owner\n")
        self.assertEqual(len(found["other"]), 2)

    def test_a_dump_has_the_data_of_the_tables_and_the_sequences_of_the_manifest_and_nothing_else(self):
        wanted = manifest(tables={"auth_group": {}, "auth_user": {}},
                          sequences=[sequence(name="auth_group_id_seq"), sequence(name="auth_user_id_seq")])
        recovery.check_contents(self.listing(self.LISTING), wanted)
        for text, mention in (
            (self.LISTING.replace("2571; 0 16431 TABLE DATA public auth_user sentinel_owner\n", ""), "no data of auth_user"),
            (self.LISTING + "2572; 0 16433 TABLE DATA public stray sentinel_owner\n", "data of stray"),
            (self.LISTING + "2570; 0 16427 TABLE DATA public auth_group sentinel_owner\n", "data of a table twice"),
            (self.LISTING.replace("auth_user_id_seq", "other_seq"), "the sequences it sets are not the application's"),
            (self.LISTING + "10; 1259 16400 TABLE public auth_group sentinel_owner\n", "holds more than data"),
        ):
            with self.subTest(mention), self.assertRaises(recovery.Rejected) as caught:
                recovery.check_contents(self.listing(text), wanted)
            self.assertEqual(caught.exception.check, "dump.toc")
            self.assertIn(mention, caught.exception.detail)

    def test_a_dump_that_cannot_be_listed_is_rejected(self):
        class Unreadable(recovery.Endpoint):
            def run(self, program, arguments=(), *, stdin=None, stdout=None):
                return subprocess.CompletedProcess([program], 1, stdout=b"", stderr=b"pg_restore: error: not a valid archive")

        with self.assertRaises(recovery.Rejected) as caught:
            recovery.contents(Unreadable(), Path("dump"))
        self.assertEqual(caught.exception.check, "dump.toc")


class BundleTests(SimpleTestCase):
    """Nothing touches the destination until the bundle itself is sound."""

    def bundle(self, **changes):
        directory = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: shutil.rmtree(directory, ignore_errors=True))
        dump = directory / recovery.DUMP
        dump.write_bytes(b"dump")
        data = {"format": recovery.FORMAT, "created": "now", "source": {"manifest": manifest(), "unsound": []},
                "dump": {"file": recovery.DUMP, "sha256": recovery.sha256(dump), "bytes": 4}}
        data.update(changes)
        (directory / recovery.BUNDLE).write_text(json.dumps(data))
        return directory

    def attempt(self, bundle, **options):
        work = Path(tempfile.mkdtemp()) / "work"
        with self.assertRaises(recovery.Rejected) as caught:
            recovery.import_bundle(FakeEndpoint(), FakeEndpoint(), bundle, work, log=lambda message: None, **options)
        self.assertEqual(json.loads((work / recovery.STATE).read_text())["state"], "rejected")
        return caught.exception

    def test_a_bundle_that_is_not_sound_is_rejected_before_any_cluster_is_asked(self):
        # (FakeEndpoint fails the test when it runs anything.)
        broken = self.bundle()
        (broken / recovery.DUMP).write_bytes(b"dumb")
        self.assertEqual(self.attempt(broken).check, "bundle")
        unsound = self.bundle(source={"manifest": manifest(), "unsound": ["foreign key t (a) -> p: 1 rows"]})
        self.assertIn("is not sound", self.attempt(unsound).detail)
        outside = self.bundle(source={"manifest": manifest(outside=["other.t"]), "unsound": []})
        self.assertIn("outside schema public", self.attempt(outside).detail)
        missing = self.bundle()
        (missing / recovery.DUMP).unlink()
        self.assertIn("missing", self.attempt(missing).detail)
        self.assertIn("not a bundle", self.attempt(self.bundle(format=99)).detail)

    def test_the_dump_is_the_bundle_s_own_file_and_the_bundle_can_be_pinned(self):
        elsewhere = self.bundle()
        record = json.loads((elsewhere / recovery.BUNDLE).read_text())
        record["dump"]["file"] = "../other.dump"
        (elsewhere / recovery.BUNDLE).write_text(json.dumps(record))
        self.assertIn("in the bundle's own directory", self.attempt(elsewhere).detail)
        linked = self.bundle()
        (linked / "real.dump").write_bytes(b"dump")
        (linked / recovery.DUMP).unlink()
        (linked / recovery.DUMP).symlink_to(linked / "real.dump")
        self.assertIn("not a regular file", self.attempt(linked).detail)
        pinned = self.bundle()
        self.assertIn("not the one whose SHA-256 was given", self.attempt(pinned, expected_sha256="0" * 64).detail)

    def test_the_old_database_is_found_unchanged_whatever_minor_release_its_server_is(self):
        bundle = self.bundle()

        class Old(FakeEndpoint):
            def __init__(self, **changes):
                super().__init__()
                object.__setattr__(self, "answer", json.dumps(manifest(**changes)))

            def psql(self, script):
                return self.answer

        work = Path(tempfile.mkdtemp()) / "work"
        recovery.Work.new(work, bundle)
        recovery.verify_source(Old(server="18.7"), bundle, log=lambda message: None, work=work)
        self.assertEqual(json.loads((work / recovery.STATE).read_text())["source_verified"], recovery.bundle_digest(bundle))
        with self.assertRaises(recovery.Rejected) as caught:
            recovery.verify_source(Old(tables={"t": {**manifest()["tables"]["t"], "rows": 4}}), bundle,
                                   log=lambda message: None, work=work)
        self.assertEqual(caught.exception.check, "source")
        self.assertIn("t", caught.exception.detail)
        # The finding that failed ended the earlier approval.
        self.assertNotIn("source_verified", json.loads((work / recovery.STATE).read_text()))

    def test_the_old_database_is_read_in_read_only_sessions_only(self):
        with self.assertRaises(recovery.Failure):
            recovery.export_bundle(FakeEndpoint(), Path(tempfile.mkdtemp()) / "bundle", log=lambda message: None)

    def test_the_work_directory_and_the_bundle_are_private_and_new(self):
        directory = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: shutil.rmtree(directory, ignore_errors=True))
        recovery.private_directory(directory / "new")
        self.assertEqual((directory / "new").stat().st_mode & 0o777, 0o700)
        with self.assertRaises(FileExistsError):
            recovery.private_directory(directory / "new")
        recovery.write_json(directory / "a.json", {"b": 1})
        self.assertEqual((directory / "a.json").stat().st_mode & 0o777, 0o600)
        self.assertFalse((directory / "a.json.part").exists())


class ActivationTests(SimpleTestCase):
    """What ``activate`` needs before it asks the destination anything: nothing is started without it."""

    def work(self, state, *, bundle=True, imported=True, source=True, **extra):
        """A work directory in ``state``; with the bundle it was made from, pinned as import pins it, and, as
        verify-source records it, the old database found unchanged."""
        root = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: shutil.rmtree(root, ignore_errors=True))
        directory = root / "bundle"
        directory.mkdir()
        if bundle:
            (directory / recovery.DUMP).write_bytes(b"dump")
            (directory / recovery.BUNDLE).write_text(json.dumps({
                "format": recovery.FORMAT, "source": {"manifest": manifest(), "unsound": []},
                "dump": {"file": recovery.DUMP, "sha256": recovery.sha256(directory / recovery.DUMP)}}))
        work = recovery.Work.new(root / "work", directory)
        digest = recovery.bundle_digest(directory) if bundle else "0" * 64
        work.to(state, **({"bundle_sha256": digest} if imported else {}), **({"source_verified": digest} if source else {}), **extra)
        return root / "work"

    def refused(self, work, **options):
        started = []
        with self.assertRaises(recovery.Refused) as caught:
            recovery.activate(FakeEndpoint(), FakeEndpoint(), work, lambda: started.append("up"), log=lambda message: None)
        self.assertEqual((caught.exception.check, started), ("activate", []))
        return caught.exception

    def test_only_a_verified_destination_is_started(self):
        for state, extra in (("checking", {}), ("restoring", {}), ("restored", {}), ("activated", {}),
                             ("rejected", {"failed": {"check": "verify.data", "detail": "t has 2 rows"}})):
            with self.subTest(state):
                error = self.refused(self.work(state, **extra))
                self.assertIn(f"the destination is {state}, not verified", error.detail)
        self.assertIn("verify.data: t has 2 rows", error.detail)

    def test_the_bundle_must_be_the_one_that_was_imported(self):
        self.assertIn("not the one that was imported", self.refused(self.work("verified", imported=False)).detail)
        work = self.work("verified")
        bundle = Path(json.loads((work / recovery.STATE).read_text())["bundle"])
        record = json.loads((bundle / recovery.BUNDLE).read_text())
        record["source"]["unsound"] = []
        (bundle / recovery.BUNDLE).write_text(json.dumps(record, indent=2))  # the same data, not the same file
        self.assertIn("not the one that was imported", self.refused(work).detail)

    def test_the_old_database_must_have_been_found_unchanged(self):
        error = self.refused(self.work("verified", source=False))
        self.assertIn("verify-source", error.detail)
        self.assertIn("--work", error.detail)

    def test_a_refusal_does_not_reject_the_destination(self):
        work = self.work("verified", source=False)
        self.refused(work)
        self.assertEqual(json.loads((work / recovery.STATE).read_text())["state"], "verified")

    def test_a_start_that_did_not_complete_is_only_started_again(self):
        # The application may be running and have written: nothing about the destination is asked, nothing is rejected.
        work = self.work("activating")
        started = []
        recovery.activate(FakeEndpoint(), FakeEndpoint(), work, lambda: started.append("up"), log=lambda message: None)
        self.assertEqual((started, json.loads((work / recovery.STATE).read_text())["state"]), (["up"], "activated"))

    def test_a_work_directory_that_is_not_one_is_rejected(self):
        with self.assertRaises(recovery.Rejected):
            recovery.activate(FakeEndpoint(), FakeEndpoint(), Path(tempfile.mkdtemp()), None, log=lambda message: None)

    def test_the_stack_is_started_by_docker_compose_up_and_a_failure_of_it_is_reported(self):
        with mock.patch("subprocess.run") as run:
            run.return_value.returncode = 0
            recovery.compose_start("/srv/new")()
            self.assertEqual(run.call_args.args[0], ["docker", "compose", "--project-directory", "/srv/new", "up", "--detach", "--wait"])
            run.return_value.returncode = 1
            with self.assertRaises(recovery.Failure) as caught:
                recovery.compose_start("/srv/new")()
            self.assertIn("run activate again", str(caught.exception))
            self.assertIn("Never discard this destination", str(caught.exception))


class CommandLineTests(SimpleTestCase):
    def run_main(self, arguments):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            return recovery.main(arguments), out.getvalue(), err.getvalue()

    def test_each_command_takes_what_it_needs(self):
        for arguments in ([], ["export"], ["import", "--bundle", "b"], ["activate"], ["frobnicate"]):
            with self.subTest(arguments), self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
                recovery.parser().parse_args(arguments)
        arguments = recovery.parser().parse_args(["import", "--bundle", "b", "--work", "w", "--compose-dir", "/srv/new"])
        self.assertEqual((arguments.command, arguments.compose_dir), ("import", "/srv/new"))

    def test_a_rejection_exits_one_and_says_which_check_and_that_nothing_was_touched_or_started(self):
        with mock.patch.object(recovery, "import_bundle", side_effect=recovery.Rejected("migrations", "they differ")):
            status, _, err = self.run_main(["import", "--bundle", "b", "--work", "w"])
        self.assertEqual(status, 1)
        self.assertIn("REJECTED: migrations: they differ", err)
        self.assertIn("not started; the old installation was not touched", err)

    def test_a_refusal_to_start_exits_one_without_calling_the_destination_rejected(self):
        with mock.patch.object(recovery, "activate", side_effect=recovery.Refused("activate", "run verify-source first")):
            status, _, err = self.run_main(["activate", "--work", "w"])
        self.assertEqual(status, 1)
        self.assertIn("REFUSED: activate: run verify-source first", err)
        self.assertNotIn("rejected", err)

    def test_what_is_not_a_finding_never_exits_with_the_status_of_one(self):
        # An uncaught exception ends Python with 1, which is a rejection: a malformed record is a failure.
        for error in (KeyError("manifest"), ValueError("not json"), TypeError("x")):
            with self.subTest(error), mock.patch.object(recovery, "import_bundle", side_effect=error):
                status, _, err = self.run_main(["import", "--bundle", "b", "--work", "w"])
            self.assertEqual(status, 3)
            self.assertIn(f"recovery: failed: {type(error).__name__}", err)

    def test_the_bundle_can_be_pinned_and_the_source_check_recorded_in_the_work(self):
        with mock.patch.object(recovery, "import_bundle") as restore:
            self.run_main(["import", "--bundle", "b", "--work", "w", "--bundle-sha256", "ab12"])
        self.assertEqual(restore.call_args.kwargs["expected_sha256"], "ab12")
        with mock.patch.object(recovery, "verify_source") as verify:
            self.run_main(["verify-source", "--bundle", "b", "--work", "w"])
        self.assertEqual(verify.call_args.kwargs["work"], Path("w"))

    def test_a_failure_exits_three(self):
        for error in (recovery.Failure("psql is not installed"), FileExistsError("exists")):
            with self.subTest(error), mock.patch.object(recovery, "export_bundle", side_effect=error):
                status, _, err = self.run_main(["export", "--bundle", "b"])
            self.assertEqual(status, 3)
            self.assertIn("recovery: failed:", err)

    def test_the_old_database_is_read_only_and_the_destination_is_reached_by_two_logins(self):
        with mock.patch.object(recovery, "export_bundle") as export:
            self.assertEqual(self.run_main(["export", "--bundle", "b", "--compose-dir", "/srv/old"])[0], 0)
        source = export.call_args.args[0]
        self.assertEqual((source.read_only, source.compose_dir, source.user), (True, "/srv/old", None))
        with mock.patch.object(recovery, "import_bundle") as restore:
            self.assertEqual(self.run_main(["import", "--bundle", "b", "--work", "w", "--compose-dir", "/srv/new"])[0], 0)
        runtime, owner = restore.call_args.args[:2]
        self.assertEqual((runtime.user, runtime.role, runtime.read_only), (db_roles.RUNTIME_ROLE, None, False))
        self.assertEqual((owner.user, owner.role, owner.read_only), (db_roles.MIGRATION_ROLE, db_roles.OWNER_ROLE, False))

    def test_activate_starts_the_stack_only_in_a_compose_project(self):
        with mock.patch.object(recovery, "activate") as activate:
            self.run_main(["activate", "--work", "w", "--compose-dir", "/srv/new"])
            self.assertIsNotNone(activate.call_args.args[3])
            self.run_main(["activate", "--work", "w"])
            self.assertIsNone(activate.call_args.args[3])


class DocumentationTests(SimpleTestCase):
    """docs/server-deployment.md is the operator's procedure: what it names exists."""

    def setUp(self):
        self.text = (ROOT / "docs" / "server-deployment.md").read_text()

    def section(self):
        heading = "#### Recover the data of an installation into a new cluster"
        start = self.text.index(heading)
        end = re.search(r"^#{2,4} ", self.text[start + len(heading):], re.MULTILINE)
        return self.text[start:start + len(heading) + end.start()]

    def test_every_command_of_the_procedure_is_one_the_tool_parses(self):
        section = self.section()
        # Each command with its continuation lines, its variables put in, as the tool's own parser reads it.
        joined = re.sub(r"\\\n\s*", " ", section)
        commands = re.findall(r"^python3 -m sentinel\.recovery (.+)$", joined, re.MULTILINE)
        self.assertEqual({command.split()[0] for command in commands}, {"export", "verify-source", "import", "activate"})
        for command in commands:
            filled = re.sub(r"<[^>]*>", "0123abcd", command.replace('"$OLD"', "/srv/old").replace('"$NEW"', "/srv/new"))
            arguments = shlex.split(filled)
            with self.subTest(command):
                parsed = recovery.parser().parse_args(arguments)  # exits on an unknown or a missing option
                self.assertEqual(parsed.compose_dir, "/srv/old" if arguments[0] in ("export", "verify-source") else "/srv/new")
        by_command = {command.split()[0]: command for command in commands}
        self.assertIn("--work", by_command["verify-source"])  # activate requires its record
        self.assertIn("--bundle-sha256", by_command["import"])

    def test_every_check_the_tool_makes_is_explained(self):
        section = self.section()
        checks = [name for check in re.findall(r"^\s{15}([a-z]+(?:\.[a-z]+)?(?:, [a-z]+)?)\s{2,}", recovery.__doc__, re.MULTILINE)
                  for name in check.split(", ")]
        self.assertGreaterEqual(len(checks), 12)
        for name in (*checks, "restore.clear", "restore.data", "restore.sequences"):
            self.assertIn(f"`{name}`", section, f"the procedure does not explain the check {name}")

    def test_what_the_procedure_says_the_tool_prints_is_what_it_prints(self):
        source = Path(recovery.__file__).read_text()
        section = " ".join(self.section().split())
        for phrase in ("the old database is exactly what was exported", "the old database was read, never written",
                       "recovery: VERIFIED: the destination holds exactly the data of the old database; nothing is started until it is activated",
                       "recovery: ACTIVATED", "docker compose up did not complete", "recovery: REJECTED:"):
            with self.subTest(phrase):
                self.assertIn(phrase, section)
                self.assertIn(phrase, " ".join(source.split()))

    def test_the_procedure_keeps_the_old_installation_and_never_starts_the_new_one_before_it_is_verified(self):
        section = self.section()
        for must in ("never writes", "rollback", "docker compose run --rm migrate", "postgres-roles.sh apply", "activate"):
            self.assertIn(must.lower(), section.lower())
        self.assertLess(section.index("sentinel.recovery import"), section.index("sentinel.recovery activate"))
        self.assertNotIn("--disable-triggers", section.replace("no `--disable-triggers`", ""))
