import { Fragment, FormEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { Session } from "@supabase/supabase-js";
import type { RoomPresence } from "@samet-watchparty/shared-types";
import { RoomRealtime } from "../shared/room-realtime";
import type { ConnectionStatus } from "../shared/room-realtime";
import { supabase } from "../shared/supabase";
import type { MessageChangeEvent, PlaybackEvent, ReactionEmoji, ReactionEvent, TypingEvent } from "../shared/protocol";
import {
  ArrowLeftIcon,
  Avatar,
  CameraIcon,
  CheckIcon,
  ChevronDownIcon,
  CloseIcon,
  CopyIcon,
  FilmIcon,
  HeartIcon,
  LogOutIcon,
  PencilIcon,
  RefreshIcon,
  ReplyIcon,
  SearchIcon,
  SendIcon,
  SettingsIcon,
  SmileIcon,
  TrashIcon,
  UserIcon,
} from "./components";
import "./styles.css";

type Profile = { id: string; display_name: string; avatar_url: string | null };
type Room = { id: string; name: string; created_at: string };
type ReplyPreview = { id: string; body: string | null; author: string };
type Message = {
  id: string;
  sender_id: string;
  body: string | null;
  reply_to: string | null;
  created_at: string;
  edited_at: string | null;
  deleted_at: string | null;
  author: string;
  authorAvatar: string | null;
  reply: ReplyPreview | null;
  likeCount: number;
  likedByMe: boolean;
};
type MessageRow = Pick<Message, "id" | "sender_id" | "body" | "reply_to" | "created_at" | "edited_at" | "deleted_at">;
type Media = { title: string; mediaTime: number; duration: number; playbackRate: number; paused: boolean; detected: boolean; fingerprint: string | null; pageUrl: string | null };
type MediaCandidate = {
  frameId: number;
  candidateId: string;
  title: string;
  kind: "video" | "audio";
  duration: number;
  playing: boolean;
  paused: boolean;
  width: number;
  height: number;
};
type MediaSelection = { frameId: number; candidateId: string };
type MessageSearchResult = Pick<Message, "id" | "sender_id" | "body" | "created_at">;
type AnimationIntensity = "low" | "normal" | "high";
type AppSettings = { messageSound: boolean; animationIntensity: AnimationIntensity };
type PlaybackSnapshot = {
  session_id: string;
  media_title: string | null;
  media_fingerprint: string | null;
  media_time: number;
  paused: boolean;
  playback_rate: number;
  revision: number;
  updated_by: string | null;
  updated_at: string;
  server_time: string;
  applied?: boolean;
};
type PendingPlayback = { event: PlaybackEvent; receivedAt: number };
type SnapshotWriteResult = { saved: boolean; snapshot: PlaybackSnapshot | null };
type ReactionParticle = { x: number; drift: number; delay: number; duration: number; size: number; rotation: number };
type ReactionBurst = ReactionEvent & { burstId: string; particles: ReactionParticle[] };

const clientId = crypto.randomUUID();
const presenceJoinedAt = new Date().toISOString();
const MESSAGE_PAGE_SIZE = 40;
const MAX_AVATAR_SIZE = 5 * 1024 * 1024;
const REACTIONS: { emoji: ReactionEmoji; label: string }[] = [
  { emoji: "😂", label: "Gülme" },
  { emoji: "❤️", label: "Kalp" },
  { emoji: "😮", label: "Şaşırma" },
  { emoji: "😡", label: "Kızma" },
  { emoji: "😭", label: "Ağlama" },
  { emoji: "🤠", label: "Kovboy" },
];
const CHAT_EMOJIS: ReactionEmoji[] = [
  "😀", "😃", "😄", "😁", "😆", "😅", "😂", "🤣",
  "😊", "😇", "🙂", "🙃", "😉", "😌", "😍", "🥰",
  "😘", "😋", "😎", "🤩", "🥳", "😏", "😒", "😔",
  "😢", "😭", "😡", "🤬", "🤯", "😱", "😮", "🤔",
  "🫡", "🤭", "🫢", "🫣", "🤗", "🫠", "🥹", "😴",
  "👍", "👎", "👏", "🙌", "🙏", "💪", "🤝", "👌",
  "✌️", "🤞", "🫶", "👀", "💋", "💯", "✨", "🔥",
  "❤️", "🧡", "💛", "💚", "💙", "💜", "🖤", "🤍",
  "💔", "💕", "💖", "💘", "🎉", "🎊", "🥂", "🍿",
  "🎬", "🎵", "🌙", "⭐", "☀️", "🌈", "🐱", "🐶",
  "🙈", "🙉", "🙊", "💩", "👻", "🤖", "🤠", "👑",
];
const REACTION_EMOJIS = new Set<ReactionEmoji>([...CHAT_EMOJIS, ...REACTIONS.map((reaction) => reaction.emoji)]);
const EMOJI_USAGE_STORAGE_KEY = "watchpartyEmojiUsage";
const SETTINGS_STORAGE_KEY = "watchpartySettings";
const DEFAULT_SETTINGS: AppSettings = { messageSound: true, animationIntensity: "normal" };
const EMPTY_MEDIA: Media = {
  title: "Video bekleniyor",
  mediaTime: 0,
  duration: 0,
  playbackRate: 1,
  paused: true,
  detected: false,
  fingerprint: null,
  pageUrl: null,
};
const EMOJI_DEFAULT_ORDER = new Map(CHAT_EMOJIS.map((emoji, index) => [emoji, index]));
let notificationAudioContext: AudioContext | null = null;

function sortChatEmojis(usage: Record<string, number>) {
  return [...CHAT_EMOJIS].sort((first, second) => {
    const weightDifference = (usage[second] ?? 0) - (usage[first] ?? 0);
    return weightDifference || (EMOJI_DEFAULT_ORDER.get(first) ?? 0) - (EMOJI_DEFAULT_ORDER.get(second) ?? 0);
  });
}

function playMessageSound() {
  try {
    notificationAudioContext ??= new AudioContext();
    const context = notificationAudioContext;
    void context.resume();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const now = context.currentTime;
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(720, now);
    oscillator.frequency.exponentialRampToValueAtTime(920, now + 0.09);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.035, now + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(now);
    oscillator.stop(now + 0.13);
  } catch {
    // Audio can remain blocked until the user first interacts with the side panel.
  }
}

function displayNameFromEmail(email: string | undefined) {
  return email?.split("@")[0]?.trim() || "Watchparty kullanıcısı";
}

function formatTime(value: number) {
  if (!Number.isFinite(value)) return "00:00";
  const seconds = Math.max(0, Math.floor(value));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function formatClock(value: string) {
  return new Intl.DateTimeFormat("tr-TR", { hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function calendarDayKey(value: string | Date) {
  const date = value instanceof Date ? value : new Date(value);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function formatDateDivider(value: string) {
  const date = new Date(value);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (calendarDayKey(date) === calendarDayKey(today)) return "Bugün";
  if (calendarDayKey(date) === calendarDayKey(yesterday)) return "Dün";
  return new Intl.DateTimeFormat("tr-TR", { day: "numeric", month: "long", year: date.getFullYear() === today.getFullYear() ? undefined : "numeric" }).format(date);
}

function escapeLikePattern(value: string) {
  return value.replace(/[\\%_]/g, "\\$&");
}

function normalizePlaybackSnapshot(value: unknown): PlaybackSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.session_id !== "string" || typeof row.updated_at !== "string" || typeof row.server_time !== "string") return null;
  const mediaTime = Number(row.media_time);
  const playbackRate = Number(row.playback_rate);
  const revision = Number(row.revision);
  if (![mediaTime, playbackRate, revision].every(Number.isFinite)) return null;
  return {
    session_id: row.session_id,
    media_title: typeof row.media_title === "string" ? row.media_title : null,
    media_fingerprint: typeof row.media_fingerprint === "string" ? row.media_fingerprint : null,
    media_time: Math.max(0, mediaTime),
    paused: row.paused !== false,
    playback_rate: playbackRate,
    revision,
    updated_by: typeof row.updated_by === "string" ? row.updated_by : null,
    updated_at: row.updated_at,
    server_time: row.server_time,
    applied: typeof row.applied === "boolean" ? row.applied : undefined,
  };
}

function messageFromError(error: unknown) {
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message;
  return "İşlem tamamlanamadı.";
}

function uniquePresence(state: Record<string, RoomPresence[]>) {
  const byUserId = new Map<string, RoomPresence>();
  for (const item of Object.values(state).flat()) {
    if (!item.userId) continue;
    const current = byUserId.get(item.userId);
    if (!current || item.joinedAt >= current.joinedAt) byUserId.set(item.userId, item);
  }
  return [...byUserId.values()];
}

async function ensureProfile(session: Session) {
  const { error } = await supabase.from("profiles").upsert(
    { id: session.user.id, display_name: displayNameFromEmail(session.user.email) },
    { onConflict: "id", ignoreDuplicates: true },
  );
  if (error) throw error;
}

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [activeRoom, setActiveRoom] = useState<Room | null>(null);
  const [members, setMembers] = useState<Profile[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [hasOlderMessages, setHasOlderMessages] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [presence, setPresence] = useState<RoomPresence[]>([]);
  const [roomName, setRoomName] = useState("");
  const [selectedUserId, setSelectedUserId] = useState("");
  const [messageBody, setMessageBody] = useState("");
  const [replyingTo, setReplyingTo] = useState<Message | null>(null);
  const [editingMessage, setEditingMessage] = useState<Message | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<MessageSearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);
  const [media, setMedia] = useState<Media>(EMPTY_MEDIA);
  const [mediaCandidates, setMediaCandidates] = useState<MediaCandidate[]>([]);
  const [selectedMedia, setSelectedMedia] = useState<MediaSelection | null>(null);
  const [mediaPickerOpen, setMediaPickerOpen] = useState(false);
  const [selectingMediaId, setSelectingMediaId] = useState<string | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("offline");
  const [syncingPlayback, setSyncingPlayback] = useState(false);
  const [syncNotice, setSyncNotice] = useState<string | null>(null);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [profileModalOpen, setProfileModalOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [profileName, setProfileName] = useState("");
  const [profileEmail, setProfileEmail] = useState("");
  const [profilePassword, setProfilePassword] = useState("");
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileNotice, setProfileNotice] = useState<string | null>(null);
  const [reactionBursts, setReactionBursts] = useState<ReactionBurst[]>([]);
  const [typingUsers, setTypingUsers] = useState<Record<string, string>>({});
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
  const [holdingEmoji, setHoldingEmoji] = useState<ReactionEmoji | null>(null);
  const [orderedChatEmojis, setOrderedChatEmojis] = useState<ReactionEmoji[]>(CHAT_EMOJIS);

  const realtime = useRef(new RoomRealtime());
  const logicalClock = useRef(0);
  const activeRoomIdRef = useRef<string | undefined>(undefined);
  const roomGenerationRef = useRef(0);
  const playbackApplyVersionRef = useRef(0);
  const playbackClockByClientRef = useRef(new Map<string, number>());
  const activeTabId = useRef<number | undefined>(undefined);
  const activeFrameId = useRef<number | undefined>(undefined);
  const mediaFingerprintRef = useRef<string | null>(null);
  const mediaRef = useRef(media);
  const mediaReadyRef = useRef(false);
  const mediaSelectionGenerationRef = useRef(0);
  const pendingRemotePlaybackRef = useRef<PendingPlayback | null>(null);
  const joinedMediaRef = useRef<{ tabId: number | null; fingerprint: string; pageUrl: string | null } | null>(null);
  const messageLimitRef = useRef(MESSAGE_PAGE_SIZE);
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const messageElementsRef = useRef(new Map<string, HTMLElement>());
  const pendingScrollMessageRef = useRef<string | null>(null);
  const highlightTimerRef = useRef<number | undefined>(undefined);
  const messageLoadSequenceRef = useRef(0);
  const memberLoadSequenceRef = useRef(0);
  const searchSequenceRef = useRef(0);
  const scrollToBottomRef = useRef(true);
  const restoreScrollRef = useRef<{ height: number; top: number } | null>(null);
  const profileMenuRef = useRef<HTMLDivElement | null>(null);
  const emojiPickerRef = useRef<HTMLDivElement | null>(null);
  const mediaPickerRef = useRef<HTMLDivElement | null>(null);
  const messageInputRef = useRef<HTMLInputElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const reactionTimersRef = useRef<number[]>([]);
  const typingExpiryTimersRef = useRef(new Map<string, number>());
  const localTypingStopTimerRef = useRef<number | undefined>(undefined);
  const lastTypingSentAtRef = useRef(0);
  const emojiHoldTimerRef = useRef<number | undefined>(undefined);
  const emojiHoldTriggeredRef = useRef(false);
  const emojiUsageRef = useRef<Record<string, number>>({});
  const emojiPickerOpenRef = useRef(false);
  const settingsRef = useRef<AppSettings>(DEFAULT_SETTINGS);
  const playbackSnapshotRef = useRef<PlaybackSnapshot | null>(null);
  const snapshotWriteSequenceRef = useRef(0);
  const snapshotWriteQueueRef = useRef<Promise<void>>(Promise.resolve());
  const snapshotInitialLoadCompleteRef = useRef(false);
  const snapshotBootstrapStartedRef = useRef(false);
  const bootstrapSnapshotRef = useRef<(roomId: string) => void>(() => undefined);
  const lastLocalPlaybackAtRef = useRef(0);
  const syncNoticeTimerRef = useRef<number | undefined>(undefined);
  const connectionStatusRef = useRef<ConnectionStatus>("offline");
  const hasConnectedRoomRef = useRef(false);

  const activeRoomId = activeRoom?.id;
  activeRoomIdRef.current = activeRoomId;
  const currentUserId = session?.user.id;
  const currentProfile = profiles.find((item) => item.id === currentUserId);
  const currentDisplayName = currentProfile?.display_name ?? displayNameFromEmail(session?.user.email);
  const currentDisplayNameRef = useRef(currentDisplayName);
  currentDisplayNameRef.current = currentDisplayName;
  settingsRef.current = settings;
  mediaRef.current = media;

  const loadProfiles = useCallback(async () => {
    const { data, error: queryError } = await supabase.from("profiles").select("id, display_name, avatar_url").order("display_name");
    if (queryError) throw queryError;
    setProfiles((data ?? []) as Profile[]);
  }, []);

  const loadRooms = useCallback(async (userId: string) => {
    const { data: memberships, error: memberError } = await supabase.from("room_members").select("room_id").eq("user_id", userId);
    if (memberError) throw memberError;
    const roomIds = (memberships ?? []).map((membership) => membership.room_id as string);
    if (!roomIds.length) { setRooms([]); return; }
    const { data, error: roomError } = await supabase.from("rooms").select("id, name, created_at").in("id", roomIds).is("archived_at", null).order("created_at", { ascending: false });
    if (roomError) throw roomError;
    setRooms((data ?? []) as Room[]);
  }, []);

  const loadMembers = useCallback(async (roomId: string) => {
    const sequence = ++memberLoadSequenceRef.current;
    const { data: memberRows, error: memberError } = await supabase.from("room_members").select("user_id").eq("room_id", roomId);
    if (memberError) throw memberError;
    const ids = (memberRows ?? []).map((member) => member.user_id as string);
    if (!ids.length) {
      if (sequence === memberLoadSequenceRef.current && activeRoomIdRef.current === roomId) setMembers([]);
      return;
    }
    const { data, error: profileError } = await supabase.from("profiles").select("id, display_name, avatar_url").in("id", ids);
    if (profileError) throw profileError;
    if (sequence === memberLoadSequenceRef.current && activeRoomIdRef.current === roomId) setMembers((data ?? []) as Profile[]);
  }, []);

  const loadMessages = useCallback(async (roomId: string) => {
    const sequence = ++messageLoadSequenceRef.current;
    const limit = messageLimitRef.current;
    const { data, error: queryError } = await supabase
      .from("messages")
      .select("id, sender_id, body, reply_to, created_at, edited_at, deleted_at")
      .eq("room_id", roomId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(limit + 1);
    if (queryError) throw queryError;

    const descendingRows = (data ?? []) as MessageRow[];
    const rows = descendingRows.slice(0, limit).reverse();
    const replyIds = [...new Set(rows.map((message) => message.reply_to).filter((id): id is string => Boolean(id)))];
    const { data: replyRows, error: replyError } = replyIds.length
      ? await supabase.from("messages").select("id, sender_id, body, deleted_at").in("id", replyIds)
      : { data: [] as { id: string; sender_id: string; body: string | null; deleted_at: string | null }[], error: null };
    if (replyError) throw replyError;

    const typedReplies = (replyRows ?? []) as { id: string; sender_id: string; body: string | null; deleted_at: string | null }[];
    const senderIds = [...new Set([...rows.map((message) => message.sender_id), ...typedReplies.map((message) => message.sender_id)])];
    const { data: authors, error: authorsError } = senderIds.length
      ? await supabase.from("profiles").select("id, display_name, avatar_url").in("id", senderIds)
      : { data: [] as Profile[], error: null };
    if (authorsError) throw authorsError;

    const messageIds = rows.map((message) => message.id);
    const { data: reactions, error: reactionsError } = messageIds.length
      ? await supabase.from("message_reactions").select("message_id, user_id").eq("reaction", "like").in("message_id", messageIds)
      : { data: [] as { message_id: string; user_id: string }[], error: null };
    if (reactionsError) throw reactionsError;

    const authorById = new Map(((authors ?? []) as Profile[]).map((profile) => [profile.id, profile]));
    const replyById = new Map(typedReplies.map((reply) => [reply.id, reply]));
    const likesByMessage = new Map<string, string[]>();
    for (const reaction of (reactions ?? []) as { message_id: string; user_id: string }[]) {
      likesByMessage.set(reaction.message_id, [...(likesByMessage.get(reaction.message_id) ?? []), reaction.user_id]);
    }

    const hydrated = rows.map((message) => {
      const author = authorById.get(message.sender_id);
      const reply = message.reply_to ? replyById.get(message.reply_to) : undefined;
      const replyAuthor = reply ? authorById.get(reply.sender_id) : undefined;
      const likes = likesByMessage.get(message.id) ?? [];
      return {
        ...message,
        author: author?.display_name ?? "Bilinmeyen",
        authorAvatar: author?.avatar_url ?? null,
        reply: reply ? { id: reply.id, body: reply.deleted_at ? null : reply.body, author: replyAuthor?.display_name ?? "Bilinmeyen" } : null,
        likeCount: likes.length,
        likedByMe: currentUserId ? likes.includes(currentUserId) : false,
      };
    });
    if (sequence !== messageLoadSequenceRef.current || activeRoomIdRef.current !== roomId) return;
    setHasOlderMessages(descendingRows.length > limit);
    setMessages(hydrated);
  }, [currentUserId]);

  const showReaction = useCallback((event: ReactionEvent) => {
    if (!REACTION_EMOJIS.has(event.emoji)) return;
    const anchorX = event.senderId === currentUserId ? 82 : 18;
    const burstId = `${event.eventId}:${crypto.randomUUID()}`;
    const intensity = settingsRef.current.animationIntensity;
    const particleCount = intensity === "low" ? 3 : intensity === "high" ? 10 : 6;
    const particles = Array.from({ length: particleCount }, (_, index): ReactionParticle => ({
      x: (Math.random() - 0.5) * 34,
      drift: (Math.random() - 0.5) * 86,
      delay: index * 45 + Math.random() * 90,
      duration: (intensity === "low" ? 1600 : intensity === "high" ? 2250 : 1950) + Math.random() * 650,
      size: 20 + Math.random() * 13,
      rotation: (Math.random() - 0.5) * 48,
    }));
    setReactionBursts((bursts) => [...bursts.slice(-11), { ...event, anchorX, burstId, particles }]);
    const timer = window.setTimeout(() => {
      setReactionBursts((bursts) => bursts.filter((burst) => burst.burstId !== burstId));
      reactionTimersRef.current = reactionTimersRef.current.filter((item) => item !== timer);
    }, 3200);
    reactionTimersRef.current.push(timer);
  }, [currentUserId]);

  const handleTyping = useCallback((event: TypingEvent) => {
    if (!event?.senderId || event.senderId === currentUserId) return;
    const previousTimer = typingExpiryTimersRef.current.get(event.senderId);
    if (previousTimer !== undefined) window.clearTimeout(previousTimer);

    if (!event.isTyping) {
      typingExpiryTimersRef.current.delete(event.senderId);
      setTypingUsers((users) => {
        const next = { ...users };
        delete next[event.senderId];
        return next;
      });
      return;
    }

    setTypingUsers((users) => ({ ...users, [event.senderId]: event.displayName || "Birisi" }));
    const timer = window.setTimeout(() => {
      typingExpiryTimersRef.current.delete(event.senderId);
      setTypingUsers((users) => {
        const next = { ...users };
        delete next[event.senderId];
        return next;
      });
    }, 2600);
    typingExpiryTimersRef.current.set(event.senderId, timer);
  }, [currentUserId]);

  const applyPlaybackToActiveTab = useCallback(async (event: PlaybackEvent, receivedAt?: number) => {
    const sameMedia = !event.mediaFingerprint || !mediaFingerprintRef.current || event.mediaFingerprint === mediaFingerprintRef.current;
    if (!sameMedia) {
      console.debug("[Watchparty Playback] ignored: media mismatch", { remote: event.mediaFingerprint, local: mediaFingerprintRef.current });
      return "mismatch" as const;
    }
    if (activeTabId.current === undefined) return "unavailable" as const;
    if (!mediaReadyRef.current) {
      pendingRemotePlaybackRef.current = { event, receivedAt: receivedAt ?? Date.now() };
      return "queued" as const;
    }

    const sentAt = Date.parse(event.sentAt);
    const receivedTimestamp = receivedAt ?? Date.now();
    const rawTransitSeconds = (receivedTimestamp - sentAt) / 1000;
    const networkTransitSeconds = event.clientId === "snapshot"
      ? Math.min(300, Math.max(0, Number.isFinite(rawTransitSeconds) ? rawTransitSeconds : 0))
      : rawTransitSeconds >= 0 && rawTransitSeconds <= 2
        ? rawTransitSeconds
        : 0;
    const queuedSeconds = receivedAt === undefined
      ? 0
      : Math.min(300, Math.max(0, (Date.now() - receivedAt) / 1000));
    const transitSeconds = event.paused ? 0 : networkTransitSeconds + queuedSeconds;
    const adjustedEvent = {
      ...event,
      mediaTime: Math.max(0, event.mediaTime + transitSeconds * event.playbackRate),
    };
    try {
      const response = await chrome.runtime.sendMessage({
        type: "WATCHPARTY_APPLY_REMOTE_PLAYBACK",
        tabId: activeTabId.current,
        frameId: activeFrameId.current,
        ...adjustedEvent,
      }) as { applied?: boolean } | undefined;
      return response?.applied ? "applied" as const : "unavailable" as const;
    } catch (applyError) {
      console.warn("[Watchparty Playback] remote state could not be applied", applyError);
      return "unavailable" as const;
    }
  }, []);

  const applyPlaybackSnapshot = useCallback(async (snapshot: PlaybackSnapshot, roundTripMs: number) => {
    const serverAdvanceSeconds = snapshot.paused
      ? 0
      : Math.max(0, (Date.parse(snapshot.server_time) - Date.parse(snapshot.updated_at)) / 1000);
    const playback: PlaybackEvent = {
      eventId: `snapshot:${snapshot.session_id}:${snapshot.revision}`,
      senderId: snapshot.updated_by ?? "snapshot",
      clientId: "snapshot",
      logicalClock: snapshot.revision,
      sentAt: new Date(Date.now() - Math.max(0, roundTripMs / 2)).toISOString(),
      mediaFingerprint: snapshot.media_fingerprint,
      action: "SEEK",
      mediaTime: Math.max(0, snapshot.media_time + serverAdvanceSeconds * snapshot.playback_rate),
      playbackRate: snapshot.playback_rate,
      paused: snapshot.paused,
    };
    logicalClock.current = Math.max(logicalClock.current, snapshot.revision) + 1;
    playbackApplyVersionRef.current += 1;
    return await applyPlaybackToActiveTab(playback);
  }, [applyPlaybackToActiveTab]);

  const fetchPlaybackSnapshot = useCallback(async (roomId: string, apply: boolean) => {
    const localPlaybackAtStart = lastLocalPlaybackAtRef.current;
    const applyVersionAtStart = playbackApplyVersionRef.current;
    const roomGeneration = roomGenerationRef.current;
    const tabIdAtStart = activeTabId.current;
    const mediaGenerationAtStart = mediaSelectionGenerationRef.current;
    const startedAt = performance.now();
    const { data, error: snapshotError } = await supabase.rpc("get_playback_snapshot", { p_room_id: roomId });
    if (snapshotError) throw snapshotError;
    if (roomGeneration !== roomGenerationRef.current || activeRoomIdRef.current !== roomId) {
      return { snapshot: null, result: "ignored" as const };
    }
    const normalized = normalizePlaybackSnapshot(Array.isArray(data) ? data[0] : null);
    const snapshot = normalized && normalized.revision > 0 ? normalized : null;
    snapshotInitialLoadCompleteRef.current = true;
    playbackSnapshotRef.current = snapshot;
    if (!snapshot) {
      bootstrapSnapshotRef.current(roomId);
      return { snapshot: null, result: "empty" as const };
    }
    const result = apply
      ? lastLocalPlaybackAtRef.current === localPlaybackAtStart
        && playbackApplyVersionRef.current === applyVersionAtStart
        && activeTabId.current === tabIdAtStart
        && mediaSelectionGenerationRef.current === mediaGenerationAtStart
        ? await applyPlaybackSnapshot(snapshot, performance.now() - startedAt)
        : "stale" as const
      : "loaded" as const;
    return { snapshot, result };
  }, [applyPlaybackSnapshot]);

  const persistPlaybackSnapshot = useCallback((
    roomId: string,
    playback: PlaybackEvent,
    options?: { onlyIfEmpty?: boolean },
  ) => {
    const sequence = ++snapshotWriteSequenceRef.current;
    const mediaAtEvent = { ...mediaRef.current };
    const task = async (): Promise<SnapshotWriteResult> => {
      if (sequence !== snapshotWriteSequenceRef.current || activeRoomIdRef.current !== roomId) {
        return { saved: false, snapshot: null };
      }
      const { data: sessionRows, error: sessionError } = await supabase.rpc("ensure_active_watch_session", {
        p_room_id: roomId,
        p_media_title: mediaAtEvent.detected ? mediaAtEvent.title : null,
        p_media_fingerprint: playback.mediaFingerprint,
        p_adapter_key: "html-media",
      });
      if (sessionError) throw sessionError;
      const sessionSnapshot = normalizePlaybackSnapshot(Array.isArray(sessionRows) ? sessionRows[0] : null);
      if (!sessionSnapshot) throw new Error("Oynatma oturumu oluşturulamadı.");
      if (sequence !== snapshotWriteSequenceRef.current || activeRoomIdRef.current !== roomId) {
        return { saved: false, snapshot: null };
      }
      if (options?.onlyIfEmpty && sessionSnapshot.revision > 0) {
        playbackSnapshotRef.current = sessionSnapshot;
        return { saved: false, snapshot: sessionSnapshot };
      }

      const write = async (expectedRevision: number | null) => {
        const sentAt = Date.parse(playback.sentAt);
        const elapsedSeconds = playback.paused || !Number.isFinite(sentAt)
          ? 0
          : Math.max(0, (Date.now() - sentAt) / 1000);
        const { data, error: updateError } = await supabase.rpc("update_playback_snapshot", {
          p_room_id: roomId,
          p_session_id: sessionSnapshot.session_id,
          p_media_time: Math.max(0, playback.mediaTime + elapsedSeconds * playback.playbackRate),
          p_paused: playback.paused,
          p_playback_rate: playback.playbackRate,
          p_expected_revision: expectedRevision,
        });
        if (updateError) throw updateError;
        return normalizePlaybackSnapshot(Array.isArray(data) ? data[0] : null);
      };

      // Normal playback uses the database row lock as a server-arrival order.
      // Bootstrap alone uses CAS so two late joiners cannot initialize over an
      // already established snapshot.
      const updated = await write(options?.onlyIfEmpty ? sessionSnapshot.revision : null);
      if (!updated) return { saved: false, snapshot: null };
      if (sequence === snapshotWriteSequenceRef.current && activeRoomIdRef.current === roomId) {
        playbackSnapshotRef.current = updated;
        return { saved: updated.applied !== false, snapshot: updated };
      }
      return { saved: false, snapshot: null };
    };
    const queued = snapshotWriteQueueRef.current.catch(() => undefined).then(task);
    snapshotWriteQueueRef.current = queued.then(() => undefined, () => undefined);
    return queued;
  }, []);

  bootstrapSnapshotRef.current = (roomId: string) => {
    const currentMedia = mediaRef.current;
    if (
      !snapshotInitialLoadCompleteRef.current
      || snapshotBootstrapStartedRef.current
      || playbackSnapshotRef.current
      || activeRoomIdRef.current !== roomId
      || !currentMedia.detected
    ) return;
    snapshotBootstrapStartedRef.current = true;
    logicalClock.current += 1;
    playbackApplyVersionRef.current += 1;
    const playback: PlaybackEvent = {
      eventId: crypto.randomUUID(),
      senderId: currentUserId ?? "local",
      clientId,
      logicalClock: logicalClock.current,
      sentAt: new Date().toISOString(),
      mediaFingerprint: currentMedia.fingerprint,
      action: currentMedia.paused ? "PAUSE" : "PLAY",
      mediaTime: currentMedia.mediaTime,
      playbackRate: currentMedia.playbackRate,
      paused: currentMedia.paused,
    };
    void persistPlaybackSnapshot(roomId, playback, { onlyIfEmpty: true })
      .then(async ({ saved, snapshot }) => {
        if (saved) await realtime.current.sendPlayback(playback);
        else if (snapshot && activeRoomIdRef.current === roomId) await applyPlaybackSnapshot(snapshot, 0);
      })
      .catch((bootstrapError) => {
        snapshotBootstrapStartedRef.current = false;
        console.warn("[Watchparty Playback] initial snapshot could not be saved", bootstrapError);
      });
  };

  useEffect(() => {
    let mounted = true;
    let recoveringSession = false;
    const recoverSession = async () => {
      if (!mounted || recoveringSession || document.visibilityState === "hidden") return;
      recoveringSession = true;
      try {
        const { data, error: recoveryError } = await supabase.auth.getSession();
        if (recoveryError) throw recoveryError;
        if (mounted) setSession(data.session);
      } catch (recoveryError) {
        console.warn("[Watchparty Auth] session recovery failed", recoveryError);
      } finally {
        recoveringSession = false;
      }
    };
    void supabase.auth.getSession()
      .then(async ({ data, error: sessionError }) => {
        if (!mounted) return;
        if (sessionError) console.warn("[Watchparty Auth] stored session could not be read", sessionError);
        setSession(data.session);
        setLoading(false);
        if (data.session) {
          try {
            await ensureProfile(data.session);
            await Promise.all([loadProfiles(), loadRooms(data.session.user.id)]);
          } catch (initError) {
            console.error("Watchparty initialization failed", initError);
          }
        }
      })
      .catch((sessionError) => {
        console.error("Watchparty session initialization failed", sessionError);
        if (mounted) {
          setLoading(false);
        }
      });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => { if (mounted) setSession(nextSession); });
    const handleVisibility = () => { if (document.visibilityState === "visible") void recoverSession(); };
    const handleForeground = () => { void recoverSession(); };
    const recoveryTimer = window.setInterval(() => { void recoverSession(); }, 10 * 60 * 1000);
    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("focus", handleForeground);
    window.addEventListener("online", handleForeground);
    return () => {
      mounted = false;
      window.clearInterval(recoveryTimer);
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("focus", handleForeground);
      window.removeEventListener("online", handleForeground);
      listener.subscription.unsubscribe();
    };
  }, [loadProfiles, loadRooms]);

  useEffect(() => {
    let mounted = true;
    void chrome.storage.local.get([EMOJI_USAGE_STORAGE_KEY, SETTINGS_STORAGE_KEY]).then((result) => {
      if (!mounted) return;
      const stored = result[EMOJI_USAGE_STORAGE_KEY];
      const restored: Record<string, number> = {};
      if (stored && typeof stored === "object") {
        for (const emoji of CHAT_EMOJIS) {
          const weight = (stored as Record<string, unknown>)[emoji];
          if (typeof weight === "number" && Number.isFinite(weight) && weight > 0) restored[emoji] = Math.floor(weight);
        }
      }
      const merged = { ...restored };
      for (const [emoji, weight] of Object.entries(emojiUsageRef.current)) {
        merged[emoji] = (merged[emoji] ?? 0) + weight;
      }
      emojiUsageRef.current = merged;
      if (!emojiPickerOpenRef.current) setOrderedChatEmojis(sortChatEmojis(merged));

      const storedSettings = result[SETTINGS_STORAGE_KEY];
      if (storedSettings && typeof storedSettings === "object") {
        const candidate = storedSettings as Partial<AppSettings>;
        const restoredSettings: AppSettings = {
          messageSound: typeof candidate.messageSound === "boolean" ? candidate.messageSound : DEFAULT_SETTINGS.messageSound,
          animationIntensity: candidate.animationIntensity === "low" || candidate.animationIntensity === "high"
            ? candidate.animationIntensity
            : "normal",
        };
        settingsRef.current = restoredSettings;
        setSettings(restoredSettings);
      }
    }).catch((storageError) => {
      console.warn("[Watchparty Emoji] usage history could not be loaded", storageError);
    });
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    const closeMenu = (event: PointerEvent) => {
      if (profileMenuRef.current && !profileMenuRef.current.contains(event.target as Node)) setProfileMenuOpen(false);
      if (emojiPickerRef.current && !emojiPickerRef.current.contains(event.target as Node)) {
        emojiPickerOpenRef.current = false;
        setEmojiPickerOpen(false);
      }
      if (mediaPickerRef.current && !mediaPickerRef.current.contains(event.target as Node)) setMediaPickerOpen(false);
    };
    document.addEventListener("pointerdown", closeMenu);
    return () => document.removeEventListener("pointerdown", closeMenu);
  }, []);

  useEffect(() => {
    const closeTopmostOverlay = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (settingsOpen) setSettingsOpen(false);
      else if (profileModalOpen) setProfileModalOpen(false);
      else if (mediaPickerOpen) setMediaPickerOpen(false);
      else if (emojiPickerOpen) {
        emojiPickerOpenRef.current = false;
        setEmojiPickerOpen(false);
      } else if (searchOpen) setSearchOpen(false);
      else if (profileMenuOpen) setProfileMenuOpen(false);
      else return;
      event.preventDefault();
    };
    document.addEventListener("keydown", closeTopmostOverlay);
    return () => document.removeEventListener("keydown", closeTopmostOverlay);
  }, [emojiPickerOpen, mediaPickerOpen, profileMenuOpen, profileModalOpen, searchOpen, settingsOpen]);

  useEffect(() => () => {
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    for (const timer of reactionTimersRef.current) window.clearTimeout(timer);
    for (const timer of typingExpiryTimersRef.current.values()) window.clearTimeout(timer);
    if (localTypingStopTimerRef.current !== undefined) window.clearTimeout(localTypingStopTimerRef.current);
    if (emojiHoldTimerRef.current !== undefined) window.clearTimeout(emojiHoldTimerRef.current);
    if (highlightTimerRef.current !== undefined) window.clearTimeout(highlightTimerRef.current);
    if (syncNoticeTimerRef.current !== undefined) window.clearTimeout(syncNoticeTimerRef.current);
  }, []);

  useEffect(() => {
    const online = () => {
      if (!activeRoomId || connectionStatusRef.current !== "offline") return;
      void realtime.current.reconnect().catch((reconnectError) => {
        console.warn("[Watchparty Live] browser-online reconnect failed", reconnectError);
      });
    };
    const offline = () => {
      connectionStatusRef.current = "offline";
      setConnectionStatus("offline");
    };
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    return () => {
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
    };
  }, [activeRoomId]);

  useEffect(() => {
    if (!currentUserId || !activeRoomId) return;
    const roomGeneration = ++roomGenerationRef.current;
    snapshotWriteSequenceRef.current += 1;
    mediaSelectionGenerationRef.current += 1;
    messageLoadSequenceRef.current += 1;
    memberLoadSequenceRef.current += 1;
    messageLimitRef.current = MESSAGE_PAGE_SIZE;
    scrollToBottomRef.current = true;
    restoreScrollRef.current = null;
    pendingScrollMessageRef.current = null;
    messageElementsRef.current.clear();
    playbackClockByClientRef.current.clear();
    setMessages([]);
    setMembers([]);
    setPresence([]);
    setHasOlderMessages(false);
    setLoadingOlder(false);
    setReplyingTo(null);
    setEditingMessage(null);
    setSearchOpen(false);
    setSearchQuery("");
    setSearchResults([]);
    setTypingUsers({});
    if (syncNoticeTimerRef.current !== undefined) window.clearTimeout(syncNoticeTimerRef.current);
    syncNoticeTimerRef.current = undefined;
    setSyncingPlayback(false);
    setSyncNotice(null);
    const initialConnectionStatus = navigator.onLine ? "reconnecting" : "offline";
    connectionStatusRef.current = initialConnectionStatus;
    hasConnectedRoomRef.current = false;
    setConnectionStatus(initialConnectionStatus);
    setMediaCandidates([]);
    setSelectedMedia(null);
    setMediaPickerOpen(false);
    setSelectingMediaId(null);
    playbackSnapshotRef.current = null;
    snapshotInitialLoadCompleteRef.current = false;
    snapshotBootstrapStartedRef.current = false;
    pendingRemotePlaybackRef.current = null;
    emojiPickerOpenRef.current = false;
    setEmojiPickerOpen(false);
    for (const timer of typingExpiryTimersRef.current.values()) window.clearTimeout(timer);
    typingExpiryTimersRef.current.clear();
    if (localTypingStopTimerRef.current !== undefined) window.clearTimeout(localTypingStopTimerRef.current);
    localTypingStopTimerRef.current = undefined;
    lastTypingSentAtRef.current = 0;
    const initialPresence: RoomPresence = {
      userId: currentUserId,
      displayName: currentDisplayNameRef.current,
      clientId,
      sessionId: null,
      videoDetected: false,
      mediaFingerprint: null,
      mediaTitle: null,
      pageUrl: null,
      joinedAt: presenceJoinedAt,
    };
    void Promise.all([loadMembers(activeRoomId), loadMessages(activeRoomId)]).catch((loadError) => {
      console.warn("[Watchparty Room] initial room data could not be loaded", loadError);
    });
    void realtime.current.connect(
      activeRoomId,
      initialPresence,
      (event) => {
        const lastClock = playbackClockByClientRef.current.get(event.clientId) ?? -1;
        if (event.logicalClock <= lastClock) return;
        playbackClockByClientRef.current.set(event.clientId, event.logicalClock);
        logicalClock.current = Math.max(logicalClock.current, event.logicalClock) + 1;
        if (event.senderId !== currentUserId) {
          playbackApplyVersionRef.current += 1;
          applyPlaybackToActiveTab(event);
        }
      },
      (state) => setPresence(uniquePresence(state)),
      (event) => {
        const list = messageListRef.current;
        if (event?.kind === "message") {
          scrollToBottomRef.current = !list || list.scrollHeight - list.scrollTop - list.clientHeight < 96;
          if (event.senderId !== currentUserId && settingsRef.current.messageSound) playMessageSound();
        } else {
          scrollToBottomRef.current = false;
        }
        void loadMessages(activeRoomId).catch((loadError) => {
          console.warn("[Watchparty Chat] messages could not be refreshed", loadError);
        });
      },
      showReaction,
      handleTyping,
      (status) => {
        if (roomGeneration !== roomGenerationRef.current || activeRoomIdRef.current !== activeRoomId) return;
        const previous = connectionStatusRef.current;
        connectionStatusRef.current = status;
        setConnectionStatus(status);
        if (status === "connected") {
          const shouldReconcile = hasConnectedRoomRef.current && previous !== "connected";
          hasConnectedRoomRef.current = true;
          if (shouldReconcile) {
            void fetchPlaybackSnapshot(activeRoomId, true).catch((snapshotError) => {
              console.warn("[Watchparty Playback] reconnect snapshot could not be applied", snapshotError);
            });
          }
        }
      },
    ).catch((connectError) => {
      if (roomGeneration !== roomGenerationRef.current || activeRoomIdRef.current !== activeRoomId) return;
      const failedStatus = navigator.onLine ? "reconnecting" : "offline";
      connectionStatusRef.current = failedStatus;
      setConnectionStatus(failedStatus);
      console.warn("[Watchparty Live] room connection failed", connectError);
    });
    void chrome.tabs.query({ active: true, currentWindow: true }).then(async ([tab]) => {
      if (tab?.id === undefined) {
        await fetchPlaybackSnapshot(activeRoomId, false);
        return;
      }
      activeTabId.current = tab.id;
      mediaReadyRef.current = false;
      await Promise.all([
        chrome.runtime.sendMessage({ type: "WATCHPARTY_ENSURE_CONTENT", tabId: tab.id }),
        fetchPlaybackSnapshot(activeRoomId, true),
      ]);
    }).catch((roomStartError) => {
      console.warn("[Watchparty Room] media or snapshot initialization failed", roomStartError);
    });
    return () => {
      if (roomGenerationRef.current === roomGeneration) roomGenerationRef.current += 1;
      connectionStatusRef.current = "offline";
      hasConnectedRoomRef.current = false;
      setConnectionStatus("offline");
      void realtime.current.disconnect();
    };
  }, [activeRoomId, applyPlaybackToActiveTab, currentUserId, fetchPlaybackSnapshot, handleTyping, loadMembers, loadMessages, showReaction]);

  useEffect(() => {
    if (!currentUserId || !activeRoomId) return;
    const listener = (event: { type: string; [key: string]: unknown }) => {
      if (event.type === "WATCHPARTY_MEDIA_CANDIDATES") {
        if (typeof event.tabId === "number" && activeTabId.current !== undefined && event.tabId !== activeTabId.current) return;
        const candidates = Array.isArray(event.candidates)
          ? event.candidates.filter((candidate): candidate is MediaCandidate => {
            if (!candidate || typeof candidate !== "object") return false;
            const item = candidate as Partial<MediaCandidate>;
            return typeof item.frameId === "number"
              && typeof item.candidateId === "string"
              && typeof item.title === "string"
              && (item.kind === "video" || item.kind === "audio");
          })
          : [];
        const selection = event.selected && typeof event.selected === "object"
          ? event.selected as Partial<MediaSelection>
          : null;
        setMediaCandidates(candidates);
        setSelectedMedia(
          typeof selection?.frameId === "number" && typeof selection.candidateId === "string"
            ? { frameId: selection.frameId, candidateId: selection.candidateId }
            : null,
        );
      }
      if (event.type === "WATCHPARTY_VIDEO_STATUS") {
        if (typeof event.tabId === "number" && activeTabId.current !== undefined && event.tabId !== activeTabId.current) return;
        if (typeof event.tabId === "number") activeTabId.current = event.tabId;
        if (typeof event.frameId === "number") activeFrameId.current = event.frameId;
        const rawPageUrl = typeof event.pageUrl === "string" ? event.pageUrl : null;
        let fingerprint = typeof event.mediaFingerprint === "string" ? event.mediaFingerprint : null;
        const joinedMedia = joinedMediaRef.current;
        if (joinedMedia && typeof event.tabId === "number" && joinedMedia.tabId === event.tabId) {
          if (joinedMedia.pageUrl === null && rawPageUrl) joinedMedia.pageUrl = rawPageUrl;
          else if (rawPageUrl && joinedMedia.pageUrl !== rawPageUrl) joinedMediaRef.current = null;
          if (joinedMediaRef.current) fingerprint = joinedMedia.fingerprint;
        }
        const nextMedia: Media = {
          title: String(event.title ?? (event.videoDetected ? "Medya bulundu" : "Medya bekleniyor")),
          mediaTime: Number(event.mediaTime ?? 0),
          duration: Number(event.duration ?? 0),
          playbackRate: Number(event.playbackRate ?? 1),
          paused: Boolean(event.paused),
          detected: Boolean(event.videoDetected),
          fingerprint,
          pageUrl: rawPageUrl,
        };
        setMedia(nextMedia);
        mediaRef.current = nextMedia;
        mediaFingerprintRef.current = nextMedia.fingerprint;
        mediaReadyRef.current = nextMedia.detected;
        if (nextMedia.detected) bootstrapSnapshotRef.current(activeRoomId);
        void realtime.current.trackPresence({
          userId: currentUserId,
          displayName: currentDisplayNameRef.current,
          clientId,
          sessionId: playbackSnapshotRef.current?.session_id ?? null,
          videoDetected: nextMedia.detected,
          mediaFingerprint: nextMedia.fingerprint,
          mediaTitle: nextMedia.title,
          pageUrl: nextMedia.pageUrl,
          joinedAt: presenceJoinedAt,
        }).catch((presenceError) => {
          console.warn("[Watchparty Presence] media status could not be sent", presenceError);
        });
        const pendingPlayback = pendingRemotePlaybackRef.current;
        if (pendingPlayback && nextMedia.detected && activeTabId.current !== undefined) {
          const samePendingMedia = !pendingPlayback.event.mediaFingerprint || pendingPlayback.event.mediaFingerprint === nextMedia.fingerprint;
          if (samePendingMedia) {
            pendingRemotePlaybackRef.current = null;
            void applyPlaybackToActiveTab(pendingPlayback.event, pendingPlayback.receivedAt);
          }
        }
      }
      if (event.type === "WATCHPARTY_LOCAL_PLAYBACK" && activeTabId.current !== undefined) {
        if (typeof event.tabId === "number" && event.tabId !== activeTabId.current) return;
        if (typeof event.frameId === "number") activeFrameId.current = event.frameId;
        lastLocalPlaybackAtRef.current = Date.now();
        playbackApplyVersionRef.current += 1;
        logicalClock.current += 1;
        const playback: PlaybackEvent = {
          eventId: crypto.randomUUID(),
          senderId: currentUserId,
          clientId,
          logicalClock: logicalClock.current,
          sentAt: new Date().toISOString(),
          mediaFingerprint: mediaFingerprintRef.current,
          action: event.action as PlaybackEvent["action"],
          mediaTime: Number(event.mediaTime ?? 0),
          playbackRate: Number(event.playbackRate ?? 1),
          paused: Boolean(event.paused),
        };
        void realtime.current.sendPlayback(playback).catch((sendError) => {
          console.warn("[Watchparty Playback] event could not be sent", sendError);
        });
        void persistPlaybackSnapshot(activeRoomId, playback).catch((snapshotError) => {
          console.warn("[Watchparty Playback] snapshot could not be saved", snapshotError);
        });
      }
      if (event.type === "WATCHPARTY_MEDIA_ERROR") {
        if (typeof event.tabId === "number" && activeTabId.current !== undefined && event.tabId !== activeTabId.current) return;
        console.warn("[Watchparty Media]", String(event.message ?? "Bu sekmede medya algılanamadı."));
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [activeRoomId, applyPlaybackToActiveTab, currentUserId, persistPlaybackSnapshot]);

  useEffect(() => {
    const handleActivated = ({ tabId }: chrome.tabs.TabActiveInfo) => {
      mediaSelectionGenerationRef.current += 1;
      activeTabId.current = tabId;
      activeFrameId.current = undefined;
      mediaReadyRef.current = false;
      pendingRemotePlaybackRef.current = null;
      const waitingMedia = { ...EMPTY_MEDIA };
      setMedia(waitingMedia);
      mediaRef.current = waitingMedia;
      setMediaCandidates([]);
      setSelectedMedia(null);
      setMediaPickerOpen(false);
      setSelectingMediaId(null);
      const joinedMedia = joinedMediaRef.current;
      if (joinedMedia?.tabId === null) joinedMedia.tabId = tabId;
      if (joinedMedia?.tabId === tabId) mediaFingerprintRef.current = joinedMedia.fingerprint;
      else {
        joinedMediaRef.current = null;
        mediaFingerprintRef.current = null;
      }
      void chrome.runtime.sendMessage({ type: "WATCHPARTY_ENSURE_CONTENT", tabId })
        .then(() => activeRoomId ? fetchPlaybackSnapshot(activeRoomId, true) : undefined)
        .catch(() => undefined);
    };
    const handleUpdated = (tabId: number, changeInfo: chrome.tabs.TabChangeInfo) => {
      if (changeInfo.status !== "complete" || tabId !== activeTabId.current) return;
      mediaSelectionGenerationRef.current += 1;
      activeFrameId.current = undefined;
      mediaReadyRef.current = false;
      pendingRemotePlaybackRef.current = null;
      const waitingMedia = { ...EMPTY_MEDIA };
      setMedia(waitingMedia);
      mediaRef.current = waitingMedia;
      mediaFingerprintRef.current = null;
      setMediaCandidates([]);
      setSelectedMedia(null);
      setMediaPickerOpen(false);
      setSelectingMediaId(null);
      const joinedMedia = joinedMediaRef.current;
      if (joinedMedia?.tabId === tabId) joinedMedia.pageUrl = null;
      void chrome.runtime.sendMessage({ type: "WATCHPARTY_ENSURE_CONTENT", tabId })
        .then(() => activeRoomId ? fetchPlaybackSnapshot(activeRoomId, true) : undefined)
        .catch(() => undefined);
    };
    chrome.tabs.onActivated.addListener(handleActivated);
    chrome.tabs.onUpdated.addListener(handleUpdated);
    return () => {
      chrome.tabs.onActivated.removeListener(handleActivated);
      chrome.tabs.onUpdated.removeListener(handleUpdated);
    };
  }, [activeRoomId, fetchPlaybackSnapshot]);

  useLayoutEffect(() => {
    const list = messageListRef.current;
    if (!list) return;
    const pendingMessageId = pendingScrollMessageRef.current;
    const pendingElement = pendingMessageId ? messageElementsRef.current.get(pendingMessageId) : undefined;
    if (pendingMessageId && pendingElement) {
      pendingScrollMessageRef.current = null;
      pendingElement.scrollIntoView({ behavior: "smooth", block: "center" });
      highlightMessage(pendingMessageId);
    } else if (restoreScrollRef.current) {
      const previous = restoreScrollRef.current;
      restoreScrollRef.current = null;
      list.scrollTop = list.scrollHeight - previous.height + previous.top;
    } else if (scrollToBottomRef.current) {
      list.scrollTop = list.scrollHeight;
      scrollToBottomRef.current = false;
    }
  }, [messages]);

  useEffect(() => {
    if (!editingMessage) return;
    const latest = messages.find((message) => message.id === editingMessage.id);
    if (!latest || latest.deleted_at) {
      setEditingMessage(null);
      setMessageBody("");
    }
  }, [editingMessage, messages]);

  useEffect(() => {
    const query = searchQuery.trim();
    const sequence = ++searchSequenceRef.current;
    if (!searchOpen || !activeRoomId || query.length < 2) {
      setSearchResults([]);
      setSearchLoading(false);
      return;
    }
    setSearchLoading(true);
    const timer = window.setTimeout(() => {
      void supabase
        .from("messages")
        .select("id, sender_id, body, created_at")
        .eq("room_id", activeRoomId)
        .eq("type", "text")
        .is("deleted_at", null)
        .ilike("body", `%${escapeLikePattern(query)}%`)
        .order("created_at", { ascending: false })
        .limit(40)
        .then(({ data, error: searchError }) => {
          if (sequence !== searchSequenceRef.current) return;
          if (searchError) {
            console.warn("[Watchparty Chat] search failed", searchError);
            setSearchResults([]);
          } else {
            setSearchResults((data ?? []) as MessageSearchResult[]);
          }
          setSearchLoading(false);
        });
    }, 280);
    return () => window.clearTimeout(timer);
  }, [activeRoomId, searchOpen, searchQuery]);

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(null); setSubmitting(true);
    const { data, error: signInError } = await supabase.auth.signInWithPassword({ email, password });
    try {
      if (signInError || !data.session) throw signInError ?? new Error("Giriş yapılamadı.");
      await ensureProfile(data.session);
      setSession(data.session); setPassword("");
      await Promise.all([loadProfiles(), loadRooms(data.session.user.id)]);
    } catch (signInFailure) { setError(messageFromError(signInFailure)); }
    finally { setSubmitting(false); }
  }

  async function createRoom(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedUserId || !roomName.trim()) return;
    setSubmitting(true);
    try {
      const { data, error: createError } = await supabase.rpc("create_room", { p_name: roomName.trim(), p_member_id: selectedUserId });
      if (createError) throw createError;
      const roomId = (data as { room_id: string }[])[0]?.room_id;
      if (!roomId) throw new Error("Oda oluşturulamadı.");
      const { data: created, error: roomError } = await supabase.from("rooms").select("id, name, created_at").eq("id", roomId).single();
      if (roomError) throw roomError;
      await loadRooms(session!.user.id);
      setActiveRoom(created as Room); setRoomName(""); setSelectedUserId("");
    } catch (createFailure) { console.warn("[Watchparty Room] room could not be created", createFailure); }
    finally { setSubmitting(false); }
  }

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeRoom || !messageBody.trim() || !session) return;
    const body = messageBody.trim();
    if (editingMessage) {
      stopTyping();
      if (body === editingMessage.body?.trim()) {
        setEditingMessage(null);
        setMessageBody("");
        return;
      }
      const { data: updated, error: updateError } = await supabase
        .from("messages")
        .update({ body })
        .eq("id", editingMessage.id)
        .eq("sender_id", session.user.id)
        .is("deleted_at", null)
        .select("id")
        .maybeSingle();
      if (updateError || !updated) {
        console.warn("[Watchparty Chat] message could not be edited", updateError ?? "Message is unavailable.");
        return;
      }
      const editedId = editingMessage.id;
      setMessageBody("");
      setEditingMessage(null);
      scrollToBottomRef.current = false;
      await loadMessages(activeRoom.id);
      await notifyMessageChange(activeRoom.id, "edited", editedId);
      return;
    }

    const replyTo = replyingTo?.id ?? null;
    stopTyping();
    setMessageBody(""); setReplyingTo(null); scrollToBottomRef.current = true;
    const { error: insertError } = await supabase.from("messages").insert({ room_id: activeRoom.id, sender_id: session.user.id, type: "text", body, reply_to: replyTo });
    if (insertError) {
      console.warn("[Watchparty Chat] message could not be sent", insertError);
      setMessageBody(body);
      return;
    }
    await loadMessages(activeRoom.id);
    await notifyMessageChange(activeRoom.id, "message");
  }

  async function notifyMessageChange(roomId: string, kind: MessageChangeEvent["kind"], messageId?: string) {
    if (!session || activeRoomIdRef.current !== roomId) return;
    await realtime.current.notifyMessageChange({
      senderId: session.user.id,
      kind,
      changedAt: new Date().toISOString(),
      messageId,
    }).catch((notifyError) => {
      console.warn("[Watchparty Chat] refresh notification failed", notifyError);
    });
  }

  function sendTypingState(isTyping: boolean) {
    if (!session || !activeRoom) return;
    if (isTyping) lastTypingSentAtRef.current = Date.now();
    const event: TypingEvent = {
      senderId: session.user.id,
      displayName: currentDisplayName,
      isTyping,
      sentAt: new Date().toISOString(),
    };
    void realtime.current.sendTyping(event).catch((typingError) => {
      console.warn("[Watchparty Chat] typing notification failed", typingError);
    });
  }

  function stopTyping() {
    if (localTypingStopTimerRef.current !== undefined) {
      window.clearTimeout(localTypingStopTimerRef.current);
      localTypingStopTimerRef.current = undefined;
    }
    if (lastTypingSentAtRef.current > 0) sendTypingState(false);
    lastTypingSentAtRef.current = 0;
  }

  function updateMessageBody(value: string) {
    setMessageBody(value);
    if (!value.trim()) {
      stopTyping();
      return;
    }
    if (Date.now() - lastTypingSentAtRef.current >= 1000) sendTypingState(true);
    if (localTypingStopTimerRef.current !== undefined) window.clearTimeout(localTypingStopTimerRef.current);
    localTypingStopTimerRef.current = window.setTimeout(stopTyping, 1400);
  }

  function insertEmoji(emoji: ReactionEmoji) {
    const input = messageInputRef.current;
    const selectionStart = input?.selectionStart ?? messageBody.length;
    const selectionEnd = input?.selectionEnd ?? selectionStart;
    const nextValue = `${messageBody.slice(0, selectionStart)}${emoji}${messageBody.slice(selectionEnd)}`;
    if (nextValue.length > 4000) return;
    recordEmojiUsage(emoji);
    updateMessageBody(nextValue);
    window.requestAnimationFrame(() => {
      const nextCursor = selectionStart + emoji.length;
      input?.focus();
      input?.setSelectionRange(nextCursor, nextCursor);
    });
  }

  function cancelEmojiHold() {
    if (emojiHoldTimerRef.current !== undefined) window.clearTimeout(emojiHoldTimerRef.current);
    emojiHoldTimerRef.current = undefined;
    setHoldingEmoji(null);
  }

  function startEmojiHold(emoji: ReactionEmoji) {
    cancelEmojiHold();
    emojiHoldTriggeredRef.current = false;
    setHoldingEmoji(emoji);
    emojiHoldTimerRef.current = window.setTimeout(() => {
      emojiHoldTimerRef.current = undefined;
      emojiHoldTriggeredRef.current = true;
      setHoldingEmoji(null);
      void sendLiveReaction(emoji);
    }, 1000);
  }

  function finishEmojiHold(emoji: ReactionEmoji) {
    const wasLongPress = emojiHoldTriggeredRef.current;
    cancelEmojiHold();
    emojiHoldTriggeredRef.current = false;
    if (!wasLongPress) insertEmoji(emoji);
  }

  function recordEmojiUsage(emoji: ReactionEmoji) {
    if (!REACTION_EMOJIS.has(emoji)) return;
    const next = {
      ...emojiUsageRef.current,
      [emoji]: Math.min((emojiUsageRef.current[emoji] ?? 0) + 1, 999_999),
    };
    emojiUsageRef.current = next;
    void chrome.storage.local.set({ [EMOJI_USAGE_STORAGE_KEY]: next }).catch((storageError) => {
      console.warn("[Watchparty Emoji] usage history could not be saved", storageError);
    });
  }

  function toggleEmojiPicker() {
    const willOpen = !emojiPickerOpen;
    if (willOpen) setOrderedChatEmojis(sortChatEmojis(emojiUsageRef.current));
    emojiPickerOpenRef.current = willOpen;
    setEmojiPickerOpen(willOpen);
  }

  async function toggleLike(message: Message) {
    if (!session || !activeRoom) return;
    if (message.sender_id === session.user.id) return;
    const query = supabase.from("message_reactions");
    const { error: reactionError } = message.likedByMe
      ? await query.delete().eq("message_id", message.id).eq("user_id", session.user.id).eq("reaction", "like")
      : await query.insert({ message_id: message.id, user_id: session.user.id, reaction: "like" });
    if (reactionError) {
      console.warn("[Watchparty Chat] message reaction could not be updated", reactionError);
      return;
    }
    await loadMessages(activeRoom.id);
    await notifyMessageChange(activeRoom.id, "reaction");
  }

  function highlightMessage(messageId: string) {
    if (highlightTimerRef.current !== undefined) window.clearTimeout(highlightTimerRef.current);
    setHighlightedMessageId(messageId);
    highlightTimerRef.current = window.setTimeout(() => {
      setHighlightedMessageId((current) => current === messageId ? null : current);
      highlightTimerRef.current = undefined;
    }, 1600);
  }

  async function scrollToMessage(messageId: string) {
    const loaded = messageElementsRef.current.get(messageId);
    if (loaded) {
      loaded.scrollIntoView({ behavior: "smooth", block: "center" });
      highlightMessage(messageId);
      setSearchOpen(false);
      return;
    }
    if (!activeRoom) return;
    const { data: target, error: targetError } = await supabase
      .from("messages")
      .select("id, created_at")
      .eq("id", messageId)
      .eq("room_id", activeRoom.id)
      .maybeSingle();
    if (targetError || !target) {
      console.warn("[Watchparty Chat] reply target could not be found", targetError ?? messageId);
      return;
    }
    const { count, error: countError } = await supabase
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("room_id", activeRoom.id)
      .gt("created_at", target.created_at);
    if (countError) {
      console.warn("[Watchparty Chat] reply target position could not be calculated", countError);
      return;
    }
    messageLimitRef.current = Math.max(messageLimitRef.current, (count ?? 0) + MESSAGE_PAGE_SIZE);
    pendingScrollMessageRef.current = messageId;
    scrollToBottomRef.current = false;
    restoreScrollRef.current = null;
    setSearchOpen(false);
    try {
      await loadMessages(activeRoom.id);
      window.setTimeout(() => {
        if (pendingScrollMessageRef.current === messageId && !messageElementsRef.current.has(messageId)) {
          pendingScrollMessageRef.current = null;
          console.warn("[Watchparty Chat] reply target is outside the loaded message window", messageId);
        }
      }, 1000);
    } catch (loadError) {
      pendingScrollMessageRef.current = null;
      console.warn("[Watchparty Chat] reply target could not be loaded", loadError);
    }
  }

  async function copyMessage(message: Message) {
    if (!message.body || message.deleted_at) return;
    try {
      await navigator.clipboard.writeText(message.body);
    } catch (clipboardError) {
      console.warn("[Watchparty Chat] message could not be copied", clipboardError);
    }
  }

  function startEditingMessage(message: Message) {
    if (!session || message.sender_id !== session.user.id || message.deleted_at || !message.body) return;
    setReplyingTo(null);
    setEditingMessage(message);
    setMessageBody(message.body);
    window.requestAnimationFrame(() => {
      messageInputRef.current?.focus();
      messageInputRef.current?.setSelectionRange(message.body?.length ?? 0, message.body?.length ?? 0);
    });
  }

  function startReplyingTo(message: Message) {
    if (message.deleted_at) return;
    if (editingMessage) setMessageBody("");
    setEditingMessage(null);
    setReplyingTo(message);
    window.requestAnimationFrame(() => messageInputRef.current?.focus());
  }

  function cancelComposerContext() {
    setReplyingTo(null);
    setEditingMessage(null);
    setMessageBody("");
    stopTyping();
  }

  async function deleteMessage(message: Message) {
    if (!session || !activeRoom || message.sender_id !== session.user.id || message.deleted_at) return;
    if (!window.confirm("Bu mesajı silmek istediğine emin misin?")) return;
    const { data: deleted, error: deleteError } = await supabase
      .from("messages")
      .update({ deleted_at: new Date().toISOString(), body: "[silindi]" })
      .eq("id", message.id)
      .eq("sender_id", session.user.id)
      .is("deleted_at", null)
      .select("id")
      .maybeSingle();
    if (deleteError || !deleted) {
      console.warn("[Watchparty Chat] message could not be deleted", deleteError ?? "Message is unavailable.");
      return;
    }
    if (editingMessage?.id === message.id || replyingTo?.id === message.id) cancelComposerContext();
    scrollToBottomRef.current = false;
    await loadMessages(activeRoom.id);
    await notifyMessageChange(activeRoom.id, "deleted", message.id);
  }

  async function loadOlderMessages() {
    if (!activeRoom || loadingOlder || !hasOlderMessages) return;
    const list = messageListRef.current;
    if (list) restoreScrollRef.current = { height: list.scrollHeight, top: list.scrollTop };
    setLoadingOlder(true);
    messageLimitRef.current += MESSAGE_PAGE_SIZE;
    try { await loadMessages(activeRoom.id); }
    catch (loadError) { console.warn("[Watchparty Chat] older messages could not be loaded", loadError); }
    finally { setLoadingOlder(false); }
  }

  async function sendLiveReaction(emoji: ReactionEmoji) {
    if (!session || !activeRoom) return;
    recordEmojiUsage(emoji);
    const event: ReactionEvent = {
      eventId: crypto.randomUUID(),
      senderId: session.user.id,
      emoji,
      anchorX: 82,
      sentAt: new Date().toISOString(),
    };
    showReaction(event);
    await realtime.current.sendReaction(event).catch((reactionError) => {
      console.warn("[Watchparty Reaction] delivery failed", reactionError);
    });
  }

  async function signOut() {
    await realtime.current.disconnect();
    await supabase.auth.signOut();
    setSession(null); setActiveRoom(null); setRooms([]); setProfileMenuOpen(false);
  }

  function openProfileEditor() {
    setProfileMenuOpen(false);
    setProfileName(currentDisplayName);
    setProfileEmail(session?.user.email ?? "");
    setProfilePassword("");
    setAvatarFile(null);
    setAvatarPreview(currentProfile?.avatar_url ?? null);
    setProfileNotice(null);
    setProfileModalOpen(true);
  }

  function selectAvatar(file: File | undefined) {
    if (!file) return;
    if (!file.type.startsWith("image/")) { setProfileNotice("Lütfen bir görsel dosyası seç."); return; }
    if (file.size > MAX_AVATAR_SIZE) { setProfileNotice("Profil fotoğrafı en fazla 5 MB olabilir."); return; }
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    objectUrlRef.current = URL.createObjectURL(file);
    setAvatarFile(file);
    setAvatarPreview(objectUrlRef.current);
    setProfileNotice(null);
  }

  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session) return;
    if (!profileName.trim()) { setProfileNotice("İsim boş bırakılamaz."); return; }
    setProfileSaving(true); setProfileNotice(null);
    try {
      let avatarUrl = currentProfile?.avatar_url ?? null;
      if (avatarFile) {
        const avatarPath = `${session.user.id}/avatar`;
        const { error: uploadError } = await supabase.storage.from("avatars").upload(avatarPath, avatarFile, {
          upsert: true,
          contentType: avatarFile.type,
          cacheControl: "3600",
        });
        if (uploadError) throw uploadError;
        const { data } = supabase.storage.from("avatars").getPublicUrl(avatarPath);
        avatarUrl = `${data.publicUrl}?v=${Date.now()}`;
      }

      const authChanges: { email?: string; password?: string } = {};
      if (profileEmail.trim() && profileEmail.trim() !== session.user.email) authChanges.email = profileEmail.trim();
      if (profilePassword) authChanges.password = profilePassword;
      if (Object.keys(authChanges).length) {
        const { error: authError } = await supabase.auth.updateUser(authChanges);
        if (authError) throw authError;
      }

      const { error: profileError } = await supabase.from("profiles").update({ display_name: profileName.trim(), avatar_url: avatarUrl }).eq("id", session.user.id);
      if (profileError) throw profileError;
      await loadProfiles();
      if (activeRoom) {
        await loadMembers(activeRoom.id);
        await realtime.current.trackPresence({
          userId: session.user.id,
          displayName: profileName.trim(),
          clientId,
          sessionId: playbackSnapshotRef.current?.session_id ?? null,
          videoDetected: media.detected,
          mediaFingerprint: media.fingerprint,
          mediaTitle: media.title,
          pageUrl: media.pageUrl,
          joinedAt: presenceJoinedAt,
        }).catch((presenceError) => console.warn("[Watchparty Presence] profile refresh failed", presenceError));
      }
      setProfilePassword(""); setAvatarFile(null);
      setProfileNotice(authChanges.email ? "Profil kaydedildi. Yeni e-posta adresini doğrulaman gerekebilir." : "Profil kaydedildi.");
    } catch (saveError) {
      setProfileNotice(messageFromError(saveError));
    } finally {
      setProfileSaving(false);
    }
  }

  async function refreshProfiles() {
    try { await loadProfiles(); }
    catch (refreshError) { console.warn("[Watchparty Profiles] profiles could not be refreshed", refreshError); }
  }

  async function refreshRooms() {
    if (!session) return;
    try { await loadRooms(session.user.id); }
    catch (refreshError) { console.warn("[Watchparty Room] room list could not be refreshed", refreshError); }
  }

  async function refreshMedia() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id === undefined) throw new Error("Aktif sekme bulunamadı.");
      mediaSelectionGenerationRef.current += 1;
      activeTabId.current = tab.id;
      activeFrameId.current = undefined;
      mediaReadyRef.current = false;
      pendingRemotePlaybackRef.current = null;
      const waitingMedia = { ...EMPTY_MEDIA };
      setMedia(waitingMedia);
      mediaRef.current = waitingMedia;
      mediaFingerprintRef.current = null;
      setMediaCandidates([]);
      setSelectedMedia(null);
      setMediaPickerOpen(false);
      setSelectingMediaId(null);
      await chrome.runtime.sendMessage({ type: "WATCHPARTY_ENSURE_CONTENT", tabId: tab.id });
      if (activeRoom) await fetchPlaybackSnapshot(activeRoom.id, true);
    } catch (refreshError) { console.warn("[Watchparty Media] media could not be refreshed", refreshError); }
  }

  function showSyncStatus(message: string) {
    if (syncNoticeTimerRef.current !== undefined) window.clearTimeout(syncNoticeTimerRef.current);
    setSyncNotice(message);
    syncNoticeTimerRef.current = window.setTimeout(() => {
      setSyncNotice(null);
      syncNoticeTimerRef.current = undefined;
    }, 2400);
  }

  async function resyncPlayback() {
    if (!activeRoom || syncingPlayback) return;
    const roomId = activeRoom.id;
    const roomGeneration = roomGenerationRef.current;
    setSyncingPlayback(true);
    try {
      const { snapshot, result } = await fetchPlaybackSnapshot(roomId, true);
      if (activeRoomIdRef.current !== roomId || roomGenerationRef.current !== roomGeneration) return;
      if (!snapshot) showSyncStatus("Henüz kaydedilmiş oynatma durumu yok.");
      else if (result === "mismatch") showSyncStatus("Eşitlemek için arkadaşınla aynı medyayı aç.");
      else if (result === "queued") showSyncStatus("Medya bulununca otomatik eşitlenecek.");
      else if (result === "unavailable") showSyncStatus("Eşitlenecek aktif sekme bulunamadı.");
      else if (result === "stale") showSyncStatus("Yeni yerel oynatma hareketin korundu.");
      else showSyncStatus("Arkadaşınla eşitlendi.");
    } catch (syncError) {
      console.warn("[Watchparty Playback] manual re-sync failed", syncError);
    } finally {
      if (activeRoomIdRef.current === roomId && roomGenerationRef.current === roomGeneration) setSyncingPlayback(false);
    }
  }

  async function selectMediaCandidate(candidate: MediaCandidate) {
    if (activeTabId.current === undefined || selectingMediaId) return;
    const tabId = activeTabId.current;
    const roomId = activeRoom?.id;
    const generation = ++mediaSelectionGenerationRef.current;
    const selectionKey = `${candidate.frameId}:${candidate.candidateId}`;
    setSelectingMediaId(selectionKey);
    try {
      const response = await chrome.runtime.sendMessage({
        type: "WATCHPARTY_SELECT_MEDIA",
        tabId,
        frameId: candidate.frameId,
        candidateId: candidate.candidateId,
      }) as { selected?: boolean } | undefined;
      if (!response?.selected) throw new Error("Seçilen medya artık bulunamıyor.");
      if (
        generation !== mediaSelectionGenerationRef.current
        || activeTabId.current !== tabId
        || activeRoomIdRef.current !== roomId
      ) return;
      setSelectedMedia({ frameId: candidate.frameId, candidateId: candidate.candidateId });
      setMediaPickerOpen(false);
      if (roomId) await fetchPlaybackSnapshot(roomId, true);
    } catch (selectionError) {
      console.warn("[Watchparty Media] media could not be selected", selectionError);
    } finally {
      if (generation === mediaSelectionGenerationRef.current) setSelectingMediaId(null);
    }
  }

  function updateSettings(next: AppSettings) {
    settingsRef.current = next;
    setSettings(next);
    void chrome.storage.local.set({ [SETTINGS_STORAGE_KEY]: next }).catch((storageError) => {
      console.warn("[Watchparty Settings] settings could not be saved", storageError);
    });
  }

  function resetEmojiUsage() {
    emojiUsageRef.current = {};
    setOrderedChatEmojis([...CHAT_EMOJIS]);
    void chrome.storage.local.remove(EMOJI_USAGE_STORAGE_KEY).catch((storageError) => {
      console.warn("[Watchparty Emoji] usage history could not be reset", storageError);
    });
  }

  async function joinRemoteMedia(pageUrl: string, mediaFingerprint: string | null) {
    try {
      const url = new URL(pageUrl);
      if (!url.protocol.startsWith("http")) throw new Error("Bu medya bağlantısı açılamıyor.");
      setMedia({ title: "Medya açılıyor…", mediaTime: 0, duration: 0, playbackRate: 1, paused: true, detected: false, fingerprint: null, pageUrl });
      joinedMediaRef.current = mediaFingerprint ? { tabId: null, fingerprint: mediaFingerprint, pageUrl: null } : null;
      mediaFingerprintRef.current = mediaFingerprint;
      mediaReadyRef.current = false;
      const tab = await chrome.tabs.create({ url: url.href, active: true });
      if (tab.id === undefined) throw new Error("Yeni medya sekmesi açılamadı.");
      activeTabId.current = tab.id;
      if (joinedMediaRef.current) joinedMediaRef.current.tabId = tab.id;
    } catch (joinError) { console.warn("[Watchparty Media] remote media could not be opened", joinError); }
  }

  function renderHeader(title: string, showBack = false) {
    const onlineRoomMembers = showBack
      ? members.filter((member) => member.id !== currentUserId && presence.some((item) => item.userId === member.id))
      : [];
    const connectionLabel = connectionStatus === "connected"
      ? "Bağlı"
      : connectionStatus === "reconnecting"
        ? "Yeniden bağlanıyor"
        : "Çevrimdışı";
    return (
      <header className={`topbar glass-panel${showBack ? " topbar-room" : ""}`}>
        <div className="topbar-leading">
          {showBack
            ? <button className="ghost-icon-button" type="button" onClick={() => setActiveRoom(null)} aria-label="Odalara dön"><ArrowLeftIcon size={21} /></button>
            : <span className="brand-mark">S</span>}
          <div className="brand-copy">
            <strong>{title}</strong>
            {showBack && <span className={`connection-indicator ${connectionStatus}`} role="status" aria-live="polite" aria-label={`Bağlantı: ${connectionLabel}`} title={connectionLabel} />}
          </div>
        </div>
        <div className="topbar-actions">
          {onlineRoomMembers.length > 0 && <div className="online-members" aria-label="Çevrimiçi üyeler">
            {onlineRoomMembers.map((member) => <Avatar key={member.id} name={`${member.display_name} · Çevrimiçi`} url={member.avatar_url} size="small" status="online" />)}
          </div>}
          <div className="profile-menu" ref={profileMenuRef}>
            <button className="profile-trigger" type="button" onClick={() => setProfileMenuOpen((open) => !open)} aria-label="Profil menüsü" aria-expanded={profileMenuOpen}>
              <Avatar name={currentDisplayName} url={currentProfile?.avatar_url} size="small" status={showBack ? "online" : undefined} />
              <ChevronDownIcon size={14} />
            </button>
            {profileMenuOpen && <div className="profile-dropdown glass-panel">
              <div className="dropdown-identity"><strong>{currentDisplayName}</strong><span>{session?.user.email}</span></div>
              <button type="button" onClick={openProfileEditor}><PencilIcon />Profili düzenle</button>
              <button type="button" onClick={() => { setProfileMenuOpen(false); setSettingsOpen(true); }}><SettingsIcon />Ayarlar</button>
              <button type="button" className="danger-menu-item" onClick={() => void signOut()}><LogOutIcon />Çıkış yap</button>
            </div>}
          </div>
        </div>
      </header>
    );
  }

  function renderProfileModal() {
    if (!profileModalOpen) return null;
    return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setProfileModalOpen(false); }}>
      <section className="profile-modal glass-panel" role="dialog" aria-modal="true" aria-labelledby="profile-title">
        <div className="modal-head"><div><span className="section-kicker">Hesap</span><h2 id="profile-title">Profili düzenle</h2></div><button autoFocus className="ghost-icon-button" type="button" onClick={() => setProfileModalOpen(false)} aria-label="Kapat"><CloseIcon /></button></div>
        <form className="profile-form" onSubmit={(event) => void saveProfile(event)}>
          <label className="avatar-editor">
            <Avatar name={profileName || currentDisplayName} url={avatarPreview} size="large" />
            <span><CameraIcon size={16} />Fotoğraf seç</span>
            <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(event) => selectAvatar(event.target.files?.[0])} />
          </label>
          <label>İsim<input value={profileName} onChange={(event) => setProfileName(event.target.value)} maxLength={80} required /></label>
          <label>E-posta<input type="email" value={profileEmail} onChange={(event) => setProfileEmail(event.target.value)} autoComplete="email" required /></label>
          <label>Yeni şifre<span className="field-hint">Değiştirmek istemiyorsan boş bırak.</span><input type="password" value={profilePassword} onChange={(event) => setProfilePassword(event.target.value)} autoComplete="new-password" minLength={6} placeholder="En az 6 karakter" /></label>
          {profileNotice && <p className="profile-notice">{profileNotice}</p>}
          <button className="primary-button" disabled={profileSaving}>{profileSaving ? "Kaydediliyor…" : "Değişiklikleri kaydet"}</button>
        </form>
      </section>
    </div>;
  }

  function renderSettingsModal() {
    if (!settingsOpen) return null;
    return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSettingsOpen(false); }}>
      <section className="profile-modal settings-modal glass-panel" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <div className="modal-head"><div><span className="section-kicker">Tercihler</span><h2 id="settings-title">Ayarlar</h2></div><button autoFocus className="ghost-icon-button" type="button" onClick={() => setSettingsOpen(false)} aria-label="Kapat"><CloseIcon /></button></div>
        <div className="settings-list">
          <label className="settings-row">
            <span><strong>Mesaj sesi</strong><small>Yeni mesaj geldiğinde kısa bir ses çal.</small></span>
            <input type="checkbox" checked={settings.messageSound} onChange={(event) => updateSettings({ ...settings, messageSound: event.target.checked })} />
          </label>
          <label className="settings-field">
            <span><strong>Animasyon yoğunluğu</strong><small>Canlı emoji parçacıklarının miktarını belirler.</small></span>
            <select value={settings.animationIntensity} onChange={(event) => updateSettings({ ...settings, animationIntensity: event.target.value as AnimationIntensity })}>
              <option value="low">Az</option>
              <option value="normal">Normal</option>
              <option value="high">Yüksek</option>
            </select>
          </label>
          <button className="settings-reset" type="button" onClick={resetEmojiUsage}>Emoji kullanım sırasını sıfırla</button>
        </div>
      </section>
    </div>;
  }

  if (loading) return <main className="auth-shell"><div className="loading-mark">S</div><p className="muted">Oturum kontrol ediliyor…</p></main>;
  if (!session) return <main className="auth-shell"><section className="auth-card glass-panel"><div className="auth-brand"><span className="brand-mark large">S</span><div><span>Samet</span><strong>Watchparty</strong></div></div><div><span className="section-kicker">Tekrar hoş geldin</span><h1>Birlikte izlemeye devam et</h1><p className="muted">Önceden oluşturulmuş hesabınla giriş yap.</p></div><form className="auth-form" onSubmit={(event) => void signIn(event)}><label>E-posta<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" required /></label><label>Şifre<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required /></label>{error && <p className="form-error">{error}</p>}<button className="primary-button" disabled={submitting}>{submitting ? "Giriş yapılıyor…" : "Giriş yap"}</button></form></section></main>;

  const otherProfiles = profiles.filter((profile) => profile.id !== session.user.id);
  const onlineIds = new Set(presence.map((item) => item.userId));

  if (!activeRoom) return <main className="shell">
    {renderHeader("Watchparty")}
    <section className="welcome-panel"><span className="section-kicker">Oturumlar</span><h1>Odaların</h1><p>Arkadaşını seç, odanı aç ve oynatmayı eşitle.</p></section>
    <section className="card glass-panel"><div className="section-head"><div><span className="section-kicker">Yeni</span><h2>Oda oluştur</h2></div><button className="ghost-icon-button" type="button" onClick={() => void refreshProfiles()} aria-label="Kullanıcıları yenile"><RefreshIcon /></button></div><form className="auth-form" onSubmit={(event) => void createRoom(event)}><label>Oda adı<input value={roomName} onChange={(event) => setRoomName(event.target.value)} placeholder="Film gecesi" required /></label><label>Arkadaş<select value={selectedUserId} onChange={(event) => setSelectedUserId(event.target.value)} required><option value="">Bir kullanıcı seç</option>{otherProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.display_name}</option>)}</select></label><button className="primary-button" disabled={submitting || !otherProfiles.length}>{submitting ? "Oluşturuluyor…" : "Oda oluştur"}</button></form>{!otherProfiles.length && <p className="muted">Arkadaşın bir kez giriş yaptığında burada görünür.</p>}</section>
    <section className="card glass-panel"><div className="section-head"><div><span className="section-kicker">Kayıtlı</span><h2>Mevcut odalar</h2></div><div className="section-actions"><span className="pill">{rooms.length}</span><button className="ghost-icon-button" type="button" onClick={() => void refreshRooms()} aria-label="Odaları yenile"><RefreshIcon /></button></div></div><div className="room-list">{rooms.map((room) => <button className="room-button" key={room.id} onClick={() => setActiveRoom(room)}><span className="room-monogram">{room.name[0]?.toLocaleUpperCase("tr-TR")}</span><span className="room-copy"><strong>{room.name}</strong><small>{new Date(room.created_at).toLocaleDateString("tr-TR")}</small></span><ChevronDownIcon className="room-arrow" size={17} /></button>)}{!rooms.length && <p className="empty-state">Henüz bir odan yok.</p>}</div></section>
    {renderProfileModal()}
    {renderSettingsModal()}
  </main>;

  const progress = media.duration ? Math.min(100, (media.mediaTime / media.duration) * 100) : 0;
  const remoteWatcher = presence.find((item) => item.userId !== session.user.id && item.videoDetected && Boolean(item.pageUrl));
  const chatPartner = members.find((member) => member.id !== session.user.id);
  const chatPartnerOnline = Boolean(chatPartner && onlineIds.has(chatPartner.id));
  const mediaTitle = remoteWatcher?.mediaTitle || media.title;
  const mediaPageUrl = remoteWatcher?.pageUrl ?? null;

  return <main className="shell room-shell">
    {renderHeader(activeRoom.name, true)}

    <section className="media-card glass-panel">
      <div className="section-head">
        <div><span className="section-kicker">Şu an izleniyor</span><span className={`media-state${media.detected ? " active" : ""}`}>{media.detected ? (media.paused ? "Duraklatıldı" : "Oynatılıyor") : "Medya bekleniyor"}</span></div>
        <div className="media-actions">
          <button className="sync-button" type="button" onClick={() => void resyncPlayback()} disabled={syncingPlayback} title="Arkadaşımla eşitle"><RefreshIcon size={13} /><span>{syncingPlayback ? "Eşitleniyor" : "Eşitle"}</span></button>
          <div className="media-picker-anchor" ref={mediaPickerRef}>
            <button className="ghost-icon-button" type="button" onClick={() => setMediaPickerOpen((open) => !open)} aria-label="Medya seç" aria-expanded={mediaPickerOpen} title="Medya seç"><FilmIcon size={16} /></button>
            {mediaPickerOpen && <section className="media-picker glass-panel" aria-label="Bulunan medyalar">
              <div className="media-picker-head"><strong>Bu sekmedeki medyalar</strong><span>{mediaCandidates.length} medya bulundu</span></div>
              <div className="media-candidate-list">
                {mediaCandidates.map((candidate) => {
                  const key = `${candidate.frameId}:${candidate.candidateId}`;
                  const selected = selectedMedia?.frameId === candidate.frameId && selectedMedia.candidateId === candidate.candidateId;
                  return <button type="button" className={selected ? "selected" : ""} key={key} aria-pressed={selected} onClick={() => void selectMediaCandidate(candidate)} disabled={Boolean(selectingMediaId)}>
                    <span className="media-candidate-icon"><FilmIcon size={15} /></span>
                    <span className="media-candidate-copy">
                      <strong>{candidate.title || (candidate.kind === "video" ? "İsimsiz video" : "İsimsiz ses")}</strong>
                      <small>{candidate.kind === "video" ? `${candidate.width || "?"}×${candidate.height || "?"}` : "Ses"} · {formatTime(candidate.duration)} · {candidate.playing ? "Oynuyor" : "Duraklatıldı"}</small>
                    </span>
                    {selected && <CheckIcon size={16} />}
                  </button>;
                })}
                {!mediaCandidates.length && <p className="media-picker-empty">Bu sekmede video veya ses bulunamadı.</p>}
              </div>
            </section>}
          </div>
          <button className="ghost-icon-button" type="button" onClick={() => void refreshMedia()} aria-label="Medyayı yenile" title="Medyayı yenile"><RefreshIcon /></button>
        </div>
      </div>
      {mediaPageUrl
        ? <button className="media-title-button" type="button" onClick={() => void joinRemoteMedia(mediaPageUrl, remoteWatcher?.mediaFingerprint ?? null)}><span>{mediaTitle}</span><small>{remoteWatcher?.displayName} izliyor · Açmak için tıkla</small></button>
        : <div className="media-title-static"><h3>{mediaTitle}</h3><small>{media.detected ? "Bu sekmedeki medya" : "Video bulunan bir sekme aç"}</small></div>}
      {syncNotice && <div className="sync-notice" role="status">{syncNotice}</div>}
      <div className="progress"><div className="progress-bar" style={{ width: `${progress}%` }} /></div>
      <div className="media-timeline"><span>{formatTime(media.mediaTime)}</span><span>{formatTime(media.duration)}</span></div>
    </section>

    <section className="chat-card glass-panel">
      <div className="chat-head">
        <div className="chat-person">
          <Avatar name={chatPartner?.display_name ?? "Sohbet"} url={chatPartner?.avatar_url} size="small" status={chatPartnerOnline ? "online" : "offline"} />
          <div>
            <h2>{chatPartner?.display_name ?? "Sohbet"}</h2>
            <span>{chatPartnerOnline ? "Çevrimiçi" : "Çevrimdışı"}</span>
          </div>
        </div>
        <button className="chat-search-toggle" type="button" onClick={() => { setSearchOpen((open) => !open); setSearchQuery(""); setSearchResults([]); }} aria-label="Sohbette ara" aria-expanded={searchOpen}><SearchIcon size={17} /></button>
      </div>
      {searchOpen && <section className="chat-search-panel glass-panel" aria-label="Sohbette ara">
        <div className="chat-search-input">
          <SearchIcon size={16} />
          <input aria-label="Mesajlarda ara" autoFocus value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="Mesajlarda ara…" maxLength={120} />
          <button type="button" onClick={() => setSearchOpen(false)} aria-label="Aramayı kapat"><CloseIcon size={15} /></button>
        </div>
        <div className="chat-search-results">
          {searchLoading && <p>Aranıyor…</p>}
          {!searchLoading && searchQuery.trim().length < 2 && <p>Aramak için en az 2 karakter yaz.</p>}
          {!searchLoading && searchQuery.trim().length >= 2 && !searchResults.length && <p>Sonuç bulunamadı.</p>}
          {!searchLoading && searchResults.map((result) => {
            const author = profiles.find((profile) => profile.id === result.sender_id)?.display_name ?? "Bilinmeyen";
            return <button type="button" key={result.id} onClick={() => void scrollToMessage(result.id)}>
              <span><strong>{result.sender_id === session.user.id ? "Sen" : author}</strong><small>{formatClock(result.created_at)}</small></span>
              <p>{result.body}</p>
            </button>;
          })}
        </div>
      </section>}
      <div className="message-list" ref={messageListRef} onScroll={(event) => { if (event.currentTarget.scrollTop < 36) void loadOlderMessages(); }}>
        {hasOlderMessages && <button className="load-older" type="button" onClick={() => void loadOlderMessages()} disabled={loadingOlder}>{loadingOlder ? "Yükleniyor…" : "Önceki mesajları yükle"}</button>}
        {messages.map((message, index) => {
          const own = message.sender_id === session.user.id;
          const showDate = index === 0 || calendarDayKey(messages[index - 1].created_at) !== calendarDayKey(message.created_at);
          return <Fragment key={message.id}>
            {showDate && <div className="date-divider"><span>{formatDateDivider(message.created_at)}</span></div>}
            <article
              ref={(element) => {
                if (element) messageElementsRef.current.set(message.id, element);
                else messageElementsRef.current.delete(message.id);
              }}
              data-message-id={message.id}
              className={`message-row${own ? " own" : ""}${message.deleted_at ? " deleted" : ""}${highlightedMessageId === message.id ? " highlighted" : ""}`}
            >
              {!own && <Avatar name={message.author} url={message.authorAvatar} size="small" />}
              <div className="message-content">
                <div className="message-bubble">
                  <div className="message-top"><strong>{own ? "Sen" : message.author}</strong><span>{message.edited_at && !message.deleted_at ? "düzenlendi · " : ""}{formatClock(message.created_at)}</span></div>
                  {message.reply && <button type="button" className="reply-quote" onClick={() => void scrollToMessage(message.reply!.id)}><strong>{message.reply.author}</strong><span>{message.reply.body ?? "Silinmiş mesaj"}</span></button>}
                  <p>{message.deleted_at ? "Bu mesaj silindi." : message.body}</p>
                </div>
                {!message.deleted_at && <div className="message-actions">
                  {!own && <button type="button" className={message.likeCount > 0 ? "liked" : ""} onClick={() => void toggleLike(message)} aria-label={message.likedByMe ? "Beğeniyi kaldır" : "Mesajı beğen"}><HeartIcon size={14} /></button>}
                  <button type="button" onClick={() => void copyMessage(message)} aria-label="Mesajı kopyala" title="Kopyala"><CopyIcon size={14} /></button>
                  <button type="button" onClick={() => startReplyingTo(message)} aria-label="Mesajı yanıtla" title="Yanıtla"><ReplyIcon size={14} /></button>
                  {own && <button type="button" onClick={() => startEditingMessage(message)} aria-label="Mesajı düzenle" title="Düzenle"><PencilIcon size={13} /></button>}
                  {own && <button type="button" className="delete-message-action" onClick={() => void deleteMessage(message)} aria-label="Mesajı sil" title="Sil"><TrashIcon size={13} /></button>}
                </div>}
              </div>
            </article>
          </Fragment>;
        })}
        {!messages.length && <div className="empty-chat"><UserIcon size={22} /><p>İlk mesajı sen gönder.</p></div>}
      </div>
      {replyingTo && <div className="replying-bar"><ReplyIcon size={16} /><div><strong>{replyingTo.author}</strong><span>{replyingTo.body}</span></div><button type="button" onClick={cancelComposerContext} aria-label="Yanıtı iptal et"><CloseIcon size={16} /></button></div>}
      {editingMessage && <div className="replying-bar editing-bar"><PencilIcon size={15} /><div><strong>Mesaj düzenleniyor</strong><span>{editingMessage.body}</span></div><button type="button" onClick={cancelComposerContext} aria-label="Düzenlemeyi iptal et"><CloseIcon size={16} /></button></div>}
      <div className={`typing-indicator${Object.keys(typingUsers).length ? " visible" : ""}`} aria-live="polite">
        {Object.keys(typingUsers).length > 0 && <>
          <span className="typing-dots" aria-hidden="true"><i /><i /><i /></span>
          <span>{Object.values(typingUsers).join(", ")} yazıyor</span>
        </>}
      </div>
      <form className="composer" onSubmit={(event) => void sendMessage(event)}>
        <div className="emoji-composer" ref={emojiPickerRef}>
          <button className="emoji-toggle" type="button" onClick={toggleEmojiPicker} aria-label="Emojileri aç" aria-expanded={emojiPickerOpen}><SmileIcon size={20} /></button>
          {emojiPickerOpen && <section className="emoji-picker glass-panel" aria-label="Emoji seçici">
            <div className="emoji-picker-head"><strong>Emojiler</strong><span>Dokun: mesaja ekle · 1 sn basılı tut: canlandır</span></div>
            <div className="emoji-grid">
              {orderedChatEmojis.map((emoji) => <button
                className={`emoji-option${holdingEmoji === emoji ? " holding" : ""}`}
                key={emoji}
                type="button"
                onPointerDown={(event) => { if (event.button === 0) { event.preventDefault(); startEmojiHold(emoji); } }}
                onPointerUp={(event) => { if (event.button === 0) { event.preventDefault(); finishEmojiHold(emoji); } }}
                onPointerCancel={cancelEmojiHold}
                onPointerLeave={cancelEmojiHold}
                onContextMenu={(event) => event.preventDefault()}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    insertEmoji(emoji);
                  }
                }}
                aria-label={`${emoji} emojisi`}
              >{emoji}</button>)}
            </div>
          </section>}
        </div>
        <label className="sr-only" htmlFor="message">Mesaj yaz</label>
        <input ref={messageInputRef} id="message" value={messageBody} onChange={(event) => updateMessageBody(event.target.value)} onBlur={stopTyping} placeholder={editingMessage ? "Mesajı düzenle…" : replyingTo ? "Yanıtını yaz…" : "Mesaj yaz…"} maxLength={4000} />
        <button className="send-button" type="submit" aria-label={editingMessage ? "Değişikliği kaydet" : "Gönder"} disabled={!messageBody.trim()}>{editingMessage ? <CheckIcon /> : <SendIcon />}</button>
      </form>
    </section>
    <div className="reaction-layer" aria-hidden="true">
      {reactionBursts.flatMap((burst) => burst.particles.map((particle, index) => <span
        className="reaction-bubble"
        key={`${burst.burstId}:${index}`}
        style={{
          left: `calc(${burst.anchorX}% + ${particle.x}px)`,
          fontSize: `${particle.size}px`,
          animationDelay: `${particle.delay}ms`,
          animationDuration: `${particle.duration}ms`,
          "--reaction-drift": `${particle.drift}px`,
          "--reaction-rotation": `${particle.rotation}deg`,
        } as CSSProperties}
      >{burst.emoji}</span>))}
    </div>
    <div className="reaction-dock glass-panel" role="group" aria-label="Canlı tepkiler">
      {REACTIONS.map((reaction) => <button key={reaction.emoji} type="button" onClick={() => void sendLiveReaction(reaction.emoji)} aria-label={reaction.label} title={reaction.label}>{reaction.emoji}</button>)}
    </div>
    {renderProfileModal()}
    {renderSettingsModal()}
  </main>;
}
