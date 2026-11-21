/**
 * Offscreen Document de RECO:
 * - Captura pantalla/ventana/pestaña + audio del sistema + micrófono mezclado.
 * - Escribe fragmentos en OPFS mientras graba para no saturar RAM.
 * - Soporta dos estrategias:
 *     1) `immediate_single`: 1 archivo WebM continuo en OPFS -> al parar sube
 *        inmediatamente en paralelo con semáforo AIMD a Notion.
 *     2) `live_chapters`: cada N segundos cierra un capítulo WebM reproducible
 *        y lo sube A NOTION MIENTRAS SIGUES GRABANDO (estilo Loom).
 */

import { attachRecordingToNotionPage, type UploadedVideoPart } from "../shared/notionClient";
import { uploadBlobToNotion, type UploadTarget } from "../shared/notionUploader";
import { createOpfsWriter, readOpfsFile } from "../shared/opfs";
import type { AppConfig, ExtMessage, RecordingItem } from "../shared/types";

interface ActiveSession {
  recordingId: string;
  title: string;
  config: AppConfig;
  startedAt: number;
  pausedMs: number;
  pauseBeganAt: number | null;
  paused: boolean;
  discarded: boolean;
  mimeType: string;
  opfsFileName: string;

  desktopStream: MediaStream;
  micStream: MediaStream | null;
  mixedStream: MediaStream;
  audioCtx: AudioContext | null;
  analyser: AnalyserNode | null;

  recorder: MediaRecorder | null;
  tickTimer: number | null;
  chapterTimer: number | null;
  bytesWritten: number;

  // Single-file OPFS writer
  opfsWriter: Awaited<ReturnType<typeof createOpfsWriter>> | null;

  // Live-chapters state
  chapterIndex: number;
  chapterChunks: Blob[];
  chapterBytes: number;
  chapterUploadPromises: Promise<UploadedVideoPart>[];
  chaptersUploaded: number;
  totalBytesAllChapters: number;
}

let session: ActiveSession | null = null;

function pickMimeType(): string {
  const candidates = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm;codecs=h264,opus",
    "video/webm",
  ];
  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported(c)) return c;
  }
  return "video/webm";
}

function bitratesForQuality(q: AppConfig["recording"]["quality"]): {
  videoBitsPerSecond: number;
  audioBitsPerSecond: number;
  maxWidth: number;
  maxHeight: number;
} {
  switch (q) {
    case "low":
      return {
        videoBitsPerSecond: 1_200_000,
        audioBitsPerSecond: 96_000,
        maxWidth: 1280,
        maxHeight: 720,
      };
    case "high":
      return {
        videoBitsPerSecond: 5_000_000,
        audioBitsPerSecond: 160_000,
        maxWidth: 2560,
        maxHeight: 1440,
      };
    default:
      return {
        videoBitsPerSecond: 2_600_000,
        audioBitsPerSecond: 128_000,
        maxWidth: 1920,
        maxHeight: 1080,
      };
  }
}

function resolveUploadTarget(config: AppConfig): UploadTarget | null {
  if (config.notion.authMode === "envi_proxy" && config.notion.enviProxyUrl.trim()) {
    return { mode: "envi_proxy", enviProxyUrl: config.notion.enviProxyUrl.trim() };
  }
  if (config.notion.token.trim()) {
    return { mode: "direct", token: config.notion.token.trim() };
  }
  return null;
}

function sendMsg(msg: ExtMessage) {
  void chrome.runtime.sendMessage(msg).catch(() => {});
}

function elapsedMsOf(s: ActiveSession): number {
  const now = s.paused && s.pauseBeganAt ? s.pauseBeganAt : Date.now();
  return Math.max(0, now - s.startedAt - s.pausedMs);
}

function readRms(analyser: AnalyserNode | null): number {
  if (!analyser) return 0;
  const buf = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i += 1) sum += buf[i] * buf[i];
  return Math.sqrt(sum / buf.length);
}

function cleanupStreams(s: ActiveSession) {
  if (s.tickTimer !== null) clearInterval(s.tickTimer);
  if (s.chapterTimer !== null) clearInterval(s.chapterTimer);
  s.desktopStream.getTracks().forEach((t) => t.stop());
  s.micStream?.getTracks().forEach((t) => t.stop());
  if (s.audioCtx) {
    void s.audioCtx.close().catch(() => {});
  }
}

