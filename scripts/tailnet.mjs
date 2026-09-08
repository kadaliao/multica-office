#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, constants, rmSync } from "node:fs";
import {
	access,
	appendFile,
	mkdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertHostContext } from "./host-context.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeDirectory = join(root, ".multica");
const statePath = join(runtimeDirectory, "office-tailnet-state.json");
const logPath = join(runtimeDirectory, "office-tailnet.log");
const stateMarker = "multica-office-tailnet-v1";

function parsePort(name, fallback) {
	const value = Number(process.env[name] ?? fallback);
	if (!Number.isInteger(value) || value < 1 || value > 65_535) {
		throw new Error(`${name} must be an integer between 1 and 65535`);
	}
	return value;
}

async function resolveTailscaleBinary() {
	const configured = process.env.TAILSCALE_BIN;
	if (configured && !isAbsolute(configured)) {
		throw new Error("TAILSCALE_BIN must be an absolute executable path");
	}
	const candidates = [
		configured,
		"/Applications/Tailscale.app/Contents/MacOS/Tailscale",
		"/usr/local/bin/tailscale",
		"/opt/homebrew/bin/tailscale",
	].filter(Boolean);
	for (const candidate of candidates) {
		if (!isAbsolute(candidate)) continue;
		try {
			await access(candidate, constants.X_OK);
			return candidate;
		} catch {
			// Try the next known absolute location.
		}
	}
	throw new Error(
		"Tailscale CLI was not found; set TAILSCALE_BIN to its absolute path",
	);
}

function run(binary, args, timeout = 15_000) {
	const result = spawnSync(binary, args, {
		cwd: root,
		encoding: "utf8",
		maxBuffer: 2 * 1024 * 1024,
		shell: false,
		timeout,
	});
	if (result.error || result.status !== 0) {
		throw new Error(`Tailscale ${args[0]} command failed`);
	}
	return result.stdout;
}

function readJson(binary, args) {
	try {
		return JSON.parse(run(binary, args));
	} catch {
		throw new Error(`Tailscale ${args[0]} returned an invalid status`);
	}
}

function normalizeDnsName(value) {
	const hostname = typeof value === "string" ? value.replace(/\.$/, "") : "";
	if (
		!hostname.endsWith(".ts.net") ||
		!/^[a-z0-9.-]+$/.test(hostname)
	) {
		throw new Error("Tailscale did not report a valid MagicDNS HTTPS name");
	}
	return hostname;
}

function portIsConfigured(config, port) {
	const key = String(port);
	if (config?.TCP && Object.hasOwn(config.TCP, key)) return true;
	return Object.keys(config?.Web ?? {}).some((host) => host.endsWith(`:${key}`));
}

function isExpectedServeConfig(config, state) {
	const port = String(state.httpsPort);
	const webKey = `${state.hostname}:${port}`;
	const tcpConfig = config?.TCP?.[port];
	const handlers = config?.Web?.[webKey]?.Handlers;
	const webKeysOnPort = Object.keys(config?.Web ?? {}).filter((key) =>
		key.endsWith(`:${port}`),
	);
	return Boolean(
		tcpConfig?.HTTPS === true &&
		Object.keys(tcpConfig).every((key) => key === "HTTPS") &&
		webKeysOnPort.length === 1 &&
		webKeysOnPort[0] === webKey &&
		handlers?.["/"]?.Proxy === state.proxyTarget &&
		Object.keys(handlers).length === 1,
	);
}

async function readState() {
	try {
		const state = JSON.parse(await readFile(statePath, "utf8"));
		if (state?.marker !== stateMarker) {
			throw new Error("The Tailnet state file is not owned by Multica Office");
		}
		return state;
	} catch (error) {
		if (error?.code === "ENOENT") return null;
		if (error instanceof SyntaxError) {
			throw new Error("The Tailnet state file is invalid");
		}
		throw error;
	}
}

async function writeState(state) {
	await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
	await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
}

