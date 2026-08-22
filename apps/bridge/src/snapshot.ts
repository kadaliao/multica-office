import { randomUUID } from "node:crypto";
import type {
	BridgeError,
	OfficeEvent,
	OfficeIssue,
	OfficeRun,
	OfficeRuntime,
	OfficeSnapshot,
	SourceName,
	SourceStatus,
} from "@multica-office/contracts";
import { ZodError } from "zod";
import {
	adaptAgents,
	adaptIssuePage,
	adaptRuns,
	adaptRuntimes,
	isActiveAgentIssue,
	mapAgentStates,
} from "./adapters.js";
import { CliFailure, type CliRunner } from "./runner.js";

const SOURCE_NAMES: SourceName[] = ["agents", "runtimes", "issues", "runs"];
const EMPTY_SOURCE = (): Record<SourceName, SourceStatus> => ({
	agents: { state: "stale" },
	runtimes: { state: "stale" },
	issues: { state: "stale" },
	runs: { state: "stale" },
});

interface LastGood {
	agents?: ReturnType<typeof adaptAgents>;
	runtimes?: OfficeRuntime[];
	issues?: OfficeIssue[];
	runs?: OfficeRun[];
}

type SnapshotListener = (
	snapshot: OfficeSnapshot,
	events: OfficeEvent[],
) => void;

function publicError(error: unknown): BridgeError {
	if (error instanceof CliFailure) return error.detail;
	if (error instanceof ZodError) {
		return {
			code: "schema_mismatch",
			retryable: true,
			message: "Multica CLI data format is not compatible.",
		};
	}
	return {
		code: "unknown",
		retryable: true,
		message: "Local data could not be read.",
	};
}

function failedSource(previous: SourceStatus, error: unknown): SourceStatus {
	return {
		state: previous.observedAt ? "stale" : "error",
		...(previous.observedAt ? { observedAt: previous.observedAt } : {}),
		error: publicError(error),
	};
}

function changedPayload(snapshot: OfficeSnapshot): string {
	return JSON.stringify({
		sources: snapshot.sources,
		agents: snapshot.agents,
		runtimes: snapshot.runtimes,
		issues: snapshot.issues,
		runs: snapshot.runs,
	});
}

function diffEvents(
	bootId: string,
	previous: OfficeSnapshot,
	next: OfficeSnapshot,
): OfficeEvent[] {
	const result: OfficeEvent[] = [];
	const add = (
		event: Omit<OfficeEvent, "id" | "sequence" | "occurredAt">,
	): void => {
		result.push({
			...event,
			id: `${bootId}:${next.sequence}:${result.length}`,
			sequence: next.sequence,
			occurredAt: next.generatedAt,
		});
	};

	const previousAgents = new Map(
		previous.agents.map((agent) => [agent.id, agent]),
	);
	for (const agent of next.agents) {
		const before = previousAgents.get(agent.id);
		if (before && before.state !== agent.state) {
			add({
				kind: "agent_state_changed",
				entityId: agent.id,
				from: before.state,
				to: agent.state,
			});
		}
	}
	const previousIssues = new Map(
		previous.issues.map((issue) => [issue.id, issue]),
	);
	for (const issue of next.issues) {
		const before = previousIssues.get(issue.id);
		if (before && before.status !== issue.status) {
			add({
				kind: "issue_status_changed",
				entityId: issue.id,
				from: before.status,
				to: issue.status,
			});
		}
	}
	const previousRuns = new Map(previous.runs.map((run) => [run.id, run]));
	for (const run of next.runs) {
		const before = previousRuns.get(run.id);
		if (!before || before.status === run.status) continue;
		if (run.status === "running")
			add({
				kind: "run_started",
				entityId: run.id,
				from: before.status,
				to: run.status,
			});
		if (run.status === "completed")
			add({
				kind: "run_completed",
				entityId: run.id,
				from: before.status,
				to: run.status,
			});
		if (run.status === "failed")
			add({
				kind: "run_failed",
				entityId: run.id,
				from: before.status,
				to: run.status,
			});
	}
	for (const source of SOURCE_NAMES) {
		const before = previous.sources[source].state;
		const after = next.sources[source].state;
		if (before === after) continue;
		if (after === "ok")
			add({
				kind: "snapshot_recovered",
				entityId: source,
				from: before,
				to: after,
			});
		else
			add({
				kind: "snapshot_degraded",
				entityId: source,
				from: before,
				to: after,
			});
	}
	return result;
}

export interface SnapshotServiceOptions {
	now?: () => Date;
	maxRunIssues?: number;
	eventCapacity?: number;
}

export class SnapshotService {
	readonly bootId = randomUUID();
	private readonly listeners = new Set<SnapshotListener>();
	private readonly lastGood: LastGood = {};
	private readonly events: OfficeEvent[] = [];
	private snapshot: OfficeSnapshot;
	private refreshPromise: Promise<OfficeSnapshot> | null = null;
	private runCursor = 0;

	constructor(
		private readonly runner: CliRunner,
		private readonly options: SnapshotServiceOptions = {},
	) {
		this.snapshot = {
			schemaVersion: 1,
			generatedAt: (options.now?.() ?? new Date()).toISOString(),
			sequence: 0,
			sources: EMPTY_SOURCE(),
			agents: [],
			runtimes: [],
			issues: [],
			runs: [],
		};
	}

	getSnapshot(): OfficeSnapshot {
		return this.snapshot;
	}

	getEvents(afterSequence = -1): OfficeEvent[] {
		return this.events.filter((event) => event.sequence > afterSequence);
	}

