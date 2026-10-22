# RECO — Documento de arquitectura

> **Estado:** v1 · base para implementación
> **Objetivo:** app de escritorio multiplataforma que une dictado local (tipo Wispr Flow)
> y grabación de pantalla con subida incremental a Notion (tipo Loom).
> **Stack:** Tauri 2 · React + TypeScript + CSS · Rust

---

## 0. Cómo usar este documento

Cada sección es una unidad de trabajo independiente. El orden de lectura recomendado es
§1 → §2 → §3 → §4 (contratos) → y luego la sección del módulo que se vaya a implementar.
Los contratos de §4 son **normativos**: si cambia un comando IPC, se actualiza aquí primero.

---

## 1. Alcance

### 1.1 Qué hace RECO

| Función | Origen de la idea | Comportamiento en RECO |
|---|---|---|
| Dictado | Wispr Flow | Atajo global (Bloq Mayús): mantener = pulsar-y-hablar, doble toque = dictado continuo. Transcribe **en local** y pega el texto en la app activa. |
| Grabación | Loom | Graba pantalla/ventana/área + micrófono + audio del sistema. Indicador flotante discreto. |
| Subida | Loom | **Sube mientras graba**, por partes, sin esperar a que termine la grabación. |
| Destino | `envi` | Notion como almacenamiento. La app **no** habla con Notion directamente desde el frontend: siempre por el núcleo Rust y, opcionalmente, por el proxy Cloudflare de `envi`. |
| Portal | Loom | Lista de grabaciones con su enlace compartible, generado desde Notion. |

### 1.2 Qué NO hace (v1)

- No edita video (recorte, anotaciones, capítulos).
- No hace videollamadas ni comparte pantalla en vivo.
- No transcribe video (solo dictado de voz); la transcripción de grabaciones queda para v2.
- No tiene backend propio: Notion es el almacén, `envi` es el proxy opcional.

### 1.3 Actores y flujos

```
Usuario
  │
  ├─ (1) Mantiene Bloq Mayús ──→ audio ──→ STT local ──→ limpieza ──→ pegar en app activa
  │
  ├─ (2) Clic en icono de bandeja ──→ menú ──→ Grabar pantalla
  │                                              │
  │                                              ├─ segmentos MP4 ──→ subida multipart Notion
  │                                              └─ al parar ──→ complete ──→ enlace
  │
  └─ (3) Portal ──→ lista de grabaciones ──→ copiar enlace / abrir en Notion
```

---

## 2. Decisiones de arquitectura (ADR)

### ADR-001 · Tauri 2 en lugar de Electron

**Contexto:** Wispr Flow es Electron (`app.asar` de 136 MB, Chromium completo incluido).

**Decisión:** Tauri 2. Usa el WebView2/WebKit del sistema en vez de empaquetar Chromium.

**Consecuencias:**
- (+) Instalador ~10–20 MB en vez de ~150–250 MB; RAM en reposo mucho menor.
- (+) El núcleo Rust es el mismo binario en las tres plataformas.
- (−) El renderizado depende del WebView del sistema: WebView2 (Windows), WebKitGTK (Linux), WKWebView (macOS). Hay que probar CSS/JS en los tres.
- (−) No podemos copiar literalmente el código de la extensión de Loom: usa APIs de Chrome (`desktopCapture`, `tabCapture`) que no existen en un WebView.

### ADR-002 · La captura de pantalla vive en Rust, no en el frontend

**Contexto:** El README original sugiere que la UI y el núcleo hablen por comandos, pero no
dice dónde vive la captura. Loom resuelve esto en el navegador porque es una extensión.

**Decisión:** Toda captura (pantalla, micrófono, audio del sistema) ocurre en Rust.
El frontend **solo recibe eventos de estado y previsualización**.

**Motivo:** `getUserMedia` con `getDisplayMedia` dentro de un WebView da resultados distintos
en cada plataforma y en macOS exige permisos que el WebView maneja de forma opaca. En Rust
controlamos el pipeline completo y podemos escribir a disco de forma continua.

### ADR-003 · Un solo pipeline de grabación: segmentar y subir, no grabar y subir

**Contexto:** Loom "ya está subido" al terminar porque crea el multipart de S3 al empezar y
empuja partes en paralelo (`CreateMultipartUpload` → `UploadPart` → `CompleteMultipartUpload`,
verificado en `references/liecbd.../js/sw.js`).

**Decisión:** Replicamos el patrón, adaptado a Notion:

```
Grabación ──→ segmento .mp4 (#1, #2, #3 …) ──→ cola ──→ upload-part Notion
                    │                                      (concurrente, AIMD)
                    └── se conserva en disco hasta que el upload esté COMPLETED
```

**Restricción real de Notion (verificada en `envi`):** la API `POST /v1/file_uploads`
exige `number_of_parts` **al crear** el upload. Por tanto podemos empujar partes mientras
grabamos **solo si conocemos el número total de partes de antemano**.

**Solución — "ventana de segmentos":**

