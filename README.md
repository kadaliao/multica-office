# Multica Office

Local-first companion application for visualizing a Multica workspace. It combines a normalized, loopback-only `office-bridge` with a responsive Pixi.js office client.

## Requirements

- Node.js 22 or newer
- An authenticated `multica` CLI
- npm

Install, build, and start the release application:

```bash
npm install
MULTICA_BIN="$(command -v multica)" npm run build
MULTICA_BIN="$(command -v multica)" npm start
```

Open `http://127.0.0.1:4317/`. The release process serves the built client and API from the same loopback origin. `http://127.0.0.1:4317/healthz` reports readiness. Set `OFFICE_BRIDGE_PORT` to choose another fixed port. The process rejects non-loopback-style Host headers and always binds to `127.0.0.1`; use the same numeric host in client URLs.

For development, start the bridge in one terminal:

```bash
MULTICA_BIN="$(command -v multica)" npm run dev:bridge
```

Start the Vite client in a second terminal:

```bash
npm run dev:web
```

Open `http://127.0.0.1:5173`. For UI development without a running bridge, append `?fixture=ready`; `empty`, `degraded`, `auth-required`, and `offline` fixtures cover the primary recovery states.

The Vite development server proxies API and SSE requests to the loopback bridge. For another separately served local client, set one exact origin, for example `OFFICE_DEV_ORIGIN=http://127.0.0.1:5173`. Production leaves CORS disabled. Wildcards, `Origin: null`, foreign origins, and credentialed cross-origin access are not supported.

## API

- `GET /healthz` returns bridge readiness, schema version, and current sequence.
- `GET /v1/snapshot` returns the latest cached `OfficeSnapshot`; it never launches a command on request.
- `GET /v1/events` streams normalized snapshots and diff events over SSE. The bridge allows four clients and sends a 15-second heartbeat.

There is deliberately no command, argv, request-body, or manual-refresh proxy endpoint. A UI refresh reads `/v1/snapshot`; the internal scheduler owns CLI refreshes.

## Data Sources

The bridge invokes these fixed commands with `execFile`, `shell: false`, and an absolute executable resolved once at startup:

```text
multica agent list --output json
multica runtime list --output json
multica issue list --limit 100 --offset <adapter-owned offset> --output json
multica issue runs <adapter-validated issue UUID> --output json
```

Issue pages are followed until `has_more` is false. Runs are requested only for non-terminal issues assigned directly to agents or to squads, with a bounded rotating set. Runner concurrency defaults to three, list commands time out after five seconds, run commands after three seconds, and stdout is capped at 2 MiB.

Adapters validate the CLI shape and rebuild allowlisted contract objects. They do not return raw Agent instructions/config/env, Runtime device metadata/headers, Issue descriptions/metadata/properties, or Run work directories/results/attribution. Raw stdout and stderr are never exposed by HTTP errors. Unknown enum values map to `unknown`; source failures retain last-good data and mark only that source stale/error.

Agent display state follows this priority:

```text
offline > working > blocked > queued > done > idle
```

The bridge polls every five seconds while an SSE client is connected and every 30 seconds when no client is present. Refresh cycles do not overlap, unchanged snapshots are deduplicated, and the most recent 100 normalized events are held only in memory. This is polling-based local state, not a transactional real-time API; event history and sequence reset when the bridge restarts, and multi-user/cloud access is not supported.

## Security Limits

- The bridge reads CLI output only. It does not read CLI token/config files or return credentials.
- Child environments retain only `HOME`, `LANG`, and `TMPDIR`, fixed locale/color settings, and an existing Multica authentication context (`MULTICA_SERVER_URL`, workspace ID, task ID, and task-scoped token). The bridge never reads token/config files and never logs or returns these values.
- The API binds only to `127.0.0.1`, enforces an exact Host header, applies a restrictive CSP, and has no arbitrary process surface.
- `MULTICA_BIN` must be an absolute executable path. Symlinks are resolved and executable access is checked before startup.
- This local boundary is not authentication. Do not expose it through a reverse proxy, tunnel, container port publication, or LAN bind.

## Validation

```bash
npm test
npm run typecheck
npm run build
npm run notices:check
npx playwright install chromium
npm run test:e2e
```

Playwright runs against the built release client served by the production bridge process. Tests cover adapter allowlisting and enum drift, state priority, fixed argv and invalid parameter rejection, timeout/output limits, authentication errors, partial-source last-good behavior, and Host/Origin/API restrictions.

`THIRD_PARTY_NOTICES.txt` is generated from the locked production dependency graph. `npm run build` verifies it is current and copies it into the built client as `apps/web/dist/THIRD_PARTY_NOTICES.txt`. After dependency updates, regenerate it with `npm run notices:generate` and review the diff.

The office artwork is drawn procedurally by this project and does not include LimeZu, The Office, or Munder Difflin assets.

## License

Multica Office is released under the MIT License. See `LICENSE`. Third-party software distributed with the application retains its original terms in `THIRD_PARTY_NOTICES.txt`.
