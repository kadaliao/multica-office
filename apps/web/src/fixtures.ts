import type { OfficeSnapshot, OfficeState } from "@multica-office/contracts";

const states: OfficeState[] = ["working", "queued", "blocked", "idle", "done", "offline"];
const names = ["Mira", "Jun", "Avery", "Sol", "Inez", "Noor"];
const longNames = [
	"Product Engineer - Codex - MacBook Pro",
	"Runtime Reliability Coordination Specialist",
	"Workspace Integration Architecture Lead",
	"Customer Operations Automation Engineer",
	"Developer Experience and Tooling Coordinator",
	"Local Bridge Observability Specialist",
];
const unicodeNames = [
	"产品工程师与自动化协调负责人",
	"👩🏽‍💻 Runtime 可靠性工程师",
	"Multica 工作区集成架构师",
	"👨‍👩‍👧‍👦 Local Agent Office 导航员",
	"De\u0301veloppeur 体验协调负责人",
	"က္က".repeat(12),
	"ក្ស".repeat(12),
	"ক্ষ".repeat(12),
	"क्ष".repeat(12),
];
const now = new Date().toISOString();

export const fixtureSnapshot: OfficeSnapshot = {
	schemaVersion: 1,
	generatedAt: now,
	sequence: 42,
	sources: {
		agents: { state: "ok", observedAt: now },
		runtimes: { state: "ok", observedAt: now },
		issues: { state: "ok", observedAt: now },
		runs: { state: "ok", observedAt: now },
	},
	agents: names.map((name, index) => ({
		id: `agent-${index}`,
		name,
		runtimeId: index === 5 ? null : `runtime-${index}`,
		state: states[index]!,
		issueId: index < 3 ? `issue-${index}` : null,
		runId: index < 2 ? `run-${index}` : null,
		activeCount: index < 3 ? 1 : 0,
		updatedAt: new Date(Date.now() - index * 73_000).toISOString(),
	})),
	runtimes: names.slice(0, 5).map((name, index) => ({
		id: `runtime-${index}`,
		name: `${name}'s Mac`,
		state: "online",
		lastSeenAt: now,
	})),
	issues: [
		{ id: "issue-0", identifier: "MUL-842", title: "Tune event stream reconnects", status: "in_progress", priority: "high", assignee: { type: "agent", id: "agent-0" }, updatedAt: now },
		{ id: "issue-1", identifier: "MUL-861", title: "Review the workspace command palette", status: "todo", priority: "medium", assignee: { type: "agent", id: "agent-1" }, updatedAt: now },
		{ id: "issue-2", identifier: "MUL-839", title: "Restore the nightly fixture export", status: "blocked", priority: "high", assignee: { type: "agent", id: "agent-2" }, updatedAt: now },
	],
	runs: [
		{ id: "run-0", issueId: "issue-0", agentId: "agent-0", runtimeId: "runtime-0", status: "running", startedAt: new Date(Date.now() - 180_000).toISOString(), completedAt: null },
		{ id: "run-1", issueId: "issue-1", agentId: "agent-1", runtimeId: "runtime-1", status: "queued", startedAt: null, completedAt: null },
	],
};

function withAgentCount(snapshot: OfficeSnapshot, count?: number): OfficeSnapshot {
	if (count === undefined || !Number.isInteger(count) || count < 0) return snapshot;
	const agents = Array.from({ length: count }, (_, index) => {
		const source = snapshot.agents[index % snapshot.agents.length]!;
		const suffix = index < snapshot.agents.length ? "" : ` ${Math.floor(index / snapshot.agents.length) + 1}`;
		return {
			...source,
			id: `agent-${index}`,
			name: `${source.name}${suffix}`,
			runtimeId: source.runtimeId ? `runtime-${index}` : null,
			issueId: index < fixtureSnapshot.issues.length ? `issue-${index}` : null,
			runId: index < fixtureSnapshot.runs.length ? `run-${index}` : null,
		};
	});
	const runtimes = agents.flatMap((agent) => agent.runtimeId ? [{ id: agent.runtimeId, name: `${agent.name}'s Mac`, state: "online" as const, lastSeenAt: now }] : []);
	return { ...snapshot, agents, runtimes };
}

export function fixtureFor(name: string, agentCount?: number): OfficeSnapshot | null {
	if (name === "ready") return withAgentCount(fixtureSnapshot, agentCount);
	if (name === "long-names") return withAgentCount({
		...fixtureSnapshot,
		agents: fixtureSnapshot.agents.map((agent, index) => ({ ...agent, name: longNames[index]! })),
	}, agentCount);
	if (name === "unicode-names") return withAgentCount({
		...fixtureSnapshot,
		agents: unicodeNames.map((name, index) => ({
			...fixtureSnapshot.agents[index % fixtureSnapshot.agents.length]!,
			id: `unicode-agent-${index}`,
			name,
			issueId: null,
			runId: null,
		})),
	}, agentCount);
	if (name === "empty") return { ...fixtureSnapshot, agents: [], issues: [], runs: [] };
	if (name === "degraded") return {
		...fixtureSnapshot,
		sources: {
			...fixtureSnapshot.sources,
			issues: {
				state: "stale",
				observedAt: now,
				error: { code: "timeout", retryable: true, message: "Issue data is temporarily stale." },
			},
		},
	};
	if (name === "auth-required") return {
		...fixtureSnapshot,
		agents: [],
		issues: [],
		runs: [],
		sources: Object.fromEntries(
			Object.keys(fixtureSnapshot.sources).map((source) => [source, {
				state: "error",
				error: { code: "auth_required", retryable: false, message: "Multica CLI is not signed in." },
			}]),
		) as OfficeSnapshot["sources"],
	};
	if (name === "stale-auth-required") return {
		...fixtureSnapshot,
		sources: {
			...fixtureSnapshot.sources,
			agents: {
				state: "stale",
				observedAt: now,
				error: { code: "auth_required", retryable: false, message: "Multica CLI is not signed in." },
			},
		},
	};
	if (name === "data-unavailable") return {
		...fixtureSnapshot,
		agents: fixtureSnapshot.agents.map((agent) => ({ ...agent, state: "offline" })),
		sources: Object.fromEntries(
			Object.keys(fixtureSnapshot.sources).map((source) => [source, {
				state: "stale",
				observedAt: "2026-01-01T00:00:00Z",
				error: { code: "unknown", retryable: true, message: "Local data could not be read." },
			}]),
		) as OfficeSnapshot["sources"],
	};
	return null;
}