| Modo | Cuándo | Cómo |
|---|---|---|
| **A · Directo** | Grabaciones cortas (< 20 MiB) | Se graba, se sube single-part al terminar. |
| **B · Por partes, secuencial** | Predeterminado | Un archivo MP4 **fragmentado** se va escribiendo; cada ~10 s se cierra un fragmento. Al detener, se conoce el tamaño final → se crea el upload con `number_of_parts` correcto y se suben las partes ya en disco en paralelo. |
| **C · Por partes, especulativo** | Opcional, v2 | Reservar N partes de antemano (p. ej. 1 parte por minuto estimado) y abortar/ajustar. **No en v1**: Notion rechaza un `complete` con partes de menos. |

**Consecuencia clave:** en v1 la subida empieza en cuanto se detiene la grabación (no
espera a codificar: los fragmentos ya están en disco). La ventaja de Loom de "ya está
subido" se aproxima mucho, pero **no se promete subida durante la grabación en v1** —
eso depende de una capacidad que Notion no ofrece hoy. Queda documentado como riesgo R-01.

### ADR-004 · Dos rutas hacia Notion, una sola interfaz

**Contexto:** `envi` ya resuelve la subida a Notion y el proxy Cloudflare, con caché,
reintentos y protección de secretos (`NOTION_SECRET` vive en el servidor, nunca en el cliente).

**Decisión:** El cliente Rust define una trait `NotionSink` con dos implementaciones:

```rust
enum NotionRoute {
    /// Habla directo con api.notion.com usando un token guardado en el keyring del SO.
    Direct,
    /// Usa el proxy Cloudflare de `envi` (recomendado: el token nunca sale del servidor).
    Proxy { base_url: String },
}
```

**Regla:** si el usuario elige `Proxy`, RECO **nunca** ve el token de Notion.
Si elige `Direct`, el token se guarda en el **keyring del sistema operativo**, jamás en
`localStorage` ni en un JSON plano.

### ADR-005 · El dictado es local por defecto, con motor intercambiable

**Contexto:** el README deja abierta la pregunta "local vs nube". El requisito explícito
del usuario es "local".

**Decisión:** trait `Transcriber` con implementación por defecto `whisper.cpp` embebido
(vía `whisper-rs`) y un segundo backend opcional `Remote` (API compatible OpenAI/Whisper).

```rust
#[async_trait]
trait Transcriber: Send + Sync {
    async fn transcribe(&self, audio: &AudioBuffer, opts: &SttOptions) -> Result<Transcript>;
    fn is_ready(&self) -> bool;
    fn model_id(&self) -> &str;
}
```

El modelo **no va en el instalador**. Se descarga en el primer uso (con barra de progreso
y verificación de hash SHA-256). Modelo inicial: `ggml-base` multilingüe (~150 MB),
configurable a `small`/`medium` según RAM.

**Limpieza posterior (opcional):** un segundo paso `TextPolisher` que quita muletillas y
arregla puntuación. v1: reglas heurísticas en Rust. v2: modelo local pequeño o servicio.

---

## 3. Vista de capas

```
┌─────────────────────────────────────────────────────────────────────┐
│  UI  (React + TS + CSS)                                             │
│  features/dictation · features/recording · features/library         │
│  features/settings · features/onboarding                            │
└──────────────────────────┬──────────────────────────────────────────┘
                           │  invoke() comandos · listen() eventos
                           │  (contratos en §4 — normativos)
┌──────────────────────────┴──────────────────────────────────────────┐
│  NÚCLEO  (Rust · src-tauri/src)                                     │
│                                                                     │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌──────────────────┐  │
│  │ shortcuts  │ │ dictation  │ │ recording  │ │ upload (cola)    │  │
│  │ hotkeys    │ │ STT+inject │ │ capture+enc│ │ AIMD + reintentos│  │
│  └────────────┘ └─────┬──────┘ └─────┬──────┘ └────────┬─────────┘  │
│                       │              │                 │            │
│  ┌────────────┐ ┌─────┴──────┐ ┌─────┴──────┐ ┌────────┴─────────┐  │
│  │ tray       │ │ platform   │ │ storage    │ │ notion           │  │
│  │ menú       │ │ (Win/Mac/  │ │ SQLite     │ │ NotionSink trait │  │
│  │            │ │  Linux)    │ │ + disco    │ │ Direct | Proxy   │  │
│  └────────────┘ └────────────┘ └────────────┘ └──────────────────┘  │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │ app_state: Arc<AppState>  (config, cola, sesiones activas)   │   │
│  └──────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
                           │
        ┌──────────────────┼──────────────────┐
        ▼                  ▼                  ▼
    Notion API        api.notion.com      Sistema operativo
    (vía proxy        (ruta Direct)       (audio, captura,
     `envi`)                              portapapeles, keyring)
```

---

## 4. Contratos IPC (normativos)

Convención: comandos en `snake_case` con prefijo por módulo. Eventos en `kebab-case`.

### 4.1 Comandos

#### Dictado

