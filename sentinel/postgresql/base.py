"""Django's PostgreSQL backend, refusing connections Sentinel may not use.

Every new connection is checked (sentinel/database.py ``check``) before
Django uses it, whatever opened it: Gunicorn, ``manage.py migrate``, a shell.
A refused connection is closed, never kept for the next query.

``dbshell`` is disabled: psql would open a connection of its own, with the
login and database its arguments, environment, service, password and startup
files and ``\\connect`` choose, none of which the check sees. Run psql in the
database container instead.

``django_migrations`` decides which DDL migrate runs, so the runtime login may
only read it (sentinel/database.py):

* ``migrate`` calls ``prepare_database`` before anything else, before it
  reads which migrations are pending, prunes, creates a table or records a
  migration, however it was started (the entrypoint, ``manage.py`` directly,
  ``call_command``). There, in a transaction PostgreSQL keeps read-only and
  rolls back, a record the runtime login could change stops it.
* With the separate logins, the migrate service's session is the owner role,
  whose default privileges give every new table the runtime login's INSERT,
  UPDATE and DELETE. ``django_migrations``, which Django creates before the
  first migration runs, is created in a transaction that also takes them back
  and checks the same again: it commits read-only for the runtime login, or
  not at all.
"""

from django.core.management import CommandError
from django.db import DatabaseError, transaction
from django.db.backends.postgresql import base, client, schema
from django.db.transaction import TransactionManagementError

from sentinel import database


def _unsafe_record(unsafe):
    return (
        f"{database.RUNTIME_ROLE} could change {database.MIGRATIONS_TABLE}, which decides what migrate runs, "
        f"or hand a privilege on it on ({unsafe}); correct that (scripts/postgres-roles.sh status names it), "
        "then migrate again"
    )


class DatabaseClient(client.DatabaseClient):
    def runshell(self, parameters):
        raise CommandError(
            "dbshell is disabled: psql would connect by itself, past the check of every "
            "connection (sentinel/postgresql/base.py); run psql in the database container"
        )


class DatabaseSchemaEditor(schema.DatabaseSchemaEditor):
    def create_model(self, model):
        restricted = (
            model._meta.db_table == database.MIGRATIONS_TABLE
            and self.connection.settings_dict["OPTIONS"].get("assume_role") == database.OWNER_ROLE
        )
        if restricted and not self.connection.in_atomic_block:
            # Outside a transaction the table would be committed with the default privileges.
            raise TransactionManagementError(
                f"{database.MIGRATIONS_TABLE} is created in a transaction with its privileges, or not at all"
            )
        super().create_model(model)
        if not restricted:
            return
        for statement in database.MIGRATIONS_TABLE_PRIVILEGES:
            self.execute(statement, None)
        with self.connection.cursor() as cursor:
            cursor.execute(database.MIGRATIONS_TABLE_UNSAFE)
            (unsafe,) = cursor.fetchone()
        if unsafe:
            # Raised inside the transaction: the table is not committed.
            raise DatabaseError(_unsafe_record(unsafe))


class DatabaseWrapper(base.DatabaseWrapper):
    client_class = DatabaseClient
    SchemaEditorClass = DatabaseSchemaEditor

    def get_new_connection(self, conn_params):
        connection = super().get_new_connection(conn_params)
        try:
            database.check(connection)
        except BaseException:
            connection.close()
            raise
        return connection

    def prepare_database(self):
        super().prepare_database()
        # Read-only and rolled back, or a savepoint rolled back: nothing it ran stays.
        with transaction.atomic(using=self.alias):
            with self.cursor() as cursor:
                cursor.execute("SET TRANSACTION READ ONLY")
                cursor.execute(database.MIGRATIONS_TABLE_UNSAFE)
                (unsafe,) = cursor.fetchone()
            transaction.set_rollback(True, using=self.alias)
        if unsafe:
            raise CommandError(f"nothing was migrated: {_unsafe_record(unsafe)}")
