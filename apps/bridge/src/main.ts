import { fileURLToPath } from "node:url";
import { readAccessConfiguration } from "./access.js";
import { buildServer } from "./server.js";
import { SnapshotPoller } from "./poller.js";
import { createCliRunner, resolveExecutable } from "./runner.js";
import { SnapshotService } from "./snapshot.js";

function readPort(): number {
	const port = Number(process.env.OFFICE_BRIDGE_PORT ?? 4317);
	if (!Number.isInteger(port) || port < 1 || port > 65_535) {
		throw new Error(
			"OFFICE_BRIDGE_PORT must be an integer between 1 and 65535",
		);
	}
	return port;
}

const executableInput = process.env.MULTICA_BIN;
if (!executableInput) {
	throw new Error(
		"MULTICA_BIN must name the absolute path to the multica executable",
	);
}

const port = readPort();
const access = readAccessConfiguration(process.env);
const executable = await resolveExecutable(executableInput);
const runner = createCliRunner({ executable });
const service = new SnapshotService(runner);
const poller = new SnapshotPoller(service);
const server = buildServer(service, {
	port,
	staticRoot: fileURLToPath(new URL("../../web/dist", import.meta.url)),
	...(process.env.OFFICE_DEV_ORIGIN
		? { developmentOrigin: process.env.OFFICE_DEV_ORIGIN }
		: {}),
	...(access.tailnetOrigin ? { tailnetOrigin: access.tailnetOrigin } : {}),
	onClientCount: (count) => poller.setClientCount(count),
});

await poller.start();
const address = await server.listen({ host: "127.0.0.1", port });
const bound = server.server.address();
if (!bound || typeof bound === "string" || bound.address !== "127.0.0.1") {
	await server.close();
	throw new Error("Bridge did not bind to 127.0.0.1");
}

process.stdout.write(`Multica Office bridge listening at ${address}\n`);

const shutdown = async (): Promise<void> => {
	poller.stop();
	await server.close();
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
