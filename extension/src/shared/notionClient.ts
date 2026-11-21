/**
 * Cliente Notion + OAuth para Chrome Extension.
 *
 * Combina lo mejor de `iii` (OAuth + selector de páginas) y `envi` (bloques
 * estructurados con callout + archivos/videos adjuntos):
 * - Como extensión MV3 con `host_permissions` para `https://api.notion.com/*`,
 *   puede llamar directamente a la API de Notion sin problemas de CORS.
 * - Soporta OAuth vía `chrome.identity.launchWebAuthFlow`:
 *     1) Vía un servidor broker (como `iii/api/notion-oauth.ts`), donde el `client_secret` vive en el servidor.
 *     2) Vía OAuth directo en la extensión (`clientId` + `clientSecret` en Ajustes) usando `chrome.identity.getRedirectURL("notion")` para pruebas inmediatas.
 * - También soporta pegar un token directo (`ntn_...` / `secret_...`) o apuntar al proxy `envi`.
 */

import type { NotionConfig, NotionPageItem, NotionWriteMode } from "./types";

export const NOTION_API_BASE = "https://api.notion.com/v1";
export const NOTION_VERSION = "2026-03-11";
const NOTION_AUTHORIZE_URL = "https://api.notion.com/v1/oauth/authorize";
const NOTION_TOKEN_URL = "https://api.notion.com/v1/oauth/token";

export interface NotionBotInfo {
  id: string;
  name: string;
  workspaceName: string;
}

export interface UploadedVideoPart {
  uploadId: string;
  name: string;
  sizeBytes: number;
  mimeType: string;
  label?: string;
}

export function cleanNotionId(input: string): string {
  if (!input) return "";
  const trimmed = input.trim();
  const dash = trimmed.match(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i);
  if (dash) return dash[0];
  const plain = trimmed.match(/[a-f0-9]{32}/i);
  if (plain) return plain[0];
  return trimmed;
}

export function getExtensionRedirectUri(): string {
  return chrome.identity.getRedirectURL("notion");
}

function randomState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function notionJson<T>(
  token: string,
  path: string,
  opts: { method?: "GET" | "POST" | "PATCH" | "DELETE"; body?: unknown } = {},
): Promise<T> {
  const res = await fetch(`${NOTION_API_BASE}${path}`, {
    method: opts.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });

  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    const msg =
      (typeof data?.message === "string" && data.message) ||
      (typeof data?.error === "string" && data.error) ||
      `Notion respondió ${res.status}`;
    throw new Error(msg);
  }
  return data as T;
}

/** Valida el token y obtiene el nombre del workspace conectado. */
export async function whoAmI(token: string): Promise<NotionBotInfo> {
  const data = await notionJson<{
    id?: string;
    name?: string | null;
    bot?: { workspace_name?: string | null };
  }>(token, "/users/me");

  return {
    id: data.id ?? "",
    name: data.name ?? "Integración RECO",
    workspaceName: data.bot?.workspace_name ?? "Workspace de Notion",
  };
}

/** Extrae el título legible de una página devuelta por `/v1/search`. */
function extractPageTitle(page: Record<string, unknown>): string {
  const props = page.properties as Record<string, Record<string, unknown>> | undefined;
  if (props) {
    for (const val of Object.values(props)) {
      if (val?.type === "title" && Array.isArray(val.title)) {
        const text = (val.title as Array<{ plain_text?: string }>)
          .map((t) => t.plain_text ?? "")
          .join("")
          .trim();
        if (text) return text;
      }
    }
  }
  return "Página sin título";
}

function extractPageIcon(page: Record<string, unknown>): string | undefined {
  const icon = page.icon as { type?: string; emoji?: string } | null | undefined;
  if (icon?.type === "emoji" && icon.emoji) return icon.emoji;
  return undefined;
}

/** Lista las páginas compartidas con la integración (estilo `iii/client.ts`). */
export async function searchNotionPages(
  token: string,
  query = "",
  pageSize = 30,
): Promise<NotionPageItem[]> {
  const body: Record<string, unknown> = {
    filter: { property: "object", value: "page" },
    sort: { direction: "descending", timestamp: "last_edited_time" },
    page_size: pageSize,
  };
  if (query.trim()) body.query = query.trim();

  const data = await notionJson<{ results?: Array<Record<string, unknown>> }>(
    token,
    "/search",
    { method: "POST", body },
  );

  return (data.results ?? []).map((p) => ({
    id: String(p.id ?? ""),
    title: extractPageTitle(p),
    url: String(p.url ?? ""),
    icon: extractPageIcon(p),
    lastEdited: typeof p.last_edited_time === "string" ? p.last_edited_time : undefined,
  }));
}

