/**
 * Motor de subida de video a Notion con semáforo adaptativo AIMD.
 *
 * Portado de `reco/references/envi/src/uploadService.ts` y `iii/src/core/notion/upload.ts`:
 * - `single_part` para archivos <= 20 MiB.
 * - `multi_part` con chunks de 10 MiB para archivos > 20 MiB (hasta 5 GiB).
 * - Semáforo AIMD (`start=6, min=2, max=12`) con enfriamiento de 1500 ms ante 429/503.
 * - Soporta subida directa a `api.notion.com/v1/file_uploads` (gracias a permisos de
 *   extensión MV3) y también subida vía proxy `envi` (`/api/upload-*`).
 */

import { NOTION_API_BASE, NOTION_VERSION } from "./notionClient";

const CHUNK_SIZE = 10 * 1024 * 1024; // 10 MiB (coincide con envi/upload-init.ts)
const MULTI_PART_THRESHOLD = 20 * 1024 * 1024; // 20 MiB
const MAX_FILE_SIZE = 5 * 1024 * 1024 * 1024; // 5 GiB

const START_CONCURRENCY = 6;
const MIN_CONCURRENCY = 2;
const MAX_CONCURRENCY = 12;
const THROTTLE_COOLDOWN_MS = 1500;
const MAX_PART_RETRIES = 6;

type Outcome = "ok" | "throttle" | "error";

const isThrottleStatus = (status: number): boolean => status === 429 || status === 503;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class AdaptiveSemaphore {
  private active = 0;
  private limit: number;
  private queue: Array<() => void> = [];
  private successCredits = 0;
  private cooldownUntil = 0;

  constructor(
    start = START_CONCURRENCY,
    private readonly min = MIN_CONCURRENCY,
    private readonly max = MAX_CONCURRENCY,
  ) {
    this.limit = start;
  }

  async acquire(): Promise<(outcome?: Outcome) => void> {
    if (this.active < this.limit) {
      this.active += 1;
      return this.makeRelease();
    }
    return new Promise((resolve) => {
      this.queue.push(() => {
        this.active += 1;
        resolve(this.makeRelease());
      });
    });
  }

  private makeRelease(): (outcome?: Outcome) => void {
    let released = false;
    return (outcome: Outcome = "ok") => {
      if (released) return;
      released = true;
      this.adjust(outcome);
      this.active -= 1;
      this.pump();
    };
  }

  private adjust(outcome: Outcome): void {
    const now = Date.now();
    if (outcome === "throttle") {
      this.limit = Math.max(this.min, Math.floor(this.limit / 2));
      this.successCredits = 0;
      this.cooldownUntil = now + THROTTLE_COOLDOWN_MS;
    } else if (outcome === "ok") {
      if (now < this.cooldownUntil) return;
      this.successCredits += 1;
      if (this.successCredits >= this.limit) {
        this.successCredits = 0;
        this.limit = Math.min(this.max, this.limit + 1);
      }
    }
  }

  private pump(): void {
    while (this.active < this.limit && this.queue.length > 0) {
      const next = this.queue.shift();
      if (next) next();
    }
  }
}

export interface UploadTarget {
  mode: "direct" | "envi_proxy";
  token?: string;
  enviProxyUrl?: string;
}

export interface UploadProgressCallbacks {
  onProgress?: (percent: number, step: string) => void;
}

function normalizeMime(mimeType: string, filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".mp4")) return "video/mp4";
  if (lower.endsWith(".webm")) return "video/webm";
  // Notion espera `video/webm` sin sufijo `;codecs=vp9,opus`
  const base = mimeType.split(";")[0]?.trim();
  return base || "video/webm";
}

export async function uploadBlobToNotion(
  blob: Blob,
  filename: string,
  target: UploadTarget,
  callbacks: UploadProgressCallbacks = {},
): Promise<{ uploadId: string; sizeBytes: number; mimeType: string }> {
  if (blob.size === 0) throw new Error("El archivo de video está vacío.");
  if (blob.size > MAX_FILE_SIZE) throw new Error("El video excede el límite de 5 GB de Notion.");

  const contentType = normalizeMime(blob.type, filename);
  const sem = new AdaptiveSemaphore();

  if (target.mode === "envi_proxy") {
    const proxyBase = (target.enviProxyUrl || "").trim().replace(/\/+$/, "");
    if (!proxyBase) throw new Error("Falta la URL del proxy envi.");
    return uploadViaEnviProxy(blob, filename, contentType, proxyBase, sem, callbacks);
  }

  const token = (target.token || "").trim();
  if (!token) throw new Error("Conecta Notion antes de subir grabaciones.");
  return uploadDirectToNotion(blob, filename, contentType, token, sem, callbacks);
}