```ts
// Inicia una sesión de dictado. Devuelve el id de sesión.
dictation_start(mode: "push_to_talk" | "toggle"): Promise<{ sessionId: string }>

// Detiene la sesión y devuelve el texto final (ya transcrito y limpiado).
// No lo inserta: la inserción la decide el caller con dictation_inject.
dictation_stop(sessionId: string): Promise<DictationResult>

// Inserta texto en la ventana que tenía el foco antes de empezar.
dictation_inject(text: string, target: InjectionTarget): Promise<InjectionReport>

// Cancela sin transcribir ni insertar.
dictation_cancel(sessionId: string): Promise<void>
```

```ts
type DictationResult = {
  text: string;
  language: string;
  durationMs: number;
  modelId: string;
  polishApplied: boolean;
};

type InjectionTarget =
  | { kind: "focused_window" }        // v1: pegar en la ventana previa
  | { kind: "clipboard_only" };       // fallback: solo dejar en el portapapeles

type InjectionReport = {
  method: "paste" | "keystroke" | "clipboard";
  ok: boolean;
  reason?: string;
};
```

#### Grabación

```ts
recording_targets(): Promise<RecordingTarget[]>

recording_start(opts: StartRecordingOptions): Promise<{ sessionId: string; dir: string }>

recording_pause(sessionId: string): Promise<void>
recording_resume(sessionId: string): Promise<void>

// Detiene la captura, cierra el MP4 y encola la subida. No espera a la subida.
recording_stop(sessionId: string): Promise<{ recordingId: string; sizeBytes: number }>

recording_cancel(sessionId: string): Promise<void>
```

```ts
type RecordingTarget =
  | { kind: "screen"; id: string; name: string; width: number; height: number }
  | { kind: "window"; id: string; name: string; appName: string }
  | { kind: "region"; id: string };   // se define tras seleccionar en pantalla

type StartRecordingOptions = {
  target: RecordingTarget;
  video: { fps: 15 | 30 | 60; quality: "low" | "medium" | "high" };
  microphone?: { deviceId: string; enabled: boolean };
  systemAudio: boolean;
  camera?: { deviceId: string; enabled: boolean };  // v2
  uploadImmediately: boolean;
};
```

#### Subida / biblioteca

```ts
upload_queue(): Promise<UploadJob[]>
upload_retry(jobId: string): Promise<void>
upload_cancel(jobId: string): Promise<void>
upload_pause(jobId: string): Promise<void>

library_list(filter?: { from?: string; to?: string; q?: string }): Promise<Recording[]>
library_get(recordingId: string): Promise<Recording | null>
library_delete(recordingId: string, alsoRemote: boolean): Promise<void>
library_open_in_notion(recordingId: string): Promise<void>
library_copy_link(recordingId: string): Promise<string>
```

```ts
type UploadJob = {
  id: string;
  recordingId: string;
  state: "queued" | "uploading" | "retrying" | "completed" | "failed" | "canceled";
  bytesTotal: number;
  bytesSent: number;
  partsTotal: number;
  partsSent: number;
  attempts: number;
  lastError?: string;
  notionUploadId?: string;
};

type Recording = {
  id: string;
  title: string;
  createdAt: string;          // ISO 8601
  durationMs: number;
  sizeBytes: number;
  localPath: string;
  thumbnailPath?: string;
  notionPageId?: string;      // página donde se adjuntó
  notionFileUrl?: string;     // enlace compartible
  uploadState: UploadJob["state"];
};
```

#### Configuración

```ts
config_get(): Promise<AppConfig>
config_set(patch: Partial<AppConfig>): Promise<AppConfig>

// Secretos: nunca viajan al frontend. Solo se informa si existen.
secrets_status(): Promise<{ notionToken: boolean; proxyToken: boolean }>
secrets_set(key: "notionToken" | "proxyToken", value: string): Promise<void>
secrets_clear(key: "notionToken" | "proxyToken"): Promise<void>

models_status(): Promise<{ id: string; installed: boolean; sizeBytes: number }[]>
models_install(id: string): Promise<void>
```

#### Diagnóstico

```ts
diagnostics_run(): Promise<Diagnostics>
// Comprueba: permisos de captura, permisos de micrófono, accesibilidad (macOS),
// WebView2 presente, keyring disponible, conectividad con Notion/proxy.
```

### 4.2 Eventos (core → UI)

```ts
"recording:tick"          { sessionId, elapsedMs, bytesWritten, droppedFrames }
"recording:segment"       { sessionId, index, bytes, uploaded }
"upload:progress"         { jobId, bytesSent, bytesTotal, partsSent, partsTotal, rateBps }
"upload:state"            { jobId, state, error? }
"dictation:state"         { state: "idle" | "listening" | "transcribing" | "inserting" }
"dictation:partial"       { text }          // solo si el motor lo soporta (v2)
"dictation:level"         { rms }           // medidor de nivel para el indicador
"tray:action"             { action: "record" | "stop" | "settings" | "library" | "quit" }
"app:error"               { scope, message, recoverable }
```

**Regla:** el core **nunca** envía datos que la UI deba persistir. La UI es una proyección
de `AppState`; al arrancar, la UI llama a los getters y reconstruye la vista.

### 4.3 Permisos (capabilities de Tauri)

`src-tauri/capabilities/default.json` solo habilita:

