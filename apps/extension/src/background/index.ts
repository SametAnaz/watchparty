chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);

type BackgroundMediaCandidate = {
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

type FramedMediaCandidate = BackgroundMediaCandidate & {
  frameId: number;
};

type MediaSelection = {
  frameId: number;
  candidateId: string;
};

const mediaFrameByTab = new Map<number, number>();
const mediaCandidatesByTab = new Map<number, Map<number, BackgroundMediaCandidate[]>>();
const selectedMediaByTab = new Map<number, MediaSelection>();
const candidateGenerationByTab = new Map<number, Map<number, number>>();
const selectionHydratedTabs = new Set<number>();
const selectionHydrationByTab = new Map<number, Promise<MediaSelection | undefined>>();
const candidateStateHydratedTabs = new Set<number>();
const candidateHydrationScheduledTabs = new Set<number>();
const tabsNeedingCandidateHydration = new Set<number>();
const navigationEpochByTab = new Map<number, number>();
const documentIdsByTab = new Map<number, Map<number, string>>();
const ensureTaskByTab = new Map<number, { epoch: number; promise: Promise<void> }>();
const BACKGROUND_MIN_AUTOMATIC_VIDEO_WIDTH = 240;
const BACKGROUND_MIN_AUTOMATIC_VIDEO_HEIGHT = 135;

function selectionStorageKey(tabId: number) {
  return `watchparty:media-selection:${tabId}`;
}

function fallbackAutomaticScore(
  kind: "video" | "audio",
  width: number,
  height: number,
  playing: boolean,
) {
  if (kind === "audio") return 100_000 + (playing ? 150_000 : 0);
  const area = Math.max(0, width * height);
  return 300_000 + area + (playing ? Math.min(area, 250_000) : 0);
}

function normalizeCandidate(value: unknown): BackgroundMediaCandidate | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.candidateId !== "string"
    || typeof candidate.title !== "string"
    || (candidate.kind !== "video" && candidate.kind !== "audio")
  ) return null;

  const width = Number.isFinite(candidate.width) ? Math.max(0, Math.round(Number(candidate.width))) : 0;
  const height = Number.isFinite(candidate.height) ? Math.max(0, Math.round(Number(candidate.height))) : 0;
  const kind = candidate.kind;
  const playing = candidate.playing === true;
  const inferredEligibility = kind === "audio"
    || (width >= BACKGROUND_MIN_AUTOMATIC_VIDEO_WIDTH && height >= BACKGROUND_MIN_AUTOMATIC_VIDEO_HEIGHT);
  return {
    candidateId: candidate.candidateId,
    title: candidate.title,
    kind,
    duration: Number.isFinite(candidate.duration) ? Number(candidate.duration) : 0,
    playing,
    paused: candidate.paused !== false,
    width,
    height,
    autoEligible: typeof candidate.autoEligible === "boolean" ? candidate.autoEligible : inferredEligibility,
    autoScore: Number.isFinite(candidate.autoScore)
      ? Number(candidate.autoScore)
      : fallbackAutomaticScore(kind, width, height, playing),
  };
}

function frameCandidates(tabId: number, frameId: number, values: unknown) {
  const candidates = Array.isArray(values)
    ? values.map(normalizeCandidate).filter((candidate): candidate is BackgroundMediaCandidate => Boolean(candidate))
    : [];
  let byFrame = mediaCandidatesByTab.get(tabId);
  if (!byFrame) {
    byFrame = new Map();
    mediaCandidatesByTab.set(tabId, byFrame);
  }
  byFrame.set(frameId, candidates);
  return candidates;
}

function mergeFrameCandidate(tabId: number, frameId: number, value: unknown) {
  const candidate = normalizeCandidate(value);
  if (!candidate) return;
  const existing = mediaCandidatesByTab.get(tabId)?.get(frameId) ?? [];
  const index = existing.findIndex((item) => item.candidateId === candidate.candidateId);
  const candidates = [...existing];
  if (index === -1) candidates.push(candidate);
  else candidates[index] = candidate;
  frameCandidates(tabId, frameId, candidates);
}