async function uploadDirectToNotion(
  blob: Blob,
  filename: string,
  contentType: string,
  token: string,
  sem: AdaptiveSemaphore,
  callbacks: UploadProgressCallbacks,
): Promise<{ uploadId: string; sizeBytes: number; mimeType: string }> {
  const isMultiPart = blob.size > MULTI_PART_THRESHOLD;
  const numberOfParts = isMultiPart ? Math.ceil(blob.size / CHUNK_SIZE) : 1;

  callbacks.onProgress?.(
    2,
    isMultiPart ? `Creando subida (${numberOfParts} partes)…` : "Creando subida en Notion…",
  );

  const createBody: Record<string, unknown> = {
    filename,
    content_type: contentType,
  };
  if (isMultiPart) {
    createBody.mode = "multi_part";
    createBody.number_of_parts = numberOfParts;
  }

  const createRes = await fetch(`${NOTION_API_BASE}/file_uploads`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(createBody),
  });

  const createJson = (await createRes.json().catch(() => null)) as {
    id?: string;
    upload_url?: string;
    complete_url?: string;
    message?: string;
  } | null;

  if (!createRes.ok || !createJson?.id) {
    throw new Error(createJson?.message ?? `Notion rechazó crear el upload (${createRes.status}).`);
  }

  const uploadId = createJson.id;
  const sendUrl = createJson.upload_url || `${NOTION_API_BASE}/file_uploads/${uploadId}/send`;
  const completeUrl =
    createJson.complete_url || `${NOTION_API_BASE}/file_uploads/${uploadId}/complete`;

  if (!isMultiPart) {
    const release = await sem.acquire();
    let outcome: Outcome = "error";
    try {
      callbacks.onProgress?.(35, "Subiendo video a Notion…");
      const form = new FormData();
      form.append("file", new Blob([blob], { type: contentType }), filename);

      const sendRes = await fetch(sendUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Notion-Version": NOTION_VERSION,
        },
        body: form,
      });

      if (isThrottleStatus(sendRes.status)) outcome = "throttle";
      const sent = (await sendRes.json().catch(() => null)) as {
        status?: string;
        message?: string;
      } | null;
      if (!sendRes.ok || (sent?.status !== "uploaded" && sent?.status !== "complete")) {
        throw new Error(sent?.message ?? `Error subiendo archivo a Notion (${sendRes.status}).`);
      }
      outcome = "ok";
    } finally {
      release(outcome);
    }

    callbacks.onProgress?.(100, "Subida completada");
    return { uploadId, sizeBytes: blob.size, mimeType: contentType };
  }

  // Multi-part paralelo con AIMD
  let doneParts = 0;
  const sendPart = async (partNumber: number): Promise<void> => {
    for (let attempt = 1; ; attempt += 1) {
      const release = await sem.acquire();
      let outcome: Outcome = "error";
      try {
        const start = (partNumber - 1) * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, blob.size);
        const slice = blob.slice(start, end, contentType);

        const form = new FormData();
        form.append("part_number", String(partNumber));
        form.append("file", slice, filename);

        const res = await fetch(sendUrl, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Notion-Version": NOTION_VERSION,
          },
          body: form,
        });

        if (isThrottleStatus(res.status)) {
          outcome = "throttle";
          throw new Error(`Notion ocupado (${res.status}) en parte ${partNumber}`);
        }
        if (!res.ok) {
          const err = (await res.json().catch(() => null)) as { message?: string } | null;
          throw new Error(err?.message ?? `Parte ${partNumber} falló (${res.status})`);
        }

        outcome = "ok";
        doneParts += 1;
        const pct = Math.min(96, Math.round((doneParts / numberOfParts) * 95));
        callbacks.onProgress?.(pct, `Subiendo parte ${doneParts}/${numberOfParts}…`);
        return;
      } catch (err) {
        if (attempt >= MAX_PART_RETRIES) throw err;
        const backoff = Math.min(5000, 400 * Math.pow(2, attempt - 1)) + Math.random() * 300;
        await sleep(backoff);
      } finally {
        release(outcome);
      }
    }
  };

  await Promise.all(Array.from({ length: numberOfParts }, (_, idx) => sendPart(idx + 1)));

  callbacks.onProgress?.(98, "Finalizando archivo en Notion…");
  const completeRes = await fetch(completeUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
  });

  const completed = (await completeRes.json().catch(() => null)) as {
    status?: string;
    message?: string;
  } | null;
  if (!completeRes.ok || (completed?.status !== "uploaded" && completed?.status !== "complete")) {
    throw new Error(completed?.message ?? `Error al completar upload (${completeRes.status}).`);
  }

  callbacks.onProgress?.(100, "Subida completada");
  return { uploadId, sizeBytes: blob.size, mimeType: contentType };
}

