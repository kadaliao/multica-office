import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Application, Container, Graphics, Text } from "pixi.js";
import type { OfficeAgent, OfficeState } from "@multica-office/contracts";
import { computeOfficeLayout, stationIsWithinLayout, stationLabelMaxWidth, truncateMeasuredLabel, type OfficeLayout } from "./officeSceneLayout.js";
import { bindRendererLifecycle } from "./rendererLifecycle.js";

export const CONTEXT_RECOVERY_TIMEOUT_MS = 1_200;
export const STATION_LABEL_FONT = "600 12px ui-monospace, monospace";
const STATION_LABEL_STYLE = { fontFamily: "ui-monospace, monospace", fontSize: 12, fontWeight: "600" as const, fill: 0x14231f, align: "center" as const };

const COLORS = {
	ink: 0x14231f,
	floor: 0xd9ddd6,
	line: 0xc1c8c0,
	wall: 0x1f3d35,
	wood: 0xb88453,
	woodDark: 0x805b3e,
	screen: 0x182924,
	paper: 0xf4f6f3,
	plant: 0x4b7452,
};

const STATE_COLORS: Record<OfficeState, number> = {
	working: 0x2c7a68,
	queued: 0xd6a83a,
	blocked: 0xd85b46,
	idle: 0x3d6c8e,
	done: 0x6f8754,
	offline: 0x78817d,
};

interface AnimatedAgent {
	container: Container;
	halo: Graphics;
	screen: Graphics;
	state: OfficeState;
	baseY: number;
	phase: number;
}

interface StationLabelMetrics {
	labels: string[];
	widths: number[];
	maxWidth: number;
	fit: boolean;
}

function measureStationLabels(agents: OfficeAgent[], layout: OfficeLayout): StationLabelMetrics {
	const canvas = document.createElement("canvas");
	const context = canvas.getContext("2d");
	if (!context) return { labels: agents.map(() => ""), widths: agents.map(() => 0), maxWidth: 0, fit: false };
	context.font = STATION_LABEL_FONT;
	const maxWidth = stationLabelMaxWidth(layout.cellWidth);
	const measured = agents.map((agent) => truncateMeasuredLabel(agent.name, maxWidth, (value) => context.measureText(value).width));
	const labels = measured.map(({ text }) => text);
	const widths = measured.map(({ width }) => width);
	const bounds = widths.map((width, index) => ({
		left: (layout.stations[index]?.x ?? Number.NaN) - width / 2,
		right: (layout.stations[index]?.x ?? Number.NaN) + width / 2,
	}));
	const fit = widths.every((width) => Number.isFinite(width) && width <= maxWidth)
		&& bounds.length === layout.stations.length
		&& bounds.every(({ left, right }) => Number.isFinite(left) && Number.isFinite(right) && left >= 0 && right <= layout.width)
		&& bounds.every(({ right }, index) => (index + 1) % layout.columns === 0 || index === bounds.length - 1 || right < bounds[index + 1]!.left);
	return { labels, widths, maxWidth, fit };
}

function furniture(stage: Container, width: number, height: number): void {
	stage.addChild(new Graphics().rect(0, 0, width, height).fill(COLORS.floor));
	const grid = new Graphics();
	for (let x = 0; x < width; x += 32) grid.moveTo(x, 0).lineTo(x, height);
	for (let y = 0; y < height; y += 32) grid.moveTo(0, y).lineTo(width, y);
	grid.stroke({ color: COLORS.line, width: 1, alpha: 0.46 });
	stage.addChild(grid);

	stage.addChild(new Graphics().rect(0, 0, width, 22).fill(COLORS.wall));
	stage.addChild(new Graphics().rect(0, 0, 18, height).fill(COLORS.wall));
	if (width >= 560) {
		const meeting = new Graphics()
			.roundRect(width - 150, 34, 116, 56, 6).fill({ color: 0xe7e9e5, alpha: 0.92 })
			.roundRect(width - 136, 50, 88, 26, 4).fill(COLORS.wood)
			.circle(width - 144, 63, 8).fill(COLORS.woodDark)
			.circle(width - 40, 63, 8).fill(COLORS.woodDark);
		stage.addChild(meeting);
	}
	const plant = new Graphics()
		.rect(30, height - 54, 26, 28).fill(0x9a6646)
		.circle(36, height - 59, 16).fill(COLORS.plant)
		.circle(53, height - 66, 14).fill(0x5f875d)
		.circle(43, height - 78, 13).fill(0x3f684a);
	stage.addChild(plant);
}

