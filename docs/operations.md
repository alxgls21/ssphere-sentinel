# Operations: secret rotation and troubleshooting

Commands assume the Docker Compose deployment in `/opt/ssphere-sentinel`
([server-deployment.md](server-deployment.md)). After editing `.env`, apply it
with `docker compose up -d` (it recreates the containers whose configuration
changed).

## Secret rotation

| Secret | Effect of rotating | Procedure |
| --- | --- | --- |
| `DJANGO_SECRET_KEY` | Admin sessions end (log in again). Agent tokens are not affected: they use `AGENT_TOKEN_PEPPER`. | New value in `.env`, `docker compose up -d`. |
| Agent token (one agent) | That agent is rejected until reconfigured; its measurements stay queued. | Admin action **Regenerate authentication token**, then update the agent ([agent-deployment.md](agent-deployment.md#token-rotation)). |
| `AGENT_TOKEN_PEPPER` | **Every** agent token stops working. | See below. |
| `POSTGRES_PASSWORD` | The application loses database access until both sides match. | See below. |
| Cloudflare Tunnel token | The tunnel reconnects with the new token. | Refresh the token in the Zero Trust dashboard, update `.env.tunnel`, `docker compose -f compose.yml -f compose.tunnel.yml up -d`. |
| Admin passwords | — | `docker compose exec web python manage.py changepassword <user>` |

Generate secrets with
`python3 -c 'import secrets; print(secrets.token_urlsafe(50))'`.

### AGENT_TOKEN_PEPPER

Only rotate it if it may have leaked together with the database (token hashes
alone do not let anyone authenticate). Plan a window:

1. Set the new `AGENT_TOKEN_PEPPER` in `.env` and run `docker compose up -d`.
2. For every agent, run **Regenerate authentication token** in the admin and
   update that host's `agent.env`, then restart its agent.

Agents keep queueing network measurements while they are rejected (up to
7 days by default) and deliver them once updated.

### POSTGRES_PASSWORD

The PostgreSQL image only reads `POSTGRES_PASSWORD` when it creates a new data
volume, so changing `.env` alone does not change the database password.
Change the role's password first, interactively so it does not end up in the
shell history:

```bash
docker compose exec db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
# at the psql prompt:
#   \password <POSTGRES_USER, default sentinel>
#   \q
```

Then put the same value in `.env` and run `docker compose up -d`.

## Troubleshooting

### Server

| Symptom | Cause and fix |
| --- | --- |
| `web` keeps restarting, log says `DJANGO_SECRET_KEY still has the .env.example placeholder value` | Set real secrets in `.env` (or `DJANGO_DEBUG=true` for local development only). |
| `RuntimeError: Environment variable ... must be true or false` | A boolean setting has a typo; values are `true`/`false` (also `1/0`, `yes/no`, `on/off`). |
| `web` is `unhealthy` | `curl -s http://127.0.0.1:8000/health/ready/`: `503` means the database is unreachable; `docker compose logs web` shows `Readiness check failed: ...` with the reason. |
| `entrypoint: database unavailable` | `db` is not healthy, or `POSTGRES_PASSWORD` in `.env` no longer matches the database (see above). |
| `Bad Request (400)` in the browser | The host name is not in `DJANGO_ALLOWED_HOSTS`. The log shows `WARNING django.security.DisallowedHost: Invalid HTTP_HOST header: ...`. |
| `CSRF verification failed` at admin login | `DJANGO_CSRF_TRUSTED_ORIGINS` must list the exact origin, e.g. `https://sentinel.example.com`. Over plain `http://` (testing), also set the two `*_COOKIE_SECURE` settings to `false`. |
| Admin login form reloads without an error | Secure cookies over `http://`: use HTTPS (or see the previous row). |
| Too many redirects | `DJANGO_SECURE_SSL_REDIRECT=true` while Gunicorn does not trust the proxy's `X-Forwarded-Proto` (`FORWARDED_ALLOW_IPS`). Turn it off and let the proxy or Cloudflare redirect, or trust the proxy ([security.md](security.md#trusted-reverse-proxy-boundary)). |
| Admin pages without styles | Native installs: run `python manage.py collectstatic`. Images built by the Dockerfile include them. |
| Agents get HTTP 403 behind Cloudflare | A Cloudflare WAF, bot or Access rule; exempt `/api/v1/agent/` ([server-deployment.md](server-deployment.md#option-a-cloudflare-tunnel)). |
| A server is `online` but its health is `unknown` and it is not ranked by CPU, memory or disk | Its last resource reading is older than `SENTINEL_OFFLINE_THRESHOLD`: heartbeats arrive without usable telemetry. The agent's log says `Telemetry collection failed` (nothing was sent) or the heartbeat answer says `"telemetry": "rejected"` with a `detail`. The last reading is still shown, flagged `stale`. It becomes current again with the next accepted report. |
| `purge_absent_docker_containers` says `Deferred to a later run: ... server(s)` | The cleanup could not lock those servers' Docker host state, so what is left of their absent containers waits for a later run (batches the run had already completed for a server stay deleted). `its Docker host state stayed locked past the timeout`: another transaction held the lock for more than five seconds, a Docker report or another cleanup run for instance; run the cleanup again (the next scheduled run does). `it has no Docker host state to lock`: the server never reported Docker, or its host state was deleted in the admin; its absent containers are removed by the first run after a Docker report creates the host state, or delete them in the admin. |
| The agent logs `Sentinel rejected docker: report is not newer than the inventory already stored`; a host's containers read `unknown` | The Docker report is not newer than the stored one: normal for an occasional overlapping heartbeat, but repeated rejections may indicate that the agent's clock stepped back. Fix the host's clock (NTP): the inventory resumes when the clock passes the stored time, or after five minutes without an applied report if the clock is within five minutes of the server's. A larger rollback is not recovered by time (a timestamp cannot tell it from a replay): delete the server's Docker host state in the admin so that the next report applies ([README](../README.md#docker-discovery-v01-optional)). |
| Empty database after an upgrade | The Compose project or volume name changed (a different directory name, or `docker compose down --volumes`). The old volume still exists: `docker volume ls`. Restore from it or from a backup. |
| `db` exits, log says `... holds no database and creating one is not authorized` | The PostgreSQL 18 data directory is empty. New installation, or restoring a dump into a new volume: add `SENTINEL_POSTGRES_INITIALIZE=true` to `.env` for that start. Existing installation: **do not authorize it**; the wrong volume is mounted. Run `scripts/postgres-preflight.sh` ([server-deployment.md](server-deployment.md#preflight-check)). |
| `scripts/postgres-preflight.sh` says `REFUSED` or `AMBIGUOUS` | `SENTINEL_POSTGRES` does not match the database volumes Docker has. The message names the way forward; [server-deployment.md](server-deployment.md#preflight-check) explains each case. |
| `db` keeps restarting, log says `in 18+, these Docker images are configured to store database data in a format ...` | The PostgreSQL 18 image was pointed at a PostgreSQL 16 volume (`SENTINEL_POSTGRES` in `.env` does not match the volume). Nothing was changed in the volume. Restore the previous `.env` (see [server-deployment.md](server-deployment.md#postgresql-versions)). |
| Data from before a PostgreSQL 18 migration is back | The `SENTINEL_POSTGRES=18` line was removed from `.env`, so `db` runs on the old PostgreSQL 16 volume again. Put it back ([server-deployment.md](server-deployment.md#moving-an-existing-installation-to-postgresql-18)). |

### Agents

See the troubleshooting table in [agent-deployment.md](agent-deployment.md#troubleshooting).
In the admin, a server whose **Effective status** is `offline` has not sent a
heartbeat within `SENTINEL_OFFLINE_THRESHOLD` seconds (default 90).
