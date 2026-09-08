import { describe, expect, it } from "vitest";
import { compactStationName, parseNicknames } from "./agentNames.js";
import { stationLabelGraphemes, truncateMeasuredLabel } from "./officeSceneLayout.js";

describe("Office display names", () => {
	it("keeps model and device instead of a repeated role prefix", () => {
		expect(compactStationName("Product Engineer - Codex - Mac mini")).toBe("Codex · Mac mini");
		expect(compactStationName("Product Engineer - Claude - MacBook Pro")).toBe("Claude · MacBook Pro");
		expect(compactStationName("小码")).toBe("小码");
		expect(compactStationName("Runtime Reliability Lead")).toBe("Runtime Reliability Lead");
	});

	it("keeps only valid local nicknames", () => {
		expect(parseNicknames('{"a":" 小码 ","b":42,"c":"","d":"' + "X".repeat(25) + '"}')).toEqual({ a: "小码" });
		for (const raw of [null, "bad json", "[]", "null", "42"]) expect(parseNicknames(raw)).toEqual({});
	});

	it("preserves both ends without splitting Unicode graphemes", () => {
		const measure = (text: string) => stationLabelGraphemes(text).length * 10;
		expect(truncateMeasuredLabel("Codex · Mac mini", 90, measure, "middle").text).toBe("Code…mini");
		expect(truncateMeasuredLabel("👩🏽‍💻abcdef👨‍👩‍👧‍👦", 30, measure, "middle").text).toBe("👩🏽‍💻…👨‍👩‍👧‍👦");
	});
});
