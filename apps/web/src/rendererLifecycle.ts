export interface TickerControl {
	start: () => void;
	stop: () => void;
}

interface VisibilitySource {
	readonly hidden: boolean;
	addEventListener: (type: "visibilitychange", listener: EventListener) => void;
	removeEventListener: (type: "visibilitychange", listener: EventListener) => void;
}

interface MotionPreferenceSource {
	readonly matches: boolean;
	addEventListener: (type: "change", listener: EventListener) => void;
	removeEventListener: (type: "change", listener: EventListener) => void;
}

interface RendererLifecycleOptions {
	canvas: Pick<HTMLCanvasElement, "addEventListener" | "removeEventListener">;
	visibilitySource: VisibilitySource;
	motionPreferenceSource?: MotionPreferenceSource;
	ticker: TickerControl;
	recoveryTimeoutMs: number;
	onContextLost: (lost: boolean) => void;
	onRecoveryTimeout: () => void;
	onVisibilityChange?: (hidden: boolean) => void;
}

export function syncTickerVisibility(ticker: TickerControl, paused: boolean): void {
	if (paused) ticker.stop();
	else ticker.start();
}

export function bindRendererLifecycle(options: RendererLifecycleOptions): () => void {
	let recoveryTimer: ReturnType<typeof setTimeout> | null = null;
	let disposed = false;

	const clearRecoveryTimer = () => {
		if (recoveryTimer !== null) clearTimeout(recoveryTimer);
		recoveryTimer = null;
	};
	const syncActivity = () => {
		if (disposed) return;
		const paused = options.visibilitySource.hidden
			|| options.motionPreferenceSource?.matches === true;
		syncTickerVisibility(options.ticker, paused);
		options.onVisibilityChange?.(paused);
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
		syncActivity();
	};

	options.visibilitySource.addEventListener("visibilitychange", syncActivity);
	options.motionPreferenceSource?.addEventListener("change", syncActivity);
	options.canvas.addEventListener("webglcontextlost", handleContextLost);
	options.canvas.addEventListener("webglcontextrestored", handleContextRestored);
	syncActivity();

	return () => {
		disposed = true;
		clearRecoveryTimer();
		options.visibilitySource.removeEventListener("visibilitychange", syncActivity);
		options.motionPreferenceSource?.removeEventListener("change", syncActivity);
		options.canvas.removeEventListener("webglcontextlost", handleContextLost);
		options.canvas.removeEventListener("webglcontextrestored", handleContextRestored);
	};
}
