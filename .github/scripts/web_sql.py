"""One SQL statement, given as data in the environment variable WEB_SQL, run
with the application's own database connection; prints the first column of
the first row. Run in the web container by .github/scripts/separate-roles-e2e.sh:

    docker compose exec -T --env "WEB_SQL=$statement" web \
        python manage.py shell --no-imports -v 0 -c "$(cat .github/scripts/web_sql.py)"

The code is fixed and the statement never becomes part of it, so any quoting
in the statement reaches PostgreSQL as written. It is executed without
parameters, so a % in it is not a placeholder.
"""

import os

from django.db import connection

with connection.cursor() as cursor:
    cursor.execute(os.environ["WEB_SQL"])
    print(cursor.fetchone()[0])
