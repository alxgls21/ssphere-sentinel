"""What PostgreSQL does with each of some statements, as the container's own
database login: given as data, one statement a line, in the environment
variable WEB_SQL. For every statement it prints one line, "ok" (and the first
column of the first row, when there is one) or "error <SQLSTATE>". Run in the
web container, or in a one-off migrate container, by
.github/scripts/separate-roles-e2e.sh:

    docker compose exec -T --env "WEB_SQL=$statements" web \
        python manage.py shell --no-imports -v 0 -c "$(cat .github/scripts/sql_probe.py)"

The code is fixed and the statements never become part of it, so any quoting
in them reaches PostgreSQL as written. They are executed without parameters,
so a % in one is not a placeholder, and each in a transaction of its own
(Django's autocommit): a refusal leaves the next one unaffected.

The SQLSTATE, not the message, is what a test compares: messages differ
between PostgreSQL versions and languages, 42501 (insufficient_privilege) does
not.
"""

import os

from django.db import connection

for statement in os.environ["WEB_SQL"].splitlines():
    if not statement.strip():
        continue
    try:
        with connection.cursor() as cursor:
            cursor.execute(statement)
            row = cursor.fetchone() if cursor.description else None
    except Exception as exc:
        cause = exc.__cause__ or exc
        print("error", getattr(cause, "sqlstate", None) or type(exc).__name__)
    else:
        print("ok" if row is None else f"ok {row[0]}")
