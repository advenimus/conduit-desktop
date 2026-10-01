import { IconButton } from "../ui";

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

/** The pin, and a close button only while the side bar is popped out unpinned; a pinned one hides by unpinning or Ctrl+B. */
export default function SidebarWindowControls({ isPinned, isDocked, onClose, onTogglePin }: SidebarWindowControlsProps) {
  return (
    <>
      <IconButton
        icon={isPinned ? "pinFilled" : "pin"}
        label={isPinned ? "Unpin sidebar" : "Pin sidebar open"}
        title={pinTitle(isPinned, isDocked)}
        pressed={isPinned}
        onClick={onTogglePin}
        className={isPinned && !isDocked ? "opacity-60" : undefined}
      />
      {!isPinned && <IconButton icon="close" label="Close sidebar" title="Close sidebar (Ctrl+B)" onClick={onClose} />}
    </>
  );
}
