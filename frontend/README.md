# SSphere Sentinel console (frontend)

The web console for SSphere Sentinel: a dark, terminal-inspired, NOC-style
dashboard. It is a standalone React app in this directory and is **independent
of the Django backend**.

> **Status: sign-in, scope, servers, containers, network targets, SNMP devices, alert incidents and the
> Overview counts are real; events are not served yet and show no figure.**
> The console signs in against the Django console API (session cookie and CSRF) and reads
> from it the customers and sites you may see, the Servers list (searched, filtered, sorted
> and paged by the server), the Docker inventory, each server with its containers and its CPU, RAM and disk
> history, the busiest servers by load, the containers of every visible server, and the network
> targets (ICMP and TCP probes) with their measurements and history, and the SNMP devices with
> their polls, interfaces, rates and history, and the incidents the alert engine opens, with the
> engine's own state, and, in Settings, the alert rules, your own email preferences and the
> system's status. The
> Overview is built from four of those lists, the worst first of each, and from the counts
> the API itself reports: the verdict, the tiles, the attention queue and the health by
> domain and site are servers, containers, probe targets and SNMP devices, nothing else. Those panels say
> `live` only because that is read from the API; a failed request is an error, never a stand-in.
> events have no console API, and neither does the Overview's fleet-wide latency chart (the API
> serves each target, not an aggregate): their panels and tiles carry a dashed frame, a `NOT CONNECTED` or `PLANNED`
> chip and one sentence saying why, and no number, chart or sample row. The built-in sample
> fleet exists only in a development run with `VITE_SENTINEL_API=mock` (servers and
> containers, marked `DEMO DATA`); a production bundle holds none of it.
> Eight screens are designed and built: **Overview**, **Servers**, **Docker** (every container of every
> visible server), **Network** (every probe target, with a page for each), **SNMP** (every device,
> with a page for each and the history of each of its interfaces), **Topology**, **Alerts** (every incident,
> with a page for each and an Acknowledge action) and **Settings** (Notifications, Alert rules, System);
> lists are searched, filtered, sorted and paged by the server. **Customers & Sites** is routed and shows
> an honest "not designed yet" placeholder. The Overview's queue and sites are built from the worst rows
> the API returns; where more exist than those rows hold, they say so, and the domain counts stay the API's
> whole-fleet counts.

## Quick start

Requires Node 22.12 or newer and a running Django backend (see below).

```bash
cd frontend
npm install
npm run dev        # http://localhost:5173, sign-in required
```

```bash
npm run check      # lint + typecheck + tests + production build
npm test           # unit and component tests only
npm run lint       # Oxlint (React, hooks, jsx-a11y, TypeScript)
npm run format     # Prettier
```

`npm install` runs with `ignore-scripts=true` (see `.npmrc`): no dependency
install script ever executes.

## Running against the backend

The dev server proxies `/api` to Django, so the browser only ever talks to
`http://localhost:5173`: there is no CORS setup and the session and CSRF cookies
belong to one origin.

1. Run Django (default `http://127.0.0.1:8000`; set `SENTINEL_BACKEND_URL` for
   another address when you start `npm run dev`).
2. Allow cookies over plain HTTP for local work. Django marks the session and
   CSRF cookies `Secure` unless `DJANGO_DEBUG=true`, and a browser does not keep
   a `Secure` cookie from `http://`. Either run the backend with
   `DJANGO_DEBUG=true`, or set both of these (testing only, never in production):

   ```
   DJANGO_SESSION_COOKIE_SECURE=false
   DJANGO_CSRF_COOKIE_SECURE=false
   ```

   Safari is stricter than Chrome and Firefox about `localhost`; use a Chromium
   or Firefox browser, or HTTPS, if sign-in does not stick.

3. Create a user that may use the console: add it to the "Console viewers"
   group in the Django admin (or grant `console.use_console`). A user without
   that permission gets "No console access".
4. Open the dev server and sign in.

Do not point `DJANGO_ALLOWED_HOSTS` or `DJANGO_CSRF_TRUSTED_ORIGINS` at the dev
server for this: the proxy keeps the browser's `Host`, which `localhost` already
satisfies.

### Modes

| `VITE_SENTINEL_API` | What it does                                                                      |
| ------------------- | --------------------------------------------------------------------------------- |
| unset or `http`     | The console API: sign-in required. The default, in every build.                   |
| `mock`              | The built-in sample fleet, no sign-in and no backend. Development and tests only. |

A production build never runs in mock mode: `npm run build` fails when
`VITE_SENTINEL_API=mock`, and a bundle that is somehow served with it refuses to
start. A URL parameter (`?mock=`) only has an effect in mock mode. Put local
settings in `.env.local` (ignored by git).

## Sign-in and sessions

