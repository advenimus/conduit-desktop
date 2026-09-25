import { PinIcon, PinFilledIcon } from "../../lib/icons";

interface SidebarWindowControlsProps {
  isPinned: boolean;
  isDocked: boolean;
  onClose: () => void;
  onTogglePin: () => void;
}

function pinTitle(isPinned: boolean, isDocked: boolean): string {
  if (!isPinned) return "Pin sidebar open (Ctrl+Shift+B)";
  if (isDocked) return "Unpin sidebar so it auto-hides (Ctrl+Shift+B)";
  return "Pinned, but the window is too narrow to dock it. Unpin (Ctrl+Shift+B)";
}

export default function SidebarWindowControls({
  isPinned,
  isDocked,
  onClose,
  onTogglePin,
}: SidebarWindowControlsProps) {
  const closeLabel = isDocked ? "Hide sidebar" : "Close sidebar";

  return (
    <>
      {/* Close button — hamburger X matching the tab bar toggle */}
      <button
        onClick={onClose}
        className="p-1.5 -ml-1 rounded hover:bg-raised text-ink-muted hover:text-ink flex-shrink-0 transition-colors"
        title={`${closeLabel} (Ctrl+B)`}
        aria-label={closeLabel}
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <line x1="2" y1="2" x2="12" y2="12" />
          <line x1="12" y1="2" x2="2" y2="12" />
        </svg>
      </button>
      <button
        onClick={onTogglePin}
        aria-pressed={isPinned}
        aria-label={isPinned ? "Unpin sidebar" : "Pin sidebar open"}
        title={pinTitle(isPinned, isDocked)}
        className={`p-1.5 mr-0.5 rounded hover:bg-raised flex-shrink-0 transition-colors ${
          isPinned
            ? `text-conduit-400 hover:text-conduit-300${isDocked ? "" : " opacity-60"}`
            : "text-ink-muted hover:text-ink"
        }`}
      >
        {isPinned ? <PinFilledIcon size={14} /> : <PinIcon size={14} />}
      </button>
    </>
  );
}
