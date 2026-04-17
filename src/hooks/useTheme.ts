import { useEffect, useState } from "react";
import { DEFAULT_SCHEME } from "../lib/schemes";
import type { PlatformTheme } from "../lib/themes";
import { DEFAULT_PLATFORM_THEME } from "../lib/themes";
import { useIconThemeStore, loadIconPack } from "../lib/icons";

type Theme = "dark" | "light" | "system";

function getSystemTheme(): "dark" | "light" {
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function applyTheme(resolved: "dark" | "light") {
  const root = document.documentElement;
  if (resolved === "dark") {
    root.classList.add("dark");
    root.classList.remove("light");
  } else {
    root.classList.add("light");
    root.classList.remove("dark");
  }
  // Notify terminals and other components to update their themes
  document.dispatchEvent(
    new CustomEvent("conduit:resolved-theme-change", { detail: resolved })
  );
}

function applyScheme(scheme: string) {
  const root = document.documentElement;
  if (scheme === DEFAULT_SCHEME) {
    root.removeAttribute("data-scheme");
  } else {
    root.setAttribute("data-scheme", scheme);
  }
  // Notify terminals so they re-read CSS variables for the new scheme
  document.dispatchEvent(
    new CustomEvent("conduit:resolved-theme-change", {
      detail: root.classList.contains("dark") ? "dark" : "light",
    })
  );
}

function applyPlatformTheme(platform: PlatformTheme) {
  const root = document.documentElement;
  if (platform === DEFAULT_PLATFORM_THEME) {
    root.removeAttribute("data-platform");
  } else {
    root.setAttribute("data-platform", platform);
  }
  // Sync the icon theme store and load the right icon pack
  useIconThemeStore.getState().setTheme(platform);
  loadIconPack(platform);
  // Notify components (e.g. overlay, terminals)
  document.dispatchEvent(
    new CustomEvent("conduit:platform-theme-change", { detail: platform })
  );
}

// Apply scheme and platform synchronously on module load to prevent flash
const initialScheme =
  localStorage.getItem("conduit-color-scheme") || DEFAULT_SCHEME;
applyScheme(initialScheme);

const initialPlatform =
  (localStorage.getItem("conduit-platform-theme") as PlatformTheme) ||
  DEFAULT_PLATFORM_THEME;
applyPlatformTheme(initialPlatform);

// Set actual OS attribute for platform-gated CSS (e.g. corner smoothing)
if (navigator.platform.startsWith("Mac")) {
  document.documentElement.setAttribute("data-os", "macos");
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => {
    return (localStorage.getItem("conduit-theme") as Theme) || "system";
  });

  const [colorScheme, setColorScheme] = useState<string>(() => {
    return localStorage.getItem("conduit-color-scheme") || DEFAULT_SCHEME;
  });

  const [platformTheme, setPlatformTheme] = useState<PlatformTheme>(() => {
    return (
      (localStorage.getItem("conduit-platform-theme") as PlatformTheme) ||
      DEFAULT_PLATFORM_THEME
    );
  });

  useEffect(() => {
    const resolved = theme === "system" ? getSystemTheme() : theme;
    applyTheme(resolved);
    localStorage.setItem("conduit-theme", theme);
    // Sync Electron's native theme (title bar, traffic lights)
    window.electron?.send?.("set-native-theme", theme);
  }, [theme]);

  useEffect(() => {
    applyScheme(colorScheme);
    localStorage.setItem("conduit-color-scheme", colorScheme);
  }, [colorScheme]);

  useEffect(() => {
    applyPlatformTheme(platformTheme);
    localStorage.setItem("conduit-platform-theme", platformTheme);
  }, [platformTheme]);

  // Listen for system theme changes
  useEffect(() => {
    if (theme !== "system") return;

    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => applyTheme(getSystemTheme());
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [theme]);

  // Listen for settings theme changes
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.theme) {
        setTheme(detail.theme as Theme);
      }
      if (detail?.colorScheme) {
        setColorScheme(detail.colorScheme as string);
      }
      if (detail?.platformTheme) {
        setPlatformTheme(detail.platformTheme as PlatformTheme);
      }
    };

    document.addEventListener("conduit:theme-change", handler);
    return () => document.removeEventListener("conduit:theme-change", handler);
  }, []);

  return {
    theme,
    setTheme,
    colorScheme,
    setColorScheme,
    platformTheme,
    setPlatformTheme,
  };
}
