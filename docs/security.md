# Security model and limitations

## Trusted reverse proxy boundary

TLS is terminated in front of Gunicorn (Cloudflare Tunnel or a reverse proxy).
Between the front end and Gunicorn, traffic is plain HTTP, so the request's
original scheme is only known from the `X-Forwarded-Proto` header, which any
client can also send.

- **Django never reads `X-Forwarded-Proto` itself** (`SECURE_PROXY_SSL_HEADER`
  is not set, `USE_X_FORWARDED_HOST` is off).
- **Gunicorn** decides, per connection: it honours `X-Forwarded-Proto` (and
  `X-Forwarded-Ssl`/`X-Forwarded-Protocol`) only when the TCP peer is listed
  in `FORWARDED_ALLOW_IPS`. The default is `127.0.0.1,::1`, which inside the
  container means "no external proxy". Django sees the result as the request
  scheme.
- A client that reaches Gunicorn directly can therefore never make Django
  believe a plain-HTTP request was HTTPS (which would, for example, defeat
  `DJANGO_SECURE_SSL_REDIRECT`).

You only need to trust a proxy if **Django** should redirect to HTTPS
(`DJANGO_SECURE_SSL_REDIRECT`) or send HSTS (`DJANGO_SECURE_HSTS_SECONDS`;
Django only sends it on requests it considers secure). The recommended setups
in [server-deployment.md](server-deployment.md) let the front end do both and
need no trust at all; admin logins work through `DJANGO_CSRF_TRUSTED_ORIGINS`
and Secure cookies.

To trust a proxy anyway, set `FORWARDED_ALLOW_IPS` to the address Gunicorn
sees the proxy connect from (IP addresses or CIDR networks), and make sure the
proxy overwrites, rather than appends to, `X-Forwarded-Proto`. With Docker,
connections through a published port arrive from the Compose network's
gateway address (`docker network inspect <project>_default`), which also
covers every other local process using that port, so keep the port bound to
`127.0.0.1`. Use `*` only when nothing but the proxy can connect to Gunicorn
at all.

Health checks (`/health/`, `/health/ready/`) are answered before host
validation and HTTPS redirects so that probes by IP over plain HTTP work.
They return no configuration, version, host or error details.

## Agent authentication

- Tokens are 256-bit random values (`secrets.token_urlsafe(32)`). The server
  stores only an HMAC-SHA256 of each token, keyed with `AGENT_TOKEN_PEPPER`
  (kept outside the database). A database leak alone does not reveal usable
  tokens.
- A raw token exists in three places only: the one page or command output
  that displays it, the agent's environment file, and the `Authorization`
  header of agent requests.
- The admin shows a new token on a single page served with
  `Cache-Control: no-store`. It is never put in Django's messages framework
  (whose cookie is signed but not encrypted) or in the session. Adding an
  agent in the admin generates its token the same way.
- Regenerating requires the *change agent* permission and a confirmation
  step; each rotation is recorded in the admin history without the token.
- Agents send the token only in the `Authorization` header, never in URLs,
  and reject `SENTINEL_URL` values containing credentials. The agent does not
  follow HTTP redirects, so the token can never be forwarded to another host
  or downgraded to plain HTTP by a redirect.
- Error messages printed by the agent are redacted if they ever contain the
  token; `ping` runs with a minimal environment that does not include it.
- Unknown, disabled and malformed credentials all get the same `401`.

## Server hardening

- Container runs as UID 10001 with a read-only root filesystem, no Linux
  capabilities and `no-new-privileges`; only `/tmp` is writable (tmpfs).
- Dependencies are installed from `requirements/server.txt`: exact versions,
  verified by SHA-256 hash, wheels only.
- No secret is part of the image; they come from `.env` at runtime. The
  Cloudflare Tunnel token is in a separate `.env.tunnel` that only the
  `cloudflared` container reads.
- PostgreSQL is reachable only on the internal Compose network.
- With `DJANGO_DEBUG=false` (the default), session and CSRF cookies are
  Secure and HttpOnly (session), the example secret key is refused, and
  `manage.py check --deploy` flags a placeholder `AGENT_TOKEN_PEPPER`
  (`sentinel.W001`) or `DJANGO_ALLOWED_HOSTS=*` (`sentinel.W002`).
- Logs contain request paths and status codes, never request headers or
  bodies. Rejected `Host` headers are logged as one-line warnings.

## Agent host hardening

The systemd unit ([agent-deployment.md](agent-deployment.md)) runs the agent
as a dedicated system account without capabilities, with a read-only view of
the system (`ProtectSystem=strict`), no access to home directories, a private
`/tmp` and devices, a system call filter and resource limits. Only its state
directory (`/var/lib/ssphere-sentinel-agent`, mode `0700`) is writable. The
token file is root-only and read by systemd before privileges are dropped.

**Docker monitoring** requires access to the Docker API, which is
equivalent to root on that host. It is disabled by default; prefer the
read-only socket proxy described in the agent guide over adding the service
account to the `docker` group.

## Known limitations

- Agent tokens are bearer tokens: anyone who obtains one can send data as
  that agent until it is rotated. There is no mutual TLS or request signing,
  and no automatic token expiry.
- Rotation is immediate: there is no overlap period with two valid tokens.
  Heartbeats fail until the agent is reconfigured (measurements are queued).
- On the agent host, root and the service account can read the token
  (environment file, process environment).
- There is no built-in rate limiting or lockout for the heartbeat API or the
  admin login, and no built-in second factor for the admin. Use the front
  end for this (for example Cloudflare WAF rate limiting and Cloudflare
  Access on `/admin/`).
- Traffic between the TLS front end and Gunicorn, and between Gunicorn and
  PostgreSQL, is unencrypted on the host or Compose network.
- The agent trusts the system's CA certificates; there is no certificate
  pinning.
- The health endpoints are public and reveal whether the database is
  reachable.
- The agent's local queue stores measurement results (not credentials) in
  plain SQLite, readable by root and the service account.
- Database backups contain password and token hashes and all monitoring
  data; protect and encrypt them.
- The container image is not signed and no SBOM is published.
