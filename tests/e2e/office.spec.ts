import { expect, test } from "@playwright/test";
import type { OfficeSnapshot } from "@multica-office/contracts";
import { createServer as createNetServer } from "node:net";
import { PNG } from "pngjs";
import type { CliRunner } from "../../apps/bridge/src/runner.js";
import { buildServer } from "../../apps/bridge/src/server.js";
import { SnapshotService } from "../../apps/bridge/src/snapshot.js";
import { stationLabelGraphemes } from "../../apps/web/src/officeSceneLayout.js";

const consoleErrors = new WeakMap<import("@playwright/test").Page, string[]>();
const pageErrors = new WeakMap<import("@playwright/test").Page, string[]>();

async function availableLoopbackPort(): Promise<number> {
	const probe = createNetServer();
	await new Promise<void>((resolve, reject) => {
		probe.once("error", reject);
		probe.listen(0, "127.0.0.1", resolve);
	});
	const address = probe.address();
	if (!address || typeof address === "string") throw new Error("Could not reserve a loopback port");
	await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
	return address.port;
}

function liveSnapshot(sequence: number, names = ["Live Agent"]): OfficeSnapshot {
	const generatedAt = new Date().toISOString();
	return {
		schemaVersion: 1,
		generatedAt,
		sequence,
		sources: {
			agents: { state: "ok" },
			runtimes: { state: "ok" },
			issues: { state: "ok" },
			runs: { state: "ok" },
		},
		agents: names.map((name, index) => ({
			id: `agent-live-${index}`,
			name,
			runtimeId: `runtime-live-${index}`,
			state: index % 2 === 0 ? "working" : "blocked",
			issueId: null,
			runId: null,
			activeCount: 0,
			updatedAt: generatedAt,
		})),
		runtimes: names.map((name, index) => ({ id: `runtime-live-${index}`, name: `${name} runtime`, state: "online", lastSeenAt: generatedAt })),
		issues: [],
		runs: [],
	};
}

async function installControllableEventSource(page: import("@playwright/test").Page) {
	await page.addInitScript(() => {
		const streams: Array<{ closed: boolean; listeners: Map<string, Array<(event: Event) => void>>; onopen: (() => void) | null }> = [];
		class FakeEventSource {
			closed = false;
			listeners = new Map<string, Array<(event: Event) => void>>();
			onopen: (() => void) | null = null;
			onerror: (() => void) | null = null;
			constructor() { streams.push(this); queueMicrotask(() => this.onopen?.()); }
			addEventListener(type: string, listener: (event: Event) => void) {
				this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
			}
			close() { this.closed = true; }
		}
		Object.defineProperty(window, "EventSource", { configurable: true, value: FakeEventSource });
		Object.defineProperty(window, "__emitOfficeSnapshot", {
			value: (value: unknown) => {
				for (const stream of streams) {
					if (stream.closed) continue;
					for (const listener of stream.listeners.get("snapshot") ?? []) listener({ data: JSON.stringify(value) } as unknown as Event);
				}
			},
		});
		Object.defineProperty(window, "__reopenOfficeStream", {
			value: () => {
				for (const stream of streams) if (!stream.closed) stream.onopen?.();
			},
		});
		Object.defineProperty(window, "__activeOfficeStreams", {
			get: () => streams.filter((stream) => !stream.closed).length,
		});
	});
}

test.beforeEach(async ({ page }) => {
	const consoleMessages: string[] = [];
	const uncaughtErrors: string[] = [];
	consoleErrors.set(page, consoleMessages);
	pageErrors.set(page, uncaughtErrors);
	page.on("console", (message) => {
		if (message.type() === "error") consoleMessages.push(message.text());
	});
	page.on("pageerror", (error) => uncaughtErrors.push(error.message));
});

test.afterEach(async ({ page }) => {
	expect(pageErrors.get(page) ?? [], "uncaught page errors").toEqual([]);
	expect(consoleErrors.get(page) ?? [], "browser console errors").toEqual([]);
});

