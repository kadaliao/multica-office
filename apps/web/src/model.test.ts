import { describe, expect, it } from "vitest";
import { fixtureSnapshot } from "./fixtures.js";
import { filterAgents, issueForAgent, requiresAuthentication, runtimeLabelForAgent, sourceProblems, timeAgo } from "./model.js";

describe("office view model", () => {
	it("filters every mapped office state", () => {
		for (const state of ["working", "queued", "blocked", "idle", "done", "offline"] as const) {
			expect(filterAgents(fixtureSnapshot.agents, state)).toHaveLength(1);
			expect(filterAgents(fixtureSnapshot.agents, state)[0]?.state).toBe(state);
		}
		expect(filterAgents(fixtureSnapshot.agents, "all")).toHaveLength(6);
	});

	it("resolves an agent's active issue", () => {
		expect(issueForAgent(fixtureSnapshot.agents[0], fixtureSnapshot.issues)?.identifier).toBe("MUL-842");
		expect(issueForAgent(fixtureSnapshot.agents[4], fixtureSnapshot.issues)).toBeUndefined();
	});

	it("derives runtime labels from runtime records", () => {
		const agent = fixtureSnapshot.agents[0]!;
		const now = new Date("2026-08-21T10:00:00Z").getTime();
		const runtime = fixtureSnapshot.runtimes[0]!;
		expect(runtimeLabelForAgent(agent, [{ ...runtime, state: "online", lastSeenAt: "2026-08-21T09:59:40Z" }], now)).toBe("Online");
		expect(runtimeLabelForAgent(agent, [{ ...runtime, state: "online", lastSeenAt: "2026-08-21T09:59:30Z" }], now)).toBe("Online");
		expect(runtimeLabelForAgent(agent, [{ ...runtime, state: "online", lastSeenAt: "2026-08-21T09:59:29Z" }], now)).toBe("Stale");
		expect(runtimeLabelForAgent(agent, [{ ...runtime, state: "online", lastSeenAt: "2026-08-21T10:01:00Z" }], now)).toBe("Online");
		expect(runtimeLabelForAgent(agent, [{ ...runtime, state: "online", lastSeenAt: null }], now)).toBe("Unknown");
		expect(runtimeLabelForAgent(agent, [{ ...runtime, state: "online", lastSeenAt: "invalid" }], now)).toBe("Unknown");
		expect(runtimeLabelForAgent(agent, [{ ...runtime, state: "offline" }], now)).toBe("Offline");
		expect(runtimeLabelForAgent(agent, [{ ...runtime, state: "unknown" }], now)).toBe("Unknown");
		expect(runtimeLabelForAgent(agent, [], now)).toBe("Missing");
		expect(runtimeLabelForAgent({ ...agent, runtimeId: null }, fixtureSnapshot.runtimes, now)).toBe("None");
		expect(runtimeLabelForAgent(agent, [{ ...runtime, state: "online", lastSeenAt: "2026-08-21T09:59:40Z" }], Number.NaN)).toBe("Unknown");
	});

	it("reports only degraded sources", () => {
		const degraded = {
			...fixtureSnapshot,
			sources: { ...fixtureSnapshot.sources, issues: { state: "stale" as const } },
		};
		expect(sourceProblems(degraded)).toEqual(["issues stale"]);
		expect(requiresAuthentication(degraded)).toBe(false);
		expect(requiresAuthentication({
			...degraded,
			sources: { ...degraded.sources, issues: { state: "stale", error: { code: "auth_required", retryable: false, message: "Sign in." } } },
		})).toBe(true);
	});

	it("formats compact relative time", () => {
		const now = new Date("2026-08-21T10:00:00Z").getTime();
		expect(timeAgo("2026-08-21T09:59:40Z", now)).toBe("20s ago");
		expect(timeAgo("2026-08-21T09:42:00Z", now)).toBe("18m ago");
		expect(timeAgo("2026-08-21T10:01:00Z", now)).toBe("0s ago");
		expect(timeAgo("invalid", now)).toBe("unavailable");
		expect(timeAgo("2026-08-21T09:59:40Z", Number.NaN)).toBe("unavailable");
	});
});
