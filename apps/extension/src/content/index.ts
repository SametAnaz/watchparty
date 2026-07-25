type LocalAction = "PLAY" | "PAUSE" | "SEEK" | "RATE_CHANGE";

type ContentMediaCandidate = {
  candidateId: string;
  title: string;
  kind: "video" | "audio";
  duration: number;
  playing: boolean;
  paused: boolean;
  width: number;
  height: number;
  autoEligible: boolean;
  autoScore: number;
};

let activeMedia: HTMLMediaElement | undefined;
let activeMediaListeners: AbortController | undefined;
let applyingRemoteAction = false;
let lastSentSeekAt = 0;
let lastStatusSignature = "";
let lastCandidatesSignature = "";
let nextCandidateId = 1;
let selectedCandidateId: string | undefined;

const candidateIdByMedia = new WeakMap<HTMLMediaElement, string>();
const candidateIdNamespace = typeof crypto.randomUUID === "function"
  ? crypto.randomUUID()
  : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
const CONTENT_MIN_AUTOMATIC_VIDEO_WIDTH = 240;
const CONTENT_MIN_AUTOMATIC_VIDEO_HEIGHT = 135;

function finite(value: number) {
  return Number.isFinite(value) ? value : 0;
}

function candidateId(media: HTMLMediaElement) {
  const current = candidateIdByMedia.get(media);
  if (current) return current;
  const created = `media-${candidateIdNamespace}-${nextCandidateId++}`;
  candidateIdByMedia.set(media, created);
  return created;
}

function fingerprint(media: HTMLMediaElement) {
  return [location.origin, location.pathname, media.currentSrc || media.getAttribute("src") || "", finite(media.duration)].join("|");
}

function mediaTitle(media: HTMLMediaElement) {
  return media.getAttribute("aria-label") || media.getAttribute("title") || document.title || "İsimsiz medya";
}

function mediaElements() {
  return [...document.querySelectorAll<HTMLMediaElement>("video, audio")];
}

function hasMediaSource(media: HTMLMediaElement) {
  return media.readyState > HTMLMediaElement.HAVE_NOTHING
    || Boolean(media.currentSrc || media.getAttribute("src") || media.querySelector("source[src]"));
}

function isRenderedVideo(media: HTMLVideoElement, bounds: DOMRect) {
  const style = window.getComputedStyle(media);
  const opacity = Number.parseFloat(style.opacity);
  const browserVisible = typeof media.checkVisibility !== "function"
    || media.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  return browserVisible
    && !media.hidden
    && media.getAttribute("aria-hidden") !== "true"
    && style.display !== "none"
    && style.visibility !== "hidden"
    && style.visibility !== "collapse"
    && (!Number.isFinite(opacity) || opacity > 0.05)
    && bounds.width >= CONTENT_MIN_AUTOMATIC_VIDEO_WIDTH
    && bounds.height >= CONTENT_MIN_AUTOMATIC_VIDEO_HEIGHT;
}

function automaticScore(kind: "video" | "audio", width: number, height: number, playing: boolean, readyState: number) {
  const readiness = Math.max(0, Math.min(4, readyState)) * 1000;
  if (kind === "audio") return 100_000 + (playing ? 150_000 : 0) + readiness;
  const area = Math.max(0, width * height);
  return 300_000 + area + (playing ? Math.min(area, 250_000) : 0) + readiness;
}

function describeMedia(media: HTMLMediaElement): ContentMediaCandidate {
  const bounds = media.getBoundingClientRect();
  const intrinsicWidth = media instanceof HTMLVideoElement ? media.videoWidth : 0;
  const intrinsicHeight = media instanceof HTMLVideoElement ? media.videoHeight : 0;
  const kind = media instanceof HTMLVideoElement ? "video" : "audio";
  const playing = !media.paused && !media.ended;
  const width = Math.round(finite(bounds.width) || intrinsicWidth);
  const height = Math.round(finite(bounds.height) || intrinsicHeight);
  const autoEligible = hasMediaSource(media)
    && (kind === "audio" || isRenderedVideo(media as HTMLVideoElement, bounds));
  return {
    candidateId: candidateId(media),
    title: mediaTitle(media),
    kind,
    duration: finite(media.duration),
    playing,
    paused: media.paused,
    width,
    height,
    autoEligible,
    autoScore: automaticScore(kind, width, height, playing, media.readyState),
  };
}

