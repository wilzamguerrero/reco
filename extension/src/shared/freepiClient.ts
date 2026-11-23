/**
 * Cliente directo de free-pi (`https://api.freepi.ai`) para la extensión RECO.
 *
 * Basado en la implementación de `inre`:
 *  - Login por dispositivo de GitHub (`/auth/github/device` -> `/auth/consent` -> `/auth/token`).
 *  - Ciclo silencioso de anuncios en segundo plano (`/ads/next?slot=banner` -> píxel gravity -> `/ads/impression`)
 *    sin mostrar banners ni tarjetas publicitarias en la interfaz.
 *  - Catálogo de modelos desde `/client-version` (con soporte de visión `vision`).
 *  - Streaming SSE en `/v1/chat/completions` con `x-session-id` (UUIDv5 estable),
 *    `x-client-version`, reintento en `403 ads_required` y `409 concurrent_session`.
 */

const FREEPI_ROOT = "https://api.freepi.ai";
const DEFAULT_CLIENT_VERSION = "0.6.21";
const CONSENT_VERSION = "4";
const VERSION_TTL_MS = 30 * 60_000;
const AD_TTL_MS = 240_000;
const GRAVITY_HOSTS = ["trygravity.ai", "trygravity.com"];

export interface FreePiDeviceStart {
  sessionId: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  interval: number;
  expiresIn: number;
}

export interface FreePiAccount {
  handle: string;
  tier: string;
  remainingCredits: number | null;
  allowanceCredits: number | null;
  days: number | null;
}

export interface FreePiModel {
  id: string;
  name: string;
  free: boolean;
  vision: boolean;
}

export type ChatMessagePart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: string } };

export interface FreePiChatMessage {
  role: "system" | "user" | "assistant";
  content: string | ChatMessagePart[];
}

interface FreePiAd {
  adId: string;
  clickToken: string;
  source: string;
  impUrl: string;
}

let clientVersion = DEFAULT_CLIENT_VERSION;
let versionAt = 0;
let versionKnown = false;
const sessionCache = new Map<string, string>();
const adCache = new Map<string, { ad: FreePiAd | null; at: number; postedToken: string }>();

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function comparesLower(a: string, b: string): boolean {
  if (!a || !b) return false;
  const left = a.split(".").map((p) => Number.parseInt(p, 10) || 0);
  const right = b.split(".").map((p) => Number.parseInt(p, 10) || 0);
  const len = Math.max(left.length, right.length);
  for (let i = 0; i < len; i += 1) {
    const x = left[i] ?? 0;
    const y = right[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
}

function daysLeft(token: string): number | null {
  const parts = token.split(".");
  if (parts.length < 2 || !parts[1]) return null;
  try {
    const padded = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = JSON.parse(atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="))) as {
      exp?: unknown;
    };
    if (typeof json.exp !== "number") return null;
    return Math.max(0, Math.floor((json.exp * 1000 - Date.now()) / 86_400_000));
  } catch {
    return null;
  }
}

async function sessionIdFor(token: string): Promise<string> {
  const seed = token.trim() || `freepi:anon:${new Date().toISOString().slice(0, 10)}`;
  const cached = sessionCache.get(seed);
  if (cached) return cached;

  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(`freepi:${seed}`));
  const bytes = new Uint8Array(digest);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes.slice(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  sessionCache.set(seed, id);
  return id;
}

async function ensureClientVersion(token: string, force = false): Promise<string> {
  if (!force && versionKnown && Date.now() - versionAt < VERSION_TTL_MS) {
    return clientVersion;
  }
  const headers: Record<string, string> = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (clientVersion) headers["x-client-version"] = clientVersion;

  try {
    const res = await fetch(`${FREEPI_ROOT}/client-version`, { headers });
    versionAt = Date.now();
    if (!res.ok) return clientVersion;
    const data = (await res.json()) as Record<string, unknown>;
    const wanted = str(data.latest) || str(data.min);
    if (wanted) {
      versionKnown = true;
      if (comparesLower(clientVersion, wanted)) clientVersion = wanted;
    }
  } catch {
    // ignore
  }
  return clientVersion;
}

async function baseHeaders(token: string): Promise<Record<string, string>> {
  await ensureClientVersion(token);
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "x-session-id": await sessionIdFor(token),
    ...(clientVersion ? { "x-client-version": clientVersion } : {}),
  };
}

/* ----------------------------------------------------- GITHUB DEVICE LOGIN */

export async function startFreePiDevice(): Promise<FreePiDeviceStart> {
  const res = await fetch(`${FREEPI_ROOT}/auth/github/device`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: "{}",
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const sessionId = str(data.session_id);
  const userCode = str(data.user_code);
  if (!res.ok || !sessionId || !userCode) {
    throw new Error(str(data.message) || str(data.error) || `free-pi HTTP ${res.status}`);
  }
  return {
    sessionId,
    userCode,
    verificationUri: str(data.verification_uri) || "https://github.com/login/device",
    verificationUriComplete:
      str(data.verification_uri_complete) ||
      str(data.verification_uri) ||
      "https://github.com/login/device",
    interval: Math.max(3, num(data.interval) ?? 5),
    expiresIn: num(data.expires_in) ?? 900,
  };
}

export async function waitForFreePiToken(
  start: FreePiDeviceStart,
  signal?: AbortSignal,
): Promise<{ token: string; days: number | null }> {
  const consentRes = await fetch(`${FREEPI_ROOT}/auth/consent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ session_id: start.sessionId, consent_version: CONSENT_VERSION }),
    signal,
  });
  if (!consentRes.ok) {
    const err = (await consentRes.json().catch(() => ({}))) as Record<string, unknown>;
    throw new Error(str(err.message) || `Consentimiento rechazado (HTTP ${consentRes.status})`);
  }

  const deadline = Date.now() + start.expiresIn * 1000;
  let waitSec = start.interval;

  while (Date.now() < deadline) {
    await new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException("Cancelado", "AbortError"));
        return;
      }
      const t = window.setTimeout(resolve, waitSec * 1000 + 1200);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(t);
          reject(new DOMException("Cancelado", "AbortError"));
        },
        { once: true },
      );
    });

    const res = await fetch(`${FREEPI_ROOT}/auth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ session_id: start.sessionId }),
      signal,
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const token = str(data.token);
    if (token) {
      return { token, days: daysLeft(token) };
    }
    if (res.status === 410 || str(data.message) === "expired_token") {
      throw new Error("El código caducó. Intenta conectar de nuevo.");
    }
    if (res.status === 200 && str(data.status) === "pending") {
      const retry = num(data.retry_after);
      if (retry && retry > 0) waitSec = Math.max(waitSec, retry);
      continue;
    }
    throw new Error(str(data.message) || str(data.error) || `Error HTTP ${res.status}`);
  }

  throw new Error("El código caducó. Intenta conectar de nuevo.");
}