function station(
	agent: OfficeAgent,
	x: number,
	y: number,
	selected: boolean,
	onSelect: (id: string) => void,
	phase: number,
	formattedLabel: string,
): AnimatedAgent {
	const group = new Container({ x, y });
	group.eventMode = "static";
	group.cursor = "pointer";
	group.hitArea = { contains: (px: number, py: number) => px >= -58 && px <= 58 && py >= -50 && py <= 68 };
	group.on("pointertap", () => onSelect(agent.id));

	const status = STATE_COLORS[agent.state];
	const selection = new Graphics().roundRect(-62, -53, 124, 126, 8).stroke({ color: selected ? 0x14231f : 0xffffff, width: selected ? 3 : 1, alpha: selected ? 0.9 : 0.5 });
	const desk = new Graphics()
		.roundRect(-54, -23, 108, 46, 4).fill(COLORS.wood)
		.rect(-49, 20, 9, 17).fill(COLORS.woodDark)
		.rect(40, 20, 9, 17).fill(COLORS.woodDark);
	const screen = new Graphics()
		.roundRect(-25, -43, 50, 30, 3).fill(COLORS.screen)
		.rect(-20, -38, 40, 19).fill({ color: status, alpha: agent.state === "offline" ? 0.25 : 0.72 })
		.rect(-4, -13, 8, 7).fill(COLORS.screen);
	const halo = new Graphics().circle(0, 39, 21).fill({ color: status, alpha: 0.2 });
	const avatar = new Graphics()
		.circle(0, 33, 12).fill(agent.state === "offline" ? 0xaeb5b1 : 0xe0a17a)
		.roundRect(-14, 44, 28, 22, 5).fill(status)
		.rect(-8, 31, 3, 3).fill(COLORS.ink)
		.rect(5, 31, 3, 3).fill(COLORS.ink);
	const marker = new Graphics().circle(43, -36, 6).fill(status).circle(43, -36, 2).fill(COLORS.paper);
	const label = new Text({
		text: formattedLabel,
		style: STATION_LABEL_STYLE,
		anchor: { x: 0.5, y: 0 },
		x: 0,
		y: 73,
	});
	group.addChild(selection, desk, screen, halo, avatar, marker, label);
	return { container: group, halo, screen, state: agent.state, baseY: y, phase };
}

function buildOffice(
	app: Application,
	agents: OfficeAgent[],
	selectedId: string | null,
	onSelect: (id: string) => void,
	labels: string[],
): AnimatedAgent[] {
	const width = app.renderer.width / app.renderer.resolution;
	const height = app.renderer.height / app.renderer.resolution;
	const layout = computeOfficeLayout(agents.length, width, height);
	const scene = new Container();
	furniture(scene, width, height);
	const animated = agents.map((agent, index) => {
		const { x, y } = layout.stations[index]!;
		const item = station(agent, x, y, agent.id === selectedId, onSelect, index * 0.8, labels[index] ?? "");
		scene.addChild(item.container);
		return item;
	});
	app.stage.addChild(scene);
	return animated;
}

