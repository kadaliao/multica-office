export type OfficeState =
	| "offline"
	| "idle"
	| "queued"
	| "working"
	| "blocked"
	| "done";

export type SourceState = "ok" | "stale" | "error";
export type SourceName = "agents" | "runtimes" | "issues" | "runs";

export interface BridgeError {
	code:
		| "auth_required"
		| "forbidden"
		| "not_found"
		| "unavailable"
		| "timeout"
		| "output_too_large"
		| "invalid_json"
		| "schema_mismatch"
		| "unknown";
	retryable: boolean;
	message: string;
}

export interface SourceStatus {
	state: SourceState;
	observedAt?: string;
	error?: BridgeError;
}

export interface OfficeRuntime {
	id: string;
	name: string;
	state: "online" | "offline" | "unknown";
	lastSeenAt: string | null;
}

export interface OfficeIssue {
	id: string;
	identifier: string;
	title: string;
	status:
		| "backlog"
		| "todo"
		| "in_progress"
		| "in_review"
		| "blocked"
		| "done"
		| "cancelled"
		| "unknown";
	priority: string;
	assignee: { type: "agent" | "squad" | "member"; id: string } | null;
	updatedAt: string;
}

export interface OfficeRun {
	id: string;
	issueId: string;
	agentId: string | null;
	runtimeId: string | null;
	status:
		| "queued"
		| "dispatched"
		| "running"
		| "completed"
		| "failed"
		| "cancelled"
		| "unknown";
	startedAt: string | null;
	completedAt: string | null;
}

export interface OfficeAgent {
	id: string;
	name: string;
	runtimeId: string | null;
	state: OfficeState;
	issueId: string | null;
	runId: string | null;
	activeCount: number;
	updatedAt: string;
}

export interface OfficeSnapshot {
	schemaVersion: 1;
	generatedAt: string;
	sequence: number;
	sources: Record<SourceName, SourceStatus>;
	agents: OfficeAgent[];
	runtimes: OfficeRuntime[];
	issues: OfficeIssue[];
	runs: OfficeRun[];
}

export interface OfficeEvent {
	id: string;
	sequence: number;
	occurredAt: string;
	kind:
		| "agent_state_changed"
		| "issue_status_changed"
		| "run_started"
		| "run_completed"
		| "run_failed"
		| "snapshot_degraded"
		| "snapshot_recovered";
	entityId: string;
	from?: string;
	to?: string;
}
