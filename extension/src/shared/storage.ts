import type {
  AppConfig,
  DictationNote,
  PersistedChatMessage,
  RecordingItem,
} from "./types";

const CONFIG_KEY = "reco_ext_config_v1";
const RECORDINGS_KEY = "reco_ext_recordings_v1";
const DICTATION_HISTORY_KEY = "reco_ext_dictation_history_v1";
const CACHED_MODELS_KEY = "reco_ext_cached_models_v1";
const CHAT_MESSAGES_KEY = "reco_ext_chat_messages_v1";
const CUSTOM_VOICE_KEY = "reco_ext_custom_voice_v1";

export const DEFAULT_CONFIG: AppConfig = {
  dictation: {
    engine: "chrome",
    language: "es-419",
    polish: true,
    smartSpacing: true,
    autoCapitalize: true,
    showFloatingOrb: true,
    desktopTyping: true,
  },
  recording: {
    quality: "medium",
    fps: 30,
    includeMic: true,
    systemAudio: true,
    uploadStrategy: "immediate_single",
    chapterSeconds: 45,
    keepLocalCopy: true,
  },
  notion: {
    authMode: "oauth_direct",
    token: "",
    workspaceName: "",
    botId: "",
    oauthBrokerUrl: "",
    oauthClientId: "",
    oauthClientSecret: "",
    enviProxyUrl: "",
    targetPageId: "",
    targetPageTitle: "",
    targetPageUrl: "",
    writeMode: "toggle_block",
  },
  ai: {
    provider: "freepi",
    freepiToken: "",
    freepiHandle: "",
    keys: {},
    models: {},
    customBaseUrl: "http://localhost:11434/v1",
    model: "",
    ttsMode: "kokoro",
    ttsVoice: "af_heart",
    ttsSpeed: 1.05,
    customVoiceName: "",
  },
  orbPosition: null,
};

function mergeConfig(raw: Partial<AppConfig> | undefined): AppConfig {
  const mergedDict = { ...DEFAULT_CONFIG.dictation, ...(raw?.dictation ?? {}) };
  if (
    mergedDict.engine !== "chrome" &&
    mergedDict.engine !== "whisper_tiny" &&
    mergedDict.engine !== "whisper_base"
  ) {
    mergedDict.engine = "whisper_base";
  }
  return {
    dictation: mergedDict,
    recording: { ...DEFAULT_CONFIG.recording, ...(raw?.recording ?? {}) },
    notion: { ...DEFAULT_CONFIG.notion, ...(raw?.notion ?? {}) },
    ai: { ...DEFAULT_CONFIG.ai, ...(raw?.ai ?? {}) },
    orbPosition: raw?.orbPosition ?? DEFAULT_CONFIG.orbPosition,
  };
}

export async function getConfig(): Promise<AppConfig> {
  const data = await chrome.storage.local.get(CONFIG_KEY);
  return mergeConfig(data[CONFIG_KEY] as Partial<AppConfig> | undefined);
}

export async function patchConfig(patch: Partial<AppConfig>): Promise<AppConfig> {
  const current = await getConfig();
  const next: AppConfig = {
    dictation: { ...current.dictation, ...(patch.dictation ?? {}) },
    recording: { ...current.recording, ...(patch.recording ?? {}) },
    notion: { ...current.notion, ...(patch.notion ?? {}) },
    ai: { ...current.ai, ...(patch.ai ?? {}) },
    orbPosition: patch.orbPosition !== undefined ? patch.orbPosition : current.orbPosition,
  };
  await chrome.storage.local.set({ [CONFIG_KEY]: next });
  return next;
}

export async function getRecordings(): Promise<RecordingItem[]> {
  const data = await chrome.storage.local.get(RECORDINGS_KEY);
  const list = data[RECORDINGS_KEY];
  return Array.isArray(list) ? (list as RecordingItem[]) : [];
}

export async function upsertRecording(item: RecordingItem): Promise<RecordingItem[]> {
  const list = await getRecordings();
  const idx = list.findIndex((r) => r.id === item.id);
  const next = idx >= 0 ? list.map((r, i) => (i === idx ? item : r)) : [item, ...list];
  const capped = next.slice(0, 60);
  await chrome.storage.local.set({ [RECORDINGS_KEY]: capped });
  return capped;
}

export async function removeRecording(id: string): Promise<RecordingItem[]> {
  const list = await getRecordings();
  const next = list.filter((r) => r.id !== id);
  await chrome.storage.local.set({ [RECORDINGS_KEY]: next });
  return next;
}

