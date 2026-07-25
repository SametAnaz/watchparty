import type { RealtimeChannel } from "@supabase/supabase-js";
import type { RoomPresence } from "@samet-watchparty/shared-types";
import type { MessageChangeEvent, PlaybackEvent, ReactionEvent, TypingEvent } from "./protocol";
import { supabase } from "./supabase";

export const roomTopic = (roomId: string) => `room:${roomId}`;
const liveTopic = (roomId: string) => `live:${roomId}`;
const HEARTBEAT_MS = 5_000;
const OFFLINE_AFTER_MS = 15_000;
const PLAYBACK_ACTIONS = new Set<PlaybackEvent["action"]>(["PLAY", "PAUSE", "SEEK", "RATE_CHANGE"]);

type SeenPresence = { presence: RoomPresence; seenAt: number };
export type ConnectionStatus = "connected" | "reconnecting" | "offline";

function nonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizePlaybackEvent(value: unknown): PlaybackEvent | null {
  if (!value || typeof value !== "object") return null;
  const event = value as Record<string, unknown>;
  const eventId = nonEmptyString(event.eventId);
  const senderId = nonEmptyString(event.senderId);
  const clientId = nonEmptyString(event.clientId);
  const logicalClock = event.logicalClock;
  const action = event.action;
  const mediaTime = event.mediaTime;
  const playbackRate = event.playbackRate;
  const sentAt = event.sentAt === undefined
    ? Date.now()
    : typeof event.sentAt === "string"
      ? Date.parse(event.sentAt)
      : Number.NaN;

  if (
    !eventId
    || !senderId
    || !clientId
    || !Number.isSafeInteger(logicalClock)
    || (logicalClock as number) < 0
    || typeof action !== "string"
    || !PLAYBACK_ACTIONS.has(action as PlaybackEvent["action"])
    || typeof mediaTime !== "number"
    || !Number.isFinite(mediaTime)
    || mediaTime < 0
    || typeof playbackRate !== "number"
    || !Number.isFinite(playbackRate)
    || playbackRate < 0.25
    || playbackRate > 4
    || typeof event.paused !== "boolean"
    || !Number.isFinite(sentAt)
    || (event.mediaFingerprint !== null && typeof event.mediaFingerprint !== "string")
  ) return null;

  return {
    eventId,
    senderId,
    clientId,
    logicalClock: logicalClock as number,
    sentAt: new Date(sentAt).toISOString(),
    mediaFingerprint: event.mediaFingerprint || null,
    action: action as PlaybackEvent["action"],
    mediaTime,
    playbackRate,
    paused: event.paused,
  };
}

export class RoomRealtime {
  private channel: RealtimeChannel | undefined;
  private latestPresence: RoomPresence | undefined;
  private presenceByUser = new Map<string, SeenPresence>();
  private heartbeatTimer: number | undefined;
  private reconnectTimer: number | undefined;
  private reconnectCurrent: (() => Promise<void>) | undefined;
  private version = 0;

  async connect(
    roomId: string,
    presence: RoomPresence,
    onPlayback: (event: PlaybackEvent) => void,
    onPresence: (state: Record<string, RoomPresence[]>) => void,
    onMessageChange: (event: MessageChangeEvent) => void,
    onReaction: (event: ReactionEvent) => void,
    onTyping: (event: TypingEvent) => void,
    onConnectionStatus: (status: ConnectionStatus) => void,
  ) {
    const version = ++this.version;
    const fallbackPresence = this.latestPresence ?? presence;
    this.reconnectCurrent = () => this.connect(
      roomId,
      this.latestPresence ?? fallbackPresence,
      onPlayback,
      onPresence,
      onMessageChange,
      onReaction,
      onTyping,
      onConnectionStatus,
    );
    onConnectionStatus(navigator.onLine ? "reconnecting" : "offline");
    await this.removeCurrentChannel();
    if (version !== this.version) return;

    this.latestPresence = presence;
    this.rememberPresence(presence, onPresence);

    const channel = supabase.channel(liveTopic(roomId), { config: { private: true } });
    const isCurrentChannel = () => this.channel === channel && version === this.version;
    channel
      .on("broadcast", { event: "playback" }, ({ payload }) => {
        if (!isCurrentChannel()) return;
        const event = normalizePlaybackEvent(payload);
        if (!event) {
          console.warn("[Watchparty Playback] ignored invalid event");
          return;
        }
        console.debug("[Watchparty Playback] received", event);
        onPlayback(event);
      })
      .on("broadcast", { event: "presence" }, ({ payload }) => {
        if (!isCurrentChannel()) return;
        this.rememberPresence(payload as RoomPresence, onPresence);
      })
      .on("broadcast", { event: "reaction" }, ({ payload }) => {
        if (!isCurrentChannel()) return;
        onReaction(payload as ReactionEvent);
      })
      .on("broadcast", { event: "message_changed" }, ({ payload }) => {
        if (!isCurrentChannel()) return;
        onMessageChange(payload as MessageChangeEvent);
      })
      .on("broadcast", { event: "typing" }, ({ payload }) => {
        if (!isCurrentChannel()) return;
        onTyping(payload as TypingEvent);
      });

    this.channel = channel;
    await new Promise<void>((resolve, reject) => {
      channel.subscribe((status, error) => {
        if (!isCurrentChannel()) return;
        console.info(`[Watchparty Live] ${liveTopic(roomId)}: ${status}`, error ?? "");
        if (status === "SUBSCRIBED") {
          onConnectionStatus("connected");
          resolve();
        }
        else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          onConnectionStatus(navigator.onLine ? "reconnecting" : "offline");
        } else if (status === "CLOSED") {
          onConnectionStatus("offline");
          const retryPresence = this.latestPresence ?? presence;
          if (this.reconnectTimer === undefined) {
            this.reconnectTimer = window.setTimeout(() => {
              this.reconnectTimer = undefined;
              if (version !== this.version) return;
              void this.connect(
                roomId,
                retryPresence,
                onPlayback,
                onPresence,
                onMessageChange,
                onReaction,
                onTyping,
                onConnectionStatus,
              ).catch((reconnectError) => {
                console.warn("[Watchparty Live] reconnect failed", reconnectError);
              });
            }, 1_500);
          }
          reject(error ?? new Error(`Live connection failed: ${status}`));
        }
      });
    });

