import type { EngineType } from "../../stores/aiStore";

/**
 * Brand-style SVG icons for each engine type.
 * Uses inline SVG paths with fill="currentColor" for theme adaptation.
 */

function ClaudeLogo({ size, className }: { size: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="currentColor"
      className={className}
      aria-label="Claude"
    >
      {/* Anthropic Claude spark/asterisk symbol */}
      <path d="M8 1.5a.75.75 0 0 1 .75.75v3.94l2.787-2.787a.75.75 0 1 1 1.06 1.06L9.81 7.25H13.75a.75.75 0 0 1 0 1.5H9.81l2.787 2.787a.75.75 0 1 1-1.06 1.06L8.75 9.81v3.94a.75.75 0 0 1-1.5 0V9.81l-2.787 2.787a.75.75 0 0 1-1.06-1.06L6.19 8.75H2.25a.75.75 0 0 1 0-1.5H6.19L3.403 4.463a.75.75 0 0 1 1.06-1.06L7.25 6.19V2.25A.75.75 0 0 1 8 1.5z" />
    </svg>
  );
}

function OpenAILogo({ size, className }: { size: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-label="OpenAI Codex"
    >
      {/* OpenAI hexagonal knot */}
      <path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023l-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365l2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z" />
    </svg>
  );
}

export default function EngineLogo({
  type,
  size = 16,
  className,
}: {
  type: EngineType;
  size?: number;
  className?: string;
}) {
  switch (type) {
    case "claude-code":
      return <ClaudeLogo size={size} className={className} />;
    case "codex":
      return <OpenAILogo size={size} className={className} />;
    default:
      return <ClaudeLogo size={size} className={className} />;
  }
}
