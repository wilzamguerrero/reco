import { useCallback, useEffect, useState } from "react";
import { DEFAULT_CONFIG, getConfig, getRecordings, patchConfig } from "../../shared/storage";
import type { AppConfig, ExtMessage, LiveState, RecordingItem } from "../../shared/types";

const INITIAL_LIVE: LiveState = {
  dictationPhase: "idle",
  dictationStartedAt: null,
  dictationInterim: "",
  dictationTranscript: "",
  dictationError: null,
  dictationLevel: 0,
  dictationHostTabId: null,
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

export function useRecoState() {
  const [live, setLive] = useState<LiveState>(INITIAL_LIVE);
  const [config, setConfig] = useState<AppConfig>(DEFAULT_CONFIG);
  const [recordings, setRecordings] = useState<RecordingItem[]>([]);

  useEffect(() => {
    void getConfig().then(setConfig);
    void getRecordings().then(setRecordings);
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
    };

    chrome.runtime.onMessage.addListener(onMsg);
    chrome.storage.onChanged.addListener(onStorage);
    return () => {
      chrome.runtime.onMessage.removeListener(onMsg);
      chrome.storage.onChanged.removeListener(onStorage);
    };
  }, []);

  const updateConfig = useCallback(async (patch: Partial<AppConfig>) => {
    const next = await patchConfig(patch);
    setConfig(next);
    void chrome.runtime.sendMessage({ type: "CONFIG_UPDATED", config: next } satisfies ExtMessage);
    return next;
  }, []);

  const send = useCallback((msg: ExtMessage) => {
    return chrome.runtime.sendMessage(msg).catch(() => undefined);
  }, []);

  return {
    live,
    config,
    recordings,
    setRecordings,
    updateConfig,
    send,
  };
}