    if (!isCurrentChannel()) return;
    await this.sendPresence().catch((error) => {
      console.warn("[Watchparty Presence] initial heartbeat failed", error);
    });
    this.heartbeatTimer = window.setInterval(() => {
      void this.sendPresence()
        .catch((error) => {
          console.warn("[Watchparty Presence] heartbeat failed", error);
        });
      this.prunePresence(onPresence);
    }, HEARTBEAT_MS);
  }

  async sendPlayback(event: PlaybackEvent) {
    const normalized = normalizePlaybackEvent(event);
    if (!normalized) throw new Error("Playback event is invalid.");
    console.debug("[Watchparty Playback] sending via HTTP", normalized);
    await this.httpSend("playback", normalized);
  }

  async trackPresence(presence: RoomPresence) {
    this.latestPresence = presence;
    await this.sendPresence();
  }

  async notifyMessageChange(event: MessageChangeEvent) {
    await this.httpSend("message_changed", event);
  }

  async sendReaction(event: ReactionEvent) {
    await this.httpSend("reaction", event);
  }

  async sendTyping(event: TypingEvent) {
    await this.httpSend("typing", event);
  }

  async disconnect() {
    this.version += 1;
    this.reconnectCurrent = undefined;
    await this.removeCurrentChannel();
  }

  async reconnect() {
    const reconnect = this.reconnectCurrent;
    if (reconnect) await reconnect();
  }

  private async httpSend(event: string, payload: unknown) {
    const channel = this.channel;
    if (!channel) throw new Error("Live channel is not initialized.");
    const result = await channel.httpSend(event, payload, { timeout: 10_000 });
    if (!result.success) throw new Error(`${event} could not be delivered: ${result.error}`);
    if (event === "playback") console.debug("[Watchparty Playback] delivered via HTTP");
  }

  private async sendPresence() {
    if (!this.latestPresence || !this.channel) return;
    await this.httpSend("presence", this.latestPresence);
  }

  private rememberPresence(presence: RoomPresence, callback: (state: Record<string, RoomPresence[]>) => void) {
    if (!presence?.userId) return;
    this.presenceByUser.set(presence.userId, { presence, seenAt: Date.now() });
    callback(this.presenceState());
  }

  private prunePresence(callback: (state: Record<string, RoomPresence[]>) => void) {
    const cutoff = Date.now() - OFFLINE_AFTER_MS;
    let changed = false;
    for (const [userId, item] of this.presenceByUser) {
      if (item.seenAt < cutoff) { this.presenceByUser.delete(userId); changed = true; }
    }
    if (changed) callback(this.presenceState());
  }

  private presenceState() {
    return Object.fromEntries([...this.presenceByUser].map(([userId, item]) => [userId, [item.presence]]));
  }

  private async removeCurrentChannel() {
    if (this.heartbeatTimer !== undefined) window.clearInterval(this.heartbeatTimer);
    if (this.reconnectTimer !== undefined) window.clearTimeout(this.reconnectTimer);
    this.heartbeatTimer = undefined;
    this.reconnectTimer = undefined;
    this.latestPresence = undefined;
    this.presenceByUser.clear();
    const channel = this.channel;
    this.channel = undefined;
    if (channel) await supabase.removeChannel(channel);
  }
}
