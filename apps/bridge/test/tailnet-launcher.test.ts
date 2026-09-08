import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Tailnet persistent launcher", () => {
	it.each([
		{ MULTICA_TASK_ID: "task-example" },
		{ MULTICA_AGENT_ID: "agent-example" },
		{ MULTICA_TASK_CONFIG_ROOT: "/task/example" },
		{ MULTICA_TOKEN: "mat_synthetic_test_value" },
	])("rejects task credentials before touching Tailscale: %o", (taskEnvironment) => {
		const result = spawnSync(process.execPath, [resolve("scripts/tailnet.mjs"), "start"], {
			env: { ...taskEnvironment },
			encoding: "utf8",
			timeout: 5_000,
		});
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("task-scoped authentication ends");
		expect(result.stderr).not.toContain("mat_synthetic_test_value");
		expect(result.stdout).toBe("");
	});
});