function allCandidates(tabId: number): FramedMediaCandidate[] {
  const byFrame = mediaCandidatesByTab.get(tabId);
  if (!byFrame) return [];
  return [...byFrame.entries()]
    .sort(([leftFrameId], [rightFrameId]) => leftFrameId - rightFrameId)
    .flatMap(([frameId, candidates]) => candidates.map((candidate) => ({ ...candidate, frameId })));
}

function chooseBestCandidate(candidates: FramedMediaCandidate[]) {
  const eligible = candidates.filter((candidate) => candidate.autoEligible);
  const pool = eligible.length ? eligible : candidates;
  return [...pool].sort((left, right) => right.autoScore - left.autoScore)[0];
}

async function extensionMessage(message: unknown) {
  try { await chrome.runtime.sendMessage(message); } catch { /* Side panel can be closed. */ }
}

async function publishMediaCandidates(tabId: number) {
  await rememberedSelection(tabId);
  const selected = selectedMediaByTab.get(tabId) ?? null;
  await extensionMessage({
    type: "WATCHPARTY_MEDIA_CANDIDATES",
    tabId,
    candidates: allCandidates(tabId),
    selected,
  });
}

function rememberSelection(tabId: number, selection: MediaSelection) {
  selectionHydratedTabs.add(tabId);
  selectedMediaByTab.set(tabId, selection);
  mediaFrameByTab.set(tabId, selection.frameId);
  void chrome.storage.session.set({ [selectionStorageKey(tabId)]: selection }).catch(() => undefined);
}

function forgetSelection(tabId: number) {
  selectionHydratedTabs.add(tabId);
  selectedMediaByTab.delete(tabId);
  void chrome.storage.session.remove(selectionStorageKey(tabId)).catch(() => undefined);
}

async function rememberedSelection(tabId: number) {
  const current = selectedMediaByTab.get(tabId);
  if (current) return current;
  if (selectionHydratedTabs.has(tabId)) return undefined;
  const pending = selectionHydrationByTab.get(tabId);
  if (pending) return await pending;

  const hydration = (async () => {
    try {
      const key = selectionStorageKey(tabId);
      const stored = (await chrome.storage.session.get(key))[key] as Partial<MediaSelection> | undefined;
      if (selectionHydratedTabs.has(tabId)) return selectedMediaByTab.get(tabId);
      selectionHydratedTabs.add(tabId);
      if (typeof stored?.frameId === "number" && typeof stored.candidateId === "string") {
        const selection = { frameId: stored.frameId, candidateId: stored.candidateId };
        selectedMediaByTab.set(tabId, selection);
        mediaFrameByTab.set(tabId, selection.frameId);
        return selection;
      }
    } catch {
      selectionHydratedTabs.add(tabId);
      return selectedMediaByTab.get(tabId);
    }
    return undefined;
  })();
  selectionHydrationByTab.set(tabId, hydration);
  try {
    return await hydration;
  } finally {
    if (selectionHydrationByTab.get(tabId) === hydration) selectionHydrationByTab.delete(tabId);
  }
}

function navigationEpoch(tabId: number) {
  return navigationEpochByTab.get(tabId) ?? 0;
}

function advanceNavigationEpoch(tabId: number) {
  const next = navigationEpoch(tabId) + 1;
  navigationEpochByTab.set(tabId, next);
  return next;
}

function recordDocument(tabId: number, frameId: number, documentId: string | undefined, replace = false) {
  if (!documentId) return;
  let documents = documentIdsByTab.get(tabId);
  if (!documents) {
    documents = new Map();
    documentIdsByTab.set(tabId, documents);
  }
  if (replace || !documents.has(frameId)) documents.set(frameId, documentId);
}

function senderDocumentIsCurrent(
  tabId: number,
  frameId: number | undefined,
  documentId: string | undefined,
  lifecycle: chrome.runtime.MessageSender["documentLifecycle"],
) {
  if (lifecycle && lifecycle !== "active") return false;
  if (frameId === undefined || !documentId) return true;
  const documents = documentIdsByTab.get(tabId);
  const known = documents?.get(frameId);
  if (known && known !== documentId) return false;
  if (!known && frameId !== 0 && documents?.has(0)) return false;
  if (!known) recordDocument(tabId, frameId, documentId);
  return true;
}