```json
{
  "identifier": "default",
  "windows": ["main", "indicator"],
  "permissions": [
    "core:default",
    "global-shortcut:allow-register",
    "global-shortcut:allow-unregister",
    "global-shortcut:allow-is-registered",
    "dialog:allow-open",
    "notification:allow-notify",
    "shell:allow-open"
  ]
}
```

Todo lo demás (HTTP, filesystem, procesos) pasa por **comandos propios en Rust**, no por
plugins expuestos al frontend. Esto evita que un XSS en la UI pueda exfiltrar el token.

---

## 5. Módulo: Dictado

### 5.1 Pipeline

```
[atajo global]
     │
     ├─ mantener (push-to-talk) ──┐
     └─ doble toque (toggle) ─────┤
                                  ▼
                        ┌──────────────────┐
                        │ AudioCapture     │  cpal: 16 kHz mono i16
                        │ ring buffer      │  VAD opcional (silencio → corte)
                        └────────┬─────────┘
                                 ▼
                        ┌──────────────────┐
                        │ Transcriber      │  whisper-rs (local) | Remote
                        └────────┬─────────┘
                                 ▼
                        ┌──────────────────┐
                        │ TextPolisher     │  reglas: muletillas, puntuación,
                        │                  │  capitalización, números
                        └────────┬─────────┘
                                 ▼
                        ┌──────────────────┐
                        │ TextInjector     │  ver §5.3
                        └──────────────────┘
```

### 5.2 Detección del modo de atajo

- **Push-to-talk:** `on_press` → `dictation_start("push_to_talk")`; `on_release` →
  `dictation_stop`.
- **Toggle:** dos pulsaciones de Bloq Mayús en < 400 ms → `dictation_start("toggle")`.
  Siguiente pulsación → `dictation_stop`.

El plugin `tauri-plugin-global-shortcut` no distingue press/release en todas las plataformas.
**Plan:** usarlo para el registro, y en Windows complementar con un hook de bajo nivel
(`SetWindowsHookEx` WH_KEYBOARD_LL) para capturar el *key-up*. En macOS, `CGEventTap`; en
Linux, X11 `XInput2` (y documentar que Wayland **no soporta** atajos globales en v1).

> **Riesgo R-02:** Wayland. En v1 Linux se soporta bajo X11 y se avisa en el diagnóstico.

### 5.3 Inserción de texto

El objetivo de v1 es "pegar en la ventana que tenía el foco".

```
1. Antes de empezar a dictar, guardar el handle de la ventana activa
   (Windows: GetForegroundWindow · macOS: AXUIElement · Linux: _NET_ACTIVE_WINDOW).
2. Al terminar: escribir el texto en el portapapeles.
3. Reactivar la ventana guardada (SetForegroundWindow / NSRunningApplication.activate).
4. Enviar Ctrl+V (Cmd+V) sintético.
5. Restaurar el portapapeles anterior tras 300 ms.
```

Fallbacks en orden: `keystroke` (escribir carácter a carácter con `SendInput`/`CGEvent`)
→ `clipboard_only` (dejar el texto listo y avisar al usuario).

**macOS:** requiere permiso de *Accesibilidad*. El diagnóstico lo comprueba con
`AXIsProcessTrusted()` y ofrece abrir el panel del sistema.

### 5.4 Modelo y rendimiento

| Modelo | Tamaño | RAM típica | Casualidad |
|---|---|---|---|
| `tiny` | 75 MB | ~300 MB | borrador |
| **`base` (predeterminado)** | 150 MB | ~500 MB | dictado normal |
| `small` | 480 MB | ~1 GB | acentos/ruido |
| `medium` | 1.5 GB | ~2.5 GB | máxima precisión |

Latencia objetivo: **< 1.5 s para 10 s de audio** con `base` en CPU moderna.
Si se supera, se cambia a `tiny` automáticamente y se avisa.

---

## 6. Módulo: Grabación

### 6.1 Captura por plataforma

| | Windows | macOS | Linux |
|---|---|---|---|
| Video | `Windows.Graphics.Capture` (WinRT) | `ScreenCaptureKit` | PipeWire (Wayland) / X11 `XShm` |
| Audio sistema | WASAPI loopback | `ScreenCaptureKit` audio | PipeWire monitor / PulseAudio `.monitor` |
| Micrófono | WASAPI capture | AVAudioEngine | PipeWire / ALSA |
| Permisos | ninguno específico | *Grabación de pantalla* + *Micrófono* | `pipewire` / grupo `audio` |

**Abstracción:**

```rust
trait ScreenCapturer: Send {
    fn start(&mut self, target: &CaptureTarget, fps: u32) -> Result<()>;
    fn next_frame(&mut self, timeout: Duration) -> Result<Option<Frame>>;
    fn stop(&mut self) -> Result<()>;
}

trait AudioCapturer: Send {
    fn start(&mut self, device: Option<&str>) -> Result<()>;
    fn read(&mut self) -> Result<Vec<i16>>;   // 48 kHz estéreo
    fn stop(&mut self) -> Result<()>;
}
```

Cada plataforma implementa ambos traits en `src-tauri/src/platform/{windows,macos,linux}/`.

### 6.2 Codificación

- Contenedor **MP4 fragmentado** (fMP4) con `moov` al principio → reproducible mientras crece
  y reanudable.
