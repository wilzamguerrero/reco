import { useCallback, useEffect, useState } from "react";
import {
  clearDictationHistory,
  DEFAULT_CONFIG,
  getConfig,
  getDictationHistory,
  getRecordings,
  patchConfig,
  removeDictationNote,
} from "../../shared/storage";
import type {
  AppConfig,
  DictationNote,
  ExtMessage,
  LiveState,
  RecordingItem,
} from "../../shared/types";

export interface ShortcutMap {
  dictate: string;
  aiVoice: string;
  record: string;
  pause: string;
}

const INITIAL_SHORTCUTS: ShortcutMap = {
  dictate: "Alt+Shift+D",
  aiVoice: "Alt+Shift+A",
  record: "Alt+Shift+R",
  pause: "Alt+Shift+P",
};

const INITIAL_LIVE: LiveState = {
  dictationPhase: "idle",
  dictationStartedAt: null,
  dictationInterim: "",
  dictationTranscript: "",
  dictationStatus: null,
  dictationError: null,
  dictationLevel: 0,
  dictationHostTabId: null,
  nativeHostConnected: false,
  aiVoicePhase: "idle",
  aiVoiceLevel: 0,
  aiVoiceStatus: null,
  recordingPhase: "idle",
  recordingId: null,
  recordingStartedAt: null,
  recordingElapsedMs: 0,
  recordingLevel: 0,
  recordingBytes: 0,
  recordingChaptersUploaded: 0,
  recordingError: null,
  uploadActiveId: null,
  uploadProgress: 0,
  uploadStep: "",
  lastNotionUrl: null,
};

async function readChromeShortcuts(): Promise<ShortcutMap> {
  try {
    const cmds = await chrome.commands.getAll();
    const find = (name: string) => cmds.find((c) => c.name === name)?.shortcut ?? "";
    return {
      dictate: find("toggle-dictation"),
      aiVoice: find("toggle-ai-voice"),
      record: find("toggle-recording"),
      pause: find("pause-recording"),
    };
  } catch {
    return INITIAL_SHORTCUTS;
  }
}

export function useRecoState() {
  const [live, setLive] = useState<LiveState>(INITIAL_LIVE);
  const [config, setConfig] = useState<AppConfig>(DEFAULT_CONFIG);
  const [recordings, setRecordings] = useState<RecordingItem[]>([]);
  const [dictationHistory, setDictationHistory] = useState<DictationNote[]>([]);
  const [shortcuts, setShortcuts] = useState<ShortcutMap>(INITIAL_SHORTCUTS);

  useEffect(() => {
    void getConfig().then(setConfig);
    void getRecordings().then(setRecordings);
    void getDictationHistory().then(setDictationHistory);
    void readChromeShortcuts().then(setShortcuts);

    void chrome.runtime
      .sendMessage({ type: "GET_STATE" } satisfies ExtMessage)
      .then((res) => {
        if (res) setLive(res as LiveState);
      })
      .catch(() => {});

    const onMsg = (msg: ExtMessage) => {
      if (msg.type === "STATE_SYNC") {
        setLive(msg.state);
      }
    };

    const onStorage = (changes: Record<string, chrome.storage.StorageChange>) => {
      if (changes.reco_ext_config_v1) {
        void getConfig().then(setConfig);
      }
      if (changes.reco_ext_recordings_v1) {
        void getRecordings().then(setRecordings);
      }
      if (changes.reco_ext_dictation_history_v1) {
        void getDictationHistory().then(setDictationHistory);
      }
    };

    const onFocus = () => {
      void readChromeShortcuts().then(setShortcuts);
    };

    chrome.runtime.onMessage.addListener(onMsg);
    chrome.storage.onChanged.addListener(onStorage);
    window.addEventListener("focus", onFocus);
    return () => {
      chrome.runtime.onMessage.removeListener(onMsg);
      chrome.storage.onChanged.removeListener(onStorage);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  const updateConfig = useCallback(async (patch: Partial<AppConfig>) => {
    const next = await patchConfig(patch);
    setConfig(next);
    void chrome.runtime.sendMessage({ type: "CONFIG_UPDATED", config: next } satisfies ExtMessage);
    return next;
  }, []);

  const deleteDictationNote = useCallback(async (id: string) => {
    const next = await removeDictationNote(id);
    setDictationHistory(next);
  }, []);

  const clearHistory = useCallback(async () => {
    await clearDictationHistory();
    setDictationHistory([]);
  }, []);

  const send = useCallback((msg: ExtMessage) => {
    return chrome.runtime.sendMessage(msg).catch(() => undefined);
  }, []);

  return {
    live,
    config,
    recordings,
    setRecordings,
    dictationHistory,
    deleteDictationNote,
    clearHistory,
    shortcuts,
    updateConfig,
    send,
  };
}
