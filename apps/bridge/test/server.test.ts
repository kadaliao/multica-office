import { afterEach, describe, expect, it } from "vitest";
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

function app(developmentOrigin?: string): FastifyInstance {
	const instance = buildServer(new SnapshotService(runner), {
		port: 4317,
		...(developmentOrigin ? { developmentOrigin } : {}),
	});
	openApps.push(instance);
	return instance;
}

describe("loopback HTTP API", () => {
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