	subscribe(listener: SnapshotListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	refresh(): Promise<OfficeSnapshot> {
		if (this.refreshPromise) return this.refreshPromise;
		this.refreshPromise = this.performRefresh().finally(() => {
			this.refreshPromise = null;
		});
		return this.refreshPromise;
	}

	private async fetchIssues(): Promise<OfficeIssue[]> {
		const issues: OfficeIssue[] = [];
		let offset = 0;
		for (let pages = 0; pages < 1_000; pages += 1) {
			const page = adaptIssuePage(
				await this.runner.run({ key: "issues", offset }),
			);
			issues.push(...page.issues);
			if (!page.hasMore) return issues;
			if (page.nextOffset <= offset)
				throw new Error("Issue pagination did not advance");
			offset = page.nextOffset;
		}
		throw new Error("Issue pagination exceeded safety limit");
	}

	private async fetchRuns(
		issues: OfficeIssue[],
	): Promise<{ runs: OfficeRun[]; complete: boolean; error?: unknown }> {
		const candidates = issues.filter(isActiveAgentIssue);
		const max = this.options.maxRunIssues ?? 32;
		if (!Number.isInteger(max) || max < 1)
			throw new Error("maxRunIssues must be a positive integer");
		const selected: OfficeIssue[] = [];
		const selectedCount = Math.min(candidates.length, max);
		for (let index = 0; index < selectedCount; index += 1) {
			const candidate =
				candidates[(this.runCursor + index) % candidates.length];
			if (candidate) selected.push(candidate);
		}
		this.runCursor = candidates.length
			? (this.runCursor + selected.length) % candidates.length
			: 0;
		const settled = await Promise.allSettled(
			selected.map(async (issue) => ({
				issueId: issue.id,
				runs: adaptRuns(
					await this.runner.run({ key: "issueRuns", issueId: issue.id }),
				),
			})),
		);
		const successful = settled.flatMap((result) =>
			result.status === "fulfilled" ? [result.value] : [],
		);
		const failure = settled.find((result) => result.status === "rejected");
		const refreshedIssueIds = new Set(
			successful.map((result) => result.issueId),
		);
		const currentIssueIds = new Set(issues.map((issue) => issue.id));
		const retained = (this.lastGood.runs ?? []).filter(
			(run) =>
				currentIssueIds.has(run.issueId) && !refreshedIssueIds.has(run.issueId),
		);
		const runs = [...retained, ...successful.flatMap((result) => result.runs)];
		return {
			runs,
			complete:
				candidates.length <= max && successful.length === selected.length,
			...(failure ? { error: failure.reason } : {}),
		};
	}

	private async performRefresh(): Promise<OfficeSnapshot> {
		const observedAt = (this.options.now?.() ?? new Date()).toISOString();
		const [agentsResult, runtimesResult, issuesResult] =
			await Promise.allSettled([
				this.runner.run({ key: "agents" }).then(adaptAgents),
				this.runner.run({ key: "runtimes" }).then(adaptRuntimes),
				this.fetchIssues(),
			]);
		const sources = structuredClone(this.snapshot.sources);

		if (agentsResult.status === "fulfilled") {
			this.lastGood.agents = agentsResult.value;
			sources.agents = { state: "ok", observedAt };
		} else sources.agents = failedSource(sources.agents, agentsResult.reason);

		if (runtimesResult.status === "fulfilled") {
			this.lastGood.runtimes = runtimesResult.value;
			sources.runtimes = { state: "ok", observedAt };
		} else
			sources.runtimes = failedSource(sources.runtimes, runtimesResult.reason);

		if (issuesResult.status === "fulfilled") {
			this.lastGood.issues = issuesResult.value;
			sources.issues = { state: "ok", observedAt };
		} else sources.issues = failedSource(sources.issues, issuesResult.reason);

		try {
			const runResult = await this.fetchRuns(this.lastGood.issues ?? []);
			this.lastGood.runs = runResult.runs;
			if (runResult.complete) sources.runs = { state: "ok", observedAt };
			else if ("error" in runResult) sources.runs = failedSource(sources.runs, runResult.error);
			else sources.runs = {
						state: "stale",
						observedAt,
						error: {
							code: "unknown",
							retryable: true,
							message: "Some run data is pending refresh.",
						},
					};
		} catch (error) {
			sources.runs = failedSource(sources.runs, error);
		}

		const generatedAt = (this.options.now?.() ?? new Date()).toISOString();
		const base = {
			schemaVersion: 1 as const,
			generatedAt,
			sequence: this.snapshot.sequence + 1,
			sources,
			runtimes: this.lastGood.runtimes ?? [],
			issues: this.lastGood.issues ?? [],
			runs: this.lastGood.runs ?? [],
		};
		const candidate: OfficeSnapshot = {
			...base,
			agents: mapAgentStates(
				this.lastGood.agents ?? [],
				base.runtimes,
				base.issues,
				base.runs,
				{ now: new Date(generatedAt) },
			),
		};
		if (changedPayload(candidate) === changedPayload(this.snapshot))
			return this.snapshot;

		const previous = this.snapshot;
		this.snapshot = candidate;
		const events = diffEvents(this.bootId, previous, candidate);
		this.events.push(...events);
		const capacity = this.options.eventCapacity ?? 100;
		if (this.events.length > capacity)
			this.events.splice(0, this.events.length - capacity);
		for (const listener of this.listeners) listener(candidate, events);
		return candidate;
	}
}
