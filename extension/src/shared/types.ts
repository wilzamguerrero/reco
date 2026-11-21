export type DictationPhase = "idle" | "listening" | "inserting" | "error";

export type RecordingPhase = "idle" | "recording" | "paused" | "uploading";

export type VideoQuality = "low" | "medium" | "high";

export type UploadStrategy = "immediate_single" | "live_chapters";

export type NotionAuthMode = "oauth_broker" | "oauth_direct" | "token" | "envi_proxy";

export type NotionWriteMode = "toggle_block" | "child_page";

export interface NotionPageItem {
  id: string;
  title: string;
  url: string;
  icon?: string;
  lastEdited?: string;
}

export interface NotionConfig {
  authMode: NotionAuthMode;
  token: string;
  workspaceName: string;
  botId: string;
  /** OAuth broker endpoint (estilo iii /api/notion-oauth) */
  oauthBrokerUrl: string;
  /** OAuth directo para pruebas locales */
  oauthClientId: string;
  oauthClientSecret: string;
  /** URL base del proxy envi (opcional) */
  enviProxyUrl: string;
  /** Página seleccionada en Notion donde guardar grabaciones */
  targetPageId: string;
  targetPageTitle: string;
  targetPageUrl: string;
  writeMode: NotionWriteMode;
}

export interface DictationConfig {
  language: string;
  polish: boolean;
  smartSpacing: boolean;
  autoCapitalize: boolean;
  showFloatingOrb: boolean;
}

export interface RecordingConfig {
  quality: VideoQuality;
  fps: 15 | 30 | 60;
  includeMic: boolean;
  systemAudio: boolean;
  uploadStrategy: UploadStrategy;
  chapterSeconds: number;
  keepLocalCopy: boolean;
}

export interface OrbPosition {
  x: number;
  y: number;
}

export interface AppConfig {
  dictation: DictationConfig;
  recording: RecordingConfig;
  notion: NotionConfig;
  orbPosition: OrbPosition | null;
}

export type UploadJobState =
  | "queued"
  | "uploading"
  | "completed"
  | "failed"
  | "canceled";

export interface RecordingItem {
  id: string;
  title: string;
  createdAt: string;
  durationMs: number;
  sizeBytes: number;
  mimeType: string;
  opfsFileName?: string;
  uploadState: UploadJobState;
  uploadProgress: number;
  uploadStep: string;
  notionPageId?: string;
  notionPageUrl?: string;
  notionBlockId?: string;
  chaptersUploaded?: number;
  error?: string;
}

export interface LiveState {
  dictationPhase: DictationPhase;
  dictationStartedAt: number | null;
  dictationInterim: string;
  dictationTranscript: string;
  dictationError: string | null;
  dictationLevel: number;
  dictationHostTabId: number | null;

  recordingPhase: RecordingPhase;
  recordingId: string | null;
  recordingStartedAt: number | null;
  recordingElapsedMs: number;
  recordingLevel: number;
  recordingBytes: number;
  recordingChaptersUploaded: number;
  recordingError: string | null;

  uploadActiveId: string | null;
  uploadProgress: number;
  uploadStep: string;
  lastNotionUrl: string | null;
}

/** Mensajes intercambiados entre Service Worker, Offscreen, Bridge, Content y UI. */
export type ExtMessage =
  | { type: "GET_STATE" }
  | { type: "STATE_SYNC"; state: LiveState }
  | { type: "CONFIG_UPDATED"; config: AppConfig }
  | { type: "DICTATION_TOGGLE"; targetTabId?: number }
  | { type: "DICTATION_START"; targetTabId?: number }
  | { type: "DICTATION_STOP" }
  | { type: "DICTATION_BRIDGE_READY"; tabId?: number }
  | { type: "DICTATION_INTERIM"; text: string }
  | { type: "DICTATION_FINAL"; text: string }
  | { type: "DICTATION_LEVEL"; rms: number }
  | { type: "DICTATION_ERROR"; message: string; fatal?: boolean }
  | { type: "DICTATION_ENDED"; reason?: string }
  | { type: "INJECT_TEXT"; text: string; smartSpacing: boolean }
  | { type: "INJECT_INTERIM"; text: string }
  | { type: "RECORDING_START" }
  | { type: "RECORDING_PAUSE_TOGGLE" }
  | { type: "RECORDING_STOP" }
  | { type: "RECORDING_DISCARD" }
  | { type: "RECORDING_RETRY_UPLOAD"; recordingId: string }
  | {
      type: "OFFSCREEN_START_RECORDING";
      recordingId: string;
      streamId: string;
      canRequestAudio: boolean;
      config: AppConfig;
      title: string;
    }
  | { type: "OFFSCREEN_PAUSE_TOGGLE" }
  | { type: "OFFSCREEN_STOP_RECORDING" }
  | { type: "OFFSCREEN_DISCARD_RECORDING" }
  | { type: "OFFSCREEN_RETRY_UPLOAD"; recording: RecordingItem; config: AppConfig }
  | { type: "OFFSCREEN_RECORDING_TICK"; elapsedMs: number; bytes: number; rms: number }
  | { type: "OFFSCREEN_RECORDING_PAUSED"; paused: boolean }
  | { type: "OFFSCREEN_CHAPTER_UPLOADED"; recordingId: string; chaptersUploaded: number; bytes: number }
  | { type: "OFFSCREEN_UPLOAD_PROGRESS"; recordingId: string; progress: number; step: string }
  | {
      type: "OFFSCREEN_RECORDING_DONE";
      recording: RecordingItem;
    }
  | { type: "OFFSCREEN_RECORDING_ERROR"; recordingId: string; message: string }
  | { type: "OPEN_PERMISSIONS"; afterAction?: "dictation" | "recording" }
  | { type: "OPEN_SIDEPANEL" }
  | { type: "PERMISSIONS_GRANTED"; afterAction?: "dictation" | "recording" };
