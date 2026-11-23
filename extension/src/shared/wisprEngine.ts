import { cleanDictatedChunk } from "./polish";
import type { SpeechEngineHandle, SpeechEngineOptions } from "./speechEngine";

export const WISPR_SESSION_KEY = "reco_wispr_api_key";
const api = "https://platform-api.wisprflow.ai/api/v1/dash";
const sampleRate = 16000;
const packetSize = 2048;

async function clientToken() {
  const stored = await chrome.storage.session.get(WISPR_SESSION_KEY);
  const key = stored[WISPR_SESSION_KEY];
  if (!key) throw new Error("Ingresá tu clave de Wispr Flow en Dictar.");
  const response = await fetch(api + "/generate_access_token", {
    method: "POST",
    headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: "reco-" + crypto.randomUUID(), duration_secs: 3600 }),
    signal: AbortSignal.timeout(10000),
    cache: "no-store",
    redirect: "error",
  });
  if (!response.ok) throw new Error(`Wispr Flow: no se pudo autorizar el dictado (HTTP ${response.status}).`);
  const data = await response.json();
  if (typeof data.access_token !== "string" || !data.access_token) throw new Error("Wispr no devolvió un token.");
  return { value: data.access_token, expires: Date.now() + (Number(data.expires_in) || 3600) * 1000 };
}

type Packet = { audio: string; volume: number };

function openUtterance(token: Promise<{ value: string }>, language: string | undefined, partial: (text: string) => void) {
  let socket: WebSocket | undefined;
  let position = 0;
  let ended = false;
  let ready = false;
  let settled = false;
  let queue: Packet[] = [];
  let resolve!: (text: string) => void;
  let reject!: (error: Error) => void;
  const result = new Promise<string>((ok, fail) => { resolve = ok; reject = fail; });
  let timer = setTimeout(() => finish("", new Error("Wispr tardó demasiado en conectar.")), 15000);
  function finish(text: string, error?: Error) {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    queue = [];
    socket?.close();
    if (error) reject(error);
    else resolve(text);
  }
  function flush() {
    if (!ready || settled || !socket) return;
    if (queue.length) {
      socket.send(JSON.stringify({ type: "append", position, audio_packets: {
        packets: queue.map(p => p.audio), volumes: queue.map(p => p.volume),
        packet_duration: packetSize / sampleRate, audio_encoding: "wav", byte_encoding: "base64",
      } }));
      position += queue.length;
      queue = [];
    }
    if (ended) {
      socket.send(JSON.stringify({ type: "commit", total_packets: position }));
      clearTimeout(timer);
      timer = setTimeout(() => finish("", new Error("Wispr no devolvió la transcripción.")), 12000);
    }
  }
  void token.then(({ value }) => {
    if (settled) return;
    socket = new WebSocket("wss://platform-api.wisprflow.ai/api/v1/dash/client_ws?client_key=" +
      encodeURIComponent("Bearer " + value));
    socket.onopen = () => socket?.send(JSON.stringify({ type: "auth", access_token: value,
      language: language && language !== "auto" ? [language.split("-")[0]] : undefined }));
    socket.onmessage = event => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.status === "auth" && !ready) { ready = true; clearTimeout(timer); flush(); }
        else if (msg.status === "error") finish("", new Error("Wispr rechazó la sesión de dictado."));
        else if (msg.status === "text") {
          if (msg.final) finish(msg.body?.text ?? "");
          else if (msg.body?.text) partial(msg.body.text);
        }
      } catch { finish("", new Error("Respuesta de Wispr inválida.")); }
    };
    socket.onclose = socket.onerror = () => finish("", new Error("Se perdió la conexión con Wispr."));
  }).catch(error => finish("", error));
  return {
    result,
    append(packet: Packet) { if (!ended && !settled) { queue.push(packet); flush(); } },
    commit() { if (!ended) { ended = true; flush(); } },
  };
}

