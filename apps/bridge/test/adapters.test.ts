import { describe, expect, it } from "vitest";
import {
	adaptAgents,
	adaptIssuePage,
	adaptRuns,
	adaptRuntimes,
	mapAgentStates,
} from "../src/adapters.js";

const now = new Date("2026-01-01T00:00:20Z");
const runtimeId = "22222222-2222-4222-8222-222222222222";
const agentId = "11111111-1111-4111-8111-111111111111";
const issueId = "33333333-3333-4333-8333-333333333333";
const runId = "44444444-4444-4444-8444-444444444444";

describe("CLI adapters", () => {
	it("rebuilds allowlisted objects and drops sensitive raw fields", () => {
		const agents = adaptAgents([
			{
				id: agentId,
				name: "Ada",
				runtime_id: runtimeId,
				status: "idle",
				updated_at: now.toISOString(),
				instructions: "must not escape",
				custom_args: ["secret"],
			},
		]);
		expect(agents[0]).toEqual(
			expect.objectContaining({ id: agentId, name: "Ada" }),
		);
		expect(agents[0]).not.toHaveProperty("instructions");
		expect(agents[0]).not.toHaveProperty("custom_args");
	});

	it("maps unknown enums without rejecting the snapshot", () => {
		const page = adaptIssuePage({
			issues: [
				{
					id: issueId,
					identifier: "OFF-1",
					title: "Unknown state",
					status: "future_status",
					priority: "high",
					assignee_type: "future_type",
					assignee_id: agentId,
					updated_at: now.toISOString(),
				},
			],
			has_more: false,
			offset: 0,
			limit: 100,
		});
		expect(page.issues[0]?.status).toBe("unknown");
		expect(page.issues[0]?.assignee).toBeNull();
	});

	it("applies offline > working > blocked > queued > done > idle", () => {
		const agents = adaptAgents([
			{
				id: agentId,
				name: "Ada",
				runtime_id: runtimeId,
				status: "idle",
				updated_at: now.toISOString(),
			},
		]);
		const runtimes = adaptRuntimes([
			{
				id: runtimeId,
				name: "Local",
				status: "online",
				last_seen_at: now.toISOString(),
			},
		]);
		const issues = adaptIssuePage({
			issues: [
				{
					id: issueId,
					identifier: "OFF-1",
					title: "Blocked issue",
					status: "blocked",
					priority: "high",
					assignee_type: "agent",
					assignee_id: agentId,
					updated_at: now.toISOString(),
				},
			],
			has_more: false,
			offset: 0,
			limit: 100,
		}).issues;
		const running = adaptRuns([
			{
				id: runId,
				issue_id: issueId,
				agent_id: agentId,
				runtime_id: runtimeId,
				status: "running",
				started_at: now.toISOString(),
				completed_at: null,
			},
		]);

		expect(
			mapAgentStates(agents, runtimes, issues, running, { now })[0]?.state,
		).toBe("working");
		expect(
			mapAgentStates(agents, runtimes, issues, [], { now })[0]?.state,
		).toBe("blocked");
		expect(
			mapAgentStates(
				agents,
				[{ ...runtimes[0]!, state: "offline" }],
				issues,
				running,
				{ now },
			)[0]?.state,
		).toBe("offline");
	});
});