async function log(message) {
	await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
	await appendFile(logPath, `${new Date().toISOString()} ${message}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
}

function inspectLocalTailscale(binary) {
	const status = readJson(binary, ["status", "--json"]);
	if (status.BackendState !== "Running" || status.Self?.Online !== true) {
		throw new Error("Tailscale must be running and online");
	}
	if (typeof status.MagicDNSSuffix !== "string" || !status.MagicDNSSuffix) {
		throw new Error("MagicDNS must be enabled for Tailnet access");
	}
	const hostname = normalizeDnsName(status.Self?.DNSName);
	const certDomains = Array.isArray(status.CertDomains)
		? status.CertDomains.map((value) => String(value).replace(/\.$/, ""))
		: [];
	if (!certDomains.includes(hostname)) {
		throw new Error("Tailscale HTTPS certificates must be enabled");
	}
	return {
		hostname,
		version: String(status.Version ?? "unknown").split("-")[0],
	};
}

async function waitForLoopbackHealth(bridgePort, child) {
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		if (child.exitCode !== null || child.signalCode !== null) {
			throw new Error("Office bridge exited before it became ready");
		}
		try {
			const response = await fetch(`http://127.0.0.1:${bridgePort}/healthz`, {
				signal: AbortSignal.timeout(1_000),
			});
			if (response.ok) return;
		} catch {
			// The bridge is still starting.
		}
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
	}
	throw new Error("Office bridge did not become healthy within 15 seconds");
}

async function waitForChild(child) {
	if (child.exitCode !== null || child.signalCode !== null) return;
	await new Promise((resolvePromise, rejectPromise) => {
		child.once("error", rejectPromise);
		child.once("exit", resolvePromise);
	});
}

async function checkDataSources(origin) {
	const response = await fetch(`${origin}/v1/snapshot`, {
		signal: AbortSignal.timeout(5_000),
	});
	if (!response.ok) throw new Error("Office snapshot could not be read");
	const snapshot = await response.json();
	if (["agents", "runtimes", "issues"].some((source) => snapshot.sources?.[source]?.state !== "ok")) {
		throw new Error("Office data is unavailable; check Multica authentication in a regular terminal on this host");
	}
}

async function removeOwnedServeConfig(binary, state) {
	const current = readJson(binary, ["serve", "status", "--json"]);
	if (
		portIsConfigured(current, state.httpsPort) &&
		!isExpectedServeConfig(current, state)
	) {
		throw new Error(
			"Refusing cleanup because the selected Serve route is no longer owned by Multica Office",
		);
	}
	if (isExpectedServeConfig(current, state)) {
		run(binary, ["serve", `--https=${state.httpsPort}`, "off"]);
	}
	await rm(statePath, { force: true });
	await log(`removed Tailnet HTTPS route on port ${state.httpsPort}`);
}

function removeOwnedServeConfigSync(binary, state) {
	const current = readJson(binary, ["serve", "status", "--json"]);
	if (
		portIsConfigured(current, state.httpsPort) &&
		!isExpectedServeConfig(current, state)
	) {
		throw new Error(
			"Refusing cleanup because the selected Serve route is no longer owned by Multica Office",
		);
	}
	if (isExpectedServeConfig(current, state)) {
		run(binary, ["serve", `--https=${state.httpsPort}`, "off"]);
	}
	rmSync(statePath, { force: true });
	appendFileSync(
		logPath,
		`${new Date().toISOString()} removed Tailnet HTTPS route on port ${state.httpsPort}\n`,
		{ encoding: "utf8", mode: 0o600 },
	);
}

