export const STATION_BOUNDS = {
	halfWidth: 62,
	top: 53,
	bottom: 92,
} as const;

export interface StationPosition {
	x: number;
	y: number;
}

export interface OfficeLayout {
	width: number;
	height: number;
	columns: number;
	rows: number;
	cellWidth: number;
	stations: StationPosition[];
}

const ROW_GAP = 142;
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function stationLabelGraphemes(value: string): string[] {
	return Array.from(graphemeSegmenter.segment(value), ({ segment }) => segment);
}

export interface MeasuredLabel {
	text: string;
	width: number;
	truncated: boolean;
}

export function stationLabelMaxWidth(cellWidth: number): number {
	return Math.max(32, Math.min(112, cellWidth - 8));
}

export function truncateMeasuredLabel(name: string, maxWidth: number, measure: (value: string) => number): MeasuredLabel {
	const measuredWidth = measure(name);
	if (Number.isFinite(measuredWidth) && measuredWidth >= 0 && measuredWidth <= maxWidth) {
		return { text: name, width: measuredWidth, truncated: false };
	}
	const ellipsis = "…";
	const ellipsisWidth = measure(ellipsis);
	if (!Number.isFinite(ellipsisWidth) || ellipsisWidth < 0 || ellipsisWidth > maxWidth) {
		return { text: "", width: 0, truncated: name.length > 0 };
	}
	let best = ellipsis;
	let bestWidth = ellipsisWidth;
	let prefix = "";
	for (const grapheme of stationLabelGraphemes(name)) {
		prefix += grapheme;
		const candidate = `${prefix}${ellipsis}`;
		const candidateWidth = measure(candidate);
		if (!Number.isFinite(candidateWidth) || candidateWidth < 0 || candidateWidth > maxWidth) continue;
		best = candidate;
		bestWidth = candidateWidth;
	}
	return { text: best, width: bestWidth, truncated: true };
}

export function officeColumns(width: number): number {
	if (width < 360) return 1;
	if (width < 620) return 2;
	if (width < 920) return 3;
	return 4;
}

export function computeOfficeLayout(agentCount: number, availableWidth: number, viewportHeight: number): OfficeLayout {
	const width = Math.max(1, Math.floor(availableWidth));
	const columns = officeColumns(width);
	const rows = agentCount === 0 ? 0 : Math.ceil(agentCount / columns);
	const horizontalPadding = Math.min(72, Math.max(STATION_BOUNDS.halfWidth + 4, width * 0.22));
	const usableWidth = Math.max(0, width - horizontalPadding * 2);
	const cellWidth = usableWidth / columns;
	const firstRowY = width < 560 ? 82 : 112;
	const requiredHeight = rows === 0
		? 0
		: firstRowY + (rows - 1) * ROW_GAP + STATION_BOUNDS.bottom + 18;
	const height = Math.max(1, Math.ceil(viewportHeight), Math.ceil(requiredHeight));
	const stations = Array.from({ length: agentCount }, (_, index) => ({
		x: horizontalPadding + (index % columns + 0.5) * cellWidth,
		y: firstRowY + Math.floor(index / columns) * ROW_GAP,
	}));
	return { width, height, columns, rows, cellWidth, stations };
}

export function stationIsWithinLayout(position: StationPosition, layout: Pick<OfficeLayout, "width" | "height">): boolean {
	return position.x - STATION_BOUNDS.halfWidth >= 0
		&& position.x + STATION_BOUNDS.halfWidth <= layout.width
		&& position.y - STATION_BOUNDS.top >= 0
		&& position.y + STATION_BOUNDS.bottom <= layout.height;
}
