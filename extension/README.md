# RECO — Extensión de Chrome (MV3)

Extensión profesional de Chrome que une **dictado continuo tipo Wispr Flow** en el cursor y **grabación de pantalla tipo Loom** con subida directa e incremental a **Notion**.

## Qué incluye

1. **Esfera flotante inteligente (Canvas 2D en Shadow DOM)** con colores distintos según el estado:
   - **Cian / Azul eléctrico**: Dictando y escribiendo en el cursor (pulsa con tu voz y destella al insertar).
   - **Rojo incandescente RECO**: Grabando pantalla.
   - **Ámbar**: Grabación en pausa.
   - **Verde esmeralda**: Subiendo video a Notion.
2. **Dictado continuo en cualquier web (`speechEngine.ts` + `textInjector.ts`)**:
   - Usa Web Speech API (`SpeechRecognition`) en el origen de la extensión (`bridge.html`) para pedir el permiso del micrófono **una sola vez**.
   - Se reanuda automáticamente tras pausas o cortes largos de Chrome: **solo se detiene cuando tú lo detienes** (`Alt + Shift + D` o botón Detener).
   - Inserta en `<input>`, `<textarea>` y editores ricos `contenteditable` (Notion, Gmail, ChatGPT, Slack, WhatsApp Web, etc.) conservando foco y Ctrl+Z.
3. **Grabación de pantalla + subida rápida/en vivo a Notion (`offscreen.ts` + `notionUploader.ts`)**:
   - Captura pantalla, ventana o pestaña + audio del sistema + micrófono mezclado.
   - Almacena fragmentos en **OPFS** para no saturar RAM.
   - Dos estrategias:
     - **Video único rápido (AIMD)**: al detener, sube inmediatamente en paralelo con semáforo adaptativo AIMD (portado de `envi`).
     - **En vivo mientras grabas (Loom)**: sube capítulos reproducibles cada ~45 s mientras sigues grabando.
4. **Conexión a Notion (`notionClient.ts`)**:
   - **OAuth con `chrome.identity.launchWebAuthFlow`** (modo pruebas con Client ID/Secret o vía servidor broker estilo `iii` en `oauth-worker/notion-oauth.ts`), permitiendo seleccionar las páginas en Notion y elegir exactamente en cuál página guardar tus grabaciones.
   - También admite **Token directo** (`ntn_...`) o **Proxy `envi`**.

## Cómo compilar y probar en Chrome

```bash
cd extension
npm install
npm run build
```

1. Abre `chrome://extensions` en Google Chrome.
2. Activa **Modo de desarrollador** (esquina superior derecha).
3. Haz clic en **Cargar descomprimida** (`Load unpacked`) y selecciona la carpeta:
   `reco/extension/dist`
4. Abre el popup de RECO, ve a la pestaña **Notion**:
   - Para probar **OAuth**, copia el `Redirect URI` (`https://<tu-id>.chromiumapp.org/notion`) que aparece en la pestaña Notion y pégalo en tu integración pública en `https://www.notion.so/my-integrations`.
   - Inicia sesión con Notion, selecciona las páginas y elige tu página destino.
5. Para probar **Dictado**, haz clic en cualquier campo de texto y pulsa `Alt + Shift + D` (o clic en la esfera flotante -> **Dictar aquí**).
   - Funciona automáticamente en páginas web, `<iframe>` (Google Docs, etc.) y Shadow DOM.
   - **Opcional para escribir fuera de Chrome** (Word, Bloc de Notas, VS Code, WhatsApp Desktop, etc.): ejecuta `native-host/Instalar_Dictado_Escritorio.bat` e introduce el ID de la extensión que aparece en `chrome://extensions` (o en la pestaña **Dictado**).
6. Para probar **Grabación**, pulsa `Alt + Shift + R` (o clic en la esfera -> **Grabar pantalla**).