- Video **H.264** por hardware cuando esté disponible (`Media Foundation` en Windows,
  `VideoToolbox` en macOS, `VA-API` en Linux) con *fallback* a `openh264` por software.
- Audio **AAC-LC** 128 kbps, mezclando micrófono + sistema en el propio encoder.
- Un **fragmento cada 10 s** (`frag_duration`), que es la unidad de subida.

**Crate:** `ffmpeg-next` queda descartado como dependencia obligatoria (obliga a distribuir
FFmpeg y complica la licencia). Se usa `openh264` + `mp4` crate, ambos permisivos y
compilables estáticamente. Si se necesita más códec, se evalúa en v2.

> **Riesgo R-03:** la codificación por hardware en Windows vía Media Foundation desde Rust
> requiere bindings WinRT (`windows` crate). Presupuestar 1 semana solo para esto.

### 6.3 Almacenamiento temporal

```
%LOCALAPPDATA%\RECO\recordings\<recordingId>\
  ├── meta.json          # estado, target, duración, hashes de segmentos
  ├── seg-00000.m4s      # fragmentos
  ├── seg-00001.m4s
  ├── ...
  ├── init.mp4
  └── final.mp4          # se genera al cerrar (concat de segmentos)
```

Regla de retención: **no se borra nada hasta que Notion confirme `COMPLETED`**.
Configurable: "borrar local tras subir" (por defecto **desactivado**).

Disco: si queda < 2 GB, se pausa la grabación y se avisa. Nunca se corrompe el archivo
por llenar el disco.

### 6.4 Indicador flotante

Ventana Tauri secundaria (`indicator`), `always_on_top`, sin decoración, `skip_taskbar`.
Muestra: punto rojo pulsante, tiempo transcurrido, medidor de nivel, botones pausa/stop.
Se posiciona en la esquina inferior derecha de la pantalla activa y se puede arrastrar.

---

## 7. Módulo: Subida a Notion

### 7.1 Referencia implementada en `envi` (portada, no reinventada)

| Pieza `envi` | Equivalente Rust en RECO |
|---|---|
| `functions/api/upload-init.ts` | `notion::create_upload` |
| `functions/api/upload-part.ts` | `notion::send_part` |
| `functions/api/upload-complete.ts` | `notion::complete_upload` |
| `src/uploadService.ts` (AIMD) | `upload::semaphore::AdaptiveSemaphore` |
| `_shared/notion.ts::resolveUploadMeta` | `notion::resolve_upload_meta` |
| Cola KV de `envi` | `storage::UploadQueue` (SQLite) |

### 7.2 Parámetros (copiados de `envi`, verificar contra Notion antes de codificar)

```
CHUNK_SIZE              = 10 MiB
MULTI_PART_THRESHOLD    = 20 MiB
MAX_FILE_SIZE           = 5 GiB
NOTION_VERSION          = "2026-03-11"   // confirmar vigencia
NOTION_BASE             = "https://api.notion.com/v1"
AIMD start/min/max      = 6 / 2 / 12
COOLDOWN tras 429/503   = 1500 ms
MAX_PART_RETRIES        = 6
BACKOFF                 = min(5s, 400ms · 2^(n-1))
```

### 7.3 Máquina de estados de un trabajo

```
        ┌─────────┐
        │ QUEUED  │
        └────┬────┘
             │ worker toma el trabajo
             ▼
     ┌──────────────┐  429/5xx/timeout   ┌───────────┐
     │  UPLOADING   ├───────────────────►│ RETRYING  │
     └──────┬───────┘   backoff          └─────┬─────┘
            │  complete OK                     │ reintento
            ▼                                  └──────► UPLOADING
     ┌──────────────┐
     │  COMPLETED   │
     └──────────────┘

     Cualquier estado ──(usuario)──► CANCELED
     Errores permanentes (400/401/403/404) ──► FAILED
```

**Idempotencia:** cada trabajo guarda `notionUploadId` en cuanto se crea. Un reintento
reutiliza el mismo upload y **solo reenvía las partes que faltan**. Nunca se duplica un
archivo en Notion.

**Persistencia:** la cola vive en SQLite. Al arrancar la app, los trabajos en
`UPLOADING`/`RETRYING` se reencolan automáticamente.

### 7.4 Destino en Notion

Configuración: `destination.databaseId` (una base de datos) + `destination.pageId` (una
página). Cada grabación crea una **página hija** con:

```
Título:       <fecha> · <título de la grabación>
Propiedades:  Fecha (date) · Duración (number, s) · Tamaño (number, bytes) · Estado (select)
Contenido:    bloque de video (file upload) + bloque de texto con metadatos
```

Se guarda `notionPageId` y `notionFileUrl` en la fila de la grabación.

### 7.5 Subida v1 (flujo realista)

```
recording_stop()
   │
   ├─ 1. cerrar init.mp4 + segmentos en disco
   ├─ 2. concatenar → final.mp4 (rápido, solo copia de átomos)
   ├─ 3. calcular size → número de partes
   ├─ 4. create_upload(mode=multi_part, number_of_parts)
   ├─ 5. subir partes con AIMD (en paralelo)
   ├─ 6. complete_upload()
   ├─ 7. crear página en Notion con el file upload
   └─ 8. emitir "upload:state" = completed
```

