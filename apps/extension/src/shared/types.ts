export interface Profile {
  id: string;
  displayName: string;
  avatarUrl: string | null;
  createdAt: string;
}

export interface RoomMembership {
  roomId: string;
  userId: string;
  joinedAt: string;
  lastSeenAt: string;
}