async function expectNonBlankCanvas(page: import("@playwright/test").Page) {
	const canvas = page.locator("canvas.office-canvas");
	await expect(canvas).toBeVisible();
	const image = PNG.sync.read(await canvas.screenshot());
	const pixels = (() => {
		let colored = 0;
		const colors = new Set<string>();
		for (let index = 0; index < image.data.length; index += 64) {
			if (image.data[index + 3]! > 0) colored += 1;
			colors.add(`${image.data[index]},${image.data[index + 1]},${image.data[index + 2]},${image.data[index + 3]}`);
		}
		return { colored, colors: colors.size };
	})();
	expect(pixels.colored).toBeGreaterThan(500);
	expect(pixels.colors).toBeGreaterThan(2);
}

async function expectSceneReachable(page: import("@playwright/test").Page, count: number) {
	const scene = page.locator(".office-scene");
	const frame = page.locator(".scene-frame");
	await expect(scene).toHaveAttribute("data-agent-count", String(count));
	await expect(scene).toHaveAttribute("data-stations-in-bounds", "true");
	const dimensions = await frame.evaluate((element) => ({
		clientHeight: element.clientHeight,
		scrollHeight: element.scrollHeight,
		clientWidth: element.clientWidth,
		scrollWidth: element.scrollWidth,
	}));
	expect(dimensions.scrollWidth - dimensions.clientWidth).toBeLessThanOrEqual(1);
	expect(dimensions.scrollHeight).toBeGreaterThanOrEqual(dimensions.clientHeight);
	await frame.evaluate((element) => element.scrollTo({ top: element.scrollHeight }));
	const reachedBottom = await frame.evaluate((element) => Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop));
	expect(reachedBottom).toBeLessThanOrEqual(1);
}

async function expectMeasuredStationLabelsDoNotOverlap(page: import("@playwright/test").Page) {
	const geometry = await page.locator(".office-scene").evaluate((element) => {
		const labels = JSON.parse(element.getAttribute("data-station-labels") ?? "[]") as string[];
		const reportedWidths = JSON.parse(element.getAttribute("data-station-label-widths") ?? "[]") as number[];
		const centers = JSON.parse(element.getAttribute("data-station-label-centers") ?? "[]") as number[];
		const columns = Number(element.getAttribute("data-layout-columns"));
		const sceneWidth = Number(element.getAttribute("data-layout-width"));
		const maxWidth = Number(element.getAttribute("data-station-label-max-width"));
		const canvas = document.createElement("canvas");
		const context = canvas.getContext("2d")!;
		context.font = element.getAttribute("data-station-label-font")!;
		const bounds = labels.map((label, index) => {
			const width = context.measureText(label).width;
			return { width, left: centers[index]! - width / 2, right: centers[index]! + width / 2, reportedWidth: reportedWidths[index]! };
		});
		const edgeViolations = bounds.filter(({ width, left, right }) => width > maxWidth || left < 0 || right > sceneWidth).length;
		const metricMismatches = bounds.filter(({ width, reportedWidth }) => Math.abs(width - reportedWidth) > 0.01).length;
		let adjacentOverlaps = 0;
		for (let index = 0; index < bounds.length - 1; index += 1) {
			if ((index + 1) % columns !== 0 && bounds[index]!.right >= bounds[index + 1]!.left) adjacentOverlaps += 1;
		}
		return { labels, widths: bounds.map(({ width }) => width), maxWidth, edgeViolations, metricMismatches, adjacentOverlaps };
	});
	expect(geometry.labels.length).toBeGreaterThan(0);
	expect(geometry.labels.every((label) => label.endsWith("…"))).toBe(true);
	expect(geometry.widths.every((width) => width <= geometry.maxWidth)).toBe(true);
	expect(geometry.edgeViolations).toBe(0);
	expect(geometry.metricMismatches).toBe(0);
	expect(geometry.adjacentOverlaps).toBe(0);
	return geometry.labels;
}

