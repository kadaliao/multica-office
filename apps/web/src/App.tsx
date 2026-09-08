import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, PlugZap, RefreshCw, RotateCcw, Users } from "lucide-react";
import type { OfficeAgent, OfficeState } from "@multica-office/contracts";
import { OfficeScene } from "./OfficeScene.js";
import { filterAgents, hasUnavailableAgentData, issueForAgent, OFFICE_STATES, requiresAuthentication, runtimeLabelForAgent, sourceProblems, STATE_LABELS, timeAgo } from "./model.js";
import { useOfficeData } from "./useOfficeData.js";
import { compactStationName, MAX_NICKNAME_LENGTH, useAgentNicknames } from "./agentNames.js";
import { stationLabelGraphemes } from "./officeSceneLayout.js";

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

function AgentRow({ agent, name, selected, onSelect }: { agent: OfficeAgent; name: string; selected: boolean; onSelect: () => void }) {
	return (
		<button className="agent-row" title={agent.name} aria-pressed={selected} onClick={onSelect}>
			<span className="agent-initial">{stationLabelGraphemes(name)[0]}</span>
			<span className="agent-copy"><strong>{name}</strong><small><StatusMark state={agent.state} />{STATE_LABELS[agent.state]}</small></span>
			<span className="active-count">{agent.activeCount || "-"}</span>
		</button>
	);
}

function NicknameEditor({ nickname, save }: { nickname: string; save: (value: string) => boolean }) {
	const [value, setValue] = useState(nickname);
	const [message, setMessage] = useState("");
	const commit = (name: string) => {
		const trimmed = name.trim();
		if (stationLabelGraphemes(trimmed).length > MAX_NICKNAME_LENGTH) {
			setMessage(`Use ${MAX_NICKNAME_LENGTH} characters or fewer.`);
			return;
		}
		setValue(trimmed);
		setMessage(save(trimmed) ? (trimmed ? "Nickname saved." : "Original name restored.") : "Applied for this tab only. Browser storage is unavailable.");
	};
	return <form className="nickname-editor" onSubmit={(event) => { event.preventDefault(); commit(value); }}>
		<label htmlFor="office-nickname">Office nickname</label>
		<div className="nickname-controls">
			<input id="office-nickname" value={value} onChange={(event) => setValue(event.target.value)} maxLength={160} autoComplete="off" placeholder="Choose a short name" aria-describedby="nickname-help" />
			<button type="submit">Save</button>
			{nickname && <button type="button" onClick={() => commit("")}>Reset</button>}
		</div>
		<p id="nickname-help">Only in this browser. Multica names stay unchanged.</p>
		{message && <p role="status">{message}</p>}
	</form>;
}

