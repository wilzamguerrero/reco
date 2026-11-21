/**
 * Endpoint OAuth opcional para Cloudflare Pages / Workers / Vercel (adaptado de `iii/api/notion-oauth.ts`).
 *
 * Úsalo en producción para que `NOTION_OAUTH_CLIENT_SECRET` nunca salga del servidor.
 *
 * Variables de entorno requeridas:
 *   NOTION_OAUTH_CLIENT_ID
 *   NOTION_OAUTH_CLIENT_SECRET
 *   NOTION_OAUTH_REDIRECT_URI   (ej. https://<EXTENSION_ID>.chromiumapp.org/notion)
 */

interface Env {
  NOTION_OAUTH_CLIENT_ID: string;
  NOTION_OAUTH_CLIENT_SECRET: string;
  NOTION_OAUTH_REDIRECT_URI: string;
}

const NOTION_TOKEN_URL = "https://api.notion.com/v1/oauth/token";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") return json({}, 204);

    if (!env.NOTION_OAUTH_CLIENT_ID || !env.NOTION_OAUTH_CLIENT_SECRET) {
      return json({ error: "notion_oauth_unconfigured" }, 503);
    }

    if (request.method === "GET") {
      return json({
        clientId: env.NOTION_OAUTH_CLIENT_ID,
        redirectUri: env.NOTION_OAUTH_REDIRECT_URI || "",
      });
    }

    if (request.method !== "POST") {
      return json({ error: "method_not_allowed" }, 405);
    }

    const body = (await request.json().catch(() => null)) as {
      code?: string;
      redirectUri?: string;
    } | null;

    const code = body?.code ?? "";
    const redirectUri = env.NOTION_OAUTH_REDIRECT_URI || body?.redirectUri || "";
    if (!code || !redirectUri) {
      return json({ error: "missing_code_or_redirect_uri" }, 400);
    }

    const credentials = btoa(`${env.NOTION_OAUTH_CLIENT_ID}:${env.NOTION_OAUTH_CLIENT_SECRET}`);
    const notionRes = await fetch(NOTION_TOKEN_URL, {
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

    const payload = await notionRes.json().catch(() => ({ error: "notion_bad_response" }));
    return json(payload, notionRes.status);
  },
};
