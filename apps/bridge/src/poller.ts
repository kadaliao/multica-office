import type { SnapshotService } from "./snapshot.js";

export class SnapshotPoller {
	private timer: NodeJS.Timeout | undefined;
	private stopped = true;
	private clientCount = 0;

	constructor(
		private readonly service: SnapshotService,
		private readonly activeIntervalMs = 5_000,
		private readonly idleIntervalMs = 30_000,
	) {}

	setClientCount(count: number): void {
		this.clientCount = count;
		if (!this.stopped) this.schedule(0);
	}

	async start(): Promise<void> {
		if (!this.stopped) return;
		this.stopped = false;
		await this.service.refresh();
		this.schedule(this.interval());
	}

	stop(): void {
		this.stopped = true;
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
	}

	private interval(): number {
		return this.clientCount > 0 ? this.activeIntervalMs : this.idleIntervalMs;
	}

	private schedule(delay: number): void {
		if (this.stopped) return;
		if (this.timer) clearTimeout(this.timer);
		this.timer = setTimeout(() => {
			void this.tick();
		}, delay);
		this.timer.unref();
	}

	private async tick(): Promise<void> {
		try {
			await this.service.refresh();
		} finally {
			this.schedule(this.interval());
		}
	}
}