function publishNoMediaStatus(tabId: number) {
  return extensionMessage({
    type: "WATCHPARTY_VIDEO_STATUS",
    tabId,
    videoDetected: false,
    mediaTime: 0,
    duration: 0,
    playbackRate: 1,
    paused: true,
    title: "Medya bekleniyor",
    mediaFingerprint: null,
  });
}

function clearTabMediaState(tabId: number, publish = true) {
  mediaFrameByTab.delete(tabId);
  mediaCandidatesByTab.delete(tabId);
  candidateGenerationByTab.delete(tabId);
  candidateStateHydratedTabs.delete(tabId);
  tabsNeedingCandidateHydration.add(tabId);
  forgetSelection(tabId);
  if (publish) {
    void publishMediaCandidates(tabId);
    void publishNoMediaStatus(tabId);
  }
}

async function activeFramesForTab(tabId: number, expectedEpoch: number) {
  const frames = await chrome.webNavigation.getAllFrames({ tabId });
  if (navigationEpoch(tabId) !== expectedEpoch) return null;
  return (frames ?? []).filter((frame) => frame.documentLifecycle === "active");
}

async function pruneDetachedFrames(
  tabId: number,
  frames: chrome.webNavigation.GetAllFrameResultDetails[],
  expectedEpoch: number,
) {
  const selection = await rememberedSelection(tabId);
  if (navigationEpoch(tabId) !== expectedEpoch) return false;

  const availableFrameIds = new Set(frames.map(({ frameId }) => frameId));
  const cachedFrames = mediaCandidatesByTab.get(tabId);
  for (const frameId of cachedFrames?.keys() ?? []) {
    if (!availableFrameIds.has(frameId)) cachedFrames?.delete(frameId);
  }
  if (cachedFrames?.size === 0) mediaCandidatesByTab.delete(tabId);

  const documents = new Map<number, string>();
  for (const frame of frames) documents.set(frame.frameId, frame.documentId);
  documentIdsByTab.set(tabId, documents);

  if (selection && !availableFrameIds.has(selection.frameId)) forgetSelection(tabId);
  const preferredFrameId = mediaFrameByTab.get(tabId);
  if (preferredFrameId !== undefined && !availableFrameIds.has(preferredFrameId)) {
    mediaFrameByTab.delete(tabId);
  }
  return true;
}

function updatePreferredFrame(tabId: number) {
  const previous = mediaFrameByTab.get(tabId);
  const selected = selectedMediaByTab.get(tabId);
  const automaticCandidate = selected ? undefined : chooseBestCandidate(allCandidates(tabId));
  const next = selected?.frameId ?? automaticCandidate?.frameId;
  if (next === undefined) mediaFrameByTab.delete(tabId);
  else mediaFrameByTab.set(tabId, next);
  return { previous, next };
}

async function requestFrameStatus(tabId: number, frameId: number) {
  try {
    await chrome.tabs.sendMessage(
      tabId,
      { type: "WATCHPARTY_REQUEST_VIDEO_STATUS" },
      { frameId },
    );
    return true;
  } catch {
    return false;
  }
}

async function recoverPreferredStatus(tabId: number, previousFrameId: number | undefined, force = false) {
  const nextFrameId = mediaFrameByTab.get(tabId);
  if (nextFrameId === undefined || (!force && nextFrameId === previousFrameId)) return;
  await requestFrameStatus(tabId, nextFrameId);
}

function scheduleCandidateHydration(tabId: number) {
  if (
    (candidateStateHydratedTabs.has(tabId) && !tabsNeedingCandidateHydration.has(tabId))
    || candidateHydrationScheduledTabs.has(tabId)
  ) return;
  const expectedEpoch = navigationEpoch(tabId);
  candidateHydrationScheduledTabs.add(tabId);
  void (async () => {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (navigationEpoch(tabId) !== expectedEpoch) return;
      if (tab.status === "complete") {
        await ensureContentScripts(tabId);
      } else {
        tabsNeedingCandidateHydration.add(tabId);
      }
    } catch {
      if (navigationEpoch(tabId) === expectedEpoch) tabsNeedingCandidateHydration.add(tabId);
    } finally {
      candidateHydrationScheduledTabs.delete(tabId);
      if (
        navigationEpoch(tabId) !== expectedEpoch
        && tabsNeedingCandidateHydration.has(tabId)
      ) scheduleCandidateHydration(tabId);
    }
  })();
}

