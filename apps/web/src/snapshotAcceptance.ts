import type { OfficeSnapshot } from "@multica-office/contracts";

export interface SnapshotRequestTicket {
	streamGeneration: number;
	streamRevision: number;
	requestId: number;
}

export class SnapshotAcceptance {
	private streamGeneration = 0;
	private streamRevision = 0;
	private latestRequestId = 0;
	private streamSequence: number | null = null;

	beginStream(): number {
		this.streamGeneration += 1;
		this.streamRevision += 1;
		this.streamSequence = null;
		return this.streamGeneration;
	}

	beginRequest(): SnapshotRequestTicket {
		this.latestRequestId += 1;
		return {
			streamGeneration: this.streamGeneration,
			streamRevision: this.streamRevision,
			requestId: this.latestRequestId,
		};
	}

	acceptRequest(ticket: SnapshotRequestTicket): boolean {
		return ticket.streamGeneration === this.streamGeneration
			&& ticket.streamRevision === this.streamRevision
			&& ticket.requestId === this.latestRequestId;
	}

	acceptStream(streamGeneration: number, snapshot: OfficeSnapshot): boolean {
		if (streamGeneration !== this.streamGeneration) return false;
		if (this.streamSequence !== null && snapshot.sequence < this.streamSequence) return false;
		this.streamSequence = snapshot.sequence;
		this.streamRevision += 1;
		return true;
	}
}