async function expectLabelsEndAtGraphemeBoundaries(page: import("@playwright/test").Page, labels: string[]) {
	const names = await page.locator(".agent-copy strong").allTextContents();
	expect(names).toHaveLength(labels.length);
	for (const [index, label] of labels.entries()) {
		const prefix = label.endsWith("…") ? label.slice(0, -1) : label;
		const graphemes = stationLabelGraphemes(names[index]!);
		expect(graphemes.some((_grapheme, count) => graphemes.slice(0, count + 1).join("") === prefix)).toBe(true);
	}
}

test("built release server delivers the runnable client and same-origin API", async ({ page }) => {
	const response = await page.goto("/");
	expect(response?.status()).toBe(200);
	const csp = response?.headers()["content-security-policy"] ?? "";
	expect(csp).toContain("script-src 'self'");
	expect(csp).not.toContain("unsafe-eval");
	await expect(page.getByRole("heading", { name: "Today's floor" })).toBeVisible();
	await expect(page.locator(".office-scene")).toHaveAttribute("data-renderer", "webgl");
	await expectNonBlankCanvas(page);
	const health = await page.evaluate(async () => {
		const result = await fetch("/healthz");
		return { status: result.status, body: await result.json() as { status: string } };
	});
	expect(health).toEqual({ status: 200, body: expect.objectContaining({ status: "ok" }) });
	const notices = await page.evaluate(async () => {
		const result = await fetch("/THIRD_PARTY_NOTICES.txt");
		return { status: result.status, body: await result.text() };
	});
	expect(notices.status).toBe(200);
	expect(notices.body).toContain("pixi.js@8.20.0");
	expect(notices.body).toContain("react@19.2.8");
	expect(notices.body).toContain("fastify@5.12.1");
});

test("desktop office is interactive and visually populated", async ({ page }, testInfo) => {
	await page.goto("/?fixture=ready");
	await expect(page.getByRole("heading", { name: "Today's floor" })).toBeVisible();
	await expectNonBlankCanvas(page);
	const canvas = page.locator("canvas.office-canvas");
	await canvas.dispatchEvent("webglcontextlost");
	await expect(page.getByText("Restoring graphics...")).toBeVisible();
	await canvas.dispatchEvent("webglcontextrestored");
	await expect(page.getByText("Restoring graphics...")).toBeHidden();
	await page.screenshot({ path: testInfo.outputPath("office-desktop.png"), fullPage: true });
	await page.locator(".filters").getByRole("button", { name: /Blocked/ }).click();
	const avery = page.locator(".agent-list").getByRole("button", { name: /Avery/ });
	await expect(avery).toBeVisible();
	await avery.click();
	await expect(page.getByRole("heading", { name: "Restore the nightly fixture export" })).toBeVisible();
});

for (const viewport of [
	{ name: "desktop", width: 1280, height: 800 },
	{ name: "narrow", width: 390, height: 844 },
]) {
	for (const count of [8, 12, 20]) {
		test(`${viewport.name} layout keeps all ${count} stations in a reachable scene`, async ({ page }, testInfo) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height });
			await page.goto(`/?fixture=ready&agents=${count}`);
			await expectNonBlankCanvas(page);
			if (viewport.name === "narrow" && count === 20) {
				await page.locator(".scene-frame").screenshot({ path: testInfo.outputPath("office-narrow-20-top.png") });
			}
			await expectSceneReachable(page, count);
			const horizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
			expect(horizontalOverflow).toBeLessThanOrEqual(1);
			if (viewport.name === "narrow" && count === 20) {
				await page.locator(".scene-frame").screenshot({ path: testInfo.outputPath("office-narrow-20-bottom.png") });
			}
		});
	}
}

