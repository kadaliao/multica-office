# Changelog

## 0.2.0 - 2026-09-08

- Add opt-in private Tailnet HTTPS access through Tailscale Serve while keeping the bridge loopback-only, with exact Host/Origin checks and verified proxy identity requirements.
- Add ownership-checked Tailnet startup, status, and cleanup commands, plus a regular-terminal installation handoff that rejects task-scoped authentication.
- Distinguish unavailable or stale CLI data from confirmed offline agents, and close active SSE streams during bridge shutdown.
- Fix desktop panel and mobile touch scrolling so every agent is reachable.
- Add browser-local Office nicknames, compact model/device seat labels, and full-name wrapping in the roster without renaming Multica agents.
- Fix high-density canvas layout so the final station, avatar, and name remain visible and selectable after scrolling or resizing.
- Expand regression coverage for access restrictions, startup/shutdown, stale-data recovery, nicknames, scrolling, and high-density rendering.

## 0.1.0 - 2026-08-23

- Add the loopback-only Multica CLI bridge and normalized office contracts.
- Add the responsive PixiJS office client with WebGL and 2D fallback rendering.
- Add built-release startup, strict CSP, authentication recovery, hidden-page throttling, and reduced-motion support.
- Add deterministic third-party notices and release-artifact verification.
