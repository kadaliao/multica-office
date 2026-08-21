import { describe, expect, it } from "vitest";
import type { CliCommand, CliRunner } from "../src/runner.js";
import { CliFailure } from "../src/runner.js";
import { SnapshotService } from "../src/snapshot.js";

const agentId = "11111111-1111-4111-8111-111111111111";
const runtimeId = "22222222-2222-4222-8222-222222222222";
const issueId = "33333333-3333-4333-8333-333333333333";
const runId = "44444444-4444-4444-8444-444444444444";
const timestamp = "2026-01-01T00:00:20Z";

function output(command: CliCommand): unknown {
	if (command.key === "agents")
		return [
			{
				id: agentId,
				name: "Ada",
				runtime_id: runtimeId,
				status: "working",
				updated_at: timestamp,
				instructions: "private",
			},
		];
	if (command.key === "runtimes")
		return [
			{
				id: runtimeId,
				name: "Local",
				status: "online",
				last_seen_at: timestamp,
				device_info: { serial: "private" },
			},
		];
	if (command.key === "issues")
		return {
			issues: [
				{
					id: issueId,
					identifier: "OFF-1",
					title: "Bridge",
					status: "in_progress",
					priority: "high",
					assignee_type: "agent",
					assignee_id: agentId,
					updated_at: timestamp,
					description: "private",
				},
			],
			has_more: false,
			offset: command.offset,
			limit: 100,
		};
	return [
		{
			id: runId,
			issue_id: issueId,
			agent_id: agentId,
			runtime_id: runtimeId,
			status: "running",
			started_at: timestamp,
			completed_at: null,
			result: { output: "private" },
		},
	];
}

describe("snapshot service", () => {
	it("builds a normalized snapshot and retains last-good data on partial failure", async () => {
		let failAgents = false;
		let failRuns = false;
		const runner: CliRunner = {
			async run(command) {
				if (failAgents && command.key === "agents") throw new Error("down");
				if (failRuns && command.key === "issueRuns") throw new Error("down");
				return output(command);
			},
		};
		const service = new SnapshotService(runner, {
			now: () => new Date(timestamp),
		});
		const first = await service.refresh();
		expect(first.agents[0]).toMatchObject({ state: "working", issueId, runId });
		expect(JSON.stringify(first)).not.toContain("private");

		failAgents = true;
		failRuns = true;
		const degraded = await service.refresh();
		expect(degraded.sources.agents.state).toBe("stale");
		expect(degraded.sources.runs.state).toBe("stale");
		expect(degraded.agents).toEqual(first.agents);
		expect(degraded.runs).toEqual(first.runs);
		expect(degraded.sources.runtimes.state).toBe("ok");
	});

	it("reports an auth-required source error with a safe message", async () => {
		const runner: CliRunner = {
			async run(command) {
				if (command.key === "issueRuns") return [];
				throw new CliFailure(
					{
						code: "auth_required",
						retryable: false,
						message: "Multica CLI is not signed in.",
					},
					command.key,
				);
			},
		};
		const service = new SnapshotService(runner, {
			now: () => new Date(timestamp),
		});
		const snapshot = await service.refresh();
		expect(snapshot.sources.agents).toMatchObject({
			state: "error",
			error: { code: "auth_required", retryable: false },
		});
	});
});
