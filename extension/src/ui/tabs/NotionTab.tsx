import { useEffect, useState } from "react";
import {
  connectNotionWithOAuth,
  createChildPage,
  getExtensionRedirectUri,
  resolveNotionPageById,
  searchNotionPages,
  whoAmI,
} from "../../shared/notionClient";
import type { AppConfig, NotionAuthMode, NotionPageItem } from "../../shared/types";
import { Icon } from "../components/Icon";

export function NotionTab({
  config,
  updateConfig,
}: {
  config: AppConfig;
  updateConfig: (patch: Partial<AppConfig>) => Promise<AppConfig>;
}) {
  const n = config.notion;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");

  const [pages, setPages] = useState<NotionPageItem[]>([]);
  const [query, setQuery] = useState("");
  const [manualId, setManualId] = useState("");
  const [newPageName, setNewPageName] = useState("");
  const [copiedUri, setCopiedUri] = useState(false);

  const redirectUri = getExtensionRedirectUri();

  async function refreshPages(tokenToUse = n.token, q = query) {
    if (!tokenToUse.trim()) return;
    setBusy(true);
    setError("");
    try {
      const list = await searchNotionPages(tokenToUse.trim(), q, 30);
      setPages(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (n.token) {
      void refreshPages(n.token, "");
    }
  }, [n.token]);

  async function handleOAuthConnect() {
    setBusy(true);
    setError("");
    setInfo("");
    try {
      const res = await connectNotionWithOAuth(n);
      await updateConfig({
        notion: {
          ...n,
          token: res.accessToken,
          workspaceName: res.workspaceName,
          botId: res.botId,
        },
      });
      setInfo(`Conectado a ${res.workspaceName}`);
      await refreshPages(res.accessToken, "");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleDirectTokenConnect() {
    if (!n.token.trim()) {
      setError("Pega tu token de integración de Notion.");
      return;
    }
    setBusy(true);
    setError("");
    setInfo("");
    try {
      const bot = await whoAmI(n.token.trim());
      await updateConfig({
        notion: {
          ...n,
          token: n.token.trim(),
          workspaceName: bot.workspaceName,
          botId: bot.id,
        },
      });
      setInfo(`Conectado a ${bot.workspaceName}`);
      await refreshPages(n.token.trim(), "");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleSelectPage(p: NotionPageItem) {
    await updateConfig({
      notion: {
        ...n,
        targetPageId: p.id,
        targetPageTitle: p.title,
        targetPageUrl: p.url,
      },
    });
    setInfo(`Destino guardado: ${p.title}`);
  }

  async function handleManualResolve() {
    if (!n.token.trim() || !manualId.trim()) return;
    setBusy(true);
    setError("");
    try {
      const page = await resolveNotionPageById(n.token.trim(), manualId);
      await handleSelectPage(page);
      setManualId("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleCreateSubpage() {
    if (!n.token.trim() || !n.targetPageId) {
      setError("Selecciona primero una página padre para crear la subpágina dentro.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const created = await createChildPage(
        n.token.trim(),
        n.targetPageId,
        newPageName || "Grabaciones RECO",
      );
      setNewPageName("");
      await handleSelectPage(created);
      await refreshPages(n.token.trim(), "");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const setAuthMode = (authMode: NotionAuthMode) => {
    void updateConfig({ notion: { ...n, authMode } });
  };

  return (
    <div className="pane pane-scroll">
      <div className="pane-row">
        <Icon name="notion" size={14} />
        <span className="pane-label">Estado</span>
        <span className="pane-value" style={{ color: n.token ? "#34d399" : "var(--fg-muted)" }}>
          {n.token ? n.workspaceName || "Conectado" : "Sin conectar"}
        </span>
      </div>

      <div className="pane-col">
        <span className="pane-label">Método de conexión</span>
        <div className="chips" style={{ marginLeft: 0 }}>
          <button
            type="button"
            className={`chip ${n.authMode === "oauth_direct" ? "is-active" : ""}`}
            onClick={() => setAuthMode("oauth_direct")}
          >
            OAuth (Pruebas)
          </button>
          <button
            type="button"
            className={`chip ${n.authMode === "oauth_broker" ? "is-active" : ""}`}
            onClick={() => setAuthMode("oauth_broker")}
          >
            OAuth Servidor (iii)
          </button>
          <button
            type="button"
            className={`chip ${n.authMode === "token" ? "is-active" : ""}`}
            onClick={() => setAuthMode("token")}
          >
            Token
          </button>
          <button
            type="button"
            className={`chip ${n.authMode === "envi_proxy" ? "is-active" : ""}`}
            onClick={() => setAuthMode("envi_proxy")}
          >
            Proxy envi
          </button>
        </div>

        {n.authMode === "oauth_direct" && (
          <>
            <div className="pane-hint">
              Redirect URI para tu integración en <b>notion.so/my-integrations</b>:
            </div>
            <div style={{ display: "flex", gap: 5, alignItems: "center" }}>
              <input value={redirectUri} readOnly style={{ flex: 1, fontSize: 11 }} />
              <button
                type="button"
                className="btn-xs"
                onClick={() => {
                  void navigator.clipboard.writeText(redirectUri);
                  setCopiedUri(true);
                  setTimeout(() => setCopiedUri(false), 1400);
                }}
              >
                {copiedUri ? "✓" : "Copiar"}
              </button>
            </div>
            <input
              placeholder="NOTION_OAUTH_CLIENT_ID"
              value={n.oauthClientId}
              onChange={(e) =>
                void updateConfig({ notion: { ...n, oauthClientId: e.target.value } })
              }
            />
            <input
              type="password"
              placeholder="NOTION_OAUTH_CLIENT_SECRET"
              value={n.oauthClientSecret}
              onChange={(e) =>
                void updateConfig({ notion: { ...n, oauthClientSecret: e.target.value } })
              }
            />
            <button
              type="button"
              disabled={busy}
              className="action-primary"
              style={{ borderColor: "rgba(52,211,153,0.45)", color: "#a7f3d0" }}
              onClick={() => void handleOAuthConnect()}
            >
              Conectar con Notion (OAuth)
            </button>
          </>
        )}

        {n.authMode === "oauth_broker" && (
          <>
            <input
              placeholder="https://tu-proyecto.pages.dev/api/notion-oauth"
              value={n.oauthBrokerUrl}
              onChange={(e) =>
                void updateConfig({ notion: { ...n, oauthBrokerUrl: e.target.value } })
              }
            />
            <button
              type="button"
              disabled={busy}
              className="action-primary"
              style={{ borderColor: "rgba(52,211,153,0.45)", color: "#a7f3d0" }}
              onClick={() => void handleOAuthConnect()}
            >
              Conectar con Notion (OAuth)
            </button>
          </>
        )}

        {n.authMode === "token" && (
          <>
            <input
              type="password"
              placeholder="ntn_... o secret_..."
              value={n.token}
              onChange={(e) => void updateConfig({ notion: { ...n, token: e.target.value } })}
            />
            <button
              type="button"
              disabled={busy}
              className="action-primary"
              onClick={() => void handleDirectTokenConnect()}
            >
              Verificar token y cargar páginas
            </button>
          </>
        )}

        {n.authMode === "envi_proxy" && (
          <>
            <input
              placeholder="https://tu-envi.pages.dev"
              value={n.enviProxyUrl}
              onChange={(e) =>
                void updateConfig({ notion: { ...n, enviProxyUrl: e.target.value } })
              }
            />
            <div className="pane-hint">
              Usa los endpoints <code>/api/upload-init</code>, <code>/api/upload-part</code> y{" "}
              <code>/api/upload-complete</code> de envi.
            </div>
          </>
        )}
      </div>

      {error && <div className="alert-box">{error}</div>}
      {info && <div className="ok-box">{info}</div>}

      {n.token && (
        <div className="pane-col">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span className="pane-label">Página donde guardar grabaciones</span>
            <button
              type="button"
              className="btn-xs"
              disabled={busy}
              onClick={() => void refreshPages(n.token, query)}
            >
              <Icon name="refresh" size={11} />
            </button>
          </div>

          <div style={{ display: "flex", gap: 5 }}>
            <input
              placeholder="Buscar página compartida…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void refreshPages(n.token, query);
              }}
              style={{ flex: 1 }}
            />
            <button
              type="button"
              className="btn-xs"
              onClick={() => void refreshPages(n.token, query)}
            >
              Buscar
            </button>
          </div>

          <div className="page-list">
            {pages.length === 0 ? (
              <div className="pane-hint">
                No hay páginas listadas. Comparte al menos una página con la integración o pega su
                ID abajo.
              </div>
            ) : (
              pages.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={`page-item ${n.targetPageId === p.id ? "is-selected" : ""}`}
                  onClick={() => void handleSelectPage(p)}
                >
                  <span>{p.icon ?? "📄"}</span>
                  <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {p.title}
                  </span>
                  {n.targetPageId === p.id && <Icon name="check" size={12} style={{ color: "#34d399" }} />}
                </button>
              ))
            )}
          </div>

          <div style={{ display: "flex", gap: 5 }}>
            <input
              placeholder="O pega URL / ID de página"
              value={manualId}
              onChange={(e) => setManualId(e.target.value)}
              style={{ flex: 1, fontSize: 11.5 }}
            />
            <button type="button" className="btn-xs" onClick={() => void handleManualResolve()}>
              Usar
            </button>
          </div>

          {n.targetPageId && (
            <div style={{ display: "flex", gap: 5 }}>
              <input
                placeholder="Nueva subpágina (ej. Clases 2026)"
                value={newPageName}
                onChange={(e) => setNewPageName(e.target.value)}
                style={{ flex: 1, fontSize: 11.5 }}
              />
              <button type="button" className="btn-xs" onClick={() => void handleCreateSubpage()}>
                + Crear
              </button>
            </div>
          )}

          <div className="chips" style={{ marginLeft: 0, marginTop: 2 }}>
            <button
              type="button"
              className={`chip ${n.writeMode === "toggle_block" ? "is-active" : ""}`}
              onClick={() =>
                void updateConfig({ notion: { ...n, writeMode: "toggle_block" } })
              }
            >
              Bloque toggle en página
            </button>
            <button
              type="button"
              className={`chip ${n.writeMode === "child_page" ? "is-active" : ""}`}
              onClick={() => void updateConfig({ notion: { ...n, writeMode: "child_page" } })}
            >
              Subpágina por video
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
