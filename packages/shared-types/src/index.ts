export interface RoomPresence {
  userId: string;
  displayName: string;
  clientId: string;
  sessionId: string | null;
  videoDetected: boolean;
  mediaFingerprint: string | null;
  mediaTitle: string | null;
  pageUrl: string | null;
  joinedAt: string;
}