Tiempo estimado para 10 min a 1080p30 (~400 MB): la parte de red domina. Con 50 Mbps de
subida son ~64 s, de los que la mayoría se solapan con la codificación.

---

## 8. Módulo: Portal / biblioteca

Lista local (SQLite) + sincronización con Notion (consulta paginada a la BD destino).

- Búsqueda por título/fecha.
- Estado de subida en vivo (`upload:progress`).
- Acciones: abrir carpeta local, abrir en Notion, copiar enlace, reintentar, borrar.
- v2: miniaturas (se extrae un frame del segmento 1) y vista previa embebida.

---

## 9. Estado y persistencia

### 9.1 SQLite (`%APPDATA%\RECO\reco.db`)

```sql
CREATE TABLE recordings (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  duration_ms     INTEGER NOT NULL,
  size_bytes      INTEGER NOT NULL,
  local_path      TEXT NOT NULL,
  thumbnail_path  TEXT,
  notion_page_id  TEXT,
  notion_file_url TEXT,
  state           TEXT NOT NULL
);

CREATE TABLE upload_jobs (
  id                TEXT PRIMARY KEY,
  recording_id      TEXT NOT NULL REFERENCES recordings(id),
  state             TEXT NOT NULL,
  bytes_total       INTEGER NOT NULL,
  bytes_sent        INTEGER NOT NULL DEFAULT 0,
  parts_total       INTEGER NOT NULL,
  parts_sent        INTEGER NOT NULL DEFAULT 0,
  attempts          INTEGER NOT NULL DEFAULT 0,
  notion_upload_id  TEXT,
  last_error        TEXT,
  updated_at        TEXT NOT NULL
);

CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
```

Crate: `rusqlite` con `bundled` (SQLite compilado dentro, sin dependencia del sistema).

### 9.2 Configuración

`AppConfig` en JSON (`%APPDATA%\RECO\config.json`) + secretos en el **keyring del SO**
(`keyring` crate → Credential Manager / Keychain / Secret Service).

```ts
type AppConfig = {
  dictation: {
    enabled: boolean;
    shortcut: string;             // "CapsLock"
    mode: "push_to_talk" | "toggle";
    language: string;             // "auto" | "es" | "en" …
    modelId: string;              // "base"
    polish: boolean;
  };
  recording: {
    video: { fps: 30; quality: "medium" };
    systemAudio: boolean;
    defaultTarget: RecordingTarget | null;
    saveDir: string;
  };
  notion: {
    route: "proxy" | "direct";
    proxyBaseUrl: string | null;
    databaseId: string | null;
    pageId: string | null;
    deleteLocalAfterUpload: boolean;
  };
  system: {
    launchAtLogin: boolean;
    closeToTray: boolean;
    indicatorPosition: { x: number; y: number } | null;
  };
};
```

---

## 10. Seguridad

1. **El token de Notion nunca entra al WebView.** Vive en el keyring; solo Rust lo lee.
2. **Sin HTTP genérico en el frontend.** No se expone `tauri-plugin-http`; las llamadas de
   red son comandos con URL y payload fijos.
3. **CSP estricta** en `tauri.conf.json`:
   `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ipc: http://ipc.localhost`
4. **Rutas validadas** en Rust: cualquier comando que reciba un path lo normaliza y verifica
   que esté dentro de `%APPDATA%\RECO` o del `saveDir` configurado (previene path traversal).
5. **Sin `shell:allow-execute`.** Solo `shell:allow-open` para abrir URLs de Notion.
6. **Actualizaciones firmadas** (`tauri-plugin-updater` con clave pública embebida).
7. **Logs sin secretos**: se serializa `redacted` en los tipos de config antes de loguear.

---

## 11. Estructura del repositorio

