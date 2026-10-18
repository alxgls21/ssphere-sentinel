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

## Console authentication and access control

The web console reads data through `/api/v1/console/`. It shares nothing with
the agent API: agents authenticate with bearer tokens (`apps/agents`), the
console with Django sessions (`apps/console`), and neither accepts the other's
credential. The console never reads the `Authorization` header, an agent token
does not sign anyone in, and a console session is not accepted by the heartbeat
endpoint (tests cover both directions). Besides sign-in and sign-out, the
console writes only what a permission allows (below), and every write needs
the CSRF token.

- **Deny by default.** A user needs the permission *Can sign in to the
  monitoring console* (`console.use_console`, in the default groups *Console
  viewers …*). Without `view_all_customers` they see only the customers and
  sites granted to them (**Console → Customer access** / **Site access**). An
  object that belongs to no site is visible only to `view_all_customers` users
  and superusers. Servers and network targets have a nullable `site`; the
  migration that added it left every existing row without one, so they are
  hidden from restricted users until an administrator assigns a site (the
  free-text `customer_name` of a network target is display text and never
  grants access). In the admin, anyone who may view servers or network targets
  also sees the names of their customers and sites (list column, filter
  sidebar, form): delegate those permissions only to operators who may see
  every customer.
- **Isolation is part of the database query.** Every console queryset is
  filtered through `apps/console/access.py`: the user's visible sites are read
  from the grants once per request (a small query on the site table) and the
  data query is restricted with `WHERE site_id IN (<those sites>)` (a subquery
  instead of a list for users who see more than 2000 sites; a user who sees no
  site never queries the data table). Rows a user may not see are never
  selected, counted or serialized. A requested `customer` or `site` that is not visible is answered
  exactly like one that does not exist (404), so ids cannot be probed. Grants
  are read at every request, so revoking one applies immediately.
- **Sessions.** Server-side Django sessions in an HttpOnly, `SameSite=Lax`
  cookie (Secure unless `DJANGO_DEBUG`). Only a session created by the
  console's own sign-in is a console session: it carries a marker with the
  sign-in time, and a session from anywhere else (the admin login, with its
  14-day default lifetime and no throttle) is anonymous to the console. The
  session starts empty and gets a new id at sign-in; it ends after
  `SENTINEL_CONSOLE_SESSION_SECONDS` (12 hours by default, no sliding renewal;
  the console also checks the marker's age, so a longer-lived cookie cannot
  extend it); changing the password ends every session of that user. Expired
  sessions stay in the database until `manage.py clearsessions` runs (schedule
  it with the other cleanup jobs, see the README). `POST`s require the CSRF
  token that `/session/` returns. Responses are `Cache-Control: no-store` and
  `Vary: Cookie`. Errors raised in a console view, including unexpected
  exceptions, are JSON without internal details (a hidden or unknown object is
  404, not 500); the few responses Django's middleware produces before a view
  runs (a rejected `Host` header, an HTTPS redirect) are Django's own.
- **Sign-in throttling.** Failed sign-ins are counted per account (5 by
  default, then a 15 minute lock), *before* the password is checked, so
  parallel guesses cannot exceed the limit. Names that do not exist share a
  fixed set of buckets, so the table cannot be filled with random names. A
  locked account is **not** answered differently: its password is hashed (the
  same work as for an unknown name) but never compared with the stored hash,
  which could be timed, and a wrong password, an unknown user, an inactive account, an
  account without console access and a locked account all get the same `401`
  with the same text and, as far as it can be controlled, the same timing.
  Anything else (a `429`, a quicker reply) would reveal which names exist,
  since locked buckets of unknown names are shared. The price: a locked user
  sees the ordinary failure message (it also mentions the lock) and, because
  every attempt still costs a password hash, the throttle limits guessing but
  not the server's CPU: use front-end rate limiting. Logs identify accounts by
  id, never by the name or the password that was typed; text that cannot be a
  name or password (NUL characters, invalid UTF-8) is a `400` that is not
  counted.