test("narrow office truncates long real-style names within station cells", async ({ page }, testInfo) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto("/?fixture=long-names");
	const scene = page.locator(".office-scene");
	await expect(scene).toHaveAttribute("data-labels-fit", "true");
	await expect(scene).toHaveAttribute("data-stations-in-bounds", "true");
	await expectNonBlankCanvas(page);
	const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
	expect(overflow).toBeLessThanOrEqual(1);
	await page.locator(".scene-frame").screenshot({ path: testInfo.outputPath("office-narrow-long-names.png") });
	await page.locator("canvas.office-canvas").dispatchEvent("webglcontextlost");
	await expect(scene).toHaveAttribute("data-renderer", "2d", { timeout: 4_000 });
	await expect(scene).toHaveAttribute("data-labels-fit", "true");
	await expectNonBlankCanvas(page);
	await page.locator(".scene-frame").screenshot({ path: testInfo.outputPath("office-narrow-long-names-fallback.png") });
});

test("narrow Pixi and 2D scenes keep Unicode grapheme labels separated", async ({ page }, testInfo) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto("/?fixture=unicode-names");
	const scene = page.locator(".office-scene");
	await page.evaluate(() => document.fonts.ready);
	await expect.poll(async () => Number(await scene.getAttribute("data-font-revision"))).toBeGreaterThan(0);
	await expect(scene).toHaveAttribute("data-labels-fit", "true");
	await expect(scene).toHaveAttribute("data-stations-in-bounds", "true");
	await expectNonBlankCanvas(page);
	const pixiLabels = await expectMeasuredStationLabelsDoNotOverlap(page);
	await expectLabelsEndAtGraphemeBoundaries(page, pixiLabels);
	const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
	expect(overflow).toBeLessThanOrEqual(1);
	await page.locator(".scene-frame").evaluate((element) => {
		(element as HTMLElement).style.height = `${element.scrollHeight}px`;
	});
	await page.locator(".scene-frame").screenshot({ path: testInfo.outputPath("office-narrow-unicode-pixi.png") });

	await page.locator("canvas.office-canvas").dispatchEvent("webglcontextlost");
	await expect(scene).toHaveAttribute("data-renderer", "2d", { timeout: 4_000 });
	await expectNonBlankCanvas(page);
	const fallbackLabels = await expectMeasuredStationLabelsDoNotOverlap(page);
	expect(fallbackLabels).toEqual(pixiLabels);
	await expectLabelsEndAtGraphemeBoundaries(page, fallbackLabels);
	await page.locator(".scene-frame").screenshot({ path: testInfo.outputPath("office-narrow-unicode-fallback.png") });
});

