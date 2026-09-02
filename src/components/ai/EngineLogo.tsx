import type { EngineType } from "../../lib/ai-harnesses";

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
      <path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023l-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365l2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z" />
    </svg>
  );
}

function GrokLogo({ size, className }: { size: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-label="Grok"
    >
      <path d="M12 2.2l1.15 6.1 5.35-3.2-3.2 5.35 6.1 1.15-6.1 1.15 3.2 5.35-5.35-3.2L12 21.8l-1.15-6.1-5.35 3.2 3.2-5.35L2.6 12.4l6.1-1.15-3.2-5.35 5.35 3.2L12 2.2z" />
    </svg>
  );
}

function CursorLogo({ size, className }: { size: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-label="Cursor"
    >
      <path d="M4 3.2l16.5 8.1c.7.35.7 1.35 0 1.7L13 16.1l-2.4 6.2c-.28.72-1.28.78-1.66.1L4 3.2z" />
    </svg>
  );
}

function OpenClawLogo({ size, className }: { size: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-label="OpenClaw"
    >
      <path d="M12 4c1.4 0 2.6.8 3.2 2 .9-.4 2-.4 2.9.2 1.3.9 1.6 2.6.8 3.9-.3.4-.6.8-1 1.1 1.1.7 1.8 1.9 1.8 3.3 0 2.2-1.8 4-4 4H8.3c-2.2 0-4-1.8-4-4 0-1.4.7-2.6 1.8-3.3-.4-.3-.7-.7-1-1.1-.8-1.3-.5-3 .8-3.9.9-.6 2-.6 2.9-.2C9.4 4.8 10.6 4 12 4zm-3.2 7.2c-.7.3-1.3.9-1.5 1.7H12V8.4c-.8.2-1.5.7-1.9 1.4-.4.6-1.2.9-1.9.8.2-.5.3-1 .2-1.4h-.6zm6.4 0c.7.3 1.3.9 1.5 1.7H12V8.4c.8.2 1.5.7 1.9 1.4.4.6 1.2.9 1.9.8-.2-.5-.3-1-.2-1.4h.6z" />
    </svg>
  );
}

function GeminiLogo({ size, className }: { size: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-label="Gemini"
    >
      <path d="M12 2c.4 3.8 2.2 6.6 6 7-3.8.4-5.6 3.2-6 7-.4-3.8-2.2-6.6-6-7 3.8-.4 5.6-3.2 6-7zm7.5 12.2c.2 1.7 1 3 2.7 3.3-1.7.2-2.5 1.6-2.7 3.3-.2-1.7-1-3-2.7-3.3 1.7-.2 2.5-1.6 2.7-3.3zM4.8 13.5c.15 1.2.7 2.1 1.9 2.3-1.2.15-1.75 1.1-1.9 2.3-.15-1.2-.7-2.1-1.9-2.3 1.2-.15 1.75-1.1 1.9-2.3z" />
    </svg>
  );
}

function CopilotLogo({ size, className }: { size: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-label="GitHub Copilot"
    >
      <path d="M12 2a7 7 0 0 0-7 7v3.2c-1.7.8-3 2.6-3 4.8v2.5C2 21 3 22 4.5 22S7 21 7 19.5V17h10v2.5c0 1.5 1 2.5 2.5 2.5S22 21 22 19.5V17c0-2.2-1.3-4-3-4.8V9a7 7 0 0 0-7-7zm-3.2 9.2a1.3 1.3 0 1 1 0-2.6 1.3 1.3 0 0 1 0 2.6zm6.4 0a1.3 1.3 0 1 1 0-2.6 1.3 1.3 0 0 1 0 2.6z" />
    </svg>
  );
}

function OpenCodeLogo({ size, className }: { size: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-label="OpenCode"
    >
      <path d="M8.2 4.5L2.5 12l5.7 7.5 1.8-1.4L5.7 12l4.3-5.6-1.8-1.9zm7.6 0l-1.8 1.9L18.3 12l-4.3 5.6 1.8 1.4L21.5 12 15.8 4.5z" />
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
    case "grok":
      return <GrokLogo size={size} className={className} />;
    case "cursor":
      return <CursorLogo size={size} className={className} />;
    case "openclaw":
      return <OpenClawLogo size={size} className={className} />;
    case "gemini":
      return <GeminiLogo size={size} className={className} />;
    case "copilot":
      return <CopilotLogo size={size} className={className} />;
    case "opencode":
      return <OpenCodeLogo size={size} className={className} />;
  }
}
