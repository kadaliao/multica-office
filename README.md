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

Open `http://127.0.0.1:4317/`. The release process serves the built client and API from the same loopback origin. `http://127.0.0.1:4317/healthz` reports process liveness, not CLI data availability. Set `OFFICE_BRIDGE_PORT` to choose another fixed port. The process rejects non-loopback-style Host headers and always binds to `127.0.0.1`; use the same numeric host in client URLs.

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

## Navigating the Office

On desktop, scroll the office floor and the right-hand details/roster panel independently to reach every agent. On narrow screens, swipe within the floor to reach more seats and scroll the page to reach the full roster.

Select an agent, enter an **Office nickname** in its details, and choose **Save**. The nickname appears on the seat, roster, and selected-agent heading; **Reset** restores the original display name. Nicknames allow up to 24 characters and are saved only in this browser for the current site address. They do not sync between devices or rename agents in Multica. If browser storage is unavailable, they apply only until the page is closed or reloaded.

Without a nickname, seat labels shorten structured names such as `Product Engineer - Codex - Mac mini` to `Codex · Mac mini`. Labels that still do not fit use a middle ellipsis to retain both ends. Full Multica names remain available in agent details and the roster; roster names wrap instead of hiding their suffixes.

## Private Tailnet Access

Tailnet access is an explicit release-only mode. It keeps the bridge on `127.0.0.1` and asks the local Tailscale daemon to terminate HTTPS on a separate Tailnet-only port and reverse proxy to the bridge. It never enables Tailscale Funnel and refuses to start if its selected Serve or Funnel port is already configured.

Prerequisites:

- Tailscale is online on this Mac and the client device.
- MagicDNS and HTTPS certificates are enabled for the tailnet.
- The tailnet ACL or grants policy permits only the intended users/devices to reach this Mac on TCP 8443 (or the chosen `OFFICE_TAILNET_HTTPS_PORT`). Tailscale's default allow-all policy is broader than recommended for this service.
- `npm run build` has completed. On macOS, the script finds the application CLI automatically; elsewhere set `TAILSCALE_BIN` to an absolute executable path.
- Start from a regular terminal with a persistent Multica CLI login. Agent task credentials expire when the task ends and cannot sustain a background Office service; `start:tailnet` refuses that context before changing Serve configuration. Never copy task credentials or an owner's token into a startup file.

A daemon-managed checkout can remain task-scoped even in another terminal because of its workdir marker. A host operator must use a separate, non-managed Office installation for the persistent service. Do not delete the marker, strip task context, or read saved owner credentials to work around this boundary.

For a checkout prepared by an agent, the host operator can install the already-built application from a **regular terminal outside that checkout**:

```bash
cd ~
MULTICA_BIN="$(command -v multica)" node /path/to/multica-office/scripts/host-start.mjs "$HOME/multica-office-host" --replace-running
```

This operator-only helper checks the current CLI's core data access, copies an explicit allowlist of built files into a new directory, installs locked production dependencies with lifecycle scripts disabled, and runs the existing Tailnet launcher there. It does not copy task markers, environments, credentials, logs, or source files, and refuses to overwrite an existing installation. If needed, run `multica login` in that regular terminal first. To select a specific workspace, set `MULTICA_WORKSPACE_ID` on the command.

`--replace-running` explicitly replaces the old Office launcher recorded by the source checkout. It checks the exact Node command and working directory before signaling that PID, then uses the existing ownership-checked route cleanup; it never kills a Multica daemon or clears unrelated Serve configuration. Without that flag, no previous process is stopped. Keep the terminal open while using Office; this is a foreground host service, not a login-item or restart supervisor. To restart an existing installation, run `npm run start:tailnet` there with `MULTICA_BIN` set, rather than rerunning the installer.

If replacement times out after dependency installation, the new installation remains intact. Once the verified old Office process has stopped and its route has been cleaned up, start from the existing installation directory with `MULTICA_BIN` (and the same `MULTICA_WORKSPACE_ID`, if supplied) set and run `npm run start:tailnet`. Do not rerun the new-directory installer or delete the installed files. During normal shutdown the bridge closes SSE streams in `preClose`, so an open browser does not prevent the process from exiting.