export function App() {
	const { snapshot, connection, error, refreshError, refresh, reconnect } = useOfficeData();
	const [filter, setFilter] = useState<OfficeState | "all">("all");
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const { nicknames, saveNickname } = useAgentNicknames();

	useEffect(() => {
		if (!snapshot?.agents.length) {
			setSelectedId(null);
			return;
		}
		if (!snapshot.agents.some((agent) => agent.id === selectedId)) setSelectedId(snapshot.agents[0]!.id);
	}, [snapshot, selectedId]);

	const visibleAgents = useMemo(() => snapshot ? filterAgents(snapshot.agents, filter) : [], [snapshot, filter]);
	const sceneAgents = useMemo(() => visibleAgents.map((agent) => ({ ...agent, name: nicknames[agent.id] || compactStationName(agent.name) })), [visibleAgents, nicknames]);
	const selectedAgent = snapshot?.agents.find((agent) => agent.id === selectedId);
	const selectedName = selectedAgent ? nicknames[selectedAgent.id] || selectedAgent.name : "";
	const selectedIssue = snapshot ? issueForAgent(selectedAgent, snapshot.issues) : undefined;
	const problems = snapshot ? sourceProblems(snapshot) : [];
	const authRequired = snapshot ? requiresAuthentication(snapshot) : false;
	const selectAgent = useCallback((id: string) => setSelectedId(id), []);

	if (!snapshot && connection === "loading") return <LoadingView />;
	if (!snapshot) return <OfflineView message={error ?? "No office data is available."} reconnect={reconnect} />;
	if (hasUnavailableAgentData(snapshot)) {
		const lastObserved = [snapshot.sources.agents.observedAt, snapshot.sources.runtimes.observedAt]
			.filter((value): value is string => Boolean(value)).sort()[0];
		return (
			<main className="offline-view" aria-live="polite">
				<div className="offline-symbol"><AlertTriangle size={30} strokeWidth={1.7} /></div>
				<h1>Office data is unavailable</h1>
				<p>The bridge cannot refresh Multica data. Agent availability cannot be determined.</p>
				{lastObserved && <p>Last successful update: <time dateTime={lastObserved}>{new Date(lastObserved).toLocaleString()}</time>.</p>}
				<p>{authRequired ? "Multica authentication is required. " : "Check the Multica connection and login on the host computer. "}For a persistent service, run <code>multica login</code> and restart Office from a regular terminal on that computer.</p>
				<button className="primary-button" onClick={reconnect}><RotateCcw size={16} /> Retry</button>
			</main>
		);
	}

	return (
		<div className="app-shell">
			<header className="topbar">
				<div className="brand-block"><span className="brand-glyph" aria-hidden="true"><i /><i /><i /></span><div><strong>Multica Office</strong><small>Studio floor</small></div></div>
				<div className="topbar-actions">
					<span className={`connection-pill connection-${connection === "live" && problems.length ? "degraded" : connection}`}><span />{connection === "live" ? problems.length ? "Data stale" : "Live" : connection === "reconnecting" ? "Reconnecting" : "Offline"}</span>
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
					<div className="scene-frame" role="region" aria-label="Scrollable office floor" tabIndex={0}>
						<OfficeScene agents={sceneAgents} selectedId={selectedId} onSelect={selectAgent} />
						{visibleAgents.length === 0 && !authRequired && <div className="empty-overlay"><Users size={25} /><strong>{snapshot.agents.length ? "No agents match this filter" : "The office is ready"}</strong><span>{snapshot.agents.length ? "Choose another status to see the floor." : "Agents appear here when the bridge reports them."}</span></div>}
					</div>
				</section>

				<aside className="inspector" aria-label="Agent details">
					<section className="detail-section selected-agent">
						<p className="section-label">Selected agent</p>
						{selectedAgent ? <>
							<div className="agent-heading"><span className="large-initial">{stationLabelGraphemes(selectedName)[0]}</span><div><h2>{selectedName}</h2><p><StatusMark state={selectedAgent.state} />{STATE_LABELS[selectedAgent.state]} · updated {timeAgo(selectedAgent.updatedAt)}</p></div></div>
							{nicknames[selectedAgent.id] && <p className="original-name">Multica name: {selectedAgent.name}</p>}
							<NicknameEditor key={selectedAgent.id} nickname={nicknames[selectedAgent.id] ?? ""} save={(value) => saveNickname(selectedAgent.id, value)} />
							<div className="metric-strip"><span><small>Active</small><strong>{selectedAgent.activeCount}</strong></span><span><small>Runtime</small><strong>{runtimeLabelForAgent(selectedAgent, snapshot.runtimes)}</strong></span><span><small>Run</small><strong>{selectedAgent.runId ? "Active" : "-"}</strong></span></div>
						</> : <p className="muted-copy">Select an agent from the floor.</p>}
					</section>

					<section className="detail-section issue-section">
						<p className="section-label">Current issue</p>
						{selectedIssue ? <div className="issue-summary"><span>{selectedIssue.identifier}</span><h3>{selectedIssue.title}</h3><dl><div><dt>Status</dt><dd>{selectedIssue.status.replaceAll("_", " ")}</dd></div><div><dt>Priority</dt><dd>{selectedIssue.priority}</dd></div></dl></div> : <p className="muted-copy">No current issue. This agent is available for work.</p>}
					</section>

					<section className="detail-section roster-section">
						<div className="section-heading"><p className="section-label">Agent roster</p><span>{visibleAgents.length}</span></div>
						<div className="agent-list">{visibleAgents.map((agent) => <AgentRow key={agent.id} agent={agent} name={nicknames[agent.id] || agent.name} selected={agent.id === selectedId} onSelect={() => setSelectedId(agent.id)} />)}</div>
					</section>
				</aside>
			</div>
		</div>
	);
}
