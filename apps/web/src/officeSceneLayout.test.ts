import { afterEach, describe, expect, it, vi } from "vitest";
import { computeOfficeLayout, stationIsWithinLayout, stationLabelGraphemes, stationLabelMaxWidth, truncateMeasuredLabel } from "./officeSceneLayout.js";
import { bindRendererLifecycle } from "./rendererLifecycle.js";

describe("office scene layout", () => {
	for (const width of [1120, 368]) {
		for (const count of [8, 12, 20]) {
			it(`keeps ${count} stations inside a ${width}px scene`, () => {
				const layout = computeOfficeLayout(count, width, width < 500 ? 430 : 620);
				expect(layout.stations).toHaveLength(count);
				expect(layout.stations.every((position) => stationIsWithinLayout(position, layout))).toBe(true);
				if (width < 500 && count === 20) expect(layout.height).toBeGreaterThan(430);
			});
		}
	}

	describe("measured grapheme truncation", () => {
		const measure = (value: string) => stationLabelGraphemes(value).length * 10;

		it("keeps exact-fit text and reserves room for the ellipsis", () => {
			expect(truncateMeasuredLabel("AB", 20, measure)).toEqual({ text: "AB", width: 20, truncated: false });
			expect(truncateMeasuredLabel("ABC", 25, measure)).toEqual({ text: "A…", width: 20, truncated: true });
		});

		it("returns an empty label when even the ellipsis cannot fit", () => {
			expect(truncateMeasuredLabel("Agent", 9, measure)).toEqual({ text: "", width: 0, truncated: true });
			expect(truncateMeasuredLabel("", 0, measure)).toEqual({ text: "", width: 0, truncated: false });
		});

		it("never splits complex grapheme clusters", () => {
			const clusters = ["e\u0301", "👩🏽‍💻", "👨‍👩‍👧‍👦", "က္က", "ក្ស", "ক্ষ", "क्ष"];
			for (const cluster of clusters) {
				expect(stationLabelGraphemes(cluster)).toEqual([cluster]);
				const result = truncateMeasuredLabel(cluster.repeat(5), 35, measure);
				expect(result.text).toBe(`${cluster}${cluster}…`);
				expect(stationLabelGraphemes(result.text)).toEqual([cluster, cluster, "…"]);
				expect(result.width).toBeLessThanOrEqual(35);
			}
		});

		it("uses the injected metric rather than codepoint or display-unit counts", () => {
			const widths = new Map([["W", 14], ["i", 3], ["…", 6]]);
			const proportional = (value: string) => stationLabelGraphemes(value).reduce((width, grapheme) => width + (widths.get(grapheme) ?? 8), 0);
			expect(truncateMeasuredLabel("WWii", 31, proportional)).toEqual({ text: "W…", width: 20, truncated: true });
		});
	});

	for (const width of [368, 390]) {
		it(`reserves non-overlapping station label boxes at ${width}px`, () => {
			const layout = computeOfficeLayout(8, width, 430);
			const first = layout.stations[0]!;
			const second = layout.stations[1]!;
			expect(first.x + stationLabelMaxWidth(layout.cellWidth) / 2).toBeLessThan(second.x - stationLabelMaxWidth(layout.cellWidth) / 2);
		});
	}
});

describe("renderer lifecycle", () => {
	afterEach(() => vi.useRealTimers());

	it("honors an initially hidden document and later visibility transitions", () => {
		const canvas = new EventTarget();
		const visibility = new EventTarget() as EventTarget & { hidden: boolean };
		visibility.hidden = true;
		const ticker = { start: vi.fn(), stop: vi.fn() };
		const onVisibilityChange = vi.fn();
		const cleanup = bindRendererLifecycle({
			canvas,
			visibilitySource: visibility,
			ticker,
			recoveryTimeoutMs: 100,
			onContextLost: vi.fn(),
			onRecoveryTimeout: vi.fn(),
			onVisibilityChange,
		});

		expect(ticker.stop).toHaveBeenCalledOnce();
		expect(onVisibilityChange).toHaveBeenLastCalledWith(true);
		visibility.hidden = false;
		visibility.dispatchEvent(new Event("visibilitychange"));
		expect(ticker.start).toHaveBeenCalledOnce();
		visibility.hidden = true;
		visibility.dispatchEvent(new Event("visibilitychange"));
		expect(ticker.stop).toHaveBeenCalledTimes(2);
		cleanup();
	});

	it("times out an unrestored context and cancels stale work on cleanup", () => {
		vi.useFakeTimers();
		const canvas = new EventTarget();
		const visibility = new EventTarget() as EventTarget & { hidden: boolean };
		visibility.hidden = false;
		const ticker = { start: vi.fn(), stop: vi.fn() };
		const onContextLost = vi.fn();
		const onRecoveryTimeout = vi.fn();
		const cleanup = bindRendererLifecycle({
			canvas,
			visibilitySource: visibility,
			ticker,
			recoveryTimeoutMs: 100,
			onContextLost,
			onRecoveryTimeout,
		});

		canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
		expect(onContextLost).toHaveBeenLastCalledWith(true);
		vi.advanceTimersByTime(100);
		expect(onRecoveryTimeout).toHaveBeenCalledOnce();

		canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
		cleanup();
		vi.advanceTimersByTime(100);
		expect(onRecoveryTimeout).toHaveBeenCalledOnce();
		visibility.dispatchEvent(new Event("visibilitychange"));
		expect(ticker.start).toHaveBeenCalledOnce();
	});

	it("cancels recovery when WebGL restores", () => {
		vi.useFakeTimers();
		const canvas = new EventTarget();
		const visibility = new EventTarget() as EventTarget & { hidden: boolean };
		visibility.hidden = false;
		const onRecoveryTimeout = vi.fn();
		const cleanup = bindRendererLifecycle({
			canvas,
			visibilitySource: visibility,
			ticker: { start: vi.fn(), stop: vi.fn() },
			recoveryTimeoutMs: 100,
			onContextLost: vi.fn(),
			onRecoveryTimeout,
		});

		canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
		canvas.dispatchEvent(new Event("webglcontextrestored"));
		vi.advanceTimersByTime(100);
		expect(onRecoveryTimeout).not.toHaveBeenCalled();
		cleanup();
	});
});