export function createWisprEngine(opts: SpeechEngineOptions): SpeechEngineHandle {
  let running = false;
  let stream: MediaStream | undefined;
  let ctx: AudioContext | undefined;
  let node: ScriptProcessorNode | undefined;
  let token: Awaited<ReturnType<typeof clientToken>>;
  let renewal: ReturnType<typeof clientToken> | undefined;
  let phrase: ReturnType<typeof openUtterance> | undefined;
  let delivery = Promise.resolve();
  let stopping: Promise<void> | undefined;
  let sequence = 0;
  let pending = 0;
  let silence = 0;
  let frames = 0;
  let preRoll: Packet[] = [];
  let newSentence = true;

  function closeMic() {
    if (node) { node.onaudioprocess = null; node.disconnect(); node = undefined; }
    stream?.getTracks().forEach(track => track.stop());
    stream = undefined;
    if (ctx) void ctx.close().catch(() => {});
    ctx = undefined;
    opts.onLevel?.(0);
  }
  function endPhrase() { phrase?.commit(); phrase = undefined; frames = silence = 0; }
  function beginPhrase() {
    const id = "wispr-" + (++sequence);
    if (Date.now() >= token.expires - 60000 && !renewal) {
      renewal = clientToken().then(next => token = next).finally(() => { renewal = undefined; });
    }
    const session = openUtterance(renewal ?? Promise.resolve(token), opts.language, text => {
      if (phrase === session && pending === 1) opts.onInterim?.(text);
    });
    phrase = session;
    pending++;
    const output = session.result.then(text => ({ text, error: "" }), err => ({ text: "", error: String(err.message || err) }));
    delivery = delivery.then(async () => {
      const { text, error } = await output;
      pending--;
      if (session === phrase) endPhrase();
      if (error) { opts.onError?.(error, false); return; }
      const cleaned = cleanDictatedChunk(text, {
        polish: opts.polish ?? true, autoCapitalize: opts.autoCapitalize ?? true, isNewSentence: newSentence,
      });
      if (cleaned) {
        newSentence = /[.!?…]$/.test(cleaned);
        opts.onLive?.({ utteranceId: id, text: cleaned, isFinal: true });
        opts.onFinal?.(cleaned);
      }
      if (!phrase) opts.onInterim?.("");
    });
    for (const packet of preRoll) session.append(packet);
    preRoll = [];
    return session;
  }
  return {
    async start() {
      if (running) return;
      if (stopping) await stopping;
      running = true;
      try {
        token = await clientToken();
        if (!running) return;
        const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
        if (!running) { mic.getTracks().forEach(track => track.stop()); return; }
        stream = mic;
        ctx = new AudioContext({ sampleRate });
        await ctx.resume();
        if (!running || !ctx) return;
        node = ctx.createScriptProcessor(packetSize, 1, 1);
        node.onaudioprocess = event => {
          const samples = event.inputBuffer.getChannelData(0);
          const pcm = new DataView(new ArrayBuffer(samples.length * 2));
          let energy = 0;
          for (let i = 0; i < samples.length; i++) {
            energy += samples[i] * samples[i];
            pcm.setInt16(2 * i, Math.round(Math.min(1, Math.max(-1, samples[i])) * 32767), true);
          }
          const volume = Math.sqrt(energy / samples.length);
          opts.onLevel?.(volume);
          const packet = { audio: btoa(String.fromCharCode(...new Uint8Array(pcm.buffer))), volume };
          if (!phrase && volume < 0.012) { preRoll.push(packet); if (preRoll.length > 2) preRoll.shift(); return; }
          (phrase ?? beginPhrase()).append(packet);
          frames++;
          silence = volume < 0.012 ? silence + 1 : 0;
          if (silence >= 4 || frames >= 230) endPhrase();
        };
        ctx.createMediaStreamSource(mic).connect(node);
        node.connect(ctx.destination);
        opts.onReady?.();
      } catch (err) { running = false; closeMic(); throw err; }
    },
    stop() {
      if (!running) return stopping;
      running = false;
      closeMic();
      endPhrase();
      preRoll = [];
      stopping = delivery.finally(() => { opts.onStop?.(); stopping = undefined; });
      return stopping;
    },
    isRunning: () => running,
    updateOptions: patch => { Object.assign(opts, patch); },
  };
}
