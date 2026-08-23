import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, PlugZap, RefreshCw, RotateCcw, Users } from "lucide-react";
import type { OfficeAgent, OfficeState } from "@multica-office/contracts";
import { OfficeScene } from "./OfficeScene.js";
import { filterAgents, issueForAgent, OFFICE_STATES, requiresAuthentication, runtimeLabelForAgent, sourceProblems, STATE_LABELS, timeAgo } from "./model.js";
import { useOfficeData } from "./useOfficeData.js";

function StatusMark({ state }: { state: OfficeState }) {
	return <span className={`status-mark status-${state}`} aria-hidden="true" />;
}

function LoadingView() {
	return (
		<main className="loading-view" aria-live="polite">
			<div className="loading-grid" aria-hidden="true">{Array.from({ length: 6 }, (_, index) => <span key={index} />)}</div>
			<p>Opening the office...</p>
		</main>
	);
}

function OfflineView({ message, reconnect }: { message: string; reconnect: () => void }) {
	return (
		<main className="offline-view">
			<div className="offline-symbol"><PlugZap size={30} strokeWidth={1.7} /></div>
			<h1>Office bridge is offline</h1>
			<p>{message} Start the local bridge, then reconnect.</p>
			<button className="primary-button" onClick={reconnect}><RotateCcw size={16} /> Reconnect</button>
		</main>
	);
}

function AgentRow({ agent, selected, onSelect }: { agent: OfficeAgent; selected: boolean; onSelect: () => void }) {
	return (
		<button className="agent-row" aria-pressed={selected} onClick={onSelect}>
			<span className="agent-initial">{agent.name.slice(0, 1).toUpperCase()}</span>
			<span className="agent-copy"><strong>{agent.name}</strong><small><StatusMark state={agent.state} />{STATE_LABELS[agent.state]}</small></span>
			<span className="active-count">{agent.activeCount || "-"}</span>
		</button>
	);
}

export function App() {
	const { snapshot, connection, error, refreshError, refresh, reconnect } = useOfficeData();
	const [filter, setFilter] = useState<OfficeState | "all">("all");
	const [selectedId, setSelectedId] = useState<string | null>(null);

	useEffect(() => {
		if (!snapshot?.agents.length) {
			setSelectedId(null);
			return;
		}
		if (!snapshot.agents.some((agent) => agent.id === selectedId)) setSelectedId(snapshot.agents[0]!.id);
	}, [snapshot, selectedId]);

	const visibleAgents = useMemo(() => snapshot ? filterAgents(snapshot.agents, filter) : [], [snapshot, filter]);
	const selectedAgent = snapshot?.agents.find((agent) => agent.id === selectedId);
	const selectedIssue = snapshot ? issueForAgent(selectedAgent, snapshot.issues) : undefined;
	const problems = snapshot ? sourceProblems(snapshot) : [];
	const authRequired = snapshot ? requiresAuthentication(snapshot) : false;
	const selectAgent = useCallback((id: string) => setSelectedId(id), []);

	if (!snapshot && connection === "loading") return <LoadingView />;
	if (!snapshot) return <OfflineView message={error ?? "No office data is available."} reconnect={reconnect} />;

	return (
		<div className="app-shell">
			<header className="topbar">
				<div className="brand-block"><span className="brand-glyph" aria-hidden="true"><i /><i /><i /></span><div><strong>Multica Office</strong><small>Studio floor</small></div></div>
				<div className="topbar-actions">
					<span className={`connection-pill connection-${connection}`}><span />{connection === "live" ? "Live" : connection === "reconnecting" ? "Reconnecting" : "Offline"}</span>
					<button className="icon-button" onClick={refresh} title="Refresh snapshot" aria-label="Refresh snapshot"><RefreshCw size={17} /></button>
					{connection !== "live" && <button className="icon-button" onClick={reconnect} title="Reconnect to bridge" aria-label="Reconnect to bridge"><RotateCcw size={17} /></button>}
				</div>
			</header>

			{authRequired ? <div className="degraded-banner" role="status"><AlertTriangle size={16} /><span>Multica sign-in is required. Run <code>multica login</code>, then reconnect.</span></div>
				: problems.length > 0 && <div className="degraded-banner" role="status"><AlertTriangle size={16} /><span>Some data is stale: {problems.join(", ")}. Last-known values remain visible.</span></div>}
			{refreshError && <div className="refresh-error-banner" role="alert"><AlertTriangle size={16} /><span>Refresh failed: {refreshError} Last-known snapshot remains visible.</span></div>}

			<div className="workspace">
				<section className="floor-panel" aria-label="Office floor">
					<div className="floor-toolbar">
						<div><h1>Today&apos;s floor</h1><p>{snapshot.agents.length} agents · snapshot {snapshot.sequence}</p></div>
						<div className="filters" aria-label="Filter agents by status">
							<button aria-pressed={filter === "all"} onClick={() => setFilter("all")}>All <b>{snapshot.agents.length}</b></button>
							{OFFICE_STATES.map((state) => {
								const count = snapshot.agents.filter((agent) => agent.state === state).length;
								return <button key={state} aria-pressed={filter === state} onClick={() => setFilter(state)}><StatusMark state={state} />{STATE_LABELS[state]} <b>{count}</b></button>;
							})}
						</div>
					</div>
					<div className="scene-frame">
						<OfficeScene agents={visibleAgents} selectedId={selectedId} onSelect={selectAgent} />
						{visibleAgents.length === 0 && !authRequired && <div className="empty-overlay"><Users size={25} /><strong>{snapshot.agents.length ? "No agents match this filter" : "The office is ready"}</strong><span>{snapshot.agents.length ? "Choose another status to see the floor." : "Agents appear here when the bridge reports them."}</span></div>}
					</div>
				</section>

				<aside className="inspector" aria-label="Agent details">
					<section className="detail-section selected-agent">
						<p className="section-label">Selected agent</p>
						{selectedAgent ? <>
							<div className="agent-heading"><span className="large-initial">{selectedAgent.name.slice(0, 1)}</span><div><h2>{selectedAgent.name}</h2><p><StatusMark state={selectedAgent.state} />{STATE_LABELS[selectedAgent.state]} · updated {timeAgo(selectedAgent.updatedAt)}</p></div></div>
							<div className="metric-strip"><span><small>Active</small><strong>{selectedAgent.activeCount}</strong></span><span><small>Runtime</small><strong>{runtimeLabelForAgent(selectedAgent, snapshot.runtimes)}</strong></span><span><small>Run</small><strong>{selectedAgent.runId ? "Active" : "-"}</strong></span></div>
						</> : <p className="muted-copy">Select an agent from the floor.</p>}
					</section>

					<section className="detail-section issue-section">
						<p className="section-label">Current issue</p>
						{selectedIssue ? <div className="issue-summary"><span>{selectedIssue.identifier}</span><h3>{selectedIssue.title}</h3><dl><div><dt>Status</dt><dd>{selectedIssue.status.replaceAll("_", " ")}</dd></div><div><dt>Priority</dt><dd>{selectedIssue.priority}</dd></div></dl></div> : <p className="muted-copy">No current issue. This agent is available for work.</p>}
					</section>

					<section className="detail-section roster-section">
						<div className="section-heading"><p className="section-label">Agent roster</p><span>{visibleAgents.length}</span></div>
						<div className="agent-list">{visibleAgents.map((agent) => <AgentRow key={agent.id} agent={agent} selected={agent.id === selectedId} onSelect={() => setSelectedId(agent.id)} />)}</div>
					</section>
				</aside>
			</div>
		</div>
	);
}