async function clearFrameMediaState(tabId: number, frameId: number, expectedEpoch: number) {
  const forceStatusRecovery = !candidateStateHydratedTabs.has(tabId);
  const previousPreferredFrame = mediaFrameByTab.get(tabId);
  const byFrame = mediaCandidatesByTab.get(tabId);
  byFrame?.delete(frameId);
  if (byFrame?.size === 0) mediaCandidatesByTab.delete(tabId);
  candidateGenerationByTab.get(tabId)?.delete(frameId);
  if (selectedMediaByTab.get(tabId)?.frameId === frameId) forgetSelection(tabId);

  await rememberedSelection(tabId);
  if (navigationEpoch(tabId) !== expectedEpoch) return;
  if (selectedMediaByTab.get(tabId)?.frameId === frameId) forgetSelection(tabId);
  updatePreferredFrame(tabId);
  await recoverPreferredStatus(tabId, previousPreferredFrame, forceStatusRecovery);
  if (navigationEpoch(tabId) !== expectedEpoch) return;
  await publishMediaCandidates(tabId);
  if (mediaFrameByTab.get(tabId) === undefined) await publishNoMediaStatus(tabId);
  tabsNeedingCandidateHydration.add(tabId);
}

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

async function sendSelectionToFrame(tabId: number, selection: MediaSelection) {
  try {
    const response = await chrome.tabs.sendMessage(
      tabId,
      { type: "WATCHPARTY_SELECT_MEDIA", candidateId: selection.candidateId },
      { frameId: selection.frameId },
    );
    return response?.selected === true;
  } catch {
    return false;
  }
}

function clearSelectionInFrame(tabId: number, frameId: number) {
  void chrome.tabs.sendMessage(
    tabId,
    { type: "WATCHPARTY_CLEAR_MEDIA_SELECTION" },
    { frameId },
  ).catch(() => undefined);
}

async function ensureContentScriptsForEpoch(tabId: number, expectedEpoch: number) {
  const availableFrames = await activeFramesForTab(tabId, expectedEpoch);
  if (!availableFrames || !await pruneDetachedFrames(tabId, availableFrames, expectedEpoch)) return;

  let detected = false;
  let reachableFrames = 0;

  await Promise.all(availableFrames.map(async ({ frameId }) => {
    try {
      await chrome.tabs.sendMessage(tabId, { type: "WATCHPARTY_PING" }, { frameId });
    } catch {
      try { await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, files: ["assets/content.js"] }); }
      catch {
        if (navigationEpoch(tabId) !== expectedEpoch) return;
        frameCandidates(tabId, frameId, []);
        return;
      }
    }

    if (navigationEpoch(tabId) !== expectedEpoch) return;
    reachableFrames += 1;
    try {
      const response = await chrome.tabs.sendMessage(tabId, { type: "WATCHPARTY_REQUEST_VIDEO_STATUS" }, { frameId });
      if (navigationEpoch(tabId) !== expectedEpoch) return;
      const candidates = frameCandidates(tabId, frameId, response?.candidates);
      if (response?.videoDetected || candidates.length > 0) detected = true;
    } catch {
      if (navigationEpoch(tabId) !== expectedEpoch) return;
      frameCandidates(tabId, frameId, []);
    }
  }));
  if (navigationEpoch(tabId) !== expectedEpoch) return;

  const selection = await rememberedSelection(tabId);
  if (navigationEpoch(tabId) !== expectedEpoch) return;
  const selectionStillExists = selection
    ? allCandidates(tabId).some(({ frameId, candidateId }) => (
      frameId === selection.frameId && candidateId === selection.candidateId
    ))
    : false;

  if (selection && selectionStillExists && await sendSelectionToFrame(tabId, selection)) {
    mediaFrameByTab.set(tabId, selection.frameId);
  } else {
    if (selection) forgetSelection(tabId);
    updatePreferredFrame(tabId);
  }
  if (navigationEpoch(tabId) !== expectedEpoch) return;

  await recoverPreferredStatus(tabId, undefined, true);
  if (navigationEpoch(tabId) !== expectedEpoch) return;
  candidateStateHydratedTabs.add(tabId);
  tabsNeedingCandidateHydration.delete(tabId);
  await publishMediaCandidates(tabId);
  if (!detected) {
    await publishNoMediaStatus(tabId);
    if (!reachableFrames) {
      await extensionMessage({
        type: "WATCHPARTY_MEDIA_ERROR",
        tabId,
        message: "Bu sekmeye erişilemiyor. Normal bir web sayfasında tekrar dene.",
      });
    }
  }
}

