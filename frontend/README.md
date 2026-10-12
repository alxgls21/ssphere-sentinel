# SSphere Sentinel console (frontend)

The web console for SSphere Sentinel: a dark, terminal-inspired, NOC-style
dashboard. It is a standalone React app in this directory and is **independent
of the Django backend**.

> **Status: design prototype on mock data.**
> The backend has no read API yet (only agent ingest), so every number you see
> is simulated and the UI says so (a `MOCK DATA` chip, per-panel `mock` tags,
> and a dashed `PLANNED` frame on anything the backend has not implemented:
> alerts, events, SNMP collection, topology, site links).
> Only the **Overview** screen is designed and built. The other seven screens
> are routed and show an honest "not designed yet" placeholder.

## Quick start

Requires Node 22.12 or newer.

```bash
cd frontend
npm install
npm run dev        # http://localhost:5173
```

```bash
npm run check      # lint + typecheck + tests + production build
npm test           # unit and component tests only
npm run lint       # Oxlint (React, hooks, jsx-a11y, TypeScript)
npm run format     # Prettier
```

`npm install` runs with `ignore-scripts=true` (see `.npmrc`): no dependency
install script ever executes.

## Reviewing every state without a backend

The mock API has scenarios. Pick one with `?mock=<name>` in the URL or from the
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
`o s d n p t a c` jumps between screens, `1`–`6` focus a panel, `p` pauses live
updates, `r` refreshes. Single-key shortcuts can be turned off in the Display menu or, at any width, from the command palette.

## Documentation

| Document                                         | Contents                                                                                 |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| [`docs/architecture.md`](docs/architecture.md)   | Stack, folder structure, layering rules, data flow, how mock data is swapped for the API |
| [`docs/design-system.md`](docs/design-system.md) | Principles, palette, status alphabet, typography, geometry, components                   |
| [`docs/design-spec.md`](docs/design-spec.md)     | The full design spec with exact values and per-component behavior                        |

## Connecting the real backend later

1. Implement `SentinelApi` (`src/api/client.ts`) with `fetch`, mapping the
   backend's payloads onto the view-models in `src/api/types.ts`.
2. Provide it in `src/app/providers.tsx` instead of `createMockApi`.
3. Update `src/config/features.ts` as backend capabilities land; the mock and
   `PLANNED` markers disappear per feature on their own.
4. Point the dev server at Django with a Vite `server.proxy` for `/api`.

No screen imports the mock, so none of them changes.

## Deployment

`npm run build` produces a static `dist/` directory. It is intentionally not
wired into the Docker image or CI yet.
