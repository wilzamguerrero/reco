import type { SVGProps } from "react";

export type IconName =
  | "mic"
  | "monitor"
  | "grid"
  | "notion"
  | "play"
  | "stop"
  | "pause"
  | "check"
  | "copy"
  | "external"
  | "trash"
  | "download"
  | "refresh"
  | "panel"
  | "spark"
  | "target"
  | "desktop"
  | "globe"
  | "bolt"
  | "audio"
  | "eye"
  | "clip"
  | "send";

/**
 * Íconos geométricos planos estilo Bauhaus / Neo-Brutalist.
 * Primitivas sólidas, cortes rectos y alto contraste sin trazos redondeados blandos.
 */
export function Icon({
  name,
  size = 16,
  ...rest
}: { name: IconName; size?: number } & Omit<SVGProps<SVGSVGElement>, "width" | "height">) {
  const common: SVGProps<SVGSVGElement> = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "currentColor",
    "aria-hidden": true,
    ...rest,
  };

  switch (name) {
    case "mic":
      return (
        <svg {...common}>
          <rect x="8.5" y="2.5" width="7" height="11.5" rx="3.5" />
          <path d="M5 11.5h2.4a4.6 4.6 0 0 0 9.2 0H19a7 7 0 0 1-5.8 6.9V20h3.8v2.2H7V20h3.8v-1.6A7 7 0 0 1 5 11.5Z" />
        </svg>
      );
    case "monitor":
      return (
        <svg {...common}>
          <path d="M2 3.5h20v14H2v-14Zm2.4 2.4v9.2h15.2V5.9H4.4Z" />
          <circle cx="12" cy="10.5" r="2.8" />
          <rect x="7" y="19.5" width="10" height="2.2" />
        </svg>
      );
    case "grid":
      // 4 Bauhaus geometric primitives: square, circle, triangle, half-circle
      return (
        <svg {...common}>
          <rect x="3" y="3" width="8" height="8" />
          <circle cx="17" cy="7" r="4" />
          <polygon points="7,13 11,21 3,21" />
          <path d="M13 17a4 4 0 0 1 8 0v4h-8v-4Z" />
        </svg>
      );
    case "notion":
      return (
        <svg {...common}>
          <path d="M3.5 3.5h17v17h-17v-17Zm2.4 2.4v12.2h12.2V5.9H5.9Z" />
          <path d="M8.5 8h2.3l4.7 6.2V8h2.1v8.2h-2.3l-4.7-6.2v6.2H8.5V8Z" />
        </svg>
      );
    case "spark":
      // Claude-inspired flat 8-ray geometric starburst
      return (
        <svg {...common}>
          <rect x="10.8" y="2" width="2.4" height="7" />
          <rect x="10.8" y="15" width="2.4" height="7" />
          <rect x="2" y="10.8" width="7" height="2.4" />
          <rect x="15" y="10.8" width="7" height="2.4" />
          <rect x="10.8" y="3" width="2.4" height="6" transform="rotate(45 12 12)" />
          <rect x="10.8" y="15" width="2.4" height="6" transform="rotate(45 12 12)" />
          <rect x="10.8" y="3" width="2.4" height="6" transform="rotate(-45 12 12)" />
          <rect x="10.8" y="15" width="2.4" height="6" transform="rotate(-45 12 12)" />
          <circle cx="12" cy="12" r="2.2" />
        </svg>
      );
    case "target":
      // Bauhaus split-circle & dot (matches floating control emblem)
      return (
        <svg {...common}>
          <path d="M12 2.5a9.5 9.5 0 1 0 0 19 9.5 9.5 0 0 0 0-19Zm0 2.4A7.1 7.1 0 0 1 19.1 12H4.9A7.1 7.1 0 0 1 12 4.9Zm0 14.2a7.1 7.1 0 0 1-6.7-4.8h13.4a7.1 7.1 0 0 1-6.7 4.8Z" />
          <circle cx="12" cy="15.8" r="1.7" />
        </svg>
      );
    case "desktop":
      // Brutalist app window with sharp cursor block
      return (
        <svg {...common}>
          <path d="M2.5 4h19v16h-19V4Zm2.2 4.2v9.6h14.6V8.2H4.7Z" />
          <rect x="7" y="10.8" width="2.6" height="4.8" />
          <rect x="11.2" y="13.4" width="5.6" height="2.2" />
        </svg>
      );
    case "globe":
      // Geometric Bauhaus split meridian circle
      return (
        <svg {...common}>
          <path d="M12 2.5a9.5 9.5 0 1 0 0 19 9.5 9.5 0 0 0 0-19Zm7 8.3h-3.4a13 13 0 0 0-1.3-5.4A7.2 7.2 0 0 1 19 10.8ZM12 4.9c.9 1.4 1.5 3.5 1.7 5.9h-3.4c.2-2.4.8-4.5 1.7-5.9ZM5 13.2h3.4c.2 2 .7 3.9 1.3 5.4A7.2 7.2 0 0 1 5 13.2Zm3.4-2.4H5a7.2 7.2 0 0 1 4.7-5.4 13 13 0 0 0-1.3 5.4Zm3.6 8.3c-.9-1.4-1.5-3.5-1.7-5.9h3.4c-.2 2.4-.8 4.5-1.7 5.9Zm2.3-.5c.6-1.5 1.1-3.4 1.3-5.4H19a7.2 7.2 0 0 1-4.7 5.4Z" />
        </svg>
      );
    case "bolt":
      return (
        <svg {...common}>
          <polygon points="13.5,2 4.5,13.5 11.2,13.5 10.2,22 19.5,10.5 12.8,10.5" />
        </svg>
      );
    case "audio":
      return (
        <svg {...common}>
          <polygon points="3,9 8,9 14,4 14,20 8,15 3,15" />
          <rect x="16.5" y="8" width="2.2" height="8" />
          <rect x="20" y="5.5" width="2.2" height="13" />
        </svg>
      );
    case "play":
      return (
        <svg {...common}>
          <polygon points="6,4 20,12 6,20" />
        </svg>
      );
    case "stop":
      return (
        <svg {...common}>
          <rect x="5" y="5" width="14" height="14" />
        </svg>
      );
    case "pause":
      return (
        <svg {...common}>
          <rect x="5" y="4" width="5" height="16" />
          <rect x="14" y="4" width="5" height="16" />
        </svg>
      );
    case "check":
      return (
        <svg {...common}>
          <polygon points="9.5,18.2 3.8,12.5 5.8,10.5 9.5,14.2 18.2,5.5 20.2,7.5" />
        </svg>
      );
    case "copy":
      return (
        <svg {...common}>
          <path d="M8 8h12.5v12.5H8V8Zm2.2 2.2v8.1h8.1v-8.1h-8.1Z" />
          <path d="M3.5 3.5H16V6H6v10H3.5V3.5Z" />
        </svg>
      );
    case "external":
      return (
        <svg {...common}>
          <path d="M13 3.5h7.5V11H18V7.6l-6.6 6.6-1.7-1.7L16.3 6H13V3.5Z" />
          <path d="M4 5.5h6.5V8H6.5v9.5H16v-4h2.5V20H4V5.5Z" />
        </svg>
      );
    case "trash":
      return (
        <svg {...common}>
          <rect x="8.5" y="3" width="7" height="2.2" />
          <rect x="3.5" y="6.2" width="17" height="2.2" />
          <path d="M5.5 9.5h13l-1.2 11.5H6.7L5.5 9.5Zm3.8 2.4v6.6h2v-6.6h-2Zm3.4 0v6.6h2v-6.6h-2Z" />
        </svg>
      );
    case "download":
      return (
        <svg {...common}>
          <polygon points="10.8,3 13.2,3 13.2,12.2 16.5,8.9 18.2,10.6 12,16.8 5.8,10.6 7.5,8.9 10.8,12.2" />
          <rect x="4" y="18.2" width="16" height="2.4" />
        </svg>
      );
    case "refresh":
      return (
        <svg {...common}>
          <path d="M19.5 4.5v6h-6V8.3h2.5A5.5 5.5 0 0 0 6.8 10H4.3a7.9 7.9 0 0 1 13.1-3.3V4.5h2.1ZM4.5 19.5v-6h6v2.2H8a5.5 5.5 0 0 0 9.2-1.7h2.5a7.9 7.9 0 0 1-13.1 3.3v2.2H4.5Z" />
        </svg>
      );
    case "panel":
      return (
        <svg {...common}>
          <path d="M2.5 3.5h19v17h-19v-17Zm2.2 2.2v12.6h9.6V5.7H4.7Zm11.8 0v12.6h2.8V5.7h-2.8Z" />
        </svg>
      );
    case "eye":
      return (
        <svg {...common}>
          <path d="M2 12c2.5-4.5 6-6.8 10-6.8S19.5 7.5 22 12c-2.5 4.5-6 6.8-10 6.8S4.5 16.5 2 12Zm10 3.6a3.6 3.6 0 1 0 0-7.2 3.6 3.6 0 0 0 0 7.2Z" />
          <circle cx="12" cy="12" r="1.7" />
        </svg>
      );
    case "clip":
      return (
        <svg {...common}>
          <path d="M7 13.5V7a5 5 0 0 1 10 0v8.5a3.5 3.5 0 0 1-7 0V8.5h2.2v7a1.3 1.3 0 0 0 2.6 0V7a2.8 2.8 0 0 0-5.6 0v6.5a5 5 0 0 0 10 0V8H21v5.5a7 7 0 0 1-14 0Z" />
        </svg>
      );
    case "send":
      return (
        <svg {...common}>
          <polygon points="3,4 21,12 3,20 6.5,12" />
        </svg>
      );
  }
}
