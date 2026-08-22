import { useCallback, useEffect, useRef, useState } from "react";
import type { OfficeSnapshot } from "@multica-office/contracts";
import { fixtureFor } from "./fixtures.js";
import { SnapshotAcceptance } from "./snapshotAcceptance.js";

export type ConnectionState = "loading" | "live" | "reconnecting" | "offline";
const BRIDGE_URL = import.meta.env.VITE_OFFICE_BRIDGE_URL ?? "http://127.0.0.1:4317";

async function getSnapshot(): Promise<OfficeSnapshot> {
	const response = await fetch(`${BRIDGE_URL}/v1/snapshot`, { cache: "no-store" });
	if (!response.ok) throw new Error(`Bridge returned ${response.status}`);
	return response.json() as Promise<OfficeSnapshot>;
}

export function useOfficeData() {
	const fixture = new URLSearchParams(window.location.search).get("fixture");
	const fixtureAgentCount = Number.parseInt(new URLSearchParams(window.location.search).get("agents") ?? "", 10);
	const initialFixture = fixture ? fixtureFor(fixture, Number.isNaN(fixtureAgentCount) ? undefined : fixtureAgentCount) : null;
	const [snapshot, setSnapshot] = useState<OfficeSnapshot | null>(initialFixture);
	const [connection, setConnection] = useState<ConnectionState>(fixture === "offline" ? "offline" : fixture ? "live" : "loading");
	const [error, setError] = useState<string | null>(fixture === "offline" ? "The local bridge is not responding." : null);
	const [refreshError, setRefreshError] = useState<string | null>(null);
	const [generation, setGeneration] = useState(0);
	const acceptanceRef = useRef<SnapshotAcceptance | null>(null);
	if (!acceptanceRef.current) acceptanceRef.current = new SnapshotAcceptance();

	const refresh = useCallback(() => {
		if (fixture) {
			setSnapshot(fixtureFor(fixture, Number.isNaN(fixtureAgentCount) ? undefined : fixtureAgentCount));
			return;
		}
		const ticket = acceptanceRef.current!.beginRequest();
		void getSnapshot().then((next) => {
			if (!acceptanceRef.current!.acceptRequest(ticket)) return;
			setSnapshot(next);
			setError(null);
			setRefreshError(null);
		}).catch(() => {
			if (!acceptanceRef.current!.acceptRequest(ticket)) return;
			setRefreshError("The latest snapshot could not be loaded.");
			setConnection((current) => current === "loading" ? "offline" : current);
		});
	}, [fixture, fixtureAgentCount]);

	useEffect(() => {
		if (fixture) return;
		let cancelled = false;
		const acceptance = acceptanceRef.current!;
		let streamGeneration = acceptance.beginStream();
		const initialTicket = acceptance.beginRequest();
		let opened = false;
		setConnection((current) => current === "loading" ? "loading" : "reconnecting");
		void getSnapshot().then((initial) => {
			if (cancelled || !acceptance.acceptRequest(initialTicket)) return;
			setSnapshot(initial);
			setError(null);
			setRefreshError(null);
			setConnection("live");
		}).catch(() => {
			if (cancelled || !acceptance.acceptRequest(initialTicket)) return;
			setError("The local bridge is not responding.");
			setConnection("offline");
		});

		const stream = new EventSource(`${BRIDGE_URL}/v1/events`);
		stream.addEventListener("snapshot", (event) => {
			if (cancelled) return;
			const next = JSON.parse((event as MessageEvent<string>).data) as OfficeSnapshot;
			if (!acceptance.acceptStream(streamGeneration, next)) return;
			setSnapshot(next);
			setConnection("live");
			setError(null);
			setRefreshError(null);
		});
		stream.onopen = () => {
			if (cancelled) return;
			if (opened) streamGeneration = acceptance.beginStream();
			else opened = true;
			setConnection("live");
		};
		stream.onerror = () => {
			if (!cancelled) setConnection((current) => current === "loading" ? "loading" : "reconnecting");
		};
		return () => {
			cancelled = true;
			stream.close();
		};
	}, [fixture, generation]);

	return { snapshot, connection, error, refreshError, refresh, reconnect: () => setGeneration((value) => value + 1) };
}