function FallbackCanvas({ agents, selectedId, onSelect, labels }: { agents: OfficeAgent[]; selectedId: string | null; onSelect: (id: string) => void; labels: string[] }) {
	const ref = useRef<HTMLCanvasElement>(null);
	useEffect(() => {
		const canvas = ref.current;
		if (!canvas) return;
		const draw = () => {
			const context = canvas.getContext("2d");
			if (!context) return;
			const ratio = Math.min(2, window.devicePixelRatio || 1);
			const bounds = canvas.getBoundingClientRect();
			const layout = computeOfficeLayout(agents.length, bounds.width, bounds.height);
			canvas.width = Math.max(1, Math.round(bounds.width * ratio));
			canvas.height = Math.max(1, Math.round(bounds.height * ratio));
			context.setTransform(ratio, 0, 0, ratio, 0, 0);
			context.fillStyle = "#d9ddd6";
			context.fillRect(0, 0, bounds.width, bounds.height);
			context.strokeStyle = "rgba(193, 200, 192, .46)";
			context.lineWidth = 1;
			for (let x = 0; x < bounds.width; x += 32) {
				context.beginPath();
				context.moveTo(x, 0);
				context.lineTo(x, bounds.height);
				context.stroke();
			}
			for (let y = 0; y < bounds.height; y += 32) {
				context.beginPath();
				context.moveTo(0, y);
				context.lineTo(bounds.width, y);
				context.stroke();
			}
			context.fillStyle = "#1f3d35";
			context.fillRect(0, 0, bounds.width, 22);
			agents.forEach((agent, index) => {
				const { x, y } = layout.stations[index]!;
				if (agent.id === selectedId) {
					context.strokeStyle = "#14231f";
					context.lineWidth = 3;
					context.strokeRect(x - 62, y - 53, 124, 126);
				}
				context.fillStyle = "#b88453";
				context.fillRect(x - 48, y - 20, 96, 42);
				context.fillStyle = `#${STATE_COLORS[agent.state].toString(16).padStart(6, "0")}`;
				context.fillRect(x - 12, y + 34, 24, 22);
				context.beginPath();
				context.arc(x, y + 28, 11, 0, Math.PI * 2);
				context.fillStyle = agent.state === "offline" ? "#aeb5b1" : "#e0a17a";
				context.fill();
				context.fillStyle = "#14231f";
				context.font = STATION_LABEL_FONT;
				context.textAlign = "center";
				context.fillText(labels[index] ?? "", x, y + 76);
			});
		};
		draw();
		const resizeObserver = new ResizeObserver(draw);
		resizeObserver.observe(canvas);
		return () => resizeObserver.disconnect();
	}, [agents, selectedId, labels]);

	const handleClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
		const canvas = ref.current;
		if (!canvas) return;
		const bounds = canvas.getBoundingClientRect();
		const layout = computeOfficeLayout(agents.length, bounds.width, bounds.height);
		const x = event.clientX - bounds.left;
		const y = event.clientY - bounds.top;
		const index = layout.stations.findIndex((position) => Math.abs(position.x - x) <= 62 && y >= position.y - 53 && y <= position.y + 92);
		if (index >= 0) onSelect(agents[index]!.id);
	};
	return <canvas ref={ref} className="office-canvas fallback-canvas" aria-label="Office scene in compatibility mode" onClick={handleClick} />;
}