function currentCandidates() {
  return mediaElements().map(describeMedia);
}

function sendMediaCandidates(force = false) {
  const candidates = currentCandidates();
  const signature = JSON.stringify({ candidates, selectedCandidateId: selectedCandidateId ?? null });
  if (!force && signature === lastCandidatesSignature) return candidates;
  lastCandidatesSignature = signature;
  void chrome.runtime.sendMessage({
    type: "WATCHPARTY_MEDIA_CANDIDATES",
    candidates,
    selectedCandidateId: selectedCandidateId ?? null,
  }).catch(() => undefined);
  return candidates;
}

function emit(action: LocalAction, media: HTMLMediaElement) {
  if (applyingRemoteAction || media !== activeMedia) return;
  chrome.runtime.sendMessage({
    type: "WATCHPARTY_LOCAL_PLAYBACK",
    candidateId: candidateId(media),
    mediaCandidate: describeMedia(media),
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
    candidateId: candidateId(media),
    mediaCandidate: describeMedia(media),
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
  activeMediaListeners?.abort();
  activeMediaListeners = new AbortController();
  activeMedia = media;
  lastStatusSignature = "";
  const eventOptions = { signal: activeMediaListeners.signal };
  media.addEventListener("play", () => {
    sendMediaCandidates(true);
    emit("PLAY", media);
    sendMediaStatus(media, true);
  }, eventOptions);
  media.addEventListener("pause", () => {
    emit("PAUSE", media);
    sendMediaStatus(media, true);
    sendMediaCandidates(true);
  }, eventOptions);
  media.addEventListener("ratechange", () => emit("RATE_CHANGE", media), eventOptions);
  media.addEventListener("loadedmetadata", () => {
    sendMediaStatus(media, true);
    sendMediaCandidates(true);
  }, eventOptions);
  media.addEventListener("durationchange", () => {
    sendMediaStatus(media);
    sendMediaCandidates(true);
  }, eventOptions);
  media.addEventListener("emptied", () => window.setTimeout(scan, 100), eventOptions);
  media.addEventListener("seeked", () => {
    if (Date.now() - lastSentSeekAt > 250) emit("SEEK", media);
    lastSentSeekAt = Date.now();
  }, eventOptions);
  sendMediaStatus(media, true);
}

function findMedia(elements = mediaElements()) {
  const described = elements.map((media) => ({ media, candidate: describeMedia(media) }));
  const eligible = described.filter(({ candidate }) => candidate.autoEligible);
  const pool = eligible.length ? eligible : described;
  return pool.sort((left, right) => right.candidate.autoScore - left.candidate.autoScore)[0]?.media;
}

function clearActiveMedia() {
  activeMediaListeners?.abort();
  activeMediaListeners = undefined;
  activeMedia = undefined;
  lastStatusSignature = "";
}

function sendNoMediaStatus() {
  if (lastStatusSignature === "no-media") return;
  lastStatusSignature = "no-media";
  void chrome.runtime.sendMessage({
    type: "WATCHPARTY_VIDEO_STATUS",
    videoDetected: false,
    mediaTime: 0,
    duration: 0,
    playbackRate: 1,
    paused: true,
    title: "Medya bekleniyor",
    mediaFingerprint: null,
    pageUrl: location.href,
  }).catch(() => undefined);
}

function scan(forceCandidates = false) {
  const allMedia = mediaElements();
  const previousMedia = activeMedia;
  const selectedMedia = selectedCandidateId
    ? allMedia.find((media) => candidateId(media) === selectedCandidateId)
    : undefined;

  if (selectedCandidateId && !selectedMedia) selectedCandidateId = undefined;
  const media = selectedMedia ?? findMedia(allMedia);
  if (media) attach(media);
  else {
    if (activeMedia) clearActiveMedia();
    sendNoMediaStatus();
  }
  sendMediaCandidates(forceCandidates);
  if (!selectedMedia && previousMedia && media && previousMedia !== media && !media.paused) {
    emit("PLAY", media);
  }
}

function containsFrame(node: Node) {
  return node instanceof HTMLIFrameElement
    || node instanceof HTMLFrameElement
    || (node instanceof Element && Boolean(node.querySelector("iframe, frame")));
}

const observer = new MutationObserver((records) => {
  const frameTreeChanged = records.some((record) => record.type === "childList"
    && [...record.addedNodes, ...record.removedNodes].some(containsFrame));
  scan(frameTreeChanged);
});
observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["src"] });
window.setInterval(scan, 1500);
scan();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "WATCHPARTY_PING") {
    sendResponse({ ready: true });
    return;
  }

  if (message?.type === "WATCHPARTY_REQUEST_VIDEO_STATUS") {
    scan(true);
    if (activeMedia) sendMediaStatus(activeMedia, true);
    sendResponse({
      videoDetected: Boolean(activeMedia),
      candidates: currentCandidates(),
      selectedCandidateId: selectedCandidateId ?? null,
    });
    return;
  }

  if (message?.type === "WATCHPARTY_REQUEST_MEDIA_CANDIDATES") {
    scan(true);
    sendResponse({
      candidates: currentCandidates(),
      selectedCandidateId: selectedCandidateId ?? null,
    });
    return;
  }

  if (message?.type === "WATCHPARTY_CLEAR_MEDIA_SELECTION") {
    selectedCandidateId = undefined;
    scan(true);
    sendResponse({ cleared: true });
    return;
  }

  if (message?.type === "WATCHPARTY_SELECT_MEDIA") {
    const media = typeof message.candidateId === "string"
      ? mediaElements().find((item) => candidateId(item) === message.candidateId)
      : undefined;
    if (!media) {
      sendResponse({ selected: false });
      return;
    }
    selectedCandidateId = message.candidateId;
    attach(media);
    sendMediaCandidates(true);
    sendResponse({
      selected: true,
      candidate: describeMedia(media),
    });
    return;
  }

  if (message?.type !== "WATCHPARTY_APPLY_REMOTE_PLAYBACK" || !activeMedia) return;
  if (
    typeof message.selectedCandidateId === "string"
    && candidateId(activeMedia) !== message.selectedCandidateId
  ) {
    sendResponse({ applied: false, reason: "selection-mismatch" });
    return;
  }
  applyingRemoteAction = true;
  const media = activeMedia;
  const operation = (async () => {
    if (Math.abs(media.currentTime - message.mediaTime) > 0.15) media.currentTime = message.mediaTime;
    media.playbackRate = message.playbackRate;
    console.debug("[Watchparty Playback] applying", message.action, message.mediaTime);
    if (message.paused) media.pause();
    else await media.play();
  })();
  void operation
    .then(() => sendResponse({ applied: true }))
    .catch((error: unknown) => {
      chrome.runtime.sendMessage({
        type: "WATCHPARTY_MEDIA_ERROR",
        message: error instanceof Error ? `Uzaktan oynatma engellendi: ${error.message}` : "Uzaktan oynatma engellendi.",
      });
      sendResponse({ applied: false });
    })
    .finally(() => window.setTimeout(() => {
      applyingRemoteAction = false;
      sendMediaStatus(media, true);
      sendMediaCandidates(true);
    }, 150));
  return true;
});
