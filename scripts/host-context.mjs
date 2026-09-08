import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export function assertHostContext(environment = process.env, cwd = process.cwd()) {
	if (
		environment.MULTICA_TASK_ID || environment.MULTICA_AGENT_ID ||
		environment.MULTICA_TASK_CONFIG_ROOT || environment.MULTICA_DAEMON_PORT ||
		environment.MULTICA_TOKEN?.startsWith("mat_")
	) {
		throw new Error("Start from a signed-in regular terminal: task-scoped authentication ends with the agent task");
	}
	let directory = resolve(cwd);
	while (!existsSync(directory)) directory = dirname(directory);
	directory = realpathSync(directory);
	for (;;) {
		if (existsSync(join(directory, ".multica", "daemon_task_context.json"))) {
			throw new Error("This directory is task-managed. Run the host installer from a regular terminal outside the managed checkout; do not remove its task marker.");
		}
		const parent = dirname(directory);
		if (parent === directory) break;
		directory = parent;
	}
}