Start the foreground service:

```bash
MULTICA_BIN="$(command -v multica)" npm run start:tailnet
```

The command prints the exact `https://<device>.<tailnet>.ts.net:8443/` URL after the loopback health check, core CLI data reads, and Serve configuration succeed. It also records only controlled lifecycle messages in `.multica/office-tailnet.log`. In a second terminal on the Mac, verify the installed route, HTTPS health, and core data sources with:

```bash
npm run tailnet:status
```

Then open the printed URL in a browser on an authorized second Tailnet device and verify that the page reaches the live state. `/healthz`, `/v1/snapshot`, and `/v1/events` can be checked at the same origin; the event endpoint stays open and emits `snapshot` plus heartbeat frames.

Press Ctrl-C to stop the bridge; the wrapper also attempts to remove only the Serve port it installed. Then run the idempotent `npm run tailnet:cleanup` to confirm removal, and use the same cleanup command after a crash or forced termination. Cleanup refuses to touch a route whose exact target no longer matches its recorded state. To avoid an existing port without changing it, choose another explicit startup port, for example `OFFICE_TAILNET_HTTPS_PORT=9443`.

Tailnet requests must use the exact HTTPS Host and Origin and must arrive from the loopback Tailscale proxy with `Tailscale-User-Login`. Tailscale Serve strips client-supplied identity headers before injecting verified member identity; Funnel requests and tagged-node requests do not receive that header and are rejected. Forwarded Host/Origin headers are never trusted. Same-origin page, snapshot, and SSE traffic needs no CORS response, and the CSP keeps `connect-src 'self'` for reconnects.

This mode relies on Tailscale's device security, control-plane policy, HTTPS termination, and identity-header behavior. It is not an independent application login. A process running as the same local user remains inside the trusted local boundary and can already access the loopback API. Do not enable Funnel, expose the bridge port on a LAN/container, or weaken the ACL/grants rule. If setup fails, the wrapper stops the bridge and removes only a route it verified as its own.

If startup reports that a port is already configured, it has made no Serve change; select an unused port instead of resetting existing Tailscale configuration. A 403 at the Tailnet URL usually means the exact Host/Origin did not match or the request had no member identity (for example, a tagged device or Funnel request). A health-check failure after an interrupted run means the bridge stopped before the Serve route was cleaned up; run `npm run tailnet:cleanup`. The workflow follows Tailscale's official [Serve behavior](https://tailscale.com/docs/features/tailscale-serve) and [CLI reference](https://tailscale.com/docs/reference/tailscale-cli/serve).

## API

- `GET /healthz` returns bridge process liveness, schema version, and current sequence; check snapshot source states for data availability.
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

When agent or runtime reads fail, the bridge retains last-known agent states and marks the source stale/error. The client shows **Office data is unavailable** with the last successful observation time instead of presenting expired heartbeats as confirmed offline agents. Partial issue/run failures show **Data stale** rather than Live. `/healthz` is process liveness only; `npm run tailnet:status` also checks source availability.

## Security Limits

- The bridge reads CLI output only. It does not read CLI token/config files or return credentials.
- Child environments retain only `HOME`, `LANG`, and `TMPDIR`, fixed locale/color settings, and an existing Multica authentication context (`MULTICA_SERVER_URL`, workspace ID, task ID, and task-scoped token). The bridge never reads token/config files and never logs or returns these values.
- The API always binds only to `127.0.0.1`, enforces exact Host/Origin values, applies a restrictive CSP, and has no arbitrary process surface. Default mode accepts only its numeric loopback origin. Explicit Tailnet mode additionally accepts one generated MagicDNS HTTPS origin through the verified local Tailscale proxy path.
- `MULTICA_BIN` must be an absolute executable path. Symlinks are resolved and executable access is checked before startup.
- The default local boundary is not authentication. Do not expose it through an arbitrary reverse proxy, tunnel, container port publication, or LAN bind. The only supported remote path is the opt-in Tailscale Serve workflow above.

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