function ensureContentScripts(tabId: number) {
  const epoch = navigationEpoch(tabId);
  const current = ensureTaskByTab.get(tabId);
  if (current?.epoch === epoch) return current.promise;

  const promise = ensureContentScriptsForEpoch(tabId, epoch);
  ensureTaskByTab.set(tabId, { epoch, promise });
  void promise.then(
    () => {
      if (ensureTaskByTab.get(tabId)?.promise === promise) ensureTaskByTab.delete(tabId);
    },
    () => {
      if (ensureTaskByTab.get(tabId)?.promise === promise) ensureTaskByTab.delete(tabId);
    },
  );
  return promise;
}

async function selectMedia(tabId: number, selection: MediaSelection) {
  const previousSelection = await rememberedSelection(tabId);
  let selected = await sendSelectionToFrame(tabId, selection);
  if (!selected) {
    await ensureContentScripts(tabId);
    selected = await sendSelectionToFrame(tabId, selection);
  }
  if (!selected) {
    await extensionMessage({
      type: "WATCHPARTY_MEDIA_ERROR",
      tabId,
      message: "Seçilen medya artık bu sayfada bulunamıyor.",
    });
    return false;
  }

  rememberSelection(tabId, selection);
  if (previousSelection && previousSelection.frameId !== selection.frameId) {
    clearSelectionInFrame(tabId, previousSelection.frameId);
  }
  try {
    await chrome.tabs.sendMessage(
      tabId,
      { type: "WATCHPARTY_REQUEST_VIDEO_STATUS" },
      { frameId: selection.frameId },
    );
  } catch { /* Selection is valid; the next media event will refresh status. */ }
  await publishMediaCandidates(tabId);
  return true;
}

async function applyPlayback(tabId: number, preferredFrameId: number | undefined, message: unknown) {
  const selected = await rememberedSelection(tabId);
  if (selected) {
    try {
      const selectedMessage = message && typeof message === "object"
        ? { ...message, selectedCandidateId: selected.candidateId }
        : message;
      const response = await chrome.tabs.sendMessage(tabId, selectedMessage, { frameId: selected.frameId });
      if (response?.applied) {
        mediaFrameByTab.set(tabId, selected.frameId);
        return true;
      }
      if (response && typeof response.applied === "boolean") return false;
    } catch { /* A removed selection falls back to automatic media discovery. */ }
    forgetSelection(tabId);
  }

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
        return true;
      }
    } catch { /* Try the next frame. */ }
  }

  await ensureContentScripts(tabId);
  const refreshedFrameId = mediaFrameByTab.get(tabId);
  if (refreshedFrameId !== undefined) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, message, { frameId: refreshedFrameId });
      if (response?.applied) return true;
    } catch { /* Report below. */ }
  }
  await extensionMessage({
    type: "WATCHPARTY_MEDIA_ERROR",
    tabId,
    message: "Playback komutu uygulanacak medya bulunamadı. Medyayı yenilemeyi dene.",
  });
  return false;
}

