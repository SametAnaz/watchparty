type LocalAction = "PLAY" | "PAUSE" | "SEEK" | "RATE_CHANGE";

let activeMedia: HTMLMediaElement | undefined;
let applyingRemoteAction = false;
let lastSentSeekAt = 0;
let lastStatusSignature = "";

function finite(value: number) {
  return Number.isFinite(value) ? value : 0;
}

function fingerprint(media: HTMLMediaElement) {
  return [location.origin, location.pathname, media.currentSrc || media.getAttribute("src") || "", finite(media.duration)].join("|");
}

function mediaTitle(media: HTMLMediaElement) {
  return media.getAttribute("aria-label") || media.getAttribute("title") || document.title || "İsimsiz medya";
}

function emit(action: LocalAction, media: HTMLMediaElement) {
  if (applyingRemoteAction) return;
  chrome.runtime.sendMessage({
    type: "WATCHPARTY_LOCAL_PLAYBACK",
    action,
    mediaTime: finite(media.currentTime),
    playbackRate: media.playbackRate,
    paused: media.paused,
  });
}

function sendMediaStatus(media: HTMLMediaElement, force = false) {
  const status = {
    type: "WATCHPARTY_VIDEO_STATUS",
    videoDetected: true,
    mediaTime: finite(media.currentTime),
    duration: finite(media.duration),
    paused: media.paused,
    playbackRate: media.playbackRate,
    title: mediaTitle(media),
    mediaFingerprint: fingerprint(media),
    pageUrl: location.href,
    mediaKind: media instanceof HTMLVideoElement ? "video" : "audio",
  };
  const signature = [status.mediaFingerprint, status.title, status.duration, status.paused].join("|");
  if (!force && signature === lastStatusSignature) return;
  lastStatusSignature = signature;
  chrome.runtime.sendMessage(status);
}

function attach(media: HTMLMediaElement) {
  if (media === activeMedia) {
    sendMediaStatus(media);
    return;
  }
  activeMedia = media;
  lastStatusSignature = "";
  media.addEventListener("play", () => { emit("PLAY", media); sendMediaStatus(media, true); });
  media.addEventListener("pause", () => { emit("PAUSE", media); sendMediaStatus(media, true); });
  media.addEventListener("ratechange", () => emit("RATE_CHANGE", media));
  media.addEventListener("loadedmetadata", () => sendMediaStatus(media, true));
  media.addEventListener("durationchange", () => sendMediaStatus(media));
  media.addEventListener("emptied", () => window.setTimeout(scan, 100));
  media.addEventListener("seeked", () => {
    if (Date.now() - lastSentSeekAt > 250) emit("SEEK", media);
    lastSentSeekAt = Date.now();
  });
  sendMediaStatus(media, true);
}

function score(media: HTMLMediaElement) {
  const area = media instanceof HTMLVideoElement ? media.clientWidth * media.clientHeight : 0;
  return (media.paused ? 0 : 10_000_000) + area + media.readyState * 1000;
}

function findMedia() {
  return [...document.querySelectorAll<HTMLMediaElement>("video, audio")].sort((a, b) => score(b) - score(a))[0];
}

function scan() {
  const media = findMedia();
  if (media) attach(media);
}

const observer = new MutationObserver(scan);
observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["src"] });
window.setInterval(scan, 1500);
scan();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "WATCHPARTY_PING") {
    sendResponse({ ready: true });
    return;
  }

  if (message?.type === "WATCHPARTY_REQUEST_VIDEO_STATUS") {
    scan();
    if (activeMedia) sendMediaStatus(activeMedia, true);
    sendResponse({ videoDetected: Boolean(activeMedia) });
    return;
  }

  if (message?.type !== "WATCHPARTY_APPLY_REMOTE_PLAYBACK" || !activeMedia) return;
  applyingRemoteAction = true;
  const media = activeMedia;
  if (Math.abs(media.currentTime - message.mediaTime) > 0.15) media.currentTime = message.mediaTime;
  media.playbackRate = message.playbackRate;
  console.debug("[Watchparty Playback] applying", message.action, message.mediaTime);
  const operation = message.paused
    ? Promise.resolve(media.pause())
    : media.play().catch((error: unknown) => {
      chrome.runtime.sendMessage({
        type: "WATCHPARTY_MEDIA_ERROR",
        message: error instanceof Error ? `Uzaktan oynatma engellendi: ${error.message}` : "Uzaktan oynatma engellendi.",
      });
    });
  void operation.finally(() => window.setTimeout(() => { applyingRemoteAction = false; }, 150));
  sendResponse({ applied: true });
});