test("SSE outranks slow GETs, accepts restart resets, and preserves the Pixi canvas", async ({ page }) => {
	const pending: Array<import("@playwright/test").Route> = [];
	await page.route("http://127.0.0.1:4317/v1/snapshot", async (route) => {
		pending.push(route);
	});
	await installControllableEventSource(page);
	await page.goto("/");
	await expect.poll(() => pending.length).toBeGreaterThan(0);
	await page.evaluate((next) => (window as unknown as { __emitOfficeSnapshot: (snapshot: unknown) => void }).__emitOfficeSnapshot(next), liveSnapshot(50, ["Alpha Engineer", "Beta Coordinator"]));
	await expect(page.getByText("2 agents · snapshot 50")).toBeVisible();
	await expectNonBlankCanvas(page);
	await page.evaluate(() => {
		(window as unknown as { __officeCanvas: Element | null }).__officeCanvas = document.querySelector("canvas.office-canvas");
	});
	const expectSameCanvas = async () => {
		expect(await page.evaluate(() => document.querySelector("canvas.office-canvas") === (window as unknown as { __officeCanvas: Element | null }).__officeCanvas)).toBe(true);
	};
	const fulfillPending = async (next: OfficeSnapshot) => {
		const routes = pending.splice(0);
		await Promise.all(routes.map((route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(next) }).catch(() => undefined)));
	};

	await fulfillPending(liveSnapshot(10, ["Old Initial GET"]));
	await expect(page.getByText("2 agents · snapshot 50")).toBeVisible();
	await expectSameCanvas();

	await page.locator(".agent-list").getByRole("button", { name: /Beta Coordinator/ }).click();
	await expectSameCanvas();
	await page.locator(".filters").getByRole("button", { name: /Blocked/ }).click();
	await expect(page.locator(".office-scene")).toHaveAttribute("data-agent-count", "1");
	await expectSameCanvas();
	await page.locator(".filters").getByRole("button", { name: /All/ }).click();

	await page.getByRole("button", { name: "Refresh snapshot" }).click();
	await expect.poll(() => pending.length).toBeGreaterThan(0);
	await page.evaluate((next) => (window as unknown as { __emitOfficeSnapshot: (snapshot: unknown) => void }).__emitOfficeSnapshot(next), liveSnapshot(60, ["Alpha Engineer", "Beta Coordinator", "Gamma Operator"]));
	await expect(page.getByText("3 agents · snapshot 60")).toBeVisible();
	await fulfillPending(liveSnapshot(55, ["Slow Manual GET"]));
	await expect(page.getByText("3 agents · snapshot 60")).toBeVisible();
	await expectSameCanvas();

	await page.evaluate(() => (window as unknown as { __reopenOfficeStream: () => void }).__reopenOfficeStream());
	await page.evaluate((next) => (window as unknown as { __emitOfficeSnapshot: (snapshot: unknown) => void }).__emitOfficeSnapshot(next), liveSnapshot(1, ["Restarted Bridge Agent"]));
	await expect(page.getByText("1 agents · snapshot 1")).toBeVisible();
	for (let sequence = 2; sequence <= 8; sequence += 1) {
		await page.evaluate((next) => (window as unknown as { __emitOfficeSnapshot: (snapshot: unknown) => void }).__emitOfficeSnapshot(next), liveSnapshot(sequence, [`Restart Agent ${sequence}`, `Update Agent ${sequence}`]));
	}
	await expect(page.getByText("2 agents · snapshot 8")).toBeVisible();
	await expectSameCanvas();
});

test("permanent WebGL context loss switches to the 2D renderer", async ({ page }) => {
	await page.goto("/?fixture=ready&agents=20");
	const canvas = page.locator("canvas.office-canvas");
	await canvas.dispatchEvent("webglcontextlost");
	await expect(page.getByText("Restoring graphics...")).toBeVisible();
	await expect(page.locator(".office-scene")).toHaveAttribute("data-renderer", "2d", { timeout: 4_000 });
	await expect(page.getByLabel("Office scene in compatibility mode")).toBeVisible();
	await expectSceneReachable(page, 20);
	await expectNonBlankCanvas(page);
});

test("ticker honors an initially hidden document and later visibility changes", async ({ page }) => {
	await page.addInitScript(() => {
		let hidden = true;
		Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
		Object.defineProperty(window, "__setOfficeHidden", {
			value: (next: boolean) => {
				hidden = next;
				document.dispatchEvent(new Event("visibilitychange"));
			},
		});
	});
	await page.goto("/?fixture=ready");
	const scene = page.locator(".office-scene");
	await expect(scene).toHaveAttribute("data-ticker", "stopped");
	await page.evaluate(() => (window as unknown as { __setOfficeHidden: (hidden: boolean) => void }).__setOfficeHidden(false));
	await expect(scene).toHaveAttribute("data-ticker", "running");
	await page.evaluate(() => (window as unknown as { __setOfficeHidden: (hidden: boolean) => void }).__setOfficeHidden(true));
	await expect(scene).toHaveAttribute("data-ticker", "stopped");
});

