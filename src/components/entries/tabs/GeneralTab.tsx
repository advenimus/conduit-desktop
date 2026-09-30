import type { EntryType } from "../../../types/entry";
import Field from "../Field";
import { getEntryIcon, getEntryColor } from "../entryIcons";
import AppearancePickers from "../AppearancePickers";
import { TextInput } from "../../ui";

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

  const Icon = getEntryIcon(entryType, false, customIcon);
  const colorResult = getEntryColor(entryType, customColor);

  return (
    <div className="space-y-4">
      <Field label="Name" required>
        <TextInput
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={entryType === "web" ? "Google" : entryType === "document" ? "Meeting Notes" : "Production Server"}
          autoFocus
        />
      </Field>

      {isConnection && (
        <div className="flex gap-2">
          <Field label={entryType === "web" ? "URL" : "Host"} className="flex-1">
            <TextInput
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder={entryType === "web" ? "https://example.com" : "192.168.1.1"}
            />
          </Field>
          {entryType !== "web" && (
            <Field label="Port" className="w-24">
              <TextInput type="number" value={port} onChange={(e) => setPort(e.target.value)} />
            </Field>
          )}
        </div>
      )}

      {entryType === "rdp" && (
        <Field label="Domain">
          <TextInput value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="DOMAIN" />
        </Field>
      )}

      <Field label="Appearance" group>
        <AppearancePickers
          Icon={Icon}
          colorResult={colorResult}
          customIcon={customIcon}
          setCustomIcon={setCustomIcon}
          customColor={customColor}
          setCustomColor={setCustomColor}
          iconLabels={["Default Icon", "Custom Icon"]}
          colorLabels={["Default Color", "Custom Color"]}
        />
      </Field>
    </div>
  );
}