/** Obtiene los metadatos de una página por ID o URL pegada. */
export async function resolveNotionPageById(
  token: string,
  idOrUrl: string,
): Promise<NotionPageItem> {
  const id = cleanNotionId(idOrUrl);
  if (!id) throw new Error("ID o enlace de página de Notion inválido.");
  const page = await notionJson<Record<string, unknown>>(token, `/pages/${id}`);
  return {
    id: String(page.id ?? id),
    title: extractPageTitle(page),
    url: String(page.url ?? `https://www.notion.so/${id.replace(/-/g, "")}`),
    icon: extractPageIcon(page),
    lastEdited: typeof page.last_edited_time === "string" ? page.last_edited_time : undefined,
  };
}

/** Crea una nueva subpágina dentro de la página padre seleccionada. */
export async function createChildPage(
  token: string,
  parentPageId: string,
  title: string,
  emoji = "🎬",
): Promise<NotionPageItem> {
  const cleanTitle = title.trim() || "Grabaciones RECO";
  const created = await notionJson<Record<string, unknown>>(token, "/pages", {
    method: "POST",
    body: {
      parent: { page_id: cleanNotionId(parentPageId) },
      icon: { type: "emoji", emoji },
      properties: {
        title: {
          title: [{ type: "text", text: { content: cleanTitle } }],
        },
      },
    },
  });

  return {
    id: String(created.id ?? ""),
    title: cleanTitle,
    url: String(created.url ?? ""),
    icon: emoji,
  };
}

/**
 * Ejecuta el flujo OAuth oficial de Notion mediante `chrome.identity.launchWebAuthFlow`.
 * Permite al usuario iniciar sesión en Notion y elegir exactamente las páginas que quiere compartir.
 */
export async function connectNotionWithOAuth(
  notionCfg: Pick<NotionConfig, "authMode" | "oauthBrokerUrl" | "oauthClientId" | "oauthClientSecret">,
): Promise<{
  accessToken: string;
  workspaceName: string;
  botId: string;
  duplicatedTemplateId?: string;
}> {
  let clientId = notionCfg.oauthClientId.trim();
  let redirectUri = getExtensionRedirectUri();
  const brokerUrl = notionCfg.oauthBrokerUrl.trim().replace(/\/+$/, "");

  if (notionCfg.authMode === "oauth_broker") {
    if (!brokerUrl) {
      throw new Error("Configura la URL de tu servidor OAuth (ej. https://tu-app.pages.dev/api/notion-oauth).");
    }
    const cfgRes = await fetch(brokerUrl, { headers: { Accept: "application/json" } });
    const cfg = (await cfgRes.json().catch(() => null)) as {
      clientId?: string;
      redirectUri?: string;
      message?: string;
    } | null;
    if (!cfgRes.ok || !cfg?.clientId) {
      throw new Error(cfg?.message ?? "No se pudo leer la configuración OAuth del servidor.");
    }
    clientId = cfg.clientId;
    if (cfg.redirectUri) redirectUri = cfg.redirectUri;
  } else {
    if (!clientId || !notionCfg.oauthClientSecret.trim()) {
      throw new Error("Ingresa el Client ID y Client Secret de tu integración pública de Notion.");
    }
  }

  const state = randomState();
  const authUrl = new URL(NOTION_AUTHORIZE_URL);
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("owner", "user");
  authUrl.searchParams.set("state", state);

  const callbackUrl = await chrome.identity.launchWebAuthFlow({
    url: authUrl.toString(),
    interactive: true,
  });

  if (!callbackUrl) {
    throw new Error("El inicio de sesión con Notion fue cancelado.");
  }

  const parsed = new URL(callbackUrl);
  const error = parsed.searchParams.get("error");
  if (error) {
    throw new Error(`Notion rechazó la autorización: ${error}`);
  }
  const returnedState = parsed.searchParams.get("state");
  if (returnedState !== state) {
    throw new Error("Error de seguridad OAuth (state inválido). Intenta de nuevo.");
  }
  const code = parsed.searchParams.get("code");
  if (!code) {
    throw new Error("Notion no devolvió el código de autorización.");
  }

  let tokenPayload: Record<string, unknown>;
  if (notionCfg.authMode === "oauth_broker") {
    const exRes = await fetch(brokerUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ code, redirectUri }),
    });
    tokenPayload = (await exRes.json().catch(() => ({}))) as Record<string, unknown>;
    if (!exRes.ok || typeof tokenPayload.access_token !== "string") {
      throw new Error(
        (typeof tokenPayload.message === "string" && tokenPayload.message) ||
          "No se pudo intercambiar el código OAuth.",
      );
    }
  } else {
    const credentials = btoa(`${clientId}:${notionCfg.oauthClientSecret.trim()}`);
    const exRes = await fetch(NOTION_TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
      }),
    });
    tokenPayload = (await exRes.json().catch(() => ({}))) as Record<string, unknown>;
    if (!exRes.ok || typeof tokenPayload.access_token !== "string") {
      throw new Error(
        (typeof tokenPayload.error_description === "string" && tokenPayload.error_description) ||
          (typeof tokenPayload.message === "string" && tokenPayload.message) ||
          "Notion rechazó el intercambio del código.",
      );
    }
  }

  return {
    accessToken: tokenPayload.access_token as string,
    workspaceName: String(tokenPayload.workspace_name ?? "Workspace de Notion"),
    botId: String(tokenPayload.bot_id ?? ""),
    duplicatedTemplateId:
      typeof tokenPayload.duplicated_template_id === "string"
        ? tokenPayload.duplicated_template_id
        : undefined,
  };
}

