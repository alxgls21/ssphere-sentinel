# SSphere Sentinel console (frontend)

The web console for SSphere Sentinel: a dark, terminal-inspired, NOC-style
dashboard. It is a standalone React app in this directory and is **independent
of the Django backend**.

> **Status: sign-in and scope are real; the screens still show demo data.**
> The console signs in against the Django console API (session cookie and CSRF)
> and reads the customers and sites you may see from it. Every other number on
> screen is built-in sample data, marked `DEMO DATA` (a strip above the screen, a
> chip in the top bar, per-panel `mock` tags) and never filtered by your real
> customers. A dashed `PLANNED` frame marks anything the backend does not
> implement yet.
> Two screens are designed and built: **Overview** and **Servers**. The other six
> are routed and show an honest "not designed yet" placeholder.

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
`o s d n p t a c` jumps between screens (`g s` opens Servers), `1`–`6` focus a panel, `p` pauses live
updates, `r` refreshes. Single-key shortcuts can be turned off in the Display menu or, at any width, from the command palette.

## Documentation

| Document                                         | Contents                                                                                    |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| [`docs/architecture.md`](docs/architecture.md)   | Stack, folder structure, layering rules, data flow, sign-in, how the API replaces demo data |
| [`docs/design-system.md`](docs/design-system.md) | Principles, palette, status alphabet, typography, geometry, components                      |
| [`docs/design-spec.md`](docs/design-spec.md)     | The full design spec with exact values and per-component behavior                           |

## Connecting more of the backend

The sign-in and the scope options already go through `src/api/http`. Each further
backend endpoint follows the same steps:

1. Add its request to `src/api/http`, validating the answer and mapping it onto
   the view-models in `src/api/types.ts`.
2. Move the matching method of `SentinelApi` from the demo side to the real side
   in `src/api/demo.ts` (`composeDemoApi`).
3. Update `src/config/features.ts`; the demo and `PLANNED` markers of that
   feature disappear on their own.

No screen imports the mock or the HTTP layer, so none of them changes.

## Deployment

`npm run build` produces a static `dist/` directory. It is intentionally not
wired into the Docker image or CI yet. The bundle expects the console API on its
own origin (`/api/v1/console/`), served by the same host or a reverse proxy.