async function handleFrameCandidates(
  tabId: number,
  frameId: number,
  documentId: string | undefined,
  message: Record<string, unknown>,
) {
  const expectedEpoch = navigationEpoch(tabId);
  if (!senderDocumentIsCurrent(tabId, frameId, documentId, "active")) return;
  let generations = candidateGenerationByTab.get(tabId);
  if (!generations) {
    generations = new Map();
    candidateGenerationByTab.set(tabId, generations);
  }
  const generation = (generations.get(frameId) ?? 0) + 1;
  generations.set(frameId, generation);
  const candidates = frameCandidates(tabId, frameId, message.candidates);
  const previousPreferredFrame = mediaFrameByTab.get(tabId);
  const needsHydration = !candidateStateHydratedTabs.has(tabId);
  const [, frames] = await Promise.all([
    rememberedSelection(tabId),
    activeFramesForTab(tabId, expectedEpoch),
  ]);
  if (
    navigationEpoch(tabId) !== expectedEpoch
    || candidateGenerationByTab.get(tabId)?.get(frameId) !== generation
    || !senderDocumentIsCurrent(tabId, frameId, documentId, "active")
    || !frames
  ) return;
  if (!await pruneDetachedFrames(tabId, frames, expectedEpoch)) return;
  if (
    candidateGenerationByTab.get(tabId)?.get(frameId) !== generation
    || !senderDocumentIsCurrent(tabId, frameId, documentId, "active")
  ) return;
  if (!frames.some((frame) => frame.frameId === frameId)) return;

  const contentSelection = typeof message.selectedCandidateId === "string"
    && candidates.some(({ candidateId }) => candidateId === message.selectedCandidateId)
    ? { frameId, candidateId: message.selectedCandidateId }
    : undefined;

  const currentRememberedSelection = selectedMediaByTab.get(tabId);
  if (contentSelection && (!currentRememberedSelection || currentRememberedSelection.frameId === frameId)) {
    rememberSelection(tabId, contentSelection);
  }
  const selected = selectedMediaByTab.get(tabId);
  if (
    selected?.frameId === frameId
    && !candidates.some(({ candidateId }) => candidateId === selected.candidateId)
  ) forgetSelection(tabId);

  updatePreferredFrame(tabId);
  await recoverPreferredStatus(tabId, previousPreferredFrame);
  if (navigationEpoch(tabId) !== expectedEpoch) return;
  await publishMediaCandidates(tabId);
  if (needsHydration) scheduleCandidateHydration(tabId);
}

async function forwardContentMessage(
  message: Record<string, unknown>,
  sender: chrome.runtime.MessageSender,
) {
  const tabId = sender.tab?.id;
  if (!tabId || typeof message.type !== "string") return;
  const frameId = sender.frameId;
  const expectedEpoch = navigationEpoch(tabId);
  if (!senderDocumentIsCurrent(tabId, frameId, sender.documentId, sender.documentLifecycle)) return;
  if (typeof frameId === "number") mergeFrameCandidate(tabId, frameId, message.mediaCandidate);
  const selected = await rememberedSelection(tabId);
  if (
    navigationEpoch(tabId) !== expectedEpoch
    || !senderDocumentIsCurrent(tabId, frameId, sender.documentId, sender.documentLifecycle)
  ) return;
  const isPlaybackSourceMessage = message.type === "WATCHPARTY_VIDEO_STATUS"
    || message.type === "WATCHPARTY_LOCAL_PLAYBACK";
  const messageCandidateId = typeof message.candidateId === "string" ? message.candidateId : undefined;
  const previousPreferredFrame = mediaFrameByTab.get(tabId);
  if (selected && isPlaybackSourceMessage) {
    if (frameId !== selected.frameId) return;
    if (messageCandidateId && messageCandidateId !== selected.candidateId) return;
    mediaFrameByTab.set(tabId, selected.frameId);
  } else if (isPlaybackSourceMessage) {
    const automaticCandidate = chooseBestCandidate(allCandidates(tabId));
    if (automaticCandidate) {
      if (
        frameId !== automaticCandidate.frameId
        || (messageCandidateId && messageCandidateId !== automaticCandidate.candidateId)
      ) return;
      mediaFrameByTab.set(tabId, automaticCandidate.frameId);
    } else if (previousPreferredFrame !== undefined && frameId !== previousPreferredFrame) {
      return;
    }
  }

  const pageUrl = sender.tab?.url ?? message.pageUrl;
  const mediaFingerprint = message.type === "WATCHPARTY_VIDEO_STATUS" && message.videoDetected
    ? stableMediaFingerprint(
      typeof pageUrl === "string" ? pageUrl : undefined,
      message.duration,
      message.title,
    ) ?? message.mediaFingerprint
    : message.mediaFingerprint;
  if (message.type === "WATCHPARTY_VIDEO_STATUS" && message.videoDetected && typeof frameId === "number") {
    mediaFrameByTab.set(tabId, selected?.frameId ?? frameId);
  }
  await extensionMessage({ ...message, tabId, frameId, pageUrl, mediaFingerprint });
  if (message.type === "WATCHPARTY_LOCAL_PLAYBACK") {
    await recoverPreferredStatus(tabId, previousPreferredFrame);
  }
}

