export type PlaybackAction = "PLAY" | "PAUSE" | "SEEK" | "RATE_CHANGE";

export interface PlaybackEvent {
	eventId: string;
	senderId: string;
	clientId: string;
	logicalClock: number;
	sentAt: string;
	mediaFingerprint: string | null;
	action: PlaybackAction;
	mediaTime: number;
	playbackRate: number;
	paused: boolean;
}