async function uploadViaEnviProxy(
  blob: Blob,
  filename: string,
  contentType: string,
  proxyBase: string,
  sem: AdaptiveSemaphore,
  callbacks: UploadProgressCallbacks,
): Promise<{ uploadId: string; sizeBytes: number; mimeType: string }> {
  if (blob.size <= MULTI_PART_THRESHOLD) {
    callbacks.onProgress?.(25, "Subiendo por proxy envi…");
    const fd = new FormData();
    fd.append("file", new Blob([blob], { type: contentType }), filename);
    const res = await fetch(`${proxyBase}/api/upload-file`, { method: "POST", body: fd });
    const data = (await res.json().catch(() => null)) as {
      success?: boolean;
      id?: string;
      error?: string;
    } | null;
    if (!res.ok || !data?.success || !data.id) {
      throw new Error(data?.error ?? `Error en proxy envi (${res.status}).`);
    }
    callbacks.onProgress?.(100, "Subida completada");
    return { uploadId: data.id, sizeBytes: blob.size, mimeType: contentType };
  }

  const numberOfParts = Math.ceil(blob.size / CHUNK_SIZE);
  callbacks.onProgress?.(2, `Inicializando envi (${numberOfParts} partes)…`);
  const initRes = await fetch(`${proxyBase}/api/upload-init`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filename, mimeType: contentType, fileSize: blob.size }),
  });
  const initData = (await initRes.json().catch(() => null)) as {
    success?: boolean;
    id?: string;
    error?: string;
  } | null;
  if (!initRes.ok || !initData?.success || !initData.id) {
    throw new Error(initData?.error ?? "Error inicializando subida en proxy envi.");
  }

  const uploadId = initData.id;
  let doneParts = 0;

  const sendPart = async (partNumber: number): Promise<void> => {
    for (let attempt = 1; ; attempt += 1) {
      const release = await sem.acquire();
      let outcome: Outcome = "error";
      try {
        const start = (partNumber - 1) * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, blob.size);
        const fd = new FormData();
        fd.append("part_number", String(partNumber));
        fd.append("file", blob.slice(start, end, contentType), filename);

        const res = await fetch(
          `${proxyBase}/api/upload-part?upload_id=${encodeURIComponent(uploadId)}`,
          { method: "POST", body: fd },
        );
        if (isThrottleStatus(res.status)) {
          outcome = "throttle";
          throw new Error(`Proxy envi ocupado (${res.status})`);
        }
        const data = (await res.json().catch(() => null)) as {
          success?: boolean;
          error?: string;
        } | null;
        if (!res.ok || !data?.success) {
          throw new Error(data?.error ?? `Parte ${partNumber} falló`);
        }

        outcome = "ok";
        doneParts += 1;
        callbacks.onProgress?.(
          Math.min(96, Math.round((doneParts / numberOfParts) * 95)),
          `Subiendo parte ${doneParts}/${numberOfParts}…`,
        );
        return;
      } catch (err) {
        if (attempt >= MAX_PART_RETRIES) throw err;
        await sleep(Math.min(5000, 400 * Math.pow(2, attempt - 1)) + Math.random() * 300);
      } finally {
        release(outcome);
      }
    }
  };

  await Promise.all(Array.from({ length: numberOfParts }, (_, i) => sendPart(i + 1)));

  callbacks.onProgress?.(98, "Completando en envi…");
  const completeRes = await fetch(`${proxyBase}/api/upload-complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ uploadId }),
  });
  const completeData = (await completeRes.json().catch(() => null)) as {
    success?: boolean;
    error?: string;
  } | null;
  if (!completeRes.ok || !completeData?.success) {
    throw new Error(completeData?.error ?? "Error completando upload en envi.");
  }

  callbacks.onProgress?.(100, "Subida completada");
  return { uploadId, sizeBytes: blob.size, mimeType: contentType };
}
