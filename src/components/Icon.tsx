/**
 * Iconos de trazo.
 *
 * Se dibujan aquí, en línea, en vez de usar una fuente de iconos: son cuatro y
 * así no hay petición de red, ni parpadeo de fuente, ni un archivo más en el
 * paquete. Heredan `currentColor`, de modo que el color lo decide el contexto.
 */

const PATHS = {
  mic: (
    <>
      <path d="M12 3.5a2.8 2.8 0 0 0-2.8 2.8v5.4a2.8 2.8 0 0 0 5.6 0V6.3A2.8 2.8 0 0 0 12 3.5Z" />
      <path d="M5.5 11.2a6.5 6.5 0 0 0 13 0" />
      <path d="M12 17.7V21" />
    </>
  ),
  monitor: (
    <>
      <rect x="3" y="4.5" width="18" height="12" rx="2" />
      <path d="M8.5 20.5h7M12 16.5v4" />
    </>
  ),
  grid: (
    <>
      <rect x="4" y="4" width="7" height="7" rx="1.6" />
      <rect x="13" y="4" width="7" height="7" rx="1.6" />
      <rect x="4" y="13" width="7" height="7" rx="1.6" />
      <rect x="13" y="13" width="7" height="7" rx="1.6" />
    </>
  ),
  sliders: (
    <>
      <path d="M4 7h5.5M14.5 7H20M4 12h8M16 12h4M4 17h3M11 17h9" />
      <circle cx="12" cy="7" r="2" />
      <circle cx="14" cy="12" r="2" />
      <circle cx="9" cy="17" r="2" />
    </>
  ),
  keyboard: (
    <>
      <rect x="2.5" y="6.5" width="19" height="11" rx="2" />
      <path d="M6.5 10h.01M10 10h.01M13.5 10h.01M17 10h.01M8 14h8" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17" />
      <path d="M12 3.5c2.6 2.5 2.6 14.5 0 17-2.6-2.5-2.6-14.5 0-17Z" />
    </>
  ),
  cpu: (
    <>
      <rect x="7" y="7" width="10" height="10" rx="2" />
      <rect x="10.5" y="10.5" width="3" height="3" rx="0.8" />
      <path d="M10 3v3M14 3v3M10 18v3M14 18v3M3 10h3M3 14h3M18 10h3M18 14h3" />
    </>
  ),
  document: (
    <>
      <path d="M6 3.5h7.5L18 8v12.5H6z" />
      <path d="M13.5 3.5V8H18" />
      <path d="M9 12h6M9 15.5h4" />
    </>
  ),
  check: <path d="M4.5 12.5 9 17 19.5 6.5" />,
  alert: (
    <>
      <path d="M12 4.5 21 20H3z" />
      <path d="M12 10v4.5M12 17.5h.01" />
    </>
  ),
  play: <path d="M8.5 5.5 19 12 8.5 18.5z" />,
  stop: <rect x="7" y="7" width="10" height="10" rx="1.6" />,
  download: <path d="M12 4v10.5M7.5 10.5 12 15l4.5-4.5M5 20h14" />,
  sparkle: (
    <>
      <path d="M10 3.5 11.7 8.3 16.5 10l-4.8 1.7L10 16.5 8.3 11.7 3.5 10l4.8-1.7z" />
      <path d="M18 14.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" />
    </>
  ),
  speaker: (
    <>
      <path d="M4 9.5h3.5L12 5.5v13L7.5 14.5H4z" />
      <path d="M15.5 9.2a4 4 0 0 1 0 5.6M18.2 6.6a7.6 7.6 0 0 1 0 10.8" />
    </>
  ),
  link: (
    <>
      <path d="M10.5 13.5a4 4 0 0 0 5.7 0l2.8-2.8a4 4 0 0 0-5.7-5.7l-1.6 1.6" />
      <path d="M13.5 10.5a4 4 0 0 0-5.7 0l-2.8 2.8a4 4 0 0 0 5.7 5.7l1.6-1.6" />
    </>
  ),
  close: <path d="M6 6l12 12M18 6 6 18" />,
  minimize: <path d="M6 12h12" />,
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({
  name,
  size = 15,
  className,
}: {
  name: IconName;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      className={className ? `icon ${className}` : "icon"}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
