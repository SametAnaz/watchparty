chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);

const mediaFrameByTab = new Map<number, number>();

function stableMediaFingerprint(pageUrl: string | undefined, duration: unknown, title: unknown) {
  if (!pageUrl) return null;
  try {
    const url = new URL(pageUrl);
    url.hash = "";
    return `${url.href}|${Math.round(Number(duration) || 0)}|${String(title ?? "").trim().toLocaleLowerCase()}`;
  } catch {
    return null;
  }
}

async function extensionMessage(message: unknown) {
  try { await chrome.runtime.sendMessage(message); } catch { /* Side panel can be closed. */ }
}

async function ensureContentScripts(tabId: number) {
  const frames = await chrome.webNavigation.getAllFrames({ tabId });
  let detected = false;
  let reachableFrames = 0;

  await Promise.all((frames ?? [{ frameId: 0 }]).map(async ({ frameId }) => {
    try {
      await chrome.tabs.sendMessage(tabId, { type: "WATCHPARTY_PING" }, { frameId });
    } catch {
      try { await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, files: ["assets/content.js"] }); }
      catch { return; }
    }

    reachableFrames += 1;
    try {
      const response = await chrome.tabs.sendMessage(tabId, { type: "WATCHPARTY_REQUEST_VIDEO_STATUS" }, { frameId });
      if (response?.videoDetected) {
        detected = true;
        mediaFrameByTab.set(tabId, frameId);
      }
    } catch { /* Frame may disappear during navigation. */ }
  }));

  if (!detected) await extensionMessage({
    type: reachableFrames ? "WATCHPARTY_VIDEO_STATUS" : "WATCHPARTY_MEDIA_ERROR",
    videoDetected: false,
    message: reachableFrames ? undefined : "Bu sekmeye erişilemiyor. Normal bir web sayfasında tekrar dene.",
  });
}

async function applyPlayback(tabId: number, preferredFrameId: number | undefined, message: unknown) {
  const frames = await chrome.webNavigation.getAllFrames({ tabId });
  const candidates = [...new Set([
    preferredFrameId,
    mediaFrameByTab.get(tabId),
    ...(frames ?? []).map((frame) => frame.frameId),
  ].filter((frameId): frameId is number => typeof frameId === "number"))];

  for (const frameId of candidates) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, message, { frameId });
      if (response?.applied) {
        mediaFrameByTab.set(tabId, frameId);
        return;
      }
    } catch { /* Try the next frame. */ }
  }

  await ensureContentScripts(tabId);
  const refreshedFrameId = mediaFrameByTab.get(tabId);
  if (refreshedFrameId !== undefined) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, message, { frameId: refreshedFrameId });
      if (response?.applied) return;
    } catch { /* Report below. */ }
  }
  await extensionMessage({ type: "WATCHPARTY_MEDIA_ERROR", message: "Playback komutu uygulanacak medya bulunamadı. Medyayı yenilemeyi dene." });
}

chrome.tabs.onRemoved.addListener((tabId) => mediaFrameByTab.delete(tabId));

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type === "WATCHPARTY_ENSURE_CONTENT" && typeof message.tabId === "number") {
    void ensureContentScripts(message.tabId).catch((error: unknown) => extensionMessage({
      type: "WATCHPARTY_MEDIA_ERROR",
      message: error instanceof Error ? error.message : "Bu sekmede medya algılanamadı.",
    }));
    return;
  }

  if (message?.type === "WATCHPARTY_APPLY_REMOTE_PLAYBACK" && typeof message.tabId === "number") {
    void applyPlayback(message.tabId, typeof message.frameId === "number" ? message.frameId : undefined, message);
    return;
  }

  if (sender.tab?.id && typeof message?.type === "string" && message.type.startsWith("WATCHPARTY_")) {
    const pageUrl = sender.tab.url ?? message.pageUrl;
    const mediaFingerprint = message.type === "WATCHPARTY_VIDEO_STATUS"
      ? stableMediaFingerprint(pageUrl, message.duration, message.title) ?? message.mediaFingerprint
      : message.mediaFingerprint;
    if (message.type === "WATCHPARTY_VIDEO_STATUS" && message.videoDetected && typeof sender.frameId === "number") {
      mediaFrameByTab.set(sender.tab.id, sender.frameId);
    }
    void extensionMessage({ ...message, tabId: sender.tab.id, frameId: sender.frameId, pageUrl, mediaFingerprint });
  }
});
