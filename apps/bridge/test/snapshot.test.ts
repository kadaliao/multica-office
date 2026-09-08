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

function outputWithInvalidTimestamp(command: CliCommand, source: "agents" | "runtimes" | "issues" | "runs"): unknown {
	const value = structuredClone(output(command));
	if (source === "agents" && command.key === "agents") (value as Array<Record<string, unknown>>)[0]!.updated_at = "invalid";
	if (source === "runtimes" && command.key === "runtimes") (value as Array<Record<string, unknown>>)[0]!.last_seen_at = "invalid";
	if (source === "issues" && command.key === "issues") ((value as { issues: Array<Record<string, unknown>> }).issues[0]!).updated_at = "invalid";
	if (source === "runs" && command.key === "issueRuns") (value as Array<Record<string, unknown>>)[0]!.completed_at = "invalid";
	return value;
}

describe("snapshot service", () => {
	for (const source of ["agents", "runtimes", "issues", "runs"] as const) {
		it(`retains last-good ${source} data after an invalid timestamp`, async () => {
			let invalid = false;
			const runner: CliRunner = {
				async run(command) {
					return invalid ? outputWithInvalidTimestamp(command, source) : output(command);
				},
			};
			const service = new SnapshotService(runner, { now: () => new Date(timestamp) });
			const first = await service.refresh();
			invalid = true;
			const degraded = await service.refresh();
			expect(degraded.sources[source]).toMatchObject({ state: "stale", error: { code: "schema_mismatch" } });
			expect(degraded[source]).toEqual(first[source]);
		});
	}

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

	it("preserves last-known agent state when failed reads outlive the heartbeat window", async () => {
		let now = new Date(timestamp);
		let failing = false;
		const service = new SnapshotService({
			async run(command) {
				if (failing) throw new Error("read unavailable");
				return output(command);
			},
		}, { now: () => now });
		const healthy = await service.refresh();
		expect(healthy.agents[0]?.state).toBe("working");
		failing = true;
		now = new Date("2026-01-01T00:05:20Z");
		const unavailable = await service.refresh();
		expect(unavailable.sources.runtimes.state).toBe("stale");
		expect(unavailable.agents).toEqual(healthy.agents);
		failing = false;
		now = new Date(timestamp);
		expect((await service.refresh()).sources.runtimes.state).toBe("ok");
	});

	it("polls squad issues and clears retained runs after a terminal transition", async () => {
		let issueStatus = "in_progress";
		let runCalls = 0;
		const runner: CliRunner = {
			async run(command) {
				if (command.key === "issues") {
					const page = output(command) as { issues: Array<Record<string, unknown>> } & Record<string, unknown>;
					page.issues[0] = { ...page.issues[0], status: issueStatus, assignee_type: "squad", assignee_id: "55555555-5555-4555-8555-555555555555" };
					return page;
				}
				if (command.key === "issueRuns") runCalls += 1;
				return output(command);
			},
		};
		const service = new SnapshotService(runner, { now: () => new Date(timestamp) });
		const active = await service.refresh();
		expect(runCalls).toBe(1);
		expect(active.agents[0]).toMatchObject({ state: "working", issueId, runId });

		issueStatus = "done";
		const terminal = await service.refresh();
		expect(runCalls).toBe(1);
		expect(terminal.runs).toEqual([]);
		expect(terminal.agents[0]).toMatchObject({ state: "idle", issueId: null, runId: null });
	});

	it("keeps retained and refreshed runs stable across bounded rotation", async () => {
		const secondIssueId = "55555555-5555-4555-8555-555555555555";
		const secondRunId = "66666666-6666-4666-8666-666666666666";
		const runner: CliRunner = {
			async run(command) {
				if (command.key === "issues") return {
					issues: [
						...(output(command) as { issues: unknown[] }).issues,
						{ id: secondIssueId, identifier: "OFF-2", title: "Second", status: "in_progress", priority: "medium", assignee_type: "agent", assignee_id: agentId, updated_at: timestamp },
					],
					has_more: false,
					offset: command.offset,
					limit: 100,
				};
				if (command.key === "issueRuns" && command.issueId === secondIssueId) return [{ id: secondRunId, issue_id: secondIssueId, agent_id: agentId, runtime_id: runtimeId, status: "queued", started_at: null, completed_at: null }];
				return output(command);
			},
		};
		const service = new SnapshotService(runner, { now: () => new Date(timestamp), maxRunIssues: 1 });
		await service.refresh();
		const warmed = await service.refresh();
		expect(warmed.runs.map((run) => run.id)).toEqual([runId, secondRunId]);
		for (let index = 0; index < 4; index += 1) {
			const next = await service.refresh();
			expect(next.sequence).toBe(warmed.sequence);
			expect(next.runs.map((run) => run.id)).toEqual([runId, secondRunId]);
		}
	});

	it("advances source freshness without broadcasting an unchanged snapshot", async () => {
		let now = new Date(timestamp);
		let failAgents = false;
		const runner: CliRunner = {
			async run(command) {
				if (failAgents && command.key === "agents") throw new Error("down");
				return output(command);
			},
		};
		const service = new SnapshotService(runner, { now: () => now });
		let broadcasts = 0;
		service.subscribe(() => { broadcasts += 1; });
		const first = await service.refresh();
		now = new Date("2026-01-01T00:00:25Z");
		const unchanged = await service.refresh();
		expect(unchanged.sequence).toBe(first.sequence);
		expect(unchanged.sources.agents.observedAt).toBe("2026-01-01T00:00:25.000Z");
		expect(broadcasts).toBe(1);

		failAgents = true;
		now = new Date("2026-01-01T00:00:26Z");
		const stale = await service.refresh();
		expect(stale.sources.agents).toMatchObject({ state: "stale", observedAt: "2026-01-01T00:00:25.000Z" });
		expect(broadcasts).toBe(2);
	});
});
