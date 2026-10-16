import { useId, useMemo, useState } from "react";
import { Button, FormField, TextInput } from "../../ui";
import { HINT } from "../settings-styles";
import {
  TERMINAL_FONT_FALLBACK,
  buildTerminalFontStack,
  isFontInstalled,
  listInstalledFontFamilies,
  sanitizeFontFamily,
} from "../../../lib/terminalFont";

// Plain text, then Powerline, Git, folder and Linux icons from the Nerd Font private use area.
const PREVIEW_TEXT = "~/conduit $ ls -la  0O 1lI {} =>      ";

const BROWSE_MESSAGES = {
  unsupported: "Conduit can't list fonts here. Type the font name instead.",
  denied: "Conduit wasn't allowed to list your fonts. Type the font name instead.",
  failed: "Could not list your fonts. Type the font name instead.",
} as const;

function browseErrorMessage(err: unknown): string {
  const name = err instanceof DOMException ? err.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return BROWSE_MESSAGES.denied;
  console.error("[TerminalFontField] Could not list the installed fonts:", err);
  return BROWSE_MESSAGES.failed;
}

function fieldError(value: string, safe: string, found: boolean | null): string | undefined {
  if (value.trim() && !safe) return "Font names can't contain quotes, commas, semicolons, brackets or backslashes.";
  if (found === false) return `"${safe}" was not found on this computer. Terminals will use the built-in fonts.`;
  return undefined;
}

interface TerminalFontFieldProps {
  value: string;
  onChange: (fontFamily: string) => void;
}

export default function TerminalFontField({ value, onChange }: TerminalFontFieldProps) {
  const listId = useId();
  const [installed, setInstalled] = useState<string[] | null>(null);
  const [browseMessage, setBrowseMessage] = useState<string | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const safe = sanitizeFontFamily(value);

  const found = useMemo(() => {
    if (!safe) return null;
    if (installed) return installed.some((family) => family.toLowerCase() === safe.toLowerCase());
    return isFontInstalled(safe);
  }, [safe, installed]);

  const browse = async () => {
    setBrowsing(true);
    try {
      const families = await listInstalledFontFamilies();
      if (!families) {
        setBrowseMessage(BROWSE_MESSAGES.unsupported);
        return;
      }
      setInstalled(families);
      setBrowseMessage(`${families.length} fonts found. Start typing in the box to pick one.`);
    } catch (err) {
      setBrowseMessage(browseErrorMessage(err));
    } finally {
      setBrowsing(false);
    }
  };

  return (
    <div className="space-y-2">
      <FormField
        label="Font Family"
        description="Any installed font, such as a Nerd Font. Leave empty for the built-in fonts, which are also used for anything the font lacks."
        error={fieldError(value, safe, found)}
      >
        <TextInput
          value={value}
          placeholder={TERMINAL_FONT_FALLBACK}
          list={installed ? listId : undefined}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => onChange(e.target.value)}
        />
      </FormField>
      {installed && (
        <datalist id={listId}>
          {installed.map((family) => (
            <option key={family} value={family} />
          ))}
        </datalist>
      )}
      <div className="flex items-center gap-3">
        <Button size="sm" onClick={browse} loading={browsing} loadingLabel="Listing Fonts...">
          Browse Installed Fonts
        </Button>
        {browseMessage && <span className={HINT}>{browseMessage}</span>}
      </div>
      <div
        data-cv-terminal-font-preview=""
        aria-label="Font preview"
        className="overflow-hidden whitespace-pre rounded-md border border-card-border bg-well px-3 py-2 text-body text-ink"
        style={{ fontFamily: buildTerminalFontStack(safe) }}
      >
        {PREVIEW_TEXT}
      </div>
    </div>
  );
}