function startChapterRecorder(s: ActiveSession) {
  const { videoBitsPerSecond, audioBitsPerSecond } = bitratesForQuality(s.config.recording.quality);
  const recorder = new MediaRecorder(s.mixedStream, {
    mimeType: s.mimeType,
    videoBitsPerSecond,
    audioBitsPerSecond,
  });

  s.chapterChunks = [];
  s.chapterBytes = 0;

  recorder.ondataavailable = (ev) => {
    if (!ev.data || ev.data.size === 0) return;
    if (s.config.recording.uploadStrategy === "live_chapters") {
      s.chapterChunks.push(ev.data);
      s.chapterBytes += ev.data.size;
      s.totalBytesAllChapters += ev.data.size;
    } else if (s.opfsWriter) {
      s.bytesWritten += ev.data.size;
      void s.opfsWriter.write(ev.data);
    }
  };

  s.recorder = recorder;
  recorder.start(1500);
}

function flushChapterUpload(s: ActiveSession, chapterIdx: number, chunks: Blob[], sizeBytes: number) {
  const target = resolveUploadTarget(s.config);
  if (!target || chunks.length === 0) return;

  const blob = new Blob(chunks, { type: s.mimeType });
  const filename = `${s.recordingId}-parte-${chapterIdx}.webm`;

  const promise = uploadBlobToNotion(blob, filename, target, {
    onProgress(progress, step) {
      sendMsg({
        type: "OFFSCREEN_UPLOAD_PROGRESS",
        recordingId: s.recordingId,
        progress,
        step: `Cap. ${chapterIdx}: ${step}`,
      });
    },
  }).then((res) => {
    s.chaptersUploaded += 1;
    sendMsg({
      type: "OFFSCREEN_CHAPTER_UPLOADED",
      recordingId: s.recordingId,
      chaptersUploaded: s.chaptersUploaded,
      bytes: sizeBytes,
    });
    return {
      uploadId: res.uploadId,
      name: filename,
      sizeBytes: res.sizeBytes,
      mimeType: res.mimeType,
      label: `Capítulo ${chapterIdx}`,
    } satisfies UploadedVideoPart;
  });

  s.chapterUploadPromises.push(promise);
}

async function rotateChapter(s: ActiveSession) {
  if (!s.recorder || s.recorder.state === "inactive" || s.paused) return;
  const currentRec = s.recorder;
  const idx = s.chapterIndex;
  s.chapterIndex += 1;

  await new Promise<void>((resolve) => {
    currentRec.onstop = () => resolve();
    currentRec.stop();
  });

  const chunks = s.chapterChunks;
  const sizeBytes = s.chapterBytes;
  startChapterRecorder(s);
  flushChapterUpload(s, idx, chunks, sizeBytes);
}

