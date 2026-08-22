export interface TickerControl {
	start: () => void;
	stop: () => void;
}

interface VisibilitySource {
	readonly hidden: boolean;
	addEventListener: (type: "visibilitychange", listener: EventListener) => void;
	removeEventListener: (type: "visibilitychange", listener: EventListener) => void;
}

interface RendererLifecycleOptions {
	canvas: Pick<HTMLCanvasElement, "addEventListener" | "removeEventListener">;
	visibilitySource: VisibilitySource;
	ticker: TickerControl;
	recoveryTimeoutMs: number;
	onContextLost: (lost: boolean) => void;
	onRecoveryTimeout: () => void;
	onVisibilityChange?: (hidden: boolean) => void;
}

export function syncTickerVisibility(ticker: TickerControl, hidden: boolean): void {
	if (hidden) ticker.stop();
	else ticker.start();
}

export function bindRendererLifecycle(options: RendererLifecycleOptions): () => void {
	let recoveryTimer: ReturnType<typeof setTimeout> | null = null;
	let disposed = false;

	const clearRecoveryTimer = () => {
		if (recoveryTimer !== null) clearTimeout(recoveryTimer);
		recoveryTimer = null;
	};
	const syncVisibility = () => {
		if (disposed) return;
		syncTickerVisibility(options.ticker, options.visibilitySource.hidden);
		options.onVisibilityChange?.(options.visibilitySource.hidden);
	};
	const handleContextLost: EventListener = (event) => {
		event.preventDefault();
		options.ticker.stop();
		options.onContextLost(true);
		clearRecoveryTimer();
		recoveryTimer = setTimeout(() => {
			recoveryTimer = null;
			if (!disposed) options.onRecoveryTimeout();
		}, options.recoveryTimeoutMs);
	};
	const handleContextRestored: EventListener = () => {
		clearRecoveryTimer();
		options.onContextLost(false);
		syncVisibility();
	};

	options.visibilitySource.addEventListener("visibilitychange", syncVisibility);
	options.canvas.addEventListener("webglcontextlost", handleContextLost);
	options.canvas.addEventListener("webglcontextrestored", handleContextRestored);
	syncVisibility();

	return () => {
		disposed = true;
		clearRecoveryTimer();
		options.visibilitySource.removeEventListener("visibilitychange", syncVisibility);
		options.canvas.removeEventListener("webglcontextlost", handleContextLost);
		options.canvas.removeEventListener("webglcontextrestored", handleContextRestored);
	};
}
