#!/usr/bin/env node

// Operator-run installation handoff. Never invoke this on behalf of an agent task.
import { spawn, spawnSync } from "node:child_process";
import { access, cp, mkdir, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertHostContext } from "./host-context.mjs";

const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const releaseFiles = [
	"package.json", "package-lock.json", "LICENSE", "THIRD_PARTY_NOTICES.txt",
	"apps/bridge/package.json", "apps/bridge/dist",
	"apps/web/package.json", "apps/web/dist",
	"packages/contracts/package.json", "packages/contracts/dist",
	"scripts/tailnet.mjs", "scripts/host-context.mjs",
];

export async function copyRelease(from, target) {
	// An explicit allowlist excludes .multica, .env, logs, source and credentials.
	for (const file of releaseFiles) await access(join(from, file));
	await mkdir(target, { recursive: false, mode: 0o700 });
	for (const file of releaseFiles) {
		await mkdir(dirname(join(target, file)), { recursive: true, mode: 0o700 });
		await cp(join(from, file), join(target, file), { recursive: true, dereference: true, force: false, errorOnExist: true });
	}
}

function run(binary, args, options = {}) {
	const result = spawnSync(binary, args, { encoding: "utf8", timeout: 15_000, maxBuffer: 2 * 1024 * 1024, ...options });
	if (result.error || result.status !== 0) throw new Error(`${args[0]} failed; no raw command output was retained.`);
	return result.stdout;
}

export function isRecordedLauncher(command, openFiles, executable, directory) {
	return command.trim() === `${executable} scripts/tailnet.mjs start`
		&& openFiles.split("\n").includes(`n${directory}`);
}

async function stopPreviousService() {
	let state;
	try { state = JSON.parse(await readFile(join(source, ".multica/office-tailnet-state.json"), "utf8")); }
	catch (error) { if (error.code === "ENOENT") return; throw error; }
	if (state.marker !== "multica-office-tailnet-v1" || !Number.isSafeInteger(state.launcherPid) || state.launcherPid <= 1) {
		throw new Error("The previous service record is invalid; no process was stopped.");
	}
	const pid = String(state.launcherPid);
	const processInfo = spawnSync("/bin/ps", ["-p", pid, "-o", "command="], { encoding: "utf8", timeout: 5_000 });
	if (processInfo.status === 0) {
		const cwd = run("/usr/sbin/lsof", ["-a", "-p", pid, "-d", "cwd", "-Fn"]);
		if (!isRecordedLauncher(processInfo.stdout, cwd, await realpath(process.execPath), await realpath(source))) {
			throw new Error("The recorded PID no longer matches the Office launcher; no process was stopped.");
		}
		process.kill(state.launcherPid, "SIGTERM");
		const deadline = Date.now() + 10_000;
		for (;;) {
			try { process.kill(state.launcherPid, 0); }
			catch (error) { if (error.code === "ESRCH") break; throw error; }
			if (Date.now() > deadline) throw new Error("The previous Office launcher did not stop; no new service was started.");
			await new Promise((done) => setTimeout(done, 100));
		}
	} else if (processInfo.status !== 1) {
		throw new Error("Could not verify the previous Office process; no process was stopped.");
	}
	run(process.execPath, ["scripts/tailnet.mjs", "cleanup"], { cwd: source });
}

async function main() {
	assertHostContext();
	const [targetInput, replaceFlag] = process.argv.slice(2);
	if (!targetInput || (replaceFlag && replaceFlag !== "--replace-running") || process.argv.length > 4) {
		throw new Error("Usage (regular terminal only): node host-start.mjs <new-install-directory> [--replace-running]");
	}
	const target = resolve(targetInput);
	assertHostContext(process.env, target);
	if (!isAbsolute(process.env.MULTICA_BIN ?? "")) throw new Error("Set MULTICA_BIN to the absolute path of your normally signed-in multica CLI.");
	try {
		run(process.env.MULTICA_BIN, ["agent", "list", "--output", "json"]);
		run(process.env.MULTICA_BIN, ["runtime", "list", "--output", "json"]);
		run(process.env.MULTICA_BIN, ["issue", "list", "--limit", "100", "--offset", "0", "--output", "json"]);
	} catch {
		throw new Error("Multica login could not be verified. Run multica login in this regular terminal, then retry. Do not send credentials to the agent.");
	}
	await copyRelease(source, target);
	process.stdout.write(`Installing locked production dependencies in ${target}\n`);
	run("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: target, timeout: 180_000 });
	if (replaceFlag) await stopPreviousService();
	process.stdout.write(`Starting Office from ${target}. Keep this terminal open; Ctrl-C stops the service.\nRestart later from that directory with: MULTICA_BIN=\"$(command -v multica)\" npm run start:tailnet\n`);
	const child = spawn(process.execPath, ["scripts/tailnet.mjs", "start"], { cwd: target, env: process.env, stdio: "inherit" });
	const stop = () => child.kill("SIGTERM");
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
	try {
		process.exitCode = await new Promise((done, reject) => {
			child.once("error", reject);
			child.once("exit", (code) => done(code ?? 1));
		});
	} finally {
		process.removeListener("SIGINT", stop);
		process.removeListener("SIGTERM", stop);
		run(process.execPath, ["scripts/tailnet.mjs", "cleanup"], { cwd: target });
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		process.stderr.write(`${error.message}\n`);
		process.exitCode = 1;
	});
}