async function startRecording(msg: Extract<ExtMessage, { type: "OFFSCREEN_START_RECORDING" }>) {
  if (session) return;

  const { recordingId, streamId, canRequestAudio, config, title } = msg;
  const q = bitratesForQuality(config.recording.quality);

  try {
    const desktopConstraints: MediaStreamConstraints = {
      video: {
        mandatory: {
          chromeMediaSource: "desktop",
          chromeMediaSourceId: streamId,
          maxWidth: q.maxWidth,
          maxHeight: q.maxHeight,
          maxFrameRate: config.recording.fps,
        },
      } as unknown as MediaTrackConstraints,
      audio:
        canRequestAudio && config.recording.systemAudio
          ? ({
              mandatory: {
                chromeMediaSource: "desktop",
                chromeMediaSourceId: streamId,
              },
            } as unknown as MediaTrackConstraints)
          : false,
    };

    const desktopStream = await navigator.mediaDevices.getUserMedia(desktopConstraints);

    let micStream: MediaStream | null = null;
    if (config.recording.includeMic) {
      try {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        micStream = null;
      }
    }

    // Mezclar audio del sistema + micrófono si alguno existe
    const mixedStream = new MediaStream();
    desktopStream.getVideoTracks().forEach((t) => mixedStream.addTrack(t));

    let audioCtx: AudioContext | null = null;
    let analyser: AnalyserNode | null = null;

    const hasDesktopAudio = desktopStream.getAudioTracks().length > 0;
    const hasMicAudio = (micStream?.getAudioTracks().length ?? 0) > 0;

    if (hasDesktopAudio || hasMicAudio) {
      audioCtx = new AudioContext();
      const dest = audioCtx.createMediaStreamDestination();
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;

      if (hasDesktopAudio) {
        const sysSrc = audioCtx.createMediaStreamSource(
          new MediaStream(desktopStream.getAudioTracks()),
        );
        sysSrc.connect(dest);
        sysSrc.connect(analyser);
      }
      if (hasMicAudio && micStream) {
        const micSrc = audioCtx.createMediaStreamSource(micStream);
        micSrc.connect(dest);
        micSrc.connect(analyser);
      }

      dest.stream.getAudioTracks().forEach((t) => mixedStream.addTrack(t));
    }

    const mimeType = pickMimeType();
    const opfsFileName = `${recordingId}.webm`;
    const opfsWriter =
      config.recording.uploadStrategy === "immediate_single"
        ? await createOpfsWriter(opfsFileName)
        : null;

    const s: ActiveSession = {
      recordingId,
      title,
      config,
      startedAt: Date.now(),
      pausedMs: 0,
      pauseBeganAt: null,
      paused: false,
      discarded: false,
      mimeType,
      opfsFileName,
      desktopStream,
      micStream,
      mixedStream,
      audioCtx,
      analyser,
      recorder: null,
      tickTimer: null,
      chapterTimer: null,
      bytesWritten: 0,
      opfsWriter,
      chapterIndex: 1,
      chapterChunks: [],
      chapterBytes: 0,
      chapterUploadPromises: [],
      chaptersUploaded: 0,
      totalBytesAllChapters: 0,
    };

    session = s;

    // Si el usuario detiene el compartir pantalla desde la barra nativa de Chrome
    const videoTrack = desktopStream.getVideoTracks()[0];
    if (videoTrack) {
      videoTrack.onended = () => {
        if (session === s) void stopRecording();
      };
    }

    startChapterRecorder(s);

    s.tickTimer = window.setInterval(() => {
      if (session !== s) return;
      sendMsg({
        type: "OFFSCREEN_RECORDING_TICK",
        elapsedMs: elapsedMsOf(s),
        bytes:
          s.config.recording.uploadStrategy === "live_chapters"
            ? s.totalBytesAllChapters
            : s.bytesWritten,
        rms: s.paused ? 0 : readRms(s.analyser),
      });
    }, 150);

    if (config.recording.uploadStrategy === "live_chapters") {
      const intervalMs = Math.max(20, config.recording.chapterSeconds || 45) * 1000;
      s.chapterTimer = window.setInterval(() => {
        if (session === s && !s.paused) {
          void rotateChapter(s);
        }
      }, intervalMs);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendMsg({ type: "OFFSCREEN_RECORDING_ERROR", recordingId, message });
    session = null;
  }
}

async function stopRecording() {
  const s = session;
  if (!s) return;
  session = null;

  const durationMs = elapsedMsOf(s);

  if (s.recorder && s.recorder.state !== "inactive") {
    await new Promise<void>((resolve) => {
      s.recorder!.onstop = () => resolve();
      s.recorder!.stop();
    });
  }

  cleanupStreams(s);

  if (s.discarded) {
    await s.opfsWriter?.abort();
    return;
  }

  const target = resolveUploadTarget(s.config);
  const canAttachToNotion = Boolean(
    s.config.notion.token.trim() && s.config.notion.targetPageId.trim(),
  );

  // Modo live_chapters: terminar el último capítulo y adjuntar todos los capítulos a Notion
  if (s.config.recording.uploadStrategy === "live_chapters") {
    flushChapterUpload(s, s.chapterIndex, s.chapterChunks, s.chapterBytes);
    const totalBytes = s.totalBytesAllChapters;

    let item: RecordingItem = {
      id: s.recordingId,
      title: s.title,
      createdAt: new Date(s.startedAt).toISOString(),
      durationMs,
      sizeBytes: totalBytes,
      mimeType: s.mimeType,
      uploadState: target ? "uploading" : "failed",
      uploadProgress: target ? 80 : 0,
      uploadStep: target ? "Finalizando capítulos en Notion…" : "Notion no conectado",
      chaptersUploaded: s.chaptersUploaded,
    };

    if (!target) {
      sendMsg({ type: "OFFSCREEN_RECORDING_DONE", recording: item });
      return;
    }

    try {
      const parts = await Promise.all(s.chapterUploadPromises);
      if (canAttachToNotion && parts.length > 0) {
        sendMsg({
          type: "OFFSCREEN_UPLOAD_PROGRESS",
          recordingId: s.recordingId,
          progress: 96,
          step: "Adjuntando grabación en la página de Notion…",
        });
        const attached = await attachRecordingToNotionPage({
          token: s.config.notion.token.trim(),
          targetPageId: s.config.notion.targetPageId,
          writeMode: s.config.notion.writeMode,
          title: s.title,
          createdAtIso: item.createdAt,
          durationMs,
          sizeBytes: totalBytes,
          parts,
        });
        item = {
          ...item,
          uploadState: "completed",
          uploadProgress: 100,
          uploadStep: "Publicado en Notion",
          notionPageId: attached.pageId,
          notionPageUrl: attached.pageUrl,
          notionBlockId: attached.blockId,
          chaptersUploaded: parts.length,
        };
      } else {
        item = {
          ...item,
          uploadState: "completed",
          uploadProgress: 100,
          uploadStep: "Subido a Notion (sin página seleccionada)",
          chaptersUploaded: parts.length,
        };
      }
    } catch (err) {
      item = {
        ...item,
        uploadState: "failed",
        uploadStep: "Error al subir capítulos",
        error: err instanceof Error ? err.message : String(err),
      };
    }

    sendMsg({ type: "OFFSCREEN_RECORDING_DONE", recording: item });
    return;
  }

  // Modo immediate_single: cerrar OPFS y lanzar subida paralela AIMD de inmediato
  const sizeBytes = (await s.opfsWriter?.close()) ?? s.bytesWritten;
  let item: RecordingItem = {
    id: s.recordingId,
    title: s.title,
    createdAt: new Date(s.startedAt).toISOString(),
    durationMs,
    sizeBytes,
    mimeType: s.mimeType,
    opfsFileName: s.opfsFileName,
    uploadState: target ? "uploading" : "failed",
    uploadProgress: 0,
    uploadStep: target ? "Iniciando subida a Notion…" : "Configura Notion para subir",
  };

  if (!target) {
    item.error = "Notion no está conectado todavía. Puedes reintentar desde Biblioteca.";
    sendMsg({ type: "OFFSCREEN_RECORDING_DONE", recording: item });
    return;
  }

  try {
    const file = await readOpfsFile(s.opfsFileName);
    if (!file) throw new Error("No se pudo leer el archivo grabado en OPFS.");

    const uploaded = await uploadBlobToNotion(file, `${s.recordingId}.webm`, target, {
      onProgress(progress, step) {
        sendMsg({
          type: "OFFSCREEN_UPLOAD_PROGRESS",
          recordingId: s.recordingId,
          progress,
          step,
        });
      },
    });

    if (canAttachToNotion) {
      sendMsg({
        type: "OFFSCREEN_UPLOAD_PROGRESS",
        recordingId: s.recordingId,
        progress: 98,
        step: "Creando bloque de video en Notion…",
      });
      const attached = await attachRecordingToNotionPage({
        token: s.config.notion.token.trim(),
        targetPageId: s.config.notion.targetPageId,
        writeMode: s.config.notion.writeMode,
        title: s.title,
        createdAtIso: item.createdAt,
        durationMs,
        sizeBytes,
        parts: [
          {
            uploadId: uploaded.uploadId,
            name: `${s.title}.webm`,
            sizeBytes: uploaded.sizeBytes,
            mimeType: uploaded.mimeType,
          },
        ],
      });
      item = {
        ...item,
        uploadState: "completed",
        uploadProgress: 100,
        uploadStep: "Publicado en Notion",
        notionPageId: attached.pageId,
        notionPageUrl: attached.pageUrl,
        notionBlockId: attached.blockId,
      };
    } else {
      item = {
        ...item,
        uploadState: "completed",
        uploadProgress: 100,
        uploadStep: "Subido a Notion (elige una página en Ajustes)",
      };
    }
  } catch (err) {
    item = {
      ...item,
      uploadState: "failed",
      uploadStep: "Error al subir",
      error: err instanceof Error ? err.message : String(err),
    };
  }

  sendMsg({ type: "OFFSCREEN_RECORDING_DONE", recording: item });
}

async function retryUpload(recording: RecordingItem, config: AppConfig) {
  const target = resolveUploadTarget(config);
  if (!target) {
    sendMsg({
      type: "OFFSCREEN_RECORDING_DONE",
      recording: {
        ...recording,
        uploadState: "failed",
        uploadStep: "Conecta Notion primero",
        error: "Falta configurar Notion en Ajustes.",
      },
    });
    return;
  }

  if (!recording.opfsFileName) {
    sendMsg({
      type: "OFFSCREEN_RECORDING_DONE",
      recording: {
        ...recording,
        uploadState: "failed",
        uploadStep: "Sin archivo local",
        error: "Esta grabación no tiene archivo local en OPFS para reintentar.",
      },
    });
    return;
  }

  try {
    const file = await readOpfsFile(recording.opfsFileName);
    if (!file) throw new Error("El archivo local ya no existe en OPFS.");

    const uploaded = await uploadBlobToNotion(file, `${recording.id}.webm`, target, {
      onProgress(progress, step) {
        sendMsg({
          type: "OFFSCREEN_UPLOAD_PROGRESS",
          recordingId: recording.id,
          progress,
          step,
        });
      },
    });

    if (config.notion.token.trim() && config.notion.targetPageId.trim()) {
      const attached = await attachRecordingToNotionPage({
        token: config.notion.token.trim(),
        targetPageId: config.notion.targetPageId,
        writeMode: config.notion.writeMode,
        title: recording.title,
        createdAtIso: recording.createdAt,
        durationMs: recording.durationMs,
        sizeBytes: recording.sizeBytes,
        parts: [
          {
            uploadId: uploaded.uploadId,
            name: `${recording.title}.webm`,
            sizeBytes: uploaded.sizeBytes,
            mimeType: uploaded.mimeType,
          },
        ],
      });
      sendMsg({
        type: "OFFSCREEN_RECORDING_DONE",
        recording: {
          ...recording,
          uploadState: "completed",
          uploadProgress: 100,
          uploadStep: "Publicado en Notion",
          notionPageId: attached.pageId,
          notionPageUrl: attached.pageUrl,
          notionBlockId: attached.blockId,
          error: undefined,
        },
      });
    } else {
      sendMsg({
        type: "OFFSCREEN_RECORDING_DONE",
        recording: {
          ...recording,
          uploadState: "completed",
          uploadProgress: 100,
          uploadStep: "Archivo subido a Notion",
          error: undefined,
        },
      });
    }
  } catch (err) {
    sendMsg({
      type: "OFFSCREEN_RECORDING_DONE",
      recording: {
        ...recording,
        uploadState: "failed",
        uploadStep: "Error al reintentar",
        error: err instanceof Error ? err.message : String(err),
      },
    });
  }
}

chrome.runtime.onMessage.addListener((msg: ExtMessage) => {
  if (msg.type === "OFFSCREEN_START_RECORDING") {
    void startRecording(msg);
  } else if (msg.type === "OFFSCREEN_PAUSE_TOGGLE") {
    if (!session || !session.recorder) return;
    if (session.paused) {
      session.paused = false;
      if (session.pauseBeganAt) {
        session.pausedMs += Date.now() - session.pauseBeganAt;
        session.pauseBeganAt = null;
      }
      if (session.recorder.state === "paused") session.recorder.resume();
    } else {
      session.paused = true;
      session.pauseBeganAt = Date.now();
      if (session.recorder.state === "recording") session.recorder.pause();
    }
    sendMsg({ type: "OFFSCREEN_RECORDING_PAUSED", paused: session.paused });
  } else if (msg.type === "OFFSCREEN_STOP_RECORDING") {
    void stopRecording();
  } else if (msg.type === "OFFSCREEN_DISCARD_RECORDING") {
    if (session) {
      session.discarded = true;
      void stopRecording();
    }
  } else if (msg.type === "OFFSCREEN_RETRY_UPLOAD") {
    void retryUpload(msg.recording, msg.config);
  }
});
