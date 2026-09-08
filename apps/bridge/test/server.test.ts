import { afterEach, describe, expect, it } from "vitest";
import { once } from "node:events";
import { get, type IncomingMessage } from "node:http";
import type { FastifyInstance } from "fastify";
import { fileURLToPath } from "node:url";
import type { CliRunner } from "../src/runner.js";
import { buildServer } from "../src/server.js";
import { SnapshotService } from "../src/snapshot.js";

const runner: CliRunner = {
	async run(command) {
		if (command.key === "issues")
			return {
				issues: [],
				has_more: false,
				offset: command.offset,
				limit: 100,
			};
		return [];
	},
};

const openApps: FastifyInstance[] = [];
afterEach(async () => {
	await Promise.all(openApps.splice(0).map((app) => app.close()));
});

function app(
	developmentOrigin?: string,
	tailnetOrigin?: string,
): FastifyInstance {
	const instance = buildServer(new SnapshotService(runner), {
		port: 4317,
		...(developmentOrigin ? { developmentOrigin } : {}),
		...(tailnetOrigin ? { tailnetOrigin } : {}),
	});
	openApps.push(instance);
	return instance;
}

describe("loopback HTTP API", () => {
	it("closes active SSE streams before waiting for HTTP shutdown", async () => {
		const clientCounts: number[] = [];
		const server = buildServer(new SnapshotService(runner), {
			port: 4317,
			onClientCount: (count) => clientCounts.push(count),
		});
		openApps.push(server);
		await server.listen({ host: "127.0.0.1", port: 0 });
		const address = server.server.address();
		if (!address || typeof address === "string") throw new Error("Expected a TCP address");
		let response: IncomingMessage | undefined;
		const request = get({
			host: "127.0.0.1", port: address.port, path: "/v1/events",
			headers: { host: "127.0.0.1:4317" }, agent: false,
		});
		let closing: Promise<void> | undefined;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		try {
			[response] = await once(request, "response") as [IncomingMessage];
			expect(response.statusCode).toBe(200);
			const [firstFrame] = await once(response, "data");
			expect(String(firstFrame)).toContain("event: snapshot");
			expect(clientCounts).toEqual([1]);
			const ended = once(response, "end");
			response.resume();
			closing = server.close();
			await Promise.race([
				Promise.all([closing, ended]),
				new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("SSE prevented shutdown")), 1_000); }),
			]);
			expect(clientCounts).toEqual([1, 0]);
		} finally {
			clearTimeout(timeout);
			response?.destroy();
			request.destroy();
			await closing;
		}
	});

	it("serves only the normalized health and snapshot surface", async () => {
		const server = app();
		const health = await server.inject({
			method: "GET",
			url: "/healthz",
			headers: { host: "127.0.0.1:4317" },
		});
		expect(health.statusCode).toBe(200);
		expect(health.json()).toMatchObject({ status: "ok", schemaVersion: 1 });

		const snapshot = await server.inject({
			method: "GET",
			url: "/v1/snapshot",
			headers: { host: "127.0.0.1:4317" },
		});
		expect(snapshot.statusCode).toBe(200);
		expect(snapshot.json()).toMatchObject({ schemaVersion: 1, agents: [] });

		const command = await server.inject({
			method: "POST",
			url: "/command",
			headers: { host: "127.0.0.1:4317" },
			payload: { argv: ["anything"] },
		});
		expect(command.statusCode).toBe(404);
	});

	it("rejects foreign hosts and origins", async () => {
		const server = app("http://127.0.0.1:5173");
		const foreignHost = await server.inject({
			method: "GET",
			url: "/healthz",
			headers: { host: "localhost:4317" },
		});
		expect(foreignHost.statusCode).toBe(403);

		const foreignOrigin = await server.inject({
			method: "GET",
			url: "/healthz",
			headers: { host: "127.0.0.1:4317", origin: "https://example.com" },
		});
		expect(foreignOrigin.statusCode).toBe(403);

		const allowedOrigin = await server.inject({
			method: "GET",
			url: "/healthz",
			headers: { host: "127.0.0.1:4317", origin: "http://127.0.0.1:5173" },
		});
		expect(allowedOrigin.statusCode).toBe(200);
		expect(allowedOrigin.headers["access-control-allow-origin"]).toBe(
			"http://127.0.0.1:5173",
		);

		const sameOrigin = await server.inject({
			method: "GET",
			url: "/healthz",
			headers: { host: "127.0.0.1:4317", origin: "http://127.0.0.1:4317" },
		});
		expect(sameOrigin.statusCode).toBe(200);
		expect(sameOrigin.headers["access-control-allow-origin"]).toBeUndefined();
	});

	it("keeps Tailnet hosts disabled unless explicitly configured", async () => {
		const server = app();
		const response = await server.inject({
			method: "GET",
			url: "/healthz",
			headers: {
				host: "office.tail1234.ts.net:8443",
				origin: "https://office.tail1234.ts.net:8443",
				"tailscale-user-login": "member@example.com",
				"x-forwarded-host": "127.0.0.1:4317",
			},
		});
		expect(response.statusCode).toBe(403);
	});

	it("accepts exact authenticated Tailnet proxy requests without CORS", async () => {
		const tailnetOrigin = "https://office.tail1234.ts.net:8443";
		const server = app(undefined, tailnetOrigin);
		const response = await server.inject({
			method: "GET",
			url: "/v1/snapshot",
			headers: {
				host: "office.tail1234.ts.net:8443",
				origin: tailnetOrigin,
				"tailscale-user-login": "member@example.com",
			},
		});
		expect(response.statusCode).toBe(200);
		expect(response.headers["access-control-allow-origin"]).toBeUndefined();
		expect(response.headers["content-security-policy"]).toContain(
			"connect-src 'self'",
		);
	});

	it.each([
		{
			name: "Funnel-like requests without a Tailscale identity",
			headers: {},
		},
		{
			name: "foreign origins",
			headers: {
				origin: "https://example.com",
				"tailscale-user-login": "member@example.com",
			},
		},
		{
			name: "opaque null origins",
			headers: {
				origin: "null",
				"tailscale-user-login": "member@example.com",
			},
		},
		{
			name: "forwarded-header host spoofing",
			headers: {
				origin: "https://office.tail1234.ts.net:8443",
				"tailscale-user-login": "member@example.com",
				"x-forwarded-host": "office.tail1234.ts.net:8443",
			},
			host: "attacker.example:8443",
		},
	])("rejects $name", async ({ headers, host }) => {
		const server = app(undefined, "https://office.tail1234.ts.net:8443");
		const response = await server.inject({
			method: "GET",
			url: "/v1/events",
			headers: {
				host: host ?? "office.tail1234.ts.net:8443",
				...headers,
			},
		});
		expect(response.statusCode).toBe(403);
	});

	it("rejects identity headers received from a non-local peer", async () => {
		const server = app(undefined, "https://office.tail1234.ts.net:8443");
		const response = await server.inject({
			method: "GET",
			url: "/healthz",
			remoteAddress: "100.64.0.2",
			headers: {
				host: "office.tail1234.ts.net:8443",
				"tailscale-user-login": "member@example.com",
			},
		});
		expect(response.statusCode).toBe(403);
	});

	it("serves only files inside the configured built-client root", async () => {
		const server = buildServer(new SnapshotService(runner), {
			port: 4317,
			staticRoot: fileURLToPath(new URL("../../web", import.meta.url)),
		});
		openApps.push(server);
		const index = await server.inject({ method: "GET", url: "/index.html", headers: { host: "127.0.0.1:4317" } });
		expect(index.statusCode).toBe(200);
		expect(index.headers["content-type"]).toContain("text/html");
		expect(index.body).toContain("Multica Office");

		const missing = await server.inject({ method: "GET", url: "/missing.js", headers: { host: "127.0.0.1:4317" } });
		expect(missing.statusCode).toBe(404);
	});
});
