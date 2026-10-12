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
- SNMP credentials are never stored on the server: devices hold only the name
  of a credential profile kept in the agent's local files, no model or form has
  a field for a community string or key, and unknown payload fields are
  ignored ([snmp.md](snmp.md#credentials-are-never-stored)).
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

### SNMP credentials

SNMP monitoring ([snmp.md](snmp.md)) is the one place where the agent holds
credentials for *other* systems: community strings and SNMPv3 keys.

- They live only in the agent's credentials file, which Sentinel never reads or
  stores. The server's device settings hold the profile *name* and nothing else.
- The agent refuses a credentials file that is a symlink, is owned by another
  user, is accessible to other users or is writable by group or others, and
  names the problem without printing any content. Recommended: `root:sentinel-agent`,
  mode `0640`.
- A secret is never queued, logged or sent: the queue and the heartbeat carry a
  fixed whitelist of poll fields, error messages repeat only the key and the rule,
  and library messages are scrubbed of every secret first.
- SNMPv1, MD5 authentication and DES privacy are refused. SNMPv3 with SHA-2
  authentication and AES privacy is the recommended setup; SNMPv2c sends its
  community in clear text, and the agent warns about it (and about the default
  communities, authentication without privacy and SHA-1) at every start.
- The agent polls only the devices in its own local file, so the server cannot
  make it contact an arbitrary address. SNMP is read-only: the agent never sends
  SET requests.
- The SNMP library is an optional dependency (`[snmp]`); an agent without it
  carries none of this code path's dependencies.

### Unprivileged ICMP

ICMP probes run the system `ping` inside the same sandbox, so `ping` gets no
capability either: its `CAP_NET_RAW` file capability (Debian, Ubuntu) is not
applied under `NoNewPrivileges=yes` and the empty bounding set. It uses the
kernel's unprivileged ICMP echo sockets instead, which the deployment allows
for the `sentinel-agent` group only (`net.ipv4.ping_group_range = <gid> <gid>`,
written by `deploy/systemd/enable-unprivileged-icmp.sh`).

What a process in that group can do with it (Linux "ping sockets",
`socket(AF_INET[6], SOCK_DGRAM, IPPROTO_ICMP[V6])`):

- send ICMP/ICMPv6 **echo requests** to any destination, and receive the echo
  replies (and related ICMP errors) for its own socket;
- nothing else: the kernel rejects every other ICMP message type, builds the
  IP header itself (only local source addresses, no spoofing), ties the echo
  identifier to the socket like a port, and delivers only the replies that
  match it. It cannot capture other traffic or craft arbitrary packets.

Compared with `CAP_NET_RAW`, which would also allow raw IP sockets (arbitrary
packets, spoofed sources, receiving copies of other ICMP traffic) for the
whole agent process, this is strictly narrower. Remaining implications:

- The setting is host-wide (per network namespace): any process running with
  the `sentinel-agent` group gets it, not only the service. The account has
  no login shell, and nothing else should run with that group.
- It exposes the kernel's ping-socket code to that group. Many distributions
  enable it for all groups by default; the deployment enables it for one.
- A compromised agent could send ICMP echo traffic, as it can already send
  TCP and UDP traffic.

If `ping_group_range` already allows the group (for example a distribution
that allows all groups), the helper changes nothing. The agent never needs
root or `CAP_NET_RAW`: do not add capabilities to the unit to make ICMP work.

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
- The agent's local queue stores measurement results and SNMP polls (not
  credentials) in plain SQLite, readable by root and the service account.
- The SNMP credentials file is readable by the service account (and root), so a
  compromise of the agent exposes the SNMP credentials of the devices it polls.
  Use read-only SNMP users with views limited to IF-MIB and SNMPv2-MIB, and
  per-agent credentials, so that one leak does not expose every device.
- Database backups contain password and token hashes and all monitoring
  data; protect and encrypt them.
- The container image is not signed and no SBOM is published.
