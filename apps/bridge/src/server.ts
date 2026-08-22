import Fastify, { type FastifyInstance } from "fastify";
import type { OutgoingHttpHeaders } from "node:http";
import type { OfficeEvent, OfficeSnapshot } from "@multica-office/contracts";
import type { SnapshotService } from "./snapshot.js";

export interface ServerOptions {
	port: number;
	developmentOrigin?: string;
	maxSseClients?: number;
	onClientCount?: (count: number) => void;
}

function sseFrame(
	event: string,
	data: OfficeSnapshot | OfficeEvent,
	id?: string,
): string {
	return `${id ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function buildServer(
	service: SnapshotService,
	options: ServerOptions,
): FastifyInstance {
	const app = Fastify({ logger: false, bodyLimit: 1_024 });
	const clients = new Set<NodeJS.WritableStream>();
	const expectedHost = `127.0.0.1:${options.port}`;

	app.addHook("onRequest", async (request, reply) => {
		if (request.headers.host !== expectedHost) {
			await reply.code(403).send({ error: "forbidden" });
			return;
		}
		const origin = request.headers.origin;
		if (origin && origin !== options.developmentOrigin) {
			await reply.code(403).send({ error: "forbidden" });
			return;
		}
		reply.headers({
			"cache-control": "no-store",
			"content-security-policy":
				"default-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'",
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

	app.setNotFoundHandler((_request, reply) =>
		reply.code(404).send({ error: "not_found" }),
	);
	return app;
}