- Every route except `/login` needs a signed-in user. An anonymous visitor is sent
  to `/login?next=<page>` and brought back after signing in. `next` is only
  followed when it is a path inside the application: absolute URLs,
  protocol-relative URLs (`//host`), other schemes and backslash tricks are
  ignored.
- The session is the server's: the cookie is `HttpOnly` and never readable by the
  page, and nothing about the user is stored in the browser.
- Writes carry Django's CSRF token (`X-CSRFToken`), taken from the session
  answer; a token the server refuses is refreshed once.
- An expired session is noticed in two ways: any request that answers 401 and a
  once-a-minute check while the tab is visible. Either one ends the session on the
  screen and returns to `/login` with a note, then to the page the user was on.
- Signing out ends the session on the server and forgets the page.

## Settings and permissions

Settings has three sections, each offered only to an account that has something in it:

| Section       | What it does                                                                                                                          | Who is offered it                                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Notifications | Your own email preferences (on or off, minimum severity, recoveries), and a test email to your own address                            | Every signed-in user; the test email needs `alerts.send_test_email`                                                     |
| Alert rules   | Lists, creates, edits, enables and disables rules (a rule is never deleted here: an incident keeps its rule)                          | `alerts.view_alertrule` or `change_alertrule` to see, `add_` to create, `change_` to edit, and access to every customer |
| System        | The alert engine, the notifier, the email outbox and what the deployment sets (read-only; no password or other secret is ever served) | `console.view_system_status` and access to every customer                                                               |

The session answer carries these as `capabilities`. They only decide what the console offers: the
server checks every request again, and a refusal (403) is shown as one. In the sample fleet
(`VITE_SENTINEL_API=mock`) there are no accounts, so no capability is offered and no Settings
section shows a request. A rule that changes while it is open is never overwritten: the console
says it changed elsewhere and offers to load the latest version. A change that would end open
incidents (disabling a rule, a new condition, severity or scope) says so, from the API's own
`changeEffects`, before it is saved.

## Reviewing every state without a backend

In mock mode (`VITE_SENTINEL_API=mock`) the sample API has scenarios. Pick one with `?mock=<name>` in the URL or from the
command palette (`Ctrl/Cmd+K`, "Mock scenario"):

| Scenario           | What you see                                                          |
| ------------------ | --------------------------------------------------------------------- |
| `normal`           | The default story: an outage at one site, a full disk, a restart loop |
| `healthy`          | Everything healthy; the verdict reads NOMINAL                         |
| `partial`          | Nothing failing, but some things not reporting; verdict PARTIAL       |
| `stale`            | Data loads once, then updates fail: watch the stale guard engage      |
| `slow` / `loading` | A slow response / a response that never arrives                       |
| `empty`            | Nothing is monitored yet                                              |
| `error`            | Every request fails                                                   |

In development, `/_ds` is a gallery of every component in every state, with a
color-vision and grayscale simulator.

## Keyboard

`Ctrl/Cmd+K` opens the command palette; `?` lists every shortcut. `g` then
`o s d n p t a c e` jumps between screens (`g s` opens Servers), `1`–`6` focus a panel, `p` pauses live
updates, `r` refreshes. Single-key shortcuts can be turned off in the Display menu or, at any width, from the command palette.

## Documentation

| Document                                                 | Contents                                                                                                  |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| [`docs/architecture.md`](docs/architecture.md)           | Stack, folder structure, layering rules, data flow, sign-in, how the console API composes the Overview    |
| [`docs/design-system.md`](docs/design-system.md)         | Principles, palette, status alphabet, typography, geometry, components, meters, charts, incident timeline |
| [`docs/design-spec.md`](docs/design-spec.md)             | The full design spec with exact values and per-component behavior                                         |
| [`docs/data-requirements.md`](docs/data-requirements.md) | What the console needs from the backend for visualizations it does not draw yet                           |

## Connecting more of the backend

The sign-in, the scope options, the servers and the containers go through `src/api/http`, and
`src/app/consoleApi.ts` composes them into the whole `SentinelApi`. Each further backend
endpoint follows the same steps:

1. Add its request to `src/api/http`, validating the answer and mapping it onto
   the view-models in `src/api/types.ts`.
2. Add the matching method to `SentinelApi` and answer it in `createConsoleApi`. A feature the
   console API does not serve has no method: its screens show a statement, not a figure.
3. Set `connected: true` for the feature in `src/config/features.ts` once a screen reads it;
   its markers follow on their own.

No screen imports the mock or the HTTP layer, so none of them changes.

## Deployment

`npm run build` produces a static `dist/` directory. It is intentionally not
wired into the Docker image or CI yet. The bundle expects the console API on its
own origin (`/api/v1/console/`), served by the same host or a reverse proxy.
