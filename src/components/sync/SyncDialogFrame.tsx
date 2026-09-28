import { useEffect, useRef, type ReactNode } from "react";
import type { IconComponent } from "../../lib/icons";
import { useEscapeLayer } from "./useEscapeLayer";

export type DialogTone = "info" | "warn" | "danger";

const TONE_CLASSES: Readonly<Record<DialogTone, { box: string; icon: string }>> = {
  info: { box: "bg-conduit-500/10", icon: "text-conduit-400" },
  warn: { box: "bg-amber-500/10", icon: "text-amber-400" },
  danger: { box: "bg-red-500/10", icon: "text-red-400" },
};

interface SyncDialogFrameProps {
  icon: IconComponent;
  title: string;
  tone?: DialogTone;
  width?: string;
  children: ReactNode;
  /** null: no button row (a progress overlay). */
  footer: ReactNode;
  onEscape?: () => void;
}

/** Moves focus into a dialog that opened without an autofocused control. */
export function useDialogFocus() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el && !el.contains(document.activeElement)) el.focus();
  }, []);
  return ref;
}

/** Modal shell shared by the sync dialogs; sits above the unlock dialog (z-60). */
export default function SyncDialogFrame({
  icon: Icon,
  title,
  tone = "info",
  width = "w-[440px]",
  children,
  footer,
  onEscape,
}: SyncDialogFrameProps) {
  const toneClasses = TONE_CLASSES[tone];
  const content = useDialogFocus();
  useEscapeLayer(onEscape);
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div
        ref={content}
        tabIndex={-1}
        data-dialog-content
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`bg-panel border border-stroke rounded-lg shadow-xl outline-none ${width} max-w-[calc(100vw-2rem)] max-h-[85vh] flex flex-col`}
      >
        <div className="flex items-center gap-3 px-6 pt-5 pb-3">
          <div className={`w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 ${toneClasses.box}`}>
            <Icon size={20} className={toneClasses.icon} />
          </div>
          <h2 className="text-lg font-semibold text-ink">{title}</h2>
        </div>
        <div className="px-6 pb-4 space-y-3 text-sm text-ink-secondary overflow-y-auto">{children}</div>
        {footer !== null && <div className="px-6 py-4 border-t border-stroke flex flex-wrap justify-end gap-2">{footer}</div>}
      </div>
    </div>
  );
}

type ButtonVariant = "primary" | "default" | "danger";

const BUTTON_CLASSES: Readonly<Record<ButtonVariant, string>> = {
  primary: "text-white bg-conduit-600 hover:bg-conduit-500",
  default: "text-ink-secondary hover:text-ink hover:bg-well",
  danger: "text-white bg-red-600 hover:bg-red-500",
};

interface DialogButtonProps {
  children: ReactNode;
  onClick: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  autoFocus?: boolean;
  type?: "button" | "submit";
}

export function DialogButton({ children, onClick, variant = "default", disabled, autoFocus, type = "button" }: DialogButtonProps) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      autoFocus={autoFocus}
      className={`px-4 py-2 text-sm font-medium rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${BUTTON_CLASSES[variant]}`}
    >
      {children}
    </button>
  );
}