export function OfficeScene({ agents, selectedId, onSelect }: { agents: OfficeAgent[]; selectedId: string | null; onSelect: (id: string) => void }) {
	const hostRef = useRef<HTMLDivElement>(null);
	const appRef = useRef<Application | null>(null);
	const animatedRef = useRef<AnimatedAgent[]>([]);
	const sceneDataRef = useRef({ agents, selectedId, onSelect, labels: [] as string[] });
	const [fallback, setFallback] = useState(false);
	const [contextLost, setContextLost] = useState(false);
	const [tickerState, setTickerState] = useState<"initializing" | "running" | "stopped">("initializing");
	const [layout, setLayout] = useState(() => computeOfficeLayout(agents.length, 320, 430));
	const [rendererRevision, setRendererRevision] = useState(0);
	const [fontRevision, setFontRevision] = useState(0);
	const labelMetrics = useMemo(() => measureStationLabels(agents, layout), [agents, layout, fontRevision]);
	sceneDataRef.current = { agents, selectedId, onSelect, labels: labelMetrics.labels };

	const rebuildStage = useCallback(() => {
		const app = appRef.current;
		if (!app) return;
		app.stage.removeChildren().forEach((child) => child.destroy({ children: true }));
		const current = sceneDataRef.current;
		animatedRef.current = buildOffice(app, current.agents, current.selectedId, current.onSelect, current.labels);
	}, []);

	useEffect(() => {
		let disposed = false;
		const refreshMetrics = () => {
			if (!disposed) setFontRevision((current) => current + 1);
		};
		void document.fonts.ready.then(refreshMetrics);
		document.fonts.addEventListener("loadingdone", refreshMetrics);
		return () => {
			disposed = true;
			document.fonts.removeEventListener("loadingdone", refreshMetrics);
		};
	}, []);

	useLayoutEffect(() => {
		const host = hostRef.current;
		const frame = host?.parentElement;
		if (!host || !frame) return;
		const updateLayout = () => {
			const next = computeOfficeLayout(agents.length, frame.clientWidth, frame.clientHeight);
			setLayout((current) => current.width === next.width && current.height === next.height && current.stations.length === next.stations.length ? current : next);
		};
		updateLayout();
		const observer = new ResizeObserver(updateLayout);
		observer.observe(frame);
		return () => observer.disconnect();
	}, [agents.length]);

	useEffect(() => {
		if (fallback) return;
		const host = hostRef.current;
		if (!host) return;
		setTickerState("initializing");
		let disposed = false;
		let app: Application | null = null;
		let initialized = false;
		let resizeObserver: ResizeObserver | null = null;
		let releaseLifecycle: (() => void) | null = null;
		void (async () => {
			try {
				app = new Application();
				await app.init({ resizeTo: host, background: COLORS.floor, antialias: false, autoDensity: true, resolution: Math.min(2, window.devicePixelRatio || 1), preference: "webgl" });
				initialized = true;
				if (disposed) {
					app.destroy(true, { children: true });
					return;
				}
				app.canvas.className = "office-canvas";
				app.canvas.setAttribute("aria-label", "Interactive Multica office floor");
				host.appendChild(app.canvas);
				appRef.current = app;
				setContextLost(false);
				rebuildStage();
				setRendererRevision((current) => current + 1);
				const resize = () => {
					if (!app || appRef.current !== app) return;
					app.resize();
					rebuildStage();
				};
				resizeObserver = new ResizeObserver(resize);
				resizeObserver.observe(host);
				app.ticker.add((ticker) => {
					const seconds = ticker.lastTime / 1000;
					for (const item of animatedRef.current) {
						const wave = Math.sin(seconds * 2.4 + item.phase);
						item.container.y = item.baseY + (item.state === "working" ? wave * 2 : 0);
						item.halo.alpha = item.state === "blocked" ? 0.16 + Math.abs(wave) * 0.28 : 0.16 + (wave + 1) * 0.05;
						item.screen.alpha = item.state === "working" ? 0.82 + wave * 0.12 : 1;
					}
				});
				releaseLifecycle = bindRendererLifecycle({
					canvas: app.canvas,
					visibilitySource: document,
					ticker: app.ticker,
					recoveryTimeoutMs: CONTEXT_RECOVERY_TIMEOUT_MS,
					onContextLost: (lost) => {
						setContextLost(lost);
						if (lost) setTickerState("stopped");
					},
					onRecoveryTimeout: () => setFallback(true),
					onVisibilityChange: (hidden) => {
						setTickerState(hidden ? "stopped" : "running");
					},
				});
			} catch {
				if (!disposed) setFallback(true);
			}
		})();
		return () => {
			disposed = true;
			resizeObserver?.disconnect();
			releaseLifecycle?.();
			if (appRef.current === app) appRef.current = null;
			animatedRef.current = [];
			if (initialized) app?.destroy(true, { children: true });
		};
	}, [fallback, rebuildStage]);

	useEffect(() => {
		if (!fallback && rendererRevision > 0) rebuildStage();
	}, [agents, selectedId, onSelect, labelMetrics.labels, fallback, rendererRevision, rebuildStage]);

	const allStationsInBounds = layout.stations.every((position) => stationIsWithinLayout(position, layout));
	return (
		<div
			ref={hostRef}
			className="office-scene"
			style={{ height: `${layout.height}px` }}
			data-agent-count={agents.length}
			data-layout-width={layout.width}
			data-layout-height={layout.height}
			data-layout-columns={layout.columns}
			data-layout-cell-width={layout.cellWidth}
			data-stations-in-bounds={allStationsInBounds}
			data-labels-fit={labelMetrics.fit}
			data-station-label-max-width={labelMetrics.maxWidth}
			data-station-label-font={STATION_LABEL_FONT}
			data-station-labels={JSON.stringify(labelMetrics.labels)}
			data-station-label-widths={JSON.stringify(labelMetrics.widths)}
			data-station-label-centers={JSON.stringify(layout.stations.map(({ x }) => x))}
			data-font-revision={fontRevision}
			data-renderer={fallback ? "2d" : "webgl"}
			data-renderer-revision={rendererRevision}
			data-ticker={fallback ? "stopped" : tickerState}
		>
			{fallback ? <FallbackCanvas agents={agents} selectedId={selectedId} onSelect={onSelect} labels={labelMetrics.labels} /> : contextLost && <div className="scene-notice">Restoring graphics...</div>}
		</div>
	);
}