test("hidden pages close the snapshot stream and reconnect when visible", async ({ page }) => {
	await installControllableEventSource(page);
	await page.route("http://127.0.0.1:4317/v1/snapshot", (route) => route.fulfill({
		status: 200,
		contentType: "application/json",
		body: JSON.stringify(liveSnapshot(1)),
	}));
	await page.addInitScript(() => {
		let hidden = false;
		Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
		Object.defineProperty(window, "__setOfficeHidden", {
			value: (next: boolean) => {
				hidden = next;
				document.dispatchEvent(new Event("visibilitychange"));
			},
		});
	});
	await page.goto("/");
	await expect.poll(() => page.evaluate(() => (window as unknown as { __activeOfficeStreams: number }).__activeOfficeStreams)).toBe(1);
	await page.evaluate(() => (window as unknown as { __setOfficeHidden: (hidden: boolean) => void }).__setOfficeHidden(true));
	await expect.poll(() => page.evaluate(() => (window as unknown as { __activeOfficeStreams: number }).__activeOfficeStreams)).toBe(0);
	await page.evaluate(() => (window as unknown as { __setOfficeHidden: (hidden: boolean) => void }).__setOfficeHidden(false));
	await expect.poll(() => page.evaluate(() => (window as unknown as { __activeOfficeStreams: number }).__activeOfficeStreams)).toBe(1);
});

test("reduced motion keeps on-demand snapshot rendering", async ({ page }) => {
	await page.emulateMedia({ reducedMotion: "reduce" });
	await installControllableEventSource(page);
	await page.route("http://127.0.0.1:4317/v1/snapshot", (route) => route.fulfill({
		status: 200,
		contentType: "application/json",
		body: JSON.stringify(liveSnapshot(1, ["First Agent"])),
	}));
	await page.goto("/");
	const scene = page.locator(".office-scene");
	await expect(scene).toHaveAttribute("data-ticker", "stopped");
	await expect(scene).toHaveAttribute("data-agent-count", "1");
	const before = await page.locator("canvas.office-canvas").screenshot();
	await page.evaluate((next) => (window as unknown as { __emitOfficeSnapshot: (snapshot: unknown) => void }).__emitOfficeSnapshot(next), liveSnapshot(2, ["First Agent", "Second Agent", "Third Agent"]));
	await expect(scene).toHaveAttribute("data-agent-count", "3");
	const after = await page.locator("canvas.office-canvas").screenshot();
	expect(before.equals(after)).toBe(false);
});

test("manual refresh failure preserves data and clears after refresh and SSE recovery", async ({ page }) => {
	let failSnapshot = false;
	let sequence = 100;
	const snapshot = (nextSequence: number): OfficeSnapshot => ({
		schemaVersion: 1,
		generatedAt: new Date().toISOString(),
		sequence: nextSequence,
		sources: {
			agents: { state: "ok" },
			runtimes: { state: "ok" },
			issues: { state: "ok" },
			runs: { state: "ok" },
		},
		agents: [{ id: "agent-live", name: "Live Agent", runtimeId: "runtime-live", state: "idle", issueId: null, runId: null, activeCount: 0, updatedAt: new Date().toISOString() }],
		runtimes: [{ id: "runtime-live", name: "Local Mac", state: "offline", lastSeenAt: null }],
		issues: [],
		runs: [],
	});
	await page.route("http://127.0.0.1:4317/v1/snapshot", async (route) => {
		if (failSnapshot) await route.fulfill({ status: 200, contentType: "application/json", body: "not valid json" });
		else await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(snapshot(sequence++)) });
	});
	await page.addInitScript(() => {
		const streams: Array<{ closed: boolean; listeners: Map<string, Array<(event: Event) => void>> }> = [];
		class FakeEventSource {
			closed = false;
			listeners = new Map<string, Array<(event: Event) => void>>();
			onopen: (() => void) | null = null;
			onerror: (() => void) | null = null;
			constructor() { streams.push(this); queueMicrotask(() => this.onopen?.()); }
			addEventListener(type: string, listener: (event: Event) => void) {
				this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
			}
			close() { this.closed = true; }
		}
		Object.defineProperty(window, "EventSource", { configurable: true, value: FakeEventSource });
		Object.defineProperty(window, "__emitOfficeSnapshot", {
			value: (value: unknown) => {
				for (const stream of streams) {
					if (stream.closed) continue;
					for (const listener of stream.listeners.get("snapshot") ?? []) listener({ data: JSON.stringify(value) } as unknown as Event);
				}
			},
		});
	});

	await page.goto("/");
	const snapshotLine = page.locator(".floor-toolbar p");
	await expect(snapshotLine).toContainText("1 agents · snapshot");
	const lastKnownSnapshot = await snapshotLine.textContent();
	await expect(page.locator(".metric-strip strong").nth(1)).toHaveText("Offline");
	failSnapshot = true;
	await page.getByRole("button", { name: "Refresh snapshot" }).click();
	await expect(page.getByRole("alert")).toContainText("Last-known snapshot remains visible");
	await expect(snapshotLine).toHaveText(lastKnownSnapshot!);

	failSnapshot = false;
	await page.getByRole("button", { name: "Refresh snapshot" }).click();
	await expect(page.getByRole("alert")).toBeHidden();
	await expect(snapshotLine).not.toHaveText(lastKnownSnapshot!);

	failSnapshot = true;
	await page.getByRole("button", { name: "Refresh snapshot" }).click();
	await expect(page.getByRole("alert")).toBeVisible();
	await page.evaluate((next) => (window as unknown as { __emitOfficeSnapshot: (snapshot: unknown) => void }).__emitOfficeSnapshot(next), snapshot(777));
	await expect(page.getByRole("alert")).toBeHidden();
	await expect(page.getByText("1 agents · snapshot 777")).toBeVisible();
});

