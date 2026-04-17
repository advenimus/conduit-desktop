import { useEffect } from "react";

interface Shortcut {
  key: string;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
  meta?: boolean;
  action: () => void;
  description: string;
}

const shortcuts: Shortcut[] = [
  {
    key: "e",
    ctrl: true,
    action: () =>
      document.dispatchEvent(new CustomEvent("conduit:new-entry")),
    description: "New Entry",
  },
  {
    key: "n",
    ctrl: true,
    shift: true,
    action: () =>
      document.dispatchEvent(new CustomEvent("conduit:new-folder")),
    description: "New Folder",
  },
  {
    key: "n",
    ctrl: true,
    action: () =>
      document.dispatchEvent(new CustomEvent("conduit:quick-connect")),
    description: "Quick Connect",
  },
  {
    key: "t",
    ctrl: true,
    action: () =>
      document.dispatchEvent(new CustomEvent("conduit:new-terminal")),
    description: "New Local Terminal",
  },
  {
    key: ",",
    ctrl: true,
    action: () =>
      document.dispatchEvent(new CustomEvent("conduit:settings")),
    description: "Settings",
  },
  {
    key: "w",
    ctrl: true,
    action: () =>
      document.dispatchEvent(new CustomEvent("conduit:close-tab")),
    description: "Close Tab",
  },
  {
    key: "Tab",
    ctrl: true,
    action: () =>
      document.dispatchEvent(new CustomEvent("conduit:next-tab")),
    description: "Next Tab",
  },
  {
    key: "Tab",
    ctrl: true,
    shift: true,
    action: () =>
      document.dispatchEvent(new CustomEvent("conduit:prev-tab")),
    description: "Previous Tab",
  },
  {
    key: "b",
    ctrl: true,
    action: () =>
      document.dispatchEvent(new CustomEvent("conduit:toggle-sidebar")),
    description: "Toggle Sidebar",
  },
  {
    key: "l",
    ctrl: true,
    shift: true,
    action: () =>
      document.dispatchEvent(new CustomEvent("conduit:lock-vault")),
    description: "Lock Vault",
  },
  {
    key: "F2",
    action: () =>
      document.dispatchEvent(new CustomEvent("conduit:rename-selected")),
    description: "Rename Selected",
  },
  {
    key: "Delete",
    action: () =>
      document.dispatchEvent(new CustomEvent("conduit:delete-selected")),
    description: "Delete Selected",
  },
  {
    key: "Backspace",
    action: () =>
      document.dispatchEvent(new CustomEvent("conduit:delete-selected")),
    description: "Delete Selected (macOS)",
  },
  {
    key: "a",
    ctrl: true,
    shift: true,
    action: () =>
      document.dispatchEvent(new CustomEvent("conduit:new-agent")),
    description: "New AI Agent Tab",
  },
  {
    key: "g",
    ctrl: true,
    action: () =>
      document.dispatchEvent(new CustomEvent("conduit:password-generator")),
    description: "Password Generator",
  },
  {
    key: "\\",
    ctrl: true,
    action: () =>
      document.dispatchEvent(new CustomEvent("conduit:split-right")),
    description: "Split Right",
  },
  {
    key: "\\",
    ctrl: true,
    shift: true,
    action: () =>
      document.dispatchEvent(new CustomEvent("conduit:split-down")),
    description: "Split Down",
  },
];

export function useKeyboardShortcuts() {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't trigger shortcuts when typing in input fields
      const target = e.target as HTMLElement;
      if (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable
      ) {
        return;
      }

      // Don't trigger shortcuts when an active session has focus
      if (target.closest('[data-session-keyboard]')) {
        return;
      }

      for (const shortcut of shortcuts) {
        const keyMatch =
          e.key.toLowerCase() === shortcut.key.toLowerCase();
        const ctrlMatch = !!shortcut.ctrl === (e.ctrlKey || e.metaKey);
        const altMatch = !!shortcut.alt === e.altKey;
        const shiftMatch = !!shortcut.shift === e.shiftKey;

        if (keyMatch && ctrlMatch && altMatch && shiftMatch) {
          e.preventDefault();
          shortcut.action();
          return;
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);
}

export function getShortcuts() {
  return shortcuts.map(({ key, ctrl, alt, shift, description }) => ({
    key,
    ctrl,
    alt,
    shift,
    description,
  }));
}