chrome.tabs.onRemoved.addListener((tabId) => {
  advanceNavigationEpoch(tabId);
  clearTabMediaState(tabId, false);
  mediaFrameByTab.delete(tabId);
  mediaCandidatesByTab.delete(tabId);
  selectedMediaByTab.delete(tabId);
  candidateGenerationByTab.delete(tabId);
  candidateStateHydratedTabs.delete(tabId);
  candidateHydrationScheduledTabs.delete(tabId);
  tabsNeedingCandidateHydration.delete(tabId);
  documentIdsByTab.delete(tabId);
  ensureTaskByTab.delete(tabId);
});

chrome.webNavigation.onCommitted.addListener(({ tabId, frameId, documentId }) => {
  const epoch = advanceNavigationEpoch(tabId);
  if (frameId === 0) {
    documentIdsByTab.delete(tabId);
    recordDocument(tabId, frameId, documentId, true);
    clearTabMediaState(tabId);
  } else {
    recordDocument(tabId, frameId, documentId, true);
    void clearFrameMediaState(tabId, frameId, epoch);
  }
});

chrome.webNavigation.onHistoryStateUpdated.addListener(({ tabId, frameId, documentId }) => {
  if (frameId !== 0) return;
  advanceNavigationEpoch(tabId);
  recordDocument(tabId, frameId, documentId);
  tabsNeedingCandidateHydration.add(tabId);
  scheduleCandidateHydration(tabId);
});

chrome.webNavigation.onCompleted.addListener(({ tabId, frameId, documentId }) => {
  recordDocument(tabId, frameId, documentId);
  if (tabsNeedingCandidateHydration.has(tabId) || !candidateStateHydratedTabs.has(tabId)) {
    scheduleCandidateHydration(tabId);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "WATCHPARTY_ENSURE_CONTENT" && typeof message.tabId === "number") {
    void ensureContentScripts(message.tabId)
      .then(() => sendResponse({ ready: true }))
      .catch((error: unknown) => {
        void publishNoMediaStatus(message.tabId);
        void extensionMessage({
          type: "WATCHPARTY_MEDIA_ERROR",
          tabId: message.tabId,
          message: error instanceof Error ? error.message : "Bu sekmede medya algılanamadı.",
        });
        sendResponse({ ready: false });
      });
    return true;
  }

  if (
    message?.type === "WATCHPARTY_SELECT_MEDIA"
    && typeof message.tabId === "number"
    && typeof message.frameId === "number"
    && typeof message.candidateId === "string"
  ) {
    void selectMedia(message.tabId, {
      frameId: message.frameId,
      candidateId: message.candidateId,
    }).then((selected) => sendResponse({ selected })).catch((error: unknown) => {
      console.error("[Watchparty Media] selection failed", error);
      sendResponse({ selected: false });
    });
    return true;
  }

  if (message?.type === "WATCHPARTY_APPLY_REMOTE_PLAYBACK" && typeof message.tabId === "number") {
    void applyPlayback(message.tabId, typeof message.frameId === "number" ? message.frameId : undefined, message)
      .then((applied) => sendResponse({ applied }))
      .catch((error: unknown) => {
        console.error("[Watchparty Playback] apply failed", error);
        sendResponse({ applied: false });
      });
    return true;
  }

  if (sender.tab?.id && typeof message?.type === "string" && message.type.startsWith("WATCHPARTY_")) {
    const tabId = sender.tab.id;
    const frameId = sender.frameId;
    if (!senderDocumentIsCurrent(tabId, frameId, sender.documentId, sender.documentLifecycle)) return;
    if (message.type === "WATCHPARTY_MEDIA_CANDIDATES" && typeof frameId === "number") {
      void handleFrameCandidates(tabId, frameId, sender.documentId, message);
      return;
    }
    void forwardContentMessage(message, sender);
  }
});
