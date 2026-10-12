"""Gunicorn settings for the Sentinel server.

Loaded automatically when Gunicorn starts from the repository root (as in
the Docker image). Command-line options override these values.

Not set here on purpose:
- ``forwarded_allow_ips``: Gunicorn reads FORWARDED_ALLOW_IPS from the
  environment (default ``127.0.0.1,::1``). Only those peers may set the
  request scheme with X-Forwarded-Proto. See docs/security.md.
- ``bind``: given on the command line (``--bind 0.0.0.0:8000`` in Docker).
"""

import os

# Sync workers; agents send small requests every heartbeat interval.
# Gunicorn's own default for WEB_CONCURRENCY is 1, which lets one slow
# request block every agent.
workers = int(os.environ.get("WEB_CONCURRENCY", "2"))
timeout = 30
graceful_timeout = 30
keepalive = 5

# Worker heartbeat files on tmpfs (also works with a read-only root filesystem).
if os.path.isdir("/dev/shm"):
    worker_tmp_dir = "/dev/shm"

# Logs go to stderr for Docker/journald. Access logging is off by default (one
# line per agent heartbeat); enable it, or more verbose logs, with for example
# GUNICORN_CMD_ARGS="--access-logfile - --log-level debug". Request lines never
# contain the agent token: it is only sent in the Authorization header.
errorlog = "-"

# Gunicorn 25.1+ opens a management socket in $HOME by default; it is not
# needed here and would only add an attack surface.
control_socket_disable = True
