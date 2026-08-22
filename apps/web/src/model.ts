import type { OfficeAgent, OfficeIssue, OfficeRuntime, OfficeSnapshot, OfficeState } from "@multica-office/contracts";

export const OFFICE_STATES: readonly OfficeState[] = ["working", "queued", "blocked", "idle", "done", "offline"];
export const RUNTIME_STALE_MS = 30_000;

export const STATE_LABELS: Record<OfficeState, string> = {
	working: "Working",
	queued: "Queued",
	blocked: "Blocked",
	idle: "Available",
	done: "Done",
	offline: "Offline",
};

export function filterAgents(agents: OfficeAgent[], filter: OfficeState | "all"): OfficeAgent[] {
	return filter === "all" ? agents : agents.filter((agent) => agent.state === filter);
}

export function issueForAgent(agent: OfficeAgent | undefined, issues: OfficeIssue[]): OfficeIssue | undefined {
	return agent?.issueId ? issues.find((issue) => issue.id === agent.issueId) : undefined;
}

export function runtimeLabelForAgent(agent: OfficeAgent | undefined, runtimes: OfficeRuntime[], now = Date.now()): string {
	if (!agent?.runtimeId) return "None";
	const runtime = runtimes.find((candidate) => candidate.id === agent.runtimeId);
	if (!runtime) return "Missing";
	if (runtime.state === "offline") return "Offline";
	if (runtime.state === "unknown") return "Unknown";
	if (!runtime.lastSeenAt) return "Unknown";
	const lastSeenAt = Date.parse(runtime.lastSeenAt);
	if (!Number.isFinite(now) || !Number.isFinite(lastSeenAt)) return "Unknown";
	if (now - lastSeenAt > RUNTIME_STALE_MS) return "Stale";
	return "Online";
}

export function sourceProblems(snapshot: OfficeSnapshot): string[] {
	return Object.entries(snapshot.sources)
		.filter(([, source]) => source.state !== "ok")
		.map(([name, source]) => `${name} ${source.state}`);
}

export function timeAgo(value: string, now = Date.now()): string {
	const timestamp = Date.parse(value);
	if (!Number.isFinite(now) || !Number.isFinite(timestamp)) return "unavailable";
	const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	return `${Math.floor(minutes / 60)}h ago`;
}