async function start() {
	assertHostContext();
	const binary = await resolveTailscaleBinary();
	await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
	const bridgePort = parsePort("OFFICE_BRIDGE_PORT", 4317);
	const httpsPort = parsePort("OFFICE_TAILNET_HTTPS_PORT", 8443);
	if (bridgePort === httpsPort) {
		throw new Error("Tailnet HTTPS and bridge ports must be different");
	}
	const { hostname, version } = inspectLocalTailscale(binary);
	const origin = `https://${hostname}${httpsPort === 443 ? "" : `:${httpsPort}`}`;
	const proxyTarget = `http://127.0.0.1:${bridgePort}`;
	const state = {
		marker: stateMarker,
		hostname,
		httpsPort,
		bridgePort,
		proxyTarget,
		launcherPid: process.pid,
	};

	if (await readState()) {
		throw new Error(
			"A Tailnet state file already exists; check the running service or clean up the stale route",
		);
	}
	const serveBefore = readJson(binary, ["serve", "status", "--json"]);
	if (portIsConfigured(serveBefore, httpsPort)) {
		throw new Error(
			`Tailscale Serve port ${httpsPort} is already configured; choose another OFFICE_TAILNET_HTTPS_PORT`,
		);
	}
	const funnel = readJson(binary, ["funnel", "status", "--json"]);
	if (portIsConfigured(funnel, httpsPort)) {
		throw new Error(
			`Tailscale Funnel port ${httpsPort} is enabled; disable it or choose another Tailnet HTTPS port`,
		);
	}
	if (!process.env.MULTICA_BIN || !isAbsolute(process.env.MULTICA_BIN)) {
		throw new Error("MULTICA_BIN must name the absolute path to multica");
	}

	const child = spawn(process.execPath, ["apps/bridge/dist/main.js"], {
		cwd: root,
		env: {
			...process.env,
			OFFICE_ACCESS_MODE: "tailnet",
			OFFICE_TAILNET_ORIGIN: origin,
			OFFICE_BRIDGE_PORT: String(bridgePort),
		},
		stdio: "inherit",
	});
	let configured = false;
	let routeCommandStarted = false;
	let handlingSignal = false;
	const forwardSignal = (signal) => {
		if (handlingSignal) return;
		handlingSignal = true;
		if (routeCommandStarted) {
			try {
				removeOwnedServeConfigSync(binary, state);
				configured = false;
			} catch (error) {
				process.stderr.write(`${error.message}\n`);
			}
		}
		if (child.exitCode === null) child.kill(signal);
	};
	process.once("SIGINT", () => forwardSignal("SIGINT"));
	process.once("SIGTERM", () => forwardSignal("SIGTERM"));
	process.once("SIGHUP", () => forwardSignal("SIGTERM"));

	try {
		await waitForLoopbackHealth(bridgePort, child);
		await checkDataSources(proxyTarget);
		routeCommandStarted = true;
		try {
			run(
				binary,
				["serve", "--bg", `--https=${httpsPort}`, proxyTarget],
				30_000,
			);
		} catch (error) {
			const partial = readJson(binary, ["serve", "status", "--json"]);
			configured = isExpectedServeConfig(partial, state);
			throw error;
		}
		const serveAfter = readJson(binary, ["serve", "status", "--json"]);
		if (!isExpectedServeConfig(serveAfter, state)) {
			throw new Error("Tailscale Serve did not install the exact expected route");
		}
		configured = true;
		await writeState(state);
		await log(
			`started Tailnet mode with Tailscale ${version}, HTTPS port ${httpsPort}, and loopback bridge port ${bridgePort}`,
		);
		process.stdout.write(`Tailnet access ready at ${origin}/\n`);
		process.stdout.write(`Controlled log: ${logPath}\n`);
		await waitForChild(child);
	} finally {
		if (child.exitCode === null) {
			child.kill("SIGTERM");
			await waitForChild(child);
		}
		if (configured) {
			try {
				await removeOwnedServeConfig(binary, state);
			} catch (error) {
				process.stderr.write(`${error.message}\n`);
			}
		}
	}
}

async function status() {
	const binary = await resolveTailscaleBinary();
	const state = await readState();
	if (!state) throw new Error("Multica Office Tailnet mode is not active");
	const serve = readJson(binary, ["serve", "status", "--json"]);
	if (!isExpectedServeConfig(serve, state)) {
		throw new Error("The recorded Multica Office Serve route is not active");
	}
	const origin = `https://${state.hostname}${
		state.httpsPort === 443 ? "" : `:${state.httpsPort}`
	}`;
	const response = await fetch(`${origin}/healthz`, {
		signal: AbortSignal.timeout(5_000),
	});
	if (!response.ok) throw new Error("Tailnet health check failed");
	await checkDataSources(origin);
	process.stdout.write(`Tailnet access is healthy at ${origin}/\n`);
	process.stdout.write(`Controlled log: ${logPath}\n`);
}

async function cleanup() {
	const binary = await resolveTailscaleBinary();
	const state = await readState();
	if (!state) {
		process.stdout.write("No Multica Office Tailnet route is recorded.\n");
		return;
	}
	await removeOwnedServeConfig(binary, state);
	process.stdout.write("Multica Office Tailnet Serve route removed.\n");
}

const command = process.argv[2];
try {
	if (command === "start") await start();
	else if (command === "status") await status();
	else if (command === "cleanup") await cleanup();
	else throw new Error("Usage: node scripts/tailnet.mjs <start|status|cleanup>");
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.message : "Tailnet command failed"}\n`);
	process.exitCode = 1;
}
