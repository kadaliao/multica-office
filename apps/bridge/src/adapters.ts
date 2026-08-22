import type {
	OfficeAgent,
	OfficeIssue,
	OfficeRun,
	OfficeRuntime,
	OfficeState,
} from "@multica-office/contracts";
import { z } from "zod";

const nullableString = z
	.string()
	.nullable()
	.optional()
	.transform((value) => value ?? null);

const timestamp = z.iso.datetime({ offset: true });
const nullableTimestamp = timestamp
	.nullable()
	.optional()
	.transform((value) => value ?? null);

const rawAgentSchema = z.object({
	id: z.uuid(),
	name: z.string(),
	runtime_id: nullableString,
	status: z.string().optional().default("unknown"),
	updated_at: timestamp,
});

const rawRuntimeSchema = z.object({
	id: z.uuid(),
	name: z.string().optional(),
	custom_name: nullableString,
	status: z.string().optional().default("unknown"),
	last_seen_at: nullableTimestamp,
});

const rawIssueSchema = z.object({
	id: z.uuid(),
	identifier: z.string(),
	title: z.string(),
	status: z.string(),
	priority: z.string().optional().default("none"),
	assignee_type: nullableString,
	assignee_id: nullableString,
	updated_at: timestamp,
});

const rawRunSchema = z.object({
	id: z.uuid(),
	issue_id: z.uuid(),
	agent_id: nullableString,
	runtime_id: nullableString,
	status: z.string(),
	started_at: nullableTimestamp,
	completed_at: nullableTimestamp,
});

const issuePageSchema = z.object({
	issues: z.array(z.unknown()),
	has_more: z.boolean(),
	offset: z.number().int().nonnegative(),
	limit: z.number().int().positive(),
});

export interface IssuePage {
	issues: OfficeIssue[];
	hasMore: boolean;
	nextOffset: number;
}

const issueStatuses = new Set([
	"backlog",
	"todo",
	"in_progress",
	"in_review",
	"blocked",
	"done",
	"cancelled",
]);
const runStatuses = new Set([
	"queued",
	"dispatched",
	"running",
	"completed",
	"failed",
	"cancelled",
]);
const terminalIssueStatuses = new Set(["done", "cancelled"]);

export function adaptAgents(
	input: unknown,
): Array<OfficeAgent & { rawStatus: string }> {
	return z
		.array(rawAgentSchema)
		.parse(input)
		.map((agent) => ({
			id: agent.id,
			name: agent.name,
			runtimeId: agent.runtime_id,
			state: "idle",
			issueId: null,
			runId: null,
			activeCount: 0,
			updatedAt: agent.updated_at,
			rawStatus: agent.status,
		}));
}

export function adaptRuntimes(input: unknown): OfficeRuntime[] {
	return z
		.array(rawRuntimeSchema)
		.parse(input)
		.map((runtime) => {
			let state: OfficeRuntime["state"] = "unknown";
			if (runtime.status === "online") state = "online";
			else if (runtime.status === "offline") state = "offline";
			return {
				id: runtime.id,
				name: runtime.custom_name ?? runtime.name ?? "Unnamed runtime",
				state,
				lastSeenAt: runtime.last_seen_at,
			};
		});
}

export function adaptIssuePage(input: unknown): IssuePage {
	const page = issuePageSchema.parse(input);
	return {
		issues: page.issues.map((entry) => {
			const issue = rawIssueSchema.parse(entry);
			let assignee: OfficeIssue["assignee"] = null;
			if (
				issue.assignee_id &&
				(issue.assignee_type === "agent" ||
					issue.assignee_type === "squad" ||
					issue.assignee_type === "member")
			) {
				assignee = { type: issue.assignee_type, id: issue.assignee_id };
			}
			return {
				id: issue.id,
				identifier: issue.identifier,
				title: issue.title,
				status: issueStatuses.has(issue.status)
					? (issue.status as OfficeIssue["status"])
					: "unknown",
				priority: issue.priority,
				assignee,
				updatedAt: issue.updated_at,
			};
		}),
		hasMore: page.has_more,
		nextOffset: page.offset + page.limit,
	};
}

