import { useState } from "react";
import { stationLabelGraphemes } from "./officeSceneLayout.js";

export const NICKNAME_STORAGE_KEY = "multica-office:nicknames:v1";
export const MAX_NICKNAME_LENGTH = 24;

export function compactStationName(name: string): string {
	const parts = name.split(/\s+-\s+/);
	return parts.length >= 3 ? parts.slice(-2).join(" · ") : name;
}

export function parseNicknames(raw: string | null): Record<string, string> {
	try {
		const value: unknown = JSON.parse(raw ?? "{}");
		if (!value || typeof value !== "object" || Array.isArray(value)) return {};
		return Object.fromEntries(Object.entries(value).filter(([, name]) =>
			typeof name === "string" && name.trim() && stationLabelGraphemes(name).length <= MAX_NICKNAME_LENGTH,
		).map(([id, name]) => [id, (name as string).trim()]));
	} catch { return {}; }
}

export function useAgentNicknames() {
	const [nicknames, setNicknames] = useState<Record<string, string>>(() => {
		try { return parseNicknames(window.localStorage.getItem(NICKNAME_STORAGE_KEY)); }
		catch { return {}; }
	});
	const saveNickname = (id: string, name: string): boolean => {
		const next = { ...nicknames };
		if (name) next[id] = name;
		else delete next[id];
		setNicknames(next);
		try { window.localStorage.setItem(NICKNAME_STORAGE_KEY, JSON.stringify(next)); return true; }
		catch { return false; }
	};
	return { nicknames, saveNickname };
}
