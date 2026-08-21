import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { BridgeError } from "@multica-office/contracts";

const UUID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type CliCommand =
	| { key: "agents" }
	| { key: "runtimes" }
	| { key: "issues"; offset: number }
	| { key: "issueRuns"; issueId: string };

export class CliFailure extends Error {
	constructor(
		readonly detail: BridgeError,
		readonly commandKey: CliCommand["key"],
	) {
		super(detail.message);
	}
}

export interface CliRunner {
	run(command: CliCommand): Promise<unknown>;
}

export interface RunnerOptions {
	executable: string;
	concurrency?: number;
	listTimeoutMs?: number;
	runsTimeoutMs?: number;
	maxBufferBytes?: number;
	environment?: NodeJS.ProcessEnv;
}

function commandArgs(command: CliCommand): string[] {
	switch (command.key) {
		case "agents":
			return ["agent", "list", "--output", "json"];
		case "runtimes":
			return ["runtime", "list", "--output", "json"];
		case "issues": {
			if (!Number.isSafeInteger(command.offset) || command.offset < 0) {
				throw new CliFailure(
					{
						code: "forbidden",
						retryable: false,
						message: "Invalid command parameters.",
					},
					command.key,
				);
			}
			return [
				"issue",
				"list",
				"--limit",
				"100",
				"--offset",
				String(command.offset),
				"--output",
				"json",
			];
		}
		case "issueRuns":
			if (!UUID.test(command.issueId)) {
				throw new CliFailure(
					{
						code: "forbidden",
						retryable: false,
						message: "Invalid command parameters.",
					},
					command.key,
				);
			}
			return ["issue", "runs", command.issueId, "--output", "json"];
		default:
			throw new Error("Unsupported CLI command key");
	}
}

interface ExecutableError {
	killed?: boolean | undefined;
	code?: string | number | undefined;
	stderr?: string | undefined;
}

function classifyFailure(error: ExecutableError): BridgeError {
	const stderr = String(error.stderr ?? "")
		.slice(0, 2_048)
		.toLowerCase();
	if (error.killed || error.code === "ETIMEDOUT") {
		return {
			code: "timeout",
			retryable: true,
			message: "Local data read timed out.",
		};
	}
	if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
		return {
			code: "output_too_large",
			retryable: true,
			message: "Local data exceeded the size limit.",
		};
	}
	if (
		stderr.includes("not authenticated") ||
		stderr.includes("multica login") ||
		stderr.includes("requires multica_token")
	) {
		return {
			code: "auth_required",
			retryable: false,
			message: "Multica CLI is not signed in.",
		};
	}
	if (stderr.includes("forbidden") || stderr.includes("permission denied")) {
		return {
			code: "forbidden",
			retryable: false,
			message: "Access to local data was denied.",
		};
	}
	if (stderr.includes("not found")) {
		return {
			code: "not_found",
			retryable: false,
			message: "The requested local record was not found.",
		};
	}
	if (stderr.includes("connection refused") || stderr.includes("unavailable")) {
		return {
			code: "unavailable",
			retryable: true,
			message: "Multica is currently unavailable.",
		};
	}
	return {
		code: "unknown",
		retryable: true,
		message: "Local data could not be read.",
	};
}

function safeEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const result: NodeJS.ProcessEnv = { LC_ALL: "C", NO_COLOR: "1" };
	for (const key of [
		"HOME",
		"LANG",
		"TMPDIR",
		"MULTICA_SERVER_URL",
		"MULTICA_WORKSPACE_ID",
		"MULTICA_TASK_ID",
		"MULTICA_TOKEN",
	] as const) {
		if (source[key]) result[key] = source[key];
	}
	return result;
}

export async function resolveExecutable(path: string): Promise<string> {
	if (!isAbsolute(path))
		throw new Error("MULTICA_BIN must be an absolute path");
	const resolved = await realpath(path);
	await access(resolved, constants.X_OK);
	return resolved;
}

export function createCliRunner(options: RunnerOptions): CliRunner {
	const concurrency = options.concurrency ?? 3;
	if (!isAbsolute(options.executable))
		throw new Error("CLI executable must be absolute");
	if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) {
		throw new Error("Runner concurrency must be between 1 and 8");
	}

	let active = 0;
	const waiters: Array<() => void> = [];
	const acquire = async (): Promise<void> => {
		if (active < concurrency) {
			active += 1;
			return;
		}
		await new Promise<void>((resolve) => waiters.push(resolve));
		active += 1;
	};
	const release = (): void => {
		active -= 1;
		waiters.shift()?.();
	};

	return {
		async run(command) {
			const args = commandArgs(command);
			await acquire();
			try {
				const timeout =
					command.key === "issueRuns"
						? (options.runsTimeoutMs ?? 3_000)
						: (options.listTimeoutMs ?? 5_000);
				const stdout = await new Promise<string>((resolve, reject) => {
					execFile(
						options.executable,
						args,
						{
							encoding: "utf8",
							env: safeEnvironment(options.environment ?? process.env),
							maxBuffer: options.maxBufferBytes ?? 2 * 1024 * 1024,
							shell: false,
							timeout,
							windowsHide: true,
						},
						(error, output, stderr) => {
							if (error) {
								Object.assign(error, { stderr });
								reject(error);
							} else {
								resolve(output);
							}
						},
					);
				});
				try {
					return JSON.parse(stdout) as unknown;
				} catch {
					throw new CliFailure(
						{
							code: "invalid_json",
							retryable: true,
							message: "Multica CLI returned invalid JSON.",
						},
						command.key,
					);
				}
			} catch (error) {
				if (error instanceof CliFailure) throw error;
				throw new CliFailure(
					classifyFailure(error as ExecutableError),
					command.key,
				);
			} finally {
				release();
			}
		},
	};
}
