import type { AppConfig, DictationNote, RecordingItem } from "./types";

const CONFIG_KEY = "reco_ext_config_v1";
const RECORDINGS_KEY = "reco_ext_recordings_v1";
const DICTATION_HISTORY_KEY = "reco_ext_dictation_history_v1";

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
  orbPosition: null,
};

function mergeConfig(raw: Partial<AppConfig> | undefined): AppConfig {
  return {
    dictation: { ...DEFAULT_CONFIG.dictation, ...(raw?.dictation ?? {}) },
    recording: { ...DEFAULT_CONFIG.recording, ...(raw?.recording ?? {}) },
    notion: { ...DEFAULT_CONFIG.notion, ...(raw?.notion ?? {}) },
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
