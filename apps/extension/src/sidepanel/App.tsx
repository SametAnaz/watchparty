import { FormEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { Session } from "@supabase/supabase-js";
import type { RoomPresence } from "@samet-watchparty/shared-types";
import { RoomRealtime } from "../shared/room-realtime";
import { supabase } from "../shared/supabase";
import type { PlaybackEvent, ReactionEmoji, ReactionEvent } from "../shared/protocol";
import {
  ArrowLeftIcon,
  Avatar,
  CameraIcon,
  ChevronDownIcon,
  CloseIcon,
  HeartIcon,
  LogOutIcon,
  PencilIcon,
  RefreshIcon,
  ReplyIcon,
  SendIcon,
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
  deleted_at: string | null;
  author: string;
  authorAvatar: string | null;
  reply: ReplyPreview | null;
  likeCount: number;
  likedByMe: boolean;
};
type MessageRow = Pick<Message, "id" | "sender_id" | "body" | "reply_to" | "created_at" | "deleted_at">;
type Media = { title: string; mediaTime: number; duration: number; paused: boolean; detected: boolean; fingerprint: string | null; pageUrl: string | null };
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
const REACTION_EMOJIS = new Set<ReactionEmoji>(REACTIONS.map((reaction) => reaction.emoji));

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
  const [membersOpen, setMembersOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [hasOlderMessages, setHasOlderMessages] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [presence, setPresence] = useState<RoomPresence[]>([]);
  const [roomName, setRoomName] = useState("");
  const [selectedUserId, setSelectedUserId] = useState("");
  const [messageBody, setMessageBody] = useState("");
  const [replyingTo, setReplyingTo] = useState<Message | null>(null);
  const [media, setMedia] = useState<Media>({ title: "Video bekleniyor", mediaTime: 0, duration: 0, paused: true, detected: false, fingerprint: null, pageUrl: null });
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [profileModalOpen, setProfileModalOpen] = useState(false);
  const [profileName, setProfileName] = useState("");
  const [profileEmail, setProfileEmail] = useState("");
  const [profilePassword, setProfilePassword] = useState("");
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileNotice, setProfileNotice] = useState<string | null>(null);
  const [reactionBursts, setReactionBursts] = useState<ReactionBurst[]>([]);

  const realtime = useRef(new RoomRealtime());
  const logicalClock = useRef(0);
  const activeTabId = useRef<number | undefined>(undefined);
  const activeFrameId = useRef<number | undefined>(undefined);
  const mediaFingerprintRef = useRef<string | null>(null);
  const mediaReadyRef = useRef(false);
  const pendingRemotePlaybackRef = useRef<PlaybackEvent | null>(null);
  const joinedMediaRef = useRef<{ tabId: number | null; fingerprint: string; pageUrl: string | null } | null>(null);
  const messageLimitRef = useRef(MESSAGE_PAGE_SIZE);
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const scrollToBottomRef = useRef(true);
  const restoreScrollRef = useRef<{ height: number; top: number } | null>(null);
  const profileMenuRef = useRef<HTMLDivElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const reactionTimersRef = useRef<number[]>([]);

  const activeRoomId = activeRoom?.id;
  const currentUserId = session?.user.id;
  const currentProfile = profiles.find((item) => item.id === currentUserId);
  const currentDisplayName = currentProfile?.display_name ?? displayNameFromEmail(session?.user.email);
  const currentDisplayNameRef = useRef(currentDisplayName);
  currentDisplayNameRef.current = currentDisplayName;

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
    const { data: memberRows, error: memberError } = await supabase.from("room_members").select("user_id").eq("room_id", roomId);
    if (memberError) throw memberError;
    const ids = (memberRows ?? []).map((member) => member.user_id as string);
    if (!ids.length) { setMembers([]); return; }
    const { data, error: profileError } = await supabase.from("profiles").select("id, display_name, avatar_url").in("id", ids);
    if (profileError) throw profileError;
    setMembers((data ?? []) as Profile[]);
  }, []);

  const loadMessages = useCallback(async (roomId: string) => {
    const limit = messageLimitRef.current;
    const { data, error: queryError } = await supabase
      .from("messages")
      .select("id, sender_id, body, reply_to, created_at, deleted_at")
      .eq("room_id", roomId)
      .order("created_at", { ascending: false })
      .limit(limit + 1);
    if (queryError) throw queryError;

    const descendingRows = (data ?? []) as MessageRow[];
    setHasOlderMessages(descendingRows.length > limit);
    const rows = descendingRows.slice(0, limit).reverse();
    const replyIds = [...new Set(rows.map((message) => message.reply_to).filter((id): id is string => Boolean(id)))];
    const { data: replyRows, error: replyError } = replyIds.length
      ? await supabase.from("messages").select("id, sender_id, body").in("id", replyIds)
      : { data: [] as { id: string; sender_id: string; body: string | null }[], error: null };
    if (replyError) throw replyError;

    const typedReplies = (replyRows ?? []) as { id: string; sender_id: string; body: string | null }[];
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

    setMessages(rows.map((message) => {
      const author = authorById.get(message.sender_id);
      const reply = message.reply_to ? replyById.get(message.reply_to) : undefined;
      const replyAuthor = reply ? authorById.get(reply.sender_id) : undefined;
      const likes = likesByMessage.get(message.id) ?? [];
      return {
        ...message,
        author: author?.display_name ?? "Bilinmeyen",
        authorAvatar: author?.avatar_url ?? null,
        reply: reply ? { id: reply.id, body: reply.body, author: replyAuthor?.display_name ?? "Bilinmeyen" } : null,
        likeCount: likes.length,
        likedByMe: currentUserId ? likes.includes(currentUserId) : false,
      };
    }));
  }, [currentUserId]);

  const showReaction = useCallback((event: ReactionEvent) => {
    if (!REACTION_EMOJIS.has(event.emoji)) return;
    const anchorX = 50;
    const burstId = `${event.eventId}:${crypto.randomUUID()}`;
    const particles = Array.from({ length: 6 }, (_, index): ReactionParticle => ({
      x: (Math.random() - 0.5) * 34,
      drift: (Math.random() - 0.5) * 86,
      delay: index * 45 + Math.random() * 90,
      duration: 1450 + Math.random() * 650,
      size: 20 + Math.random() * 13,
      rotation: (Math.random() - 0.5) * 48,
    }));
    setReactionBursts((bursts) => [...bursts.slice(-11), { ...event, anchorX, burstId, particles }]);
    const timer = window.setTimeout(() => {
      setReactionBursts((bursts) => bursts.filter((burst) => burst.burstId !== burstId));
      reactionTimersRef.current = reactionTimersRef.current.filter((item) => item !== timer);
    }, 2600);
    reactionTimersRef.current.push(timer);
  }, []);

  useEffect(() => {
    let mounted = true;
    void supabase.auth.getSession().then(async ({ data, error: sessionError }) => {
      if (!mounted) return;
      if (sessionError) setError(sessionError.message);
      setSession(data.session);
      setLoading(false);
      if (data.session) {
        try {
          await ensureProfile(data.session);
          await Promise.all([loadProfiles(), loadRooms(data.session.user.id)]);
        } catch (initError) {
          console.error("Watchparty initialization failed", initError);
          if (mounted) setError(messageFromError(initError));
        }
      }
    });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => { if (mounted) setSession(nextSession); });
    return () => { mounted = false; listener.subscription.unsubscribe(); };
  }, [loadProfiles, loadRooms]);

  useEffect(() => {
    const closeMenu = (event: PointerEvent) => {
      if (profileMenuRef.current && !profileMenuRef.current.contains(event.target as Node)) setProfileMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeMenu);
    return () => document.removeEventListener("pointerdown", closeMenu);
  }, []);

  useEffect(() => () => {
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    for (const timer of reactionTimersRef.current) window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!currentUserId || !activeRoomId) return;
    messageLimitRef.current = MESSAGE_PAGE_SIZE;
    scrollToBottomRef.current = true;
    setReplyingTo(null);
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
    void Promise.all([loadMembers(activeRoomId), loadMessages(activeRoomId)]).catch((loadError) => setError(messageFromError(loadError)));
    void realtime.current.connect(
      activeRoomId,
      initialPresence,
      (event) => {
        logicalClock.current = Math.max(logicalClock.current, event.logicalClock) + 1;
        const sameMedia = !event.mediaFingerprint || event.mediaFingerprint === mediaFingerprintRef.current;
        if (event.senderId !== currentUserId && sameMedia && activeTabId.current !== undefined) {
          if (!mediaReadyRef.current) {
            pendingRemotePlaybackRef.current = event;
          } else {
            void chrome.runtime.sendMessage({ type: "WATCHPARTY_APPLY_REMOTE_PLAYBACK", tabId: activeTabId.current, frameId: activeFrameId.current, ...event });
          }
        } else if (event.senderId !== currentUserId && !sameMedia) {
          console.debug("[Watchparty Playback] ignored: media mismatch", { remote: event.mediaFingerprint, local: mediaFingerprintRef.current });
        }
      },
      (state) => setPresence(uniquePresence(state)),
      () => {
        const list = messageListRef.current;
        scrollToBottomRef.current = !list || list.scrollHeight - list.scrollTop - list.clientHeight < 96;
        void loadMessages(activeRoomId).catch((loadError) => setError(messageFromError(loadError)));
      },
      showReaction,
    ).catch((connectError) => setError(messageFromError(connectError)));
    void chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      if (tab?.id === undefined) return;
      activeTabId.current = tab.id;
      mediaReadyRef.current = false;
      return chrome.runtime.sendMessage({ type: "WATCHPARTY_ENSURE_CONTENT", tabId: tab.id });
    });
    return () => { void realtime.current.disconnect(); };
  }, [activeRoomId, currentUserId, loadMembers, loadMessages, showReaction]);

  useEffect(() => {
    if (!currentUserId || !activeRoomId) return;
    const listener = (event: { type: string; [key: string]: unknown }) => {
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
          paused: Boolean(event.paused),
          detected: Boolean(event.videoDetected),
          fingerprint,
          pageUrl: rawPageUrl,
        };
        setMedia(nextMedia);
        mediaFingerprintRef.current = nextMedia.fingerprint;
        mediaReadyRef.current = nextMedia.detected;
        void realtime.current.trackPresence({
          userId: currentUserId,
          displayName: currentDisplayNameRef.current,
          clientId,
          sessionId: null,
          videoDetected: nextMedia.detected,
          mediaFingerprint: nextMedia.fingerprint,
          mediaTitle: nextMedia.title,
          pageUrl: nextMedia.pageUrl,
          joinedAt: presenceJoinedAt,
        }).catch((presenceError) => setError(messageFromError(presenceError)));
        const pendingPlayback = pendingRemotePlaybackRef.current;
        if (pendingPlayback && nextMedia.detected && activeTabId.current !== undefined) {
          const samePendingMedia = !pendingPlayback.mediaFingerprint || pendingPlayback.mediaFingerprint === nextMedia.fingerprint;
          if (samePendingMedia) {
            pendingRemotePlaybackRef.current = null;
            void chrome.runtime.sendMessage({ type: "WATCHPARTY_APPLY_REMOTE_PLAYBACK", tabId: activeTabId.current, frameId: activeFrameId.current, ...pendingPlayback });
          }
        }
      }
      if (event.type === "WATCHPARTY_LOCAL_PLAYBACK" && activeTabId.current !== undefined) {
        if (typeof event.tabId === "number" && event.tabId !== activeTabId.current) return;
        if (typeof event.frameId === "number") activeFrameId.current = event.frameId;
        logicalClock.current += 1;
        const playback: PlaybackEvent = {
          eventId: crypto.randomUUID(),
          senderId: currentUserId,
          clientId,
          logicalClock: logicalClock.current,
          mediaFingerprint: mediaFingerprintRef.current,
          action: event.action as PlaybackEvent["action"],
          mediaTime: Number(event.mediaTime ?? 0),
          playbackRate: Number(event.playbackRate ?? 1),
          paused: Boolean(event.paused),
        };
        void realtime.current.sendPlayback(playback).catch((sendError) => setError(messageFromError(sendError)));
      }
      if (event.type === "WATCHPARTY_MEDIA_ERROR") setError(String(event.message ?? "Bu sekmede medya algılanamadı."));
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [activeRoomId, currentUserId]);

  useEffect(() => {
    const handleActivated = ({ tabId }: chrome.tabs.TabActiveInfo) => {
      activeTabId.current = tabId;
      activeFrameId.current = undefined;
      mediaReadyRef.current = false;
      pendingRemotePlaybackRef.current = null;
      const joinedMedia = joinedMediaRef.current;
      if (joinedMedia?.tabId === null) joinedMedia.tabId = tabId;
      if (joinedMedia?.tabId === tabId) mediaFingerprintRef.current = joinedMedia.fingerprint;
      else {
        joinedMediaRef.current = null;
        mediaFingerprintRef.current = null;
      }
      void chrome.runtime.sendMessage({ type: "WATCHPARTY_ENSURE_CONTENT", tabId }).catch(() => undefined);
    };
    chrome.tabs.onActivated.addListener(handleActivated);
    return () => chrome.tabs.onActivated.removeListener(handleActivated);
  }, []);

  useLayoutEffect(() => {
    const list = messageListRef.current;
    if (!list) return;
    if (restoreScrollRef.current) {
      const previous = restoreScrollRef.current;
      restoreScrollRef.current = null;
      list.scrollTop = list.scrollHeight - previous.height + previous.top;
    } else if (scrollToBottomRef.current) {
      list.scrollTop = list.scrollHeight;
      scrollToBottomRef.current = false;
    }
  }, [messages]);

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
    setSubmitting(true); setError(null);
    try {
      const { data, error: createError } = await supabase.rpc("create_room", { p_name: roomName.trim(), p_member_id: selectedUserId });
      if (createError) throw createError;
      const roomId = (data as { room_id: string }[])[0]?.room_id;
      if (!roomId) throw new Error("Oda oluşturulamadı.");
      const { data: created, error: roomError } = await supabase.from("rooms").select("id, name, created_at").eq("id", roomId).single();
      if (roomError) throw roomError;
      await loadRooms(session!.user.id);
      setActiveRoom(created as Room); setRoomName(""); setSelectedUserId("");
    } catch (createFailure) { setError(messageFromError(createFailure)); }
    finally { setSubmitting(false); }
  }

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeRoom || !messageBody.trim() || !session) return;
    const body = messageBody.trim();
    const replyTo = replyingTo?.id ?? null;
    setMessageBody(""); setReplyingTo(null); scrollToBottomRef.current = true;
    const { error: insertError } = await supabase.from("messages").insert({ room_id: activeRoom.id, sender_id: session.user.id, type: "text", body, reply_to: replyTo });
    if (insertError) { setError(messageFromError(insertError)); setMessageBody(body); return; }
    await loadMessages(activeRoom.id);
    await notifyMessageChange();
  }

  async function notifyMessageChange() {
    await realtime.current.notifyMessageChange().catch((notifyError) => {
      console.warn("[Watchparty Chat] refresh notification failed", notifyError);
    });
  }

  async function toggleLike(message: Message) {
    if (!session || !activeRoom) return;
    if (message.sender_id === session.user.id) return;
    setError(null);
    const query = supabase.from("message_reactions");
    const { error: reactionError } = message.likedByMe
      ? await query.delete().eq("message_id", message.id).eq("user_id", session.user.id).eq("reaction", "like")
      : await query.insert({ message_id: message.id, user_id: session.user.id, reaction: "like" });
    if (reactionError) { setError(messageFromError(reactionError)); return; }
    await loadMessages(activeRoom.id);
    await notifyMessageChange();
  }

  async function loadOlderMessages() {
    if (!activeRoom || loadingOlder || !hasOlderMessages) return;
    const list = messageListRef.current;
    if (list) restoreScrollRef.current = { height: list.scrollHeight, top: list.scrollTop };
    setLoadingOlder(true);
    messageLimitRef.current += MESSAGE_PAGE_SIZE;
    try { await loadMessages(activeRoom.id); }
    catch (loadError) { setError(messageFromError(loadError)); }
    finally { setLoadingOlder(false); }
  }

  async function sendLiveReaction(emoji: ReactionEmoji) {
    if (!session || !activeRoom) return;
    const event: ReactionEvent = {
      eventId: crypto.randomUUID(),
      senderId: session.user.id,
      emoji,
      anchorX: 50,
      sentAt: new Date().toISOString(),
    };
    showReaction(event);
    await realtime.current.sendReaction(event).catch((reactionError) => {
      console.warn("[Watchparty Reaction] delivery failed", reactionError);
      setError(messageFromError(reactionError));
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
          sessionId: null,
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
    try { setError(null); await loadProfiles(); }
    catch (refreshError) { setError(messageFromError(refreshError)); }
  }

  async function refreshRooms() {
    if (!session) return;
    try { setError(null); await loadRooms(session.user.id); }
    catch (refreshError) { setError(messageFromError(refreshError)); }
  }

  async function refreshMedia() {
    try {
      setError(null);
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id === undefined) throw new Error("Aktif sekme bulunamadı.");
      activeTabId.current = tab.id;
      mediaReadyRef.current = false;
      await chrome.runtime.sendMessage({ type: "WATCHPARTY_ENSURE_CONTENT", tabId: tab.id });
    } catch (refreshError) { setError(messageFromError(refreshError)); }
  }

  async function joinRemoteMedia(pageUrl: string, mediaFingerprint: string | null) {
    try {
      const url = new URL(pageUrl);
      if (!url.protocol.startsWith("http")) throw new Error("Bu medya bağlantısı açılamıyor.");
      setMedia({ title: "Medya açılıyor…", mediaTime: 0, duration: 0, paused: true, detected: false, fingerprint: null, pageUrl });
      joinedMediaRef.current = mediaFingerprint ? { tabId: null, fingerprint: mediaFingerprint, pageUrl: null } : null;
      mediaFingerprintRef.current = mediaFingerprint;
      mediaReadyRef.current = false;
      const tab = await chrome.tabs.create({ url: url.href, active: true });
      if (tab.id === undefined) throw new Error("Yeni medya sekmesi açılamadı.");
      activeTabId.current = tab.id;
      if (joinedMediaRef.current) joinedMediaRef.current.tabId = tab.id;
    } catch (joinError) { setError(messageFromError(joinError)); }
  }

  function renderHeader(title: string, showBack = false) {
    return (
      <header className="topbar glass-panel">
        <div className="topbar-leading">
          {showBack
            ? <button className="ghost-icon-button" type="button" onClick={() => setActiveRoom(null)} aria-label="Odalara dön"><ArrowLeftIcon size={21} /></button>
            : <span className="brand-mark">S</span>}
          <div className="brand-copy"><span>Samet</span><strong>{title}</strong></div>
        </div>
        <div className="profile-menu" ref={profileMenuRef}>
          <button className="profile-trigger" type="button" onClick={() => setProfileMenuOpen((open) => !open)} aria-label="Profil menüsü" aria-expanded={profileMenuOpen}>
            <Avatar name={currentDisplayName} url={currentProfile?.avatar_url} size="small" />
            <ChevronDownIcon size={14} />
          </button>
          {profileMenuOpen && <div className="profile-dropdown glass-panel">
            <div className="dropdown-identity"><strong>{currentDisplayName}</strong><span>{session?.user.email}</span></div>
            <button type="button" onClick={openProfileEditor}><PencilIcon />Profili düzenle</button>
            <button type="button" className="danger-menu-item" onClick={() => void signOut()}><LogOutIcon />Çıkış yap</button>
          </div>}
        </div>
      </header>
    );
  }

  function renderProfileModal() {
    if (!profileModalOpen) return null;
    return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setProfileModalOpen(false); }}>
      <section className="profile-modal glass-panel" role="dialog" aria-modal="true" aria-labelledby="profile-title">
        <div className="modal-head"><div><span className="section-kicker">Hesap</span><h2 id="profile-title">Profili düzenle</h2></div><button className="ghost-icon-button" type="button" onClick={() => setProfileModalOpen(false)} aria-label="Kapat"><CloseIcon /></button></div>
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

  if (loading) return <main className="auth-shell"><div className="loading-mark">S</div><p className="muted">Oturum kontrol ediliyor…</p></main>;
  if (!session) return <main className="auth-shell"><section className="auth-card glass-panel"><div className="auth-brand"><span className="brand-mark large">S</span><div><span>Samet</span><strong>Watchparty</strong></div></div><div><span className="section-kicker">Tekrar hoş geldin</span><h1>Birlikte izlemeye devam et</h1><p className="muted">Önceden oluşturulmuş hesabınla giriş yap.</p></div><form className="auth-form" onSubmit={(event) => void signIn(event)}><label>E-posta<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" required /></label><label>Şifre<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required /></label>{error && <p className="form-error">{error}</p>}<button className="primary-button" disabled={submitting}>{submitting ? "Giriş yapılıyor…" : "Giriş yap"}</button></form></section></main>;

  const otherProfiles = profiles.filter((profile) => profile.id !== session.user.id);
  const onlineIds = new Set(presence.map((item) => item.userId));

  if (!activeRoom) return <main className="shell">
    {renderHeader("Watchparty")}
    <section className="welcome-panel"><span className="section-kicker">Oturumlar</span><h1>Odaların</h1><p>Arkadaşını seç, odanı aç ve oynatmayı eşitle.</p></section>
    <section className="card glass-panel"><div className="section-head"><div><span className="section-kicker">Yeni</span><h2>Oda oluştur</h2></div><button className="ghost-icon-button" type="button" onClick={() => void refreshProfiles()} aria-label="Kullanıcıları yenile"><RefreshIcon /></button></div><form className="auth-form" onSubmit={(event) => void createRoom(event)}><label>Oda adı<input value={roomName} onChange={(event) => setRoomName(event.target.value)} placeholder="Film gecesi" required /></label><label>Arkadaş<select value={selectedUserId} onChange={(event) => setSelectedUserId(event.target.value)} required><option value="">Bir kullanıcı seç</option>{otherProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.display_name}</option>)}</select></label><button className="primary-button" disabled={submitting || !otherProfiles.length}>{submitting ? "Oluşturuluyor…" : "Oda oluştur"}</button></form>{!otherProfiles.length && <p className="muted">Arkadaşın bir kez giriş yaptığında burada görünür.</p>}</section>
    <section className="card glass-panel"><div className="section-head"><div><span className="section-kicker">Kayıtlı</span><h2>Mevcut odalar</h2></div><div className="section-actions"><span className="pill">{rooms.length}</span><button className="ghost-icon-button" type="button" onClick={() => void refreshRooms()} aria-label="Odaları yenile"><RefreshIcon /></button></div></div><div className="room-list">{rooms.map((room) => <button className="room-button" key={room.id} onClick={() => setActiveRoom(room)}><span className="room-monogram">{room.name[0]?.toLocaleUpperCase("tr-TR")}</span><span className="room-copy"><strong>{room.name}</strong><small>{new Date(room.created_at).toLocaleDateString("tr-TR")}</small></span><ChevronDownIcon className="room-arrow" size={17} /></button>)}{!rooms.length && <p className="empty-state">Henüz bir odan yok.</p>}</div></section>
    {error && <p className="form-error">{error}</p>}
    {renderProfileModal()}
  </main>;

  const progress = media.duration ? Math.min(100, (media.mediaTime / media.duration) * 100) : 0;
  const remoteWatcher = presence.find((item) => item.userId !== session.user.id && item.videoDetected && Boolean(item.pageUrl));
  const mediaTitle = remoteWatcher?.mediaTitle || media.title;
  const mediaPageUrl = remoteWatcher?.pageUrl ?? null;

  return <main className="shell room-shell">
    {renderHeader(activeRoom.name, true)}

    <section className={`members-card glass-panel${membersOpen ? " open" : ""}`}>
      <button className="members-summary" type="button" onClick={() => setMembersOpen((open) => !open)} aria-expanded={membersOpen}>
        <div><span className="section-kicker">Üyeler</span><div className="avatar-stack">{members.map((member) => <Avatar key={member.id} name={member.display_name} url={member.avatar_url} size="small" status={onlineIds.has(member.id) ? "online" : "offline"} />)}</div></div>
        <div className="members-meta"><span>{presence.length} çevrimiçi</span><ChevronDownIcon /></div>
      </button>
      {membersOpen && <div className="member-list">{members.map((member) => <article key={member.id} className="member-row"><Avatar name={member.display_name} url={member.avatar_url} size="small" status={onlineIds.has(member.id) ? "online" : "offline"} /><div><strong>{member.display_name}</strong><p>{onlineIds.has(member.id) ? "Çevrimiçi" : "Çevrimdışı"}</p></div></article>)}</div>}
    </section>

    <section className="media-card glass-panel">
      <div className="section-head"><div><span className="section-kicker">Şu an izleniyor</span><span className={`media-state${media.detected ? " active" : ""}`}>{media.detected ? (media.paused ? "Duraklatıldı" : "Oynatılıyor") : "Medya bekleniyor"}</span></div><button className="ghost-icon-button" type="button" onClick={() => void refreshMedia()} aria-label="Medyayı yenile"><RefreshIcon /></button></div>
      {mediaPageUrl
        ? <button className="media-title-button" type="button" onClick={() => void joinRemoteMedia(mediaPageUrl, remoteWatcher?.mediaFingerprint ?? null)}><span>{mediaTitle}</span><small>{remoteWatcher?.displayName} izliyor · Açmak için tıkla</small></button>
        : <div className="media-title-static"><h3>{mediaTitle}</h3><small>{media.detected ? "Bu sekmedeki medya" : "Video bulunan bir sekme aç"}</small></div>}
      <div className="progress"><div className="progress-bar" style={{ width: `${progress}%` }} /></div>
      <div className="media-timeline"><span>{formatTime(media.mediaTime)}</span><span>{formatTime(media.duration)}</span></div>
    </section>

    <section className="chat-card glass-panel">
      <div className="chat-head"><div><span className="section-kicker">Oda sohbeti</span><h2>Mesajlar</h2></div><span className="pill">{messages.length} yüklendi</span></div>
      <div className="message-list" ref={messageListRef} onScroll={(event) => { if (event.currentTarget.scrollTop < 36) void loadOlderMessages(); }}>
        {hasOlderMessages && <button className="load-older" type="button" onClick={() => void loadOlderMessages()} disabled={loadingOlder}>{loadingOlder ? "Yükleniyor…" : "Önceki mesajları yükle"}</button>}
        {messages.map((message) => {
          const own = message.sender_id === session.user.id;
          return <article key={message.id} className={`message-row${own ? " own" : ""}`}>
            {!own && <Avatar name={message.author} url={message.authorAvatar} size="small" />}
            <div className="message-content">
              <div className="message-bubble">
                <div className="message-top"><strong>{own ? "Sen" : message.author}</strong><span>{formatClock(message.created_at)}</span></div>
                {message.reply && <div className="reply-quote"><strong>{message.reply.author}</strong><span>{message.reply.body ?? "Silinmiş mesaj"}</span></div>}
                <p>{message.deleted_at ? "Bu mesaj silindi." : message.body}</p>
              </div>
              {!message.deleted_at && <div className="message-actions">
                <button type="button" className={message.likeCount > 0 ? "liked" : ""} onClick={() => void toggleLike(message)} disabled={own} aria-label={own ? "Kendi mesajını beğenemezsin" : message.likedByMe ? "Beğeniyi kaldır" : "Mesajı beğen"} title={own ? "Kendi mesajını beğenemezsin" : undefined}><HeartIcon size={14} />{message.likeCount > 0 && <span>{message.likeCount}</span>}</button>
                <button type="button" onClick={() => { setReplyingTo(message); document.getElementById("message")?.focus(); }} aria-label="Mesajı yanıtla"><ReplyIcon size={14} /></button>
              </div>}
            </div>
          </article>;
        })}
        {!messages.length && <div className="empty-chat"><UserIcon size={22} /><p>İlk mesajı sen gönder.</p></div>}
      </div>
      {replyingTo && <div className="replying-bar"><ReplyIcon size={16} /><div><strong>{replyingTo.author}</strong><span>{replyingTo.body}</span></div><button type="button" onClick={() => setReplyingTo(null)} aria-label="Yanıtı iptal et"><CloseIcon size={16} /></button></div>}
      <form className="composer" onSubmit={(event) => void sendMessage(event)}><label className="sr-only" htmlFor="message">Mesaj yaz</label><input id="message" value={messageBody} onChange={(event) => setMessageBody(event.target.value)} placeholder={replyingTo ? "Yanıtını yaz…" : "Mesaj yaz…"} maxLength={4000} /><button type="submit" aria-label="Gönder" disabled={!messageBody.trim()}><SendIcon /></button></form>
    </section>
    {error && <p className="form-error">{error}</p>}
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
  </main>;
}
