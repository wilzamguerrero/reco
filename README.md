# RECO

Dictado local por voz y grabación de pantalla con subida por partes a Notion.
Una app de escritorio multiplataforma construida con Tauri 2, React y Rust.

**Estado:** Fase 0 completada — el esqueleto compila, arranca y empaqueta.

---

## Qué es

RECO reúne dos herramientas que normalmente se usan por separado:

- **Dictado local**, al estilo de Wispr Flow: mantienes una tecla (Bloq Mayús por
  defecto), hablas, y el texto aparece en la aplicación que estabas usando. La
  transcripción corre en tu equipo, sin enviar audio a ningún servicio.
- **Grabación de pantalla con subida a Notion**, al estilo de Loom: grabas la
  pantalla con micrófono y audio del sistema, y la grabación se sube por partes
  a tu espacio de Notion, donde queda disponible como página compartible.

La arquitectura completa, las decisiones de diseño y los riesgos conocidos están
en [ARCHITECTURE.md](ARCHITECTURE.md).

---

## Requisitos

| Herramienta | Versión | Para qué |
|---|---|---|
| Node.js | 20 o superior | Compilar la interfaz |
| Rust | 1.77 o superior | Núcleo de la aplicación |
| Visual Studio Build Tools | 2022 | Enlazador de MSVC en Windows |
| WebView2 | cualquiera reciente | Motor de la interfaz (viene con Windows 11) |

En Windows, instala las Build Tools con el workload **Desarrollo para el escritorio
con C++**:

```powershell
winget install --id Microsoft.VisualStudio.2022.BuildTools `
  --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

En Linux necesitas además las dependencias de WebKitGTK y `libasound2-dev`.
En macOS, las Command Line Tools de Xcode.

---

## Puesta en marcha

```bash
npm install
npm run tauri:dev
```

La primera compilación de Rust tarda varios minutos: descarga y compila unas 400
dependencias. Las siguientes son de segundos.

Para generar un instalador:

```bash
npm run tauri:build
```

Los artefactos quedan en `src-tauri/target/release/bundle/`.

---

## Estructura

```
reco/
├── src/                        Interfaz (React + TypeScript)
│   ├── features/               Una carpeta por sección de la app
│   ├── services/ipc.ts         Wrapper tipado sobre los comandos de Tauri
│   ├── styles/                 Variables de diseño y layout
│   └── types/ipc.ts            Contratos con el núcleo (proyección de §4)
├── src-tauri/src/              Núcleo (Rust)
│   ├── commands/               Comandos expuestos al frontend
│   ├── dictation/              Audio, transcripción, limpieza, inserción
│   ├── recording/              Captura, codificación, sesión
│   ├── notion/                 Cliente de Notion (ruta directa y proxy)
│   ├── platform/               Implementaciones por sistema operativo
│   ├── storage/                SQLite y rutas de datos
│   └── state.rs                Estado compartido
├── ARCHITECTURE.md             Documento de arquitectura
└── README.md
```

---

## Estado por fases

| Fase | Contenido | Estado |
|---|---|---|
| 0 | Esqueleto Tauri, compilación, empaquetado | ✅ terminada |
| 1 | Atajos globales y bandeja del sistema | 🚧 en curso |
| 2 | Dictado con transcripción local | 🚧 en curso |
| 3 | Captura de pantalla nativa en Windows | ⏳ pendiente |
| 4 | Subida por partes a Notion | ⏳ pendiente |
| 5 | Portal de grabaciones | ⏳ pendiente |
| 6 | macOS, Linux y distribución | ⏳ pendiente |

Lo que ya funciona hoy:

- La app arranca, muestra cuatro secciones y se cierra a la bandeja.
- La bandeja graba y detiene sin abrir la ventana, y el menú se habilita o
  deshabilita según el estado real.
- La configuración se guarda de forma atómica en disco.
- Los secretos se guardan en el llavero del sistema operativo, nunca en texto plano.
- El diagnóstico informa de las capacidades reales de esta compilación, no de lo
  que el sistema operativo soporta en teoría.
- Grabación de micrófono con remuestreo a 16 kHz mono.
- Descarga de modelos con progreso y verificación de tamaño, y caché del modelo
  cargado entre dictados.
- El motor de limpieza de texto (`dictation/polish.rs`) está completo y probado.
- La conversión de color para el codificador H.264 está probada.

Lo que devuelve «no implementado» de forma explícita, sin fallar en silencio:

- La captura real de pantalla y de audio del sistema (Fase 3).
- La transcripción si compilas sin `--features whisper`.
- La subida a Notion (el cliente está escrito; falta conectar la cola, Fase 4).

---

## Compilar con transcripción local

El motor Whisper no se compila por defecto porque arrastra whisper.cpp, lo que
multiplica el tiempo de compilación. Para activarlo:

```bash
npm run tauri:dev -- --features whisper
```

Requisitos de compilación (solo la primera vez):

| Plataforma | Necesitas |
|---|---|
| Windows | Visual Studio Build Tools (C++), CMake y LLVM (para `libclang`) |
| macOS | Xcode Command Line Tools, CMake y LLVM |
| Linux | `build-essential`, `cmake`, `libclang-dev` |

En Windows, CMake y LLVM no siempre quedan en `PATH` al instalarlos. Este
proyecto fija `LIBCLANG_PATH` en [`.cargo/config.toml`](src-tauri/.cargo/config.toml);
si instalas LLVM en otra ruta, exporta la variable antes de compilar.

Los modelos se descargan desde la propia app (Dictado → Motores disponibles). La
descarga va a un archivo `.part` y solo se renombra al destino cuando el tamaño
coincide, así una descarga cortada no deja un modelo corrupto. El modelo cargado
se reutiliza entre dictados: el primer dictado tras arrancar tarda más.

---

## Privacidad

- El audio del dictado no sale del equipo: se procesa con un modelo local.
- El token de Notion se guarda en el llavero del sistema operativo (Credential
  Manager en Windows, Keychain en macOS, Secret Service en Linux).
- La interfaz no tiene acceso a red ni a disco: solo puede llamar a los comandos
  del núcleo, que validan sus argumentos.
- No hay telemetría.

---

## Licencia

Pendiente de definir.
