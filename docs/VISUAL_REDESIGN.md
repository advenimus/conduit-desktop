# Conduit visual redesign: implementation spec

Status: ready to build. Written 2026-09-27 against branch `advenimus/unlimited-mcp-free` at `270ae43` (PR #12, the sidebar pin, is merged in). Revised 2026-09-28 after three adversarial reviews (fidelity, native, plan); the changes and the rejected points are listed in the Review log at the end. The redesign ships in the pending desktop release (PR #13).

This document is self-contained. An engineer who has not read the research can build any work package from it. Numbers come from the installed VS Code 1.139.0 (`/Applications/Visual Studio Code.app`, commit `2242ebbb`) unless a line says otherwise.

Tags used below:

| Tag | Meaning |
|---|---|
| [V] | Verified in this session: code read, command run, or VS Code 1.139 file read. |
| [A] | Assumption. Must be checked by the package that relies on it. |
| [ADAPT] | A deliberate difference from VS Code 1.139. The reason is given next to it. |
| OD-n | A fixed owner decision (section 1.1). Do not reopen. |
| D-n | A decision made by this spec (section 1.2). |

---

## 0. Summary

- Conduit gets VS Code 1.139's "Modern UI" layout: a custom title bar, an activity bar, a docked or floating primary side bar, one editor card with VS Code "connected" tabs per split pane, the AI chat as a secondary side bar, and a status bar. Parts are floating cards (4px gaps, 8px radius, 1px border on a shell color). A Compact density removes gaps and radii.
- A new default color scheme, **Modern**, uses VS Code "Dark 2026" / "Light 2026" values. The six universal schemes stay and map onto the same token set. The macOS, Windows and Ubuntu platform themes and their six native schemes are retired, with a one-time migration.
- Icons become their own setting (`icon_pack`). Six packs: **Codicons** (default), Lucide, Tabler ("Classic"), Phosphor, Fluent, Material Symbols. Codicons ship through a build-time codegen from `@iconify-json/codicon`.
- Type follows the OS font stack at 13px. Controls are 26px, list rows 22px, weights 400 and 600 only.
- A shared primitive layer lands in `src/components/ui/`. A ref-counted freeze registry makes every dialog and popover hide native web views, which closes an existing gap (sync dialogs never froze web views).
- The live `/verify` harness keeps passing through stable `data-cv-*` hooks. The migration pairs each class selector with its hook first (the hook wins wherever it exists) and removes the class-based fallbacks last.
- Work is split into 30 packages in 4 waves (section 10). Files are owned by exactly one package per wave. Two standing packages (W2-FOUNDATION, W3-FOUNDATION) own the shared foundations during waves 2 and 3. Wave 2 lands on one integration branch.

---

## 1. Decisions and non-goals

### 1.1 Owner decisions (fixed)

| ID | Decision |
|---|---|
| OD-1 | Complete visual redesign modeled on VS Code 1.139 Modern UI and the 2026 Dark/Light themes. Tabs, buttons and spacing like VS Code. Part of PR #13. |
| OD-2 | Custom title bar on macOS, Windows and Linux. macOS: hidden title bar with inset traffic lights. Windows/Linux: hidden title bar with Electron `titleBarOverlay` window buttons whose colors follow the theme, plus an in-app menu button that opens the application menu. Windows/Linux ship untested locally, so every path there is defensive. |
| OD-3 | Layout: activity bar (Modern metrics), primary side bar (PR #12 pin/auto-hide model), editor area with VS Code tabs per pane (splits stay), AI chat as secondary side bar on the right, status bar that absorbs sync indicators, offline mode, trial days and FreeRDP startup status. Floating cards (4px gaps, 8px radius, 1px border on a shell color) with a Compact density (no gaps, no radii). No bottom panel. No command palette. The title bar center may hold a search pill only if it maps to an existing capability and is cheap and safe over native web views. |
| OD-4 | Icon pack is its own setting. Default Codicons with CC-BY-4.0 attribution. Offer Codicons, Lucide, Tabler (Classic), Phosphor, Fluent, Material Symbols. Overlay window, picker window and popup context menus use the active pack. Custom entry icons (Tabler names in vault data) keep working. 16px icons, 12px compact where VS Code uses compact. |
| OD-5 | Retire the platform themes and their six native schemes. Keep the six universal schemes, add Modern as default. Migration: untouched default (platform `default` + scheme `ocean`) moves to Modern once; other choices keep their scheme; retired platform users keep their pack (macos→phosphor, windows→fluent, ubuntu→tabler) and move to the nearest universal scheme. Migration runs in the main-process settings read and in the renderer boot path, idempotently. |
| OD-6 | OS system font stack at 13px base. 12px buttons/labels, 11px metadata, 10px badges. Weights 400/600. Terminal fonts unchanged. |
| OD-7 | Shared primitives in `src/components/ui/` (list in section 4). No new runtime dependencies except icon libraries. Local `cx()` helper. Visible keyboard focus rings everywhere. |
| OD-8 | Replace the hand-listed overlay flags in `App.tsx` with a ref-counted overlay/freeze registry used by every dialog, popover and title-bar flyout. |
| OD-9 | All tests and the 41-scenario `/verify` harness keep passing. Add `data-cv-*` hooks where the harness uses Tailwind classes. Never give chrome buttons the exact text of the unscoped harness labels: `Review`, `Use here instead`, `Lock Current Vault`, `New Vault`, `Not Now`, `Open Vault File`. Keep or update the sidebar titles the harness clicks. No `role=dialog` or `role=status` on permanent chrome. |
| OD-10 | WCAG AA for text (faint text at least 4.5:1 where it is real text). ARIA roles for tabs, trees and menus. |
| OD-11 | Update `docs/FEATURES.md` and the What's New source (`release-notes/manifest.json`) the way the repo does it. |

### 1.2 Decisions made by this spec

| ID | Decision | Why |
|---|---|---|
| D-1 | **Codicons delivery: build-time codegen from `@iconify-json/codicon@1.2.73`** (devDependency, 385 KB, CC-BY-4.0) into a checked-in TypeScript module of path data. The same generator produces Material Symbols from `@iconify-json/material-symbols-light@1.2.94` (Apache-2.0). | (a) Every Codicon the mapping names exists in the set: 115 of the 123 semantic names have one, and the other 8 borrow Lucide glyphs (Appendix A.1). The set also has 68 pixel-drawn 12×12 `-compact` glyphs, 36 of them twins of mapped names, including `arrow-up`, `cloud-upload` and `cloud-download`, which `react-icons` lacks [V]. (b) `react-icons@5.7.0` is 88.3 MB unpacked [V `npm view`] for 612 glyphs we would use ~110 of, and ships its own snapshot of Codicons we cannot pin independently. (c) `@vscode/codicons` has no JS entry and its `latest` tag is a prerelease `0.0.46-24` [V]. (d) Iconify bodies contain only `path` and `g` with `fill`, `d`, `fill-rule`, `clip-rule` [V], so the generator emits plain React elements, no `dangerouslySetInnerHTML`. (e) One generator also covers Material Symbols, which has no maintained React package. |
| D-2 | All icon libraries become **devDependencies**. The renderer is bundled by Vite and nothing under `electron/` or `mcp/` imports them [V grep]. | The packaged `app.asar` is 264.7 MB today and contains `@fluentui/react-icons` (11,632 entries) [V `npx asar list`]. Unpacked sizes: Fluent 178 MB, Tabler 74 MB, Phosphor 57 MB [V `du`]. Adding Lucide (35 MB) as a runtime dependency would grow it further. |
| D-3 | Editor tabs use VS Code's **connected** style only. No pill option. | Connected is VS Code's default [V `workbench.experimental.modernUIEditorTabStyle` default `connected`]. One style halves the test matrix. |
| D-4 | Density names: **Comfortable** (default, cards) and **Compact**. Setting `ui_density`. | Matches VS Code `window.density.layout` (`default`/`compact`) with a user-facing label. |
| D-5 | The title bar is always **35 DIP tall and counter-zoomed** (`zoom: calc(1 / var(--c-zoom))`). Traffic-light position, the Windows/Linux overlay height and the caption reserve never change with `ui_scale`. | VS Code uses the same `counter-zoom` class [V `.titlebar-container.counter-zoom {zoom:calc(1 / var(--zoom-factor))}`]. It removes every zoom-dependent main-process call. [ADAPT] VS Code lets the title bar grow when zoom > 1 and the command center shows; Conduit keeps it constant because native window controls do not scale. |
| D-6 | Title bar center: a **search pill** that dispatches the existing `conduit:focus-sidebar-search` event (`Sidebar.tsx:101-105`). No dropdown, no new floating surface. Shortcut Ctrl/Cmd+P (renderer only). | Maps to an existing capability. The only surface it opens is the side bar, which already freezes web views when it floats. A native accelerator is not added so Ctrl/Cmd+P still reaches remote sessions (print). |
| D-7 | Windows/Linux menu button pops up the **native application menu** with `Menu.getApplicationMenu().popup()`. No HTML menu bar. | Native popups draw above native web views, include every item, the dynamic "Restart to Update" label and accelerator hints, and keep the harness's `clickMenuItem` working. |
| D-8 | Defensive fallbacks for Windows/Linux: (1) HTML window controls whenever the main process reports the overlay inactive or the Window Controls Overlay reports itself not visible, re-evaluated on every state change (3.2); (2) a `title_bar_style` setting (`custom` default, `native`) plus env `CONDUIT_TITLE_BAR=native`, and a Help menu item `Use Native Title Bar` that sets it and restarts (7.1); (3) F10 and a lone Alt open the application menu (3.2). | The custom title bar is untested on these OSes. Hidden-menu accelerators need no fallback: with `titleBarStyle: 'hidden'` Electron registers the menu's accelerators and creates no menu bar [V Electron 44.4.5 `root_view.cc:52-56`, `native_window_views.cc:2077-2078`]. |
| D-9 | Side bar keeps PR #12's default (**unpinned**, floats and auto-hides). Activity bar items: Vault, Favorites, Home, Quick Connect; bottom: Account, Settings. | OD-3 says keep the pin model. Each item maps to an existing capability. |
| D-10 | AI secondary side bar toggle lives in the title bar layout controls, plus Ctrl/Cmd+Alt+B (renderer only). Its visibility and width persist. | VS Code puts the secondary side bar toggle in the title bar [V layout controls]. Ctrl/Cmd+Alt+B is free [V critic]. |
| D-11 | Status bar: left = offline, personal sync, "N to review", cloud backup, team sync, FreeRDP build; right = active session, trial days, zoom (only when not 100%). | OD-3. The sync indicators are invisible today whenever the sidebar is closed (`Sidebar.tsx:513-525`). |
| D-12 | Sync banners stay banners, restyled as VS Code's 26px banner part under the title bar. They keep `role="status"`. | VS Code banner part is 26px tall, 12px text [V JS `this.height=26`]. The harness reads banners by `[role=status]` [V `ui-forms.mjs:82-106`]. |
| D-13 | Neutral gray selection and active states; accent only for primary buttons, focus, badges, links, progress and connection state. | VS Code 2026 "Focus" principle [V theme values]. |
| D-14 | Five text levels: `ink`, `ink-secondary`, `ink-muted`, `ink-faint`, `ink-disabled`. `ink-faint` becomes AA (≥ 4.5:1) in every scheme; the old faint value moves to `ink-disabled`. | OD-10. Faint text fails 3:1 in almost every scheme today [V computed, section 2.11]. |
| D-15 | In light mode, accent steps 300 and 400 (used only as text) are remapped per scheme to text-safe shades. | Light-mode `text-conduit-400` is 2.1:1 on white in Ocean today [V computed]. 163 of 164 `conduit-400` uses and all 19 `conduit-300` uses are text [V research counts]. |
| D-16 | Status colors are VS Code 2026 values. Light warning uses 2026 Light's `problemsWarningIcon.foreground` `#895503` [V]. Light success is darkened from `#587C0C` to `#4B6A0A` [ADAPT]. | VS Code's `list.warningForeground` `#667309` reads as olive green, too close to "connected"; `#895503` is the amber 2026 Light already uses for warnings. `#587C0C` passes the light surfaces only barely (4.53:1 at the lowest) and falls below 4.5:1 on any success tint, so tone text on its own background would fail AA; `#4B6A0A` passes on every surface and tint (2.11). |
| D-17 | Native web views get `View.setBorderRadius(round(7 × zoom))` (the card's 8px radius minus its 1px border) only when their container is flush with both bottom corners of the editor card (Comfortable density, Chromium engine). When a native view touches exactly one bottom corner, or is a WebView2, the card squares that corner instead. | `setBorderRadius` rounds all four corners [V `electron.d.ts:16118`], so a view on one corner cannot match the card; a square native view would paint over the card's rounded corner, because the card's `overflow:hidden` cannot clip a native view. WebView2 is a separate HWND and cannot be rounded [V `webview2-session.ts:155-163`]. |
| D-18 | Tab status dot shows only non-connected states (connecting, reconnecting, disconnected). | VS Code shows no marker for a clean tab; the dot slot doubles as the close button like VS Code's dirty dot. The status bar shows the active session state. |
| D-19 | Custom entry icons stay Tabler (`iconRegistry.ts`). | They are stored and synced as Tabler export names [V `iconRegistry.ts:213`]; renaming them is a data change. |
| D-20 | Context menus stay in the HTML child window (`electron/ipc/menu.ts`) on every OS and get icons serialized from the active pack by the renderer. | The child window already floats above native web views without freezing them. [ADAPT] Stable VS Code uses native OS context menus on macOS (`window.menuStyle` defaults to `native` there [V]); Conduit keeps one HTML menu on all OSes so menus show the active icon pack and danger styling. |
| D-21 | The freeze registry replaces `conduit:overlay-change` and `conduit:sidebar-overlay-change` as the source of truth. Tooltips stay native `title` (no DOM tooltip). | A native tooltip cannot be covered by a native view. |
| D-22 | Harness: stable `data-cv-*` hooks. Wave 1 rewrites each class-based harness selector as a pair (hook, old class selector) resolved per scope by `pickSelector`, which uses the hook whenever the scope has one (8.2); wave 4 removes the class alternatives. Dialog detection narrows to `[role=dialog][aria-label]`. | Lets wave 3 migrate files independently. The Dialog primitive adds `role=dialog` to every dialog; without the narrowing, `waitForUnlockOutcome` would treat the unlock dialog itself as a sync dialog (section 8.3). |
| D-23 | `font-medium`, `font-semibold` and `font-bold` all map to 600. | OD-6 (two weights). |
| D-24 | Toast overlay window grows to 458 DIP wide (toast max 450 plus 4px padding each side). Toasts sit 8px from the right edge and 8px above the status bar. | VS Code toast `MAX_WIDTH=450` [V research]; Modern toasts: container `right: calc(8px - 4px)`, `bottom: calc(36px - 4px)`, each toast `margin: 4px` [V workbench CSS]. |
| D-25 | Dialogs: radius 8, no backdrop blur, sizes 400/520/720/880, no open or close animation. | VS Code Modern dialog radius 8 [V `.modern-ui .monaco-dialog-box {border-radius: var(--vscode-cornerRadius-large)}`], min width 440 [V]. No animation rule matches `.monaco-dialog-box`; the 250ms entrance belongs to action-widget dropdowns and quick input [V]. |
| D-26 | On Linux the app runs under XWayland this release (`--ozone-platform=x11`), with an opt-out. | Electron 38 and later run as native Wayland clients by default [V Electron 38 release notes], and Wayland forbids global window positions (`setPosition` is not supported there [V `electron.d.ts`]). The context menus, the toast overlay and the picker are positioned child windows. Every earlier Conduit release ran under X11 or XWayland. |
| D-27 | Web sessions get a user-origin stylesheet that sets `app-region: no-drag` on every element. | With `titleBarStyle: 'hidden'` the window has no frame, so Electron honors drag regions from every WebContents, remote pages included [V Electron 44.4.5 `native_window.cc:104-105`, `electron_api_web_contents.cc:2440`, `electron_api_web_contents_view.cc:94-144`]. A site whose CSS sets `-webkit-app-region: drag` would otherwise move the Conduit window. |

### 1.3 Non-goals (this release)

- Bottom panel. Command palette or quick pick. HTML menu bar.
- Pill tab style option.
- Inactive-window title bar dimming (`titleBar.inactiveBackground`). It would add a Windows/Linux `setTitleBarOverlay` call on every focus change.
- Making custom entry icons follow the icon pack.
- Toasts following `ui_scale`, and popup menus following `ui_scale` (both unchanged today).
- High-contrast themes, an RTL layout. (The title bar reserves still follow caption buttons that the OS mirrors, 3.2.)
- Bumping `@tabler/icons-react` (3.38.0) or `@fluentui/react-icons` (2.0.321). The research sheets used newer versions [V critic]; previews in Settings render the installed glyphs live.
- Terminal font, xterm padding and ANSI palette (`terminalTheme.ts:43-58`).
- The picker window's dropped toasts (existing bug: `picker.tsx` never sets `setPushOverlayState`).

### 1.4 Baseline: what the code does today

| Area | Fact | Source |
|---|---|---|
| Window | Native frame on every OS, `minWidth 1024`, `minHeight 700`, `backgroundColor '#0f172a'`. | `electron/main.ts:704-723` [V] |
| Zoom | `ui_scale` applied with `setZoomFactor` at `ready-to-show` without sending `zoom-factor-changed`; live changes via `set-zoom-factor`. | `main.ts:725-733`, `853-858` [V] |
| App menu | File, Edit, (dev) View, Tools, (mac) Window, Help. Items send `menu-action`. | `main.ts:400-674` [V] |
| Layout | 2px accent bar, offline banner, `SyncBanners`, then a row: `Sidebar`, `SplitContainer` (AI robot toggle in the focused pane's tab bar), 4px AI divider, AI panel (`useState(400)`, not persisted). `StartupStatus` strip at the bottom. | `App.tsx:1067-1130`, `97-98` [V] |
| Overlay flags | 24 dialog flags OR'ed into `conduit:overlay-change`. | `App.tsx:389-395` [V] |
| Sidebar | Floating by default; docked when pinned and `viewportWidth - expandedWidth - rightPanelWidth - 480 >= 0`. Footer holds counts, sync indicators, Home, Settings, account. | `sidebarStore.ts:40-50`, `Sidebar.tsx:513-595` [V] |
| Tabs | 36px bar, 32px floating tabs, always-visible 12px close, 8px status dot, 44px hamburger, `+` and AI toggle at right. | `PaneTabBar.tsx:333-445` [V] |
| Tokens | Platform CSS imported before the `:root` defaults, so platform token overrides never apply (equal specificity, later wins). | `src/index.css:1-4`, `60-92` [V] |
| Icons | Pack chosen by platform theme; overlay window never loads a pack; popup menu uses 25 hard-coded Tabler paths and has no `split` icon. | `useTheme.ts:45-59`, `electron/ipc/menu.ts:23-49` [V] |
| Popup menus | 210px wide, 30px rows, `Inter` hard-coded, labels and ids interpolated into HTML unescaped. | `menu.ts:111-118`, `209-231`, `286-297` [V] |
| Toasts | Overlay window 400×500, 16px from the content corner, no zoom. | `overlay-manager.ts:33-35`, `133-138` [V] |
| Tests | `vitest`: 3 failures in `src/App.test.tsx` (`window.matchMedia` missing, stale strings). `tsc` clean. | PR #13 body [V] |
| Scripts | There is no `build:electron` script; the full build is `npm run build`. | `package.json` [V] |

---

## 2. Design tokens

### 2.1 File layout and the cascade fix

**The bug being fixed.** `src/index.css:2-4` imports `platform-*.css` before the `:root` token block at `index.css:60`. `[data-platform="macos"]` and `:root` both have specificity (0,1,0), so the later `:root` wins and no platform token override ever applied [V: compiled CSS, `dist/assets/index-Asd-Qr4O.css` byte order, Electron probe]. Platform themes are retired (OD-5), but the same trap would hit density and scheme overrides.

**The rule.** Precedence must come from specificity, never from file order:

| Layer | Selector | Specificity | File |
|---|---|---|---|
| Mode-independent base | `:root` | (0,1,0) | `src/styles/tokens.css` |
| Mode base (Modern primitives + derived formulas) | `:root.dark`, `:root.light` | (0,2,0) | `src/styles/tokens.css` |
| OS font stacks | `:root[data-os="macos"]` etc. | (0,2,0) | `src/styles/tokens.css` (only defines `--c-font-*`, which no other layer defines) |
| Density | `:root[data-density="compact"]` | (0,2,0) | `src/styles/density.css` (only defines density tokens, which only `:root` also defines) |
| Scheme, per mode | `:root[data-scheme="ocean"].dark`, `:root[data-scheme="ocean"].light`, … | (0,3,0) | `src/styles/schemes.css` |
| Modern exact values | `:root[data-scheme="modern"].dark, :root:not([data-scheme]).dark` (and `.light`) | (0,3,0) | `src/styles/schemes.css` |

Every scheme block is mode-specific, so it always beats the mode base. No scheme defines mode-independent accents at (0,2,0) (that would tie with the mode base). Accent ramps are repeated inside each scheme's `.dark` and `.light` blocks.

**New `src/index.css` skeleton** (W1-TOKENS):

```css
@import "tailwindcss";
@import "./styles/tokens.css";
@import "./styles/schemes.css";
@import "./styles/density.css";
@import "./styles/base.css";
@import "./styles/components/cards.css";
@import "./styles/components/tabs.css";
@import "./styles/components/sash.css";
@plugin "@tailwindcss/typography";
@custom-variant dark (&:where(.dark, .dark *));
@custom-variant compact (&:where([data-density="compact"], [data-density="compact"] *));
@theme { /* section 2.10 */ }
```

Delete: `src/themes/platform-macos.css`, `platform-windows.css`, `platform-ubuntu.css`, `native-schemes.css` (never imported [V]), `tailwind.config.js` (never loaded, and it `require()`s inside an ESM package [V]).

**Guard test** (`src/styles/__tests__/tokens-cascade.test.ts`, node environment): compile `src/index.css` with the repo's `@tailwindcss/postcss` (same approach as `scratchpad/redesign/compile-css.cjs`), then walk the PostCSS AST and assert:

1. No selector contains `data-platform`.
2. Every rule that sets a `--c-*` color token for a named scheme matches `^:root\[data-scheme="(modern|ocean|ember|forest|amethyst|rose|midnight)"\]\.(dark|light)$` (plus the two `:root:not([data-scheme])` Modern selectors).
3. Every rule that sets a density token matches `^:root(\[data-density="compact"\])?$`.
4. For each of the 7 schemes × 2 modes, a small resolver (specificity-ordered merge of the matching blocks, `var()` substitution, and exact floating-point `color-mix(in srgb, A p%, B)` evaluation, no rounding between steps) resolves **every token in the contract list (section 2.2) to a color**. No token may be missing in any combination.
5. The contrast gates in section 2.11 hold for the resolved values.

### 2.2 Token contract and Modern values

Every token below resolves in every scheme and mode. "Base formula" is what the six universal schemes get from `:root.dark` / `:root.light`. "Modern" is the exact value in the Modern block. VS Code sources are 1.139 theme keys resolved from `extensions/theme-defaults/themes/2026-{dark,light}.json` [V].

#### 2.2.1 Primitive surfaces, text and borders

| Token | Modern dark | Modern light | VS Code source | Notes |
|---|---|---|---|---|
| `--c-canvas` | `#121314` | `#FFFFFF` | `editor.background` | Legacy name; kept for existing `bg-canvas`. |
| `--c-panel` | `#191A1B` | `#FAFAFD` | `sideBar.background` | Legacy name. |
| `--c-raised` | `#2B2C2D` | `#E6E6E9` | `list.hoverBackground` (`#FFFFFF14` / `#00000014`) composited on the side bar | Opaque hover for legacy `bg-raised`. |
| `--c-well` | `#121314` | `#F2F2F2` | dark `editor.background`; light `modernActivityBarItem.hoverBackground` | Recessed areas (segmented-control track, input wells). Code blocks use `--c-code-bg` (2.2.3). |
| `--c-ink` | `#EDEDED` | `#202020` | `list.activeSelectionForeground` / `foreground` | Emphasis: titles, selected rows. |
| `--c-ink-secondary` | `#BFBFBF` | `#202020` | 2026 `foreground` (dark) / 2026 `foreground`, `sideBar.foreground`, `menu.foreground` (light) | Default body and control text. In Modern light it equals `ink`, as in 2026 Light. |
| `--c-ink-muted` | `#9D9D9D` | `#606060` | dark [ADAPT]: Dark Modern `descriptionForeground` (2026 Dark uses `#8C8C8C`, which is `ink-faint` here; the extra step keeps D-14's five levels) / light 2026 `descriptionForeground` | Descriptions, labels. |
| `--c-ink-faint` | `#8C8C8C` | `#6B6B6B` | 2026 dark `descriptionForeground` / [ADAPT] light: VS Code `#999999` placeholder fails AA; `#6B6B6B` is 5.12:1 | Metadata, placeholders. Must pass 4.5:1. |
| `--c-ink-disabled` | `#555555` | `#BBBBBB` | `disabledForeground` | Disabled text and decorative marks only. |
| `--c-stroke` | `#2A2B2C` | `#E4E5E6` | `surface.border` | Card and surface borders. |
| `--c-stroke-dim` | `#333536` | `#F0F1F2` | `input.border` / `titleBar.border` | Keeps today's relation: brighter than `stroke` in dark, subtler in light [V theme-engine 3.1]. |

#### 2.2.2 Accent ramp (`--c-accent-50` … `--c-accent-950`)

Tailwind exposes these as `conduit-*` (`index.css:10-20`). Semantic uses: 300 = link hover text, 400 = link / active text, 500 = accent fill, ring and border, 600 = primary button, 700 = primary button hover [V usage counts, research]. In **light** mode, 300 and 400 hold text-safe shades in every scheme (D-15).

| Step | Modern dark | Modern light | Source |
|---|---|---|---|
| 50 | `#EBF4F8` | `#EBF3FB` | 90% white mix of the 500 |
| 100 | `#D7EAF2` | `#D6E7F7` | 80% white mix |
| 200 | `#B0D4E4` | `#A8CCEE` | 60% white mix |
| 300 | `#53A5CA` | `#005BB5` | dark `textLink.activeForeground`; light [ADAPT] darker hover (VS Code uses the same `#0069CC`), 6.37:1 |
| 400 | `#48A0C7` | `#0069CC` | `textLink.foreground` |
| 500 | `#3994BC` | `#0D6FCF` | dark `focusBorder` without alpha; light [ADAPT] a step lighter than 600 so the 27 legacy `hover:bg-conduit-500` hovers stay visible (white on it 5.01:1) |
| 600 | `#297AA0` | `#0069CC` | `button.background` |
| 700 | `#2B7DA3` | `#0063C1` | `button.hoverBackground` |
| 800 | `#1C4A5E` | `#004485` | 50% / 35% black mix |
| 900 | `#143442` | `#003466` | 65% / 50% black mix |
| 950 | `#0B1E26` | `#00203D` | 80% / 70% black mix |

#### 2.2.3 Layer and component tokens

| Token | Base formula (dark) | Base formula (light) | Modern dark | Modern light | VS Code source |
|---|---|---|---|---|---|
| `--c-shell` | `var(--c-panel)` | `var(--c-canvas)` | `#191A1B` | `#FAFAFD` | `titleBar.activeBackground` = `modernUI.shellBackground` |
| `--c-sidebar` | `var(--c-shell)` | `var(--c-shell)` | `#191A1B` | `#FAFAFD` | `sideBar.background` (also the AI card, [V] `.floating-panels .part.auxiliarybar`) |
| `--c-editor` | `var(--c-canvas)` | `var(--c-panel)` | `#121314` | `#FFFFFF` | `editor.background` |
| `--c-tabstrip` | `color-mix(in srgb, var(--c-panel) 70%, var(--c-raised))` | `color-mix(in srgb, var(--c-canvas) 94%, var(--c-ink))` | `#202122` | `#EAEAEA` | `editorGroupHeader.tabsBackground` (1.139 value; `main` has moved on, do not mix) |
| `--c-overlay` | `color-mix(in srgb, var(--c-panel) 70%, var(--c-raised))` | `var(--c-panel)` | `#202122` | `#FAFAFD` | `editorWidget` / `menu` / `notifications.background` |
| `--c-overlay-border` | `var(--c-stroke)` | `var(--c-stroke)` | `#2A2B2C` | `#E4E5E6` | `menu.border` |
| `--c-card-border` | `var(--c-stroke)` | `var(--c-stroke)` | `#2A2B2C` | `#E4E5E6` | `surface.border` |
| `--c-divider` | `var(--c-stroke)` | `var(--c-stroke-dim)` | `#2A2B2C` | `#F0F1F2` | `sideBarSectionHeader.border` |
| `--c-control-border` | `var(--c-stroke-dim)` | `var(--c-stroke)` | `#333536` | `#D8D8D8` | `dropdown.border` |
| `--c-editor-group-border` | `color-mix(in srgb, var(--c-ink) 9%, transparent)` | `var(--c-stroke)` | `#FFFFFF17` | `#E5E5E5` | `editorGroup.border` |
| `--c-hover` | `color-mix(in srgb, var(--c-ink) 8%, transparent)` | same | `#FFFFFF14` | `#00000014` | `list.hoverBackground` |
| `--c-selected` | `color-mix(in srgb, var(--c-ink) 13%, transparent)` | `… 14%` | `#FFFFFF22` | `#00000025` | `list.activeSelectionBackground` |
| `--c-selected-inactive` | `color-mix(in srgb, var(--c-ink) 8%, var(--c-sidebar))` | `… 9%` | `#2C2D2E` | `#DADADA99` | `list.inactiveSelectionBackground` |
| `--c-toolbar-hover` | `color-mix(in srgb, var(--c-ink) 20%, transparent)` | `… 12%` | `#5A5D5E50` | `#0000001F` | `toolbar.hoverBackground` |
| `--c-toolbar-active` | `color-mix(in srgb, var(--c-ink) 20%, transparent)` | `… 16%` | `#FFFFFF33` | `#D6D6D8` | `toolbar.activeBackground` |
| `--c-activity-active-bg` | `var(--c-selected)` | same | `#FFFFFF22` | `#E4E6F1` | `modernActivityBarItem.activeBackground` |
| `--c-activity-hover-bg` | `color-mix(in srgb, var(--c-ink) 7%, transparent)` | same | `#FFFFFF11` | `#F2F2F2` | `modernActivityBarItem.hoverBackground` |
| `--c-activity-fg` | `var(--c-ink-faint)` | same | `#8C8C8C` | `#606060` | `activityBar.inactiveForeground` |
| `--c-activity-fg-hover` | `var(--c-ink-secondary)` | same | `#BFBFBF` | `#3B3B3B` | `modernActivityBarItem.hoverForeground` (dark falls back to `modernTab.hoverForeground` = `list.hoverForeground`; light inherits Light Modern's `#3B3B3B`) [V] |
| `--c-activity-fg-active` | `var(--c-ink)` | `var(--c-ink-secondary)` | `#EDEDED` | `#3B3B3B` | `modernActivityBarItem.activeForeground` (dark falls back to `modernTab.activeForeground` = `list.inactiveSelectionForeground`; light inherits Light Modern's `#3B3B3B`) [V] |
| `--c-titlebar-fg` | `var(--c-ink-faint)` | same | `#8C8C8C` | `#606060` | `titleBar.activeForeground` |
| `--c-statusbar-fg` | `var(--c-ink-faint)` | same | `#8C8C8C` | `#606060` | `statusBar.foreground` |
| `--c-statusbar-hover` | `color-mix(in srgb, var(--c-ink) 10%, var(--c-shell))` | same | `#323233` | `#E3E3E5` | `statusBarItem.hoverBackground` |
| `--c-statusbar-hover-fg` | `var(--c-ink)` | same | `#FFFFFF` | `#000000` | `statusBarItem.hoverForeground` (inherited from Dark/Light Modern) [V] |
| `--c-statusbar-active` | `color-mix(in srgb, var(--c-ink) 20%, var(--c-shell))` | same | `#4B4C4D` | `#EEEEEE` | `statusBarItem.activeBackground` [V] |
| `--c-cc-bg` | `var(--c-shell)` | `var(--c-editor)` | `#191A1B` | `#FFFFFF` | `commandCenter.background` |
| `--c-cc-fg` | `var(--c-ink-secondary)` | `var(--c-ink)` | `#BFBFBF` | `#202020` | `commandCenter.foreground` |
| `--c-cc-border` | `color-mix(in srgb, var(--c-ink) 12%, var(--c-shell))` | `var(--c-control-border)` | `#2E3031` | `#D8D8D8AA` | `commandCenter.border` |
| `--c-cc-hover-bg` | `color-mix(in srgb, var(--c-ink) 6%, transparent)` | `color-mix(in srgb, var(--c-ink) 8%, transparent)` | `#FFFFFF0F` | `#DADADA4F` | `commandCenter.activeBackground` |
| `--c-cc-hover-border` | `var(--c-control-border)` | same | `#333536` | `#D8D8D8` | `commandCenter.activeBorder` |
| `--c-tab-fg` | `var(--c-ink-faint)` | `var(--c-ink-muted)` (ocean light overrides it to `#5C6C82`, 2.3) | `#8C8C8C` | `#606060` | `tab.inactiveForeground` (Modern UI reads it only in connected mode [V `.modern-ui-tabs.monaco-workbench:where(.modern-ui-connected-editor-tabs) {--modern-ui-editor-tab-inactive-foreground: var(--vscode-tab-inactiveForeground)}`]) |
| `--c-tab-fg-active` | `var(--c-ink)` | `var(--c-ink)` | `#EDEDED` | `#202020` | `modernEditorTab.activeForeground`, which falls back to `modernTab.activeForeground` = `list.inactiveSelectionForeground` [V]. Modern UI ignores `tab.activeForeground` and `tab.unfocusedActiveForeground`: the unfocused active tab uses the same color. |
| `--c-tab-fg-hover` | `var(--c-ink-secondary)` | `var(--c-ink)` | `#BFBFBF` | `#202020` | `modernEditorTab.hoverForeground` → `modernTab.hoverForeground` = `list.hoverForeground` [V] |
| `--c-tab-active-bg` | `var(--c-editor)` | same | `#121314` | `#FFFFFF` | connected tab = `editor.background` |
| `--c-tab-hover-bg` | `color-mix(in srgb, var(--c-ink-secondary) 6%, var(--c-tabstrip))` | same | same formula | same formula | [V] `.modern-ui-connected-editor-tabs … --modern-ui-editor-tab-hover-background: color-mix(in srgb, var(--vscode-foreground) 6%, …tabsBackground)` |
| `--c-tab-underline` | `var(--c-accent)` | `var(--c-ink)` | `#3994BC` | `#000000` | `panelTitle.activeBorder` [V]; used only by `Tabs variant="underline"` (4.7) |
| `--c-input-bg` | `var(--c-well)` | `var(--c-editor)` | `#191A1B` | `#FFFFFF` | `input.background` |
| `--c-input-fg` | `var(--c-ink)` | same | `#BFBFBF` | `#202020` | `input.foreground` |
| `--c-input-border` | `var(--c-control-border)` | same | `#333536` | `#D8D8D866` | `input.border` |
| `--c-input-placeholder` | `var(--c-ink-faint)` | same | `#8C8C8C` | `#6B6B6B` | [ADAPT] VS Code `#555555`/`#999999` fail AA |
| `--c-dropdown-bg` | `var(--c-input-bg)` | same | `#191A1B` | `#FFFFFF` | `dropdown.background` |
| `--c-dropdown-border` | `var(--c-control-border)` | same | `#333536` | `#D8D8D8` | `dropdown.border` |
| `--c-checkbox-bg` | `var(--c-input-bg)` | `var(--c-well)` | `#242526` | `#EAEAEA` | `checkbox.background` |
| `--c-checkbox-border` | `var(--c-ink-muted)` | same | `#707070` | `#868686` | `checkbox.border` (≥ 3:1 non-text) |
| `--c-checkbox-fg` | `var(--c-ink)` | same | `#8C8C8C` | `#606060` | `checkbox.foreground` |
| `--c-btn-primary-bg` | `var(--c-accent-700)` | same | `#297AA0` | `#0069CC` | `button.background` |
| `--c-btn-primary-hover` | `var(--c-accent-800)` | same | `#2B7DA3` | `#0063C1` | `button.hoverBackground` |
| `--c-btn-primary-fg` | `#FFFFFF` | same | `#FFFFFF` | `#FFFFFF` | `button.foreground` |
| `--c-btn-secondary-bg` | `transparent` | `var(--c-well)` | `#00000000` | `#EAEAEA` | `button.secondaryBackground` |
| `--c-btn-secondary-fg` | `var(--c-ink-secondary)` | `var(--c-ink)` | `#CCCCCC` | `#202020` | `button.secondaryForeground` |
| `--c-btn-secondary-hover` | `var(--c-hover)` | same | `#FFFFFF10` | `#F2F3F4` | `button.secondaryHoverBackground` |
| `--c-btn-secondary-border` | `var(--c-control-border)` | same | `#333536` | `#EAEAEA` | `button.secondaryBorder` |
| `--c-btn-danger-bg` | `#C72E0F` | same | `#C72E0F` | `#C72E0F` | `statusBarItem.errorBackground` (light) [ADAPT: used in both modes; white 5.49:1] |
| `--c-btn-danger-hover` | `#B42A1A` | same | `#B42A1A` | `#B42A1A` | [ADAPT] darker step, white 6.39:1 |
| `--c-accent` | `var(--c-accent-500)` | same | `#3994BC` | `#0069CC` | `focusBorder` / `badge` hue |
| `--c-accent-text` | `var(--c-accent-400)` | same (light 400 is text-safe) | `#48A0C7` | `#0069CC` | `textLink.foreground` |
| `--c-accent-text-hover` | `var(--c-accent-300)` | same | `#53A5CA` | `#005BB5` | `textLink.activeForeground` |
| `--c-focus` | `var(--c-accent-500)` | `var(--c-accent-600)` | `#3994BC` | `#0069CC` | `focusBorder` [ADAPT dark: VS Code `#3994BCB3` has 70% alpha, 3.17:1 effective; opaque is 5.09:1] |
| `--c-badge-bg` | `var(--c-btn-primary-bg)` | same | `#307E9F` | `#0069CC` | `badge.background` |
| `--c-badge-fg` | `#FFFFFF` | same | `#FFFFFF` | `#FFFFFF` | `badge.foreground` |
| `--c-menu-selection-bg` | `color-mix(in srgb, var(--c-accent) 15%, transparent)` | `… 10%` | `#3994BC26` | `#0069CC1A` | `menu.selectionBackground` |
| `--c-menu-selection-border` | `var(--c-accent)` | same | `#3994BC` | `#0069CC` | `menu.selectionBorder` |
| `--c-progress` | `var(--c-accent)` | same | `#878889` | `#0069CC` | `progressBar.background` |
| `--c-scrollbar-thumb` | `color-mix(in srgb, var(--c-ink-muted) 52%, transparent)` | `… 75%` | `#A8A9AA85` | `#646464C0` | `scrollbarSlider.background` |
| `--c-scrollbar-thumb-hover` | `… 56%` | `… 82%` | `#A8A9AA90` | `#646464D0` | `scrollbarSlider.hoverBackground` |
| `--c-scrollbar-thumb-active` | `… 61%` | `… 88%` | `#A8A9AA9C` | `#646464E0` | `scrollbarSlider.activeBackground` |
| `--c-drop-bg` | `color-mix(in srgb, var(--c-accent) 18%, transparent)` | same | `#3994BC1A` | `#0069CC15` | `list.dropBackground` (2026 theme) [V] |
| `--c-code-bg` | `color-mix(in srgb, var(--c-ink) 6%, var(--c-editor))` | same | `#242526` | `#EAEAEA` | `textCodeBlock.background` (2026 theme) [V]; code blocks and prose `pre`/`code` |
| `--c-menu-danger-hover-bg` | `color-mix(in srgb, var(--c-danger) 15%, transparent)` | same | same formula | same formula | none in VS Code; the popup menu's `dangerHover` (7.7) |
| `--c-sash-grip` | `color-mix(in srgb, var(--c-ink-secondary) 40%, transparent)` | same | `#BFBFBF66` | `#20202066` | `modernSash.gripForeground` = `foreground` at 40% alpha [V] |
| `--c-indent-guide` | `color-mix(in srgb, var(--c-ink) 30%, var(--c-sidebar))` | `… 37%` | `#585858` | `#A9A9A9` | `tree.indentGuidesStroke` (registry default; the 2026 themes do not set it) [V] |
| `--c-scrim` | `rgb(0 0 0 / 0.5)` | same | same | same | [ADAPT] unchanged from today's `bg-black/50` |
| `--c-scrim-sidebar` | `rgb(0 0 0 / 0.2)` | same | same | same | unchanged from `SidebarPanel.tsx:36` |

#### 2.2.4 Status, connection state and entry-type colors

Status colors do not change per scheme (VS Code keeps them fixed). They are text and icon colors. They pass 4.5:1 on shell, editor and overlay in both modes, and `danger`, `warning` and `success` also pass 4.5:1 on their own `-bg` token, where Badge puts them (2.11) [V computed].

| Token | Dark | Light | VS Code source |
|---|---|---|---|
| `--c-danger` | `#F48771` | `#AD0707` | `errorForeground` |
| `--c-warning` | `#E5BA7D` | `#895503` | dark `list.warningForeground`; light `problemsWarningIcon.foreground` (D-16) [V] |
| `--c-success` | `#73C991` | `#4B6A0A` | dark `gitDecoration.addedResourceForeground`; light [ADAPT] darker than its `#587C0C` (D-16) |
| `--c-info` | Modern `#3A94BC`; base `var(--c-accent-text)` | Modern `#0069CC`; base `var(--c-accent-text)` | `notificationsInfoIcon.foreground` |
| `--c-danger-bg` / `--c-danger-border` | Modern `#3A1D1D` / `#BE1100`; base `color-mix(in srgb, var(--c-danger) 10%, var(--c-overlay))` / `color-mix(in srgb, var(--c-danger) 45%, transparent)` | Modern `#FDEDED` / `#AD0707`; base same formulas | `inputValidation.error*` |
| `--c-warning-bg` / `--c-warning-border` | Modern `#352A05` / `#B89500`; base formulas as above | Modern `#FDF6E3` / `#B69500` | `inputValidation.warning*` |
| `--c-info-bg` / `--c-info-border` | Modern `#1E3A47` / `#3994BC`; base formulas | Modern `#E6F2FA` / `#0069CC` | `inputValidation.info*` (2026 theme) [V] |
| `--c-success-bg` / `--c-success-border` | base formulas (all schemes) | base formulas | none in VS Code |
| `--c-state-connected` | `var(--c-success)` | same | |
| `--c-state-connecting` | `var(--c-warning)` | same | |
| `--c-state-error` | `var(--c-danger)` | same | |

The base tint is 10%, not 12%: at 12% `danger` on its tint measures 4.48:1 in Ocean dark [V computed with exact `color-mix`].

Entry-type identity colors replace the hard-coded Tailwind classes in `entryIcons.ts:61-80`. Dark keeps today's Tailwind 400 shades. Light moves to the 700 shades so the glyphs reach 3:1 against the light side bar (yellow-600 was 2.82:1) [V computed]:

| Token | Dark | Light |
|---|---|---|
| `--c-entry-ssh` | `#4ADE80` | `#15803D` |
| `--c-entry-rdp` | `#60A5FA` | `#1D4ED8` |
| `--c-entry-vnc` | `#C084FC` | `#7E22CE` |
| `--c-entry-web` | `#22D3EE` | `#0E7490` |
| `--c-entry-credential` | `#FACC15` | `#A16207` |
| `--c-entry-document` | `#2DD4BF` | `#0F766E` |
| `--c-entry-command` | `#FBBF24` | `#B45309` |
| `--c-entry-folder` | `var(--c-ink-muted)` | `var(--c-ink-muted)` |

Terminal ANSI colors stay fixed (`terminalTheme.ts:43-58`).

Kept as they are: the team tokens `--c-team-bg`, `--c-team-border` and `--c-team-border-strong` (`index.css:95-99`, mixes of `--c-accent-500`), and their Tailwind names `team`, `team-border` and `team-border-strong` (`index.css:23-25`).

### 2.3 Universal schemes on the new contract

The six universal schemes keep their primitives exactly as today (`src/index.css:101-365` [V]), move into `schemes.css` as `:root[data-scheme="<id>"].dark` / `.light` blocks, and add only these overrides. Everything else comes from the base formulas.

**Per-scheme overrides:**

| Scheme | Mode | `--c-ink-faint` (new, AA) | `--c-ink-disabled` (= old faint) | `--c-ink-muted` | `--c-accent-300` / `--c-accent-400` | `--c-btn-primary-bg` / `-hover` |
|---|---|---|---|---|---|---|
| ocean | dark | `#8B98AA` | `#64748b` | unchanged | ramp (`#7dd3fc` / `#38bdf8`) | 700 `#0369a1` / 800 `#075985` |
| ocean | light | `#677388` | `#94a3b8` | unchanged | 800 `#075985` / 700 `#0369a1` | 700 / 800 |
| ember | dark | `#888078` | `#615850` | unchanged | ramp | 700 `#c2410c` / 800 `#9a3412` |
| ember | light | `#7D7367` | `#9c9286` | unchanged | 800 `#9a3412` / 700 `#c2410c` | 700 / 800 |
| forest | dark | `#7F9089` | `#546860` | `#7B9189` | ramp | 700 `#047857` / 800 `#065f46` |
| forest | light | `#60776B` | `#8aa496` | unchanged | 800 `#065f46` / 700 `#047857` | 700 / 800 |
| amethyst | dark | `#878296` | `#5e5870` | `#88809C` | ramp | 600 `#7c3aed` / 700 `#6d28d9` |
| amethyst | light | `#736E8B` | `#908aa8` | unchanged | 700 `#6d28d9` / 600 `#7c3aed` | 600 / 700 |
| rose | dark | `#8E8087` | `#685860` | `#957D83` | ramp | 600 `#e11d48` / 700 `#be123c` |
| rose | light | `#856B74` | `#9c828c` | unchanged | 800 `#9f1239` / 700 `#be123c` | 600 / 700 |
| midnight | dark | `#748289` | `#506068` | unchanged | ramp | 700 `#0e7490` / 800 `#155e75` |
| midnight | light | `#5F7681` | `#84a0ac` | unchanged | 800 `#155e75` / 700 `#0e7490` | 700 / 800 |

The new faint values are the old faint mixed toward `--c-ink` in 1% steps until the minimum contrast on shell, editor and overlay reaches 4.5:1 [V computed, `scratchpad/spec/palette.py`]. The check uses the exact `color-mix()` result for the overlay, not a rounded hex: rounded, Forest dark passed at 4.50, but exactly its faint and muted measured 4.49, so both moved one step (`#7F9089`, `#7B9189`, now 4.55) [V computed, review pass]. Buttons use the first ramp step whose contrast with white text is ≥ 4.5:1.

One more per-scheme override: Ocean light sets `--c-tab-fg: #5C6C82`. Its `ink-muted` (`#64748b`) measures 4.02:1 on the Ocean light tab strip (`#EAECEF`); `#5C6C82` measures 4.54:1 there [V computed].

**Resolved derived surfaces** (formulas evaluated in sRGB) [V computed]:

| Scheme | Mode | shell / sidebar | editor | tabstrip | overlay | hover (opaque on shell) | selected (opaque on shell) |
|---|---|---|---|---|---|---|---|
| ocean | dark | `#1e293b` | `#0f172a` | `#243043` | `#243043` | `#2F394A` | `#394454` |
| ocean | light | `#f8fafc` | `#ffffff` | `#EAECEF` | `#ffffff` | `#E5E8EB` | `#D7DADF` |
| ember | dark | `#1a1210` | `#000000` | `#201712` | `#201712` | `#2B2321` | `#362E2C` |
| ember | light | `#fffbf5` | `#ffffff` | `#F1EDE7` | `#ffffff` | `#EDE8E2` | `#DFDAD3` |
| forest | dark | `#12231a` | `#0a1510` | `#16291E` | `#16291E` | `#23332A` | `#2D3E35` |
| forest | light | `#f2faf5` | `#ffffff` | `#E4EDE8` | `#ffffff` | `#E0E8E3` | `#D2DBD6` |
| amethyst | dark | `#1a1430` | `#0e0a18` | `#1E1736` | `#1E1736` | `#2B2540` | `#353049` |
| amethyst | light | `#f8f5ff` | `#ffffff` | `#EAE7F2` | `#ffffff` | `#E6E3EE` | `#D8D5E1` |
| rose | dark | `#221418` | `#140a0c` | `#29161B` | `#29161B` | `#322529` | `#3D3033` |
| rose | light | `#fef5f6` | `#ffffff` | `#F1E7E8` | `#ffffff` | `#EDE3E4` | `#E0D5D6` |
| midnight | dark | `#0a1418` | `#000000` | `#0D181D` | `#0D181D` | `#1B2529` | `#263034` |
| midnight | light | `#f4fafc` | `#ffffff` | `#E6EDEF` | `#ffffff` | `#E1E8EB` | `#D4DBDD` |

Two facts this fixes [V critic]: in light mode every universal scheme now has the editor lighter than the shell (like VS Code), and the tab strip always differs from the editor, so a connected active tab never looks darker than its strip.

**Retired native schemes** (`macos-blue`, `macos-graphite`, `win-blue`, `win-sun-valley`, `ubuntu-yaru`, `ubuntu-gnome`): delete their blocks (`index.css:372-400`). The migration maps them (section 6.3).

### 2.4 Typography

Font stacks (VS Code 1.139 `.monaco-workbench` stacks [V], set on `<html data-os>`):

```css
:root                   { --c-font-ui: system-ui, -apple-system, "Segoe UI", sans-serif;
                          --c-font-mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace; }
:root[data-os="macos"]  { --c-font-ui: -apple-system, BlinkMacSystemFont, sans-serif;
                          --c-font-mono: "SF Mono", Monaco, Menlo, Courier, monospace; }
:root[data-os="windows"]{ --c-font-ui: "Segoe WPC", "Segoe UI", sans-serif;
                          --c-font-mono: Consolas, "Courier New", monospace; }
:root[data-os="linux"]  { --c-font-ui: system-ui, "Ubuntu", "Droid Sans", sans-serif;
                          --c-font-mono: "Ubuntu Mono", "Liberation Mono", "DejaVu Sans Mono", "Courier New", monospace; }
```

All four mono stacks are VS Code's `--monaco-monospace-font` per OS [V `.monaco-workbench.linux {--monaco-monospace-font: …}`]. `monospace` stays unquoted so it is the generic family.

`Inter` is dropped. It was never bundled; the owner saw it only because it is installed locally [V critic 5]. Review screenshots on a machine without Inter.

Terminals keep `Menlo, Monaco, "Courier New", monospace` (`TerminalView.tsx:89`, `CommandView.tsx:82`) (OD-6).

Type ramp (VS Code `fontSize.*` tokens [V]; line heights follow VS Code's `1.4em` rounded to the 2px grid):

| Token | Size / line height | Weight | Tailwind | VS Code | Used for |
|---|---|---|---|---|---|
| `--c-text-display` | 26px / 32px | 600 | `text-display` | `fontSize.heading1` | Landing-page titles (auth, hub, welcome) |
| `--c-text-title` | 18px / 24px | 600 | `text-title` (and `text-lg`) | `fontSize.heading2` | Page and large section titles |
| `--c-text-heading` | 13px / 18px | 600 | `text-heading` | `fontSize.heading3` = 13px [V]; Modern dialog titles use it (`.modern-ui-notifications-dialogs … .dialog-message {font-size: var(--vscode-fontSize-heading3); font-weight: semiBold}` [V], which overrides the older 14px rule) | Dialog titles |
| `--c-text-body` | 13px / 18px | 400 | `text-body` (and `text-sm`) | `fontSize.body1`, workbench base | Body, tabs, tree rows, inputs, menus |
| `--c-text-label` | 12px / 16px | 400 / 600 | `text-label` (and `text-xs`) | `fontSize.label1` | Buttons, part titles and section headers (600), status bar, title bar |
| `--c-text-meta` | 11px / 16px | 400 | `text-meta` | `fontSize.label2` | Metadata, group labels, keyboard hints |
| `--c-text-badge` | 10px / 14px | 400 / 600 | `text-badge` | `fontSize.label3` | Badges |

Weights: `--c-weight-regular: 400`, `--c-weight-strong: 600`. `font-medium`, `font-semibold`, `font-bold` all compile to 600 (D-23).

`body { font-family: var(--c-font-ui); font-size: var(--c-text-body); line-height: var(--c-text-body-lh); color: var(--c-ink); }`. Do not change the `html` font size: Tailwind spacing is in `rem` and must stay 4px per unit.

### 2.5 Spacing, radii, sizes

**Spacing.** VS Code's ramp (`spacing.size20 … size400` = 2, 4, 6, 8, 10, 12, 16, 20, 24, 28, 32, 36, 40px [V]) equals Tailwind's default rem scale with a 16px root: `0.5`=2, `1`=4, `1.5`=6, `2`=8, `2.5`=10, `3`=12, `4`=16, `5`=20, `6`=24, `7`=28, `8`=32, `9`=36, `10`=40. Use those classes; add no spacing tokens. Dominant rhythm: 4px spacing, 4px control radius, 8px container radius, 1px stroke [V usage counts].

**Radii** (`cornerRadius.*` [V]; policy from VS Code `roundedCorners.css`: controls 4, inner containers 6, overlays 8):

| Token | Value | Tailwind | Use |
|---|---|---|---|
| `--c-radius-xs` | 2px | `rounded-xs` | Checkbox inner marks |
| `--c-radius-sm` / `--c-radius-control` | 4px | `rounded`, `rounded-sm`, `rounded-control` | Buttons, inputs, selects, list rows, tabs, status bar items, activity pill, toolbar icon buttons (Modern UI sets `.monaco-action-bar .action-label` to `cornerRadius.small` [V `.modern-ui .monaco-action-bar .action-label {border-radius: var(--vscode-cornerRadius-small)}`]) |
| `--c-radius-md` / `--c-radius-container` | 6px | `rounded-md`, `rounded-container` | Cards, callouts, menu items, title bar pill |
| `--c-radius-lg` / `--c-radius-overlay` | 8px | `rounded-lg`, `rounded-overlay` | Menus, dialogs, popovers, toasts |
| `--c-radius-xl` | 12px | `rounded-xl` | Legacy only |
| `--c-radius-full` | 9999px | `rounded-full` | Count badges, switches, status dots |
| `--c-card-radius` | 8px / 0 compact | `rounded-card` | Workbench cards |
| `--c-tab-cap-radius` | 5px | (tabs.css) | Connected tab top corners and shoulders (4 + 1 stroke) [V] |

**Control and row sizes:**

| Token | Value | Tailwind | Source |
|---|---|---|---|
| `--c-control-h-sm` | 22px | `h-control-sm` | VS Code small button (11px, 3px 6px padding) [V] |
| `--c-control-h` | 26px | `h-control` | `.monaco-text-button` 4px 8px padding, 16px line, 1px border [V]; inputs 4px 6px padding at 13px [V] |
| `--c-control-h-lg` | 32px | `h-control-lg` | [ADAPT] landing-page CTAs (auth, onboarding, hub); VS Code has no large button |
| `--c-row-h` | 22px | `h-row` | `ITEM_HEIGHT=22` [V] |
| `--c-row-h-2line` | 36px | `h-row-2line` | [ADAPT] list rows with a description line (picker, vault hub) |
| `--c-icon-sm` / `--c-icon` / `--c-icon-lg` | 12 / 16 / 24px | (props) | `codiconFontSize` 16, compact 12, activity bar 24 [V] |
| `--c-toolbar-btn` | 22px | `size-toolbar` | `.monaco-action-bar .action-label {padding:3px}` + 16px icon; radius 4 in Modern UI [V] |

**Layout sizes** (mode-independent; density ones in section 2.9):

| Token | Value | Source |
|---|---|---|
| `--c-titlebar-h` | 35px (DIP, counter-zoomed) | `Pne=35` with command center [V] |
| `--c-traffic-reserve` | 70px (0 in full screen or native title bar) | `.mac .window-controls-container {width:70px}` [V] |
| `--c-wco-reserve-start` / `--c-wco-reserve-end` | 0 / 138px until known, then from the WCO rect, each clamped to 0..300 (3.2) | `.windows .window-controls-container {width:calc(138px / zoom)}`; Linux reads both sides from `env(titlebar-area-*)` [V] |
| `--c-cc-h` / `--c-cc-w` / `--c-cc-max-w` | 22px / 38vw / 600px | `.command-center-center {height:22px;width:38vw;max-width:600px}` [V] |
| `--c-banner-h` | 26px | banner part `height=26` [V] |
| `--c-part-title-h` | 32px | `AREA_HEIGHT_MODERN_UI=32` [V] |
| `--c-section-h` | 28px | `--pane-header-size: 28px` [V research] |
| `--c-statusbar-h` | 22px | `HEIGHT=22` [V] |
| `--c-activity-item` | 36px | `FLOATING_ACTION_HEIGHT=36` [V] |
| `--c-activity-pill` | 32px | `calc(action-height - 4px)` [V] |
| `--c-zoom` | 1 (set from JS) | Used by the title bar counter-zoom |

A TypeScript mirror of the numeric layout tokens lives in `src/styles/metrics.ts` (used by `sidebarStore` chrome math and the content-size fallbacks). A unit test asserts `metrics.ts` equals the values in `tokens.css` and `density.css`.

**Electron code never imports from `src/`.** `electron/tsconfig.json` has `rootDir: "."`, so an import of `src/…` fails `tsc -p electron/tsconfig.json` and the harness build (TS6059). The main process keeps its own constants (for example the status bar heights 28 and 26 used for the toast inset, 7.6). Tests that compare the two sides read JSON with `fs.readFileSync`, or live in `scripts/__tests__/`, which neither tsconfig checks and vitest resolves across both trees.

### 2.6 Shadows, motion, z-index

| Token | Value | Tailwind | Use |
|---|---|---|---|
| `--c-shadow-sm` | `none` | `shadow-sm` | Chrome is flat (VS Code sets `--vscode-shadow-sm` transparent in Modern UI [V]) |
| `--c-shadow-md` | `0 0 6px rgba(0,0,0,.08)` | `shadow-md` | Modern UI zeroes only `shadow-sm`; `--vscode-shadow-md` keeps its value [V `.modern-ui.monaco-workbench {--vscode-shadow-sm: 0 0 0 0 transparent}`] |
| `--c-shadow-overlay` | `0 0 12px rgba(0,0,0,.14)` | `shadow-lg`, `shadow-overlay` | Menus, popovers, toasts, floating side bar (`--vscode-shadow-lg` [V]) |
| `--c-shadow-modal` | `0 0 20px rgba(0,0,0,.15)` | `shadow-xl`, `shadow-modal` | Dialogs (`--vscode-shadow-xl` [V]) |

| Token | Value | Use |
|---|---|---|
| `--c-motion-open` | 250ms | DOM menus and popovers: opacity 0→1 and `scale(.97)`→`scale(1)` from the anchor corner [V `.modern-ui.monaco-enable-motion .action-widget.action-widget-dropdown {animation: … .25s cubic-bezier(.22,1,.36,1)}`]. Dialogs do not animate (D-25) |
| `--c-motion-close` | 150ms | DOM menus and popovers: to opacity 0 and `scale(.99)` |
| `--c-motion-fast` | 100ms | Hover color changes, sash highlight (`background-color .1s ease-out` [V]), sash grip fade |
| `--c-ease-out` | `cubic-bezier(0.22, 1, 0.36, 1)` | All of the above |
| `--c-sash-delay` | 300ms | Delay before a sash shows its hover color |

Under `@media (prefers-reduced-motion: reduce)`, set all three durations to `0ms` and disable the side bar slide. Never animate layout boxes that contain sessions (section 3.11).

| Token | Value | Layer |
|---|---|---|
| `--c-z-sticky` | 10 | Sticky `+` button in tab strips, drop-zone overlay |
| `--c-z-sidebar-scrim` | 30 | Floating side bar scrim |
| `--c-z-sidebar` | 40 | Floating side bar card |
| `--c-z-dialog` | 50 | Dialogs, layer `base` |
| `--c-z-dialog-sync` | 60 | Dialogs, layer `sync` (above unlock, as today `SyncDialogFrame.tsx:48`) |
| `--c-z-dialog-stacked` | 70 | Dialogs, layer `stacked` (confirm above a sync panel, as today `RecentlyDeletedPanel.tsx:130`) |
| `--c-z-popover` | 80 | Popovers and DOM menus (above any dialog that owns them) |

### 2.7 Focus ring

One rule set in `base.css`, zero specificity so components can refine it:

```css
:where(button, [role="button"], [role="tab"], [role="menuitem"], [role="option"], [role="treeitem"],
       [role="switch"], [role="radio"], a, summary, [tabindex],
       input:not([data-bare]), select, textarea):focus-visible {
  outline: 1px solid var(--c-focus);
  outline-offset: -1px;                  /* VS Code default: drawn inside [V] */
}
:where([data-cv-text-button], input[type="checkbox"], input[type="radio"]):focus-visible {
  outline-offset: 2px;                   /* VS Code text buttons and checkboxes only [V] */
}
```

VS Code draws the default ring inside the element: `.monaco-workbench [tabindex="0"]:focus, … button:focus, … input[type=checkbox]:focus {outline-width:1px; outline-style:solid; outline-offset:-1px}`, then moves it 2px outside only for `input[type=checkbox]:focus` and `.monaco-text-button:focus` [V]. An outside ring would be clipped by `.cv-card {overflow:hidden}`, `.cv-tabs {overflow-y:hidden}` and the 22px status bar. The `Button` primitive (text buttons) sets `data-cv-text-button`; `IconButton`, status bar items, title bar controls, tab close buttons and activity items keep the inset ring. The `Checkbox` and `Radio` inputs get the 2px ring because of the second rule, which beats the `input` part of the first (same zero specificity, later in the file).

This replaces `index.css:418-430`, which removed button focus outlines entirely (1 of 452 buttons re-added one [V research]). `:focus-visible` does not match mouse clicks on buttons, so pointer users see no ring. Composite fields whose wrapper shows focus keep `data-bare` on the inner input and put `focus-within:outline …` on the wrapper. The gallery (4.1) shows every focusable primitive focused inside a Card and inside a tab strip, so a clipped ring is visible in review.

### 2.8 Other global rules in `base.css`

- `:root.dark { color-scheme: dark } :root.light { color-scheme: light }` so native `<select>` popups, spinners and scrollbars follow the mode (missing today [V]).
- `[data-os="macos"] body { -webkit-font-smoothing: antialiased; }` (VS Code does this on macOS).
- `body { user-select: none }` and the input/`.allow-select` exceptions stay (`index.css:406-437`).
- `::selection { background: color-mix(in srgb, var(--c-accent) 35%, transparent); }`.
- Scrollbars: 8px, transparent track, thumb `--c-scrollbar-thumb` with hover/active variants, radius 4 [V: Modern UI uses 8 instead of the classic 10, `applyScrollbarSize(e){iAi(e?I4r:vHt)}` with `I4r=8`, `vHt=10`; slider radius `cornerRadius.small`]. `.scrollbar-autohide` keeps its JS fade but uses 8px and the token colors. `.xterm .xterm-viewport` keeps its 4px bar (`index.css:498-514`), and the tab strip keeps its 3px bar (3.6).
- Keyframes kept: `toast-in/out`, `sidebar-in/out`, `indeterminate`. New: `cv-pop-in` / `cv-pop-out` (opacity + scale, section 2.6).

### 2.9 Density

`ui_density` sets `<html data-density="comfortable|compact">`. Comfortable values live in `:root`; Compact overrides in `:root[data-density="compact"]`.

| Token | Comfortable | Compact | VS Code |
|---|---|---|---|
| `--c-gap` (between cards; card to status bar) | 4px | 0 | `--modern-ui-floating-card-margin` 4 / 0 [V] |
| `--c-outer` (cards to window edge) | 4px | 0 | outer margin 4 [V]; [ADAPT] compact 0: the owner asked for "no gaps", and remote screens gain the pixels |
| `--c-card-radius` | 8px | 0 | `cornerRadius.large` / 0 [V] |
| `--c-card-border-w` | 1px | 0 (dividers take over) | [V] compact sets card border transparent |
| `--c-activitybar-lane` | 8px | 4px | `--modern-ui-activitybar-lane` [V] |
| `--c-activitybar-w` (card) | 44px | 40px | 36 + lane [V] |
| `--c-activity-gap` | 8px | 4px | `FLOATING_ACTION_GAP` / compact [V] |
| `--c-tabstrip-h` | 33px | 29px | `EDITOR_TAB_HEIGHT` modernUI 32 / 28, +1 connected [V]. [ADAPT] VS Code picks 28 from a separate setting (`window.density.editorTabHeight`, read as `partOptions.tabHeight === "compact"`), not from the layout density [V]; Conduit ties it to Compact because the owner asked Compact to free up room for sessions |
| `--c-tab-h` (painted tab body) | 24px | 20px | `--editor-group-tab-height` [V] |
| `--c-tab-gutter-top` | 4px | 4px | strip padding [V] |
| `--c-statusbar-gutter` | 6px | 4px | `FLOATING_BOTTOM_PADDING` / compact [V] |
| `--c-list-inset` | 4px | 2px | row inset [V research] |

Typography, control heights (26/22/32) and row height (22) do not change with density, as in VS Code.

In Compact, dividers replace card borders: title bar `border-bottom: 1px solid var(--c-divider)`; activity bar `border-right`; status bar `border-top`. Between the docked side bar and the editor, and between the editor and the AI side bar, the divider is the 1px line painted inside the 4px in-flow sash (3.3). Everything else touches.

### 2.10 Tailwind v4 `@theme` mapping

Complete block for `src/index.css`. Every entry below was test-compiled with the repo's Tailwind 4.2.1 and produced the expected utility (`h-control` → `height: var(--spacing-control)`, `rounded` → `border-radius: var(--radius)`, `bg-danger/10` → `color-mix(in oklab, …)`, `compact:` variant) [V `scratchpad/spec/tw/`].

```css
@theme {
  /* fonts */
  --font-sans: var(--c-font-ui);
  --font-mono: var(--c-font-mono);
  --font-weight-medium: 600;
  --font-weight-semibold: 600;
  --font-weight-bold: 600;

  /* type (legacy sizes re-pointed + named ramp) */
  --text-xs: var(--c-text-label);   --text-xs--line-height: var(--c-text-label-lh);
  --text-sm: var(--c-text-body);    --text-sm--line-height: var(--c-text-body-lh);
  --text-lg: var(--c-text-title);   --text-lg--line-height: var(--c-text-title-lh);
  --text-display: var(--c-text-display); --text-display--line-height: var(--c-text-display-lh);
  --text-title:   var(--c-text-title);   --text-title--line-height:   var(--c-text-title-lh);
  --text-heading: var(--c-text-heading); --text-heading--line-height: var(--c-text-heading-lh);
  --text-body:    var(--c-text-body);    --text-body--line-height:    var(--c-text-body-lh);
  --text-label:   var(--c-text-label);   --text-label--line-height:   var(--c-text-label-lh);
  --text-meta:    var(--c-text-meta);    --text-meta--line-height:    var(--c-text-meta-lh);
  --text-badge:   var(--c-text-badge);   --text-badge--line-height:   var(--c-text-badge-lh);

  /* radii */
  --radius: var(--c-radius-sm);              /* bare `rounded` (≈430 uses) now follows tokens */
  --radius-xs: var(--c-radius-xs);
  --radius-sm: var(--c-radius-sm);
  --radius-md: var(--c-radius-md);
  --radius-lg: var(--c-radius-lg);
  --radius-xl: var(--c-radius-xl);
  --radius-full: var(--c-radius-full);
  --radius-control: var(--c-radius-sm);
  --radius-container: var(--c-radius-md);
  --radius-overlay: var(--c-radius-lg);
  --radius-card: var(--c-card-radius);

  /* shadows */
  --shadow-sm: var(--c-shadow-sm);
  --shadow-md: var(--c-shadow-md);
  --shadow-lg: var(--c-shadow-overlay);
  --shadow-xl: var(--c-shadow-modal);        /* 43 dialogs used a literal shadow-xl */
  --shadow-overlay: var(--c-shadow-overlay);
  --shadow-modal: var(--c-shadow-modal);

  /* sizes (h-*, w-*, size-*, min-h-* …) */
  --spacing-control: var(--c-control-h);
  --spacing-control-sm: var(--c-control-h-sm);
  --spacing-control-lg: var(--c-control-h-lg);
  --spacing-row: var(--c-row-h);
  --spacing-row-2line: var(--c-row-h-2line);
  --spacing-toolbar: var(--c-toolbar-btn);
  --spacing-titlebar: var(--c-titlebar-h);
  --spacing-banner: var(--c-banner-h);
  --spacing-part-title: var(--c-part-title-h);
  --spacing-section: var(--c-section-h);
  --spacing-statusbar: var(--c-statusbar-h);
  --spacing-tabstrip: var(--c-tabstrip-h);
  --spacing-activitybar: var(--c-activitybar-w);

  /* legacy colors (unchanged names) */
  --color-conduit-50: var(--c-accent-50);   /* … through 950, as today (index.css:10-20) */
  --color-canvas: var(--c-canvas);  --color-panel: var(--c-panel);  --color-raised: var(--c-raised);
  --color-well: var(--c-well);      --color-ink: var(--c-ink);      --color-ink-secondary: var(--c-ink-secondary);
  --color-ink-muted: var(--c-ink-muted); --color-ink-faint: var(--c-ink-faint);
  --color-stroke: var(--c-stroke);  --color-stroke-dim: var(--c-stroke-dim);
  --color-team: var(--c-team-bg);   --color-team-border: var(--c-team-border); --color-team-border-strong: var(--c-team-border-strong);

  /* new semantic colors */
  --color-ink-disabled: var(--c-ink-disabled);
  --color-shell: var(--c-shell);       --color-sidebar: var(--c-sidebar);     --color-editor: var(--c-editor);
  --color-tabstrip: var(--c-tabstrip); --color-overlay: var(--c-overlay);     --color-overlay-border: var(--c-overlay-border);
  --color-card-border: var(--c-card-border); --color-divider: var(--c-divider); --color-control: var(--c-control-border);
  --color-hover: var(--c-hover);       --color-selected: var(--c-selected);   --color-selected-inactive: var(--c-selected-inactive);
  --color-toolbar-hover: var(--c-toolbar-hover); --color-toolbar-active: var(--c-toolbar-active);
  --color-accent: var(--c-accent);     --color-link: var(--c-accent-text);    --color-link-hover: var(--c-accent-text-hover);
  --color-focus: var(--c-focus);       --color-badge: var(--c-badge-bg);      --color-code: var(--c-code-bg);
  --color-btn-primary: var(--c-btn-primary-bg); --color-btn-primary-hover: var(--c-btn-primary-hover);
  --color-btn-danger: var(--c-btn-danger-bg);   --color-btn-danger-hover: var(--c-btn-danger-hover);
  --color-input: var(--c-input-bg);    --color-input-border: var(--c-input-border);
  --color-danger: var(--c-danger);     --color-danger-bg: var(--c-danger-bg);   --color-danger-border: var(--c-danger-border);
  --color-warning: var(--c-warning);   --color-warning-bg: var(--c-warning-bg); --color-warning-border: var(--c-warning-border);
  --color-success: var(--c-success);   --color-success-bg: var(--c-success-bg); --color-success-border: var(--c-success-border);
  --color-info: var(--c-info);         --color-info-bg: var(--c-info-bg);       --color-info-border: var(--c-info-border);
  --color-entry-ssh: var(--c-entry-ssh); --color-entry-rdp: var(--c-entry-rdp); --color-entry-vnc: var(--c-entry-vnc);
  --color-entry-web: var(--c-entry-web); --color-entry-credential: var(--c-entry-credential);
  --color-entry-document: var(--c-entry-document); --color-entry-command: var(--c-entry-command);
  --color-entry-folder: var(--c-entry-folder);
}
```

Legacy utilities after wave 1 (no JSX change needed):

| Utility | Before | After |
|---|---|---|
| `rounded` (≈430) | literal `.25rem` | `var(--radius)` = 4px, tokenized |
| `shadow-xl` (43) | literal Tailwind shadow | modal shadow |
| `shadow-lg` (9) | `--c-shadow-lg` | overlay shadow |
| `text-sm` (558) | 14px / 20px | 13px / 18px |
| `text-xs` (446) | 12px / 16px | 12px / 16px (tokenized) |
| `text-lg` (39) | 18px / 28px | 18px / 24px |
| `font-medium` (≈45) | 500 | 600 |
| `font-mono` (51) | Tailwind default stack | per-OS VS Code mono stack |
| `text-conduit-400` in light mode | 2.1 to 3.3:1 | ≥ 5:1 (D-15) |
| `text-ink-faint` | 2.2 to 3.3:1 | ≥ 4.5:1 |

The `text-sm` change shrinks most text by 1px on day one of wave 1. That is intended (OD-6).

`text-[10px]` (74) and `text-[11px]` (36) are migrated by wave-3 packages to `text-badge` / `text-meta`.

### 2.11 Contrast table

Minimum contrast of each text token against the shell, editor and overlay surfaces of its scheme and mode, after the changes above [V computed, WCAG relative luminance]. "Faint before" is today's value.

| Scheme / mode | ink | ink-secondary | ink-muted | ink-faint before → after | accent text | white on primary button (rest / hover) | focus ring |
|---|---|---|---|---|---|---|---|
| modern dark | 13.78 | 8.77 | 5.95 | 2.16 → 4.80 | 5.47 | 4.79 / 4.60 | 4.71 |
| modern light | 15.64 | 15.64 (equals ink) | 6.04 | 2.73 → 5.12 | 5.18 | 5.39 / 5.91 | 5.18 |
| ocean dark | 12.14 | 8.96 | 5.19 | 2.79 → 4.54 | 6.21 | 5.93 / 7.56 | 4.80 |
| ocean light | 17.06 | 9.90 | 4.55 | 2.45 → 4.58 | 5.67 | 5.93 / 7.56 | 3.91 |
| ember dark | 14.85 | 9.04 | 4.80 | 2.53 → 4.53 | 7.78 | 5.18 / 7.31 | 6.28 |
| ember light | 18.18 | 12.20 | 5.94 | 2.97 → 4.51 | 5.02 | 5.18 / 7.31 | 3.45 |
| forest dark | 13.00 | 8.35 | 4.55 (was 4.49 exact) | 2.57 → 4.55 | 7.97 | 5.48 / 7.68 | 6.04 |
| forest light | 16.59 | 10.73 | 5.21 | 2.52 → 4.55 | 5.16 | 5.48 / 7.68 | 3.55 |
| amethyst dark | 14.13 | 8.19 | 4.56 (was 4.32) | 2.52 → 4.60 | 6.27 | 5.70 / 7.10 | 4.03 |
| amethyst light | 17.14 | 12.02 | 6.33 | 3.05 → 4.50 | 5.29 | 5.70 / 7.10 | 5.29 |
| rose dark | 14.23 | 8.72 | 4.52 (was 4.46) | 2.57 → 4.56 | 6.37 | 4.70 / 6.29 | 4.67 |
| rose light | 16.74 | 12.83 | 6.78 | 3.28 → 4.50 | 5.87 | 4.70 / 6.29 | 4.39 |
| midnight dark | 15.06 | 9.16 | 5.09 | 2.76 → 4.54 | 9.97 | 5.36 / 7.27 | 7.42 |
| midnight light | 16.79 | 11.22 | 5.44 | 2.62 → 4.53 | 5.08 | 5.36 / 7.27 | 3.49 |

Rules the gates enforce (section 2.1 test). The resolver evaluates `color-mix()` exactly (floating point, no rounding between steps) and composites alpha on the surface named in the pair:

1. `ink`, `ink-secondary`, `ink-muted`, `ink-faint`, `accent-text`, `danger`, `warning`, `success`, `info` ≥ 4.5:1 on `shell`, `editor`, `overlay`.
2. Chrome text on its own surface ≥ 4.5:1: `tab-fg` on `tabstrip`; `tab-fg-active` on `tab-active-bg`; `tab-fg-hover` on `tab-hover-bg`; `titlebar-fg` and `statusbar-fg` on `shell`; `statusbar-hover-fg` on `statusbar-hover` and on `statusbar-active`; `cc-fg` on `cc-bg`.
3. Tone text on its own tint ≥ 4.5:1: `danger` on `danger-bg`, `warning` on `warning-bg`, `success` on `success-bg` (Badge, 4.12). `info` on `info-bg` ≥ 3:1, because info text never sits on it (Callout and Banner put text in `ink`, only the icon in `info`).
4. Text inside a selected row ≥ 4.5:1 on `selected` composited over `sidebar`: `ink` and `ink-secondary`. Inside a selected row `ink-muted`, `ink-faint` and link colors are re-scoped (rule below), so they are not gated there.
5. White on `btn-primary-bg`, `btn-primary-hover`, `badge-bg`, `btn-danger-bg`, `btn-danger-hover` ≥ 4.5:1.
6. Non-text ≥ 3:1 (WCAG 1.4.11): `focus`, `checkbox-border` (on `shell`, `editor`, `overlay` and on `checkbox-bg`), `state-*` and `entry-*` against the surfaces they sit on, `activity-fg-active` on the active pill, `info` on `info-bg`.
7. `ink-disabled` is exempt (disabled controls), and no component may use it for enabled text.

With the values in this section every gate passes in all 14 scheme and mode combinations [V computed, review pass]. The lowest results: `tab-fg` on `tabstrip` 4.53 (Ocean dark), `danger` on `danger-bg` 4.63 (Ocean dark), `tab-fg-hover` on `tab-hover-bg` 7.39, `statusbar-hover-fg` on `statusbar-active` 7.22, `ink-secondary` on `selected` 6.09, `checkbox-border` on `checkbox-bg` 3.03 (Modern light), `info` on `info-bg` 3.51 (Modern dark).

**Selected rows.** Faint text, muted text and links fail on a selected row in almost every scheme (`ink-faint` on `selected`: 3.34 to 3.67 in all 14 combinations; Modern light link `#0069CC` on `#D6D6D8`: 3.72) [V computed]. So a selected row re-scopes those tokens for everything inside it, instead of each component swapping classes:

```css
/* base.css. Tailwind utilities read the --color-* theme variables, which @theme declares on :root
   and which resolve there, so the re-scope must redeclare them as well as the --c-* tokens. */
:where([aria-selected="true"], [data-selected]) {
  --c-ink-muted: var(--c-ink-secondary);   --color-ink-muted: var(--c-ink-secondary);
  --c-ink-faint: var(--c-ink-secondary);   --color-ink-faint: var(--c-ink-secondary);
  --c-accent-text: var(--c-ink);           --color-link: var(--c-ink);
  --c-accent-text-hover: var(--c-ink);     --color-link-hover: var(--c-ink);
}
```

[V] The repo's Tailwind 4.2.1 compiles `text-ink-muted` to `color: var(--color-ink-muted)` and emits `--color-ink-muted: var(--c-ink-muted)` on `:root`, so a descendant that only redeclares `--c-ink-muted` would still inherit the value resolved at the root [test-compiled, review pass]. `ListRow`, `TreeRow` and `NavList` rows set `aria-selected` or `data-selected`. Status colors are not re-scoped: inside rows they are only used for icons, which pass 3:1 on `selected` (lowest 4.06).

**Known limits** [V computed]. Hover backgrounds are transient and not gated. Card borders (`stroke` on `shell`, 1.13 to 1.75:1) are decorative. Input boundaries match VS Code and are faint: Modern dark `input-bg` `#191A1B` on the dialog overlay `#202122` is 1.08:1 and its border `#333536` is 1.31:1; Modern light's `#D8D8D866` border is 1.10:1. That is accepted because every input has a visible label. Checkboxes, radios and the Switch do not rely on it: their boundary is `checkbox-border` (3.26:1 or better).

### 2.12 Reading tokens from JavaScript

Unregistered custom properties are returned by `getComputedStyle` as their specified token stream, so a `color-mix()` token comes back as text, not a color. Every JS reader must use one helper (W1-TOKENS):

```ts
// src/lib/appearance/resolveCssColor.ts
/** Resolves a CSS color token (any syntax) to "#rrggbb" via a probe element, alpha flattened on `over`. */
export function resolveCssColor(token: `--c-${string}`, over?: `--c-${string}`): string;
```

Implementation: a hidden `<span>` with `color: var(<token>)`, read `getComputedStyle(span).color`, parse `rgb()`, `rgba()` and `color(srgb r g b / a)` (the forms Chromium serializes), composite alpha over `over` (default `--c-shell`), return `#rrggbb`. Unit tests cover all three input forms.

Callers: `terminalTheme.ts` (replaces `cssVar` + `hexToRgba`, `terminalTheme.ts:6-21`, which break on non-hex tokens [V]); `utils/contextMenu.ts` (popup colors); the title bar color sync (`window_chrome_update`, sent only by `src/lib/window-chrome.ts`, 3.2 and 7.2).

---

## 3. Layout

All sizes are CSS px at `ui_scale` 1.0 unless marked DIP. "Comfortable" and "Compact" are the two densities (section 2.9).

### 3.1 Shell structure and screen gates

New components live in `src/components/shell/`. The tree:

```
WindowFrame            data-cv-window, h-screen, flex-col, bg-shell, text-ink
├─ TitleBar            35 DIP, counter-zoomed (3.2); variant "full" or "minimal"
├─ BannerStack         0..n banners, 26px each (3.9)
├─ Workbench           flex-1, flex-row, position:relative (3.3)
│  ├─ LeftCard         ActivityBar (3.4) + docked SideBar (3.5), one card
│  ├─ Sash             only when the side bar is docked and open
│  ├─ EditorCard       flex-1; SplitContainer → Pane → PaneTabBar + PaneContent (3.6)
│  ├─ Sash             only when the AI side bar is open
│  ├─ AuxCard          AI chat (3.8)
│  └─ FloatingSideBar  absolute, only when the side bar floats (3.5)
├─ StatusBar           22 + gutter (3.10)
└─ portals             dialogs, DOM popovers (section 4)
```

Every screen renders inside `WindowFrame`, because the native frame is gone (OD-2). The gates in `App.tsx` change like this:

| Screen | Today | New | Title bar |
|---|---|---|---|
| Auth loading | `App.tsx:962-971`, `h-screen`, text exactly `Loading...` | `h-full` inside `WindowFrame` | minimal |
| Sign-in | `AuthScreen` (`AuthScreen.tsx:24` `min-h-screen`) | `min-h-full` | minimal |
| Onboarding | `OnboardingWizard` (`OnboardingWizard.tsx:81`) | `h-full` | minimal |
| Team auto-connect | `App.tsx:984-993` | `h-full` | minimal |
| Vault hub | `App.tsx:995-1065` with its own offline banner (`998-1010`) | `h-full`, offline banner moves into `BannerStack` | minimal |
| Main | `App.tsx:1067-1130` | `Workbench` + `StatusBar` | full |

The minimal title bar adds **no text nodes**: the harness treats a page whose whole `innerText` is `Loading...` as the loading screen (`scripts/verify/lib/flows.mjs:34`). Its buttons carry `aria-label`, never visible text. On the loading screen the minimal bar renders only the drag region and the reserves.

Removed from the main layout: the 2px accent bar (`App.tsx:1070`) and its twin in the floating side bar (`SidebarPanel.tsx:50`), the offline banner (`App.tsx:1072-1083`, now a status bar item), the robot toggle in the tab strip (`App.tsx:1092-1106`, now in the title bar), the 4px AI divider (`App.tsx:1109-1113`, now a sash) and the `StartupStatus` strip (`App.tsx:1130`, now a status bar item).

### 3.2 Title bar

The title bar is a fixed **35 DIP** strip on every OS [V VS Code `Pne=35`, the height with the command center shown]. It is counter-zoomed so the main process never has to follow `ui_scale` (D-5):

```css
.cv-titlebar { height: 35px; zoom: calc(1 / var(--c-zoom)); }   /* VS Code: .titlebar-container.counter-zoom */
```

**Zoom factor.** The main window is created with `webPreferences: {zoomFactor: clamp(ui_scale, 0.75, 1.5), zoomMode: 'isolated'}` (7.1), so the first frame already has the right zoom and nothing races at `ready-to-show` [V Electron 44.4.5 `electron_api_web_contents.cc:1044-1066` applies both before the first navigation]. `boot-inline.js` sets `--c-zoom` before first paint from `window.electron.zoomFactor?.()`, a synchronous preload call (7.4), or `1` when it is missing [A: `webFrame.getZoomFactor()` already returns the creation zoom at that point; the next step corrects it if not]. `src/lib/window-chrome.ts` then confirms the value with `invoke('get-zoom-factor')` and follows the `zoom-factor-changed` event (`main.ts:853-858`). It exports `useZoomFactor()`, which the status bar's zoom item reads (3.10).

**Layout** (a 3-column grid `grid-template-columns: 1fr auto 1fr`, so the center stays centered):

| Slot | macOS | Windows | Linux |
|---|---|---|---|
| Leading reserve | 70px for the traffic lights [V `.mac .window-controls-container {width:70px}`]; 0 in full screen | `--c-wco-reserve-start`: 0, unless an RTL system locale mirrors the caption buttons to the left [V Electron `win_frame_view.cc:251-256` builds the overlay rect with `GetMirroredRect`] | `--c-wco-reserve-start`: the caption buttons the desktop puts on the left (GTK `gtk-decoration-layout`, for example elementary OS) [V Electron `electron_frame_view_layout_linux.cc:135-171` has leading and trailing button rects] |
| Left group | none (the menu stays in the OS menu bar) | 35×35 slot with a 22×22 **menu button** (`menu` icon), [ADAPT] in place of VS Code's app icon | same as Windows |
| Center | search pill | search pill | search pill |
| Right group | layout controls | layout controls | layout controls |
| Trailing reserve | 0 | `--c-wco-reserve-end`: the caption buttons, 138px until known [V 3 × 46] | `--c-wco-reserve-end` [A: depends on the GTK theme] |
| Group padding | `padding-top: 2px` on all groups [V Modern UI mac tweak] | none | none |

The leading reserve comes before the menu button, so caption buttons on the left never cover it. VS Code does the same on Linux [V `.linux .titlebar-left .window-controls-container.wco-enabled {width: env(titlebar-area-x, 0px)}` plus a matching right container].

**Native window options** (W2-MAIN, section 7.1): macOS uses `titleBarStyle: 'hidden'` with the traffic lights at `{x: 11, y: 10}` on macOS 26 or later and `{x: 10, y: 9}` before. That is VS Code's formula `o = floor((35 − (tahoe ? 14 : 16)) / 2)`, `{x: o + 1, y: o}`, with "tahoe" meaning Darwin major ≥ 25 [V VS Code `main.js`: `setWindowButtonPosition({x:o+1,y:o})`, `ky(i){return parseFloat(i)>=25}`]. Windows and Linux use `titleBarStyle: 'hidden'` plus `titleBarOverlay {color, symbolColor, height: 34}`. 34 is 35 − 1, as in VS Code [V `height:e.height?e.height-1:void 0`].

**Drag regions.** `.cv-titlebar { -webkit-app-region: drag; }`. Every interactive child gets `-webkit-app-region: no-drag`: the menu button, the pill, the layout controls and the fallback caption buttons. No text is selectable in the title bar. Double-click on the drag region is left to the OS [A: maximize or zoom per OS setting; Windows and Linux in section 8.7]. The title bar needs no top-edge resizer strip: on Windows and Linux Electron tests the resize border before any drag region [V Electron 44.4.5 `native_window.cc:747-766` calls `ResizingBorderHitTest` before the draggable-region providers; `win_frame_view.cc:79-133` keeps a top resize band for overlay windows]. VS Code adds its 4px `.resizer` only in its own HTML caption mode (`window.controlsStyle: custom`) [V]. Section 8.7 checks top-edge resizing.

**Search pill (command center, D-6).** It is a `<button data-cv-command-center>`:

| Property | Value | Source |
|---|---|---|
| Height | 22px | [V] `.command-center-center {height:22px}` |
| Width | `min(calc(38vw * var(--c-zoom)), 600px)`, min 200px | [V] 38vw / max 600; [ADAPT] `× --c-zoom` undoes the counter-zoom so the pill stays 38% of the window |
| Shape | radius 6, 1px `--c-cc-border`, bg `--c-cc-bg`, `margin: 0 6px` | [V] `cornerRadius.medium`, `margin:0 6px` |
| Hover | bg `--c-cc-hover-bg`, border `--c-cc-hover-border` | [V] |
| Content | 14px `search` icon at `opacity: .8` (margin `auto 3px`), then the active vault name in 12px `--c-cc-fg`, truncated | [V] `.search-icon {font-size:14px; opacity:.8; margin:auto 3px}`; 14 is a named exception in the icon size test (5.2); label = vault name like VS Code shows the workspace name |
| Action | click, Enter or Space dispatches `conduit:focus-sidebar-search` (handled at `Sidebar.tsx:101-105`: expands and focuses search) | existing capability |
| Name | `aria-label="Search entries in {vault} (Ctrl+P)"` (`⌘P` on macOS), `aria-keyshortcuts` | |
| Harness rule | **no `title` attribute**: `team-flows.mjs:46` clicks `button[title]` whose text contains the vault name, and the title bar comes first in DOM order | |

Ctrl/Cmd+P is a renderer shortcut only (W2-WORKBENCH adds it to `useKeyboardShortcuts.ts:13-143`), so the key still reaches remote sessions, which mark themselves with `data-session-keyboard` (`useKeyboardShortcuts.ts:158-161`).

**Layout controls** (right group; `gap: 4px; padding-right: 4px` [V]). Each is a 22×22 IconButton (4.3):

| Control | Icon when shown / hidden | Action | Hook |
|---|---|---|---|
| Toggle primary side bar | `panelLeft` / `panelLeftOff` | `onToggleSidebar()` (same as Ctrl/Cmd+B) | `data-cv-layout="sidebar"` |
| Toggle AI side bar | `panelRight` / `panelRightOff` | `onToggleAi()` (same as Ctrl/Cmd+Alt+B) | `data-cv-layout="ai"` |

VS Code keeps these buttons flat and swaps the glyph: the filled pane while the part is visible, the outlined `-off` pane while it is hidden [V `LayoutControlMenu` item `icon: panel-left-off, toggled: {condition: sideBarVisible, icon: panel-left}`, and the same pair for the secondary side bar]. The IconButtons keep `aria-pressed` for screen readers but do not use the pressed background (`pressedLook={false}`, 4.3). `TitleBar` takes `sidebarOpen`, `onToggleSidebar`, `aiOpen` and `onToggleAi` as props, and W2-WORKBENCH wires them to `sidebarStore` and `auxBarStore`, so the title bar imports neither store.

Titles: `Toggle Primary Side Bar (Ctrl+B)` and `Toggle AI Chat (Ctrl+Alt+B)`, with ⌘ and ⌥ on macOS.

**Windows/Linux menu button (D-7).** Click calls `openAppMenu()` from `src/lib/window-chrome.ts`, which runs `invoke('window_chrome_app_menu', {x, y})` with the button's bottom-left corner in CSS px (`getBoundingClientRect()`). The main process pops up `Menu.getApplicationMenu()` at that point (section 7.3). `aria-label="Application menu"`, `aria-haspopup="menu"`, hook `data-cv-app-menu`.

**Keyboard access to the menu (D-8(3)).** A frameless window has no menu bar, so Alt and F10 do nothing natively [V Electron `root_view.cc:96-97` returns when there is no menu bar]. On Windows and Linux in custom mode, `useKeyboardShortcuts` (W2-WORKBENCH) calls `openAppMenu()` on F10, and on Alt pressed and released with no other key in between (VS Code's `window.customMenuBarAltFocus`), unless focus is inside `[data-session-keyboard]`, so remote sessions keep both keys. The native popup supports arrow keys, Enter and mnemonics once open [V `electron_api_menu_views.cc`: `MenuRunner::CONTEXT_MENU | MenuRunner::HAS_MNEMONICS`]. The menu's own accelerators (Ctrl+O, Ctrl+S, F1 and the rest) keep working without a menu bar, because Electron registers them with the window's focus manager [V `root_view.cc:52-56`, `native_window_views.cc:2077-2078`].

**Caption button fallback (D-8(1)).** On Windows and Linux in custom mode, `window-chrome.ts` computes

```ts
const showFallback = !state.isFullScreen &&
  (state.overlayActive === false || navigator.windowControlsOverlay?.visible !== true);
```

and re-evaluates it on `geometrychange`, the `window-chrome:state` event, window `focus` and `visibilitychange`, never on a timer. `overlayActive` comes from `window_chrome_get_state` and `window-chrome:state` (7.2, 7.4). The fallback is three 46×35 buttons: codicons `chrome-minimize`, `chrome-maximize` or `chrome-restore`, and `chrome-close` [V: all exist in `@iconify-json/codicon`], 16px in `--c-titlebar-fg`. They render inside the trailing reserve (the leading one when the rect puts the caption buttons on the left), so a wrong "show" stays hidden under native buttons that do paint. They call `invoke('window_chrome_control', {action})`. Hover bg `#FFFFFF1A` in dark and `#0000001A` in light; close hover bg `#E81123E6` with a white glyph [V VS Code `.window-controls-container>.window-icon:hover`, `.window-icon.window-close:hover`]. Hook: `data-cv-caption`. `localStorage["conduit:debug-caption-fallback"] = "1"` forces them for testing.

**Reserves.** `src/lib/window-chrome.ts` computes both from the Window Controls Overlay API:

```ts
const r = navigator.windowControlsOverlay.getTitlebarAreaRect();   // CSS px
const start = Math.ceil(r.x * zoom);                                // the title bar is counter-zoomed, so DIP
const end = Math.ceil((window.innerWidth - r.x - r.width) * zoom);
```

Each value is clamped to 0..300 DIP. When the rect is empty or a value falls outside that range, the reserves fall back to `start 0` and `end 138`. They recompute on `geometrychange` and on zoom changes and set `--c-wco-reserve-start` and `--c-wco-reserve-end`. CSS `env(titlebar-area-*)` is not used, because those values are page CSS px and the counter-zoom would divide them by the zoom a second time.

**Full screen.** The main process sends `window-chrome:state` `{isFullScreen, isMaximized, overlayActive}` on `enter-full-screen`, `leave-full-screen`, `maximize` and `unmaximize`, and when the overlay fails (section 7.4). `<html data-fullscreen>` sets the macOS leading reserve to 0. Windows and Linux keep the bar; the reserves follow `geometrychange`, and the fallback caption buttons hide in full screen.

**Colors.** bg `--c-shell`, fg `--c-titlebar-fg`. Compact adds `border-bottom: 1px solid var(--c-divider)` inside the 35px. `useAppearance` dispatches `conduit:appearance-applied` `{scheme, mode, density, iconPack}` after it applies a change (6.2). `src/lib/window-chrome.ts` is the only sender of `window_chrome_update`: once at boot and on every `conduit:appearance-applied`, debounced by 50ms, it sends the resolved hex values (`resolveCssColor('--c-shell')`, `resolveCssColor('--c-titlebar-fg')`) and the density. A rejected invoke (no handler yet, before W2-MAIN) is caught and ignored. The main process then updates the overlay and `backgroundColor` (section 7.2).

**Native mode (D-8(2)).** With `title_bar_style: 'native'` or env `CONDUIT_TITLE_BAR=native`, the window keeps the OS frame, as today. `TitleBar` then renders as a plain 35px in-app toolbar: no drag region, no reserves, no menu button (the OS menu bar is back on Windows and Linux), pill and layout controls kept. This is a defensive fallback, so function wins over looks. The Help menu item `Use Native Title Bar` (7.1) switches to it when the custom title bar itself does not work.

### 3.3 Workbench and cards

`Workbench` is a flex row:

```css
.cv-workbench { display:flex; gap: var(--c-gap); padding: var(--c-gap) var(--c-outer); min-height:0; flex:1; position:relative; }
.cv-card { background: var(--c-editor); border: var(--c-card-border-w) solid var(--c-card-border);
           border-radius: var(--c-card-radius); overflow: hidden; min-width:0; }
```

The top padding is the 4px gap under the title bar or banners. The bottom padding is the gap above the status bar. [A] VS Code applies these margins in JS; the Comfortable values match its 4px card margin and 4px outer margin [V `--modern-ui-floating-card-margin` 4, outer margin 4].

| Card | Background | Width | Comfortable | Compact |
|---|---|---|---|---|
| LeftCard (activity bar + docked side bar) | `--c-sidebar` | 44 or 40 + side bar width | radius 8, 1px border | radius 0, no border, `border-right: 1px solid var(--c-divider)` on the activity bar; a docked side bar is followed by the 4px sash, which paints its divider |
| EditorCard | `--c-editor` | flex | radius 8, 1px border | none |
| AuxCard (AI) | `--c-sidebar` | 300 to 800 | radius 8, 1px border | none; the 4px sash before it paints the divider |

The activity bar and a docked side bar share **one card** [V VS Code: "Joined into one card: side bar loses its left radii when activity bar is present"]. There is no divider between them in Comfortable, because both are `--c-sidebar`.

[ADAPT] VS Code's Compact keeps a 4px outer margin and rounds the outermost corners. OD-3 asks Compact for "no gaps, no radii", so Conduit's Compact is flush to the window edges.

**Sashes** (resize handles between cards). Every sash is an element in the layout flow, 4px wide (4px tall when horizontal), never an overlay on a neighbour: a native web view paints over any HTML that overlaps it, so an overlapping hit area could not be grabbed next to a web session. In Comfortable the sash is the 4px gap between two cards. In Compact it is a 4px element that paints the left neighbour's background, the 1px divider at its center and the right neighbour's background (for the side bar sash: `background: linear-gradient(to right, var(--c-sidebar) 0 1.5px, var(--c-divider) 1.5px 2.5px, var(--c-editor) 2.5px)`), so it reads as a plain 1px divider; it takes 3px from its neighbours. The floating side bar's own sash may overlap the editor card, because the floating side bar holds a freeze (native views are hidden while it is open).

- **Highlight.** The whole 4px turns `--c-accent` after `--c-sash-delay` (300ms) of hover, or at once while dragging, fading in over `--c-motion-fast`, with `border-radius: 2px` [V VS Code sash `background-color .1s ease-out`; `.modern-ui .monaco-sash:before {border-radius: calc(var(--vscode-sash-hover-size) / 2)}`].
- **Grip** (Comfortable only). A sash between two cards shows three 2px dots in `--c-sash-grip` at its center: an `::after` of 2×2px, `border-radius: 50%`, with `box-shadow: 0 -5px currentColor, 0 5px currentColor` (vertical sash) or `-5px 0 currentColor, 5px 0 currentColor` (horizontal). The dots fade out over 100ms on hover and while dragging [V `.modern-ui .monaco-sash:not(.disabled):after {…}`, `.modern-ui .monaco-sash.hover:not(.disabled):after {opacity:0}`, `.modern-ui.modern-ui-compact .monaco-sash:not(.disabled):after {content:none}`]. Sashes inside a card, such as the editor split lines (3.6), have no grip [V `.modern-ui .part .monaco-sash:after {content:none}`].
- **Cursor.** macOS `col-resize` / `row-resize`; Windows and Linux `ew-resize` / `ns-resize`. The side bar sash shows `e-resize` at the minimum width and `w-resize` at the maximum [V `.monaco-sash.mac.vertical {cursor:col-resize}`, `.monaco-sash.vertical {cursor:ew-resize}`, `.monaco-sash.vertical.minimum {cursor:e-resize}`].

The side bar sash replaces `SidebarPanel.tsx:52-63`; the AI sash replaces `App.tsx:1109-1113`. Both live in `src/styles/components/sash.css`.

**Space budget** at the minimum window, 1024×700 DIP [V `main.ts:707-708`: the minimum applies to the whole window, frame included], single pane, side bar floating and closed, AI closed. Today the OS title bar (and on Windows the menu bar) sits outside the web content; after the redesign the whole window is content:

| Case | Session area after (DIP) | Today, macOS | Today, Windows | Change macOS / Windows |
|---|---|---|---|---|
| Comfortable, zoom 1.0 | 966 × 594 (width 1024 − 4 − 44 − 4 − 4 − 2 border; height 700 − 35 − 4 − 4 − 28 − 2 − 33) | 1024 × 634 (700 − 28 title bar [A: 32 on macOS 26] − 2 accent bar − 36 tab bar) | about 1024 × 611 (700 − 31 title bar − 20 menu bar [A] − 38) | width −5.7%; height −6.3% / −2.8% |
| Compact, zoom 1.0 | 984 × 610 (1024 − 40; 700 − 35 − 26 − 29) | 1024 × 634 | about 1024 × 611 | width −3.9%; height −3.8% / −0.2% |
| Comfortable, zoom 1.5 | 937 × 559 (viewport 683 × 467 CSS px; title bar 23.3 CSS px because it is counter-zoomed) | 1024 × 615 (672 − 57) | about 1024 × 592 (649 − 57) | width −8.5%; height −9.1% / −5.6% |

`MIN_CONTENT_WIDTH` (480, `sidebarStore.ts:8`) stays, but `spareWidth()` (`sidebarStore.ts:40-42`) must subtract the new chrome: `viewportWidth − chromeWidth − expandedWidth − rightPanelWidth − 480`. `chromeWidth = 2 × outer + activityBarWidth + gap` = 56 in Comfortable and 44 in Compact (2 × 0 + 40 + the 4px in-flow sash that follows a docked side bar and paints its divider). The store derives `chromeWidth` itself: it listens for `conduit:appearance-applied` (6.2) and sets `chromeWidth` from `metrics.ts` for the new density in the same task, so a density switch causes one layout pass (3.7). `Workbench` does not set it from an effect. `rightPanelWidth` becomes AI width + gap (4 in Comfortable, the 4px sash in Compact).

### 3.4 Activity bar

`src/components/shell/activitybar/ActivityBar.tsx` is a vertical `role="toolbar"` (`aria-orientation="vertical"`, `aria-label="Activity bar"`) of 36×36 buttons with roving `tabIndex` and Up, Down, Home and End keys. The top group comes first; the bottom group sits under `margin-top: auto`.

| Metric | Comfortable | Compact | Source |
|---|---|---|---|
| Card width | 44 | 40 | [V] 36 + lane 8 or 4 |
| Horizontal padding | 4 each side | 2 each side | lane / 2 |
| Top and bottom padding | 4 | 4 | [A] |
| Item box | 36 × 36 | 36 × 36 | [V] `FLOATING_ACTION_HEIGHT=36` |
| Gap between items | 8 | 4 | [V] |
| Icon | 24 | 24 | [V] |
| Active and hover pill | 32 × 32, inset 2px, radius 4 | same | [V] `calc(action-height - 4px)`, `cornerRadius.small` |
| Colors | icon `--c-activity-fg`; hover pill `--c-activity-hover-bg` + icon `--c-activity-fg-hover`; active pill `--c-activity-active-bg` + icon `--c-activity-fg-active` | same | [V] `.modern-ui .activitybar … .action-item.checked .action-label {color: var(--vscode-modernActivityBarItem-activeForeground)}` and the `:hover` rule with `modernActivityBarItem-hoverForeground` |
| Focus | 1px `--c-focus` outline, offset −2px, on the pill | same | [A] |

Items (D-9):

| Position | Id and hook | Icon | Pressed when | Click | Title (native tooltip) |
|---|---|---|---|---|---|
| Top 1 | `data-cv-activity="vault"`, also `data-cv-sidebar-toggle` + `aria-expanded` | `explorer` | side bar open and favorites filter off | closed: open the side bar with the filter off. Open with filter off: animated collapse (`conduit:animated-collapse`). Open with filter on: turn the filter off | `Open sidebar (Ctrl+B)` when closed; `Close sidebar (Ctrl+B)` when open and floating; `Hide sidebar (Ctrl+B)` when open and docked. These keep today's strings (`PaneTabBar.tsx:350`, `SidebarWindowControls.tsx:22,30`), so `team-flows.mjs:39-40` still works before wave 4 |
| Top 2 | `favorites` | `star` (`starFilled` when pressed) | side bar open and favorites filter on | open the side bar with the filter on; if already so, collapse | `Favorites` |
| Top 3 | `home` | `home` | never | `openHomeTab()` from `src/components/layout/openHomeTab.ts`: W2-SIDEBAR moves `handleHome` there verbatim from `Sidebar.tsx:165-206` when it removes the footer, so the logic is never deleted in between | `Home` |
| Top 4 | `quick-connect` | `plug` | never | `conduit:quick-connect` | `Quick Connect (Ctrl+N)` |
| Bottom 1 | `account` | `account` | never | native popup menu (4.10): header with the email (or "Local mode" / "Offline"), `Account Settings`, separator, `Sign Out` (danger, then `ConfirmDialog`). Local mode: `Sign in to start a free Pro trial` (`exitToSignIn()`) | `Account` |
| Bottom 2 | `settings` | `settings` | never | `conduit:settings` | `Settings (Ctrl+,)` |

The favorites filter state moves from `Sidebar.tsx:39,124-134` into `sidebarStore` (`favoritesOnly`, `setFavoritesOnly`), still persisted through `ui_state_set('favorites-filter')`. The side bar's star button and the activity bar item then share it.

No badges this release.

### 3.5 Primary side bar

The PR #12 model stays: `isPinned`, `openWhenDocked`, docked only when pinned and it fits (`sidebarStore.ts:44-54`), and auto-collapse when floating (D-9). Widths: min 200, max 500, default 250 (`sidebarStore.ts:5-7`) [ADAPT: VS Code's minimum is 170; the existing tests assert 200].

**Docked.** It is the right part of the LeftCard, `expandedWidth` wide, and the sash sits on its right edge. Web sessions stay live beside it, as today.

**Floating.** An absolutely positioned card inside `Workbench`:

```css
.cv-sidebar-float { position:absolute; z-index: var(--c-z-sidebar);
  left: calc(var(--c-outer) + var(--c-activitybar-w) + var(--c-gap)); top: var(--c-gap); bottom: var(--c-gap);
  width: <expandedWidth>px; background: var(--c-sidebar); border: 1px solid var(--c-card-border);
  border-radius: var(--c-card-radius); box-shadow: var(--c-shadow-overlay); }
.cv-sidebar-scrim { position:absolute; z-index: var(--c-z-sidebar-scrim); inset: 0;
  left: calc(var(--c-outer) + var(--c-activitybar-w)); background: var(--c-scrim-sidebar); }
```

The scrim covers only the workbench right of the activity bar. The title bar stays draggable and the activity bar stays clickable. That changes today's full-window scrim (`SidebarPanel.tsx:35-38`). Motion: `sidebar-in` 250ms and `sidebar-out` 150ms with `--c-ease-out`, animating transform and opacity only. The floating card holds a freeze while open (`useFreeze(open && floating, 'sidebar')`), and so does the vault menu while it spills over (`sidebarStore.menuOpen`, `App.tsx:388,410`).

**Content, top to bottom:**

1. **Part title row, 32px** [V `AREA_HEIGHT_MODERN_UI=32`], `padding-left: 8px`. On the left is the vault switcher: a `<button data-cv-vault-switcher>` with the vault name at 12px/600 in `--c-ink-secondary` (hover `--c-ink`), a 16px `chevronDown`, and `title` = the vault path (today `Sidebar.tsx:314-323`). On the right are 22×22 IconButtons: favorites (`star`/`starFilled`, `aria-pressed`), new entry (`plus`, `New Entry (Ctrl+E)`), new folder (`folderPlus`, `New Folder (Ctrl+Shift+N)`), pin (`pin`/`pinFilled`, titles from `SidebarWindowControls.tsx:10-14`) and close (`close`, titles from `SidebarWindowControls.tsx:22-31`). The pin and close buttons move from the left edge to the right end [ADAPT: VS Code puts part actions on the right]. The team tint stays (`Sidebar.tsx:305`: `border-l-2 border-l-team-border-strong bg-team`).
2. **Vault context bar** (team vaults, `VaultContextBar.tsx`): a 28px row (`--c-section-h`), 12px text.
3. **Admin onboarding card** (`Sidebar.tsx:373-403`) and **invitation banner** (`TeamInvitationBanner.tsx`): `Callout size="sm"` (4.13) with `margin: 4px 8px`.
4. **Search**: `padding: 4px 8px 8px`. A `SearchInput` (4.4): 26px, 16px `search` icon, placeholder `Search entries...`, clear IconButton (`close`, 16px, `Clear search`). The `data-bare` inner-input pattern stays (`Sidebar.tsx:425-430`). Escape clears, as today (`Sidebar.tsx:414-419`).
5. **Tree** (`EntryTree.tsx`), `flex-1`, scrolling, `padding: 0 var(--c-list-inset)` (4px, Compact 2px [V]):

| Property | Value | Source |
|---|---|---|
| Row | 22px, radius 4, `display:flex; align-items:center; gap:6px` | [V] `ITEM_HEIGHT=22`; today 28px (`EntryTree.tsx:897`) |
| Indent | `padding-left: calc(4px + depth * 8px)` | [V] `workbench.tree.indent` default 8; today `depth * 16 + 8` (`EntryTree.tsx:906`) |
| Twistie | 16×16 box plus `padding-right: 6px`, `chevronRight` / `chevronDown` 16px, `--c-ink-muted`. Rows without children render the same empty slot, so leaf icons line up with folder icons at the same depth | [V] `.monaco-tl-twistie {width:16px; padding-right:6px; flex-shrink:0}` on every row |
| Indent guides | a 1px `--c-indent-guide` line per ancestor level, at the center of that ancestor's twistie; shown while the tree is hovered or has `:focus-within` (opacity 0 → 1 over 100ms linear); guides on the path to the selected row at full strength, the others at 40% opacity | [V] `workbench.tree.renderIndentGuides` default `onHover`; `tree.inactiveIndentGuidesStroke` = stroke at 40% |
| Icon | entry icon 16px in its `--c-entry-*` color | today `EntryTree.tsx:972` |
| Label | 13px/400, `--c-ink-secondary`, ellipsis | |
| Hover | bg `--c-hover` | |
| Selected, tree focused | bg `--c-selected`, fg `--c-ink` | D-13; today `bg-conduit-600/20 text-conduit-400` (`EntryTree.tsx:903`) |
| Selected, tree not focused | bg `--c-selected-inactive` | |
| Keyboard focus | `outline: 1px solid var(--c-focus); outline-offset: -1px` | [V] `list.focusOutline` |
| Drop target | bg `--c-drop-bg` + `outline: 1px solid var(--c-accent); outline-offset: -1px` | today `EntryTree.tsx:899` |
| Locked | `opacity: .6` | today `EntryTree.tsx:901` |
| Rename (F2 or the Rename menu item) | an input replaces the label: 22px tall, 13px, bg `--c-input-bg`, 1px `--c-focus` border, radius 2, filling the label area; Enter and blur commit, Escape cancels, as today | today `EntryTree.tsx:977-990`; same style as the tab rename (3.6) |
| Flat-mode group label | 22px row, 11px/600, `--c-ink-muted`, no uppercase | [V] Modern UI drops uppercase; today `EntryTree.tsx:866-870` |
| Multi-drag badge | inline style background `var(--c-btn-primary-bg)` instead of `#6366f1` | `EntryTree.tsx:935` |
| ARIA | container `role="tree" aria-label="Entries"`; rows `role="treeitem"` with `aria-level`, `aria-expanded` (containers), `aria-selected`; roving `tabIndex`; Up, Down, Left, Right, Home, End, Enter (open) and F2 (rename) | OD-10 |

6. **Trial promotion** (`Sidebar.tsx:465-489`): a dismissible `Callout` with `margin: 8px`. The trial **countdown** (`Sidebar.tsx:490-511`) moves to the status bar (3.10).
7. **The footer is removed** (`Sidebar.tsx:513-595`). The sync indicators move to the status bar. Home and Settings move to the activity bar. The email, sign-out and local-mode sign-in move to the Account menu. The item count (`Sidebar.tsx:517-521`) is dropped [ADAPT: VS Code shows no counts. W4-DOCS records it].

The empty-vault states in `EntryTree.tsx:1020-1040` become the `EmptyState` primitive.

### 3.6 Editor card, panes and connected tabs

The editor card holds `SplitContainer` (`SplitContainer.tsx:10-20`) unchanged. Split lines (`LayoutRenderer.tsx:44-50`) keep today's 4px `Separator` in the layout flow (`w-1` / `h-1`), so no hit area overlaps a pane that may hold a native web view (3.3). The separator paints a centered 1px `--c-editor-group-border` line on `--c-editor` (`background: linear-gradient(var(--c-editor-group-border), var(--c-editor-group-border)) center / 1px 100% no-repeat`, `100% 1px` when horizontal) and gets the sash highlight and cursors (3.3), but no grip.

Each pane has its own tab strip (D-3, connected style only). Exact CSS for `src/styles/components/tabs.css`, taken from VS Code 1.139 [V `modern-ui-rules.css`: `--modern-ui-connected-tab-radius: cornerRadius.small`, `cap-radius: radius + stroke`, `gutter: size40 + stroke`, `top-inset: size40`, tab `border-block: size40 solid transparent`, `.tabs-container {padding-bottom: strokeThickness}`, active fill `top:-inset; bottom:-gutter-stroke; border-radius: cap cap 0 0`]:

```css
.cv-tabstrip { position:relative; display:flex; align-items:stretch; height:var(--c-tabstrip-h); background:var(--c-tabstrip); }
.cv-tabs { display:flex; align-items:stretch; flex:1 1 auto; min-width:0; overflow-x:auto; overflow-y:hidden;
           padding-bottom:1px; scrollbar-width:thin; }
.cv-tabs::-webkit-scrollbar { height:3px; }                     /* [A] VS Code titleScrollbarSizing default */
.cv-tab { position:relative; flex:0 0 auto; display:flex; align-items:center; box-sizing:border-box;
          min-width:80px; max-width:240px;                       /* [V] min 80; [ADAPT] max 240 for long web titles */
          height:calc(var(--c-tab-h) + 8px); border-block:4px solid transparent;
          padding:0 33px 0 6px;                                  /* [V] 0 8px 0 6px; right = 28 + 5 shoulder for the close column */
          font:400 13px/18px var(--c-font-ui); color:var(--c-tab-fg); cursor:default; user-select:none; }
.cv-tab-fill { position:absolute; inset-inline:0; top:-4px; bottom:-5px; border-radius:4px; pointer-events:none; }
.cv-tab:hover > .cv-tab-fill { background:var(--c-tab-hover-bg); }
.cv-tab[aria-selected="true"] { color:var(--c-tab-fg-active); z-index:1; }
.cv-tab[aria-selected="true"] > .cv-tab-fill { top:-4px; bottom:-5px; background:var(--c-tab-active-bg);
          border-radius:5px 5px 0 0; }
.cv-tab[aria-selected="true"] > .cv-tab-fill::before,
.cv-tab[aria-selected="true"] > .cv-tab-fill::after { content:""; position:absolute; bottom:0; width:5px; height:5px;
          clip-path:inset(0); pointer-events:none; }
.cv-tab[aria-selected="true"] > .cv-tab-fill::before { right:100%; border-bottom-right-radius:5px;
          box-shadow:2.5px 2.5px 0 2.5px var(--c-tab-active-bg); }
.cv-tab[aria-selected="true"] > .cv-tab-fill::after { left:100%; border-bottom-left-radius:5px;
          box-shadow:-2.5px 2.5px 0 2.5px var(--c-tab-active-bg); }
.cv-tab:first-child[aria-selected="true"] > .cv-tab-fill::before { content:none; }      /* [V] connected-tab-left-edge */
.cv-tab:not([aria-selected="true"]):hover { color:var(--c-tab-fg-hover); }          /* [V] modernEditorTab.hoverForeground */
.cv-tab-icon { flex:none; width:16px; height:16px; margin-right:6px; position:relative; }
.cv-tab-label { position:relative; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.cv-tab-actions { position:absolute; top:0; bottom:0; right:5px; width:24px; display:flex;
          align-items:center; justify-content:center; z-index:2; }            /* [V] 24px column, right = shoulder */
.cv-tab:not([aria-selected="true"]):not(:hover):not(:focus-within) > .cv-tab-actions { opacity:0; pointer-events:none; }
.cv-tab[data-state]:not(:hover):not(:focus-within) > .cv-tab-actions { opacity:1; pointer-events:auto; }
.cv-tab[data-drop-target]::before { content:""; position:absolute; left:-1px; top:0; bottom:0; width:2px;
          background:var(--c-accent); z-index:3; }                       /* [V] 2px drag-and-drop border */
.cv-tab[data-dragging] { opacity:.5; }
.cv-editor-actions { display:flex; align-items:center; padding-right:8px; opacity:.5; }   /* [V] .title-actions {opacity:.5; padding-right:8px} */
.cv-tabstrip[data-focused] .cv-editor-actions { opacity:1; }                      /* [V] .editor-group-container.active>.title>.title-actions {opacity:1} */
```

Focused and unfocused panes show the same tab colors: Modern UI sets `--modern-ui-editor-tab-unfocused-active-foreground` to the active foreground [V], so an unfocused pane is marked only by its dimmed editor actions. That cue matters in Conduit, where keystrokes go to the focused session.

Geometry check: the strip is 4 + 24 + 4 + 1 = **33** (Compact 4 + 20 + 4 + 1 = **29**) [V `EDITOR_TAB_HEIGHT` modernUI 32 / compact 28, plus 1 when connected]. The active fill runs from the strip top to the strip bottom, so the tab and the session below read as one surface. The strip needs no bottom border: VS Code's connected border defaults to the surface color, so it is invisible [V `--modern-ui-connected-tab-border: var(--modern-ui-connected-tab-surface)`]. [ADAPT] VS Code extends the active fill 1px further (`bottom: -gutter - stroke`) to cover that invisible line. Conduit stops at the strip bottom, because `.cv-tabs` clips vertical overflow.

**Tab parts** (`PaneTabBar.tsx:361-432` today):

| Part | Spec |
|---|---|
| Icon | 16px. Entry tabs use the entry icon in its `--c-entry-*` color (today 13px, `PaneTabBar.tsx:458`). Other tabs use `typeIcons` at 16px (today 14px, `PaneTabBar.tsx:26-35`). Home uses `home` in `--c-accent-text`. |
| Label | Session title, ellipsis (today `max-w-[120px]`, `PaneTabBar.tsx:404`). |
| Close | IconButton 20×20 (hover target), radius 4, hover bg `--c-toolbar-hover`, `close` glyph at 16px (not compact), `aria-label="Close {title}"`, `tabIndex=-1`. The active tab always shows it; inactive tabs show it on hover or focus [V]. |
| Status dot (D-18) | Only when `status !== "connected"`: `data-state="connecting"`, `"reconnecting"` or `"disconnected"` on the tab. The close slot then shows `circleFilled` 16px in `--c-state-connecting` (pulsing, 2s, off under reduced motion) or `--c-state-error`, and swaps to the close glyph on hover or focus [V: VS Code's dirty dot works the same way]. Its tooltip text comes from today's logic (`PaneTabBar.tsx:416-422`), moved to the tab's `title`. Connected tabs show no dot (today a green 8px dot, `PaneTabBar.tsx:407-423`). |
| Rename | The input replaces the label: 22px tall, 13px, bg `--c-input-bg`, 1px `--c-focus` border, radius 2, `max-width:180px`. Enter commits and Escape cancels, as today (`PaneTabBar.tsx:391-402`). |
| Drag and drop | Same data and handlers (`PaneTabBar.tsx:259-326`). The drop marker uses `data-drop-target` instead of the `border-l-2` class (`PaneTabBar.tsx:383-385`), so the layout does not shift. The dragged tab gets `data-dragging` (`PaneTabBar.tsx:386`). |
| Overflow | Horizontal scroll. A vertical wheel scrolls horizontally when `deltaX === 0`. On activation the tab calls `scrollIntoView({block:'nearest', inline:'nearest'})`. |
| New-tab `+` | IconButton 22×22 (`plus`) with `margin: 0 4px`, placed right after the last tab in a wrapper with `position: sticky; right: 0; z-index: 9` and bg `--c-tabstrip` [V `.tabs-bar-add-tab {position:sticky; right:0; z-index:9}`, `.tabs-bar-add-tab .action-label {margin:0 4px}`]. Title `New Local Shell`, hook `data-cv-new-tab`. Its menu is today's (`PaneTabBar.tsx:73-136`). |
| Editor actions | Outside the scroller, right-aligned, `.cv-editor-actions` (8px right padding, 50% opacity while the pane is not focused): one IconButton `splitHorizontal`, `Split Right (Ctrl+\)` (`layoutStore.splitPane(paneId, "horizontal", activeId)`). The side bar hamburger (`PaneTabBar.tsx:336-358`) goes, because the activity bar replaces it: W2-TABS hides it behind a `legacySidebarToggle` prop (default `true`), W2-WORKBENCH passes `false` when it mounts the activity bar, and W4-CLEANUP deletes it. The AI toggle moves to the title bar: W2-WORKBENCH stops passing `rightSlot` (`App.tsx:1092-1106`), the prop stays optional until W4-CLEANUP removes it from `Pane`, `LayoutRenderer` and `SplitContainer`. |
| ARIA | `.cv-tabs` has `role="tablist" aria-label="Sessions"`. Tabs have `role="tab"`, `aria-selected`, roving `tabIndex` and `aria-controls` → PaneContent's `role="tabpanel"` wrappers. Left, Right, Home and End move and activate. The strip gets `data-focused` when its pane is focused (the `isFocused` prop, unused today at `PaneTabBar.tsx:43`). |
| Hooks | Keep `data-tabbar` on the strip. Add `data-cv-tab="{sessionId}"`. |

**Tab context menu** (native popup, `PaneTabBar.tsx:147-247`). Same items, with icons from the active pack: Rename `pencil`, Reconnect `refresh`, View Info `infoCircle` (was `home`), Send Ctrl+Alt+Delete `keyboard`, Copy Username `user`, Copy Password `key`, Split Right `splitHorizontal`, Split Down `splitVertical` (today both use a missing `split` key, `PaneTabBar.tsx:175-176`), Close Session `close` (danger). New-tab menu icons: Quick Connect `plug`, Home Directory `home`, agents `terminal`, Browse... `folder`.

**Empty pane**: the strip stays (for `+` and split). The dashboard fills the content area, as today.

**Drop zones** (`DropZoneOverlay.tsx`): zone fill `--c-drop-bg`, 1px `--c-accent` border, radius 4, inset 4px.

### 3.7 Session surfaces and native web views

- The content area (`Pane.tsx:25-28`, `data-content-area` on the focused pane, kept) has bg `--c-editor`. RDP, VNC, terminal, document and dashboard views are HTML, so the card's `overflow:hidden` + radius clips them.
- **Web views (D-17).** A native `WebContentsView` paints over HTML and ignores CSS clipping. `WebView.tsx:246-265` (`syncBounds`) adds `radius` to its `web_session_update_position` payload (`ipc/web.ts:128-131`) and includes it in the de-duplication key (`x|y|w|h|radius`, today `WebView.tsx:257-259`), so a radius-only change is still sent. The value is **7** (card radius 8 minus the 1px border) when all of these hold, else 0:
  1. density is Comfortable;
  2. the session engine is Chromium;
  3. the container's bottom-left and bottom-right corners both sit within 1px of the editor card's inner bottom corners (compare `getBoundingClientRect()` of the container and of `[data-cv-editor-card]`).

  The main process keeps `cornerRadiusDip` per web session and checks it before the unchanged-bounds early return in `updateBounds` (`manager.ts:405-410`). It applies `view.setBorderRadius(Math.round(radius * zoom))` to a view whenever that view's last applied value differs: in `updateBounds`, in `initTabView` and `initTabViewWithDipBounds` (every new sub-tab view, `manager.ts:1014-1072`), in `switchTab` and `closeTab` when a sub-tab view is attached (`manager.ts:614-628, 666-679`) and in `showSession`. It recomputes on zoom changes. A web session has one `WebContentsView` per sub-tab, so applying the radius to `tab.view` alone would leave new or switched sub-tabs square. `setBorderRadius` rounds all four corners [V `electron.d.ts:16118`; Electron keeps the radius per view and reapplies it on bounds changes, `electron_api_view.cc:488-518`], so the web page's top corners are rounded too, under the web toolbar. That is accepted.
- **Square card corners.** A native view the card cannot clip must never sit on a rounded corner. `EditorCard` sets `data-square-bottom-left` and `data-square-bottom-right`, and CSS drops that corner's radius to 0, whenever a pane showing a native web view touches exactly that bottom corner while the view is square: a Chromium view in a pane that touches only one bottom corner (for example the left pane of a side-by-side split), or a **WebView2** view (Windows) in any corner pane. WebView2 cannot be rounded (a separate HWND placed by screen coordinates, `webview2-session.ts:155-163`). A Chromium view that touches both corners gets radius 7 instead, and the card keeps its corners.
- **Remote pages cannot drag the window (D-27).** On every `dom-ready` of a web-session view (`setupTabEventHandlers`, `manager.ts:1212`), the main process calls `view.webContents.insertCSS('*, *::before, *::after { -webkit-app-region: no-drag !important; app-region: no-drag !important; }', {cssOrigin: 'user'})`. A user-origin `!important` declaration beats the page's own `!important` rules, and only main frames report drag regions [V Electron `electron_api_web_contents.cc:865-867` TODO]. Without it, a site whose CSS sets `-webkit-app-region: drag` (common in pages shared with Electron desktop apps) would become a window-drag handle and swallow clicks once the frame is gone [V `native_window.cc:104-105` (no frame with `titleBarStyle: 'hidden'`), `electron_api_web_contents.cc:2440` (regions ignored only when the window has a frame), `electron_api_web_contents_view.cc:94-144` (every `WebContentsView` is a drag-region provider)]. WebView2 is a separate process and is not affected. It can be tested on macOS (8.7).
- **Freeze.** Every DOM surface that can overlap the editor card must hold a freeze (section 4.9): dialogs, DOM popovers, the floating side bar and drags. `useNativeViewVisibility.ts:58-59` then reads `isFrozen()` from the registry instead of three event booleans.
- **Content-size fallbacks.** `entryStore.ts:49-50` and `QuickConnect.tsx:80-81` guess `innerWidth − 250` and `innerHeight − 40` when `[data-content-area]` is missing. They move to `getContentAreaFallback()` in `src/lib/layout/contentArea.ts`, which computes from `metrics.ts` (chrome width, title bar ÷ zoom, gaps, tab strip, status bar).
- **RDP, VNC and terminal sizing.** VNC and terminals need no code change: each reads its own container. VNC reads the canvas rect for MCP clicks (`VncView.tsx:440`), and terminals refit with the xterm fit addon (`TerminalView.tsx:123,160,171,221,240,326`). RDP measures `clientWidth` and the canvas rect (`RdpView.tsx:486,514,576,630,652,731`) and needs the resize fix below. The new chrome only makes those containers smaller (3.3 budget). Their toolbars and error states restyle in W3-SESSIONS.
- **RDP resolution churn.** RDP follows the container size, and today one layout change can send two to four identical `rdp_resize` requests: the `conduit:layout-changed` handler resizes at once and again at 50, 200 and 500ms, and compares against the size the server last confirmed, not the size it last requested (`RdpView.tsx:570-615`). W2-TABS changes that handler: it keeps `lastRequestedRef`, skips a request when the target is within 10px of the last requested size, and replaces the immediate call plus retries with one 150ms trailing debounce followed by a single 500ms retry that fires only if the server has not confirmed the size. The density switch is one layout pass (3.3: `chromeWidth` updates in the same task). Guardrail: never animate the size of a card that holds sessions; the floating side bar animates transform only. Acceptance: one `rdp_resize` log line per density switch, AI toggle and banner change against a real RDP host.
- **MCP viewport.** `website_get_dimensions` reports `tab.view.getBounds()` (`manager.ts:965-972`), so agents see the smaller area. `/verify-mcp` runs after wave 2 (section 8.5).
- **Screen coordinates.** WebView2 HWNDs, context menus and the toast overlay are placed from `getContentBounds()` (`manager.ts:92-105`, `menu.ts:145-148`, `overlay-manager.ts:133-138`). W2-MAIN rewrites the stale comment at `manager.ts:93-95`, which assumes a native title bar and menu bar above the content. A maximized or snapped frameless window on Windows can report an inset client area; 8.7 checks placement in those states.

### 3.8 AI secondary side bar

- `src/stores/auxBarStore.ts` (zustand): `{open, width, toggle(), setOpen(), setWidth(), commitWidth()}`. It persists in `localStorage` as `conduit:ai-panel-open` (default `false`) and `conduit:ai-panel-width` (default 400, clamped 300 to 800), with try/catch like `sidebarStore.ts:74-88`. Today the width is `useState(400)` and not persisted (`App.tsx:97-98`) (D-10).
- It publishes `setRightPanelWidth(open ? width + 4 : 0)` to `sidebarStore` (the 4px is the gap in Comfortable and the in-flow sash in Compact, 3.3), replacing `App.tsx:381-383`. Maximum width: `maxRightPanelWidth(state, 800 + 4)`, as `App.tsx:526-529`.
- Shortcut: Ctrl/Cmd+Alt+B in `useKeyboardShortcuts`. The shortcut table gains an optional `code` field matched against `e.code` (`KeyB`), because Option+B on macOS changes `e.key` to `∫` [A: macOS keyboard layout behavior].
- The card keeps `contain: strict` (`App.tsx:1119`). It opens and closes without animation.
- **Part title row, 32px** (W2-AI restyles the header of `ChatPanel.tsx:222-295`). Left: the engine switcher as a title-style button (engine logo 16, engine name 12px/600, `chevronDown` 16). Right: 22×22 IconButtons for model, new conversation (`plus`) and close (`close`, `Close AI Chat (Ctrl+Alt+B)`, calls `setOpen(false)`). Everything below the header belongs to W3-AI.

### 3.9 Banners

`BannerStack` sits between the title bar and the workbench and spans the full width, like VS Code's banner part [V `this.height=26`]. It hosts `SyncBanners` and, on the vault hub, the offline banner.

| Property | Value |
|---|---|
| Row | `min-height: 26px; display: flex; align-items: center`, 12px text on a 26px line, an icon container with `padding: 0 6px 0 10px`, 10px right padding [V `.part.banner {font-size:12px}`, `.icon-container {padding:0 6px 0 10px}`, `.message-container {line-height:26px}`]. [ADAPT] The text may wrap to a second line instead of VS Code's single-line ellipsis, so no sync message is cut off |
| Colors | tones `info` and `lock` (`SyncBanner.tsx:10-16`): bg `--c-selected` over `--c-shell`, as VS Code's `banner.background` = `list.activeSelectionBackground` [V]. Tone `warn`: bg `--c-warning-bg` [ADAPT: sync warnings such as changes to review or paused syncing must stand out; VS Code's banner only carries neutral notices]. Text `--c-ink`; icon 16px in `--c-info` (info), `--c-warning` (warn) or `--c-ink-muted` (lock); `border-bottom: 1px solid var(--c-divider)` |
| Text | kept in `span.flex-1` plus hook `data-cv-banner-text` (harness `ui-forms.mjs:85`) |
| Actions | `Button variant="link"` in `--c-ink`, always underlined, `padding: 3px; margin-left: 12px` [V `.message-actions-container a {color: var(--vscode-banner-foreground); padding:3px; margin-left:12px; text-decoration:underline}`]. They stay `<button>` elements with their exact labels, so the harness's exact `Review` (B14) and `Use here instead` (B34) still match. The `primary` flag (`SyncBanner.tsx:34-44`) no longer changes the look |
| Semantics | `role="status"` kept (D-12, `SyncBanner.tsx:30`). These are the only `role="status"` elements outside dialogs |

Adding or removing a banner calls `notifyLayoutChanged()`.

### 3.10 Status bar

`<footer data-cv-statusbar aria-label="Status bar">`. **Not** `role="status"` (OD-9).

| Property | Comfortable | Compact | Source |
|---|---|---|---|
| Height | 22 bar + 6 bottom gutter = 28 | 22 + 4 = 26 | [V] `FLOATING_BOTTOM_PADDING=6` / 4 |
| Side padding | 6 | 4 | [V] |
| Border | none | `border-top: 1px solid var(--c-divider)` (inside the 22) | [V] Modern hides the top border; Compact dividers per 2.9 |
| Background, text | `--c-shell`, `--c-statusbar-fg`, 12px/22px | same | [V] |
| Item | `height:22px; padding:0 5px; margin:0 3px; border-radius:4px; gap:4px; font-variant-numeric: tabular-nums`, icon 16px | `margin:0 2px; padding:0 4px` | [V] `.statusbar-item {… font-variant-numeric: tabular-nums}`, so counts do not jitter |
| Hover (buttons only) | bg `--c-statusbar-hover`, text and icon `--c-statusbar-hover-fg` (`hover:bg-(--c-statusbar-hover) hover:text-(--c-statusbar-hover-fg)`) | same | [V] `.statusbar-item>a:hover:not(.disabled) {color: var(--vscode-statusBarItem-hoverForeground)}` |
| Pressed (buttons only) | bg `--c-statusbar-active` (`active:bg-(--c-statusbar-active)`) | same | [V] `.statusbar-item a:active:not(.disabled) {background-color: var(--vscode-statusBarItem-activeBackground)}` |
| Tones | warning fg `--c-warning`; error fg `--c-danger`; busy icons spin (`animate-spin`, off under reduced motion) | same | [ADAPT] text color only, no colored item backgrounds |

Items (D-11), left to right, then right-aligned:

| Side | Id (`data-cv-status=`) | Shown when | Content | Click | Tooltip (`title`) | Source today |
|---|---|---|---|---|---|---|
| Left | `offline` | `authMode === 'cached'` | `wifiOff` + `Offline`, warning tone | `useAuthStore.getState().tryReauthenticate()` | `Working offline, using cached features. Click to reconnect.` | `App.tsx:1072-1083` |
| Left | `sync` | personal vault with a sync state | tone icon from `iconFor()` + `statusLabel()`; icon only when "Up to date" | `conduit:settings` → `sync` | `"{label}. {detail}"`; `aria-label="Sync: {label}"` | `PersonalSyncIndicator.tsx:43-53` |
| Left | `review` | `conflictCount > 0` | `alertTriangle` + `{n} to review`, warning tone | `openView({kind:"review", row:null})` | `Review changes from your other devices` (kept for `flows.mjs:180`), plus hook `data-cv-review-button` | `PersonalSyncIndicator.tsx:54-62` |
| Left | `cloud-backup` | as `CloudSyncIndicator` today | its icon and label | as today | as today | `vault/CloudSyncIndicator.tsx` |
| Left | `team-sync` | team vault | as `TeamSyncIndicator` today | as today | as today | `vault/TeamSyncIndicator.tsx` |
| Left | `freerdp` | a build task is shown | `loader` (spinning) + `Building FreeRDP helper...`; done: `check` + `FreeRDP helper ready`; error: `alertTriangle` + `FreeRDP build failed` (error tone) | none | the task detail | `common/StartupStatus.tsx:19-80`: same events, same auto-dismiss (4s done, 10s error) |
| Right | `session` | the focused pane has an active session | type icon 16 + session title (max 240px, ellipsis); when not connected, the `circleFilled` icon at 16px (an 8px disc, like VS Code's dirty dot) in the state color | none (`<span>`) | `{type}: {title}, {status}` | new, from `layoutStore` + `sessionStore` |
| Right | `trial` | `isTrialing && trialDaysRemaining >= 0` | `clock` + `Pro trial: {n} days left`; urgent → error tone, moderate → warning tone | none | same text | `Sidebar.tsx:490-511` |
| Right | `zoom` | the zoom factor from `useZoomFactor()` (`src/lib/window-chrome.ts`, 3.2) is not 1 | `search` + `{pct}%` | `conduit:settings` → `appearance` | `Zoom {pct}%. Change it in Settings > Appearance.` | new |

Text rule: no status bar item may show text exactly equal to the six unscoped harness labels (OD-9) or containing a reserved harness phrase (section 8.4).

### 3.11 Zoom and coupling rules

- `ui_scale` stays 0.75 to 1.5 (`main.ts:854`). Everything zooms except the title bar (counter-zoomed) and the toast overlay window (non-goal).
- Main-process DIP math is unchanged (`manager.ts:81-90` `cssToDip`), because the renderer still sends page CSS px.
- These call `notifyLayoutChanged()` (4.9), which dispatches the existing `conduit:layout-changed` event (listened to at `WebView.tsx:342`): density change, banner count change, side bar dock or undock, AI open, close and resize end, zoom change, and full-screen change. The existing dispatch sites (`App.tsx:377-379,398-405,540`, `Sidebar.tsx:263`, `LayoutRenderer.tsx:30`) stay until W4-CLEANUP routes them through the helper.
- Minimum window size stays 1024×700 (`main.ts:707-708`).

---

## 4. Components

### 4.1 Conventions

- One small file per primitive in `src/components/ui/`, plus a barrel `src/components/ui/index.ts` and a local `cx.ts` (`export const cx = (...c: Array<string | false | null | undefined>) => c.filter(Boolean).join(" ")`). No new runtime dependency (OD-7).
- Primitives take `className` (appended last) and forward `ref` and `data-*` props. Every interactive primitive uses the global focus rule (2.7). Primitives never set `outline: none`.
- Utilities come from the `@theme` block in 2.10. Tokens without a theme name use Tailwind v4's variable shorthand, for example `bg-(--c-btn-secondary-bg)` (v4 syntax for `bg-[var(--c-btn-secondary-bg)]`) [V: test-compiled with the repo's Tailwind; `bg-(--c-btn-secondary-bg)` emits `background-color: var(--c-btn-secondary-bg)`, and the `z-`, `outline-`, `border-`, `accent-`, `text-`, `placeholder:` and `focus-within:` forms used below compile the same way].
- Harness-bound markup rules (Appendix B) that primitives must keep:
  - Dialog panels carry `data-dialog-content`, and the title is an `h2`.
  - Labeled fields render as `<label><span>{label}</span>…control…</label>`, with the control *inside* the label (`ui-forms.mjs:28-38` fills the input inside the label whose first `span` equals the label).
  - Checkboxes are `<label>` elements that wrap `input[type=checkbox]` and the text (`ui-forms.mjs:61-69`). Radios are the same with `input[type=radio]`, and the label's text is exactly the option text (`sync-dialogs.mjs:98-106`, B46).
  - Inline errors are `<p data-cv-error>`.
  - A dialog with a form passes `onSubmit` to `Dialog`, which then wraps header, body and footer in one `<form>` so the submit button is inside it (`[data-dialog-content] form button[type=submit]`, B31; 4.8).
  - DOM menu items render `<button type="button" role="menuitem">` (the harness clicks `Lock Current Vault` with selector `button`, B43). Clickable `ListRow`s render `<button>` (B44).
  - Actions revealed on hover or focus hide with `opacity: 0` only, never `visibility` or `display`: the harness skips elements that are `visibility: hidden` or have no layout box (`ui.mjs:85-88`, B45).
  - Busy text stays visible text: `Button loading` keeps a visible label and `Spinner` can show text (4.2, 4.12, B35).
- A shared gallery (`gallery.html` + `src/gallery.tsx`, dev server only, not in `rollupOptions.input`) renders every primitive in every state, including each focusable primitive focused inside a `Card` and inside a tab strip (2.7). It has scheme, mode, density and icon pack switches. It is the screenshot source in section 8.6.

### 4.2 Button

`<Button variant size icon iconEnd loading fullWidth type="button" …>` (`src/components/ui/Button.tsx`).

| Part | Recipe | Source |
|---|---|---|
| Base | `inline-flex items-center justify-center gap-1 whitespace-nowrap rounded border select-none transition-colors duration-100 disabled:opacity-40 disabled:pointer-events-none` + `data-cv-text-button` (2px focus offset, 2.7) | [V] disabled `opacity:.4`; radius 4; `.monaco-text-button:focus {outline-offset:2px}` |
| `sm` | `h-control-sm px-1.5 text-meta` (22px, 11px) | [V] small button 11px, `3px 6px` |
| `md` (default) | `h-control px-2 text-label` (26px, 12px) | [V] `.monaco-text-button` 12px/16, `4px 8px`, 1px border |
| `lg` | `h-control-lg px-3 text-body` (32px) | [ADAPT] landing-page CTAs only |
| `primary` | `bg-btn-primary hover:bg-btn-primary-hover text-white border-transparent` | [V] `button.background` / hover |
| `secondary` | `bg-(--c-btn-secondary-bg) text-(--c-btn-secondary-fg) border-(--c-btn-secondary-border) hover:bg-(--c-btn-secondary-hover)` | [V] `button.secondary*` |
| `ghost` | `bg-transparent border-transparent text-ink-secondary hover:bg-hover hover:text-ink` | replaces 101 ghost buttons [V count] |
| `danger` | `bg-btn-danger hover:bg-btn-danger-hover text-white border-transparent` | 2.2.3 |
| `link` | `h-auto px-0 border-0 bg-transparent text-link hover:text-link-hover hover:underline` | [V] `textLink.*` |
| Icon | 16px (`sm`: 12px, the compact glyph when the pack has one), 4px gap | [V] leading icon 16, 4px gap |
| Loading | a 16px spinning `loader` replaces the icon; the label stays visible: `loadingLabel` when given (for example `<Button loading loadingLabel="Opening...">`), else the children; `aria-busy="true"`; disabled | the harness reads `Opening...`, `Please wait...` and `Checking...` from the button text (B35) |
| Order in footers | secondary first, primary last (right), as today (`SettingsDialog.tsx:218-231`) | |

Replaces the 332 raw text buttons, `DialogButton` (`SyncDialogFrame.tsx:71-100`), `smallButton()` (`ConflictFieldRow.tsx:34-38`), the `ConfirmDialog` buttons (`ConfirmDialog.tsx:30-43`), and the toast and banner actions [V counts, primitives research].

### 4.3 IconButton

`<IconButton icon label size pressed tone …>`. `label` is required and becomes both `aria-label` and the native `title` (D-21). A shortcut hint is appended in parentheses by the caller.

| Size | Box | Icon | Radius | Use |
|---|---|---|---|---|
| `sm` | 20 × 20 | 16 | 4 | tab close, field adornments, clear buttons [V close target 20] |
| `md` (default) | 22 × 22 | 16 | 4 | toolbars, part titles, title bar, tab strip [V `.monaco-action-bar .action-label {padding:3px}`; Modern UI radius `cornerRadius.small`, `.modern-ui .monaco-action-bar .action-label {border-radius: var(--vscode-cornerRadius-small)}` overrides the classic 6] |
| `lg` | 28 × 28 | 20 | 4 | landing pages only [ADAPT] |

Focus: the inset ring (2.7), because icon buttons often sit at a card or strip edge that clips.

Colors: `text-ink-muted hover:text-ink hover:bg-toolbar-hover active:bg-toolbar-active`. `pressed` sets `aria-pressed="true"` and `bg-toolbar-active text-ink`; with `pressedLook={false}` it sets only `aria-pressed` (the title bar layout controls, which show state by swapping the glyph, 3.2). `tone="danger"` sets `hover:text-danger`. Disabled: `opacity-40`, plus a `title` that says why (as `Sidebar.tsx:376`, "View-only access"). Replaces the 120 icon-only buttons, 116 of which have no `aria-label` today [V].

### 4.4 Text fields

| Primitive | Recipe | Notes |
|---|---|---|
| `TextInput` | `h-control w-full rounded border border-input-border bg-input px-1.5 text-body leading-4 text-(--c-input-fg) placeholder:text-(--c-input-placeholder)` | [V] 26px, `padding: 4px 6px`, 13px. `invalid` adds `border-danger` + `aria-invalid`. `leading`/`trailing` slots: 16px icons at 6px from the edge, input `pl-7`/`pr-7` |
| `Textarea` | same colors, `min-h-[78px] px-1.5 py-1 text-body leading-[18px] resize-y` | |
| `PasswordInput` | `TextInput` + trailing `IconButton sm` (`eye`/`eyeOff`) labeled `Show password`/`Hide password` | keeps today's strings (`PasswordFields.tsx:31`); replaces `PasswordFields.PasswordInput` |
| `SearchInput` | wrapper `flex items-center gap-1.5 h-control px-1.5 rounded border border-input-border bg-input focus-within:outline focus-within:outline-1 focus-within:outline-(--c-focus) focus-within:-outline-offset-1`; inner `<input data-bare>`; leading `search` 16; trailing clear `IconButton sm` when not empty | today `Sidebar.tsx:398-433` |
| `FormField` | `<label class="block"><span class="block text-label font-semibold text-ink-secondary mb-1">{label}</span>{control}{description && <span class="block text-meta text-ink-muted mt-1">}{error && <p data-cv-error class="text-meta text-danger mt-1">}</label>` | harness structure (4.1). Generalizes `entries/Field.tsx:8-18` |

Every field sets an explicit font size. 24 fields today have none and inherit 16px [V].

### 4.5 Select

A native `<select>` wrapped for styling: `appearance-none h-control w-full rounded border border-(--c-dropdown-border) bg-(--c-dropdown-bg) pl-1.5 pr-6 text-body text-ink`, plus a `chevronDown` 16 at `right:4px`, `pointer-events-none`. The popup list follows `color-scheme` (2.8), which today leaves it light in dark mode. It keeps every `aria-label` (the harness selects `select[aria-label="Lock the vault when idle"]`, `settings-flows.mjs:11`). It replaces 20 raw selects and the inner selects of `DefaultableSelect` and `DefaultableCheckbox`.

### 4.6 Checkbox, Radio, Switch, Slider

| Primitive | Recipe | Source |
|---|---|---|
| `Checkbox` | `<label class="inline-flex items-start gap-2 text-body text-ink-secondary">` + `<input type=checkbox class="peer appearance-none size-[18px] shrink-0 rounded-[3px] border border-(--c-checkbox-border) bg-(--c-checkbox-bg) checked:bg-btn-primary checked:border-btn-primary">` + a white `check` 16 icon shown by `peer-checked` + text. Focus ring 2px outside (2.7) | [V] 18×18, radius 3, `input[type=checkbox]:focus {outline-offset:2px}`. [ADAPT] accent fill when checked (VS Code draws a gray glyph on gray) |
| `Radio` / `RadioGroup` | `<label>` wrapping `<input type=radio class="appearance-none size-4 rounded-full border border-(--c-checkbox-border) bg-(--c-checkbox-bg)">` and the option text (exactly the text, B46) + an 8px `--c-btn-primary-bg` inner dot when checked; focus ring 2px outside; the group uses `role="radiogroup"` and arrow keys | |
| `Switch` | `<button role="switch" aria-checked>`: track 28 × 16 `rounded-full`; off: `bg-(--c-checkbox-bg)` with a 1px `border-(--c-checkbox-border)`; on: `bg-btn-primary`, border transparent; thumb 12 × 12, off `bg-ink-muted`, on white, `translate-x-3` | [ADAPT] VS Code has no switch; replaces `SecurityTab.tsx:98-109` (no role today). The off track's border is the 3:1 boundary (3.26:1 or better, 2.11); `--c-control-border` would be 1.31:1 |
| `Slider` | native range, `w-full accent-(--c-accent) h-4`; min/mid/max row `text-meta text-ink-muted` | today `AppearanceTab.tsx:269-296` |

### 4.7 Tabs, SegmentedControl, NavList

| Primitive | Recipe | Semantics | Replaces |
|---|---|---|---|
| `Tabs` `variant="panel"` (default) | strip `flex items-center gap-1 h-part-title px-1`; tab `h-6 px-2.5 rounded text-body text-(--c-tab-fg) hover:bg-hover hover:text-(--c-tab-fg-hover)`; selected `bg-selected-inactive text-(--c-tab-fg-active)` | `role="tablist"`/`tab`, `aria-selected`, Left/Right/Home/End | `MarkdownEditor.tsx:36-58` underline tabs. [V] Modern panel tabs: 24px pills, 13px regular, radius 4, bg `list.inactiveSelectionBackground`; label `panelTitle.inactiveForeground` (`#8C8C8C` / `#606060`), hover `modernTab.hoverForeground`, checked `modernTab.activeForeground` |
| `Tabs` `variant="underline"` | strip `flex items-end gap-4 h-part-title px-2 border-b border-divider`; tab `h-full px-0 text-body text-(--c-tab-fg) hover:text-(--c-tab-fg-hover) border-b-2 border-transparent`; selected `text-(--c-tab-fg-active) border-(--c-tab-underline)` | same | OD-7 names underline tabs. [V] `panelTitle.activeBorder` (`#3994BC` / `#000000`); VS Code's classic panel tabs. No screen uses it at launch; the gallery covers it |
| `SegmentedControl` | container `inline-flex gap-0.5 p-0.5 rounded-md bg-well`; item `h-control-sm px-2 rounded text-label text-ink-muted hover:text-ink`; selected `bg-selected text-ink` | `role="radiogroup"` + `role="radio"`, arrows | both segmented styles (accent fill in 8 places, raised thumb in `AppearanceTab.tsx:188-208`). One neutral style (D-13) |
| `NavList` | rows `flex items-center gap-2 h-row px-2 rounded text-body text-ink-secondary hover:bg-hover`; selected `bg-selected text-ink` plus `data-selected` (the 2.11 re-scope); group row with `chevronRight`/`chevronDown` 16; group label `h-row px-2 text-meta font-semibold text-ink-muted` | `role="navigation"` + buttons with `aria-current="page"` | `SettingsNav.tsx:53-68`, `EntryDialogSidebar.tsx:48-60`, `VaultSettingsDialog.tsx:809-822` (36px rows and accent tint today) |

The Settings nav container keeps the `w-52` class (208px) and adds `data-cv-settings-nav`. The harness clicks `.w-52 button` until wave 4 (Appendix B).

### 4.8 Dialog, ConfirmDialog and the layer stack

**`Dialog`** (`src/components/ui/Dialog.tsx`):

```tsx
<Dialog open onClose title icon? tone? size="sm|md|lg|xl" layer="base|sync|stacked"
        harnessLabel? closeOnScrim? initialFocusRef? footer? hideClose? onSubmit? portal?>
```

| Part | Recipe | Source |
|---|---|---|
| Portal and scrim | portal to `document.body` (unless `portal={false}`, which renders in place); `fixed inset-0 flex items-center justify-center p-4 bg-(--c-scrim)`; z-index from `layer`: `--c-z-dialog` 50, `--c-z-dialog-sync` 60, `--c-z-dialog-stacked` 70; `data-cv-layer={layer}` on the scrim | today z-50 / `z-[60]` (`SyncDialogFrame.tsx:48`) / `z-[70]` (`RecentlyDeletedPanel.tsx:130`) |
| Panel | `data-dialog-content role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}` + `relative flex w-full max-h-[85vh] flex-col overflow-hidden rounded-lg border border-overlay-border bg-overlay text-ink shadow-modal outline-none` | [V] radius 8, shadow xl (D-25) |
| Form (`onSubmit`) | when `onSubmit` is set, the panel's only child is `<form data-cv-dialog-form class="flex min-h-0 flex-1 flex-col" onSubmit={…}>`, which wraps header, body and footer; the footer is the form's last child and holds the `type="submit"` button. Enter in a field submits, as today | the harness submits every vault form with `[data-dialog-content] form button[type=submit]` (B31); `UnlockDialog.tsx:245-387` wraps all three in one form today |
| `harnessLabel` | also sets `aria-label={harnessLabel}`; only sync-style dialogs pass it (`SyncDialogFrame`, `ConflictReviewPanel`) | D-22 and 8.3: the harness reads `[role=dialog][aria-label]` as "sync dialogs" |
| Width | `sm` 400, `md` 520, `lg` 720, `xl` 880 (`max-w-[400px]` …) | D-25; [ADAPT] VS Code's 440 min width applies to its message box only |
| Header | `flex items-center gap-2 px-4 pt-4 pb-3`; optional tone tile `size-7 rounded-md` (`info` `bg-info-bg text-info`, `warn` `bg-warning-bg text-warning`, `danger` `bg-danger-bg text-danger`) with a 16px icon; `<h2 id={titleId} class="flex-1 mt-0.5 text-heading text-ink">` (13px/600); close `IconButton md` `close`, `label="Close"` | [V] Modern dialog title `fontSize.heading3` 13px, semibold, margin 2px top and 12px bottom, row padding 16px top. `aria-label="Close"` matches `sync-flows.mjs:171` |
| Body | `min-h-0 flex-1 overflow-y-auto px-4 py-2 text-body text-ink-secondary space-y-3`. Message-box dialogs (`ConfirmDialog`, alerts) show their message in `text-ink-muted`; form dialogs keep `text-ink-secondary` | [V] `.modern-ui-notifications-dialogs … .dialog-message-detail {color: var(--vscode-descriptionForeground)}` |
| Footer | the **last child** of the panel (of the form when `onSubmit` is set): `flex flex-wrap justify-end gap-2 px-4 pt-2 pb-4` + `data-cv-dialog-footer` | harness `${root} > div:last-child button` (`settings-flows.mjs:52`); the B3 union also matches `[data-cv-dialog-footer]` |
| Motion | none: the dialog appears and disappears at once, and unmounts when `open` goes false | [V] no animation rule matches `.monaco-dialog-box` (D-25) |
| No blur | `backdrop-blur-sm` goes (`SyncDialogFrame.tsx:48`, `ConfirmDialog.tsx`) | D-25 |
| Behavior | `useFreeze(open, "dialog")` (4.9); `useLayer({onEscape: onClose, trapFocus: true})`; focus `initialFocusRef` or the first `[autofocus]`, else the panel; return focus to the opener on close; scrim click closes only when `closeOnScrim` (default `false`; `AboutDialog` passes `true`, as today at `AboutDialog.tsx:28-30`) | replaces the hand-written Escape in 30 files [V] |

`DialogHeader`, `DialogBody` and `DialogFooter` are exported for dialogs that need custom layouts (Settings, EntryDialog).

**`ConfirmDialog`** (`src/components/common/ConfirmDialog.tsx`, rebuilt on `Dialog` by W3-MISC). Props stay compatible with today's (`ConfirmDialog.tsx:1-8`): `title`, `message`, `confirmLabel = "Confirm"`, `variant: "default" | "danger"`, `onConfirm`, `onCancel`. New optional props: `cancelLabel = "Cancel"` and `layer`. The message renders in `text-ink-muted`. **Stacking during the migration:** when `layer` is not given, `ConfirmDialog` renders with `portal={false}` at the `base` z-index, exactly where today's markup sits. That keeps `RecentlyDeletedPanel`'s `div.relative.z-[70]` wrapper working (`RecentlyDeletedPanel.tsx:129-131`) whichever of W3-MISC and W3-SYNC merges first; a portal would move the confirm under the z-60 panel. W3-SYNC (which depends on W3-MISC) passes `layer="stacked"` and drops the wrapper in the same change. W4-CLEANUP makes the portal the default once every caller that needs a layer passes one.

**Layer stack** (`src/components/ui/layers.ts`):

```ts
export function useLayer(opts: { ref: RefObject<HTMLElement>; onEscape?: () => void; trapFocus?: boolean }): void;
export function useEscapeLayer(onEscape: (() => void) | undefined): void;   // same contract as today
```

One capturing `keydown` listener serves the whole stack. Escape goes to the top layer only and is swallowed with `stopImmediatePropagation` (today's semantics, `useEscapeLayer.ts:3-19`). Tab and Shift+Tab cycle inside the top layer when it traps focus. `src/components/sync/useEscapeLayer.ts` becomes a one-line re-export in wave 1 and is deleted in wave 4.

### 4.9 Freeze registry (native web views)

`src/lib/native-freeze/index.ts` (W1-FREEZE):

```ts
export type FreezeReason = "dialog" | "popover" | "sidebar" | "drag" | "menu" | "legacy";
export function acquireFreeze(reason: FreezeReason, label?: string): () => void; // release is idempotent
export function isFrozen(): boolean;
export function subscribe(listener: () => void): () => void;
export function useIsFrozen(): boolean;                           // useSyncExternalStore
export function useFreeze(active: boolean, reason: FreezeReason, label?: string): void;
export function notifyLayoutChanged(): void;                     // rAF-coalesced "conduit:layout-changed"
export function freezeHolders(): ReadonlyArray<{ reason: FreezeReason; label?: string; since: number }>;
```

- Holders live in a `Map<symbol, Holder>`, and the view is frozen while the map is not empty (OD-8). Subscribers are notified once per microtask batch.
- **Legacy bridge**, removed by W4-CLEANUP: the module listens for `conduit:overlay-change`, `conduit:sidebar-overlay-change` and `conduit:drag-change` (`App.tsx:389-395,410-415`; `DragContext.tsx:35-48`) and maps each to one `legacy` holder. Old dispatchers therefore keep working while the directories migrate.
- `useNativeViewVisibility.ts:46-82` drops its three booleans and listeners and computes `shouldBeNative = isActive && !useIsFrozen() && webviewReady`. Paths A and B (`useNativeViewVisibility.ts:89-165`) stay unchanged.
- **Who holds a freeze**:
  - every `Dialog`;
  - wave 1's direct additions to the three shared shells: `SyncDialogFrame`, `ConflictReviewPanel` and `ConfirmDialog`. These close today's gap: sync dialogs never froze web views, because they are not in the `App.tsx:389-391` list;
  - the floating side bar and the spilled vault menu;
  - DOM popovers with `freeze="auto"` whose rect intersects `[data-cv-editor-card]`;
  - tab drags (`DragContext`).
  
  Native popup menus hold none (D-20).
- In development, `window.__conduitFreeze = freezeHolders` for debugging.

### 4.10 Menus and popovers

**Native popup menus** stay the main surface for context menus (D-20). The IPC contract is in section 7.7. The renderer helper `showContextMenu(x, y, items, opts)` (`src/utils/contextMenu.ts:35-61`) keeps its signature. `PopupMenuItem.icon` becomes a `SemanticIconName` (5.1) instead of a menu-local key. The helper serializes each icon to SVG with the active pack (5.6) and resolves colors with `resolveCssColor`.

**DOM `Popover`** (`src/components/ui/Popover.tsx`): `<Popover anchorRef open onClose placement="bottom-start|bottom-end|top-start" freeze="auto|true|false">`. Position comes from the existing `usePopoverPosition` (`src/hooks/usePopoverPosition.ts`, flip and clamp with an 8px edge and a 4px gap). Panel: `rounded-lg border border-overlay-border bg-overlay shadow-overlay p-1 z-(--c-z-popover)`. Motion: `cv-pop-in` over `--c-motion-open` (250ms) and `cv-pop-out` over `--c-motion-close` (150ms), from the anchor corner (2.6). It joins the layer stack (Escape) and closes on outside `mousedown`.

**DOM `Menu`** (`src/components/ui/Menu.tsx`), rendered inside a `Popover`:

| Part | Recipe | Source |
|---|---|---|
| Container | `role="menu"`, `min-w-[160px] py-1` | [V] min-width 160, `padding: 4px 0` |
| Item | `<button type="button" role="menuitem">`, `flex w-[calc(100%-8px)] items-center gap-2 h-6 mx-1 px-2 rounded-md text-body text-ink-secondary`, icon 16 in `--c-ink-muted` | [V] item 24 tall, `margin: 0 4px`, radius 6; text `menu.foreground` (`#BFBFBF` / `#202020`). A `<button>` because the harness clicks `Lock Current Vault` with selector `button` (B43) |
| Active item (hover or keyboard) | `bg-(--c-menu-selection-bg) outline outline-1 -outline-offset-1 outline-(--c-menu-selection-border)` | [V] 2026 `menu.selectionBackground` + `selectionBorder` |
| Danger item | `text-danger`, icon `text-danger` | |
| Separator | `role="separator"`, `h-px my-[5px] bg-divider` | [V] `margin: 5px 0` |
| Header | `h-6 px-3 text-meta font-semibold text-ink-muted` (no uppercase) | [ADAPT] VS Code menus have no headers; Conduit's do (`PaneTabBar.tsx:84`) |
| Keyboard | Up, Down, Home, End, Enter, Space, Escape, typeahead. Keys typed in a field inside the menu (ModelPicker's custom model id) stay with the field: no typeahead, no roving. Escape in that field still closes the popover, because the layer stack takes Escape before any element handler (4.8) | none today |

Users: `VaultSwitcherMenu.tsx:111` (keeps `data-context-menu`), `ChatPanel.tsx:242,510`, `ModelPicker.tsx:65` (keeps `data-popover`), `ColorPicker.tsx:39`, `IconPicker.tsx:51`.

### 4.11 Tooltips

Native `title` only (D-21): a native tooltip cannot be covered by a native web view. `IconButton` sets it from `label`. Text buttons do not get a `title` unless the text is truncated. The command center pill never gets one (3.2).

### 4.12 Badge, Kbd, Spinner

| Primitive | Recipe | Source |
|---|---|---|
| `Badge` | `inline-flex items-center h-4 px-1 rounded text-badge font-semibold`; tones: neutral `bg-selected text-ink-secondary`, accent `bg-badge text-white`, warning `bg-warning-bg text-warning`, danger `bg-danger-bg text-danger`, success `bg-success-bg text-success` (each tone text passes 4.5:1 on its tint, 2.11 rule 3) | [V] `fontSize.label3` 10px |
| Count badge | `min-w-[18px] min-h-[18px] px-[5px] py-[3px] rounded-full text-badge font-normal leading-[11px] text-center`, accent tone | [V] `.monaco-count-badge {padding:3px 5px; border-radius:11px; min-width:18px; min-height:18px; line-height:11px; font-weight:400}`, 10px in Modern UI (`.modern-ui .monaco-count-badge {font-size: var(--vscode-fontSize-label3)}`) |
| `Kbd` | `inline-flex items-center h-4 px-1 rounded border border-control text-meta font-mono text-ink-muted` | |
| `Spinner` | the `loader` icon with `animate-spin` at 12, 16 or 24; `aria-hidden` unless it has a `label` (then `role="img" aria-label`). With `text`, it renders `<span class="inline-flex items-center gap-2">` + the icon + the text as visible text (for example `<Spinner text="Loading..." />`). Never `role="status"` | replaces 4 CSS border spinners (`App.tsx:966`, `App.tsx:988`, picker) and the inline `LoaderIcon` + text pairs in the sync panels, whose text the harness reads (B35) |

### 4.13 Containers

| Primitive | Recipe | Notes |
|---|---|---|
| `Card` | `rounded-md border border-card-border bg-well p-3` | [V] inner containers radius 6 |
| `ChoiceCard` + `ChoiceGroup` | group `role="radiogroup"`, grid; card `role="radio" aria-checked`, `flex flex-col gap-1.5 rounded-md border border-card-border bg-transparent p-2 text-left hover:border-(--c-control-border)`; checked `border-accent bg-selected-inactive`; roving focus with arrows | Appearance scheme and icon pack pickers (6.4); replaces `SchemeCard` (`AppearanceTab.tsx:302-344`) |
| `Callout` | `flex gap-2 rounded-md border p-2.5 text-label`; tones `info` (`bg-info-bg border-info-border`, icon `text-info`), `warning`, `danger`, `success`; title `font-semibold text-ink`; body `text-ink-secondary`; danger body text is `<p data-cv-error>`; optional actions row `mt-2 flex gap-2` of `Button sm`; `size="sm"` uses `p-2` | replaces 46 callouts and `InlineError` (`PasswordFields.tsx:40-47`) |
| `Banner` | the 26px banner from 3.9, `role="status"`; used only by `BannerStack` | |
| `EmptyState` | `flex flex-col items-center gap-2 py-8 text-center`; icon 32 `text-ink-faint`; title `text-body text-ink-secondary`; description `text-label text-ink-muted`; optional action `Button` | about 15 today |
| `SectionHeader` | `<h3 class="text-label font-semibold text-ink-secondary">` + optional `description` `text-meta text-ink-muted`; `mb-2` | must stay an `h3` (the harness reads Sync tab section titles from `h3`, `settings-flows.mjs:72`) |
| `SettingsRow` | `grid gap-1 py-3 border-b border-divider last:border-0`; title `text-body font-semibold text-ink`; description `text-label text-ink-muted`; control below, `max-w-[420px]`; booleans put the `Checkbox` inline with the description, except toggle rows the harness drives (Backup's `Local Backup` and `Cloud Backup`): those keep the title as a `<label>` with exact text and a `Switch` as a direct child of the `.justify-between` / `data-cv-toggle-row` row (B22, B39) | [A] VS Code settings editor pattern |

### 4.14 ListRow and TreeRow

`ListRow` (`src/components/ui/ListRow.tsx`): `flex items-center gap-1.5 h-row px-2 rounded text-body text-ink-secondary`.

- Element: a `<button type="button">` when the row is clickable (the harness clicks recent vaults as `button[title="{path}"]`, B44), else a `<div>`. Selected rows set `aria-selected="true"` (inside a listbox or tree) or `data-selected`.
- States: hover `bg-hover`; selected `bg-selected text-ink`; selected in an unfocused list `bg-selected-inactive`; focus `outline-1 -outline-offset-1 outline-(--c-focus)`.
- Slots: `leading` (16px icon), `trailing` (20px IconButtons shown on hover or `focus-within`, hidden with `opacity-0` only, never `invisible` or `hidden`, B45). A `description` switches the row to `h-row-2line` with a `text-meta text-ink-muted` line; inside a selected row the global re-scope (2.11) turns it into `ink-secondary`.
- `TreeRow` adds `depth` (8px per level), a twistie slot and `role="treeitem"`.

Users: `EntryTree`, `VaultHub.tsx:227,341` rows, `VaultSwitcherMenu`, `CredentialManager`, `BackupManagerDialog`, `SyncDevicesList`, the `ConflictReviewPanel` list, picker lists and `DashboardOverview` rows.

### 4.15 Toasts (visual only)

The toast API is unchanged (`common/Toast.tsx:74-85`). `OverlayToast.tsx` and `OverlayUpdateNotification.tsx` (W3-OVERLAY) become:

- container `data-toast flex items-start gap-2 w-full max-w-[450px] rounded-lg border border-overlay-border bg-overlay p-2 shadow-overlay` [V toast max width 450, radius 8, shadow lg]. The 4px colored left bar goes (`OverlayToast.tsx:13-18`) [ADAPT to VS Code];
- icon 16 in the tone color, `mt-0.5 ml-1` [V 16px severity icon];
- title `text-body font-semibold text-ink`; message `text-body text-ink-secondary`;
- actions `mt-2 flex gap-1` of `Button sm`;
- close `IconButton sm`;
- progress track `h-1 rounded-full bg-selected` with fill `bg-(--c-progress)`;
- animations: `toast-in` slides up from `translateY(100%)` with opacity 0 → 1 over 300ms `ease-out`, and `toast-out` reverses it; both 0ms under reduced motion [V `.notification-toast {transform: translate3d(0,100%,0); opacity:0; transition: transform .3s ease-out, opacity .3s ease-out}`];
- the overlay container (`OverlayApp.tsx:92`) becomes `p-1 gap-1`: each toast then sits 4px inside the window, and with the window placement in 7.6 that is 8px from the window's right edge and 8px above the status bar, as in VS Code (D-24).

`data-toast` must stay (`OverlayApp.tsx:61` switches click-through on it).

### 4.16 Legacy class map for wave 3

Each wave-3 package applies this map in its directory. It uses a primitive wherever one exists.

| Legacy | New |
|---|---|
| `bg-canvas` (page or session background) | `bg-editor` |
| `bg-panel` on dialogs and popovers | primitive (`bg-overlay`) |
| `bg-panel` on side panels | `bg-sidebar` |
| `hover:bg-raised`, `hover:bg-well`, `hover:bg-stroke` (hover surfaces) | `hover:bg-hover` |
| `bg-conduit-600/20 text-conduit-400`, `bg-conduit-500/10` (selection) | `bg-selected text-ink` (D-13) |
| `bg-conduit-600 hover:bg-conduit-700/500 text-white` | `Button variant="primary"` |
| `text-conduit-400 hover:text-conduit-300` (links) | `text-link hover:text-link-hover` or `Button variant="link"` |
| `text-red-400/500`, `bg-red-500/10 border-red-500/20` | `text-danger`, `Callout tone="danger"` |
| `text-amber-400`, `text-yellow-400/500`, `bg-amber-500/10` | `text-warning`, `bg-warning-bg` |
| `text-green-400/500` | `text-success` |
| `text-[10px]`, `text-[11px]` | `text-badge`, `text-meta` |
| `rounded-xl`, `shadow-xl`, `backdrop-blur-sm` on overlays | the `Dialog` primitive |
| `text-2xl font-bold` headings | `text-display` or `text-title` |
| `uppercase` with `tracking-wide` / `tracking-wider`, usually on `text-[10px]` or `text-xs` section labels (40 `uppercase` and 37 `tracking-wide*` class uses in 27 files [V count]) | `SectionHeader`, or `text-meta font-semibold text-ink-muted` with no uppercase and no letter spacing. Modern UI uses title case [V `.modern-ui .monaco-pane-view .pane>.pane-header>.title {text-transform:capitalize}`; `workbench.experimental.modernUIUppercaseViewHeaders` defaults to `false`] |
| `text-base` (8) | `text-heading` for dialog titles, `text-body` elsewhere. Markdown prose variants (`prose-h2:text-base` in `markdownProseClasses.ts:5`) keep document heading sizes |
| `text-xl` (6) | `text-title` |
| `bg-well` (or `bg-raised`) on code blocks and prose `pre` / `code` | `bg-code` (`--c-code-bg`) |
| Tailwind palette entry colors (`entryIcons.ts:61-80`) | `text-entry-ssh` and siblings |
| `w-8 h-8 border-2 … animate-spin` spinners | `Spinner` |

`scripts/redesign/legacy-classes.mjs` matches these patterns only inside `className` / `class` strings and `cx()` arguments, so words such as the `uppercase` option in `src/utils/passwordGenerator.ts` are not findings.

**Exception.** Classes named in Appendix B stay until the matching hook exists and W1-HARNESS's selector pair is merged. The dead files in section 10.5 are skipped.

---

## 5. Icon system

### 5.1 Registry API

Everything lives in `src/lib/icons/` (W1-ICONS). Call sites keep importing named components (`CloseIcon`, `SettingsIcon`, …) from `src/lib/icons`, so wave 1 changes no call sites.

| File | Contents |
|---|---|
| `types.ts` | `SEMANTIC_ICON_NAMES`: the 111 names of today (`types.ts:11-158`) plus 12 new ones in a "Layout and chrome" group (5.3), 123 in all. `SemanticIconName`. `IconProps { size?: number; className?: string; style?: CSSProperties; compact?: boolean; title?: string; stroke?: number }` (`stroke` is kept for compatibility and ignored by fill-based packs). `IconPackId = "codicons" \| "lucide" \| "tabler" \| "phosphor" \| "fluent" \| "material"`. `ICON_PACKS: ReadonlyArray<IconPackInfo>` with `{id, label, description, license, packageName, version}`. The old `IconTheme` type and `THEME_ICON_DEFAULTS` (`types.ts:176-189`) stay only as a deprecated shim until W4-CLEANUP. |
| `store.ts` | zustand `useIconPackStore: {pack, mapping, status}`; `setIconPack(id)`. Loads are lazy and cached. A request counter drops a load that finishes after a newer request (fixes the pack-switch race [V critic]). Module-level listeners: `conduit:theme-change` with `detail.iconPack`, and `window` `storage` events for key `conduit-icon-pack` (the overlay and picker windows). Replaces `theme-store.ts`, which reads `conduit-platform-theme` (`theme-store.ts:20`). |
| `loader.ts` | `loadIconPack(id)` (dynamic `import()` per pack, cached), `preloadAllIconPacks(): Promise<void>` (loads the five lazy packs, used by the Appearance tab, 5.7), `getPackMapping(id): IconMapping \| null` (a loaded pack's mapping, `null` until loaded) and `bootIconPack()`. Boot reads `localStorage["conduit-icon-pack"]` (after the boot migration, 6.3), sets Codicons synchronously (statically imported) and starts the lazy load of any other pack. The deprecated `loadIconPack(theme: IconTheme)` overload maps `default → tabler`, `macos → phosphor`, `windows → fluent`, `ubuntu → tabler` until W1-TOKENS removes its callers. |
| `create-themed-icon.ts` | `createThemedIcon(name)`: a memo component that renders `mapping[name]` with `size` (default 16), `className`, `style` and `compact`. Icons are decorative by default (`aria-hidden="true" focusable="false"`); with `title` they render `role="img" aria-label={title}`. |
| `Icon.tsx` | `<Icon name={SemanticIconName} size compact className pack? />` for data-driven places (menus, status bar, activity bar). With `pack` it renders from that pack's mapping (`getPackMapping`), falling back to the active pack until the pack has loaded; the Appearance tab's preview strips use it. |
| `serialize.ts` | `iconToSvg(name, size = 16): string` for native popup menus. Renders into a detached `div` with `createRoot` + `flushSync` and returns the `<svg>` markup, cached per `pack:name:size`, with the cache cleared on pack change. |
| `licenses.ts` | License metadata for the Licenses view (5.8) and the pack cards. |
| `index.ts` | The 111 existing named exports plus `MenuIcon`, `PanelLeftIcon`, `PanelLeftOffIcon`, `PanelRightIcon`, `PanelRightOffIcon`, `SplitHorizontalIcon`, `SplitVerticalIcon`, `EllipsisIcon`, `CollapseAllIcon`, `AccountIcon`, `ExplorerIcon`, `CircleFilledIcon`, plus `Icon`, `useIconPackStore`, `setIconPack`, `bootIconPack`, `preloadAllIconPacks`, `getPackMapping`, `iconToSvg`, `ICON_PACKS`. |
| `packs/*` | `codicons.tsx` and `material.tsx` (adapters over generated data), `lucide.ts`, `tabler.ts` (renamed from `default.ts`), `phosphor.ts` (from `macos.ts`; also fixes `playerStopFilled: wrap(Stop)` to `wrap(Stop, "fill")`, `macos.ts:254`), `fluent.ts` (from `windows.ts`). `ubuntu.ts` (an alias of the Tabler mapping, `ubuntu.ts:11-14`) is deleted. |
| `generated/codicons.ts`, `generated/material.ts` | Checked-in generator output. Each maps a semantic name to `{ w, h, nodes, compact? }`, where `nodes` is a tree of `{ tag: "path" \| "g", attrs }` holding only `d`, `fill`, `fill-rule`, `clip-rule`, `transform` and `opacity`. The adapter renders `<svg viewBox="0 0 w h" width={size} height={size} fill="currentColor">` with `React.createElement`, never `dangerouslySetInnerHTML`. |

**Generator** `scripts/icons/generate-icon-packs.mjs` (`npm run icons:generate`, `--check` in tests):

1. Read the mapping source `scripts/icons/mapping.mjs` (semantic → Codicon name, Codicon compact name, Material name, Material fill flag).
2. Read `node_modules/@iconify-json/codicon/icons.json` and `node_modules/@iconify-json/material-symbols-light/icons.json`, resolving aliases. Per-icon `width`/`height` overrides are honored: `settings-gear`, `terminal` and `files` are 24×24 and every `-compact` glyph is 12×12 [V].
3. Tokenize each body with a strict parser that accepts only `<path …/>` and `<g …>…</g>` with the attributes above, and fail on anything else.
4. Emit only the glyphs the mapping uses, sorted, with a do-not-edit header. Emit `public/licenses/third-party-icons.txt` from each package's `LICENSE` file (5.8).

### 5.2 Delivery per pack

| Pack id | Label | Package and version | Delivery | License | Notes |
|---|---|---|---|---|---|
| `codicons` | Codicons (default) | `@iconify-json/codicon@1.2.73` | codegen, static | CC-BY-4.0 | D-1; 115 of 123 names are native Codicons, 8 have no Codicon and use Lucide glyphs (Appendix A.1) |
| `lucide` | Lucide | `lucide-react@1.48.0` | named imports, lazy chunk | ISC | `strokeWidth` 1.5 at 16px [ADAPT: Lucide's default 2 reads heavy next to Codicons] |
| `tabler` | Tabler (Classic) | `@tabler/icons-react` 3.38.0 installed (range `^3.36.1` kept) | existing pack, lazy chunk | MIT | stroke 1.5 as today (`types.ts:185`) |
| `phosphor` | Phosphor | `@phosphor-icons/react` 2.1.10 | existing pack, lazy chunk | MIT | weight `regular`, `fill` for filled names |
| `fluent` | Fluent | `@fluentui/react-icons` 2.0.321 | existing pack, lazy chunk | MIT | unsized `*Regular` / `*Filled` components as today (`windows.ts:120-133`) |
| `material` | Material Symbols | `@iconify-json/material-symbols-light@1.2.94` | codegen, lazy chunk | Apache-2.0 | `*-outline-rounded` glyphs, `*-rounded` for filled names (Appendix A.3) |

All six move to or land in **devDependencies** (D-2). The renderer is bundled by Vite and nothing under `electron/` or `mcp/` imports them [V grep]. Acceptance check: `npm ls --omit=dev --parseable` lists none of these packages.

**Size policy.** Icons render at the requested size. The approved sizes are 12, 16, 20, 24, 32 and 48. Codicons are drawn on a 16px grid, so 13, 14 and 15 look soft [V critic: 183 call sites use 14]. Wave-3 packages round 13 and 14 to 16, 18 to 16 or 20, and 10 and 11 to 12. W4-CLEANUP adds a test that fails on any other `size={n}` under `src/components/`, except custom entry icons (`iconRegistry.ts`), `EngineLogo` and one named exception: the 14px search icon of the title bar pill (`data-cv-command-center`, VS Code's value, 3.2). State dots are the 16px `circleFilled` glyph, which draws an 8px disc, never an 8px icon.

### 5.3 New semantic names

| Name | Used by | Codicons | Lucide | Tabler | Phosphor | Fluent | Material |
|---|---|---|---|---|---|---|---|
| `menu` | title bar menu button | `menu` | `Menu` | `IconMenu2` | `List` | `NavigationRegular` | `menu-outline-rounded` |
| `panelLeft` | layout control, side bar shown | `layout-sidebar-left` | `PanelLeft` | `IconLayoutSidebar` | `SidebarSimple` (fill) | `PanelLeftFilled` | `left-panel-close-outline-rounded` |
| `panelLeftOff` | layout control, side bar hidden | `layout-sidebar-left-off` | `PanelLeftDashed` | `IconLayoutSidebarInactive` | `SidebarSimple` | `PanelLeftRegular` | `left-panel-open-outline-rounded` |
| `panelRight` | layout control, AI shown | `layout-sidebar-right` | `PanelRight` | `IconLayoutSidebarRight` | `SidebarSimple` (fill) + `transform: scaleX(-1)` | `PanelRightFilled` | `right-panel-close-outline-rounded` |
| `panelRightOff` | layout control, AI hidden | `layout-sidebar-right-off` | `PanelRightDashed` | `IconLayoutSidebarRightInactive` | `SidebarSimple` + `transform: scaleX(-1)` | `PanelRightRegular` | `right-panel-open-outline-rounded` |
| `splitHorizontal` | split right | `split-horizontal` | `Columns2` | `IconLayoutColumns` | `SquareSplitHorizontal` | `SplitVerticalRegular` | `splitscreen-right-outline-rounded` |
| `splitVertical` | split down | `split-vertical` | `Rows2` | `IconLayoutRows` | `SquareSplitVertical` | `SplitHorizontalRegular` | `splitscreen-bottom-outline-rounded` |
| `ellipsis` | more actions | `ellipsis` | `Ellipsis` | `IconDots` | `DotsThree` | `MoreHorizontalRegular` | `more-horiz-outline-rounded` |
| `collapseAll` | tree collapse | `collapse-all` | `ChevronsDownUp` | `IconFold` | `ArrowsInLineVertical` | `ArrowMinimizeVerticalRegular` | `unfold-less-outline-rounded` |
| `account` | activity bar | `account` | `CircleUser` | `IconUserCircle` | `UserCircle` | `PersonCircleRegular` | `account-circle-outline-rounded` |
| `explorer` | activity bar Vault | `files` (24×24) | `Files` | `IconFiles` | `Files` | `DocumentMultipleRegular` | `files-outline-rounded` |
| `circleFilled` | tab state dot | `circle-filled` | `Circle` + `fill="currentColor"` | `IconCircleFilled` | `Circle` weight `fill` | `CircleFilled` | `circle-rounded` |

Every name above was checked against the installed or downloaded package [V: `lucide-react@1.48.0` exports; `@tabler/icons-react@3.38.0` `dist/esm/icons`; `@phosphor-icons/react@2.1.10` `dist/csr`; `@fluentui/react-icons@2.0.321` `lib/atoms/svg` typings; Iconify JSON for Codicons and Material]. The shown / hidden pairs follow VS Code: the Codicon, Phosphor `fill` and Fluent `Filled` glyphs draw the pane filled, the `-off` / regular glyphs draw it as an outline [V glyph paths]. Lucide and Tabler have no filled pane, so their hidden glyph is the dashed or inactive variant. Material Symbols names its glyphs by action, so the shown state uses `…-close` and the hidden state `…-open`.

Orientation is [A] for Fluent and Phosphor, whose names describe the divider line. In each pair above, the "horizontal" entry is side-by-side panes, matching Conduit's `splitPane(paneId, "horizontal")` = Split Right (`PaneTabBar.tsx:231-236`). W1-PRIMITIVES' gallery shows both glyphs for a visual check.

Full tables for all 123 names are in Appendix A.

### 5.4 Compact glyphs

36 of the 123 mapped names have a pixel-drawn 12×12 `-compact` Codicon [V], for example `close-compact`, `add-compact`, `chevron-down-compact`, `folder-compact` and `circle-filled-compact` (Appendix A.1). The Codicons adapter uses the compact glyph when `compact` is set or `size <= 12`. Other packs scale down.

Where to use `compact` (VS Code uses compact glyphs only in chat, chips and pickers [V]): `Button size="sm"`, `Badge` icons, chips in `ChatPanel` and the picker window's list rows. Tab close buttons, tree twisties, status bar and title bar icons stay at 16.

### 5.5 Loading in every window

- `src/main.tsx`, `src/overlay.tsx` and `src/picker.tsx` call `bootIconPack()` before `createRoot().render()` (W1-TOKENS owns these entry files). Today the overlay window never loads a pack [V critic].
- The overlay and picker windows follow pack changes through the `storage` event, as `OverlayApp.tsx:18-53` does for the theme.

### 5.6 Popup menu icons

- `PopupMenuItem.icon` becomes `SemanticIconName`. During migration, `src/utils/contextMenu.ts` also accepts the old keys and maps them:

  | Old key | Semantic name |
  |---|---|
  | `play` | `playerPlay` |
  | `edit`, `rename` | `pencil` |
  | `copy`, `copy-host` | `copy` |
  | `reconnect` | `refresh` |
  | `connect` | `plug` |
  | `folder-plus` | `folderPlus` |
  | `external-link` | `externalLink` |
  | `dots` | `ellipsis` |
  | `chevron-right` | `chevronRight` |
  | `star-off` | `star` |
  | `split` | `splitHorizontal` |
  | the rest | same name |

  W4-CLEANUP removes the old-key type.
- The helper sends `iconSvg: iconToSvg(name, 16)` per item. The main process sanitizes it (7.7) and sets the item `color`. Every pack draws with `currentColor` (Codicons, Material, Phosphor and Fluent fill it; Lucide and Tabler stroke it).
- This fixes the missing `split` icon (`PaneTabBar.tsx:175-176` passes `split`, which `menu.ts:23-49` lacks) and the hard-coded Tabler paths.
- W2-MENUS lands in wave 2, beside the packages whose menus pass semantic names (W2-TABS, W2-ACTIVITYBAR), so wave 2 never ships icon-less menus. Call sites may pass either old keys or semantic names until W4-CLEANUP converts the remaining old keys.

### 5.7 Settings UI for the pack

The Appearance tab (6.4) shows a `ChoiceGroup` of six `ChoiceCard`s in 3 columns.

- **Preview strip**: `folder`, `terminal`, `desktop`, `globe`, `key`, `search`, `settings`, `cloud` at 16px in `--c-ink-secondary`, `gap-2`, inside a `rounded bg-well p-2` well 32px tall. They are rendered from that card's pack with `<Icon name pack={id}>`, so the tab calls `preloadAllIconPacks()` on mount (both in 5.1, W1-ICONS).
- **Label**: the pack name, 12px/600. **Description**: 11px `text-ink-muted`, for example `VS Code icons · CC BY 4.0`.
- **Order**: Codicons, Lucide, Tabler (Classic), Phosphor, Fluent, Material Symbols.

A click previews the pack live (`conduit:theme-change` `{iconPack}`). Save persists it and Cancel reverts it.

### 5.8 Licenses view

`AboutDialog` (`src/components/about/AboutDialog.tsx`, W3-MISC) gains a `Button variant="link"` labeled `Third-party licenses`. It expands a section in the same dialog (size `md`):

- a list of the six packs from `licenses.ts`: name, version, license, copyright;
- a scrollable `<pre class="text-meta font-mono">` loaded with `fetch("./licenses/third-party-icons.txt")`. That file is generated into `public/`, which Vite copies to `dist/` (relative path, `vite.config.ts` `base: './'`).

The Codicons line reads: "Codicons © Microsoft Corporation, licensed under CC BY 4.0. Converted from SVG to React path data." That is the attribution and the change notice CC-BY requires. The Material Symbols entry includes the Apache-2.0 text.

### 5.9 Migration and custom icons

`platform_theme` maps to `icon_pack`: `macos → phosphor`, `windows → fluent`, `ubuntu → tabler`, anything else → `codicons` (OD-5, section 6.3). Custom entry icons stay Tabler (D-19, `iconRegistry.ts:81,208-213`).

---

## 6. Settings

### 6.1 Keys

| Key | Type | Default | Values | Read by |
|---|---|---|---|---|
| `color_scheme` | string | **`modern`** (was `ocean`, `settings.ts:119`) | `modern`, `ocean`, `ember`, `forest`, `amethyst`, `rose`, `midnight` | renderer; main (`backgroundColor`, 7.5) |
| `theme` | string | `system` (unchanged) | `dark`, `light`, `system` | renderer; main via `set-native-theme` (`main.ts:846-850`) |
| `icon_pack` | string | `codicons` | 6 pack ids | renderer |
| `ui_density` | string | `comfortable` | `comfortable`, `compact` | renderer; main (toast inset, 7.6) |
| `title_bar_style` | string | `custom` | `custom`, `native` | main at window creation (7.1) |
| `appearance_version` | number | `2` | | migration |
| ~~`platform_theme`~~ | removed | | | deleted by the migration |

The renderer mirrors appearance in `localStorage` so the first paint needs no IPC:

- `conduit-theme`
- `conduit-color-scheme`
- `conduit-icon-pack` (new)
- `conduit-density` (new)
- `conduit-appearance-version` (new)

`conduit-platform-theme` is removed. `title_bar_style` is not mirrored, because only the main process reads it. Unknown values fall back to the defaults in both paths.

Code locations:

- `AppSettings` and `defaultSettings`: `electron/ipc/settings.ts:63-148`.
- `Settings`: `SettingsHelpers.tsx:6-26`.
- The dialog's initial state: `SettingsDialog.tsx:42-60`.
- The `conduit:theme-change` detail becomes `{theme, colorScheme, iconPack, density}`: `SettingsDialog.tsx:89-93,111-119`.

### 6.2 Appearance runtime (replaces `useTheme`)

`src/lib/appearance/` (W1-TOKENS):

| File | Role |
|---|---|
| `boot-inline.js` | The pre-paint script (plain ES5). It migrates `localStorage` with `migration-table.json` (inlined), then sets on `<html>`: the `dark` or `light` class, `data-scheme` (always set, `modern` included), `data-density`, `data-os` (`macos`, `windows` or `linux`, from `window.electron.platform`, `preload.cts:4`, falling back to `navigator.userAgent`), `--c-zoom` (from `window.electron.zoomFactor()` when that function exists, 7.4, else `1`), and `--c-boot-bg` / `--c-boot-fg` from `shell-colors.json`. |
| `vite.config.ts` plugin | `conduitAppearanceBoot()` uses `transformIndexHtml` to replace the marker `<!-- conduit:appearance-boot -->` in `index.html`, `overlay.html`, `picker.html` and `gallery.html` with `<script>{boot-inline.js with JSON inlined}</script>`. It replaces the three hand-copied boot scripts (`index.html:7-17`, `overlay.html:7-26`, `picker.html:7-26`), which treat `ocean` as the default and set `data-os` only on Mac. [A] `transformIndexHtml` runs for every HTML entry in dev and build; the W1-TOKENS acceptance checks `dist/*.html`. |
| `useAppearance.ts` | Replaces `src/hooks/useTheme.ts` (the file becomes a re-export until W4). It applies changes from `conduit:theme-change`, follows `prefers-color-scheme` when `theme === "system"`, writes `localStorage`, sends `set-native-theme` (`useTheme.ts:97`), and dispatches `conduit:resolved-theme-change` (`useTheme.ts:25-27`, used by terminals). After it has set the attributes on `<html>`, in the same task, it dispatches `conduit:appearance-applied` with `{scheme, mode, density, iconPack}`: `src/lib/window-chrome.ts` sends the title bar colors from it (3.2) and `sidebarStore` updates `chromeWidth` from it (3.3). It never sends `window_chrome_update` itself. On mount it calls `settings_get` once and adopts the settings file's values when they differ from `localStorage` (the settings file wins; they differ only after the storage was cleared). |
| `migrate.ts` + `migration-table.json` | The renderer migration (6.3). |
| `shell-colors.json` | `{scheme: {dark: {shell, fg}, light: {shell, fg}}}` for the boot script, the splash and the main-process palette (7.5). |
| `resolveCssColor.ts` | 2.12. |

`src/lib/schemes.ts` keeps `COLOR_SCHEMES`, gains `modern` first, drops the six native entries and makes `DEFAULT_SCHEME = "modern"`. Each entry gets `preview: {dark: {shell, editor, sidebar, accent}, light: {…}}`, which the tokens test (2.1) checks against the resolved tokens. `src/lib/themes.ts` is deleted.

### 6.3 Migration (dual path, idempotent)

The same rules run in the main process on every settings read (`electron/services/appearance-migration.ts`, called from `readSettings()` at `settings.ts:157-201`) and in the renderer before first paint (`boot-inline.js` and `migrate.ts`).

**Every rule, the version check included, reads the raw stored values: in the main process the parsed file before defaults are spread over it.** `readSettings()` builds `{ ...defaultSettings, ...raw }` (`settings.ts:163`), and the new defaults include `appearance_version: 2` (6.1), so a check on the merged object would treat every legacy file as migrated and skip the whole migration. The main process calls `migrateAppearance(raw)` and applies its result to the merged settings: it sets the migrated keys and deletes `platform_theme`. The renderer reads `localStorage` directly.

1. If `raw.appearance_version >= 2`: validate only. An unknown scheme becomes `modern`, an unknown pack `codicons`, an unknown density `comfortable`. Stop.
2. `platform = raw.platform_theme ?? "default"`, `scheme = raw.color_scheme ?? "ocean"`.
3. `icon_pack = valid(raw.icon_pack) ? raw.icon_pack : PACK_BY_PLATFORM[platform] ?? "codicons"`.
4. `color_scheme = RETIRED[scheme] ?? (platform === "default" && scheme === "ocean" ? "modern" : scheme)`, then validate.
5. Delete `platform_theme`. Set `appearance_version = 2`. Fill `ui_density` and `title_bar_style` with defaults when missing.

| Before (platform, scheme) | After scheme | After pack | Rule |
|---|---|---|---|
| `default` or missing, `ocean` or missing | `modern` | `codicons` | untouched default (OD-5) |
| `default`, `ember` / `forest` / `amethyst` / `rose` / `midnight` | unchanged | `codicons` | kept |
| `macos`, `macos-blue` or `macos-graphite` | `modern` | `phosphor` | retired native scheme |
| `windows`, `win-blue` or `win-sun-valley` | `modern` | `fluent` | retired native scheme |
| `ubuntu`, `ubuntu-yaru` | `ember` | `tabler` | nearest universal scheme (warm orange) |
| `ubuntu`, `ubuntu-gnome` | `modern` | `tabler` | retired native scheme |
| `macos` / `windows` / `ubuntu`, a universal scheme (including `ocean`) | unchanged | per platform | "other choices keep their scheme" (OD-5) |
| any platform, a native scheme of another platform | as `RETIRED` | per platform | stale value after a platform switch |

- **Persistence.** When the main-process migration changes anything and `settings.json` exists, it writes the file back once (try/catch with a logged warning). The renderer's `localStorage` migration writes its keys and removes `conduit-platform-theme`.
- **Idempotence.** `migrate(migrate(x))` equals `migrate(x)`, checked with `fast-check` (already a devDependency) in both test suites.
- **Integration.** `electron/services/__tests__/appearance-migration.test.ts` writes legacy `settings.json` files to a temporary data dir (`macos` + `macos-blue`; `default` + `ocean`; a file with no appearance keys), calls `readSettings()` twice, and asserts the migrated values, exactly one write-back, and no write on the second read.
- **Parity.** The same test reads `src/lib/appearance/migration-table.json` with `fs.readFileSync` (never an import, 2.5) and compares it with the main-process table. A behavior test, `scripts/__tests__/appearance-migration-parity.test.ts`, runs `boot-inline.js` in jsdom, `migrate.ts` and the main-process migration on the same `fast-check` inputs and asserts equal outputs; it lives in `scripts/__tests__/` because it imports from both trees (2.5).
- **Downgrade.** An older build reading `color_scheme: "modern"` finds no CSS for it and shows its default look. The older build also treats a missing `platform_theme` as default. This is acceptable and noted in section 9.

### 6.4 Appearance tab

W1-TOKENS makes the minimal edit that keeps the build green: it removes the Platform Theme block (`AppearanceTab.tsx:46-122`) and the native-scheme block (`128-161`), and lists the 7 schemes. W3-SETTINGS builds the final tab from primitives, top to bottom:

| Section (`data-cv-appearance=`) | Control | Details |
|---|---|---|
| `scheme`: "Color scheme" | `ChoiceGroup`, 4 columns, 7 `ChoiceCard`s, Modern first | Preview 48px tall: a `shell` background holding an 8px-radius `editor` rectangle and a `sidebar` strip, plus a 12px `accent` bar, from `COLOR_SCHEMES[i].preview[mode]`; label below. Replaces `SchemeCard` |
| `mode`: "Mode" | `SegmentedControl`: Dark, Light, System | replaces "Brightness" (`AppearanceTab.tsx:185-209`) |
| `icon-pack`: "Icon pack" | `ChoiceGroup`, 3 columns, 6 cards | 5.7 |
| `density`: "Density" | `SegmentedControl`: Comfortable, Compact | description: "Compact removes the gaps and rounded corners between panels." |
| `scale`: "UI scale" | the existing slider and Reset (`AppearanceTab.tsx:211-237`, `249-299`) | restyled only; zoom sync unchanged (`AppearanceTab.tsx:8-29`) |
| `title-bar`: "Title bar" | `RadioGroup`: Custom (recommended), Native | note "Restart Conduit to apply."; `Button sm` "Restart now" (`invoke('app_relaunch')`, as `App.tsx:369`), enabled only when the choice differs from `window_chrome_get_state().style` |

Every control previews live through `conduit:theme-change`, except the title bar. **Save** persists all of them (`SettingsDialog.tsx:78-106`). **Cancel** reverts scheme, mode, pack, density and zoom (`SettingsDialog.tsx:108-124`). Choice cards carry `data-cv-choice="{id}"`.

---

## 7. Main process

### 7.1 BrowserWindow options

A new `electron/services/window-chrome/options.ts` exports `titleBarOptions(settings, env, platform, osRelease)`, `zoomOptions(settings)` and `shellColor(settings, prefersDark)`. `createWindow()` (`main.ts:676-723`) spreads them into the constructor:

| | macOS | Windows | Linux |
|---|---|---|---|
| `titleBarStyle` | `'hidden'` | `'hidden'` | `'hidden'` |
| Window buttons | `trafficLightPosition: {x: 11, y: 10}` when Darwin major ≥ 25, else `{x: 10, y: 9}` [V VS Code formula, 3.2] | `titleBarOverlay: {color: shell, symbolColor: fg, height: 34}` [V `height − 1`] | same as Windows |
| Menu bar | OS menu bar | none: a frameless window gets no menu bar, but the application menu's accelerators stay registered [V Electron `root_view.cc:52-56`] | same |
| Sheets | `setSheetOffset(isTahoe ? 32 : 28)` [V VS Code] | n/a | n/a |
| Zoom | `webPreferences.zoomFactor: clamp(settings.ui_scale, 0.75, 1.5)`, `webPreferences.zoomMode: 'isolated'` | same | same |
| `backgroundColor` | `shellColor()` from `settings.color_scheme` + `theme` (with `nativeTheme.shouldUseDarkColors` for `system`), replacing `'#0f172a'` (`main.ts:711`) | same | same |
| Native mode | none of the title bar options; the frame as today | same | same |

**Zoom.** The `ready-to-show` handler no longer calls `setZoomFactor` (`main.ts:725-733`): the zoom is part of the window's creation options, so the first paint and the renderer's first `get-zoom-factor` already see it [V Electron 44.4.5 `electron_api_web_contents.cc:1044-1066`: with `zoomMode: 'isolated'` the factor is applied at the first navigation]. `'isolated'` keeps the zoom on the main window's own `WebContents`. In the default mode Chromium stores zoom per host, and in development `index.html`, `overlay.html` and `picker.html` all load from the same Vite host, so a 150% app zoom would also zoom the toast overlay and the picker (a 450px toast would become 675 DIP in a 458 DIP window) [V `web_contents_zoom_controller.cc:104-123`; `electron.d.ts` notes zoom is same-origin by default]. The overlay (`overlay-manager.ts`) and picker (`main.ts:276-294`) windows get `zoomMode: 'isolated'` too. Live changes keep `set-zoom-factor` (`main.ts:853-858`).

**`frame`.** VS Code also sets `frame: false` on Windows and Linux [V `main.js`: `c.titleBarStyle="hidden",V||(c.frame=!1)`]. Conduit does not need to: `titleBarStyle: 'hidden'` alone already makes the window frameless (`has_frame_ = frame && title_bar_style == kNormal` [V Electron `native_window.cc:104-105`]), so a double frame cannot happen, and the `titleBarOverlay` option docs pair it with `titleBarStyle` (`electron.d.ts:4040-4053`).

**Linux display server (D-26).** Before `app` is ready, `main.ts` appends `--ozone-platform=x11` on Linux unless `process.env.CONDUIT_OZONE === "wayland"` or the command line already names an ozone platform. Because the ozone platform may be chosen before the main script runs [A], the dependable path is the launcher: W2-MAIN adds `executableArgs: ["--ozone-platform=x11"]` to the `linux` section of `electron-builder.yml`, which puts the flag on the `Exec` line of the AppImage and deb desktop entries [A: check the built `.desktop` file]. Under XWayland, Conduit keeps the X11 behavior every earlier release had, including absolute positions for the popup menus, the toast overlay and the picker.

**Help menu escape hatch (D-8(2)).** On Windows and Linux in custom mode the Help menu gains `Use Native Title Bar`, after `What's New`. It writes `title_bar_style: "native"` with `writeSettings()` and runs `app.relaunch(); app.quit()`, as the `app_relaunch` handler does (`settings.ts:267-270`). It reaches users whose title bar does not work: the menu still opens with F10 or Alt (3.2), and the accelerators keep working.

**Style selection.** `style = process.env.CONDUIT_TITLE_BAR === "native" || settings.title_bar_style === "native" ? "native" : "custom"`. The value is read once at creation, so a change needs a restart (6.4).

Minimum size (1024×700), bounds restore and the tray behavior are unchanged (`main.ts:676-772`).

### 7.2 Title bar color sync

IPC `window_chrome_update` (renderer → main, `invoke`), registered in the new `electron/ipc/window-chrome.ts`. Its only sender is `src/lib/window-chrome.ts` (3.2):

```ts
{ shell: string; fg: string; density: "comfortable" | "compact" }   // colors must match /^#[0-9a-f]{6}$/i
```

The main process ignores invalid payloads and unchanged values. Otherwise:

- `win.setBackgroundColor(shell)`;
- when `overlayActive` is true, `win.setTitleBarOverlay({color: shell, symbolColor: fg, height: 34})` inside `try`/`catch`;
- `overlayManager.setBottomInset(...)` (7.6).

`overlayActive` is recorded when the window is created: `style === "custom" && platform !== "darwin"`. `setTitleBarOverlay` exists on win32 and linux only (`electron.d.ts:3570-3579`) and throws when the window has no overlay (`"Titlebar overlay is not enabled"`) or a color does not parse [V Electron `native_window_views.cc:495-523`]. On the first throw the handler logs one warning, sets `overlayActive = false`, sends `window-chrome:state` with `overlayActive: false` (the renderer then shows the HTML caption buttons, 3.2) and still resolves. Today only `nativeTheme.themeSource` is synced (`main.ts:846-850`); that stays.

### 7.3 Application menu popup

- **`window_chrome_app_menu`** `{x, y}` in CSS px (finite, clamped to the content size). The main process runs `Menu.getApplicationMenu()?.popup({ window: win, x: Math.round(x * zf), y: Math.round(y * zf) })`, where `zf = webContents.getZoomFactor()`. `popup` coordinates are relative to the window's content area, in DIP [V Electron `electron_api_menu_views.cc:43-50` adds them to `GetContentBounds().origin()`]. On macOS it does nothing. The native menu keeps every item, the dynamic "Restart to Update" label (`main.ts:648-651`) and the accelerator hints, and the harness's `clickMenuItem` (`ui-forms.mjs:126-142`) keeps working because the application menu stays set (`main.ts:672-673`).
- **Accelerators.** No fallback code. With the frame gone, Electron still registers every menu accelerator (Ctrl+O, Ctrl+S, F1 and the rest) with the window's focus manager and runs keys the page does not handle through it [V `root_view.cc:52-56`, `native_window_views.cc:2077-2078`], the same path as today's visible menu bar. 8.7 keeps a smoke check.
- **F10 and Alt** open this popup from the renderer (3.2), because a frameless window has no menu bar to focus.

### 7.4 Window state

- `window_chrome_get_state` → `{platform, style, isTahoe, isFullScreen, isMaximized, overlayActive}`.
- Event `window-chrome:state` → `{isFullScreen, isMaximized, overlayActive}` on `enter-full-screen`, `leave-full-screen`, `maximize` and `unmaximize`, and when `setTitleBarOverlay` fails (7.2).
- `window_chrome_control` `{action: "minimize" | "maximize" | "unmaximize" | "close"}` for the fallback caption buttons. `close` calls `win.close()`, so today's hide-to-tray handler still runs (`main.ts:751-772`).
- `ready-to-show` only shows the window; the zoom is already set (7.1).
- **Preload.** `electron/preload.cts` gains `zoomFactor: () => webFrame.getZoomFactor()` (synchronous) on the `window.electron` bridge, and `src/types/ipc.d.ts` declares it. `boot-inline.js` uses it when present (6.2); `get-zoom-factor` stays as the fallback. The rest of the bridge is unchanged (`preload.cts:3-23`).
- **Web session views.** On every `dom-ready`, `setupTabEventHandlers` inserts the user-origin `no-drag` stylesheet (D-27, 3.7).

### 7.5 Background color and splash

- `electron/services/window-chrome/palette.ts` holds the `{shell, fg}` table below. A test checks it against `src/lib/appearance/shell-colors.json`, and the tokens test (2.1) checks the JSON against the resolved `--c-shell` and `--c-titlebar-fg`.

| Scheme | Dark shell / fg | Light shell / fg |
|---|---|---|
| modern | `#191A1B` / `#8C8C8C` | `#FAFAFD` / `#606060` |
| ocean | `#1e293b` / `#8B98AA` | `#f8fafc` / `#677388` |
| ember | `#1a1210` / `#888078` | `#fffbf5` / `#7D7367` |
| forest | `#12231a` / `#7E8F87` | `#f2faf5` / `#60776B` |
| amethyst | `#1a1430` / `#878296` | `#f8f5ff` / `#736E8B` |
| rose | `#221418` / `#8E8087` | `#fef5f6` / `#856B74` |
| midnight | `#0a1418` / `#748289` | `#f4fafc` / `#5F7681` |

- **Splash** (`index.html:18-53`): `#splash { background: var(--c-boot-bg) }`, spinner border `var(--c-boot-fg)`. It replaces `#0f172a`, `#f8fafc` and the sky-blue spinner, so the window, splash and first frame share one color.

### 7.6 Toast overlay and picker windows

- **Toast overlay** (`electron/services/overlay/overlay-manager.ts`):
  - `OVERLAY_WIDTH` 400 → **458** (a 450 toast plus 2 × 4 padding; D-24), height 500 unchanged (`overlay-manager.ts:33-35`). The window gets `webPreferences.zoomMode: 'isolated'` (7.1).
  - `computeOverlayBounds()` (`133-138`) becomes `x = cb.x + cb.width − 458 − 4` and `y = cb.y + cb.height − 500 − bottomInset`. With the page's 4px padding, a toast's right edge sits 8px from the content edge, as in VS Code [V Modern `.notifications-toasts {right: calc(8px - 4px)}` plus the toast's `margin: 4px`].
  - `setBottomInset(dip)` defaults to `round(28 × zf) + 4`; the renderer's `window_chrome_update` sets it from the density: `round(statusBarHeight × zf) + 8 − 4`, with `statusBarHeight` 28 in Comfortable and 26 in Compact (main-process constants, 2.5). A toast's bottom edge then sits 8px above the status bar, as in VS Code [V `bottom: calc(36px - 4px)` + 4px margin over a 28px status bar].
  - `OverlayApp.tsx:92` changes `p-4 gap-2` to `p-1 gap-1` (W3-OVERLAY, 4.15).
- **Picker window** stays 380×500 (`main.ts:255-256`), gets `webPreferences.zoomMode: 'isolated'` (7.1) and keeps its drag header (`CredentialPickerApp.tsx:114-117`); W3-PICKER restyles it.

### 7.7 Popup menu window restyle (`electron/ipc/menu.ts`, W2-MENUS)

| Property | Today | New | Source |
|---|---|---|---|
| Width | 210 fixed (`menu.ts:111`) | 220 fixed | [ADAPT] the child window is sized before render; VS Code's min 160 plus auto width is not possible |
| Row | 30 (`padding:5px 12px`, 13px/20px, `menu.ts:292-294`) | 24: `height:24px; margin:0 4px; padding:0 8px; border-radius:6px; gap:8px; font:13px/24px` | [V] item 24, radius 6 |
| Separator | 9 (`margin:4px 8px`) | 11: 1px line, `margin:5px 0` | [V] |
| Header | 24, 10px/600 uppercase | 24, 11px/600, no uppercase, `--c-ink-muted` | [ADAPT] Modern UI drops uppercase |
| Container | radius 8, `padding:4px 0`, 1px border, `box-shadow:0 4px 24px` | radius 8, `padding:4px 0`, 1px `overlayBorder`, `box-shadow:0 0 12px rgba(0,0,0,.14)`; the window gains a transparent margin `M = 12` on every side for the shadow (geometry below) | [V] `--vscode-shadow-lg` |
| Font | `Inter, system-ui` (`menu.ts:291,297`) | `-apple-system, BlinkMacSystemFont, "Segoe WPC", "Segoe UI", system-ui, Ubuntu, sans-serif` | OD-6 |
| Text | `ink` | `inkSecondary` for items, `inkMuted` for headers and icons | [V] 2026 `menu.foreground` `#bfbfbf` / `#202020` |
| Selection | bg `raised` | bg `selectionBg` + 1px inset `selectionBorder` | [V] 2026 menu selection |
| Danger | `#f87171` and a 12 to 15% tint | `danger` text, `dangerHover` (`--c-menu-danger-hover-bg`) behind the active danger item | 2.2.3 |
| Icons | 25 inline Tabler paths (`menu.ts:23-49`) | `iconSvg` from the renderer after `sanitizeSvg()` | 5.6 |
| Keyboard | Escape only (`menu.ts:302`) | Up, Down, Home, End (skipping separators and headers), Enter, Space, Right (open submenu), Left (close submenu), Escape | |

- **Colors.** The payload `colors` becomes `{overlay, overlayBorder, inkSecondary, inkMuted, selectionBg, selectionBorder, danger, dangerHover, divider}`, resolved from `--c-overlay`, `--c-overlay-border`, `--c-ink-secondary`, `--c-ink-muted`, `--c-menu-selection-bg`, `--c-menu-selection-border`, `--c-danger`, `--c-menu-danger-hover-bg` and `--c-divider`. The renderer resolves every value to `#rrggbb` with `resolveCssColor` (alpha flattened over `--c-overlay`). The main process validates each value with the hex regex and falls back to the built-in Modern values.
- **Geometry with the shadow margin.** The visible menu must stay at the click point. With `M = 12`, the main process computes the visible menu rect first (`x`, `y` from the click as today, `menuWidth`, `menuHeight` without any buffer), flips and clamps that rect against the display work area (if `x + menuWidth > right`, `x -= menuWidth`; if `y + menuHeight > bottom`, `y -= menuHeight`; in `anchorRight` mode, `x -= menuWidth`), and only then creates the window at `(x − M, y − M)` with size `(menuWidth + 2M, menuHeight + 2M)` (submenu layouts add `2M` to their width and height the same way). Today's 12px `buffer`, added to the height only (`menu.ts:118-131`), goes.
- **Clicks in the margin dismiss.** A transparent window is not click-through, so a click in the margin lands in the popup and would neither blur it nor reach the app. The page adds `document.addEventListener('mousedown', e => { if (!e.target.closest('.m, .sm')) console.log('__MENU__:dismiss') }, true)`, and the main process resolves anything that is not a valid item index as `null` and closes the popup.
- **Wayland.** Absolute window positions need X11 or XWayland; D-26 keeps Linux on XWayland this release.
- **Injection fix.** Labels are HTML-escaped (`& < > " '`). Ids must match `^[A-Za-z0-9_:.-]{1,64}$`; items with other ids are dropped with a warning. The page reports a **flattened item index** (`__MENU__:<n>`) instead of the id, and the main process maps the index back to the id. That closes today's latent injection through labels and ids (`menu.ts:214-231,286-299`).
- **`sanitizeSvg(svg)`** lives in the new `electron/ipc/menu-svg.ts`. It is an allowlist parser:
  - elements: `svg`, `g`, `path`, `circle`, `ellipse`, `line`, `polyline`, `polygon`, `rect`;
  - attributes: `xmlns`, `viewBox`, `width`, `height`, `d`, `fill`, `fill-rule`, `clip-rule`, `stroke`, `stroke-width`, `stroke-linecap`, `stroke-linejoin`, `cx`, `cy`, `r`, `rx`, `ry`, `x`, `y`, `x1`, `y1`, `x2`, `y2`, `points`, `transform`, `opacity`, `fill-opacity`, `stroke-opacity`;
  - it drops any other attribute and returns `null` on any other element or on text content;
  - size limit 8 KB per icon.

---

## 8. Tests and harness

### 8.1 Unit and component tests

Every package adds or updates the tests below. The runner is vitest (`vitest.config.ts`, jsdom, setup in `src/test/setup.ts`). Main-process tests use `// @vitest-environment node`.

| Package | Test files | What they check |
|---|---|---|
| W1-ICONS | `src/lib/icons/__tests__/{registry,store,serialize}.test.tsx`, `scripts/__tests__/icon-packs.test.ts` | every pack maps all 123 names and each renders one `<svg>`; `preloadAllIconPacks` loads the five lazy packs and `<Icon pack>` renders from the named pack; decorative by default, `role="img"` with `title`; fast pack switches end on the last request; `storage` and `conduit:theme-change` events switch packs; `iconToSvg` returns `<svg…` and resets on pack change; the generator's `--check` is clean; the body parser rejects `<script>`, `<use>`, `<foreignObject>`, `on*` and `href` |
| W1-TOKENS | `src/styles/__tests__/tokens-cascade.test.ts`, `src/lib/appearance/__tests__/{migrate,boot-inline,resolveCssColor,useAppearance}.test.ts`, `electron/services/__tests__/appearance-migration.test.ts`, `scripts/__tests__/appearance-migration-parity.test.ts`, `src/lib/__tests__/terminalTheme.test.ts` | the 5 cascade assertions and every contrast gate in 2.11 with exact `color-mix()` evaluation; the selected-row re-scope redeclares both `--c-*` and `--color-*`; every 6.3 table row; the version check reads raw values (a legacy file still migrates although the defaults hold `appearance_version: 2`); temp-dir `readSettings()` integration: migrated values, one write-back, none on the second read; `fast-check` idempotence; JSON table parity (read with `fs`); behavior parity of `boot-inline.js`, `migrate.ts` and the main migration; the boot script sets class, attributes and `--c-zoom` and migrates `localStorage` in jsdom; `conduit:appearance-applied` fires after the attributes change; `rgb()`, `rgba()` and `color(srgb …)` parsing and alpha compositing; settings-file reconciliation; the terminal theme gets hex colors |
| W1-FREEZE | `src/lib/native-freeze/__tests__/registry.test.ts`, `src/hooks/__tests__/useNativeViewVisibility.test.tsx`, `src/components/sync/__tests__/SyncDialogFrame.freeze.test.tsx` | counting, idempotent release, release on unmount, batched notifications, the legacy event bridge; frozen → `web_session_capture_and_hide`, thawed → `web_session_show`; mounting `SyncDialogFrame` alone (no Settings, no App overlay flag) makes `isFrozen()` true |
| W1-PRIMITIVES | `src/components/ui/__tests__/*.test.tsx`, `scripts/__tests__/legacy-classes.test.ts` | roles and ARIA; keyboard (Escape reaches only the top layer, Tab is trapped, arrows in SegmentedControl, Tabs, NavList, Menu and ChoiceGroup); harness markup: `FormField` nesting, the `Checkbox` and `Radio` labels, `Dialog` with `data-dialog-content` + `h2` + footer as last child + `aria-label` only with `harnessLabel`; a `Dialog` with `onSubmit` where `[data-dialog-content] form button[type=submit]` matches a visible submit; `portal={false}` renders in place; `data-cv-layer`, `data-cv-error`; `Button loading` keeps a visible label; `Spinner text` renders visible text; `Menu` items are `button[role=menuitem]`; clickable `ListRow` is a `<button>` and its trailing actions hide with opacity only; focus offsets (-1px default, 2px on `Button`, checkbox and radio); a freeze is held while a `Dialog` is mounted; the legacy report finds the 4.16 patterns only in class strings |
| W1-HARNESS | `scripts/__tests__/verify-selectors.test.ts`, `scripts/__tests__/check-owns.test.ts` | every selector pair in `selectors.mjs` resolves on old-markup and new-markup jsdom fixtures; mixed fixtures, where a hooked element sits next to a nearer or earlier element that carries the legacy class, resolve to the hooked element (scope-level `pickSelector`, 8.2); `openDialogs` ignores unlabeled dialogs; `check-owns.mjs` flags a path outside `owns` |
| W2-MAIN | `electron/services/window-chrome/__tests__/{options,palette}.test.ts`, `electron/ipc/__tests__/window-chrome.test.ts`, `electron/services/web/__tests__/manager.chrome.test.ts`, `scripts/__tests__/window-chrome-parity.test.ts` | options per platform, OS release, env and style; traffic lights `{11,10}` / `{10,9}`; overlay height 34; `zoomFactor` clamped and `zoomMode: 'isolated'` for the main, overlay and picker windows; the Linux ozone switch and its `CONDUIT_OZONE` opt-out; palette equals `shell-colors.json` (read with `fs`); payload validation; `setTitleBarOverlay` only while `overlayActive`, and a mocked throw flips `overlayActive`, emits `window-chrome:state` and still resolves; popup coordinates × zoom; overlay bounds with width 458 and the bottom inset; `setBorderRadius` on every attached view (new sub-tab, switch, show) when the value differs, never for WebView2, and a radius-only change passes the unchanged-bounds check; the `no-drag` stylesheet is inserted on `dom-ready` with `cssOrigin: 'user'`; the toast inset constants equal `metrics.ts` |
| W2-TITLEBAR | `src/components/shell/titlebar/__tests__/TitleBar.test.tsx`, `src/lib/__tests__/window-chrome.test.ts` | the minimal variant has `textContent === ""`; the pill has no `title`; macOS reserve 70, 0 in full screen; leading and trailing reserves from mocked rects at zoom 1 and 1.5, including a left-side layout (Linux) and a mirrored one (Windows RTL); clamping and the `0 / 138` fallback; the fallback caption buttons follow `overlayActive`, `visible` and full screen and re-evaluate on each event; layout controls swap `panelLeft`/`panelLeftOff` and keep `aria-pressed`; no store imports (props only); drag and no-drag classes; `--c-zoom` and `useZoomFactor` updates; one debounced `window_chrome_update` per `conduit:appearance-applied`, and a rejected invoke is ignored |
| W2-ACTIVITYBAR | `src/components/shell/activitybar/__tests__/ActivityBar.test.tsx` | item titles (Appendix B, B16); pressed states from `sidebarStore`; roving focus; hover and active icon colors; Home calls `openHomeTab` |
| W2-SIDEBAR | `SidebarPanel.test.tsx`, `sidebarStore.test.ts` (both updated), `src/components/entries/__tests__/EntryTree.roles.test.tsx`, `src/components/layout/__tests__/openHomeTab.test.ts` | docked vs floating markup; the scrim only over the workbench; `spareWidth` with `chromeWidth`; `chromeWidth` follows `conduit:appearance-applied` in the same task; `favoritesOnly` persisted; tree roles, `aria-level`, arrow keys, the empty twistie slot on leaves, indent guides on hover, the rename input; `openHomeTab` keeps today's behavior (moved verbatim) |
| W2-TABS | `src/components/layout/__tests__/PaneTabBar.test.tsx`, `src/lib/layout/__tests__/contentArea.test.ts`, `src/components/layout/tabs/__tests__/webViewRadius.test.ts`, `src/components/sessions/__tests__/RdpView.resize.test.tsx` | tab roles; `data-state` only when not connected; close visibility; inactive-tab hover color; editor actions at 50% in an unfocused pane; drop marker; semantic menu icons; split separators stay 4px in flow; fallback size math; the radius decision (7, 0, square-left, square-right) for every density, engine and corner case, and the radius in the de-duplication key; one `rdp_resize` per layout change (debounce, last-requested check, single retry) |
| W2-STATUSBAR | `src/components/shell/statusbar/__tests__/StatusBar.test.tsx` | visibility rules per store state; the review item keeps its `title` and `data-cv-review-button`; hover and pressed colors; the state dot is the 16px `circleFilled`; the zoom item follows `useZoomFactor`; no `role="status"`; no text breaks the rules in 8.4 |
| W2-AI | `src/stores/__tests__/auxBarStore.test.ts` | persistence, clamping, the published `rightPanelWidth` (width + 4) |
| W2-MENUS | `electron/ipc/__tests__/{menu,menu-svg}.test.ts`, `src/utils/__tests__/contextMenu.test.ts` | label escaping; id validation; index-to-id mapping; the window rect equals the visible menu rect grown by 12 on each side, and the flip and clamp use the visible rect; a margin click resolves to `null`; the SVG allowlist rejects `script`, `on*`, `href`, `style`, `foreignObject` and more than 8 KB; old keys map; colors are hex and include `inkSecondary` and `dangerHover` |
| W2-WORKBENCH | `src/App.test.tsx` (fixed), `src/components/shell/__tests__/{Workbench,BannerStack,chromeText}.test.tsx`, `src/hooks/__tests__/useKeyboardShortcuts.test.ts` | the whole suite is green; density sets gaps, in-flow sashes and dividers; banners keep `role="status"` and `span.flex-1`, and their actions are link buttons with exact labels; chrome text rules (8.4) on a fully rendered workbench; Ctrl/Cmd+P, Ctrl/Cmd+Alt+B via `e.code`; F10 and a lone Alt open the application menu only on win32/linux custom and never inside `[data-session-keyboard]` |
| W3-* | the tests already in each directory stay green (for example `src/components/sync/__tests__/*` query `[role=dialog]` and ARIA labels) | wherever a component moves to a primitive, its test asserts the Appendix B hook; busy texts stay visible (B35) |
| W4-HARNESS | `scripts/__tests__/verify-harness.test.ts` (updated), `verify-selectors.test.ts` (fallbacks removed) | `all` skips opt-in suites; naming `appearance` runs it |
| W4-CLEANUP | `src/components/__tests__/icon-sizes.test.ts`, `src/components/__tests__/overlay-freeze.test.tsx` | no icon size outside 12, 16, 20, 24, 32, 48 under `src/components/` (except custom entry icons, `EngineLogo` and the named 14px pill icon); each of the 24 overlays that `App.tsx:389` lists today mounts with minimal props and makes `isFrozen()` true with the legacy hold removed |

### 8.2 Harness hook contract

The harness reads the UI through `page.evaluate` DOM queries (`scripts/verify/lib/ui.mjs:84-135`). The full list of dependencies is in Appendix B. The rollout has three steps, so no single migration package can break a run:

1. **Wave 1 (W1-HARNESS)** turns each class-based selector into a pair of the old selector and the new `data-cv-*` hook (`selectors.mjs`), resolved by a scope-level `pickSelector(scope, hook, legacy)`: if any element inside the scope carries the hook, only the hook is used; otherwise only the legacy selector. A comma union is never passed to `querySelector` or `closest()`: `querySelector` returns the first match in document order and `closest()` the nearest ancestor that matches either part, so after a restyle an unrelated element with the legacy class (a `rounded-md` Card, the first `<span>`, a `span.block` field label) could win over the hooked one (B5, B11, B18, B20, B21, B23, B24). Where the code today calls `el.closest(sel)`, it becomes `pickSelector` on the ancestor chain: the nearest ancestor with the hook if one exists in the scope, else `closest(legacy)`. The "Union (wave 1)" column of Appendix B lists the two alternatives this helper chooses between.
2. **Waves 2 and 3** add the hooks on the markup, owned by the package that owns the file (Appendix B, "Hook added by").
3. **Wave 4 (W4-HARNESS)** deletes the old alternatives.

### 8.3 Dialog detection

`openDialogs()` (`flows.mjs:43-48`) and `dialogDetails()` (`sync-flows.mjs:16-22`) list every visible `[role=dialog]` by its `aria-label`. `waitForUnlockOutcome()` returns `{outcome: 'dialog'}` as soon as any listed dialog is visible (`flows.mjs:94-96`).

Today only the sync dialogs carry `role="dialog"` (`SyncDialogFrame.tsx:53-55`, `ConflictReviewPanel.tsx:89-91`). The `Dialog` primitive gives **every** dialog `role="dialog"`, which OD-10 needs. Without a harness change, the unlock dialog itself would count as an open "dialog" and every unlock would be misreported.

Fix, in wave 1:

- both functions query `[role=dialog][aria-label]`;
- the `Dialog` primitive names ordinary dialogs with `aria-labelledby` and sets `aria-label` only when `harnessLabel` is passed, which only the sync-style shells do (4.8);
- the scoped clicks at `sync-flows.mjs:72,88,98` narrow the same way (B10);
- `waitForUnlockOutcome()` reports `{outcome: 'unlocked'}` only once `sync_get_state().vault` names the vault, not as soon as `vault_is_unlocked` is true: that turns true when the working copy opens, before the unlock cycle and the device lease finish (`flows.mjs:93-96`, tested in `scripts/__tests__/verify-sync-flows.test.ts`).

### 8.4 Text rules for permanent chrome

Permanent chrome means the title bar, activity bar, status bar, side bar part title and layout controls.

1. No button's visible text may **equal** `Review`, `Use here instead`, `Lock Current Vault`, `New Vault`, `Not Now` or `Open Vault File`. The harness clicks those with `selector: 'button'` and takes the first match in DOM order, and chrome comes first (`flows.mjs:80,119,135,186`, `team-flows.mjs:47`, `sync-flows.mjs:88,98`, `suites/mcp.mjs:262`) (OD-9).
2. No visible chrome text may **contain** a phrase the harness looks for in the page text:
   - `Loading...`, `Please wait...`, `Opening...`, `Checking...`, `Comparing...`, `Looking for copies...`
   - `Sync now`, `Nothing to review`, `Unlock Vault`, `Set a master password`
   - `Select a vault to get started`, `Continue without signing in`

   Sources: `flows.mjs:22-35,97`, `settings-flows.mjs` `syncNowFromSettings`, `sync-panels.mjs:27,97`, `suites/mcp.mjs:212`.
3. The minimal title bar renders no text nodes (3.1).
4. No `role="dialog"` or `role="status"` on chrome. `role="status"` exists only on banners (3.9), because `ui-forms.mjs:83-101` reads banners that way.
5. The command center pill has no `title` attribute (3.2).

`src/components/shell/__tests__/chromeText.test.tsx` (W2-WORKBENCH) renders the workbench with stores seeded to every status bar state and asserts rules 1 to 5.

### 8.5 Harness runs

| When | Command | Notes |
|---|---|---|
| End of wave 1 | `npm run verify` (all 41 scenarios) | selector pairs against the unchanged UI; needs the local Supabase stack (`supabase start`, `docs/LOCAL_SUPABASE.md`) |
| Wave 2, before W2-WORKBENCH | unit tests and gallery renders on the wave-2 integration branch (W2-MAIN also runs `node scripts/verify/run.mjs password lifecycle`, the suites that drive the application menu) | the new shell parts are not mounted until the integrator lands; manual checks move to W2-WORKBENCH (10) |
| End of wave 2 (W2-WORKBENCH) | `npm run verify` (it includes `mcp`) on the integration branch, which then merges to the release branch | the layout changes the web viewport the MCP tools report (3.7) |
| Each wave-3 package | `npm run verify` (all 41 scenarios, about 12 minutes) before it merges | a suite list per directory missed real dependencies: the Sync tab readers are used by `lifecycle`, `copies` and `password`, the vault menu by `resilience`, the Home dashboard by `mcp`, `backup` and `sync`, and `ConfirmDialog` by `lifecycle` and `password`. A package may run a subset while it iterates |
| End of wave 4 | `npm run verify`, then `node scripts/verify/run.mjs appearance` | old selector alternatives removed; screenshot set (8.6) |

### 8.6 Screenshot matrix

The full product 7 schemes × 2 modes × 2 densities × 6 packs is 168 combinations per screen. That is not run. Colors, density and icons are independent (icons draw with `currentColor`), so the matrix covers each axis fully and the pairs that interact:

| Set | Source | Combinations | Shots |
|---|---|---|---|
| G1 tokens | `/gallery.html` (dev server) | 7 schemes × 2 modes × 2 densities, Codicons | 28 |
| G2 packs | gallery icon strip | 6 packs × 2 modes, Modern, Comfortable | 12 |
| A1 core screens | opt-in `appearance` suite: S1 vault hub, S2 workbench (side bar floating open, 2 panes, tabs in connected, connecting and disconnected states, AI open), S3 Settings > Appearance, S4 Recently deleted with the stacked confirm, S5 tab context menu (popup window page), S6 toast (overlay window page) | Modern × 2 modes × 2 densities, Codicons | 24 |
| A2 schemes | S2 | 6 universal schemes × 2 modes, Comfortable, Codicons | 12 |
| A3 packs in context | S2 and S5 | 5 non-default packs, Modern dark, Comfortable | 10 |
| A4 zoom | S2 | `ui_scale` 0.75, 1.0, 1.5, Modern dark, Comfortable | 3 |

Output: `.verify/runs/<id>/appearance/<set>-<screen>-<scheme>-<mode>-<density>-<pack>.png`. No pixel diffing this release; the owner reviews the set. Review on a machine **without Inter installed**, because the owner's Mac has it and most users will see the OS font (2.4) [V critic].

### 8.7 What only Windows or Linux can test

Nobody can run these on the owner's Mac. The PR test plan carries one checkbox per line. A debug flag, `localStorage["conduit:debug-caption-fallback"] = "1"`, forces the HTML caption buttons for testing (W2-TITLEBAR).

1. The window controls overlay shows, has height 34, and its color and glyph color follow every scheme and mode change (`setTitleBarOverlay`).
2. The leading and trailing reserves match the caption buttons at OS scaling 100%, 125% and 150% and at `ui_scale` 0.75 and 1.5 (`geometrychange`). Linux with `gtk-decoration-layout` set to `close,minimize,maximize:` (buttons on the left): the menu button is not covered. Windows with a right-to-left display language: the mirrored buttons get the leading reserve.
3. Drag moves the window. Double-click maximizes. Windows 11 snap layouts appear on the maximize button. Resizing from the top edge works, with and without the HTML caption fallback, and dragging 5px below the edge moves the window.
4. The menu button opens the native application menu under itself, keyboard navigation works in it, and its items fire. F10 and a lone Alt open it at the menu button, and neither does so while a terminal or remote session has focus.
5. Ctrl+O, Ctrl+S and F1 still fire (a smoke check: the frameless window keeps the menu's accelerators, 7.3), and Alt shows no native menu bar.
6. The HTML caption fallback (forced with the debug flag): minimize, maximize and restore, close (hides to tray). It also appears by itself when `setTitleBarOverlay` fails, and scheme or mode changes then raise no errors (7.2).
7. Native mode with `CONDUIT_TITLE_BAR=native`, with the setting, and through Help > `Use Native Title Bar`.
8. Linux: GNOME and KDE, Wayland and X11 sessions. In a Wayland session the app runs under XWayland (D-26) [A: the `.desktop` `Exec` line carries `--ozone-platform=x11`], and the context menus, the Account menu, the toast overlay and the picker open where they should. Also check resize edges, Electron 43+'s default rounded corners for frameless windows, and whether the overlay is visible at all. `CONDUIT_OZONE=wayland` still starts the app.
9. Windows, maximized, restored and snapped, at 100%, 125% and 150% scaling: a WebView2 session lines up with its pane, the right-click menu opens at the cursor, and the toast sits above the status bar (all three are placed from `getContentBounds()`, 3.7).
10. WebView2 sessions: the card corner is square wherever a WebView2 touches it, no artifacts, and a freeze under dialogs.
11. Chromium web views: rounded bottom corners when a view spans the card's bottom edge, a square card corner when a view touches only one bottom corner, and clicks in the corner cut-outs (they still reach the page [V typings note]). A page whose CSS sets `-webkit-app-region: drag` does not move the window (D-27; also checked on macOS in W2-WORKBENCH).
12. Fonts: Segoe UI or system-ui at 13px; Consolas (Windows) or Ubuntu Mono (Linux) for code.
13. The toast overlay sits 8px above the status bar at 125% and 150% OS scaling.
14. The popup menu's transparent shadow margin (needs a compositor on Linux); a click in the margin closes the menu.
15. The picker window behaves as before.

## 9. Risks and guardrails

| # | Risk | Likelihood / impact | Guardrail | Owner |
|---|---|---|---|---|
| R1 | Harness breakage: class selectors, the dialog-role change, and text that chrome adds | high / high | selector pairs resolved by `pickSelector` first (8.2); dialog detection narrowed (8.3); chrome text rules with a test (8.4); full `npm run verify` at each wave end | W1-HARNESS, W2-WORKBENCH, W4-HARNESS |
| R2 | New DOM surfaces render under live native web views | high / high | freeze registry with a legacy bridge (4.9); every `Dialog` and `Popover` self-registers; context menus stay native windows (D-20); manual check of each surface with a web session open | W1-FREEZE, W1-PRIMITIVES |
| R3 | The custom title bar on Windows and Linux is untested locally | medium / high | reactive HTML caption fallback, `setTitleBarOverlay` guarded by `overlayActive` with try/catch, leading and trailing reserves from the overlay rect with clamps, native mode by setting, env and Help menu item, F10/Alt menu access, the 8.7 checklist; behavior claims about Electron are read from the 44.4.5 source | W2-MAIN, W2-TITLEBAR |
| R4 | Zoom desync between the HTML bar and native controls | medium / medium | the title bar is counter-zoomed at a constant 35 DIP; overlay height constant 34; reserves computed in DIP; the zoom is set at window creation with `zoomMode: 'isolated'`, so there is no startup race and no dev-only zoom leak into the overlay and picker (7.1) | W2-TITLEBAR, W2-MAIN |
| R5 | RDP resolution churn from chrome changes | medium / medium | no animated resizing of session cards; `chromeWidth` updates in the same task as the density; `notifyLayoutChanged` coalesced per frame; `RdpView` debounces and compares against the last requested size (3.7) | W2-TABS, W2-SIDEBAR |
| R6 | Contrast regressions in any scheme or mode | medium / medium | contrast gates in the tokens test (2.11) fail CI | W1-TOKENS |
| R7 | Density shock: 14 → 13px text, 36 → 26px controls, 28 → 22px rows | high / medium | Comfortable default, `ui_scale` kept, What's New explains the change, owner screenshot review (8.6) | W4-DOCS |
| R8 | Icon flash or races when switching packs | low / low | Codicons are static; a request counter drops stale loads; the Appearance tab preloads all packs | W1-ICONS |
| R9 | Package size | low / medium | icon libraries are devDependencies (D-2); `npm ls --omit=dev` check | W1-ICONS |
| R10 | Licensing | low / medium | Licenses view plus the generated license file (5.8); only MIT, ISC, Apache-2.0 and CC-BY-4.0 packs | W1-ICONS, W3-MISC |
| R11 | Popup menu HTML injection (latent today, `menu.ts:214-231`) | low / high | escaping, id allowlist, index-based selection, SVG allowlist (7.7) | W2-MENUS |
| R12 | Users miss their platform theme or get a new default color | medium / low | the OD-5 migration table; the icon style carries over; a What's New line; older builds fall back to their default look on downgrade | W1-TOKENS, W4-DOCS |
| R13 | Parallel packages collide | medium / high | disjoint ownership per wave (section 10); the wave-2 integrator runs last; contracts written in this spec | all |
| R14 | Owner review bias from a locally installed Inter | high / low | review on a machine without Inter (8.6) | owner |
| R15 | Traffic-light position wrong on some macOS versions | low / medium | VS Code's formula keyed on the Darwin version; check on macOS 15 and 26 or later [A] | W2-MAIN |
| R16 | `setBorderRadius` also rounds the web page's top corners, and a square native view on a rounded card corner would paint over it | certain / low | accepted for the top corners; radius only when a view spans both bottom corners; any square native view (one-corner Chromium, WebView2) makes that card corner square; the radius is applied to every sub-tab view (3.7) | W2-TABS, W2-MAIN |
| R17 | A large release gets larger (PR #13 already carries Electron 44, sync, the pin and unlimited MCP) | high / medium | wave boundaries keep the app shippable: wave 1 alone restyles through tokens, wave 2 reaches the release branch only as one integration merge, and each wave ends with a full verify run | owner |
| R18 | Newly defined theme colors revive dead classes (for example `text-accent` at `AboutDialog.tsx:61` starts working) | low / low | the legacy report lists them; the wave-3 owner decides | W1-PRIMITIVES, W3-* |
| R19 | The global focus ring doubles on elements that also use `focus:ring-*` | medium / low | the legacy report flags `focus:ring`; wave-3 packages remove it when they move to primitives | W3-* |
| R20 | Stale contributor doc: `.claude/commands/notification.md` still describes a `w-sm` toast container in `App.tsx` (lines 7, 114) | certain / low | not edited by any package (it is Claude Code configuration); flagged for the owner | owner |
| R21 | A remote web page moves the window through CSS drag regions once the frame is gone | medium / medium | user-origin `app-region: no-drag` stylesheet on every web-session `dom-ready` (D-27, 3.7); a macOS manual check with a page that sets `-webkit-app-region: drag` | W2-MAIN |
| R22 | Wayland ignores absolute window positions, which menus, toasts and the picker rely on | high on Wayland / medium | Linux runs under XWayland this release (D-26), with a `CONDUIT_OZONE=wayland` opt-out; 8.7 item 8 | W2-MAIN |
| R23 | A class-based harness selector picks an unrelated element after a restyle | medium / high | scope-level `pickSelector` instead of comma unions (8.2), mixed-fixture tests, and the full `npm run verify` before every wave-3 merge (8.5) | W1-HARNESS, W3-* |

---

## 10. Work packages

There are 30 packages in 4 waves. The same list is in machine-readable form at `scratchpad/redesign/work-packages.json` (session scratchpad); W1-HARNESS copies it to `scripts/redesign/work-packages.json` for `check-owns.mjs`.

**Rules for every package:**

1. **Ownership.** Edit only the paths in `owns`. Within a wave, no two packages own the same file, and each shared file (`App.tsx`, `package.json`, `DragContext.tsx`, `ConfirmDialog.tsx`, …) has exactly one owner per wave (`scripts/redesign/check-owns.mjs` checks both). In waves 2 and 3 the shared foundations belong to a standing package (W2-FOUNDATION, W3-FOUNDATION; W3-FOUNDATION owns everything outside the wave-3 directories). A package that needs a change in a path it does not own files it with that path's owner, which lands it as its own small commit with tests, so no fix waits a whole wave.
2. **Order.** A package starts when everything in `depends_on` is merged. Within a wave, `depends_on` can name same-wave packages: W1-TOKENS runs after W1-ICONS, W1-PRIMITIVES after W1-TOKENS and W1-FREEZE, W2-ACTIVITYBAR after W2-SIDEBAR, W2-STATUSBAR after W2-TITLEBAR, W2-WORKBENCH (the integrator) last in wave 2, and W3-SYNC after W3-MISC. The two foundation packages open with their wave and close when its last other package merges.
3. **Wave 2 integration branch.** Wave-2 packages merge into one integration branch (for example `redesign/wave-2`), never straight into the release branch, because the states in between are not shippable: W2-MAIN makes the window frameless before any title bar is mounted, and W2-SIDEBAR removes the side bar footer before the activity bar and status bar exist. Developers on that branch can run with `CONDUIT_TITLE_BAR=native`. Wave-2 packages accept on unit tests and gallery renders (W2-MAIN also on two harness suites); every manual check runs in W2-WORKBENCH, which merges the branch into the release branch after a full `npm run verify`.
4. **Contracts.** Cross-package contracts are the ones written in this spec: module paths, props, IPC channels, events, store fields and hooks. A package builds against the contract, not against another package's internals.
5. **Baseline checks.** Every acceptance list ends with the baseline checks: vitest (with the 3 known `src/App.test.tsx` failures allowed until W2-WORKBENCH fixes them), both `tsc` runs, an ESLint error count no higher than on the wave base, `npm run build`, and `check-owns.mjs`. Until W1-HARNESS lands `lint-count.mjs` and `check-owns.mjs`, count errors with `npx eslint src --quiet --format json -o /tmp/lint.json` and `node -e "console.log(require('/tmp/lint.json').reduce((n, f) => n + f.errorCount, 0))"`, and compare the two git listings with `owns` by hand. Commands are written to run in zsh: globs are quoted, or passed to `git grep` as pathspecs.
6. **Git.** No package commits to `main`, rewrites history, or uses a bare `git stash`.

### 10.1 Wave 1: foundation

| Id | Title | Depends on |
|---|---|---|
| W1-ICONS | Icon registry, six packs and the icon codegen | none |
| W1-TOKENS | Design tokens, schemes, density, appearance runtime and migration | W1-ICONS |
| W1-FREEZE | Ref-counted freeze registry for native web views | none |
| W1-PRIMITIVES | UI primitives, layer stack, gallery and legacy report | W1-TOKENS, W1-ICONS, W1-FREEZE |
| W1-HARNESS | Harness selector pairs, dialog detection and the ownership check | none |

#### W1-ICONS: Icon registry, six packs and the icon codegen

**Owns:** `src/lib/icons/**`, `scripts/icons/**`, `scripts/__tests__/icon-packs.test.ts`, `public/licenses/**`, `package.json`, `package-lock.json`

**Deliverables:**

- Registry per spec 5.1: types.ts (123 names), store.ts, loader.ts with bootIconPack(), preloadAllIconPacks() and getPackMapping(id), create-themed-icon.ts, Icon.tsx (with the pack prop), serialize.ts (iconToSvg), licenses.ts, index.ts with the 12 new named exports
- Packs: codicons.tsx + generated/codicons.ts (static), material.tsx + generated/material.ts, lucide.ts, tabler.ts (from default.ts), phosphor.ts (from macos.ts, playerStopFilled fixed), fluent.ts (from windows.ts); the 12 new names in every pack (spec 5.3, Appendix A), including the shown/hidden pairs panelLeft/panelLeftOff and panelRight/panelRightOff; ubuntu.ts deleted
- scripts/icons/generate-icon-packs.mjs + mapping.mjs with --check mode; npm script icons:generate; generated public/licenses/third-party-icons.txt
- package.json: devDependencies @iconify-json/codicon@1.2.73, @iconify-json/material-symbols-light@1.2.94, lucide-react@1.48.0 (exact); @tabler/icons-react, @phosphor-icons/react, @fluentui/react-icons moved to devDependencies with unchanged ranges
- Deprecated shims so current callers compile: IconTheme, THEME_ICON_DEFAULTS, loadIconPack(theme) mapping default/ubuntu to tabler, macos to phosphor, windows to fluent, useIconThemeStore alias

**Acceptance:**

- npx vitest run src/lib/icons scripts/__tests__/icon-packs.test.ts passes (spec 8.1 row W1-ICONS)
- npm ls --omit=dev --parseable | grep -E "lucide|tabler|phosphor|fluentui|iconify" prints nothing
- node scripts/icons/generate-icon-packs.mjs --check exits 0
- After npm run build: for p in lucide tabler phosphor fluent material; do ls dist/assets | grep -qE "^$p-.*\.js$" || echo "missing $p"; done prints nothing, and ls dist/assets | grep -c codicons prints 0 (Codicons ship in the entry chunk)
- npx vitest run passes, except the 3 known src/App.test.tsx failures (fixed by W2-WORKBENCH)
- npx tsc --noEmit and npx tsc -p electron/tsconfig.json --noEmit report no errors
- node scripts/redesign/lint-count.mjs prints no more ESLint errors than it printed on the wave base (record the base count first)
- npm run build passes
- node scripts/redesign/check-owns.mjs W1-ICONS --base &lt;wave base> exits 0 (before W1-HARNESS lands: git diff --name-only $(git merge-base HEAD &lt;wave base>)...HEAD and git status --porcelain list only paths in owns)

#### W1-TOKENS: Design tokens, schemes, density, appearance runtime and migration

**Owns:** `src/index.css`, `src/styles/**`, `src/themes/**`, `tailwind.config.js`, `src/lib/themes.ts`, `src/lib/schemes.ts`, `src/lib/appearance/**`, `src/hooks/useTheme.ts`, `src/lib/terminalTheme.ts`, `src/lib/__tests__/terminalTheme.test.ts`, `index.html`, `overlay.html`, `picker.html`, `vite.config.ts`, `src/main.tsx`, `src/overlay.tsx`, `src/picker.tsx`, `src/components/overlay/OverlayApp.tsx`, `src/test/setup.ts`, `electron/ipc/settings.ts`, `electron/services/appearance-migration.ts`, `electron/services/__tests__/appearance-migration.test.ts`, `src/components/settings/SettingsDialog.tsx`, `src/components/settings/SettingsHelpers.tsx`, `src/components/settings/tabs/AppearanceTab.tsx`, `src/components/entries/entryIcons.ts`, `scripts/__tests__/appearance-migration-parity.test.ts`

**Deliverables:**

- src/styles/{tokens,schemes,density,base}.css and components/{cards,tabs,sash}.css with every token in spec 2.2-2.9 as revised: Modern exact values, the 6 universal schemes with the 2.3 overrides (Forest dark muted and faint, Ocean light tab-fg), 10% tone tints, and the tab, status bar, activity, code, grip, indent and underline tokens; the selected-row re-scope of both --c-* and --color-* (2.11); the focus rules (2.7); 8px scrollbars (2.8)
- src/index.css rewritten to the 2.1 skeleton and the 2.10 @theme block; platform CSS, native-schemes.css, tailwind.config.js and src/lib/themes.ts deleted
- src/styles/metrics.ts mirror of layout tokens; resolveCssColor (2.12)
- Appearance runtime (6.2): boot-inline.js (sets --c-zoom from window.electron.zoomFactor() when present), the conduitAppearanceBoot Vite plugin and markers in the three HTML shells, useAppearance (useTheme.ts re-exports it; dispatches conduit:appearance-applied and never sends window_chrome_update), migrate.ts, migration-table.json, shell-colors.json, COLOR_SCHEMES with Modern first and preview colors
- Settings keys and defaults (6.1) in electron/ipc/settings.ts; main-process migration (6.3) that reads the raw file before defaults, with write-back; SettingsDialog, SettingsHelpers and AppearanceTab minimal edits (6.4 first paragraph)
- terminalTheme uses resolveCssColor('--c-editor'); entryIcons.ts uses text-entry-* classes; OverlayApp theme sync reads the new keys; entry files call bootIconPack(); splash uses --c-boot-bg/--c-boot-fg
- src/test/setup.ts stubs window.matchMedia and ResizeObserver when missing

**Acceptance:**

- npx vitest run src/styles src/lib/appearance src/lib/__tests__/terminalTheme.test.ts electron/services/__tests__/appearance-migration.test.ts scripts/__tests__/appearance-migration-parity.test.ts passes, including every contrast gate in 2.11 for 7 schemes x 2 modes (exact color-mix), the raw-value version check and the temp-dir readSettings() integration test
- git grep -nE "data-platform|conduit-platform-theme|platform_theme" -- src electron index.html overlay.html picker.html finds only the migration code and its tests
- grep -l conduit-appearance-version dist/index.html dist/overlay.html dist/picker.html lists all three files (the inlined boot script)
- npm run dev:electron on a fresh profile shows Modern dark, and Settings > Appearance previews each of the 7 schemes live
- npx vitest run passes, except the 3 known src/App.test.tsx failures (fixed by W2-WORKBENCH)
- npx tsc --noEmit and npx tsc -p electron/tsconfig.json --noEmit report no errors
- node scripts/redesign/lint-count.mjs prints no more ESLint errors than it printed on the wave base (record the base count first)
- npm run build passes
- node scripts/redesign/check-owns.mjs W1-TOKENS --base &lt;wave base> exits 0 (before W1-HARNESS lands: git diff --name-only $(git merge-base HEAD &lt;wave base>)...HEAD and git status --porcelain list only paths in owns)

#### W1-FREEZE: Ref-counted freeze registry for native web views

**Owns:** `src/lib/native-freeze/**`, `src/hooks/useNativeViewVisibility.ts`, `src/hooks/__tests__/useNativeViewVisibility.test.tsx`, `src/App.tsx`, `src/components/sync/SyncDialogFrame.tsx`, `src/components/sync/ConflictReviewPanel.tsx`, `src/components/common/ConfirmDialog.tsx`, `src/components/layout/DragContext.tsx`, `src/components/sync/__tests__/SyncDialogFrame.freeze.test.tsx`

**Deliverables:**

- src/lib/native-freeze/index.ts with the API in spec 4.9, the legacy event bridge and window.__conduitFreeze in dev
- useNativeViewVisibility computes shouldBeNative from useIsFrozen() (replaces useNativeViewVisibility.ts:46-82)
- App.tsx: the two dispatch effects (389-395, 410-415) become useFreeze(anyOverlayOpen, 'legacy') and useFreeze(sidebarOverlayOpen, 'sidebar')
- SyncDialogFrame, ConflictReviewPanel and ConfirmDialog hold a 'dialog' freeze while mounted (closes the sync-dialog gap)
- DragContext holds a 'drag' freeze between startDrag and endDrag and keeps web_session_hide_all and conduit:drag-change

**Acceptance:**

- npx vitest run src/lib/native-freeze src/hooks/__tests__/useNativeViewVisibility.test.tsx src/components/sync/__tests__/SyncDialogFrame.freeze.test.tsx passes (mounting SyncDialogFrame alone makes isFrozen() true)
- Manual: with a web session open and Settings closed, a sync dialog opened from the review banner or the take-over prompt appears above the page (today the native view covers it, because sync dialogs are not in the App.tsx flag list); the floating side bar and tab drags still freeze
- npx vitest run passes, except the 3 known src/App.test.tsx failures (fixed by W2-WORKBENCH)
- npx tsc --noEmit and npx tsc -p electron/tsconfig.json --noEmit report no errors
- node scripts/redesign/lint-count.mjs prints no more ESLint errors than it printed on the wave base (record the base count first)
- npm run build passes
- node scripts/redesign/check-owns.mjs W1-FREEZE --base &lt;wave base> exits 0 (before W1-HARNESS lands: git diff --name-only $(git merge-base HEAD &lt;wave base>)...HEAD and git status --porcelain list only paths in owns)

#### W1-PRIMITIVES: UI primitives, layer stack, gallery and legacy report

**Owns:** `src/components/ui/**`, `gallery.html`, `src/gallery.tsx`, `src/components/sync/useEscapeLayer.ts`, `scripts/redesign/legacy-classes.mjs`, `scripts/__tests__/legacy-classes.test.ts`

**Deliverables:**

- Every primitive in spec section 4 (4.2-4.15) as one file each, barrel index.ts and cx.ts, including: Dialog with onSubmit (one form around header, body and footer), the portal prop and no animation; Button loadingLabel and data-cv-text-button; Spinner text; Menu items as button[role=menuitem]; ListRow as a button when clickable, with opacity-only reveal; Radio as label > input; the Switch off state on the checkbox tokens; Tabs panel and underline variants; IconButton radius 4; the count badge metrics
- layers.ts (useLayer, useEscapeLayer); src/components/sync/useEscapeLayer.ts becomes a re-export
- gallery.html + src/gallery.tsx with scheme, mode, density and pack switches (dev server only), including every focusable primitive focused inside a Card and inside a tab strip
- scripts/redesign/legacy-classes.mjs: reports the 4.16 legacy patterns (uppercase and tracking, text-base, text-xl and bg-well on code blocks included) found inside class strings only, per path, with the Appendix B allowlist and the 10.5 dead files excluded

**Acceptance:**

- npx vitest run src/components/ui scripts/__tests__/legacy-classes.test.ts passes (spec 8.1 row W1-PRIMITIVES)
- The gallery renders in all 7 schemes x 2 modes x 2 densities with no console errors, and every focus ring is fully visible inside the Card and the tab strip
- node scripts/redesign/legacy-classes.mjs src/components/ui reports 0 findings
- npx vitest run passes, except the 3 known src/App.test.tsx failures (fixed by W2-WORKBENCH)
- npx tsc --noEmit and npx tsc -p electron/tsconfig.json --noEmit report no errors
- node scripts/redesign/lint-count.mjs prints no more ESLint errors than it printed on the wave base (record the base count first)
- npm run build passes
- node scripts/redesign/check-owns.mjs W1-PRIMITIVES --base &lt;wave base> exits 0 (before W1-HARNESS lands: git diff --name-only $(git merge-base HEAD &lt;wave base>)...HEAD and git status --porcelain list only paths in owns)

#### W1-HARNESS: Harness selector pairs, dialog detection and the ownership check

**Owns:** `scripts/verify/lib/selectors.mjs`, `scripts/verify/lib/flows.mjs`, `scripts/verify/lib/team-flows.mjs`, `scripts/verify/lib/settings-flows.mjs`, `scripts/verify/lib/backup-flows.mjs`, `scripts/verify/lib/sync-flows.mjs`, `scripts/verify/lib/sync-panels.mjs`, `scripts/verify/lib/sync-dialogs.mjs`, `scripts/verify/lib/password-flows.mjs`, `scripts/verify/lib/ui-forms.mjs`, `scripts/verify/suites/mcp.mjs`, `scripts/verify/README.md`, `scripts/__tests__/verify-selectors.test.ts`, `scripts/redesign/check-owns.mjs`, `scripts/redesign/lint-count.mjs`, `scripts/redesign/work-packages.json`, `scripts/__tests__/check-owns.test.ts`, `scripts/__tests__/verify-sync-flows.test.ts`

**Deliverables:**

- selectors.mjs with every selector pair in Appendix B (Union column, B35 to B46 included) resolved by a scope-level pickSelector(scope, hook, legacy); no comma union is passed to querySelector or closest (spec 8.2)
- openDialogs and dialogDetails query [role=dialog][aria-label]; scoped [role=dialog] clicks narrowed (spec 8.3)
- scripts/redesign/work-packages.json (a copy of the section 10 package list) and check-owns.mjs &lt;ID> --base &lt;ref>, which fails when git diff --name-only $(git merge-base HEAD &lt;ref>)...HEAD or git status --porcelain lists a path outside that package's owns; lint-count.mjs, which prints the ESLint error count for src through the ESLint Node API (ESLint 10 ships no line-per-error formatter)
- README section on stable data-cv hooks, the busy-text rule (B35) and the chrome text rules (8.4)

**Acceptance:**

- npx vitest run scripts/__tests__ passes (selector tests with mixed fixtures, check-owns tests and the existing harness tests)
- npm run verify passes all 41 scenarios against the unchanged UI (local Supabase running)
- npx vitest run passes, except the 3 known src/App.test.tsx failures (fixed by W2-WORKBENCH)
- npx tsc --noEmit and npx tsc -p electron/tsconfig.json --noEmit report no errors
- node scripts/redesign/lint-count.mjs prints no more ESLint errors than it printed on the wave base (record the base count first)
- npm run build passes
- node scripts/redesign/check-owns.mjs W1-HARNESS --base &lt;wave base> exits 0

### 10.2 Wave 2: shell (one integration branch)

| Id | Title | Depends on |
|---|---|---|
| W2-FOUNDATION | Shared foundations during wave 2 (standing package) | W1-ICONS, W1-TOKENS, W1-FREEZE, W1-PRIMITIVES, W1-HARNESS |
| W2-MAIN | Main process: frameless window, zoom, overlay colors, menu popup, web view corners and drag regions, toast overlay | W1-TOKENS |
| W2-TITLEBAR | Title bar, window frame and window-chrome client | W1-PRIMITIVES |
| W2-SIDEBAR | Primary side bar on the PR #12 model | W1-PRIMITIVES, W1-FREEZE |
| W2-ACTIVITYBAR | Activity bar | W1-PRIMITIVES, W2-SIDEBAR |
| W2-TABS | Editor card, connected tabs, splits and web view corners | W1-PRIMITIVES, W1-FREEZE |
| W2-STATUSBAR | Status bar | W1-PRIMITIVES, W2-TITLEBAR |
| W2-AI | AI secondary side bar | W1-PRIMITIVES |
| W2-MENUS | Native popup menu restyle and hardening | W1-ICONS, W1-TOKENS |
| W2-WORKBENCH | Workbench integration, banners, shortcuts and screen gates | W2-MAIN, W2-TITLEBAR, W2-ACTIVITYBAR, W2-SIDEBAR, W2-TABS, W2-STATUSBAR, W2-AI, W2-MENUS, W1-HARNESS |

#### W2-FOUNDATION: Shared foundations during wave 2 (standing package)

**Owns:** `src/components/ui/**`, `gallery.html`, `src/gallery.tsx`, `src/components/sync/useEscapeLayer.ts`, `src/index.css`, `src/styles/tokens.css`, `src/styles/schemes.css`, `src/styles/density.css`, `src/styles/base.css`, `src/styles/metrics.ts`, `src/styles/__tests__/**`, `src/lib/icons/**`, `src/lib/appearance/**`, `src/lib/schemes.ts`, `src/lib/terminalTheme.ts`, `src/lib/__tests__/terminalTheme.test.ts`, `src/lib/native-freeze/**`, `src/hooks/useNativeViewVisibility.ts`, `src/hooks/__tests__/useNativeViewVisibility.test.tsx`, `src/hooks/useTheme.ts`, `src/main.tsx`, `src/overlay.tsx`, `src/picker.tsx`, `index.html`, `overlay.html`, `picker.html`, `vite.config.ts`, `electron/ipc/settings.ts`, `electron/services/appearance-migration.ts`, `electron/services/__tests__/appearance-migration.test.ts`, `scripts/verify/**`, `scripts/redesign/**`, `scripts/icons/**`, `scripts/__tests__/verify-selectors.test.ts`, `scripts/__tests__/verify-harness.test.ts`, `scripts/__tests__/verify-sync-files.test.ts`, `scripts/__tests__/verify-sync-flows.test.ts`, `scripts/__tests__/icon-packs.test.ts`, `scripts/__tests__/legacy-classes.test.ts`, `scripts/__tests__/check-owns.test.ts`, `scripts/__tests__/appearance-migration-parity.test.ts`, `public/licenses/**`, `package.json`, `package-lock.json`

**Deliverables:**

- Opens when wave 2 starts and closes when W2-WORKBENCH merges. It is the only package that edits the shared foundations in wave 2: primitives, tokens and styles (except tabs.css, cards.css and sash.css), icons, the appearance runtime, the freeze registry, the harness, the redesign scripts and the package manifests
- Takes change requests from the other wave-2 packages one at a time and lands each as its own small commit with tests, against the contracts in this spec; a request that would change a contract is written into the spec first
- Keeps the gallery, the token gates and the harness selector tests green after every change

**Acceptance:**

- npx vitest run src/components/ui src/styles src/lib/icons src/lib/appearance src/lib/native-freeze scripts/__tests__ passes after each change
- node scripts/verify/run.mjs smoke passes after each harness change
- npx vitest run passes, except the 3 known src/App.test.tsx failures (fixed by W2-WORKBENCH)
- npx tsc --noEmit and npx tsc -p electron/tsconfig.json --noEmit report no errors
- node scripts/redesign/lint-count.mjs prints no more ESLint errors than it printed on the wave base (record the base count first)
- npm run build passes
- node scripts/redesign/check-owns.mjs W2-FOUNDATION --base &lt;wave base> exits 0

#### W2-MAIN: Main process: frameless window, zoom, overlay colors, menu popup, web view corners and drag regions, toast overlay

**Owns:** `electron/main.ts`, `electron/preload.cts`, `electron/ipc/index.ts`, `electron/ipc/window-chrome.ts`, `electron/ipc/__tests__/window-chrome.test.ts`, `electron/ipc/web.ts`, `electron/services/web/manager.ts`, `electron/services/web/__tests__/manager.chrome.test.ts`, `electron/services/overlay/overlay-manager.ts`, `electron/services/window-chrome/**`, `electron-builder.yml`, `src/types/ipc.d.ts`, `scripts/__tests__/window-chrome-parity.test.ts`

**Deliverables:**

- window-chrome/options.ts (titleBarOptions, zoomOptions, shellColor) and palette.ts per spec 7.1-7.5
- ipc/window-chrome.ts: window_chrome_update (setTitleBarOverlay only while overlayActive, in try/catch, flipping overlayActive and emitting window-chrome:state on the first throw), window_chrome_app_menu, window_chrome_get_state, window_chrome_control and the window-chrome:state event with overlayActive; registered in ipc/index.ts
- main.ts: new window options with webPreferences zoomFactor and zoomMode 'isolated' (no setZoomFactor at ready-to-show), zoomMode 'isolated' on the picker window, setSheetOffset on macOS, the Linux --ozone-platform=x11 switch with the CONDUIT_OZONE=wayland opt-out, and the Help menu item Use Native Title Bar on Windows/Linux custom (7.1)
- preload.cts: synchronous zoomFactor() on the window.electron bridge; src/types/ipc.d.ts declares it (7.4)
- electron-builder.yml: linux.executableArgs ["--ozone-platform=x11"] (D-26)
- web_session_update_position accepts radius; the web manager applies setBorderRadius(round(radius x zoom)) to every attached view (new sub-tab, switch, close, show, bounds) when the value differs, never for WebView2 (spec 3.7); the user-origin no-drag stylesheet on every web-session dom-ready (D-27); the stale getContentBounds comment at manager.ts:93-95 rewritten
- Overlay manager: width 458, right margin 4, zoomMode 'isolated', setBottomInset (spec 7.6)

**Acceptance:**

- npx vitest run electron/services/window-chrome electron/ipc/__tests__/window-chrome.test.ts electron/services/web/__tests__/manager.chrome.test.ts scripts/__tests__/window-chrome-parity.test.ts passes
- node scripts/verify/run.mjs password lifecycle passes on the wave-2 integration branch (these suites drive the application menu)
- npx vitest run passes, except the 3 known src/App.test.tsx failures (fixed by W2-WORKBENCH)
- npx tsc --noEmit and npx tsc -p electron/tsconfig.json --noEmit report no errors
- node scripts/redesign/lint-count.mjs prints no more ESLint errors than it printed on the wave base (record the base count first)
- npm run build passes
- node scripts/redesign/check-owns.mjs W2-MAIN --base &lt;wave base> exits 0

#### W2-TITLEBAR: Title bar, window frame and window-chrome client

**Owns:** `src/components/shell/WindowFrame.tsx`, `src/components/shell/titlebar/**`, `src/lib/window-chrome.ts`, `src/lib/__tests__/window-chrome.test.ts`

**Deliverables:**

- WindowFrame (spec 3.1) and TitleBar full and minimal variants (spec 3.2): leading and trailing reserves, the pill (14px icon at .8 opacity), layout controls that swap panelLeft/panelLeftOff and panelRight/panelRightOff and take sidebarOpen, onToggleSidebar, aiOpen and onToggleAi as props (no store imports), the menu button, the reactive caption fallback with VS Code colors, native mode
- src/lib/window-chrome.ts: --c-zoom and useZoomFactor(), both WCO reserves with the 0..300 clamp and the 0/138 fallback, openAppMenu(), the single debounced window_chrome_update sender driven by conduit:appearance-applied (a rejected invoke is ignored), the state store with overlayActive, the debug flag conduit:debug-caption-fallback

**Acceptance:**

- npx vitest run src/components/shell/titlebar src/lib/__tests__/window-chrome.test.ts passes
- node scripts/redesign/legacy-classes.mjs src/components/shell/WindowFrame.tsx src/components/shell/titlebar reports 0 findings
- npx vitest run passes, except the 3 known src/App.test.tsx failures (fixed by W2-WORKBENCH)
- npx tsc --noEmit and npx tsc -p electron/tsconfig.json --noEmit report no errors
- node scripts/redesign/lint-count.mjs prints no more ESLint errors than it printed on the wave base (record the base count first)
- npm run build passes
- node scripts/redesign/check-owns.mjs W2-TITLEBAR --base &lt;wave base> exits 0

#### W2-SIDEBAR: Primary side bar on the PR #12 model

**Owns:** `src/components/layout/Sidebar.tsx`, `src/components/layout/SidebarPanel.tsx`, `src/components/layout/SidebarWindowControls.tsx`, `src/components/layout/VaultContextBar.tsx`, `src/components/layout/TeamInvitationBanner.tsx`, `src/components/layout/__tests__/SidebarPanel.test.tsx`, `src/stores/sidebarStore.ts`, `src/stores/__tests__/sidebarStore.test.ts`, `src/components/entries/EntryTree.tsx`, `src/components/entries/__tests__/EntryTree.roles.test.tsx`, `src/components/vault/VaultSwitcherMenu.tsx`, `src/components/layout/openHomeTab.ts`, `src/components/layout/__tests__/openHomeTab.test.ts`

**Deliverables:**

- Side bar per spec 3.5: part title row, search, 22px tree rows with roles and keyboard, the empty twistie slot on leaves, indent guides and the rename input, docked in the left card, floating card with a workbench-only scrim, footer removed
- handleHome moved verbatim from Sidebar.tsx:165-206 to src/components/layout/openHomeTab.ts (export openHomeTab) in the same change that removes the footer
- sidebarStore: chromeWidth in spareWidth, updated from conduit:appearance-applied in the same task (setChromeWidth kept for tests), favoritesOnly + setFavoritesOnly (persisted via ui_state favorites-filter)
- VaultSwitcherMenu on the Popover and Menu primitives (keeps data-context-menu; items are buttons); hooks data-cv-vault-switcher and data-sidebar-panel (Appendix B, B16 and B17)

**Acceptance:**

- npx vitest run src/components/layout/__tests__/SidebarPanel.test.tsx src/components/layout/__tests__/openHomeTab.test.ts src/stores/__tests__/sidebarStore.test.ts src/components/entries/__tests__/EntryTree.roles.test.tsx passes
- node scripts/redesign/legacy-classes.mjs src/components/layout/Sidebar.tsx src/components/layout/SidebarPanel.tsx src/components/layout/SidebarWindowControls.tsx src/components/layout/VaultContextBar.tsx src/components/layout/TeamInvitationBanner.tsx src/components/layout/openHomeTab.ts reports 0 findings outside the Appendix B allowlist (dead files excluded)
- Manual checks happen in W2-WORKBENCH, once the shell is mounted
- npx vitest run passes, except the 3 known src/App.test.tsx failures (fixed by W2-WORKBENCH)
- npx tsc --noEmit and npx tsc -p electron/tsconfig.json --noEmit report no errors
- node scripts/redesign/lint-count.mjs prints no more ESLint errors than it printed on the wave base (record the base count first)
- npm run build passes
- node scripts/redesign/check-owns.mjs W2-SIDEBAR --base &lt;wave base> exits 0

#### W2-ACTIVITYBAR: Activity bar

**Owns:** `src/components/shell/activitybar/**`

**Deliverables:**

- ActivityBar per spec 3.4 with Vault, Favorites, Home, Quick Connect, Account and Settings; hover and active icon colors
- actions.ts with the Account popup menu; Home calls openHomeTab() from src/components/layout/openHomeTab.ts

**Acceptance:**

- npx vitest run src/components/shell/activitybar passes
- node scripts/redesign/legacy-classes.mjs src/components/shell/activitybar reports 0 findings
- npx vitest run passes, except the 3 known src/App.test.tsx failures (fixed by W2-WORKBENCH)
- npx tsc --noEmit and npx tsc -p electron/tsconfig.json --noEmit report no errors
- node scripts/redesign/lint-count.mjs prints no more ESLint errors than it printed on the wave base (record the base count first)
- npm run build passes
- node scripts/redesign/check-owns.mjs W2-ACTIVITYBAR --base &lt;wave base> exits 0

#### W2-TABS: Editor card, connected tabs, splits and web view corners

**Owns:** `src/components/layout/PaneTabBar.tsx`, `src/components/layout/Pane.tsx`, `src/components/layout/PaneContent.tsx`, `src/components/layout/LayoutRenderer.tsx`, `src/components/layout/SplitContainer.tsx`, `src/components/layout/DropZoneOverlay.tsx`, `src/components/layout/DragContext.tsx`, `src/components/layout/tabs/**`, `src/components/layout/__tests__/PaneTabBar.test.tsx`, `src/components/shell/EditorCard.tsx`, `src/lib/layout/**`, `src/stores/entryStore.ts`, `src/components/connections/QuickConnect.tsx`, `src/components/sessions/WebView.tsx`, `src/components/sessions/RdpView.tsx`, `src/components/sessions/__tests__/RdpView.resize.test.tsx`, `src/styles/components/tabs.css`

**Deliverables:**

- Connected tabs per spec 3.6 in src/styles/components/tabs.css, with roles, keyboard, state dot, inactive-tab hover color, drop marker, sticky + with its 4px margins, split button and editor actions dimmed to 50% in unfocused panes
- Transitional props so the app keeps working until W2-WORKBENCH: legacySidebarToggle (default true) keeps today's hamburger, and rightSlot stays optional; W4-CLEANUP removes both
- EditorCard with data-cv-editor-card and data-square-bottom-left / data-square-bottom-right (spec 3.7); split separators kept 4px in the layout flow with a centered 1px line; drop zones restyled
- WebView.tsx sends radius per the 3.7 rules and includes it in the de-duplication key; getContentAreaFallback() replaces the innerWidth - 250 / innerHeight - 40 guesses
- RdpView's layout-changed handler: last-requested check, 150ms trailing debounce and one 500ms retry (spec 3.7)

**Acceptance:**

- npx vitest run src/components/layout src/lib/layout src/components/layout/tabs src/components/sessions/__tests__/RdpView.resize.test.tsx passes
- node scripts/redesign/legacy-classes.mjs src/components/layout/PaneTabBar.tsx src/components/layout/Pane.tsx src/components/layout/PaneContent.tsx src/components/layout/LayoutRenderer.tsx src/components/layout/SplitContainer.tsx src/components/layout/DropZoneOverlay.tsx src/components/layout/DragContext.tsx src/components/layout/tabs src/components/shell/EditorCard.tsx reports 0 findings outside the Appendix B allowlist (dead files excluded)
- Manual checks happen in W2-WORKBENCH, once the shell is mounted
- npx vitest run passes, except the 3 known src/App.test.tsx failures (fixed by W2-WORKBENCH)
- npx tsc --noEmit and npx tsc -p electron/tsconfig.json --noEmit report no errors
- node scripts/redesign/lint-count.mjs prints no more ESLint errors than it printed on the wave base (record the base count first)
- npm run build passes
- node scripts/redesign/check-owns.mjs W2-TABS --base &lt;wave base> exits 0

#### W2-STATUSBAR: Status bar

**Owns:** `src/components/shell/statusbar/**`, `src/components/sync/PersonalSyncIndicator.tsx`, `src/components/vault/CloudSyncIndicator.tsx`, `src/components/vault/TeamSyncIndicator.tsx`, `src/components/common/StartupStatus.tsx`

**Deliverables:**

- StatusBar per spec 3.10 with every item in its table: hover text, pressed background and tabular numerals; state dots as the 16px circleFilled; the zoom item reads useZoomFactor() from src/lib/window-chrome.ts; the indicators render as status bar items (default exports kept)
- Review item keeps title "Review changes from your other devices" and adds data-cv-review-button (B13)

**Acceptance:**

- npx vitest run src/components/shell/statusbar passes
- node scripts/redesign/legacy-classes.mjs src/components/shell/statusbar reports 0 findings
- The harness run (openConflictReview through the status bar) happens at W2-WORKBENCH, once the status bar is mounted
- npx vitest run passes, except the 3 known src/App.test.tsx failures (fixed by W2-WORKBENCH)
- npx tsc --noEmit and npx tsc -p electron/tsconfig.json --noEmit report no errors
- node scripts/redesign/lint-count.mjs prints no more ESLint errors than it printed on the wave base (record the base count first)
- npm run build passes
- node scripts/redesign/check-owns.mjs W2-STATUSBAR --base &lt;wave base> exits 0

#### W2-AI: AI secondary side bar

**Owns:** `src/components/shell/auxbar/**`, `src/stores/auxBarStore.ts`, `src/stores/__tests__/auxBarStore.test.ts`, `src/components/ai/ChatPanel.tsx`

**Deliverables:**

- auxBarStore and the AI card per spec 3.8 (persisted open state and width, sash, rightPanelWidth = width + 4)
- ChatPanel header (ChatPanel.tsx:222-295) restyled as the 32px part title with a close button

**Acceptance:**

- npx vitest run src/stores/__tests__/auxBarStore.test.ts passes
- node scripts/redesign/legacy-classes.mjs src/components/shell/auxbar reports 0 findings
- Manual checks happen in W2-WORKBENCH, once the shell is mounted
- npx vitest run passes, except the 3 known src/App.test.tsx failures (fixed by W2-WORKBENCH)
- npx tsc --noEmit and npx tsc -p electron/tsconfig.json --noEmit report no errors
- node scripts/redesign/lint-count.mjs prints no more ESLint errors than it printed on the wave base (record the base count first)
- npm run build passes
- node scripts/redesign/check-owns.mjs W2-AI --base &lt;wave base> exits 0

#### W2-MENUS: Native popup menu restyle and hardening

**Owns:** `src/utils/contextMenu.ts`, `src/utils/__tests__/contextMenu.test.ts`, `electron/ipc/menu.ts`, `electron/ipc/menu-svg.ts`, `electron/ipc/__tests__/menu.test.ts`, `electron/ipc/__tests__/menu-svg.test.ts`

**Deliverables:**

- menu.ts per spec 7.7: sizes, font, colors (inkSecondary and dangerHover included), selection, keyboard, escaping, id allowlist, index-based selection, the 12px shadow margin with the flip and clamp done on the visible rect, margin clicks that dismiss, sanitizeSvg in menu-svg.ts
- contextMenu.ts: semantic icons with the old-key map (5.6), iconSvg per item, resolved hex colors

**Acceptance:**

- npx vitest run electron/ipc/__tests__/menu.test.ts electron/ipc/__tests__/menu-svg.test.ts src/utils/__tests__/contextMenu.test.ts passes
- Manual checks happen in W2-WORKBENCH, once the shell is mounted
- npx vitest run passes, except the 3 known src/App.test.tsx failures (fixed by W2-WORKBENCH)
- npx tsc --noEmit and npx tsc -p electron/tsconfig.json --noEmit report no errors
- node scripts/redesign/lint-count.mjs prints no more ESLint errors than it printed on the wave base (record the base count first)
- npm run build passes
- node scripts/redesign/check-owns.mjs W2-MENUS --base &lt;wave base> exits 0

#### W2-WORKBENCH: Workbench integration, banners, shortcuts and screen gates

**Owns:** `src/App.tsx`, `src/App.test.tsx`, `src/test/setup.ts`, `src/components/shell/Workbench.tsx`, `src/components/shell/BannerStack.tsx`, `src/components/shell/index.ts`, `src/components/shell/__tests__/**`, `src/hooks/useKeyboardShortcuts.ts`, `src/hooks/__tests__/useKeyboardShortcuts.test.ts`, `src/components/sync/SyncBanner.tsx`, `src/components/sync/SyncBanners.tsx`, `src/components/auth/AuthScreen.tsx`, `src/components/onboarding/OnboardingWizard.tsx`, `src/styles/components/cards.css`, `src/styles/components/sash.css`

**Deliverables:**

- App.tsx gates inside WindowFrame (spec 3.1); Workbench with cards, gaps, in-flow sashes with grips and cursors, and density dividers (3.3, cards.css and sash.css); accent bar, offline banner, robot toggle, AI divider and StartupStatus strip removed; AI state from auxBarStore; TitleBar wired to sidebarStore and auxBarStore through its props; SplitContainer gets legacySidebarToggle={false} and no rightSlot
- BannerStack and the VS Code style SyncBanner (3.9): neutral info and lock tones, a warning tint, link-button actions with exact labels, data-cv-banner-text; hub offline banner moved into BannerStack
- useKeyboardShortcuts: Ctrl/Cmd+P, Ctrl/Cmd+Alt+B matched on e.code, and F10 or a lone Alt opening the application menu on win32/linux custom, never inside [data-session-keyboard] (3.2)
- src/App.test.tsx fixed; chromeText.test.tsx for the rules in 8.4
- Merges the wave-2 integration branch into the release branch once its acceptance passes

**Acceptance:**

- npm run verify passes all 41 scenarios (mcp included) on the wave-2 integration branch
- Manual on macOS (the wave-2 packages' checks, run here once the shell is mounted): traffic lights at {11,10} on macOS 26 or later and centered in the 35px bar; the window drags; CONDUIT_TITLE_BAR=native restores the native frame; the pill focuses side bar search; both layout controls toggle and swap glyphs; the bar stays 35 DIP at ui_scale 0.75 and 1.5; Vault toggles the side bar with today's titles; Favorites opens it filtered; Home opens the Home tab as before; pin/unpin and dock/undock by window width, with web sessions live beside the docked side bar; tab states, reorder, cross-pane drop; a split line between two web sessions can be grabbed across its full 4px in Comfortable and Compact; web view bottom corners rounded in Comfortable, square in Compact, and square card corners beside a one-corner view; the AI control and Ctrl/Cmd+Alt+B toggle the AI side bar, and width and state survive a restart; tab, tree, new-tab, vault and Account menus render with the active pack, work with the keyboard, and close on a click in their shadow margin
- Manual on macOS: a local page whose body sets -webkit-app-region: drag, opened as a web session, does not move the window and its buttons still click (D-27)
- An RDP session against a real host logs one rdp_resize per density switch, AI toggle and banner change
- Screens S1 to S3 of spec 8.6 captured by hand from npm run dev:electron in Modern dark and light for the owner (the automated set comes with W4-HARNESS)
- node scripts/redesign/legacy-classes.mjs src/App.tsx src/components/shell/Workbench.tsx src/components/shell/BannerStack.tsx src/components/shell/index.ts reports 0 findings outside the Appendix B allowlist (dead files excluded)
- npx vitest run passes with no failures
- npx tsc --noEmit and npx tsc -p electron/tsconfig.json --noEmit report no errors
- node scripts/redesign/lint-count.mjs prints no more ESLint errors than it printed on the wave base (record the base count first)
- npm run build passes
- node scripts/redesign/check-owns.mjs W2-WORKBENCH --base &lt;wave base> exits 0

### 10.3 Wave 3: surface migrations by directory

| Id | Title | Depends on |
|---|---|---|
| W3-SETTINGS | Settings dialog, Appearance tab and settings tabs | W2-WORKBENCH |
| W3-ENTRIES | Entry dialogs and forms | W2-WORKBENCH |
| W3-VAULT | Vault hub and vault dialogs | W2-WORKBENCH |
| W3-SYNC | Sync dialogs and panels | W2-WORKBENCH, W3-MISC |
| W3-DASHBOARD | Dashboards | W2-WORKBENCH |
| W3-AI | AI chat body and AI dialogs | W2-WORKBENCH |
| W3-AUTH-ONBOARDING | Sign-in and onboarding screens | W2-WORKBENCH |
| W3-MISC | Tools, import, about, what's new, upgrade, feedback, connections, common | W2-WORKBENCH |
| W3-SESSIONS | Session views and markdown | W2-WORKBENCH |
| W3-PICKER | Credential picker window | W2-WORKBENCH |
| W3-OVERLAY | Toast overlay visuals | W2-WORKBENCH, W2-MAIN |
| W3-FOUNDATION | Shared foundations and everything outside the wave-3 directories (standing package) | W2-WORKBENCH |

#### W3-SETTINGS: Settings dialog, Appearance tab and settings tabs

**Owns:** `src/components/settings/**`

**Deliverables:**

- SettingsDialog on Dialog size xl with NavList (keeps w-52) and hooks B1 to B4, B7, B22 to B24 and B36, B37, B39 to B41 (the sync plan line, the Multi-device sync h3, the Backup toggles as &lt;label> + direct-child Switch, the backup files list, the cloud backup badge)
- Appearance tab per spec 6.4 (schemes, mode, icon packs with &lt;Icon pack> previews after preloadAllIconPacks(), density, UI scale, title bar)
- Every tab on SettingsRow, FormField, Select, Checkbox and Switch; legacy map 4.16 applied; busy texts kept (B35)

**Acceptance:**

- node scripts/redesign/legacy-classes.mjs src/components/settings reports 0 findings outside the Appendix B allowlist (dead files excluded)
- npm run verify passes all 41 scenarios before the package merges (a subset is fine while iterating; spec 8.5)
- Manual: Appearance previews live and Cancel reverts scheme, mode, pack, density and zoom
- npx vitest run passes with no failures
- npx tsc --noEmit and npx tsc -p electron/tsconfig.json --noEmit report no errors
- node scripts/redesign/lint-count.mjs prints no more ESLint errors than it printed on the wave base (record the base count first)
- npm run build passes
- node scripts/redesign/check-owns.mjs W3-SETTINGS --base &lt;wave base> exits 0

#### W3-ENTRIES: Entry dialogs and forms

**Owns:** `src/components/entries/**`

**Deliverables:**

- EntryDialog and EntryDialogSidebar on Dialog (onSubmit where the dialog has a form) and NavList; entry tabs on FormField, Select and Checkbox; FolderDialog on Dialog
- ColorPicker and IconPicker on Popover; Field.tsx, DefaultableSelect and DefaultableCheckbox rebuilt on primitives
- iconRegistry.ts untouched (D-19); EntryTree.tsx only for leftovers of 4.16

**Acceptance:**

- node scripts/redesign/legacy-classes.mjs src/components/entries reports 0 findings outside the Appendix B allowlist (dead files excluded)
- npm run verify passes all 41 scenarios before the package merges (a subset is fine while iterating; spec 8.5)
- npx vitest run passes with no failures
- npx tsc --noEmit and npx tsc -p electron/tsconfig.json --noEmit report no errors
- node scripts/redesign/lint-count.mjs prints no more ESLint errors than it printed on the wave base (record the base count first)
- npm run build passes
- node scripts/redesign/check-owns.mjs W3-ENTRIES --base &lt;wave base> exits 0

#### W3-VAULT: Vault hub and vault dialogs

**Owns:** `src/components/vault/**`

**Deliverables:**

- Every vault dialog on Dialog, with onSubmit for form dialogs (UnlockDialog keeps its placeholders, its Please wait... label and data-cv-error, B8, B30, B35); BackupManagerDialog gets data-cv-backup-manager and keeps its Master password placeholder and Restore, Confirm and Close buttons (B25, B42)
- VaultHub landing page on ListRow; recent vault rows are buttons whose title is the path (B26, B44)
- VaultSwitcherMenu leftovers (menu items stay buttons, B43); CredentialManager, CredentialForm, AuditLogViewer, VaultSettingsDialog, DeviceSetupDialog and the rest migrated; dead files skipped

**Acceptance:**

- node scripts/redesign/legacy-classes.mjs src/components/vault reports 0 findings outside the Appendix B allowlist (dead files excluded)
- npm run verify passes all 41 scenarios before the package merges (a subset is fine while iterating; spec 8.5)
- npx vitest run passes with no failures
- npx tsc --noEmit and npx tsc -p electron/tsconfig.json --noEmit report no errors
- node scripts/redesign/lint-count.mjs prints no more ESLint errors than it printed on the wave base (record the base count first)
- npm run build passes
- node scripts/redesign/check-owns.mjs W3-VAULT --base &lt;wave base> exits 0

#### W3-SYNC: Sync dialogs and panels

**Owns:** `src/components/sync/**`

**Deliverables:**

- SyncDialogFrame rebuilt on Dialog (harnessLabel = title, layer sync); DialogButton and smallButton on Button with loadingLabel where a busy text shows (Opening..., Checking..., B35); InlineError on Callout; PasswordInput on the primitive
- ConflictReviewPanel (harnessLabel "Review changes") with hooks B11; RecentlyDeletedPanel passes layer="stacked" to ConfirmDialog and drops its div.relative.z-[70] wrapper in the same change, hooks B18, B19; OtherCopiesPanel B20; MassChangeNotice B21; SyncDevicesList B5; SyncNoticeList B6 and B38; IdleLockSetting keeps its aria-label (B28); Loading..., Looking for copies... and Comparing... stay visible (Spinner text, B35)
- Files restyled in wave 2 (PersonalSyncIndicator, SyncBanner, SyncBanners) get only 4.16 leftovers; useEscapeLayer.ts stays a re-export until W4-CLEANUP

**Acceptance:**

- node scripts/redesign/legacy-classes.mjs src/components/sync reports 0 findings outside the Appendix B allowlist (dead files excluded)
- npm run verify passes all 41 scenarios before the package merges (a subset is fine while iterating; spec 8.5)
- npx vitest run passes with no failures
- npx tsc --noEmit and npx tsc -p electron/tsconfig.json --noEmit report no errors
- node scripts/redesign/lint-count.mjs prints no more ESLint errors than it printed on the wave base (record the base count first)
- npm run build passes
- node scripts/redesign/check-owns.mjs W3-SYNC --base &lt;wave base> exits 0

#### W3-DASHBOARD: Dashboards

**Owns:** `src/components/dashboard/**`

**Deliverables:**

- DashboardOverview, EntryDashboard and the other dashboard views on Card, ListRow, Button, IconButton and SectionHeader; the local IconButton (EntryDashboard.tsx:20-37) replaced

**Acceptance:**

- node scripts/redesign/legacy-classes.mjs src/components/dashboard reports 0 findings outside the Appendix B allowlist (dead files excluded)
- npm run verify passes all 41 scenarios before the package merges (a subset is fine while iterating; spec 8.5)
- npx vitest run passes with no failures
- npx tsc --noEmit and npx tsc -p electron/tsconfig.json --noEmit report no errors
- node scripts/redesign/lint-count.mjs prints no more ESLint errors than it printed on the wave base (record the base count first)
- npm run build passes
- node scripts/redesign/check-owns.mjs W3-DASHBOARD --base &lt;wave base> exits 0

#### W3-AI: AI chat body and AI dialogs

**Owns:** `src/components/ai/**`

**Deliverables:**

- ChatPanel body, EngineSelector, ModelPicker (Popover and Menu), McpSetupDialog and EnginePicker on primitives; compact icons for chips (5.4)

**Acceptance:**

- node scripts/redesign/legacy-classes.mjs src/components/ai reports 0 findings outside the Appendix B allowlist (dead files excluded)
- npm run verify passes all 41 scenarios before the package merges (a subset is fine while iterating; spec 8.5)
- npx vitest run passes with no failures
- npx tsc --noEmit and npx tsc -p electron/tsconfig.json --noEmit report no errors
- node scripts/redesign/lint-count.mjs prints no more ESLint errors than it printed on the wave base (record the base count first)
- npm run build passes
- node scripts/redesign/check-owns.mjs W3-AI --base &lt;wave base> exits 0

#### W3-AUTH-ONBOARDING: Sign-in and onboarding screens

**Owns:** `src/components/auth/**`, `src/components/onboarding/**`

**Deliverables:**

- AuthScreen and OnboardingWizard on primitives with Button size lg CTAs and text-display titles; the auth text "Continue without signing in" unchanged

**Acceptance:**

- node scripts/redesign/legacy-classes.mjs src/components/auth src/components/onboarding reports 0 findings outside the Appendix B allowlist (dead files excluded)
- npm run verify passes all 41 scenarios before the package merges (a subset is fine while iterating; spec 8.5)
- npx vitest run passes with no failures
- npx tsc --noEmit and npx tsc -p electron/tsconfig.json --noEmit report no errors
- node scripts/redesign/lint-count.mjs prints no more ESLint errors than it printed on the wave base (record the base count first)
- npm run build passes
- node scripts/redesign/check-owns.mjs W3-AUTH-ONBOARDING --base &lt;wave base> exits 0

#### W3-MISC: Tools, import, about, what's new, upgrade, feedback, connections, common

**Owns:** `src/components/tools/**`, `src/components/import/**`, `src/components/about/**`, `src/components/whats-new/**`, `src/components/upgrade/**`, `src/components/feedback/**`, `src/components/connections/**`, `src/components/common/**`

**Deliverables:**

- ConfirmDialog rebuilt on Dialog with a compatible API plus cancelLabel and layer (4.8); without a layer it renders in place (portal={false}) so today's z-[70] wrapper keeps working until W3-SYNC passes layer="stacked"
- AboutDialog with the Licenses view (5.8); WhatsNewDialog, QuickConnect, PasswordGeneratorDialog, SshKeyGeneratorDialog, ImportDialog and FeedbackDialog on Dialog
- common/StartupStatus.tsx (restyled in wave 2) gets only 4.16 leftovers; dead files skipped

**Acceptance:**

- node scripts/redesign/legacy-classes.mjs src/components/tools src/components/import src/components/about src/components/whats-new src/components/upgrade src/components/feedback src/components/connections src/components/common reports 0 findings outside the Appendix B allowlist (dead files excluded)
- npm run verify passes all 41 scenarios before the package merges (a subset is fine while iterating; spec 8.5)
- npx vitest run passes with no failures
- npx tsc --noEmit and npx tsc -p electron/tsconfig.json --noEmit report no errors
- node scripts/redesign/lint-count.mjs prints no more ESLint errors than it printed on the wave base (record the base count first)
- npm run build passes
- node scripts/redesign/check-owns.mjs W3-MISC --base &lt;wave base> exits 0

#### W3-SESSIONS: Session views and markdown

**Owns:** `src/components/sessions/**`, `src/components/markdown/**`

**Deliverables:**

- Web toolbar and WebSubTabBar, RDP, VNC, terminal and command views (toolbars, error and empty states), DocumentView and MarkdownEditor (Tabs primitive) on primitives; terminal fonts and ANSI colors unchanged (non-goal)

**Acceptance:**

- node scripts/redesign/legacy-classes.mjs src/components/sessions src/components/markdown reports 0 findings outside the Appendix B allowlist (dead files excluded)
- npm run verify passes all 41 scenarios before the package merges (a subset is fine while iterating; spec 8.5)
- npx vitest run passes with no failures
- npx tsc --noEmit and npx tsc -p electron/tsconfig.json --noEmit report no errors
- node scripts/redesign/lint-count.mjs prints no more ESLint errors than it printed on the wave base (record the base count first)
- npm run build passes
- node scripts/redesign/check-owns.mjs W3-SESSIONS --base &lt;wave base> exits 0

#### W3-PICKER: Credential picker window

**Owns:** `src/components/picker/**`

**Deliverables:**

- CredentialPickerApp and its lists on primitives; inline SVGs replaced by semantic icons; drag header kept (CredentialPickerApp.tsx:114-117); window size unchanged

**Acceptance:**

- node scripts/redesign/legacy-classes.mjs src/components/picker reports 0 findings outside the Appendix B allowlist (dead files excluded)
- npm run verify passes all 41 scenarios before the package merges (a subset is fine while iterating; spec 8.5)
- Manual: Cmd/Ctrl+Shift+Space opens the picker in Modern dark and light with the active icon pack
- npx vitest run passes with no failures
- npx tsc --noEmit and npx tsc -p electron/tsconfig.json --noEmit report no errors
- node scripts/redesign/lint-count.mjs prints no more ESLint errors than it printed on the wave base (record the base count first)
- npm run build passes
- node scripts/redesign/check-owns.mjs W3-PICKER --base &lt;wave base> exits 0

#### W3-OVERLAY: Toast overlay visuals

**Owns:** `src/components/overlay/**`

**Deliverables:**

- OverlayToast and OverlayUpdateNotification per spec 4.15 (300ms slide-in); OverlayApp container p-1 gap-1; data-toast kept

**Acceptance:**

- node scripts/redesign/legacy-classes.mjs src/components/overlay reports 0 findings outside the Appendix B allowlist (dead files excluded)
- npm run verify passes all 41 scenarios before the package merges (a subset is fine while iterating; spec 8.5)
- npx vitest run passes with no failures
- npx tsc --noEmit and npx tsc -p electron/tsconfig.json --noEmit report no errors
- node scripts/redesign/lint-count.mjs prints no more ESLint errors than it printed on the wave base (record the base count first)
- npm run build passes
- node scripts/redesign/check-owns.mjs W3-OVERLAY --base &lt;wave base> exits 0

#### W3-FOUNDATION: Shared foundations and everything outside the wave-3 directories (standing package)

**Owns:** `src/App.tsx`, `src/App.test.tsx`, `src/main.tsx`, `src/overlay.tsx`, `src/picker.tsx`, `src/gallery.tsx`, `src/index.css`, `src/styles/**`, `src/lib/**`, `src/stores/**`, `src/hooks/**`, `src/utils/**`, `src/types/**`, `src/test/**`, `src/components/ui/**`, `src/components/layout/**`, `src/components/shell/**`, `index.html`, `overlay.html`, `picker.html`, `gallery.html`, `vite.config.ts`, `vitest.config.ts`, `electron/**`, `scripts/**`, `public/**`, `package.json`, `package-lock.json`, `electron-builder.yml`

**Deliverables:**

- Opens when wave 3 starts and closes when the last other wave-3 package merges. It owns every file no wave-3 directory package owns: the primitives, styles, icons, appearance runtime, freeze registry, stores, hooks, shared libraries, the shell and layout components, App.tsx, the main process, the harness, the scripts and the manifests
- Takes change requests from the wave-3 packages one at a time and lands each as its own small commit with tests, against the contracts in this spec; a request that would change a contract is written into the spec first
- Keeps the gallery, the token gates and the harness selector tests green after every change

**Acceptance:**

- npx vitest run passes with no failures after each change
- npm run verify passes after each change to scripts/verify or to the main process
- npx vitest run passes with no failures
- npx tsc --noEmit and npx tsc -p electron/tsconfig.json --noEmit report no errors
- node scripts/redesign/lint-count.mjs prints no more ESLint errors than it printed on the wave base (record the base count first)
- npm run build passes
- node scripts/redesign/check-owns.mjs W3-FOUNDATION --base &lt;wave base> exits 0

### 10.4 Wave 4: harness, docs, What's New and cleanup

| Id | Title | Depends on |
|---|---|---|
| W4-HARNESS | Final harness selectors and the appearance suite | W3-SETTINGS, W3-ENTRIES, W3-VAULT, W3-SYNC, W3-DASHBOARD, W3-AI, W3-AUTH-ONBOARDING, W3-MISC, W3-SESSIONS, W3-PICKER, W3-OVERLAY, W3-FOUNDATION |
| W4-DOCS | FEATURES.md, What's New and spec status | W3-SETTINGS, W3-ENTRIES, W3-VAULT, W3-SYNC, W3-DASHBOARD, W3-AI, W3-AUTH-ONBOARDING, W3-MISC, W3-SESSIONS, W3-PICKER, W3-OVERLAY, W3-FOUNDATION |
| W4-CLEANUP | Dead files, compatibility shims and final checks | W3-SETTINGS, W3-ENTRIES, W3-VAULT, W3-SYNC, W3-DASHBOARD, W3-AI, W3-AUTH-ONBOARDING, W3-MISC, W3-SESSIONS, W3-PICKER, W3-OVERLAY, W3-FOUNDATION |

#### W4-HARNESS: Final harness selectors and the appearance suite

**Owns:** `scripts/verify/**`, `scripts/__tests__/verify-harness.test.ts`, `scripts/__tests__/verify-selectors.test.ts`

**Deliverables:**

- Old selector alternatives removed (Appendix B, W4 column)
- suites/appearance.mjs (opt-in) producing the spec 8.6 screenshot sets; run.mjs optIn support so all skips it

**Acceptance:**

- npx vitest run scripts/__tests__ passes
- npm run verify passes all scenarios
- node scripts/verify/run.mjs appearance writes the 8.6 screenshot sets
- npx vitest run passes with no failures
- npx tsc --noEmit and npx tsc -p electron/tsconfig.json --noEmit report no errors
- node scripts/redesign/lint-count.mjs prints no more ESLint errors than it printed on the wave base (record the base count first)
- npm run build passes
- node scripts/redesign/check-owns.mjs W4-HARNESS --base &lt;wave base> exits 0

#### W4-DOCS: FEATURES.md, What's New and spec status

**Owns:** `docs/FEATURES.md`, `release-notes/manifest.json`, `docs/VISUAL_REDESIGN.md`

**Deliverables:**

- FEATURES.md sections Window, Appearance, Splash Screen, Sidebar, Tab Bar, Split-View Pane Layout, Keyboard Shortcuts, Dialogs, Notifications & Indicators, Context Menus, Menus and the sync indicator lines rewritten for the new UI; the dropped side bar item count, the Help > Use Native Title Bar item, F10/Alt menu access and Linux running under XWayland recorded
- release-notes/manifest.json: the Appendix C highlights in the pending release entry
- Spec status line updated to shipped

**Acceptance:**

- node -e "JSON.parse(require('fs').readFileSync('release-notes/manifest.json','utf8'))" exits 0
- grep -n "Platform themes" docs/FEATURES.md mentions them only as retired
- npx vitest run passes with no failures
- npx tsc --noEmit and npx tsc -p electron/tsconfig.json --noEmit report no errors
- node scripts/redesign/lint-count.mjs prints no more ESLint errors than it printed on the wave base (record the base count first)
- npm run build passes
- node scripts/redesign/check-owns.mjs W4-DOCS --base &lt;wave base> exits 0

#### W4-CLEANUP: Dead files, compatibility shims and final checks

**Owns:** `src/**`, `scripts/redesign/**`

**Deliverables:**

- The 9 dead files in spec 10.5 deleted
- useFreeze(anyOverlayOpen, "legacy") and the App.tsx overlay flag list removed once every dialog self-registers; the legacy event bridge in native-freeze and the conduit:overlay-change, conduit:sidebar-overlay-change and conduit:drag-change events removed
- Shims removed: IconTheme, THEME_ICON_DEFAULTS, loadIconPack(theme), useIconThemeStore alias, src/hooks/useTheme.ts re-export, src/components/sync/useEscapeLayer.ts, old popup menu icon keys, the legacySidebarToggle and rightSlot props with the old hamburger code; ConfirmDialog portals by default
- src/components/__tests__/icon-sizes.test.ts (spec 5.2 size policy, with the 14px pill exception) and src/components/__tests__/overlay-freeze.test.tsx (each of the 24 overlays listed at App.tsx:389 today holds a freeze by itself)

**Acceptance:**

- node scripts/redesign/legacy-classes.mjs src reports 0 findings outside the Appendix B allowlist (dead files excluded)
- npx vitest run src/components/__tests__/icon-sizes.test.ts src/components/__tests__/overlay-freeze.test.tsx passes
- git grep -n "useFreeze(anyOverlayOpen" -- src and git grep -nE "conduit:(overlay|sidebar-overlay|drag)-change" -- src both find nothing
- npm run verify passes all scenarios
- npx vitest run passes with no failures
- npx tsc --noEmit and npx tsc -p electron/tsconfig.json --noEmit report no errors
- node scripts/redesign/lint-count.mjs prints no more ESLint errors than it printed on the wave base (record the base count first)
- npm run build passes
- node scripts/redesign/check-owns.mjs W4-CLEANUP --base &lt;wave base> exits 0

### 10.5 Dead files

These nine files have zero imports [V: grep of `src` and `electron` for each module path]. Wave-3 packages skip them, and the legacy report excludes them. W4-CLEANUP deletes them.

- `src/components/vault/TeamVaultMembersDialog.tsx`
- `src/components/connections/ConnectionTree.tsx`
- `src/components/layout/TabBar.tsx`
- `src/components/vault/FolderPermissionEditor.tsx`
- `src/components/vault/VaultSelector.tsx`
- `src/components/layout/MainContent.tsx`
- `src/components/ai/McpSetupPopover.tsx`
- `src/components/common/ContextMenu.tsx`
- `src/components/upgrade/UpgradeGate.tsx`

### 10.6 Files that change hands between waves

| File | Wave 1 | Wave 2 | Wave 3 | Wave 4 |
|---|---|---|---|---|
| `src/App.tsx` | W1-FREEZE | W2-WORKBENCH | W3-FOUNDATION | W4-CLEANUP |
| `src/test/setup.ts` | W1-TOKENS | W2-WORKBENCH | W3-FOUNDATION | W4-CLEANUP |
| `src/components/layout/DragContext.tsx` | W1-FREEZE | W2-TABS | W3-FOUNDATION | W4-CLEANUP |
| `src/components/common/ConfirmDialog.tsx` | W1-FREEZE | none | W3-MISC | W4-CLEANUP |
| `src/components/sync/SyncDialogFrame.tsx`, `ConflictReviewPanel.tsx` | W1-FREEZE | none | W3-SYNC | W4-CLEANUP |
| `src/components/sync/useEscapeLayer.ts` | W1-PRIMITIVES | W2-FOUNDATION | W3-SYNC | W4-CLEANUP |
| `src/components/settings/{SettingsDialog,SettingsHelpers}.tsx`, `tabs/AppearanceTab.tsx` | W1-TOKENS | none | W3-SETTINGS | W4-CLEANUP |
| `src/components/entries/entryIcons.ts` | W1-TOKENS | none | W3-ENTRIES | W4-CLEANUP |
| `src/components/entries/EntryTree.tsx` | none | W2-SIDEBAR | W3-ENTRIES | W4-CLEANUP |
| `src/components/vault/VaultSwitcherMenu.tsx` | none | W2-SIDEBAR | W3-VAULT | W4-CLEANUP |
| `src/components/sessions/WebView.tsx`, `RdpView.tsx` | none | W2-TABS | W3-SESSIONS | W4-CLEANUP |
| `src/components/connections/QuickConnect.tsx` | none | W2-TABS | W3-MISC | W4-CLEANUP |
| `src/components/ai/ChatPanel.tsx` | none | W2-AI (header) | W3-AI (body) | W4-CLEANUP |
| `src/components/overlay/OverlayApp.tsx` | W1-TOKENS | none | W3-OVERLAY | W4-CLEANUP |
| `src/components/ui/**` | W1-PRIMITIVES | W2-FOUNDATION | W3-FOUNDATION | W4-CLEANUP |
| `src/lib/icons/**` | W1-ICONS | W2-FOUNDATION | W3-FOUNDATION | W4-CLEANUP |
| `src/lib/appearance/**`, `src/index.css` | W1-TOKENS | W2-FOUNDATION | W3-FOUNDATION | W4-CLEANUP |
| `src/lib/native-freeze/**` | W1-FREEZE | W2-FOUNDATION | W3-FOUNDATION | W4-CLEANUP |
| `src/styles/components/tabs.css` | W1-TOKENS | W2-TABS | W3-FOUNDATION | W4-CLEANUP |
| `src/styles/components/{cards,sash}.css` | W1-TOKENS | W2-WORKBENCH | W3-FOUNDATION | W4-CLEANUP |
| the rest of `src/styles/**` | W1-TOKENS | W2-FOUNDATION | W3-FOUNDATION | W4-CLEANUP |
| `src/utils/contextMenu.ts`, `electron/ipc/menu.ts`, `electron/ipc/menu-svg.ts` | none | W2-MENUS | W3-FOUNDATION | W4-CLEANUP (`contextMenu.ts` only) |
| `electron/preload.cts`, `electron-builder.yml`, `src/types/ipc.d.ts` | none | W2-MAIN | W3-FOUNDATION | W4-CLEANUP (`ipc.d.ts` only) |
| `scripts/verify/**` | W1-HARNESS | W2-FOUNDATION | W3-FOUNDATION | W4-HARNESS |
| `scripts/redesign/**` | W1-PRIMITIVES (`legacy-classes.mjs`), W1-HARNESS (`check-owns.mjs`, `work-packages.json`) | W2-FOUNDATION | W3-FOUNDATION | W4-CLEANUP |
| `package.json`, `package-lock.json` | W1-ICONS | W2-FOUNDATION | W3-FOUNDATION | none |

---

## Appendix A. Icon mappings

### A.1 Codicons (default pack)

Source `@iconify-json/codicon@1.2.73` [V: every name resolved in `icons.json`]. "Lucide fallback" means the set has no fitting glyph, so the Codicons pack renders that Lucide icon (from `lucide-react@1.48.0`). "substitute" is the closest stand-in. Compact twins are 12×12.

| # | Semantic | Codicon | Status | viewBox | 12px twin |
|---|---|---|---|---|---|
| 1 | `close` | `close` | exact | 16×16 | `close-compact` |
| 2 | `plus` | `add` | exact | 16×16 | `add-compact` |
| 3 | `check` | `check` | exact | 16×16 | `check-compact` |
| 4 | `search` | `search` | exact | 16×16 | `search-compact` |
| 5 | `trash` | `trash` | exact | 16×16 |  |
| 6 | `pencil` | `edit` | exact | 16×16 | `edit-compact` |
| 7 | `copy` | `copy` | exact | 16×16 |  |
| 8 | `refresh` | `refresh` | exact | 16×16 | `refresh-compact` |
| 9 | `send` | `send` | exact | 16×16 |  |
| 10 | `download` | `download` | exact | 16×16 |  |
| 11 | `upload` | `cloud-upload` | substitute | 16×16 | `cloud-upload-compact` |
| 12 | `externalLink` | `link-external` | exact | 16×16 |  |
| 13 | `login` | `sign-in` | exact | 16×16 |  |
| 14 | `logout` | `sign-out` | exact | 16×16 |  |
| 15 | `restore` | `discard` | exact | 16×16 |  |
| 16 | `settings` | `settings-gear` | exact | 24×24 |  |
| 17 | `eye` | `eye` | exact | 16×16 |  |
| 18 | `eyeOff` | `eye-closed` | exact | 16×16 |  |
| 19 | `home` | `home` | exact | 16×16 |  |
| 20 | `arrowLeft` | `arrow-left` | exact | 16×16 |  |
| 21 | `arrowRight` | `arrow-right` | exact | 16×16 |  |
| 22 | `arrowUp` | `arrow-up` | exact | 16×16 | `arrow-up-compact` |
| 23 | `arrowsExchange` | `arrow-swap` | exact | 16×16 |  |
| 24 | `chevronDown` | `chevron-down` | exact | 16×16 | `chevron-down-compact` |
| 25 | `chevronLeft` | `chevron-left` | exact | 16×16 | `chevron-left-compact` |
| 26 | `chevronRight` | `chevron-right` | exact | 16×16 | `chevron-right-compact` |
| 27 | `alertCircle` | `error` | exact | 16×16 | `error-compact` |
| 28 | `alertTriangle` | `warning` | exact | 16×16 | `warning-compact` |
| 29 | `infoCircle` | `info` | exact | 16×16 |  |
| 30 | `circleCheck` | `pass` | exact | 16×16 | `pass-compact` |
| 31 | `circleX` | `error` | substitute | 16×16 | `error-compact` |
| 32 | `ban` | `circle-slash` | exact | 16×16 | `circle-slash-compact` |
| 33 | `loader` | `loading` | exact | 16×16 | `loading-compact` |
| 34 | `wifiOff` | `debug-disconnect` | substitute | 16×16 | `debug-disconnect-compact` |
| 35 | `lock` | `lock` | exact | 16×16 |  |
| 36 | `lockOpen` | `unlock` | exact | 16×16 |  |
| 37 | `key` | `key` | exact | 16×16 |  |
| 38 | `shield` | `shield` | exact | 16×16 | `shield-compact` |
| 39 | `shieldCheck` | `workspace-trusted` | exact | 16×16 |  |
| 40 | `shieldLock` | `shield` | substitute | 16×16 | `shield-compact` |
| 41 | `fingerprint` | Lucide `FingerprintPattern` | Lucide fallback |  |  |
| 42 | `file` | `file` | exact | 16×16 |  |
| 43 | `fileCode` | `file-code` | exact | 16×16 |  |
| 44 | `fileImport` | `go-to-file` | substitute | 16×16 |  |
| 45 | `filePlus` | `new-file` | exact | 16×16 |  |
| 46 | `fileText` | `file-text` | exact | 16×16 |  |
| 47 | `fileX` | Lucide `FileX` | Lucide fallback |  |  |
| 48 | `folder` | `folder` | exact | 16×16 | `folder-compact` |
| 49 | `folderOpen` | `folder-opened` | exact | 16×16 | `folder-opened-compact` |
| 50 | `folderPlus` | `new-folder` | exact | 16×16 |  |
| 51 | `user` | `person` | exact | 16×16 |  |
| 52 | `users` | `organization` | exact | 16×16 |  |
| 53 | `crown` | Lucide `Crown` | Lucide fallback |  |  |
| 54 | `terminal` | `terminal` | exact | 24×24 | `terminal-compact` |
| 55 | `terminalAlt` | `terminal` | substitute | 24×24 | `terminal-compact` |
| 56 | `desktop` | `vm` | exact | 16×16 | `vm-compact` |
| 57 | `globe` | `globe` | exact | 16×16 |  |
| 58 | `globeWww` | `browser` | substitute | 16×16 |  |
| 59 | `server` | `server` | exact | 16×16 |  |
| 60 | `serverAlt` | `server-environment` | exact | 16×16 |  |
| 61 | `devices` | `multiple-windows` | substitute | 16×16 |  |
| 62 | `network` | `type-hierarchy` | substitute | 16×16 |  |
| 63 | `plug` | `plug` | exact | 16×16 |  |
| 64 | `plugDisconnected` | `debug-disconnect` | substitute | 16×16 | `debug-disconnect-compact` |
| 65 | `star` | `star-empty` | exact | 16×16 |  |
| 66 | `starFilled` | `star-full` | exact | 16×16 |  |
| 67 | `pin` | `pin` | exact | 16×16 |  |
| 68 | `pinFilled` | `pinned` | exact | 16×16 |  |
| 69 | `database` | `database` | exact | 16×16 |  |
| 70 | `history` | `history` | exact | 16×16 |  |
| 71 | `calendar` | `calendar` | exact | 16×16 |  |
| 72 | `clock` | `clockface` | exact | 16×16 |  |
| 73 | `tag` | `tag` | exact | 16×16 |  |
| 74 | `notes` | `note` | exact | 16×16 |  |
| 75 | `mail` | `mail` | exact | 16×16 |  |
| 76 | `message` | `comment` | exact | 16×16 | `comment-compact` |
| 77 | `messageChatbot` | `comment-discussion-sparkle` | exact | 16×16 |  |
| 78 | `cloud` | `cloud` | exact | 16×16 | `cloud-compact` |
| 79 | `cloudOff` | Lucide `CloudOff` | Lucide fallback |  |  |
| 80 | `cloudDownload` | `cloud-download` | exact | 16×16 | `cloud-download-compact` |
| 81 | `robot` | `robot` | exact | 16×16 |  |
| 82 | `sparkles` | `sparkle` | exact | 16×16 | `sparkle-compact` |
| 83 | `tool` | `tools` | exact | 16×16 |  |
| 84 | `stack` | `layers` | exact | 16×16 |  |
| 85 | `bolt` | Lucide `Zap` | Lucide fallback |  |  |
| 86 | `rocket` | `rocket` | exact | 16×16 | `rocket-compact` |
| 87 | `playerPlay` | `play` | exact | 16×16 |  |
| 88 | `playerStop` | `debug-stop` | exact | 16×16 |  |
| 89 | `playerStopFilled` | `stop-circle` | substitute | 16×16 |  |
| 90 | `playerSkipForward` | `debug-step-over` | substitute | 16×16 |  |
| 91 | `keyboard` | `record-keys` | exact | 16×16 | `record-keys-compact` |
| 92 | `qrcode` | Lucide `QrCode` | Lucide fallback |  |  |
| 93 | `target` | `target` | exact | 16×16 |  |
| 94 | `palette` | `symbol-color` | exact | 16×16 | `symbol-color-compact` |
| 95 | `icons` | `extensions` | substitute | 16×16 |  |
| 96 | `photo` | `file-media` | exact | 16×16 | `file-media-compact` |
| 97 | `deviceMobile` | `device-mobile` | exact | 16×16 |  |
| 98 | `hammer` | `tools` | substitute | 16×16 |  |
| 99 | `bug` | `bug` | exact | 16×16 |  |
| 100 | `floppy` | `save` | exact | 16×16 |  |
| 101 | `bold` | `bold` | exact | 16×16 |  |
| 102 | `italic` | `italic` | exact | 16×16 |  |
| 103 | `strikethrough` | `strikethrough` | exact | 16×16 |  |
| 104 | `heading1` | Lucide `Heading1` | Lucide fallback |  |  |
| 105 | `heading2` | Lucide `Heading2` | Lucide fallback |  |  |
| 106 | `link` | `link` | exact | 16×16 |  |
| 107 | `code` | `code` | exact | 16×16 |  |
| 108 | `list` | `list-unordered` | exact | 16×16 |  |
| 109 | `listNumbers` | `list-ordered` | exact | 16×16 |  |
| 110 | `table` | `table` | exact | 16×16 |  |
| 111 | `quote` | `quote` | exact | 16×16 |  |
| 112 | `menu` | `menu` | exact | 16×16 |  |
| 113 | `panelLeft` | `layout-sidebar-left` | exact | 16×16 |  |
| 114 | `panelRight` | `layout-sidebar-right` | exact | 16×16 |  |
| 115 | `splitHorizontal` | `split-horizontal` | exact | 16×16 |  |
| 116 | `splitVertical` | `split-vertical` | exact | 16×16 |  |
| 117 | `ellipsis` | `ellipsis` | exact | 16×16 |  |
| 118 | `collapseAll` | `collapse-all` | exact | 16×16 | `collapse-all-compact` |
| 119 | `account` | `account` | exact | 16×16 |  |
| 120 | `explorer` | `files` | exact | 24×24 |  |
| 121 | `circleFilled` | `circle-filled` | exact | 16×16 | `circle-filled-compact` |
| 122 | `panelLeftOff` | `layout-sidebar-left-off` | exact | 16×16 |  |
| 123 | `panelRightOff` | `layout-sidebar-right-off` | exact | 16×16 |  |

### A.2 Lucide

Source `lucide-react@1.48.0` [V: all 123 exports present]. Rendered with `strokeWidth={1.5}`.

| # | Semantic | lucide-react export | Status |
|---|---|---|---|
| 1 | `close` | `X` | exact |
| 2 | `plus` | `Plus` | exact |
| 3 | `check` | `Check` | exact |
| 4 | `search` | `Search` | exact |
| 5 | `trash` | `Trash2` | exact |
| 6 | `pencil` | `Pencil` | exact |
| 7 | `copy` | `Copy` | exact |
| 8 | `refresh` | `RefreshCw` | exact |
| 9 | `send` | `Send` | exact |
| 10 | `download` | `Download` | exact |
| 11 | `upload` | `Upload` | exact |
| 12 | `externalLink` | `ExternalLink` | exact |
| 13 | `login` | `LogIn` | exact |
| 14 | `logout` | `LogOut` | exact |
| 15 | `restore` | `RotateCcw` | exact |
| 16 | `settings` | `Settings` | exact |
| 17 | `eye` | `Eye` | exact |
| 18 | `eyeOff` | `EyeOff` | exact |
| 19 | `home` | `House` | exact |
| 20 | `arrowLeft` | `ArrowLeft` | exact |
| 21 | `arrowRight` | `ArrowRight` | exact |
| 22 | `arrowUp` | `ArrowUp` | exact |
| 23 | `arrowsExchange` | `ArrowLeftRight` | exact |
| 24 | `chevronDown` | `ChevronDown` | exact |
| 25 | `chevronLeft` | `ChevronLeft` | exact |
| 26 | `chevronRight` | `ChevronRight` | exact |
| 27 | `alertCircle` | `CircleAlert` | exact |
| 28 | `alertTriangle` | `TriangleAlert` | exact |
| 29 | `infoCircle` | `Info` | exact |
| 30 | `circleCheck` | `CircleCheck` | exact |
| 31 | `circleX` | `CircleX` | exact |
| 32 | `ban` | `Ban` | exact |
| 33 | `loader` | `LoaderCircle` | exact |
| 34 | `wifiOff` | `WifiOff` | exact |
| 35 | `lock` | `Lock` | exact |
| 36 | `lockOpen` | `LockOpen` | exact |
| 37 | `key` | `KeyRound` | exact |
| 38 | `shield` | `Shield` | exact |
| 39 | `shieldCheck` | `ShieldCheck` | exact |
| 40 | `shieldLock` | `ShieldLock` | exact |
| 41 | `fingerprint` | `FingerprintPattern` | exact |
| 42 | `file` | `File` | exact |
| 43 | `fileCode` | `FileCode` | exact |
| 44 | `fileImport` | `FileInput` | exact |
| 45 | `filePlus` | `FilePlus` | exact |
| 46 | `fileText` | `FileText` | exact |
| 47 | `fileX` | `FileX` | exact |
| 48 | `folder` | `Folder` | exact |
| 49 | `folderOpen` | `FolderOpen` | exact |
| 50 | `folderPlus` | `FolderPlus` | exact |
| 51 | `user` | `User` | exact |
| 52 | `users` | `Users` | exact |
| 53 | `crown` | `Crown` | exact |
| 54 | `terminal` | `SquareTerminal` | exact |
| 55 | `terminalAlt` | `Terminal` | exact |
| 56 | `desktop` | `Monitor` | exact |
| 57 | `globe` | `Globe` | exact |
| 58 | `globeWww` | `Earth` | substitute |
| 59 | `server` | `Server` | exact |
| 60 | `serverAlt` | `HardDrive` | substitute |
| 61 | `devices` | `MonitorSmartphone` | exact |
| 62 | `network` | `Network` | exact |
| 63 | `plug` | `Plug` | exact |
| 64 | `plugDisconnected` | `Unplug` | exact |
| 65 | `star` | `Star` | exact |
| 66 | `starFilled` | `Star` | exact, render with `fill="currentColor"` |
| 67 | `pin` | `Pin` | exact |
| 68 | `pinFilled` | `Pin` | exact, render with `fill="currentColor"` |
| 69 | `database` | `Database` | exact |
| 70 | `history` | `History` | exact |
| 71 | `calendar` | `Calendar` | exact |
| 72 | `clock` | `Clock` | exact |
| 73 | `tag` | `Tag` | exact |
| 74 | `notes` | `NotepadText` | exact |
| 75 | `mail` | `Mail` | exact |
| 76 | `message` | `MessageSquare` | exact |
| 77 | `messageChatbot` | `BotMessageSquare` | exact |
| 78 | `cloud` | `Cloud` | exact |
| 79 | `cloudOff` | `CloudOff` | exact |
| 80 | `cloudDownload` | `CloudDownload` | exact |
| 81 | `robot` | `Bot` | exact |
| 82 | `sparkles` | `Sparkles` | exact |
| 83 | `tool` | `Wrench` | exact |
| 84 | `stack` | `Layers` | exact |
| 85 | `bolt` | `Zap` | exact |
| 86 | `rocket` | `Rocket` | exact |
| 87 | `playerPlay` | `Play` | exact |
| 88 | `playerStop` | `Square` | exact |
| 89 | `playerStopFilled` | `Square` | exact, render with `fill="currentColor"` |
| 90 | `playerSkipForward` | `SkipForward` | exact |
| 91 | `keyboard` | `Keyboard` | exact |
| 92 | `qrcode` | `QrCode` | exact |
| 93 | `target` | `Target` | exact |
| 94 | `palette` | `Palette` | exact |
| 95 | `icons` | `Shapes` | exact |
| 96 | `photo` | `Image` | exact |
| 97 | `deviceMobile` | `Smartphone` | exact |
| 98 | `hammer` | `Hammer` | exact |
| 99 | `bug` | `Bug` | exact |
| 100 | `floppy` | `Save` | exact |
| 101 | `bold` | `Bold` | exact |
| 102 | `italic` | `Italic` | exact |
| 103 | `strikethrough` | `Strikethrough` | exact |
| 104 | `heading1` | `Heading1` | exact |
| 105 | `heading2` | `Heading2` | exact |
| 106 | `link` | `Link` | exact |
| 107 | `code` | `Code` | exact |
| 108 | `list` | `List` | exact |
| 109 | `listNumbers` | `ListOrdered` | exact |
| 110 | `table` | `Table` | exact |
| 111 | `quote` | `Quote` | exact |
| 112 | `menu` | `Menu` | exact |
| 113 | `panelLeft` | `PanelLeft` | exact |
| 114 | `panelRight` | `PanelRight` | exact |
| 115 | `splitHorizontal` | `Columns2` | exact |
| 116 | `splitVertical` | `Rows2` | exact |
| 117 | `ellipsis` | `Ellipsis` | exact |
| 118 | `collapseAll` | `ChevronsDownUp` | exact |
| 119 | `account` | `CircleUser` | exact |
| 120 | `explorer` | `Files` | exact |
| 121 | `circleFilled` | `Circle` | exact, render with `fill="currentColor"` |
| 122 | `panelLeftOff` | `PanelLeftDashed` | substitute (Lucide has no outlined-pane variant) |
| 123 | `panelRightOff` | `PanelRightDashed` | substitute |

### A.3 Material Symbols (Light)

Source `@iconify-json/material-symbols-light@1.2.94` [V: every name resolved]. Outline rounded glyphs; "fill" rows use the filled rounded glyph.

| # | Semantic | Iconify name | Kind |
|---|---|---|---|
| 1 | `close` | `close-outline-rounded` | exact |
| 2 | `plus` | `add-outline-rounded` | exact |
| 3 | `check` | `check-outline-rounded` | exact |
| 4 | `search` | `search-outline-rounded` | exact |
| 5 | `trash` | `delete-outline-rounded` | exact |
| 6 | `pencil` | `edit-outline-rounded` | exact |
| 7 | `copy` | `content-copy-outline-rounded` | exact |
| 8 | `refresh` | `refresh-outline-rounded` | exact |
| 9 | `send` | `send-outline-rounded` | exact |
| 10 | `download` | `download-outline-rounded` | exact |
| 11 | `upload` | `upload-outline-rounded` | exact |
| 12 | `externalLink` | `open-in-new-outline-rounded` | exact |
| 13 | `login` | `login-outline-rounded` | exact |
| 14 | `logout` | `logout-outline-rounded` | exact |
| 15 | `restore` | `settings-backup-restore-outline-rounded` | exact |
| 16 | `settings` | `settings-outline-rounded` | exact |
| 17 | `eye` | `visibility-outline-rounded` | exact |
| 18 | `eyeOff` | `visibility-off-outline-rounded` | exact |
| 19 | `home` | `home-outline-rounded` | exact |
| 20 | `arrowLeft` | `arrow-back-outline-rounded` | exact |
| 21 | `arrowRight` | `arrow-forward-outline-rounded` | exact |
| 22 | `arrowUp` | `arrow-upward-outline-rounded` | exact |
| 23 | `arrowsExchange` | `swap-horiz-outline-rounded` | exact |
| 24 | `chevronDown` | `keyboard-arrow-down-outline-rounded` | exact |
| 25 | `chevronLeft` | `chevron-left-outline-rounded` | exact |
| 26 | `chevronRight` | `chevron-right-outline-rounded` | exact |
| 27 | `alertCircle` | `error-outline-rounded` | exact |
| 28 | `alertTriangle` | `warning-outline-rounded` | exact |
| 29 | `infoCircle` | `info-outline-rounded` | exact |
| 30 | `circleCheck` | `check-circle-outline-rounded` | exact |
| 31 | `circleX` | `cancel-outline-rounded` | exact |
| 32 | `ban` | `block-outline-rounded` | exact |
| 33 | `loader` | `progress-activity-outline-rounded` | exact |
| 34 | `wifiOff` | `wifi-off-outline-rounded` | exact |
| 35 | `lock` | `lock-outline-rounded` | exact |
| 36 | `lockOpen` | `lock-open-outline-rounded` | exact |
| 37 | `key` | `key-outline-rounded` | exact |
| 38 | `shield` | `shield-outline-rounded` | exact |
| 39 | `shieldCheck` | `verified-user-outline-rounded` | exact |
| 40 | `shieldLock` | `shield-lock-outline-rounded` | exact |
| 41 | `fingerprint` | `fingerprint-outline-rounded` | exact |
| 42 | `file` | `draft-outline-rounded` | exact |
| 43 | `fileCode` | `code-blocks-outline-rounded` | exact |
| 44 | `fileImport` | `file-open-outline-rounded` | exact |
| 45 | `filePlus` | `note-add-outline-rounded` | exact |
| 46 | `fileText` | `description-outline-rounded` | exact |
| 47 | `fileX` | `file-copy-off-outline-rounded` | substitute |
| 48 | `folder` | `folder-outline-rounded` | exact |
| 49 | `folderOpen` | `folder-open-outline-rounded` | exact |
| 50 | `folderPlus` | `create-new-folder-outline-rounded` | exact |
| 51 | `user` | `person-outline-rounded` | exact |
| 52 | `users` | `group-outline-rounded` | exact |
| 53 | `crown` | `crown-outline-rounded` | exact |
| 54 | `terminal` | `terminal-outline-rounded` | exact |
| 55 | `terminalAlt` | `terminal-2-outline-rounded` | exact |
| 56 | `desktop` | `desktop-windows-outline-rounded` | exact |
| 57 | `globe` | `language-outline-rounded` | exact |
| 58 | `globeWww` | `globe-outline-rounded` | substitute |
| 59 | `server` | `dns-outline-rounded` | exact |
| 60 | `serverAlt` | `storage-outline-rounded` | exact |
| 61 | `devices` | `devices-outline-rounded` | exact |
| 62 | `network` | `lan-outline-rounded` | exact |
| 63 | `plug` | `power-plug-outline-rounded` | exact |
| 64 | `plugDisconnected` | `power-plug-off-outline-rounded` | exact |
| 65 | `star` | `star-outline-rounded` | exact |
| 66 | `starFilled` | `star-rounded` | fill |
| 67 | `pin` | `keep-outline-rounded` | exact |
| 68 | `pinFilled` | `keep-rounded` | fill |
| 69 | `database` | `database-outline-rounded` | exact |
| 70 | `history` | `history-outline-rounded` | exact |
| 71 | `calendar` | `calendar-today-outline-rounded` | exact |
| 72 | `clock` | `schedule-outline-rounded` | exact |
| 73 | `tag` | `sell-outline-rounded` | exact |
| 74 | `notes` | `sticky-note-2-outline-rounded` | exact |
| 75 | `mail` | `mail-outline-rounded` | exact |
| 76 | `message` | `chat-bubble-outline-rounded` | exact |
| 77 | `messageChatbot` | `forum-outline-rounded` | exact |
| 78 | `cloud` | `cloud-outline-rounded` | exact |
| 79 | `cloudOff` | `cloud-off-outline-rounded` | exact |
| 80 | `cloudDownload` | `cloud-download-outline-rounded` | exact |
| 81 | `robot` | `smart-toy-outline-rounded` | exact |
| 82 | `sparkles` | `wand-stars-outline-rounded` | exact |
| 83 | `tool` | `build-outline-rounded` | exact |
| 84 | `stack` | `stacks-outline-rounded` | exact |
| 85 | `bolt` | `bolt-outline-rounded` | exact |
| 86 | `rocket` | `rocket-launch-outline-rounded` | exact |
| 87 | `playerPlay` | `play-arrow-outline-rounded` | exact |
| 88 | `playerStop` | `stop-outline-rounded` | exact |
| 89 | `playerStopFilled` | `stop-rounded` | fill |
| 90 | `playerSkipForward` | `skip-next-outline-rounded` | exact |
| 91 | `keyboard` | `keyboard-outline-rounded` | exact |
| 92 | `qrcode` | `qr-code-outline-rounded` | exact |
| 93 | `target` | `target-outline-rounded` | exact |
| 94 | `palette` | `palette-outline-rounded` | exact |
| 95 | `icons` | `interests-outline-rounded` | exact |
| 96 | `photo` | `image-outline-rounded` | exact |
| 97 | `deviceMobile` | `mobile-outline-rounded` | exact |
| 98 | `hammer` | `construction-outline-rounded` | exact |
| 99 | `bug` | `bug-report-outline-rounded` | exact |
| 100 | `floppy` | `save-outline-rounded` | exact |
| 101 | `bold` | `format-bold-outline-rounded` | exact |
| 102 | `italic` | `format-italic-outline-rounded` | exact |
| 103 | `strikethrough` | `format-strikethrough-outline-rounded` | exact |
| 104 | `heading1` | `format-h1-outline-rounded` | exact |
| 105 | `heading2` | `format-h2-outline-rounded` | exact |
| 106 | `link` | `link-outline-rounded` | exact |
| 107 | `code` | `code-outline-rounded` | exact |
| 108 | `list` | `format-list-bulleted-outline-rounded` | exact |
| 109 | `listNumbers` | `format-list-numbered-outline-rounded` | exact |
| 110 | `table` | `table-outline-rounded` | exact |
| 111 | `quote` | `format-quote-outline-rounded` | exact |
| 112 | `menu` | `menu-outline-rounded` | exact |
| 113 | `panelLeft` | `left-panel-close-outline-rounded` | exact (shown state; Material names glyphs by action) |
| 114 | `panelRight` | `right-panel-close-outline-rounded` | exact (shown state) |
| 115 | `splitHorizontal` | `splitscreen-right-outline-rounded` | exact |
| 116 | `splitVertical` | `splitscreen-bottom-outline-rounded` | exact |
| 117 | `ellipsis` | `more-horiz-outline-rounded` | exact |
| 118 | `collapseAll` | `unfold-less-outline-rounded` | exact |
| 119 | `account` | `account-circle-outline-rounded` | exact |
| 120 | `explorer` | `files-outline-rounded` | exact |
| 121 | `circleFilled` | `circle-rounded` | fill |
| 122 | `panelLeftOff` | `left-panel-open-outline-rounded` | exact (hidden state) |
| 123 | `panelRightOff` | `right-panel-open-outline-rounded` | exact (hidden state) |

### A.4 Tabler, Phosphor and Fluent

Today's mappings from `packs/default.ts`, `packs/macos.ts` and `packs/windows.ts` [V read], unchanged except the new names (5.3) and one Phosphor fix. Phosphor entries marked "(fill)" use `weight="fill"`.

| # | Semantic | Tabler (`@tabler/icons-react`) | Phosphor (`@phosphor-icons/react`) | Fluent (`@fluentui/react-icons`) |
|---|---|---|---|---|
| 1 | `close` | `IconX` | `X` | `DismissRegular` |
| 2 | `plus` | `IconPlus` | `Plus` | `AddRegular` |
| 3 | `check` | `IconCheck` | `Check` | `CheckmarkRegular` |
| 4 | `search` | `IconSearch` | `MagnifyingGlass` | `SearchRegular` |
| 5 | `trash` | `IconTrash` | `Trash` | `DeleteRegular` |
| 6 | `pencil` | `IconPencil` | `PencilSimple` | `EditRegular` |
| 7 | `copy` | `IconCopy` | `Copy` | `CopyRegular` |
| 8 | `refresh` | `IconRefresh` | `ArrowsClockwise` | `ArrowSyncRegular` |
| 9 | `send` | `IconSend` | `PaperPlaneRight` | `SendRegular` |
| 10 | `download` | `IconDownload` | `DownloadSimple` | `ArrowDownloadRegular` |
| 11 | `upload` | `IconUpload` | `UploadSimple` | `ArrowUploadRegular` |
| 12 | `externalLink` | `IconExternalLink` | `ArrowSquareOut` | `OpenRegular` |
| 13 | `login` | `IconLogin` | `SignIn` | `PersonArrowRightRegular` |
| 14 | `logout` | `IconLogout` | `SignOut` | `PersonArrowLeftRegular` |
| 15 | `restore` | `IconRestore` | `ClockCounterClockwise` | `HistoryRegular` |
| 16 | `settings` | `IconSettings` | `Gear` | `SettingsRegular` |
| 17 | `eye` | `IconEye` | `Eye` | `EyeRegular` |
| 18 | `eyeOff` | `IconEyeOff` | `EyeSlash` | `EyeOffRegular` |
| 19 | `home` | `IconHome` | `House` | `HomeRegular` |
| 20 | `arrowLeft` | `IconArrowLeft` | `ArrowLeft` | `ArrowLeftRegular` |
| 21 | `arrowRight` | `IconArrowRight` | `ArrowRight` | `ArrowRightRegular` |
| 22 | `arrowUp` | `IconArrowUp` | `ArrowUp` | `ArrowUpRegular` |
| 23 | `arrowsExchange` | `IconArrowsExchange` | `ArrowsLeftRight` | `ArrowSwapRegular` |
| 24 | `chevronDown` | `IconChevronDown` | `CaretDown` | `ChevronDownRegular` |
| 25 | `chevronLeft` | `IconChevronLeft` | `CaretLeft` | `ChevronLeftRegular` |
| 26 | `chevronRight` | `IconChevronRight` | `CaretRight` | `ChevronRightRegular` |
| 27 | `alertCircle` | `IconAlertCircle` | `WarningCircle` | `ErrorCircleRegular` |
| 28 | `alertTriangle` | `IconAlertTriangle` | `Warning` | `WarningRegular` |
| 29 | `infoCircle` | `IconInfoCircle` | `Info` | `InfoRegular` |
| 30 | `circleCheck` | `IconCircleCheck` | `CheckCircle` | `CheckmarkCircleRegular` |
| 31 | `circleX` | `IconCircleX` | `XCircle` | `DismissCircleRegular` |
| 32 | `ban` | `IconBan` | `Prohibit` | `ProhibitedRegular` |
| 33 | `loader` | `IconLoader2` | `SpinnerGap` | `SpinnerIosRegular` |
| 34 | `wifiOff` | `IconWifiOff` | `WifiSlash` | `WifiOffRegular` |
| 35 | `lock` | `IconLock` | `Lock` | `LockClosedRegular` |
| 36 | `lockOpen` | `IconLockOpen` | `LockOpen` | `LockOpenRegular` |
| 37 | `key` | `IconKey` | `Key` | `KeyRegular` |
| 38 | `shield` | `IconShield` | `Shield` | `ShieldRegular` |
| 39 | `shieldCheck` | `IconShieldCheck` | `ShieldCheck` | `ShieldCheckmarkRegular` |
| 40 | `shieldLock` | `IconShieldLock` | `ShieldWarning` | `ShieldLockRegular` |
| 41 | `fingerprint` | `IconFingerprint` | `Fingerprint` | `FingerprintRegular` |
| 42 | `file` | `IconFile` | `File` | `DocumentRegular` |
| 43 | `fileCode` | `IconFileCode` | `FileCode` | `DocumentCode16Regular` |
| 44 | `fileImport` | `IconFileImport` | `FileArrowDown` | `DocumentArrowDownRegular` |
| 45 | `filePlus` | `IconFilePlus` | `FilePlus` | `DocumentAddRegular` |
| 46 | `fileText` | `IconFileText` | `FileText` | `DocumentTextRegular` |
| 47 | `fileX` | `IconFileX` | `FileX` | `DocumentDismissRegular` |
| 48 | `folder` | `IconFolder` | `Folder` | `FolderRegular` |
| 49 | `folderOpen` | `IconFolderOpen` | `FolderOpen` | `FolderOpenRegular` |
| 50 | `folderPlus` | `IconFolderPlus` | `FolderPlus` | `FolderAddRegular` |
| 51 | `user` | `IconUser` | `User` | `PersonRegular` |
| 52 | `users` | `IconUsers` | `Users` | `PeopleRegular` |
| 53 | `crown` | `IconCrown` | `Crown` | `CrownIcon` |
| 54 | `terminal` | `IconTerminal2` | `TerminalWindow` | `WindowConsoleRegular` |
| 55 | `terminalAlt` | `IconTerminal` | `Terminal` | `WindowConsoleRegular` |
| 56 | `desktop` | `IconDeviceDesktop` | `Desktop` | `DesktopRegular` |
| 57 | `globe` | `IconWorld` | `Globe` | `GlobeRegular` |
| 58 | `globeWww` | `IconWorldWww` | `GlobeSimple` | `GlobeRegular` |
| 59 | `server` | `IconServer` | `HardDrive` | `ServerRegular` |
| 60 | `serverAlt` | `IconServer2` | `HardDrives` | `ServerRegular` |
| 61 | `devices` | `IconDevices` | `DeviceMobile` | `PhoneDesktopRegular` |
| 62 | `network` | `IconNetwork` | `TreeStructure` | `BranchRegular` |
| 63 | `plug` | `IconPlug` | `Plug` | `PlugConnectedRegular` |
| 64 | `plugDisconnected` | `IconPlugConnectedX` | `PlugsConnected` | `PlugDisconnectedRegular` |
| 65 | `star` | `IconStar` | `Star` | `StarRegular` |
| 66 | `starFilled` | `IconStarFilled` | `Star (fill)` | `StarFilled` |
| 67 | `pin` | `IconPin` | `PushPin` | `PinRegular` |
| 68 | `pinFilled` | `IconPinFilled` | `PushPin (fill)` | `PinFilled` |
| 69 | `database` | `IconDatabase` | `Database` | `DatabaseRegular` |
| 70 | `history` | `IconHistory` | `ClockClockwise` | `HistoryRegular` |
| 71 | `calendar` | `IconCalendar` | `Calendar` | `CalendarRegular` |
| 72 | `clock` | `IconClock` | `Clock` | `ClockRegular` |
| 73 | `tag` | `IconTag` | `Tag` | `TagRegular` |
| 74 | `notes` | `IconNotes` | `Notepad` | `NoteRegular` |
| 75 | `mail` | `IconMail` | `Envelope` | `MailRegular` |
| 76 | `message` | `IconMessage` | `ChatCircle` | `ChatRegular` |
| 77 | `messageChatbot` | `IconMessageChatbot` | `ChatCircleDots` | `ChatMultipleRegular` |
| 78 | `cloud` | `IconCloud` | `Cloud` | `CloudRegular` |
| 79 | `cloudOff` | `IconCloudOff` | `CloudSlash` | `CloudOffRegular` |
| 80 | `cloudDownload` | `IconCloudDownload` | `CloudArrowDown` | `CloudArrowDownRegular` |
| 81 | `robot` | `IconRobot` | `Robot` | `BotRegular` |
| 82 | `sparkles` | `IconSparkles` | `Sparkle` | `SparkleRegular` |
| 83 | `tool` | `IconTool` | `Wrench` | `WrenchRegular` |
| 84 | `stack` | `IconStack2` | `Stack` | `StackRegular` |
| 85 | `bolt` | `IconBolt` | `Lightning` | `FlashRegular` |
| 86 | `rocket` | `IconRocket` | `Rocket` | `RocketRegular` |
| 87 | `playerPlay` | `IconPlayerPlay` | `Play` | `PlayRegular` |
| 88 | `playerStop` | `IconPlayerStop` | `Stop` | `StopRegular` |
| 89 | `playerStopFilled` | `IconPlayerStopFilled` | `Stop` (fill), fixed; today regular | `StopFilled` |
| 90 | `playerSkipForward` | `IconPlayerSkipForward` | `SkipForward` | `NextRegular` |
| 91 | `keyboard` | `IconKeyboard` | `Keyboard` | `KeyboardRegular` |
| 92 | `qrcode` | `IconQrcode` | `QrCode` | `QrCodeRegular` |
| 93 | `target` | `IconTarget` | `Crosshair` | `TargetRegular` |
| 94 | `palette` | `IconPalette` | `Palette` | `ColorRegular` |
| 95 | `icons` | `IconIcons` | `GridFour` | `GridRegular` |
| 96 | `photo` | `IconPhoto` | `Image` | `ImageRegular` |
| 97 | `deviceMobile` | `IconDeviceMobile` | `DeviceMobile` | `PhoneRegular` |
| 98 | `hammer` | `IconHammer` | `Hammer` | `WrenchScrewdriverRegular` |
| 99 | `bug` | `IconBug` | `Bug` | `BugRegular` |
| 100 | `floppy` | `IconDeviceFloppy` | `FloppyDisk` | `SaveRegular` |
| 101 | `bold` | `IconBold` | `TextB` | `TextBoldRegular` |
| 102 | `italic` | `IconItalic` | `TextItalic` | `TextItalicRegular` |
| 103 | `strikethrough` | `IconStrikethrough` | `TextStrikethrough` | `TextStrikethroughRegular` |
| 104 | `heading1` | `IconH1` | `TextHOne` | `TextHeader1Regular` |
| 105 | `heading2` | `IconH2` | `TextHTwo` | `TextHeader2Regular` |
| 106 | `link` | `IconLink` | `Link` | `LinkRegular` |
| 107 | `code` | `IconCode` | `Code` | `CodeRegular` |
| 108 | `list` | `IconList` | `ListBullets` | `TextBulletListRegular` |
| 109 | `listNumbers` | `IconListNumbers` | `ListNumbers` | `TextNumberListLtrRegular` |
| 110 | `table` | `IconTable` | `Table` | `TableRegular` |
| 111 | `quote` | `IconQuote` | `Quotes` | `TextQuoteRegular` |
| 112 | `menu` | `IconMenu2` | `List` | `NavigationRegular` |
| 113 | `panelLeft` | `IconLayoutSidebar` | `SidebarSimple (fill)` | `PanelLeftFilled` |
| 114 | `panelRight` | `IconLayoutSidebarRight` | `SidebarSimple (fill, mirrored)` | `PanelRightFilled` |
| 115 | `splitHorizontal` | `IconLayoutColumns` | `SquareSplitHorizontal` | `SplitVerticalRegular` |
| 116 | `splitVertical` | `IconLayoutRows` | `SquareSplitVertical` | `SplitHorizontalRegular` |
| 117 | `ellipsis` | `IconDots` | `DotsThree` | `MoreHorizontalRegular` |
| 118 | `collapseAll` | `IconFold` | `ArrowsInLineVertical` | `ArrowMinimizeVerticalRegular` |
| 119 | `account` | `IconUserCircle` | `UserCircle` | `PersonCircleRegular` |
| 120 | `explorer` | `IconFiles` | `Files` | `DocumentMultipleRegular` |
| 121 | `circleFilled` | `IconCircleFilled` | `Circle (fill)` | `CircleFilled` |
| 122 | `panelLeftOff` | `IconLayoutSidebarInactive` | `SidebarSimple` | `PanelLeftRegular` |
| 123 | `panelRightOff` | `IconLayoutSidebarRightInactive` | `SidebarSimple (mirrored)` | `PanelRightRegular` |

---

## Appendix B. Harness hook contract

"Union (wave 1)" lists the two alternatives W1-HARNESS's scope-level `pickSelector` chooses between: the hook if any element in the scope carries it, else the legacy selector (8.2). The pair is never handed to `querySelector` or `closest()` as one comma list. "Final" is what W4-HARNESS keeps. "Hook added by" is the package that owns the markup when the hook lands. `ROOT` is `[data-cv-settings]`. Harness paths are under `scripts/verify/`.

| # | Harness use | Today | Markup today | Hook added by | Union (wave 1) | Final (wave 4) |
|---|---|---|---|---|---|---|
| B1 | Settings root (`lib/settings-flows.mjs:16-21`, used by `backup-flows.mjs`) | finds `[data-dialog-content]` whose `h2` is `Settings` and sets `data-cv-settings` | `SettingsDialog.tsx:189-192` | `data-cv-settings` on the panel (W3-SETTINGS) | mark function returns early when `[data-cv-settings]` exists | `[data-cv-settings]` |
| B2 | Settings nav (`settings-flows.mjs:48`, `backup-flows.mjs:29`) | `ROOT .w-52 button` | `SettingsNav.tsx:71` | `data-cv-settings-nav` (W3-SETTINGS; the `w-52` class stays until wave 4) | `ROOT .w-52 button, ROOT [data-cv-settings-nav] button` | `ROOT [data-cv-settings-nav] button` |
| B3 | Save and Cancel (`settings-flows.mjs:52`) | `ROOT > div:last-child button` | `SettingsDialog.tsx:217-232` | `data-cv-dialog-footer` (W1-PRIMITIVES `Dialog`, used by W3-SETTINGS) | `ROOT > div:last-child button, ROOT [data-cv-dialog-footer] button` | `ROOT [data-cv-dialog-footer] button` |
| B4 | Sync tab status (`settings-flows.mjs:73-75`) | `.bg-well.border`, `p.font-medium`, `p.text-xs` | `SyncTab.tsx:48-50` | `data-cv-sync-status`, `-label`, `-detail` (W3-SETTINGS) | `pickSelector` hook, else legacy | hooks |
| B5 | Devices (`settings-flows.mjs:77-79`) | `.divide-y > div`, `p.text-sm`, `p.text-xs` | `SyncDevicesList.tsx:35-46` | `data-cv-device-row`, `data-cv-device-name`, `data-cv-device-line` (W3-SYNC) | `.divide-y > div, [data-cv-device-row]` and the same for name and line | hooks |
| B6 | Sync notices (`settings-flows.mjs:81-84,119`) | `.bg-amber-500\/10` | `SyncNoticeList.tsx:30` | `data-cv-sync-notice` (W3-SYNC) | `.bg-amber-500\/10, [data-cv-sync-notice]` | hook |
| B7 | Paused note (`settings-flows.mjs:85`) | `p.text-amber-400` | `SyncTab.tsx:91` | `data-cv-sync-paused` (W3-SETTINGS) | `p.text-amber-400, [data-cv-sync-paused]` | hook |
| B8 | Inline errors (`flows.mjs:97`, `password-flows.mjs:10`, `settings-flows.mjs:144-145`, `sync-dialogs.mjs:55`) | `[data-dialog-content] .text-red-400`, `p.text-red-400` | `UnlockDialog`, `ChangePasswordDialog`, `InlineError` (`PasswordFields.tsx:40-47`) | `data-cv-error` on the error `<p>` (W1-PRIMITIVES `Callout`/`FormField`; applied by W3-VAULT and W3-SYNC) | `… p.text-red-400, [data-dialog-content] [data-cv-error]` | `[data-dialog-content] [data-cv-error]` |
| B9 | Sync dialogs (`flows.mjs:43-48`, `sync-flows.mjs:16-22`) | `[role=dialog]` | `SyncDialogFrame.tsx:53-55`, `ConflictReviewPanel.tsx:89-91` | `Dialog harnessLabel` (W1-PRIMITIVES) | `[role=dialog][aria-label]` (8.3) | same |
| B10 | Scoped sync clicks (`sync-flows.mjs:72,88,98`) | `[role=dialog] button` | sync dialogs | none | `[role=dialog][aria-label] button` | same |
| B11 | Review rows (`sync-flows.mjs:134-138`, `suites/mcp.mjs:227-231`) | `button.closest('.rounded-md')`, `row.querySelector('span')`, `.font-mono` | `ConflictFieldRow.tsx:62-67,156-158`, `ConflictItemView.tsx:70` | `data-cv-review-field`, `data-cv-review-field-label`, `data-cv-review-value` (W3-SYNC) | `.rounded-md, [data-cv-review-field]`; label `[data-cv-review-field-label], span`; value `[data-cv-review-value], .font-mono` | hooks |
| B12 | Close review (`sync-flows.mjs:171`) | `… button[aria-label="Close"]` | `ConflictReviewPanel.tsx:103` | the `Dialog` close keeps `aria-label="Close"` | unchanged | unchanged |
| B13 | Open review (`flows.mjs:180-181`) | `button[title="Review changes from your other devices"]` | `PersonalSyncIndicator.tsx:55-61` → status bar | `title` kept + `data-cv-review-button` (W2-STATUSBAR) | `button[title="Review changes from your other devices"], [data-cv-review-button]` | hook |
| B14 | Review banner (`flows.mjs:183-186`) | page text `/need(s)? review/`, then `button` exactly `Review` | `SyncBanner` | none; the banner keeps its text and its `Review` button | unchanged | unchanged |
| B15 | Banners (`ui-forms.mjs:83-85,97-101`) | `[role=status]`, `span.flex-1`, `button` | `SyncBanner.tsx:30-45` | `role="status"` + `span.flex-1` kept, `data-cv-banner-text` added (W2-WORKBENCH) | `span.flex-1, [data-cv-banner-text]` | `[data-cv-banner-text]` |
| B16 | Open the side bar (`team-flows.mjs:39-40`) | `button[title="Open sidebar (Ctrl+B)"]`, then wait for `button[title="Close sidebar (Ctrl+B)"]` | `PaneTabBar.tsx:350`, `SidebarWindowControls.tsx:30` | activity bar Vault item `data-cv-sidebar-toggle` + `aria-expanded` (W2-ACTIVITYBAR, same titles kept); panel `data-sidebar-panel` exists (`SidebarPanel.tsx:41`) | click `[data-cv-sidebar-toggle][aria-expanded="false"]` or the old title; wait for `[data-sidebar-panel]` or the old close title | hooks |
| B17 | Vault menu (`team-flows.mjs:46`) | `clickText(vaultName, {selector: 'button[title]'})` | `Sidebar.tsx:311-323` | `data-cv-vault-switcher` (W2-SIDEBAR) | `pickSelector('[data-cv-vault-switcher]', 'button[title]')` | `[data-cv-vault-switcher]` |
| B18 | Recently deleted rows (`sync-panels.mjs:28-30`) | `.max-h-80 label`, `p.text-sm`, `p.text-xs` | `RecentlyDeletedPanel.tsx:17-21,124` | `data-cv-deleted-list`, `data-cv-row-title`, `data-cv-row-detail` (W3-SYNC) | `.max-h-80 label, [data-cv-deleted-list] label`; title and detail unions | hooks |
| B19 | Stacked confirm (`sync-panels.mjs:78,82`) | `[data-dialog-content] h2` text; `.z-\[70\] [data-dialog-content] button` | `RecentlyDeletedPanel.tsx:130-131` + `ConfirmDialog` | `data-cv-layer="stacked"` (W1-PRIMITIVES; applied by W3-SYNC) | `.z-\[70\] [data-dialog-content] button, [data-cv-layer="stacked"] [data-dialog-content] button` | hook |
| B20 | Other copies (`sync-panels.mjs:98-101,134`) | `.border-b` rows, `p.text-sm` (+ `title`), `p.text-xs`, `.closest('.flex.items-start')` | `OtherCopiesPanel.tsx:48-52` | `data-cv-copy-row`, `data-cv-row-title` (keeps `title` = path), `data-cv-row-detail` (W3-SYNC) | unions of each | hooks |
| B21 | Mass change (`sync-panels.mjs:191-193`) | `label span.text-ink` | `MassChangeNotice.tsx:119,129` | `data-cv-row-title` (W3-SYNC) | `span.text-ink, [data-cv-row-title]` | hook |
| B22 | Backup toggles (`backup-flows.mjs:13-19,113`) | label → `.closest('.justify-between')` → `:scope > button` | `BackupTab.tsx:68,251` | `data-cv-toggle-row` on the row; the toggle is the `Switch`, with the markup rules in B39 (W3-SETTINGS) | `.justify-between, [data-cv-toggle-row]` | hook |
| B23 | Backup files (`backup-flows.mjs:76-78`) | `.border-b` rows, `span.block`, `span.text-\[10px\]` | `BackupTab.tsx:189-196` | `data-cv-backup-row`, `data-cv-backup-name`, `data-cv-backup-meta` (W3-SETTINGS) | unions of each | hooks |
| B24 | Cloud backup (`backup-flows.mjs:110-116`) | `label` → `.closest('.space-y-3')`, badge `span` | `BackupTab.tsx:250-260` | `data-cv-cloud-backup-section` (W3-SETTINGS) | `.space-y-3, [data-cv-cloud-backup-section]` | hook |
| B25 | Backup Manager (`backup-flows.mjs:180-184`) | `[data-dialog-content]` with `h2` `Backup Manager` → sets `data-cv-backup-manager` | `BackupManagerDialog` | `data-cv-backup-manager` on the panel (W3-VAULT) | mark function returns early when the hook exists | hook |
| B26 | Recent vaults (`suites/lifecycle.mjs:184-186`) | `button[title$=".conduit"]`, `button[title="{path}"]` | `VaultHub` recent rows | `title` = path kept (W3-VAULT) | unchanged | unchanged |
| B27 | Screen detection (`flows.mjs:30-35`) | body text `Loading...`, hub text, auth text | `App.tsx:962-971`, `VaultHub`, `AuthScreen` | the minimal title bar adds no text (W2-TITLEBAR) | unchanged | unchanged |
| B28 | Idle lock (`settings-flows.mjs:11`, `suites/lifecycle.mjs:276`) | `select[aria-label="Lock the vault when idle"]` | `IdleLockSetting.tsx:47` | `Select` keeps `aria-label` (W3-SYNC) | unchanged | unchanged |
| B29 | Labeled fields and checkboxes (`ui-forms.mjs:28-38,61-69`) | `label` + first `span` + inner control; `label` + `input[type=checkbox]` | `PasswordFields.tsx:16-37`, checkbox rows | `FormField` and `Checkbox` structure (W1-PRIMITIVES) | unchanged | unchanged |
| B30 | Password and name inputs (`flows.mjs:24-25`, `lifecycle-flows.mjs:10-11`, `settings-flows.mjs:136-138`, `password-flows.mjs:9`, `backup-flows.mjs:200`) | `input[placeholder=…]` for exactly: `Enter master password`, `Confirm master password`, `Enter new vault name`, `Enter current password`, `Enter new password`, `Confirm new password`, `Master password` | `UnlockDialog`, `ChangePasswordDialog`, the rename dialog, `BackupManagerDialog` | placeholders kept verbatim (W3-VAULT, W3-SETTINGS) | unchanged | unchanged |
| B31 | Form submit (`flows.mjs:26`, `lifecycle-flows.mjs:12`, `sync-flows.mjs:13`, `settings-flows.mjs:140`, `suites/backup.mjs:211`) | `[data-dialog-content] form button[type=submit]` | dialogs with forms (`UnlockDialog.tsx:245-387` wraps header, body and footer in one form) | `Dialog onSubmit` renders one `<form data-cv-dialog-form>` around header, body and footer, so the footer's `type="submit"` button is inside it (W1-PRIMITIVES; every form dialog in W3 uses it) | unchanged | unchanged |
| B32 | App menu (`ui-forms.mjs:126-142`) | `Menu.getApplicationMenu()` labels | `main.ts:400-674` | the application menu and its labels stay (W2-MAIN) | unchanged | unchanged |
| B33 | Toasts (`ui-forms.mjs` `overlayPage`, `clickToastAction`) | overlay window URL contains `overlay.html`; `overlay:action-clicked` | `overlay-manager.ts:110-114` | unchanged (W2-MAIN) | unchanged | unchanged |
| B34 | Unscoped exact labels | `button` with text `Review`, `Use here instead`, `Lock Current Vault`, `New Vault`, `Not Now`, `Open Vault File` | dialogs and the hub | chrome text rules (8.4) | unchanged | unchanged |
| B35 | Busy texts as readiness signals (`sync-flows.mjs:63-64`, `flows.mjs:97`, `sync-dialogs.mjs:95`, `sync-panels.mjs:27,97,159,188`) | page or dialog text contains `Opening...`, `Please wait...`, `Checking...`, `Loading...`, `Looking for copies...`, `Comparing...` | `TakeoverDialog.tsx:49`, `UnlockDialog.tsx:381`, `EpochPromptDialog.tsx:81`, `RecentlyDeletedPanel.tsx:118`, `OtherCopiesPanel.tsx:103`, `CandidateMergeDialog.tsx:118`, `MassChangeNotice.tsx:108` | the texts stay verbatim as visible text inside the dialog: `Button loading loadingLabel="…"` and `Spinner text="…"` (W1-PRIMITIVES; kept by W3-SYNC and W3-VAULT) | unchanged | unchanged |
| B36 | Sync plan line (`settings-flows.mjs:76`; asserted at `suites/lifecycle.mjs:336,350`) | the first `<p>` whose text starts with `Your plan:` | `SyncTab.tsx` | `data-cv-sync-plan` on that `<p>`, text kept (W3-SETTINGS) | `[data-cv-sync-plan]` else `p` starting with `Your plan:` | hook |
| B37 | Sync tab ready (`settings-flows.mjs:72,94`) | an `h3` with text `Multi-device sync` | `SyncTab.tsx` | `SectionHeader` keeps the `h3` and the exact text (W3-SETTINGS) | unchanged | unchanged |
| B38 | Sync notice text (`settings-flows.mjs:81-84`) | the notice's first `p` | `SyncNoticeList.tsx:30` | `data-cv-sync-notice-text` on the text element (W3-SYNC) | `[data-cv-sync-notice-text]` else `p` | hook |
| B39 | Backup toggle markup (`backup-flows.mjs:13-19,110-116`) | a `<label>` whose text is exactly `Local Backup` or `Cloud Backup`, in a row that holds the toggle as a direct child (`:scope > button`) | `BackupTab.tsx:68,251` | the title stays a `<label>` with its exact text and the `Switch` stays a direct child of the row, with `data-cv-toggle="local\|cloud"` (the SettingsRow exception in 4.13) (W3-SETTINGS) | toggle: `[data-cv-toggle]` else `:scope > button` | hook |
| B40 | Backup files list (`backup-flows.mjs:76-77`) | `<label>` `Backup Files (N)` → `parentElement` holds the rows | `BackupTab.tsx:189-196` | `data-cv-backup-files` on the list container; the label keeps its text (W3-SETTINGS) | `[data-cv-backup-files]` else the label's `parentElement` | hook |
| B41 | Cloud backup badge (`backup-flows.mjs:115`) | the first `span` of the `Cloud Backup` label's `parentElement` | `BackupTab.tsx:250-260` | `data-cv-cloud-backup-badge` on the badge (W3-SETTINGS) | `[data-cv-cloud-backup-badge]` else that `span` | hook |
| B42 | Backup Manager controls (`backup-flows.mjs:198-205`) | text buttons `Restore`, `Confirm`, `Close` (exact) and `input[placeholder="Master password"]` inside `[data-cv-backup-manager]` | `BackupManagerDialog` | labels and placeholder kept (W3-VAULT) | unchanged | unchanged |
| B43 | Vault menu items (`team-flows.mjs:47`) | `button` with the exact text `Lock Current Vault` | `VaultSwitcherMenu.tsx` | DOM `Menu` items are `<button type="button" role="menuitem">` (W1-PRIMITIVES; W2-SIDEBAR, W3-VAULT) | unchanged | unchanged |
| B44 | Recent vault rows (`suites/lifecycle.mjs:184-186`) | `button[title$=".conduit"]`, `button[title="{path}"]` | `VaultHub` recent rows | clickable `ListRow` renders a `<button>`; the `title` stays the path (W1-PRIMITIVES, W3-VAULT; extends B26) | unchanged | unchanged |
| B45 | Visibility filter (`ui.mjs:85-88`) | clicks skip elements with `visibility: hidden` or no client rects | every clickable | hover-revealed actions hide with `opacity: 0` only (W1-PRIMITIVES `ListRow`, all W3) | unchanged | unchanged |
| B46 | Radios (`sync-dialogs.mjs:98-106`) | `label` with the exact option text containing `input[type=radio]` | sync dialogs | `Radio` renders `label > input[type=radio]` + text (W1-PRIMITIVES, W3-SYNC) | unchanged | unchanged |

Kept attributes that other code already relies on: `data-dialog-content`, `data-tabbar`, `data-sidebar-panel`, `data-docked`, `data-content-area`, `data-context-menu`, `data-popover`, `data-toast`, `data-bare`, `data-session-keyboard`.

New hooks, all harness-safe (none uses `role=dialog` or `role=status`):

- window and title bar: `data-cv-window`, `data-cv-titlebar`, `data-cv-command-center`, `data-cv-layout`, `data-cv-app-menu`, `data-cv-caption`;
- activity bar and side bar: `data-cv-activitybar`, `data-cv-activity`, `data-cv-sidebar-toggle`, `data-cv-vault-switcher`;
- editor: `data-cv-editor-card`, `data-square-bottom-left`, `data-square-bottom-right`, `data-cv-tab`, `data-cv-new-tab`;
- status bar and banners: `data-cv-statusbar`, `data-cv-status`, `data-cv-review-button`, `data-cv-banner-text`;
- primitives: `data-cv-dialog-footer`, `data-cv-dialog-form`, `data-cv-layer`, `data-cv-error`, `data-cv-text-button`;
- the B-table hooks above (B35 to B46 included: `data-cv-sync-plan`, `data-cv-sync-notice-text`, `data-cv-toggle`, `data-cv-backup-files`, `data-cv-cloud-backup-badge`);
- Appearance: `data-cv-appearance`, `data-cv-choice`.

---

## Appendix C. What's New entry

W4-DOCS adds these highlights to the pending release's entry in `release-notes/manifest.json`, the file the app fetches from `main` (`useReleaseNotes.ts:4-11`). If the pending release has no entry yet, W4-DOCS creates one with the release version and date. The text avoids em dashes (repo style for new text).

```json
{
  "title": "A New Look",
  "summary": "Conduit gets a VS Code style workspace with a new Modern color scheme, a choice of icon packs, and a compact layout.",
  "highlights": [
    { "text": "**A cleaner workspace**: a custom title bar, an activity bar, floating panels and a status bar, modeled on VS Code's 2026 design.", "category": "feature" },
    { "text": "**Modern color scheme**: new default dark and light colors from VS Code 2026. Ocean, Ember, Forest, Amethyst, Rose and Midnight are still available.", "category": "feature" },
    { "text": "**Pick your icons**: choose Codicons, Lucide, Tabler, Phosphor, Fluent or Material Symbols in Settings > Appearance.", "category": "feature" },
    { "text": "**Compact density**: remove the gaps and rounded corners between panels to give sessions more room.", "category": "feature" },
    { "text": "**VS Code style tabs**: the active tab joins its session, and a tab shows a dot only while its connection is not ready.", "category": "improvement" },
    { "text": "**Always-visible status bar**: sync state, changes to review, offline mode, trial days and the FreeRDP build now live in one bar.", "category": "improvement" },
    { "text": "**Easier to read and use from the keyboard**: stronger text contrast in every color scheme and a visible focus ring on every control.", "category": "improvement" },
    { "text": "**Platform themes retired**: the macOS, Windows and Ubuntu themes give way to the new layout. Your icon style carries over as an icon pack.", "category": "improvement" }
  ],
  "hasMedia": false
}
```

A demo GIF (`release-notes/v<version>/demo.gif`, with `hasMedia: true`) is optional and left to the owner.

---

## Review log (2026-09-28)

Three adversarial reviews (fidelity against VS Code 1.139, native behavior against Electron 44.4.5, and the work plan) raised 54 issues. Each was checked against the installed VS Code 1.139 files, the Electron 44.4.5 sources, the repo and the harness before it was applied. 53 were accepted (four with changes) and 1 was rejected; two accepted issues had one sub-point rejected. "Where" names the sections that changed.

### Fidelity

| # | Sev. | Issue | Resolution | Where |
|---|---|---|---|---|
| F1 | high | Editor tab and activity bar text used legacy keys that Modern UI ignores | Accepted. Active tab `#EDEDED` in Modern dark; `--c-tab-fg-unfocused` and its rule deleted (Modern UI keeps the unfocused active tab identical); new `--c-tab-fg-hover` and hover rule; active activity icon `#EDEDED`, new `--c-activity-fg-hover` | 2.2.3, 3.4, 3.6 |
| F2 | high | Contrast gates skipped the tab strip, tone tints and selected rows | Accepted with changes. New gates 2 to 4 and 6; Ocean light `--c-tab-fg: #5C6C82`; the selected-row re-scope redeclares the `--color-*` theme variables too, because Tailwind resolves them on `:root` [V test-compile]; tone tints 12% → 10% (danger measured 4.48 on its Ocean dark tint); light success darkened to `#4B6A0A` instead of adding a separate strong token. Also found: with exact `color-mix()`, Forest dark faint and muted measured 4.49, so both moved one step | 2.2.4, 2.3, 2.11, D-16 |
| F3 | medium | Status bar hover kept dim text; no pressed state | Accepted. `--c-statusbar-hover-fg`, `--c-statusbar-active`, `tabular-nums`, gated | 2.2.3, 3.10 |
| F4 | medium | Drop and info colors were registry defaults | Accepted. 2026 theme values | 2.2.3, 2.2.4 |
| F5 | medium | Dialog titles 14px; message detail color | Accepted. 13px/600 with VS Code margins; message boxes use `ink-muted` | 2.4, 4.8 |
| F6 | medium | Some Modern text colors came from Dark/Light Modern | Accepted. Modern light `ink-secondary` `#202020`; dark `ink-muted` `#9D9D9D` tagged [ADAPT]; menus use `ink-secondary` | 2.2.1, 2.11, 4.10, 7.7 |
| F7 | medium | Focus rings drawn outside and clipped | Accepted. Inset by default; 2px outside only for text buttons, checkboxes and radios | 2.7, 4.2, 4.3, 4.6 |
| F8 | medium | Top-edge resizer strip missing on Windows/Linux | Rejected. Electron 44.4.5 tests the resize border before any drag region (`native_window.cc:747-766`, `win_frame_view.cc:79-133`), and VS Code adds `.resizer` only in its own HTML caption mode. An 8.7 check was added instead | 3.2, 8.7 item 3 |
| F9 | medium | Scrollbars 10px | Accepted. 8px, as Modern UI | 2.8 |
| F10 | medium | Legacy map missed uppercase headers, `text-base`, `text-xl` | Accepted. New rows; the legacy script reads class strings only (`passwordGenerator.ts` has an `uppercase` option) | 4.16, W1-PRIMITIVES |
| F11 | low | Token gaps (menu danger hover, code blocks, new states) | Accepted. `--c-code-bg`, `--c-menu-danger-hover-bg`, `--c-sash-grip`, `--c-indent-guide` and the F1/F3 tokens | 2.2.3, 4.16, 7.7 |
| F12 | low | Sash grip dots and per-OS cursors missing | Accepted | 3.3 |
| F13 | low | Tree indent guides, leaf twistie slot, rename style | Accepted | 3.5 |
| F14 | low | Banners were an untagged deviation | Accepted with changes. Info and lock tones use VS Code's neutral banner and underlined link actions; the warn tint and text wrapping are tagged [ADAPT] | 3.9 |
| F15 | low | Layout controls should swap glyphs, not show a pressed fill | Accepted. `panelLeftOff` and `panelRightOff` in all six packs (123 names); Lucide's hidden state uses the dashed glyphs, Material's glyphs are named by action | 3.2, 5.1, 5.3, App. A |
| F16 | low | Editor actions not dimmed in unfocused panes | Accepted | 3.6 |
| F17 | low | Linux mono stack | Accepted. VS Code's stack, generic `monospace` unquoted | 2.4 |
| F18 | low | Light warning color | Accepted: `#895503`. The optional `--c-warning-icon` was rejected: VS Code's light `#B69500` is 2.77:1 on `#FAFAFD`, below the 3:1 non-text gate | D-16, 2.2.4 |
| F19 | low | 14px pill icon and 8px dot break the size policy | Accepted. Named 14px exception, pill icon at `.8`, dots are the 16px `circleFilled` | 3.2, 3.10, 5.2 |
| F20 | low | Several numeric values | (a) `shadow-md` kept, (b) count badge metrics, (d) `+` margins, (e) toast placement and slide, (f) caption hover colors, (g) panel tab colors: accepted. (c) rejected: Modern UI sets action labels to `cornerRadius.small` (4px), so the tab close radius was right; the same check showed `IconButton` md/lg at 6 was wrong, now 4 | 2.5, 2.6, 3.2, 3.6, 4.3, 4.7, 4.12, 4.15, 7.6, D-24 |
| F21 | low | Untagged deviations | Accepted. D-20 tagged; dialogs no longer animate; Compact tab height tagged | D-20, D-25, 2.6, 2.9, 4.8 |
| F22 | low | "Controls rely on fill plus border" was false; Switch off track invisible | Accepted. Known limits rewritten; Switch off state on the checkbox tokens and gated | 2.11, 4.6 |

### Native

| # | Sev. | Issue | Resolution | Where |
|---|---|---|---|---|
| N1 | high | Remote pages can drag the frameless window | Accepted. User-origin `no-drag` stylesheet on every web-session `dom-ready`; macOS manual check | D-27, 3.7, 7.4, R21, W2-MAIN, W2-WORKBENCH |
| N2 | high | Linux left-side caption buttons, Windows RTL | Accepted with changes. Leading and trailing reserves from the overlay rect on both OSes (the rect mirrors by itself), clamped with a 0/138 fallback, rather than a fixed Windows 138 plus an RTL switch | 2.5, 3.2, 8.7 item 2 |
| N3 | medium | Split and Compact sash hit areas overlap native views | Accepted. Every sash is 4px in the layout flow; Compact `chromeWidth` is 44 when docked | 2.9, 3.3, 3.6, 3.8 |
| N4 | medium | `setTitleBarOverlay` throws without an overlay | Accepted. `overlayActive` guard, try/catch, state event to the fallback | 3.2, 7.2, 7.4 |
| N5 | medium | Zoom startup race; dev zoom leaks into overlay and picker | Accepted. `zoomFactor` + `zoomMode: 'isolated'` at creation for all three windows; synchronous `zoomFactor()` on the preload bridge | 3.2, 6.2, 7.1, 7.4, 7.6 |
| N6 | medium | Popup shadow margin shifted the menu and ate clicks | Accepted. Visible-rect flip and clamp, margin clicks dismiss | 7.7, W2-MENUS |
| N7 | medium | Radius lost on radius-only changes, sub-tabs, one-corner panes | Accepted. Radius in the renderer key, applied per view on every attach, per-corner card squaring | D-17, 3.7 |
| N8 | medium | Wayland ignores window positions | Accepted (option A). Linux runs under XWayland with a `CONDUIT_OZONE=wayland` opt-out; the desktop-entry flag is the dependable path, the in-process switch is [A] | D-26, 7.1, 7.7, 8.7 item 8, R22 |
| N9 | medium | RDP resize churn | Accepted. `RdpView` debounce and last-requested check (W2-TABS owns it in wave 2); `chromeWidth` set in the same task as the density | 3.3, 3.7, R5 |
| N10 | medium | Caption fallback decided once after one second | Accepted. Reactive decision, rendered inside the reserve; Help menu escape hatch | D-8, 3.2, 7.1 |
| N11 | low | Hidden-menu accelerators already work | Accepted. Renderer accelerator fallback, `menu-commands.ts`, `window_chrome_menu_command` and `setMenuBarVisibility(false)` dropped; popup coordinates now [V] | D-8, 7.1, 7.3 |
| N12 | low | No keyboard path to the app menu | Accepted. F10 and a lone Alt, outside session keyboards | 3.2, W2-WORKBENCH |
| N13 | low | Maximized/snapped positioning untested | Accepted. 8.7 item 9; stale `manager.ts` comment rewritten | 3.7, 8.7 |
| N14 | low | Space budget "Today" column counted the OS title bar | Accepted with changes. Per-OS columns; recomputed, Comfortable still loses height on macOS (634 → 594, −6.3%) and slightly on Windows (−2.8%), so the reviewer's "roughly neutral on macOS" does not hold | 3.3 |

### Plan

| # | Sev. | Issue | Resolution | Where |
|---|---|---|---|---|
| P1 | high | Shared foundations had no owner in waves 2 and 3 | Accepted. W2-FOUNDATION and W3-FOUNDATION (W3 owns everything outside the wave-3 directories); `preloadAllIconPacks`, `getPackMapping` and `<Icon pack>` added to W1-ICONS; `tabs.css` to W2-TABS, `cards.css`/`sash.css` to W2-WORKBENCH | 5.1, 10, 10.6 |
| P2 | high | Dialog footer outside the form | Accepted. `Dialog onSubmit` wraps header, body and footer in one form | 4.1, 4.8, B31 |
| P3 | high | Hidden cross-package dependencies in wave 2 | Accepted. TitleBar takes props; W2-STATUSBAR depends on W2-TITLEBAR (`useZoomFactor`); W2-SIDEBAR moves `handleHome` to `layout/openHomeTab.ts` | 3.2, 3.4, 3.10, 10.2 |
| P4 | high | ConfirmDialog could render under the sync panel | Accepted. W3-SYNC depends on W3-MISC; `ConfirmDialog` renders in place without a layer (`portal` prop) until W4-CLEANUP | 4.8, 10.3, 10.4 |
| P5 | high | Wave-3 suite lists missed dependencies | Accepted. Full `npm run verify` before every wave-3 merge | 8.5, 10.3 |
| P6 | high | Comma unions do not prefer the hook | Accepted. Scope-level `pickSelector`, mixed-fixture tests | 8.2, App. B, R23 |
| P7 | medium | Busy texts could disappear | Accepted. B35, `loadingLabel`, `Spinner text` | 4.2, 4.12, B35 |
| P8 | medium | Harness DOM dependencies missing from Appendix B | Accepted. B30 lists every placeholder; B36 to B46; SettingsRow toggle exception | 4.1, 4.10, 4.13, 4.14, App. B |
| P9 | medium | Broken intermediate states in wave 2 | Accepted. One integration branch; manual checks in W2-WORKBENCH | 8.5, 10 rule 3 |
| P10 | medium | Migration gate read the merged settings | Accepted. Raw reads, temp-dir integration test, behavior parity test | 6.3, 8.1 |
| P11 | medium | Two senders and two names for the color sync | Accepted. `window-chrome.ts` is the only sender, driven by `conduit:appearance-applied` | 2.12, 3.2, 6.2, 7.2 |
| P12 | medium | Freeze checks proved nothing | Accepted. W4-CLEANUP removes the legacy hold with a 24-overlay test; W1-FREEZE check and unit test use a sync dialog without Settings | 8.1, 10.1, 10.4 |
| P13 | medium | No legacy-class check in wave 2 | Accepted. Each wave-2 package checks its files that have no wave-3 owner | 10.2 |
| P14 | low | W2-MAIN's smoke run never used the app menu | Accepted. `password lifecycle` | 8.5, 10.2 |
| P15 | low | Acceptance commands not runnable in zsh or not decisive | Accepted. `git grep` pathspecs (the unquoted `--include` was reproduced failing in zsh), `check-owns.mjs`, a chunk loop, an eslint count, S1 to S3 by hand; the misleading "not edited" notes corrected | 10 |
| P16 | low | No underline Tabs variant (OD-7) | Accepted. `Tabs variant="underline"` with `--c-tab-underline`; no screen uses it at launch | 2.2.3, 4.7 |
| P17 | low | Menus icon-less at the wave-2 boundary | Accepted. W3-MENUS moved to wave 2 as W2-MENUS | 5.6, 7.7, 10.2 |
| P18 | low | Electron code importing `src/` breaks its tsconfig | Accepted. Electron never imports from `src/`; cross-tree tests live in `scripts/__tests__` or read JSON with `fs` | 2.5, 6.3, 8.1 |
