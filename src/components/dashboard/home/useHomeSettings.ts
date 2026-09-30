import { useEffect } from "react";
import { create } from "zustand";
import { invoke } from "../../../lib/electron";
import {
  BACKUP_STALE_OPTIONS,
  DEFAULT_HOME_SETTINGS,
  HOME_SECTION_IDS,
  HOME_SETTINGS_KEY,
  PASSWORD_AGE_OPTIONS,
  type HomeSectionId,
  type HomeSettings,
} from "../../../types/dashboard";

type HomeSettingsPatch = Partial<Omit<HomeSettings, "version">>;

function parseHidden(raw: unknown): readonly HomeSectionId[] {
  if (!Array.isArray(raw)) return DEFAULT_HOME_SETTINGS.hidden;
  return HOME_SECTION_IDS.filter((id) => raw.includes(id));
}

function parsePasswordAge(raw: unknown): number | null {
  if (raw === undefined) return DEFAULT_HOME_SETTINGS.passwordAgeDays;
  return PASSWORD_AGE_OPTIONS.includes(raw as number | null) ? (raw as number | null) : DEFAULT_HOME_SETTINGS.passwordAgeDays;
}

function parseBackupStale(raw: unknown): number {
  return BACKUP_STALE_OPTIONS.includes(raw as number) ? (raw as number) : DEFAULT_HOME_SETTINGS.backupStaleDays;
}

/** The stored value, field by field: unknown section ids drop, values outside the option lists fall back to the default. */
export function parseHomeSettings(raw: unknown): HomeSettings {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return DEFAULT_HOME_SETTINGS;
  const value = raw as Record<string, unknown>;
  return {
    version: 1,
    hidden: parseHidden(value.hidden),
    passwordAgeDays: parsePasswordAge(value.passwordAgeDays),
    backupStaleDays: parseBackupStale(value.backupStaleDays),
  };
}

interface HomeSettingsState {
  settings: HomeSettings;
  loaded: boolean;
}

// One copy for every Home view on screen (an empty second pane shows Home too).
const useHomeSettingsStore = create<HomeSettingsState>(() => ({ settings: DEFAULT_HOME_SETTINGS, loaded: false }));
let loading: Promise<void> | null = null;

/** Reads the saved settings once; App calls it at start so the first Home paint already knows the hidden sections. */
export function preloadHomeSettings(): void {
  ensureLoaded();
}

function ensureLoaded(): void {
  if (loading) return;
  loading = invoke<unknown>("ui_state_get", { key: HOME_SETTINGS_KEY })
    .then((raw) => {
      if (!useHomeSettingsStore.getState().loaded) useHomeSettingsStore.setState({ settings: parseHomeSettings(raw), loaded: true });
    })
    .catch((err) => {
      console.warn("[home] ui_state_get failed:", err);
      useHomeSettingsStore.setState({ loaded: true });
    });
}

/** Forgets the loaded settings; the next mount reads them again. For tests. */
export function resetHomeSettings(): void {
  loading = null;
  useHomeSettingsStore.setState({ settings: DEFAULT_HOME_SETTINGS, loaded: false });
}

export function useHomeSettings(): { settings: HomeSettings; loaded: boolean; update: (patch: HomeSettingsPatch) => void } {
  const settings = useHomeSettingsStore((s) => s.settings);
  const loaded = useHomeSettingsStore((s) => s.loaded);
  useEffect(ensureLoaded, []);
  const update = (patch: HomeSettingsPatch) => {
    const next: HomeSettings = { ...useHomeSettingsStore.getState().settings, ...patch, version: 1 };
    useHomeSettingsStore.setState({ settings: next, loaded: true });
    invoke("ui_state_set", { key: HOME_SETTINGS_KEY, value: next }).catch((err) => console.warn("[home] ui_state_set failed:", err));
  };
  return { settings, loaded, update };
}
