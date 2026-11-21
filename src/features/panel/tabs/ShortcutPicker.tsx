/**
 * Selector de atajo global.
 *
 * Captura la combinación en el propio campo, sin diálogo aparte: es lo que se
 * espera al pulsar «cambiar atajo». Se valida contra el sistema antes de
 * guardar para no quedarse sin dictado por una combinación que otra aplicación
 * ya tiene ocupada.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { Icon } from "../../../components/Icon";
import { ipc, toMessage } from "../../../services/ipc";

/** Traduce un evento de teclado al formato que entiende el núcleo. */
function toSpec(e: React.KeyboardEvent): string | null {
  const key = e.key;

  // Los modificadores solos no forman un atajo válido.
  if (["Control", "Shift", "Alt", "Meta"].includes(key)) return null;

  const parts: string[] = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  if (e.metaKey) parts.push("Super");

  let name: string;
  if (key === " ") name = "Space";
  else if (key === "Escape") name = "Escape";
  else if (key === "Tab") name = "Tab";
  else if (key === "Enter") name = "Enter";
  else if (key === "Backspace") name = "Backspace";
  else if (/^F\d{1,2}$/.test(key)) name = key;
  else if (/^[a-zA-Z]$/.test(key)) name = key.toUpperCase();
  else if (/^\d$/.test(key)) name = key;
  else if (key === "CapsLock") name = "CapsLock";
  else return null;

  // Una letra o un número sueltos escribirían texto constantemente: se exige
  // modificador salvo en teclas que no producen caracteres.
  const bare = [
    "CapsLock",
    "Escape",
    "Tab",
    "F1",
    "F2",
    "F3",
    "F4",
    "F5",
    "F6",
    "F7",
    "F8",
    "F9",
    "F10",
    "F11",
    "F12",
  ];
  if (parts.length === 0 && !bare.includes(name)) return null;

  parts.push(name);
  return parts.join("+");
}

export function ShortcutPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  const [capturing, setCapturing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const boxRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (capturing) boxRef.current?.focus();
  }, [capturing]);

  const commit = useCallback(
    async (spec: string) => {
      setError(null);
      try {
        await ipc.config.validateShortcut(spec);
        onChange(spec);
      } catch (e) {
        setError(toMessage(e));
      } finally {
        setCapturing(false);
      }
    },
    [onChange],
  );

  return (
    <div className="field">
      <span className="field-label">
        <Icon name="keyboard" size={13} /> Atajo
      </span>

      <button
        ref={boxRef}
        type="button"
        className={`key-capture ${capturing ? "is-capturing" : ""}`}
        onClick={() => {
          setError(null);
          setCapturing(true);
        }}
        onBlur={() => setCapturing(false)}
        onKeyDown={(e) => {
          if (!capturing) return;
          e.preventDefault();

          if (e.key === "Escape") {
            setCapturing(false);
            return;
          }

          const spec = toSpec(e);
          if (spec) void commit(spec);
        }}
      >
        {capturing ? "Pulsa la combinación…" : value}
      </button>

      {error && <span className="field-note is-warn">{error}</span>}
      {!capturing && !error && (
        <span className="field-note">
          Clic y pulsa la tecla. Vale cualquier tecla sola sin modificador
          (CapsLock, F1…); las letras necesitan Ctrl, Alt o Shift.
        </span>
      )}
    </div>
  );
}