- **Administration is by permission, checked on the server.** Acknowledging
  incidents needs `alerts.acknowledge_incident`. Alert rules need the model
  permissions (`alerts.view_alertrule`, `add_alertrule`, `change_alertrule`)
  *and* `view_all_customers`, because a rule may concern every customer and the
  list names customers and sites; a restricted user is refused whatever their
  permissions. Rules are never deleted from the console, only disabled. A change
  carries the `version` the client read and is refused (`409`) if the rule has
  changed since, in the console or the admin. Every user manages their own email
  preferences only (the address is the account's, set by an administrator). A
  test email (`alerts.send_test_email`) goes to the user's own address only, at
  most one a minute and one at a time; the web process queues it and the
  notifier sends it, so the SMTP password never reaches the web process. The
  system status (`console.view_system_status`, also with
  `view_all_customers`, since its counts concern every customer) shows settings
  the environment sets, never a password or the SMTP user name. No group is
  given these permissions automatically. Changes of rules and subscriptions
  (from the console or the admin) and test-email requests are recorded, with the
  account and its name at the time, in the append-only *Configuration changes*
  trail (read-only in the admin; the database login could still alter it). A
  subscription removed with its account is recorded without an actor: the
  account's deletion is in the admin's own history. A save in the admin has no
  version check: it is the last word over a change made since the form was
  opened, and the trail records what it changed.
- **Domains are verified before anything is monitored, by permission too.**
  Adding a domain (`web.add_monitoreddomain`), seeing domains
  (`web.view_monitoreddomain`) and asking for a verification
  (`web.verify_monitoreddomain`) all need `view_all_customers` as well; a
  restricted user is refused whatever their permissions. A domain is kept in
  one canonical form (IDNA2008 A-labels, lowercase), once per customer; public
  suffixes, IP addresses and names of local use are refused. Each customer's
  token is its own (256 random bits), shown only in the domain's detail, and
  is public DNS material, not a credential: it is never in the trail or the
  logs. The web process only queues a verification; the `domain-verifier`
  service asks the container's resolver only where public suffixes are served,
  then follows the delegations from there itself and asks the domain's own
  name servers the TXT question of the record name, or of the names its
  aliases point to (never one with no public DNS). It never sends anything to
  an address that is not public, nor looks up a name server whose name has no
  public DNS, so a domain cannot make it query an internal network. A request
  takes no options (no server, no name, no type), and is bounded: one at a
  time per domain, one per 10 seconds per domain, 20 per user in 10 minutes,
  200 waiting in all, a 30-second deadline and a fixed number of questions.
  Only authoritative answers count; a delegation is followed only when most of
  the servers asked give the very same one (no server alone chooses who is
  asked next); more than half of the domain's name servers (the names its
  parent delegates to, each counted once however many addresses it has) must
  answer and agree; and a failure is never taken for absence. So one name
  server that is not the owner's to run (a lame delegation someone else has
  taken over) cannot verify a domain by its own answers; whoever runs more
  than half of its name servers while the others are silent, or its DNS
  account, can. The name servers' addresses are found the same way, never from
  the resolver: those (glue) more than half of the servers asked give with a
  delegation, or those the name server's own zone gives, more than half of its
  servers answering and agreeing (at most three lookups deep); a name server
  whose address cannot be found that way is not asked, and too few answering
  is never verified. So a taken-over server that also serves the zone of the
  domain's other name servers' names (`example.net` for `ns1.example.net`)
  cannot point them to itself either. Servers are counted by name: two names
  under one lapsed domain (`ns1` and `ns2` of a name server domain that
  expired) are two votes for whoever registers it. What this does not cover:
  whoever controls more than half of the names of any zone on the way (the
  domain's, its name servers', or a public suffix's), the registries, the
  operators of private suffixes (`github.io` and the like, from the Public
  Suffix List's PRIVATE section) and the resolver's view of where public
  suffixes are served, a shared DNS provider whose servers answer from a zone
  another of its customers created under the domain, an attacker on the path
  between Sentinel and the name servers (there is no DNSSEC validation), and a
  domain whose DNS account is someone else's. It does not make a domain's DNS
  secure; it makes one server's word not enough. The admin shows domains and
  verifications read-only to staff with the view permissions, of every
  customer, as it does servers.
- **Nothing sensitive is returned**: no password hashes, agent tokens, SNMP
  credential profiles or secret settings; the session payload has the user
  name, display name, the access flags and what the account may administer. The server and container endpoints
  read an explicit list of columns, never whole model rows, so an agent's token
  hash is never even loaded (the agent's version is the one agent column read).
- **Lists are bounded.** Every list is paginated by the server (at most 200
  rows a page, and a page number cap), accepts only the documented parameters,
  and rejects anything else with a `400` that does not repeat the input.
  Counts and totals describe only what the user may see.

Whoever can edit *Customer access*, *Site access*, a user's permissions or
groups, or a group's permissions in the admin can give any account (their own
included) access to any customer: treat those permissions as "may see
everything". Operational notes:
create console users in the admin (they need no staff access); the throttle is per account because the client address is not
trustworthy behind a proxy (see above), so it cannot be bypassed by rotating
addresses but can be used to lock a known account out for the lockout period
(unlock it under **Console → Login throttles**). Put the console behind the same
front-end protections as the admin (Cloudflare Access or WAF rate limiting) if
it is exposed to the internet.

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

- Console accounts have passwords only: no second factor, and no audit log of
  what a console user read. Lock-outs are per account (see above).
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
