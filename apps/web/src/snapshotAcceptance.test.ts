import { describe, expect, it } from "vitest";
import type { OfficeSnapshot } from "@multica-office/contracts";
import { fixtureSnapshot } from "./fixtures.js";
import { SnapshotAcceptance } from "./snapshotAcceptance.js";

const snapshot = (sequence: number): OfficeSnapshot => ({ ...fixtureSnapshot, sequence });

describe("snapshot acceptance", () => {
	it("lets SSE win over a slow initial GET", () => {
		const acceptance = new SnapshotAcceptance();
		const stream = acceptance.beginStream();
		const initialGet = acceptance.beginRequest();
		expect(acceptance.acceptStream(stream, snapshot(20))).toBe(true);
		expect(acceptance.acceptRequest(initialGet)).toBe(false);
	});

	it("lets SSE win over a slow manual GET", () => {
		const acceptance = new SnapshotAcceptance();
		const stream = acceptance.beginStream();
		expect(acceptance.acceptStream(stream, snapshot(20))).toBe(true);
		const refresh = acceptance.beginRequest();
		expect(acceptance.acceptStream(stream, snapshot(21))).toBe(true);
		expect(acceptance.acceptRequest(refresh)).toBe(false);
	});

	it("rejects older snapshots within one stream", () => {
		const acceptance = new SnapshotAcceptance();
		const stream = acceptance.beginStream();
		expect(acceptance.acceptStream(stream, snapshot(40))).toBe(true);
		expect(acceptance.acceptStream(stream, snapshot(39))).toBe(false);
	});

	it("accepts a lower sequence after a stream reconnect", () => {
		const acceptance = new SnapshotAcceptance();
		const firstBoot = acceptance.beginStream();
		expect(acceptance.acceptStream(firstBoot, snapshot(400))).toBe(true);
		const secondBoot = acceptance.beginStream();
		expect(acceptance.acceptStream(secondBoot, snapshot(1))).toBe(true);
		expect(acceptance.acceptStream(firstBoot, snapshot(401))).toBe(false);
	});

	it("keeps only the newest concurrent GET eligible", () => {
		const acceptance = new SnapshotAcceptance();
		acceptance.beginStream();
		const older = acceptance.beginRequest();
		const newer = acceptance.beginRequest();
		expect(acceptance.acceptRequest(older)).toBe(false);
		expect(acceptance.acceptRequest(newer)).toBe(true);
	});
});
