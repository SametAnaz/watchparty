export type PlaybackAction = "PLAY" | "PAUSE" | "SEEK" | "RATE_CHANGE";

export interface PlaybackEvent {
  eventId: string;
  senderId: string;
  clientId: string;
  logicalClock: number;
  mediaFingerprint: string | null;
  action: PlaybackAction;
  mediaTime: number;
  playbackRate: number;
  paused: boolean;
}

export type ReactionEmoji = "😂" | "❤️" | "😮" | "😡" | "😭" | "🤠";

export interface ReactionEvent {
  eventId: string;
  senderId: string;
  emoji: ReactionEmoji;
  anchorX: number;
  sentAt: string;
}
