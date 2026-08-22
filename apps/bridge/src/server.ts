import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { readFile } from "node:fs/promises";
import type { OutgoingHttpHeaders } from "node:http";
import { extname, resolve, sep } from "node:path";
import type { OfficeEvent, OfficeSnapshot } from "@multica-office/contracts";
import type { SnapshotService } from "./snapshot.js";

export interface ServerOptions {
	port: number;
	developmentOrigin?: string;
	maxSseClients?: number;
	onClientCount?: (count: number) => void;
	staticRoot?: string;
}

function sseFrame(
	event: string,
	data: OfficeSnapshot | OfficeEvent,
	id?: string,
): string {
	return `${id ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

const STATIC_CONTENT_TYPES: Record<string, string> = {
	".css": "text/css; charset=utf-8",
	".html": "text/html; charset=utf-8",
	".ico": "image/x-icon",
	".js": "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".png": "image/png",
	".svg": "image/svg+xml",
	".webmanifest": "application/manifest+json",
};

export function buildServer(
	service: SnapshotService,
	options: ServerOptions,
): FastifyInstance {
	const app = Fastify({ logger: false, bodyLimit: 1_024 });
	const clients = new Set<NodeJS.WritableStream>();
	const expectedHost = `127.0.0.1:${options.port}`;
	const sameOrigin = `http://${expectedHost}`;

	app.addHook("onRequest", async (request, reply) => {
		if (request.headers.host !== expectedHost) {
			await reply.code(403).send({ error: "forbidden" });
			return;
		}
		const origin = request.headers.origin;
		if (origin && origin !== sameOrigin && origin !== options.developmentOrigin) {
			await reply.code(403).send({ error: "forbidden" });
			return;
		}
		reply.headers({
			"cache-control": "no-store",
			"content-security-policy":
				"default-src 'self'; script-src 'self' 'unsafe-eval'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'",
			"referrer-policy": "no-referrer",
			"x-content-type-options": "nosniff",
		});
		if (options.developmentOrigin && origin === options.developmentOrigin) {
			reply.header("access-control-allow-origin", options.developmentOrigin);
			reply.header("vary", "Origin");
		}
	});

	app.get("/healthz", () => ({
		status: "ok",
		schemaVersion: 1,
		sequence: service.getSnapshot().sequence,
	}));

	app.get("/v1/snapshot", () => service.getSnapshot());

	app.get("/v1/events", async (request, reply) => {
		if (clients.size >= (options.maxSseClients ?? 4)) {
			return reply.code(429).send({ error: "too_many_clients" });
		}

		const headers: OutgoingHttpHeaders = {};
		for (const [name, value] of Object.entries(reply.getHeaders())) {
			if (value === undefined) continue;
			headers[name] = typeof value === "number"
				? String(value)
				: Array.isArray(value) ? value.map(String) : value;
		}
		headers["cache-control"] = "no-cache, no-store";
		headers.connection = "keep-alive";
		headers["content-type"] = "text/event-stream; charset=utf-8";
		headers["x-accel-buffering"] = "no";
		reply.hijack();
		reply.raw.writeHead(200, headers);
		clients.add(reply.raw);
		options.onClientCount?.(clients.size);
		reply.raw.write(sseFrame("snapshot", service.getSnapshot()));

		const lastEventId = request.headers["last-event-id"];
		const [, sequencePart] =
			typeof lastEventId === "string" ? lastEventId.split(":") : [];
		const lastSequence = Number(sequencePart ?? -1);
		if (Number.isSafeInteger(lastSequence)) {
			for (const event of service.getEvents(lastSequence)) {
				reply.raw.write(sseFrame("office-event", event, event.id));
			}
		}

		const unsubscribe = service.subscribe((snapshot, events) => {
			if (!reply.raw.writable) return;
			reply.raw.write(sseFrame("snapshot", snapshot));
			for (const event of events)
				reply.raw.write(sseFrame("office-event", event, event.id));
		});
		const heartbeat = setInterval(() => {
			if (reply.raw.writable) reply.raw.write(": heartbeat\n\n");
		}, 15_000);
		heartbeat.unref();

		const cleanup = (): void => {
			clearInterval(heartbeat);
			unsubscribe();
			clients.delete(reply.raw);
			options.onClientCount?.(clients.size);
		};
		request.raw.once("close", cleanup);
		reply.raw.once("error", cleanup);
	});

	if (options.staticRoot) {
		const staticRoot = resolve(options.staticRoot);
		const sendStaticFile = async (relativePath: string, reply: FastifyReply) => {
			const filePath = resolve(staticRoot, relativePath);
			if (!filePath.startsWith(`${staticRoot}${sep}`))
				return reply.code(403).send({ error: "forbidden" });
			try {
				const body = await readFile(filePath);
				return reply.type(STATIC_CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream").send(body);
			} catch {
				return reply.code(404).send({ error: "not_found" });
			}
		};
		app.get("/", (_request, reply) => sendStaticFile("index.html", reply));
		app.get("/*", (request, reply) =>
			sendStaticFile((request.params as { "*": string })["*"], reply),
		);
	}

	app.setNotFoundHandler((_request, reply) =>
		reply.code(404).send({ error: "not_found" }),
	);
	return app;
}