test("development SSE returns validated CORS headers and streamed snapshots", async () => {
	const port = await availableLoopbackPort();
	const runner: CliRunner = {
		async run(command) {
			if (command.key === "issues") return { issues: [], has_more: false, offset: command.offset, limit: 100 };
			return [];
		},
	};
	const service = new SnapshotService(runner);
	const bridge = buildServer(service, { port, developmentOrigin: "http://127.0.0.1:4317" });
	await bridge.listen({ host: "127.0.0.1", port });
	const eventsUrl = `http://127.0.0.1:${port}/v1/events`;
	try {
		const headerResponse = await fetch(eventsUrl, { headers: { origin: "http://127.0.0.1:4317" } });
		expect(headerResponse.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:4317");
		expect(headerResponse.headers.get("vary")).toBe("Origin");
		expect(headerResponse.headers.get("content-type")).toContain("text/event-stream");
		const reader = headerResponse.body?.getReader();
		if (!reader) throw new Error("SSE response did not include a body");
		const decoder = new TextDecoder();
		let buffered = "";
		const nextSnapshot = async (): Promise<OfficeSnapshot> => {
			for (;;) {
				const boundary = buffered.indexOf("\n\n");
				if (boundary >= 0) {
					const frame = buffered.slice(0, boundary);
					buffered = buffered.slice(boundary + 2);
					if (frame.includes("event: snapshot")) {
						const data = frame.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
						if (data) return JSON.parse(data) as OfficeSnapshot;
					}
				}
				const { done, value } = await reader.read();
				if (done) throw new Error("SSE stream ended before a snapshot arrived");
				buffered += decoder.decode(value, { stream: true });
			}
		};
		expect((await nextSnapshot()).sequence).toBe(0);
		await service.refresh();
		expect((await nextSnapshot()).sequence).toBe(1);
		await reader.cancel();
	} finally {
		await bridge.close();
	}
});

test("empty, degraded, and offline states give a recovery path", async ({ page }) => {
	await page.goto("/?fixture=empty");
	await expect(page.getByText("The office is ready")).toBeVisible();
	await page.goto("/?fixture=degraded");
	await expect(page.getByText(/Some data is stale/)).toBeVisible();
	await page.goto("/?fixture=auth-required");
	await expect(page.getByText(/multica login/)).toBeVisible();
	await expect(page.getByText("The office is ready")).toBeHidden();
	await page.goto("/?fixture=stale-auth-required");
	await expect(page.getByText(/multica login/)).toBeVisible();
	await expect(page.getByRole("heading", { name: "Mira" })).toBeVisible();
	await page.goto("/?fixture=offline");
	await expect(page.getByRole("heading", { name: "Office bridge is offline" })).toBeVisible();
	await expect(page.getByRole("button", { name: "Reconnect" })).toBeVisible();
});
