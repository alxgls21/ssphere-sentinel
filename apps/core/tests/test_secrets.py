"""The secrets of a new Compose installation (sentinel/secrets.py): what init creates, and when it refuses."""

import os
import stat
import tempfile
from pathlib import Path
from unittest import TestCase

from sentinel import secrets


class InitializeTests(TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        base = Path(directory.name)
        self.folder = base / "secrets"
        self.folder.mkdir()
        self.cluster = base / "data"
        self.cluster.mkdir()

    def initialize(self):
        return secrets.initialize(self.folder, self.cluster, owner=os.getuid(), group=os.getgid())

    def contents(self):
        return {path.name: path.read_text() for path in self.folder.iterdir()}

    def test_a_new_installation_gets_three_random_private_secrets_and_may_create_its_database(self):
        self.assertEqual(self.initialize(), "created")
        values = {name: (self.folder / name).read_text().strip() for name in secrets.FILES.values()}
        self.assertEqual(len(set(values.values())), 3)
        for name, value in values.items():
            self.assertRegex(value, r"^[A-Za-z0-9_-]{64}$")
            self.assertEqual(stat.S_IMODE((self.folder / name).stat().st_mode), 0o400, name)
        self.assertTrue((self.folder / secrets.INITIALIZE_MARKER).exists())
        self.assertFalse([path for path in self.folder.iterdir() if path.name.endswith(".new")])

    def test_again_nothing_changes_and_the_authorization_goes_once_the_database_exists(self):
        self.initialize()
        before = self.contents()
        self.assertEqual(self.initialize(), "kept")
        self.assertEqual(self.contents(), before)
        (self.cluster / "PG_VERSION").write_text("18\n")
        self.assertEqual(self.initialize(), "kept")
        self.assertFalse((self.folder / secrets.INITIALIZE_MARKER).exists())
        self.assertEqual({name for name in self.contents()}, set(secrets.FILES.values()))

    def test_a_database_without_its_secrets_is_refused(self):
        (self.cluster / "PG_VERSION").write_text("18\n")
        with self.assertRaisesRegex(RuntimeError, "the database exists"):
            self.initialize()
        self.assertEqual(self.contents(), {})

    def test_some_secrets_but_not_all_are_refused(self):
        self.initialize()
        (self.folder / "agent_token_pepper").unlink()
        before = self.contents()
        with self.assertRaisesRegex(RuntimeError, "but not agent_token_pepper"):
            self.initialize()
        self.assertEqual(self.contents(), before)


class LoadTests(TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.folder = Path(directory.name)
        for name in secrets.FILES.values():
            (self.folder / name).write_text(f"from-{name}\n")

    def test_only_what_the_environment_leaves_out_is_filled(self):
        environ = {"SENTINEL_SECRETS_DIR": str(self.folder), "DJANGO_SECRET_KEY": "from-env", "AGENT_TOKEN_PEPPER": " "}
        self.assertEqual(secrets.load(environ), ["AGENT_TOKEN_PEPPER", "POSTGRES_PASSWORD"])
        self.assertEqual(environ["DJANGO_SECRET_KEY"], "from-env")
        self.assertEqual(environ["AGENT_TOKEN_PEPPER"], "from-agent_token_pepper")
        self.assertEqual(environ["POSTGRES_PASSWORD"], "from-postgres_password")

    def test_without_the_directory_nothing_happens(self):
        environ = {"SENTINEL_SECRETS_DIR": str(self.folder / "missing")}
        self.assertEqual(secrets.load(environ), [])
        self.assertEqual(environ, {"SENTINEL_SECRETS_DIR": str(self.folder / "missing")})

    def test_separate_logins_never_take_the_superusers_password(self):
        environ = {"SENTINEL_SECRETS_DIR": str(self.folder), "SENTINEL_DB_ROLES": "separate"}
        with self.assertRaisesRegex(RuntimeError, "holds the database superuser's password"):
            secrets.load(environ)
        (self.folder / "postgres_password").unlink()
        self.assertEqual(secrets.load(environ), ["DJANGO_SECRET_KEY", "AGENT_TOKEN_PEPPER"])
        self.assertNotIn("POSTGRES_PASSWORD", environ)


class InitCommandTests(TestCase):
    def test_env_with_the_database_password_needs_no_secrets(self):
        with tempfile.TemporaryDirectory() as directory:
            environ = {"SENTINEL_ENV_SETS_DATABASE_PASSWORD": "yes", "SENTINEL_SECRETS_DIR": directory}
            self.assertEqual(secrets.main(["secrets", "init"], environ), 0)
            self.assertEqual(os.listdir(directory), [])

    def test_a_refusal_is_an_exit_status(self):
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, "data").mkdir()
            Path(directory, "data", "PG_VERSION").write_text("18\n")
            environ = {"SENTINEL_SECRETS_DIR": directory, "SENTINEL_DATABASE_DIR": str(Path(directory, "data"))}
            self.assertEqual(secrets.main(["secrets", "init"], environ), 1)
            self.assertEqual(secrets.main(["secrets"], environ), 2)