function formatDurationHuman(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/**
 * Publica una grabación subida en la página de Notion seleccionada.
 * Sigue la misma estructura limpia de `envi` (callout informativo + bloques nativos de video).
 */
export async function attachRecordingToNotionPage(params: {
  token: string;
  targetPageId: string;
  writeMode: NotionWriteMode;
  title: string;
  createdAtIso: string;
  durationMs: number;
  sizeBytes: number;
  parts: UploadedVideoPart[];
}): Promise<{ blockId: string; pageId: string; pageUrl: string }> {
  const parentId = cleanNotionId(params.targetPageId);
  if (!parentId) throw new Error("No hay una página de destino seleccionada en Notion.");

  const dateText = new Date(params.createdAtIso).toLocaleString("es-ES", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const sizeMb = (params.sizeBytes / (1024 * 1024)).toFixed(2);
  const durText = formatDurationHuman(params.durationMs);

  const innerBlocks: unknown[] = [
    {
      object: "block",
      type: "callout",
      callout: {
        rich_text: [
          {
            type: "text",
            text: {
              content:
                `Grabación RECO\n` +
                `• Título: ${params.title}\n` +
                `• Fecha: ${dateText}\n` +
                `• Duración: ${durText}\n` +
                `• Tamaño total: ${sizeMb} MB` +
                (params.parts.length > 1 ? `\n• Capítulos subidos en vivo: ${params.parts.length}` : ""),
            },
          },
        ],
        icon: { type: "emoji", emoji: "🎬" },
        color: "red_background",
      },
    },
    ...params.parts.map((part, idx) => {
      const captionText = part.label
        ? `${part.label} — ${(part.sizeBytes / (1024 * 1024)).toFixed(2)} MB`
        : `${part.name} (${(part.sizeBytes / (1024 * 1024)).toFixed(2)} MB)${
            params.parts.length > 1 ? ` · Parte ${idx + 1}/${params.parts.length}` : ""
          }`;

      return {
        object: "block",
        type: "video",
        video: {
          type: "file_upload",
          file_upload: { id: part.uploadId },
          caption: [{ type: "text", text: { content: captionText } }],
        },
      };
    }),
  ];

  if (params.writeMode === "child_page") {
    const created = await notionJson<{ id?: string; url?: string }>(params.token, "/pages", {
      method: "POST",
      body: {
        parent: { page_id: parentId },
        icon: { type: "emoji", emoji: "🎬" },
        properties: {
          title: {
            title: [{ type: "text", text: { content: `${params.title} (${dateText})` } }],
          },
        },
        children: innerBlocks,
      },
    });
    const pageId = created.id ?? parentId;
    return {
      blockId: pageId,
      pageId,
      pageUrl: created.url ?? `https://www.notion.so/${pageId.replace(/-/g, "")}`,
    };
  }

  // Modo toggle_block (estilo envi): agrega un toggle desplegable dentro de la página elegida
  const appended = await notionJson<{ results?: Array<{ id?: string }> }>(
    params.token,
    `/blocks/${parentId}/children`,
    {
      method: "PATCH",
      body: {
        children: [
          {
            object: "block",
            type: "toggle",
            toggle: {
              rich_text: [
                {
                  type: "text",
                  text: { content: `🎬 ${params.title} — ${dateText} (${durText})` },
                },
              ],
              children: innerBlocks,
            },
          },
        ],
      },
    },
  );

  const blockId = appended.results?.[0]?.id ?? "";
  return {
    blockId,
    pageId: parentId,
    pageUrl: `https://www.notion.so/${parentId.replace(/-/g, "")}`,
  };
}
