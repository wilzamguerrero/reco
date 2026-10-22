/**
 * Contratos IPC con el núcleo Rust.
 *
 * Este archivo es la proyección TypeScript de `ARCHITECTURE.md` §4.
 * Si cambia un contrato allí, se actualiza aquí en el mismo commit.
 */

// ---------------------------------------------------------------- dictado

export type DictationMode = "push_to_talk" | "toggle";

export type DictationState = "idle" | "listening" | "transcribing" | "inserting";

export interface DictationResult {
  text: string;
  language: string;
  durationMs: number;
  modelId: string;
  polishApplied: boolean;
}

export type InjectionTarget =
  | { kind: "focused_window" }
  | { kind: "clipboard_only" };

export interface InjectionReport {
  method: "paste" | "keystroke" | "clipboard";
  ok: boolean;
  reason?: string;
}

export interface ModelStatus {
  id: string;
  installed: boolean;
  sizeBytes: number;
}

// ---------------------------------------------------------------- grabación

export type RecordingTarget =
  | { kind: "screen"; id: string; name: string; width: number; height: number }
  | { kind: "window"; id: string; name: string; appName: string }
  | { kind: "region"; id: string };

/** Lo que el núcleo necesita para iniciar: solo el tipo y el id. */
export type RecordingTargetInput = { kind: "screen" | "window"; id: string };

export type VideoQuality = "low" | "medium" | "high";

export interface StartRecordingOptions {
  target: RecordingTargetInput;
  video: { fps: 15 | 30 | 60; quality: VideoQuality };
  microphone?: { deviceId: string; enabled: boolean };
  systemAudio: boolean;
  camera?: { deviceId: string; enabled: boolean };
  uploadImmediately: boolean;
  /** Dimensiones del destino; el núcleo las necesita para configurar el encoder. */
  width: number;
  height: number;
}

/** Respuesta de `recording_start`. */
export interface RecordingStartResult {
  sessionId: string;
  dir: string;
}

/** Respuesta de `recording_stop`. */
export interface RecordingStopResult {
  durationMs: number;
  bytes: number;
  fragments: number;
}

// ---------------------------------------------------------------- subida

export type UploadState =
  | "queued"
  | "uploading"
  | "retrying"
  | "completed"
  | "failed"
  | "canceled";

export interface UploadJob {
  id: string;
  recordingId: string;
  state: UploadState;
  bytesTotal: number;
  bytesSent: number;
  partsTotal: number;
  partsSent: number;
  attempts: number;
  lastError?: string;
  notionUploadId?: string;
}

export interface Recording {
  id: string;
  title: string;
  createdAt: string;
  durationMs: number;
  sizeBytes: number;
  localPath: string;
  thumbnailPath?: string;
  notionPageId?: string;
  notionFileUrl?: string;
  uploadState: UploadState;
}

// ---------------------------------------------------------------- config

export interface AppConfig {
  dictation: {
    enabled: boolean;
    shortcut: string;
    mode: DictationMode;
    language: string;
    modelId: string;
    polish: boolean;
    clipboard_only: boolean;
  };
  recording: {
    fps: number;
    quality: VideoQuality;
    system_audio: boolean;
    microphone_id: string | null;
    save_dir: string | null;
    delete_local_after_upload: boolean;
  };
  notion: {
    route: "proxy" | "direct";
    proxy_base_url: string | null;
    database_id: string | null;
    page_id: string | null;
  };
  system: {
    launch_at_login: boolean;
    close_to_tray: boolean;
    indicator_position: [number, number] | null;
  };
}

export type ConfigPatch = {
  [K in keyof AppConfig]?: AppConfig[K];
};

export interface SecretsStatus {
  notion_token: boolean;
  proxy_token: boolean;
}

// ---------------------------------------------------------------- diagnóstico

export interface Capabilities {
  screen_capture: boolean;
  system_audio: boolean;
  global_shortcuts: boolean;
  text_injection: boolean;
  secure_storage: boolean;
  local_transcription: boolean;
}

export interface DiagnosticsCheck {
  id: string;
  ok: boolean;
  detail: string;
  hint: string | null;
}

export interface Diagnostics {
  os: string;
  arch: string;
  version: string;
  data_dir: string;
  capabilities: Capabilities;
  checks: DiagnosticsCheck[];
}

// ---------------------------------------------------------------- eventos

export interface CoreEvents {
  "recording:tick": {
    sessionId: string;
    elapsedMs: number;
    bytesWritten: number;
    droppedFrames: number;
  };
  "recording:segment": {
    sessionId: string;
    index: number;
    bytes: number;
    uploaded: boolean;
  };
  "upload:progress": {
    jobId: string;
    bytesSent: number;
    bytesTotal: number;
    partsSent: number;
    partsTotal: number;
    rateBps: number;
  };
  "upload:state": { jobId: string; state: UploadState; error?: string };
  "dictation:state": { state: DictationState };
  "dictation:level": { rms: number };
  "dictation:result": { text: string; language: string | null };
  "models:state": {
    id: string;
    state: "downloading" | "installed" | "failed";
    error?: string;
  };
  "models:progress": {
    id: string;
    downloaded: number;
    total: number;
    percent: number;
  };
  "tray:action": { action: "record" | "stop" | "settings" | "library" | "quit" };
  "tray:navigate": { section: string };
  "app:error": { scope: string; message: string; recoverable: boolean };
}
