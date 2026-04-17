import { useState, useRef } from "react";
import type { EntryType } from "../../../types/entry";
import Field from "../Field";
import { getEntryIcon, getEntryColor } from "../entryIcons";
import IconPicker from "../IconPicker";
import ColorPicker from "../ColorPicker";
import { IconsIcon, PaletteIcon } from "../../../lib/icons";

interface GeneralTabProps {
  entryType: EntryType;
  name: string;
  setName: (v: string) => void;
  host: string;
  setHost: (v: string) => void;
  port: string;
  setPort: (v: string) => void;
  domain: string;
  setDomain: (v: string) => void;
  customIcon: string | null;
  setCustomIcon: (v: string | null) => void;
  customColor: string | null;
  setCustomColor: (v: string | null) => void;
}

export default function GeneralTab({
  entryType,
  name,
  setName,
  host,
  setHost,
  port,
  setPort,
  domain,
  setDomain,
  customIcon,
  setCustomIcon,
  customColor,
  setCustomColor,
}: GeneralTabProps) {
  const isConnection = entryType !== "credential" && entryType !== "document" && entryType !== "command";
  const [showIconPicker, setShowIconPicker] = useState(false);
  const [showColorPicker, setShowColorPicker] = useState(false);
  const iconBtnRef = useRef<HTMLButtonElement>(null);
  const colorBtnRef = useRef<HTMLButtonElement>(null);

  const Icon = getEntryIcon(entryType, false, customIcon);
  const colorResult = getEntryColor(entryType, customColor);

  return (
    <div className="space-y-3">
      {/* Name */}
      <Field label="Name" required>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={entryType === "web" ? "Google" : entryType === "document" ? "Meeting Notes" : "Production Server"}
          autoFocus
          className="w-full px-3 py-2 bg-well border border-stroke rounded text-sm focus:outline-none focus:ring-2 focus:ring-conduit-500"
        />
      </Field>

      {/* Host + Port (connections only) */}
      {isConnection && (
        <div className="flex gap-2">
          <Field label={entryType === "web" ? "URL" : "Host"} className="flex-1">
            <input
              type="text"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder={entryType === "web" ? "https://example.com" : "192.168.1.1"}
              className="w-full px-3 py-2 bg-well border border-stroke rounded text-sm focus:outline-none focus:ring-2 focus:ring-conduit-500"
            />
          </Field>
          {entryType !== "web" && (
            <Field label="Port" className="w-24">
              <input
                type="number"
                value={port}
                onChange={(e) => setPort(e.target.value)}
                className="w-full px-3 py-2 bg-well border border-stroke rounded text-sm focus:outline-none focus:ring-2 focus:ring-conduit-500"
              />
            </Field>
          )}
        </div>
      )}

      {/* Domain (RDP only in General tab) */}
      {entryType === "rdp" && (
        <Field label="Domain">
          <input
            type="text"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            placeholder="DOMAIN"
            className="w-full px-3 py-2 bg-well border border-stroke rounded text-sm focus:outline-none focus:ring-2 focus:ring-conduit-500"
          />
        </Field>
      )}

      {/* Appearance */}
      <div>
        <label className="block text-sm font-medium text-ink-secondary mb-1">Appearance</label>
        <div className="flex items-center gap-3">
          {/* Preview */}
          <div className="w-9 h-9 flex items-center justify-center bg-well rounded border border-stroke">
            <Icon size={20} className={colorResult.className} style={colorResult.style} />
          </div>

          {/* Icon picker */}
          <button
            ref={iconBtnRef}
            type="button"
            onClick={() => { setShowIconPicker(!showIconPicker); setShowColorPicker(false); }}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-stroke rounded hover:bg-raised transition-colors"
          >
            <IconsIcon size={14} />
            {customIcon ? "Custom Icon" : "Default Icon"}
          </button>
          {showIconPicker && (
            <IconPicker
              value={customIcon}
              onSelect={setCustomIcon}
              onClose={() => setShowIconPicker(false)}
              customColor={customColor}
              anchorRef={iconBtnRef}
            />
          )}

          {/* Color picker */}
          <button
            ref={colorBtnRef}
            type="button"
            onClick={() => { setShowColorPicker(!showColorPicker); setShowIconPicker(false); }}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-stroke rounded hover:bg-raised transition-colors"
          >
            {customColor ? (
              <span className="w-3 h-3 rounded-full" style={{ backgroundColor: customColor }} />
            ) : (
              <PaletteIcon size={14} />
            )}
            {customColor ? "Custom Color" : "Default Color"}
          </button>
          {showColorPicker && (
            <ColorPicker
              value={customColor}
              onSelect={setCustomColor}
              onClose={() => setShowColorPicker(false)}
              anchorRef={colorBtnRef}
            />
          )}
        </div>
      </div>
    </div>
  );
}