export async function getDictationHistory(): Promise<DictationNote[]> {
  const data = await chrome.storage.local.get(DICTATION_HISTORY_KEY);
  const list = data[DICTATION_HISTORY_KEY];
  return Array.isArray(list) ? (list as DictationNote[]) : [];
}

export async function upsertDictationNote(note: DictationNote): Promise<DictationNote[]> {
  const list = await getDictationHistory();
  const idx = list.findIndex((n) => n.id === note.id);
  const next = idx >= 0 ? list.map((n, i) => (i === idx ? note : n)) : [note, ...list];
  const capped = next.slice(0, 30);
  await chrome.storage.local.set({ [DICTATION_HISTORY_KEY]: capped });
  return capped;
}

export async function removeDictationNote(id: string): Promise<DictationNote[]> {
  const list = await getDictationHistory();
  const next = list.filter((n) => n.id !== id);
  await chrome.storage.local.set({ [DICTATION_HISTORY_KEY]: next });
  return next;
}

export async function clearDictationHistory(): Promise<void> {
  await chrome.storage.local.set({ [DICTATION_HISTORY_KEY]: [] });
}

export async function getCachedModels(): Promise<Record<string, boolean>> {
  const data = await chrome.storage.local.get(CACHED_MODELS_KEY);
  const raw = data[CACHED_MODELS_KEY];
  return raw && typeof raw === "object" ? (raw as Record<string, boolean>) : {};
}

export async function markModelCached(modelKey: string): Promise<void> {
  const cur = await getCachedModels();
  if (cur[modelKey]) return;
  await chrome.storage.local.set({ [CACHED_MODELS_KEY]: { ...cur, [modelKey]: true } });
}

export async function getChatMessages(): Promise<PersistedChatMessage[]> {
  const data = await chrome.storage.local.get(CHAT_MESSAGES_KEY);
  const raw = data[CHAT_MESSAGES_KEY];
  return Array.isArray(raw) ? (raw as PersistedChatMessage[]) : [];
}

export async function saveChatMessages(msgs: PersistedChatMessage[]): Promise<void> {
  // Strip large base64 images beyond the last 4 messages to keep storage lean
  const trimmed = msgs.slice(-30).map((m, idx, arr) => {
    if (idx < arr.length - 4 && m.attachments?.length) {
      return {
        ...m,
        attachments: m.attachments.map((a) => ({ ...a, dataUrl: undefined })),
      };
    }
    return m;
  });
  await chrome.storage.local.set({ [CHAT_MESSAGES_KEY]: trimmed });
}

export async function clearChatMessages(): Promise<void> {
  await chrome.storage.local.set({ [CHAT_MESSAGES_KEY]: [] });
}

export interface StoredCustomVoice {
  name: string;
  sampleRate: number;
  pcm16Base64: string;
}

export async function saveCustomVoicePcm(pcm24k: Float32Array, name: string): Promise<void> {
  // Cap to 8 seconds @ 24kHz (192k samples = ~384KB int16)
  const maxSamples = 24000 * 8;
  const trimmed = pcm24k.length > maxSamples ? pcm24k.subarray(0, maxSamples) : pcm24k;
  const int16 = new Int16Array(trimmed.length);
  for (let i = 0; i < trimmed.length; i++) {
    const clamped = Math.max(-1, Math.min(1, trimmed[i]));
    int16[i] = clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);
  }
  const bytes = new Uint8Array(int16.buffer);
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  const payload: StoredCustomVoice = {
    name: name.trim() || "Mi voz",
    sampleRate: 24000,
    pcm16Base64: btoa(binary),
  };
  await chrome.storage.local.set({ [CUSTOM_VOICE_KEY]: payload });
}

export async function getCustomVoicePcm(): Promise<{
  name: string;
  sampleRate: number;
  pcm: Float32Array;
} | null> {
  const data = await chrome.storage.local.get(CUSTOM_VOICE_KEY);
  const raw = data[CUSTOM_VOICE_KEY] as StoredCustomVoice | undefined;
  if (!raw?.pcm16Base64) return null;
  const binary = atob(raw.pcm16Base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const int16 = new Int16Array(bytes.buffer);
  const pcm = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) pcm[i] = int16[i] / 32768;
  return { name: raw.name || "Mi voz", sampleRate: raw.sampleRate || 24000, pcm };
}

export async function clearCustomVoicePcm(): Promise<void> {
  await chrome.storage.local.remove(CUSTOM_VOICE_KEY);
}