```
reco/
├── src/                              # React + TS
│   ├── main.tsx
│   ├── App.tsx
│   ├── components/                   # primitivos reutilizables
│   ├── features/
│   │   ├── dictation/                # indicador, ajustes de atajo/modelo
│   │   ├── recording/                # selección de fuente, controles
│   │   ├── uploads/                  # cola, progreso
│   │   ├── library/                  # portal de grabaciones
│   │   └── settings/                 # configuración general
│   ├── services/
│   │   ├── ipc.ts                    # wrapper tipado sobre invoke/listen
│   │   └── events.ts
│   ├── styles/
│   └── types/                        # contratos de §4 en TS
├── src-tauri/
│   ├── src/
│   │   ├── main.rs
│   │   ├── lib.rs                    # builder, plugins, registro de comandos
│   │   ├── state.rs                  # AppState
│   │   ├── commands/                 # un archivo por módulo (contratos §4)
│   │   │   ├── dictation.rs
│   │   │   ├── recording.rs
│   │   │   ├── upload.rs
│   │   │   ├── library.rs
│   │   │   ├── config.rs
│   │   │   └── diagnostics.rs
│   │   ├── shortcuts/
│   │   ├── dictation/
│   │   │   ├── audio.rs
│   │   │   ├── transcriber.rs        # trait + whisper + remote
│   │   │   ├── polish.rs
│   │   │   └── inject.rs
│   │   ├── recording/
│   │   │   ├── capture.rs            # traits ScreenCapturer / AudioCapturer
│   │   │   ├── encoder.rs            # fMP4 + H.264 + AAC
│   │   │   └── session.rs
│   │   ├── upload/
│   │   │   ├── queue.rs
│   │   │   ├── semaphore.rs          # AIMD
│   │   │   └── worker.rs
│   │   ├── notion/
│   │   │   ├── mod.rs                # NotionSink trait
│   │   │   ├── direct.rs
│   │   │   ├── proxy.rs
│   │   │   └── meta.rs               # resolve_upload_meta
│   │   ├── storage/
│   │   │   ├── db.rs
│   │   │   └── paths.rs
│   │   ├── platform/
│   │   │   ├── windows/
│   │   │   ├── macos/
│   │   │   └── linux/
│   │   └── tray.rs
│   ├── capabilities/default.json
│   ├── icons/
│   ├── Cargo.toml
│   └── tauri.conf.json
├── tests/
│   ├── e2e/                          # WebDriver (tauri-driver)
│   └── fixtures/
├── .github/workflows/release.yml
├── package.json
├── vite.config.ts
└── README.md
```

---

## 12. Fases y criterios de aceptación

### Fase 0 · Esqueleto (1 día)

- [ ] `npm create tauri-app` con React + TS.
- [ ] `npm run tauri dev` abre una ventana con "RECO".
- [ ] `npm run tauri build` produce un `.msi` instalable.
- **Aceptación:** instalador arranca en una máquina limpia con WebView2.

### Fase 1 · Atajos y bandeja (2 días)

- [ ] Atajo global registrado (Bloq Mayús).
- [ ] Icono en bandeja con menú: Grabar · Biblioteca · Ajustes · Salir.
- [ ] Cerrar ventana → queda en bandeja.
- **Aceptación:** el atajo dispara un log aunque la ventana esté oculta.

### Fase 2 · Dictado (5 días)

- [ ] Captura de micrófono (cpal) y medidor de nivel.
- [ ] `whisper-rs` transcribiendo `base` en local.
- [ ] Descarga del modelo con progreso + verificación SHA-256.
- [ ] Inserción por portapapeles + Ctrl+V en la ventana previa.
- **Aceptación:** dictar 20 palabras en Chrome, Word y VS Code; texto correcto en los tres.

### Fase 3 · Grabación en Windows (8 días)

- [ ] Captura WGC de pantalla completa y ventana.
- [ ] WASAPI loopback + micrófono mezclados.
- [ ] fMP4 con fragmentos de 10 s, recuperable tras cierre forzado.
- [ ] Indicador flotante con temporizador.
- **Aceptación:** grabar 5 min, cerrar la app de golpe, reabrir: el video se reproduce hasta
  el último fragmento completo.

### Fase 4 · Subida a Notion (5 días)

- [ ] `create_upload` / `send_part` / `complete_upload` en Rust.
- [ ] Cola SQLite con reintentos y AIMD.
- [ ] Creación de página en Notion con el video adjunto.
- **Aceptación:** subir un archivo de 300 MB con red inestable (cortar el WiFi 10 s a mitad);
  la subida se reanuda y termina sin duplicados.

### Fase 5 · Portal (3 días)

- [ ] Lista con estado en vivo.
- [ ] Copiar enlace, abrir en Notion, reintentar, borrar.
- **Aceptación:** se puede compartir el enlace de una grabación sin abrir la app.

### Fase 6 · Multiplataforma (10 días)

- [ ] macOS: ScreenCaptureKit + permisos + `CGEventTap`.
- [ ] Linux: PipeWire/X11 + limitaciones de Wayland documentadas.
- [ ] GitHub Actions generando `.msi`, `.dmg`, `.AppImage`/`.deb`.
- **Aceptación:** los tres instaladores se descargan de un Release y arrancan.

**Total estimado: ~34 días de trabajo efectivo.**

---

## 13. Riesgos

| ID | Riesgo | Impacto | Mitigación |
|---|---|---|---|
| R-01 | Notion exige `number_of_parts` al crear → no se puede subir *durante* la grabación de forma fiable | Alto | v1 sube justo al parar (segmentos ya en disco). v2: evaluar proxy propio con almacenamiento intermedio. |
| R-02 | Wayland no permite atajos globales ni captura sin portal | Medio | v1 solo X11 en Linux; el diagnóstico avisa. |
| R-03 | Codificación H.264 por hardware desde Rust (Media Foundation/WinRT) | Alto | Spike aislado antes de la Fase 3. Fallback openh264 por software. |
| R-04 | Tamaño del modelo Whisper (150 MB–1.5 GB) | Medio | Descarga en primer uso, nunca en el instalador. |
| R-05 | Audio del sistema en macOS requiere ScreenCaptureKit (macOS 13+) | Medio | Declarar macOS 13 como mínimo. |
| R-06 | API de `file_uploads` de Notion en beta: puede cambiar | Alto | Aislar tras `NotionSink`; un cambio solo toca `notion/direct.rs`. |
| R-07 | El proxy `envi` está pensado para formularios, no para video | Medio | Verificar límite de tamaño/duración por petición en Cloudflare (100 s CPU, 100 MB body en plan gratuito). Probablemente obligue a ruta `Direct` para video. |
| R-08 | Un XSS en la UI podría llamar comandos | Bajo | Sin HTTP/filesystem expuestos; comandos con validación de rutas. |