export async function getFreePiMe(token: string): Promise<FreePiAccount | null> {
  if (!token.trim()) return null;
  try {
    const res = await fetch(`${FREEPI_ROOT}/me`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as Record<string, unknown>;
    return {
      handle: str(data.handle),
      tier: str(data.tier),
      remainingCredits: num(data.remaining_credits_today),
      allowanceCredits: num(data.allowance_credits),
      days: daysLeft(token),
    };
  } catch {
    return null;
  }
}

/* -------------------------------------------------- SILENT BACKGROUND ADS */

function isGravityPixel(urlStr: string): boolean {
  try {
    const u = new URL(urlStr);
    const h = u.hostname.toLowerCase();
    return (
      u.protocol === "https:" &&
      GRAVITY_HOSTS.some((known) => h === known || h.endsWith(`.${known}`))
    );
  } catch {
    return false;
  }
}

export async function ensureFreePiAd(token: string, force = false): Promise<boolean> {
  if (!token.trim()) return false;
  let entry = adCache.get(token);
  if (!entry) {
    entry = { ad: null, at: 0, postedToken: "" };
    adCache.set(token, entry);
  }

  const now = Date.now();
  if (force || !entry.ad || now - entry.at >= AD_TTL_MS) {
    try {
      const res = await fetch(`${FREEPI_ROOT}/ads/next?slot=banner`, {
        headers: await baseHeaders(token),
      });
      if (res.ok && res.status !== 204) {
        const data = (await res.json()) as Record<string, unknown>;
        const adId = str(data.ad_id);
        const clickToken = str(data.click_token);
        if (adId && clickToken) {
          entry.ad = {
            adId,
            clickToken,
            source: str(data.source) || "own",
            impUrl: str(data.imp_url),
          };
          entry.at = now;
        }
      }
    } catch {
      return false;
    }
  }

  const ad = entry.ad;
  if (!ad) return false;
  if (entry.postedToken === ad.clickToken) return true;

  let impFired = false;
  if (ad.source === "gravity" && isGravityPixel(ad.impUrl)) {
    try {
      await fetch(ad.impUrl);
      impFired = true;
    } catch {
      impFired = true;
    }
  }

  try {
    const body: Record<string, unknown> = { ad_id: ad.adId, click_token: ad.clickToken };
    if (impFired) body.imp_fired = true;
    const res = await fetch(`${FREEPI_ROOT}/ads/impression`, {
      method: "POST",
      headers: { ...(await baseHeaders(token)), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return false;
    entry.postedToken = ad.clickToken;
    return true;
  } catch {
    return false;
  }
}

/* -------------------------------------------------------- CATALOG & STREAM */

export async function fetchFreePiModels(token: string): Promise<FreePiModel[]> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (clientVersion) headers["x-client-version"] = clientVersion;

  const res = await fetch(`${FREEPI_ROOT}/client-version`, { headers });
  if (!res.ok) return [];
  const payload = (await res.json()) as Record<string, unknown>;
  const wanted = str(payload.latest) || str(payload.min);
  if (wanted && comparesLower(clientVersion, wanted)) {
    clientVersion = wanted;
    versionKnown = true;
    versionAt = Date.now();
  }

  const raw = Array.isArray(payload.models) ? payload.models : [];
  return raw
    .map((entry): FreePiModel => {
      if (typeof entry === "string") {
        return { id: entry, name: entry, free: true, vision: false };
      }
      const m = (typeof entry === "object" && entry !== null ? entry : {}) as Record<
        string,
        unknown
      >;
      const id = str(m.id);
      const name = str(m.name) || id;
      const input = Array.isArray(m.input) ? m.input : [];
      return {
        id,
        name,
        free: m.free === true || m.usage === 0,
        vision: input.includes("image") || m.vision === true,
      };
    })
    .filter((m) => m.id !== "");
}

export async function streamFreePiChat(opts: {
  token: string;
  model: string;
  messages: FreePiChatMessage[];
  signal?: AbortSignal;
  onDelta?: (chunk: string) => void;
  onReasoning?: (chunk: string) => void;
}): Promise<{ text: string; reasoning: string }> {
  const { token, model, messages, signal, onDelta, onReasoning } = opts;

  // Keep silent ad cycle active before sending chat
  await ensureFreePiAd(token, false);

  const send = async () =>
    fetch(`${FREEPI_ROOT}/v1/chat/completions`, {
      method: "POST",
      headers: {
        ...(await baseHeaders(token)),
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({ model, messages, stream: true }),
      signal,
    });

  let res = await send();

  if (res.status === 403) {
    const detail = await res.clone().text().catch(() => "");
    if (/ads_required|ads aren't displaying|ads aren't shown/i.test(detail)) {
      if (await ensureFreePiAd(token, true)) {
        res = await send();
      }
    }
  }

  if (res.status === 409) {
    await new Promise((r) => setTimeout(r, 1400));
    if (!signal?.aborted) res = await send();
  }

  if (!res.ok) {
    const raw = await res.text().catch(() => "");
    let msg = raw;
    try {
      const parsed = JSON.parse(raw) as { message?: string; error?: { message?: string } | string };
      msg =
        parsed.message ||
        (typeof parsed.error === "string" ? parsed.error : parsed.error?.message) ||
        raw;
    } catch {
      // keep raw
    }
    throw new Error(msg.slice(0, 240) || `free-pi HTTP ${res.status}`);
  }

  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>;
    };
    const msg = data.choices?.[0]?.message;
    const text = typeof msg?.content === "string" ? msg.content : "";
    const reasoning = typeof msg?.reasoning_content === "string" ? msg.reasoning_content : "";
    if (reasoning) onReasoning?.(reasoning);
    if (text) onDelta?.(text);
    return { text: text || reasoning, reasoning };
  }

  const reader = res.body?.getReader();
  if (!reader) return { text: "", reasoning: "" };
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let reasoning = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") return { text: text || reasoning, reasoning };
        try {
          const parsed = JSON.parse(payload) as {
            choices?: Array<{
              delta?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown };
            }>;
          };
          const delta = parsed.choices?.[0]?.delta;
          const r =
            typeof delta?.reasoning_content === "string"
              ? delta.reasoning_content
              : typeof delta?.reasoning === "string"
                ? delta.reasoning
                : "";
          if (r) {
            reasoning += r;
            onReasoning?.(r);
          }
          if (typeof delta?.content === "string" && delta.content) {
            text += delta.content;
            onDelta?.(delta.content);
          }
        } catch {
          // ignore partial JSON
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return { text: text || reasoning, reasoning };
}
