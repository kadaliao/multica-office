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
	it("rejects malformed timestamps while preserving nullable timestamp fields", () => {
		expect(() => adaptAgents([{ id: agentId, name: "Ada", runtime_id: null, updated_at: "not-a-date" }])).toThrow();
		expect(() => adaptRuntimes([{ id: runtimeId, status: "online", last_seen_at: "2026-02-30T00:00:00Z" }])).toThrow();
		expect(() => adaptIssuePage({ issues: [{ id: issueId, identifier: "OFF-1", title: "Bad date", status: "todo", updated_at: "yesterday" }], has_more: false, offset: 0, limit: 100 })).toThrow();
		expect(() => adaptRuns([{ id: runId, issue_id: issueId, status: "running", started_at: "invalid", completed_at: null }])).toThrow();
		expect(() => adaptRuns([{ id: runId, issue_id: issueId, status: "completed", started_at: null, completed_at: "invalid" }])).toThrow();
		expect(adaptRuntimes([{ id: runtimeId, status: "online", last_seen_at: null }])[0]?.lastSeenAt).toBeNull();
		expect(adaptRuns([{ id: runId, issue_id: issueId, status: "queued", started_at: null, completed_at: null }])[0]).toMatchObject({ startedAt: null, completedAt: null });
		expect(adaptAgents([{ id: agentId, name: "Ada", runtime_id: null, updated_at: "2026-01-01T08:00:20+08:00" }])[0]?.updatedAt).toBe("2026-01-01T08:00:20+08:00");
	});

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

	it("handles runtime freshness and recent completions with finite-safe boundaries", () => {
		const agent = adaptAgents([{ id: agentId, name: "Ada", runtime_id: runtimeId, status: "idle", updated_at: now.toISOString() }])[0]!;
		const runtime = adaptRuntimes([{ id: runtimeId, name: "Local", status: "online", last_seen_at: "2025-12-31T23:59:50Z" }])[0]!;
		const state = (lastSeenAt: string | null, mappedNow = now) => mapAgentStates([agent], [{ ...runtime, lastSeenAt }], [], [], { now: mappedNow })[0]?.state;
		expect(state("2025-12-31T23:59:50Z")).toBe("idle");
		expect(state("2025-12-31T23:59:49.999Z")).toBe("offline");
		expect(state("2026-01-01T00:01:00Z")).toBe("idle");
		expect(state("invalid")).toBe("offline");
		expect(state(null)).toBe("offline");
		expect(state(now.toISOString(), new Date(Number.NaN))).toBe("offline");

		const completed = {
			id: runId,
			issueId,
			agentId,
			runtimeId,
			status: "completed" as const,
			startedAt: null,
			completedAt: "2026-01-01T00:00:05Z",
		};
		const completedState = (completedAt: string | null) => mapAgentStates([agent], [{ ...runtime, lastSeenAt: now.toISOString() }], [], [{ ...completed, completedAt }], { now })[0]?.state;
		expect(completedState("2026-01-01T00:00:05Z")).toBe("done");
		expect(completedState("2026-01-01T00:00:04.999Z")).toBe("idle");
		expect(completedState("2026-01-01T00:00:21Z")).toBe("idle");
		expect(completedState("invalid")).toBe("idle");
		expect(completedState(null)).toBe("idle");
	});
});