> **R-07 es el más urgente de verificar**: si el plan gratuito de Cloudflare limita el body
> a 100 MB, el proxy `envi` no sirve para video con partes de 10 MiB sí (10 MiB < 100 MB),
> pero sí para partes. Conclusión preliminar: **el proxy sirve si subimos por partes**,
> que es justo lo que hacemos. Validar en la Fase 4.

---

## 14. Preguntas abiertas (decidir antes de la Fase 4)

1. **Ruta de Notion:** ¿`Proxy` (recomendado, el token queda en Cloudflare) o `Direct`
   (el token vive en el keyring del usuario)? → por defecto `Proxy`.
2. **Base de datos de destino:** ¿en qué BD/página de Notion se crea cada grabación?
   Necesitamos `databaseId` o `pageId` reales para probar.
3. **Idioma del dictado:** ¿siempre español o autodetección? (Afecta al modelo: `base`
   multilingüe pesa lo mismo pero es algo menos preciso que uno monolingüe.)
4. **¿La app se distribuye firmada?** Sin firma, Windows SmartScreen y macOS Gatekeeper
   muestran advertencias. Un certificado de código cuesta ~200–400 USD/año.

---

## 15. Bitácora de implementación

Decisiones tomadas al construir la Fase 0 que corrigen o concretan lo previsto arriba.

### 15.1 Entorno verificado

| Componente | Estado |
|---|---|
| Node.js 24.21 + npm 11.19 | ✅ |
| Rust 1.99 · MSVC x86_64 | ✅ |
| Visual Studio 2022 Build Tools (workload C++) | ✅ instalado durante la Fase 0 |
| WebView2 157 | ✅ presente |
| Tauri CLI 2.12 | ✅ |

**Impedimento real encontrado:** la máquina tenía Rust pero **no** el enlazador de
MSVC. `cargo build` fallaba en el build script de `quote` porque el `link.exe` que
resolvía el PATH era el de Git Bash (`C:\Program Files\Git\usr\bin\link.exe`), que
es un comando POSIX distinto. Bastó instalar las Build Tools; no hay que tocar el
PATH si se compila desde PowerShell.

### 15.2 Cambio de contrato: `serde(rename_all = "camelCase")`

Los tipos de configuración y diagnóstico se serializan en **camelCase** para que el
frontend use los nombres naturales de TypeScript (`modelId`, `systemAudio`). La
proyección en `src/types/ipc.ts` manda sobre §4 en caso de discrepancia: es lo que
el compilador verifica.

### 15.3 Whisper como feature opcional

`whisper-rs` arrastra whisper.cpp y CMake y multiplica el tiempo de compilación.
Se declara como **feature opcional** (`--features whisper`). Sin la feature,
`WhisperTranscriber::new` devuelve un error explicativo en lugar de romper la
compilación. Consecuencia: el dictado no funciona en la build por defecto hasta
que se active la feature. Es deliberado — preferible a que el build diario tarde
10 minutos.

### 15.4 La captura nativa está declarada pero no conectada

`WgcCapturer` y `WasapiLoopback` existen con la interfaz definitiva y devuelven
`NotImplemented` explícito. Esto es intencionado: el pipeline completo (sesión,
encoder, fragmentos, cola) ya compila y se prueba con frames sintéticos, así que
la Fase 3 solo rellena dos funciones, sin rediseñar nada.

La sesión de grabación **falla rápido** si el audio del sistema no se puede abrir,
en vez de grabar video mudo creyendo que tiene audio.

### 15.5 Ajustes por defecto

- Atajo: `CapsLock`, modo mantener pulsado.
- Modelo: `base` (150 MB, ~500 MB de RAM).
- Notion: ruta `Proxy`.
- Cerrar la ventana: se oculta en la bandeja.
- Borrar local tras subir: **desactivado**.

### 15.6 Pruebas que ya corren

17 pruebas unitarias en `cargo test`, sobre las partes con lógica pura:

- Limpieza de texto del dictado (muletillas, espaciado, mayúsculas, puntuación final).
- Remuestreo de audio y mezcla estéreo→mono.
- Conversión de color BGRA→YUV420p y dimensiones pares del encoder.
- Resolución y rechazo de rutas fuera del directorio de la aplicación.
- Análisis de atajos (CapsLock solo, combinaciones, teclas inválidas).
- Mapeo de extensiones a MIME de Notion.

La prueba de limpieza encontró un bug real: la primera versión perdía el espacio
antes de una coma («hola , mundo» → «hola,mundo»). Corregido.

---

*Documento vivo. Cualquier cambio en §4 (contratos IPC) obliga a actualizar este archivo y
`src/types/` en el mismo commit.*