export function adaptRuns(input: unknown): OfficeRun[] {
	return z
		.array(rawRunSchema)
		.parse(input)
		.map((run) => ({
			id: run.id,
			issueId: run.issue_id,
			agentId: run.agent_id,
			runtimeId: run.runtime_id,
			status: runStatuses.has(run.status)
				? (run.status as OfficeRun["status"])
				: "unknown",
			startedAt: run.started_at,
			completedAt: run.completed_at,
		}));
}

export function isActiveAgentIssue(issue: OfficeIssue): boolean {
	return (
		(issue.assignee?.type === "agent" || issue.assignee?.type === "squad")
		&& !terminalIssueStatuses.has(issue.status)
	);
}

export interface AgentStateOptions {
	now: Date;
	runtimeStaleMs?: number;
	doneTtlMs?: number;
}

export function mapAgentStates(
	agents: Array<OfficeAgent & { rawStatus?: string }>,
	runtimes: OfficeRuntime[],
	issues: OfficeIssue[],
	runs: OfficeRun[],
	options: AgentStateOptions,
): OfficeAgent[] {
	const runtimeById = new Map(runtimes.map((runtime) => [runtime.id, runtime]));
	const runtimeStaleMs = options.runtimeStaleMs ?? 30_000;
	const doneTtlMs = options.doneTtlMs ?? 15_000;
	const now = options.now.getTime();

	return agents.map(({ rawStatus, ...agent }) => {
		const assignedIssues = issues.filter(
			(issue) =>
				issue.assignee?.type === "agent" && issue.assignee.id === agent.id,
		);
		const issueIds = new Set(assignedIssues.map((issue) => issue.id));
		const relatedRuns = runs.filter(
			(run) => run.agentId === agent.id || issueIds.has(run.issueId),
		);
		const running = relatedRuns.find((run) => run.status === "running");
		const waiting = relatedRuns.find(
			(run) => run.status === "queued" || run.status === "dispatched",
		);
		const blocked = assignedIssues.find((issue) => issue.status === "blocked");
		const activeIssue = assignedIssues.find(
			(issue) => !terminalIssueStatuses.has(issue.status),
		);
		const recentDone = relatedRuns.find((run) => {
			if (run.status !== "completed" || !run.completedAt) return false;
			const completedAt = Date.parse(run.completedAt);
			const age = now - completedAt;
			return Number.isFinite(now)
				&& Number.isFinite(completedAt)
				&& age >= 0
				&& age <= doneTtlMs;
		});
		const runtime = agent.runtimeId
			? runtimeById.get(agent.runtimeId)
			: undefined;
		const lastSeenAt = runtime?.lastSeenAt ? Date.parse(runtime.lastSeenAt) : Number.NaN;
		const runtimeAge = now - lastSeenAt;
		const runtimeStale = !Number.isFinite(now)
			|| !Number.isFinite(lastSeenAt)
			|| runtimeAge > runtimeStaleMs;

		let state: OfficeState = "idle";
		if (!runtime || runtime.state !== "online" || runtimeStale)
			state = "offline";
		else if (running || (rawStatus === "working" && activeIssue)) state = "working";
		else if (blocked) state = "blocked";
		else if (waiting || activeIssue) state = "queued";
		else if (recentDone) state = "done";

		const selectedRun = running ?? waiting ?? recentDone;
		const selectedIssue = selectedRun
				? issues.find((issue) => issue.id === selectedRun.issueId)
				: activeIssue;
		return {
			...agent,
			state,
			issueId: selectedIssue?.id ?? null,
			runId: selectedRun?.id ?? null,
			activeCount: assignedIssues.filter(
				(issue) => !terminalIssueStatuses.has(issue.status),
			).length,
		};
	});
}
