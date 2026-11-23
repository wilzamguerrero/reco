const server = "http://127.0.0.1:8766";

export type PocketWebLanguage = "spanish" | "english";

export const pocketWebVoices = [
  ["jane", "Jane · conversación"], ["alba", "Alba · lectura"],
  ["bill_boerst", "Bill Boerst · lectura"], ["caro_davy", "Caro Davy · lectura"],
  ["peter_yearsley", "Peter Yearsley · lectura"], ["stuart_bell", "Stuart Bell · lectura"],
  ["anna", "Anna · conversación"], ["azelma", "Azelma · lectura"],
  ["charles", "Charles · conversación"], ["eponine", "Eponine · lectura"],
  ["eve", "Eve · conversación"], ["fantine", "Fantine · lectura"],
  ["george", "George · conversación"], ["mary", "Mary · conversación"],
  ["michael", "Michael · conversación"], ["paul", "Paul · conversación"],
  ["vera", "Vera · conversación"], ["jean", "Jean · conversación"],
  ["daan", "Daan · neerlandés"], ["estelle", "Estelle · francés"],
  ["giovanni", "Giovanni · italiano"], ["juergen", "Juergen · alemán"],
  ["lola", "Lola · español"], ["rafael", "Rafael · portugués de Brasil"],
  ["cosette", "Cosette"], ["javert", "Javert"], ["marius", "Marius"],
].map(([id, label]) => ({ id, label }));

export function pocketLanguage(language: PocketWebLanguage | undefined, voice: string): PocketWebLanguage {
  return language ?? (voice === "jane" ? "english" : "spanish");
}

// Verify the service before sending a transcript to a local port.
export async function hasKyutaiServer(signal: AbortSignal): Promise<boolean> {
  try {
    const response = await fetch(server + "/openapi.json", {
      signal: AbortSignal.any([signal, AbortSignal.timeout(800)]),
      redirect: "error",
    });
    if (!response.ok) return false;
    const api = await response.json();
    return api.info?.title === "Kyutai Pocket TTS API" && Boolean(api.paths?.["/tts"]?.post);
  } catch {
    signal.throwIfAborted();
    return false;
  }
}

export async function* streamKyutai(text: string, voice: string, signal: AbortSignal, language?: PocketWebLanguage) {
  const timeout = new AbortController();
  const expire = () => timeout.abort(new Error("Pocket dejó de enviar audio"));
  let timer = setTimeout(expire, 30_000);
  try {
    const endpoint = language
      ? `https://pocket-tts-api.kyutai.org/${language}/tts`
      : server + "/tts";
    const form = new FormData();
    form.set("text", text);
    form.set("voice_url", voice);
    const response = await fetch(endpoint, {
      method: "POST",
      body: form,
      credentials: "omit",
      cache: "no-store",
      signal: AbortSignal.any([signal, timeout.signal]),
      redirect: "error",
    });
    if (!response.ok || !response.body) throw new Error(`Pocket HTTP ${response.status}`);
    const reader = response.body.getReader();
    // Kyutai writes a canonical PCM16 mono WAV with a placeholder data size.
    // HTTP packet boundaries can split the 44-byte header or a single sample.
    let tail = new Uint8Array(0);
    let rate = 0;
    let samples = 0;
    try {
      while (true) {
        clearTimeout(timer);
        timer = setTimeout(expire, 30_000);
        const { value, done } = await reader.read();
        clearTimeout(timer);
        if (done) break;
        const bytes = new Uint8Array(tail.length + value.length);
        bytes.set(tail);
        bytes.set(value, tail.length);
        const view = new DataView(bytes.buffer);
        let offset = 0;
        if (!rate) {
          if (bytes.length < 44) { tail = bytes; continue; }
          if (view.getUint32(0) !== 0x52494646 || view.getUint32(8) !== 0x57415645 ||
              view.getUint32(36) !== 0x64617461 || view.getUint16(20, true) !== 1 ||
              view.getUint16(22, true) !== 1 || view.getUint16(34, true) !== 16) {
            throw new Error("Formato de audio Pocket incompatible");
          }
          rate = view.getUint32(24, true);
          if (rate < 8000 || rate > 96000) throw new Error("Frecuencia de audio Pocket inválida");
          offset = 44;
        }
        const pcm = new Float32Array(Math.floor((bytes.length - offset) / 2));
        for (let i = 0; i < pcm.length; i++) pcm[i] = view.getInt16(offset + i * 2, true) / 32768;
        tail = bytes.slice(offset + pcm.length * 2);
        samples += pcm.length;
        if (pcm.length) yield { pcm, rate };
      }
      if (!samples || tail.length) throw new Error("Audio Pocket incompleto");
    } finally {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  } finally {
    clearTimeout(timer);
    timeout.abort();
  }
}
