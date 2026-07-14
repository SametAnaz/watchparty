import type { RealtimeChannel } from "@supabase/supabase-js";
import type { RoomPresence } from "@samet-watchparty/shared-types";
import type { PlaybackEvent, ReactionEvent } from "./protocol";
import { supabase } from "./supabase";

export const roomTopic = (roomId: string) => `room:${roomId}`;
const liveTopic = (roomId: string) => `live:${roomId}`;
const HEARTBEAT_MS = 5_000;
const OFFLINE_AFTER_MS = 15_000;

type SeenPresence = { presence: RoomPresence; seenAt: number };

export class RoomRealtime {
  private channel: RealtimeChannel | undefined;
  private latestPresence: RoomPresence | undefined;
  private presenceByUser = new Map<string, SeenPresence>();
  private heartbeatTimer: number | undefined;
  private version = 0;

  async connect(
    roomId: string,
    presence: RoomPresence,
    onPlayback: (event: PlaybackEvent) => void,
    onPresence: (state: Record<string, RoomPresence[]>) => void,
    onMessageChange: () => void,
    onReaction: (event: ReactionEvent) => void,
  ) {
    const version = ++this.version;
    await this.removeCurrentChannel();
    if (version !== this.version) return;

    this.latestPresence = presence;
    this.rememberPresence(presence, onPresence);

    const channel = supabase
      .channel(liveTopic(roomId), { config: { private: false } })
      .on("broadcast", { event: "playback" }, ({ payload }) => {
        console.debug("[Watchparty Playback] received", payload);
        onPlayback(payload as PlaybackEvent);
      })
      .on("broadcast", { event: "presence" }, ({ payload }) => {
        this.rememberPresence(payload as RoomPresence, onPresence);
      })
      .on("broadcast", { event: "reaction" }, ({ payload }) => {
        onReaction(payload as ReactionEvent);
      })
      .on("broadcast", { event: "message_changed" }, onMessageChange);

    this.channel = channel;
    await new Promise<void>((resolve, reject) => {
      channel.subscribe((status, error) => {
        if (this.channel !== channel || version !== this.version) return;
        console.info(`[Watchparty Live] ${liveTopic(roomId)}: ${status}`, error ?? "");
        if (status === "SUBSCRIBED") resolve();
        else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          reject(error ?? new Error(`Live connection failed: ${status}`));
        }
      });
    });

    if (version !== this.version) return;
    await this.sendPresence().catch((error) => {
      console.warn("[Watchparty Presence] initial heartbeat failed", error);
    });
    this.heartbeatTimer = window.setInterval(() => {
      void this.sendPresence().catch((error) => {
        console.warn("[Watchparty Presence] heartbeat failed", error);
      });
      this.prunePresence(onPresence);
    }, HEARTBEAT_MS);
  }

  async sendPlayback(event: PlaybackEvent) {
    console.debug("[Watchparty Playback] sending via HTTP", event);
    await this.httpSend("playback", event);
  }

  async trackPresence(presence: RoomPresence) {
    this.latestPresence = presence;
    await this.sendPresence();
  }

  async notifyMessageChange() {
    await this.httpSend("message_changed", { changedAt: new Date().toISOString() });
  }

  async sendReaction(event: ReactionEvent) {
    await this.httpSend("reaction", event);
  }

  async disconnect() {
    this.version += 1;
    await this.removeCurrentChannel();
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
    this.heartbeatTimer = undefined;
    this.latestPresence = undefined;
    this.presenceByUser.clear();
    const channel = this.channel;
    this.channel = undefined;
    if (channel) await supabase.removeChannel(channel);
  }
}
