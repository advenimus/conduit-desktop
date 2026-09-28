# Conduit visual restyle: implementation spec

Status: ready to build. Written 2026-09-28 against branch `advenimus/visual-restyle` at `41d9657`, where wave 1 of the earlier redesign plan has landed (tokens, schemes, primitives, icon registry, freeze registry, harness hooks, migration) and the app still has today's layout; revised the same day after an owner-intent review and a plan review (Review log at the end). The restyle ships in the pending desktop release (PR #13).

This spec replaces the earlier redesign spec, which rebuilt Conduit's layout as a copy of VS Code (custom title bar with a search pill, activity bar, status bar, floating cards, a reorganized side bar) and made Codicons, VS Code's own icons, the default. The owner rejected that build on 2026-09-28:

> "Hold up, you've made it like an exact clone of vscode! I just wanted the styling and look. Now theres no vault access, a pointless title bar, etc. You dead ass copied icons from vscode as well! I said new icon packs lol"

The request was always about the look: tabs, buttons and spacing similar to the new VS Code look, and new icon packs that can be changed in Settings, with a refreshed default. This spec keeps every part of today's layout and every feature where it is, and changes only how things look. The clone's branches (`advenimus/visual-redesign`, `redesign/w2-*`, `redesign/wave-2`, `redesign/w3-foundation-1`) are not built on; section 9.2 lists the few commits salvaged from them.

The document is self-contained. An engineer who has not read the earlier spec or the research can build any work package from it.

Tags used below:

| Tag | Meaning |
|---|---|
| [V] | Verified while writing this spec: code read, command run, package unpacked, or VS Code 1.139 file read. |
| [A] | Assumption. The package that relies on it checks it. |
| [ADAPT] | A deliberate difference from VS Code 1.139. The reason is given next to it. |
| [BEFORE nn] | A reference shot of today's app (section 3.1), for example [BEFORE 07] is `dark-07-main-split-sidebar-pinned.png` and its light twin. |
| OD-n | A fixed owner decision (1.1). Do not reopen. |
| D-n | A decision made by this spec (1.2). |

Paths written `<scratchpad>` mean `/private/tmp/claude-501/-Volumes-SSD-Storage-Orca-Workspaces-conduit-desktop-unlimited-mcp-free/8e769676-5d49-487b-92cc-bf1b85c9a47d/scratchpad`.

---

## 0. Summary

- **Restyle, not redesign.** Today's layout stays exactly: the native OS title bar, the side bar with every control (vault switcher, favorites, new entry, new folder, search, tree, onboarding and trial cards, footer with item count, sync indicators, Home, Settings and account), the PR #12 pin and auto-hide behavior, one tab bar per pane with its hamburger, `+` popup and AI toggle, splits and drag and drop, the right-docked AI panel, the banners, the StartupStatus strip, every dialog and screen. Section 3 fixes that layout as hard rules and gives the new styling of each existing component. Behavior stays too: tabs shrink to fit as today and keep their close buttons, every dialog closes exactly as it does today (3.12.1), banner actions stay buttons.
- **The look** is inspired by VS Code 1.139's Modern UI without copying its structure or its colors: connected tabs inside today's tab bars, 26px buttons and inputs with 4px radii, 22px list rows, 8px-radius menus, dialogs and toasts, neutral gray selection, the system font at 13px, inset focus rings, 8px scrollbars. The **Modern** gray scheme is the default, with Conduit's own sky accent (D-25); the six universal schemes stay.
- **Icons.** No VS Code icons anywhere: Codicons, their codegen, their package and their attribution go. Six packs are selectable in Settings > Appearance: **Lucide** (the new default, bundled), Phosphor, **Hugeicons** (new; `@hugeicons/core-free-icons@4.3.5`, MIT, checked in 5.10), Material Symbols, Fluent and Tabler ("Classic", today's icons). Users of the retired macOS, Windows and Ubuntu themes keep the pack they saw; everyone else gets Lucide. Custom entry icons that have a semantic twin follow the pack (5.11).
- **Kept from wave 1:** tokens and schemes with their contrast gates, the retirement of the broken platform themes, the system font, the primitives in `src/components/ui/`, the ref-counted native-view freeze registry that keeps dialogs above web pages, the icon registry and pack switching, the harness hooks, the migration machinery. **Removed:** everything that only served the clone: density, card and gap tokens, title bar, activity bar, status bar and command center tokens, `ui_density`, `title_bar_style`, the counter-zoom variable, the glyph-swap button mode.
- **Salvaged** from the abandoned wave 2: the popup context menu restyle and hardening (W2-MENUS), the shared 8px state dot, the Material Symbols padding fix and two smaller style fixes (9.2).
- **Layout identity is tested, not eyeballed only.** An opt-in harness suite rebuilds the reference screens (signed-in and team states included), compares a DOM inventory of every control against today's app, checks geometry rules, fails on any clone part, checks all six icon packs in every window, and writes before and after images side by side (8.6).
- **The owner sees the work early.** Owner gate 1 (the six packs in the real app) closes wave 1 and owner gate 2 (the restyled chrome, before and after) closes wave 2, before most of the work is built; gate 3 is the final review (8.5).
- **Work** is 24 packages in 4 waves with disjoint file ownership per wave (section 10). `npm run verify` runs in the four integrator steps; wave-3 packages that touch harness-bound markup run targeted live suites.

---

## 1. Decisions and non-goals

### 1.1 Owner decisions (fixed)

| ID | Decision |
|---|---|
| OD-1 | A visual refresh similar to the new VS Code look: its tabs, buttons and spacing. The look is borrowed, the layout is not. |
| OD-2 | Keep today's layout and features exactly: the native OS frame and title bar (no custom title bar, no title bar overlay, no menu button), the side bar with every one of its controls, the PR #12 pin and auto-hide behavior, the pane tab bars with the hamburger, the `+` popup and the AI toggle where they are, splits and drag and drop, the right-docked AI panel, the banners, the StartupStatus strip, dialogs and screens. No activity bar, no status bar, no search pill, no card shell with gaps, no moved or removed controls, no new navigation. |
| OD-3 | Change only the look, inspired by (not copied from) the new VS Code: tab shape, sizes, padding and states (for example the connected active tab and the close button's behavior); button sizes, radius and padding; spacing rhythm; list and tree rows; inputs; dialogs; menus; toasts; colors (the Modern gray scheme as the default); typography (system font, 13px); focus rings; scrollbars. Structure stays; styling changes. |
| OD-4 | New icon packs, changeable in Settings, with a refreshed default. No VS Code icons: Codicons are removed with their codegen, dependency and attribution. The default is Lucide. The packs are Lucide, Phosphor, Hugeicons, Material Symbols, Fluent and Tabler ("Classic", today's icons). Users of the retired platform themes keep a sensible pack; everyone else defaults to Lucide. |
| OD-5 | Keep the wave-1 foundation (tokens, the Modern scheme, universal schemes, retirement of the platform themes, the system font, the primitives, the freeze registry, the icon registry and pack switching, harness hooks, migration machinery). Drop what only served the cloned shell. |
| OD-6 | Salvage from the abandoned wave 2 the popup menu restyle and hardening, the shared 8px state dot and style-only fixes. Never bring back the title bar, activity bar, status bar, workbench cards, editor card, AI side bar store or side bar restructuring. |
| OD-7 | Carried from the earlier spec: the platform themes and their six native schemes stay retired; the six universal schemes stay; Modern is the default; the one-time migration runs in the main process and before first paint. |
| OD-8 | Carried: the OS system font stack at 13px, 12px buttons and labels, 11px metadata, 10px badges, weights 400 and 600 only. Terminal fonts do not change. |
| OD-9 | Carried: all tests and the 41-scenario `/verify` harness keep passing. Stable `data-cv-*` hooks replace class selectors in the harness. |
| OD-10 | Carried: WCAG AA for text; visible keyboard focus on every control. |
| OD-11 | Carried: `docs/FEATURES.md` and the What's New source (`release-notes/manifest.json`) are updated the way the repo does it. |

### 1.2 Decisions made by this spec

| ID | Decision | Why |
|---|---|---|
| D-1 | **Structure is frozen.** No component moves, no control is added, removed, hidden or reordered, and no existing title, `aria-label`, placeholder or visible text changes (icon-only buttons that have no name gain one, D-20; labels drawn in CSS `uppercase` show their own capitalization, 8.4). The one added control is the Icon pack picker that OD-4 asks for (5.8). Styling happens in place: class changes, primitives swapped in where the element already is, and the CSS files of section 2. | OD-2, OD-3. The layout inventory check (8.6) fails on any structural change. |
| D-2 | **Connected tabs inside today's bar.** Each pane keeps its tab bar. Tabs take a "connected" look: the active tab is filled with the session surface color and joins the session below with rounded top corners and curved shoulders; inactive tabs sit on the strip color and show a rounded hover fill. The bar is 33px. Tabs keep today's sizing: they shrink to fit the pane, the label truncating first, down to a 78px floor (icon, dot and close stay whole); only when every tab is at the floor does the strip scroll. [ADAPT] The active fill starts 4px below the strip top instead of at it, because Conduit's strip sits directly under the accent line and the banners, not inside a bordered card. | VS Code 1.139's default tab style is `connected` [V `workbench.experimental.modernUIEditorTabStyle` default]; its tabs keep their width and scroll, which would push tabs out of view in a split with the AI panel open [BEFORE 18], so Conduit keeps its own shrink-to-fit. One style, no pill option. |
| D-3 | **Tab close buttons stay visible on every tab**, as today: drawn in `--c-tab-fg` at rest and `--c-tab-fg-active` on the active or hovered tab, with the toolbar hover fill under the pointer. Tab widths never change on hover. | OD-2 forbids hidden controls; today every tab shows its × [BEFORE 10, 10b]. VS Code's hover-only close is an open owner question (gate 1, 8.5), not adopted. |
| D-4 | **The tab status dot stays for every state** (connected, connecting, disconnected) in today's position after the title, with today's tooltip. It is drawn as the shared 8px state dot (5.4) in the state token colors. [ADAPT] VS Code has no connection state; its dirty dot swaps with the close button, which would hide the state of the active tab. | OD-2 keeps features: the green connected dot is information today [BEFORE 10]. |
| D-5 | **The three top rows line up.** The side bar header, every pane tab bar and the AI panel header are 33px tall, so their bottom edges form one line. | Today they are 52, 36 and about 50px, and they do not line up [BEFORE 07, 18]. |
| D-6 | **Neutral selection.** Selected tree rows, the active tab and menu highlights use neutral grays; the accent marks primary buttons, focus rings, links, badges, progress, the 2px top accent line and connection state only. | VS Code 2026 "Focus" principle [V theme values]. Today the tree selection is an accent pill and the active tab an accent tint. |
| D-7 | **One density.** `ui_density`, `data-density`, the Compact variant, `density.css` and every density token are removed; the few metrics the restyle needs (tab strip 33, tab 24, list inset 4) become plain tokens. | Density only existed to remove the clone's card gaps (OD-5). |
| D-8 | **No window chrome work.** The native frame stays on every OS. `title_bar_style`, the `--c-zoom` counter-zoom variable and every title bar, caption and overlay plan are dropped. The only main-process changes are the popup menu window (7.1) and the window background color (7.2). | OD-2. None of the clone's main-process code landed on this branch [V: `electron/ipc/window-chrome.ts`, `electron/services/window-chrome/` and `src/lib/window-chrome.ts` do not exist]. |
| D-9 | **Lucide is the default pack and ships in the entry chunk**; the other five packs are lazy chunks. | The default must draw on the first frame with no load. A research bundle of 108 Lucide glyphs measured 38 KB raw and 11 KB gzip [V `<scratchpad>/iconlab/bundle.json`]; the Codicons module it replaces in the entry chunk is 75 KB of source (`src/lib/icons/generated/codicons.ts`). |
| D-10 | **Hugeicons ships from `@hugeicons/core-free-icons@4.3.5`** (the official free set, MIT), one subpath import per glyph, rendered by a local adapter (5.2). `@hugeicons/react` is not used. | The official data is plain `[tag, attributes]` arrays [V]. The adapter emits only attributes that the popup menu sanitizer keeps (the `@hugeicons/react` component adds a `color` attribute to every `<svg>` [V `HugeiconsIcon.js`], which the sanitizer drops, so the "icons pass the sanitizer unchanged" test would fail), and it needs no runtime package. Subpath imports keep dev and test startup from parsing the 676 KB index module [V `dist/esm/index.js`]. |
| D-11 | All icon libraries stay **devDependencies**. | The renderer is bundled by Vite and nothing under `electron/` or `mcp/` imports them [V grep, carried]. `@hugeicons/core-free-icons` is 80.4 MB unpacked [V `npm view`], so it must never reach `app.asar`. |
| D-12 | **`circleFilled` is one shared 8px disc in every pack** (salvage of `588e2ad`, 5.4). | Each pack's own filled circle is 12 to 13px in a 16px box, so state dots would change size with the pack. |
| D-13 | **Popup context menus stay in the HTML child window** (`electron/ipc/menu.ts`), restyled and hardened by the W2-MENUS salvage (7.1): 24px rows, 8px-radius panel, icons from the active pack, escaped labels, index-based selection, an SVG allowlist. | The child window floats above native web views without freezing them. The owner asked for new icon packs in menus too. |
| D-14 | **The migration stays version 2.** Version 2 never shipped [V: neither `main` nor PR #13's branch `advenimus/unlimited-mcp-free` contains `electron/services/appearance-migration.ts`]. A stored `codicons` fails validation and becomes `lucide`; the retired keys `platform_theme`, `ui_density` and `title_bar_style` are deleted on every read (6.3). | No second migration is needed for development profiles. |
| D-15 | **Toast window geometry is unchanged**: 400 × 500 DIP, 16px from the content corner, `p-4 gap-2` inside (`overlay-manager.ts:33-35`, `OverlayApp.tsx:79`). Only the toast cards restyle. [ADAPT] VS Code toasts are up to 450px wide and sit 8px from the edge. | OD-2: where toasts appear is layout [BEFORE 36]. |
| D-16 | **The 2px accent line under the title bar stays**, and so does its twin at the top of the floating side bar, colored `--c-accent`. | Today's layout reference keeps it (INVENTORY section 1) [BEFORE 07]. |
| D-17 | **Favorite stars get their own token**, `--c-favorite` (yellow, 2.2.4). | Today they use `text-yellow-400`; the legacy report would otherwise turn them into warning amber. |
| D-18 | **Dialogs keep today's width.** The `Dialog` primitive gains a `width` prop (4.8) so every dialog keeps its current maximum width while taking the primitive's radius, surface, padding, typography and footer. | Width is part of the layout reference; the look does not need other widths. |
| D-19 | **Surfaces directly under a tab strip use `--c-editor`**: terminals, RDP and VNC views, the web session toolbar, sub-tab and autofill bars, document and command headers, dashboards, empty panes. | The connected active tab is filled with `--c-editor`; the surface below must be the same color for the tab to join it. |
| D-20 | **Styling hooks are `data-*` attributes** (`data-active`, `data-selected`, `data-drop-target`, `data-dragging`). The restyle adds no ARIA widget role (`tab`, `treeitem`) to a component that has no matching keyboard model. Icon-only buttons that have no accessible name today get one (`aria-label` plus a native `title`), which adds no visible text. | A style-only change must not promise keyboard behavior it does not implement; INVENTORY section 11 lists the unnamed buttons. |
| D-21 | **`Popover freeze="auto"` probes `[data-cv-session-area]`**, which every pane's content container carries (3.5), instead of the clone's `[data-cv-editor-card]`. | Native web views live only inside pane content. No app code uses `Popover` yet [V grep], so nothing regresses before the hook exists. |
| D-22 | **The native window background follows the scheme** (`backgroundColor` at creation, after Settings save and on OS theme changes). | Today it is the old Ocean navy `#0f172a` for every scheme (`main.ts:709`), which flashes while a window is resized over a gray Modern UI. |
| D-23 | **Seven semantic icon names retire**: `panelLeft`, `panelLeftOff`, `panelRight`, `panelRightOff`, `collapseAll`, `account`, `explorer`. 116 names remain: today's 111 plus `menu` (the hamburger), `splitHorizontal` and `splitVertical` (tab menu), `ellipsis` (the tree's "Open With" item, old key `dots`) and `circleFilled` (state dots). | The seven only served the title bar and the activity bar [V grep: used only in the gallery and its tests]. |
| D-24 | `font-medium`, `font-semibold` and `font-bold` all map to 600 (carried). | OD-8. |
| D-25 | **Modern keeps VS Code's neutral grays but takes Conduit's own accent**: the sky ramp that Ocean uses (500 `#0EA5E9`, primary buttons 700 `#0369A1`), with Ocean light's text-safe 300 and 400 in light mode (2.2.2). Every contrast gate of 2.10 holds [V computed]. The owner confirms it at gate 1 (8.5). | VS Code's exact accent blue on top of its grays, font, row heights and connected tabs would make the default look read as VS Code at first glance, the impression the owner rejected. |
| D-26 | **Every dialog keeps today's close behavior**: Escape, an outside click and a close button each work exactly where they work today, and nowhere else (3.12.1). The `Dialog` primitive gains `closeOnEscape` and draws its close button only where a dialog has one today (`hideClose` elsewhere); a dialog that cannot be dismissed (the recovery passphrase) passes neither `onClose` nor Escape. | Moving every dialog onto one primitive would otherwise add Escape and a close button to mandatory flows and drop outside-click closing from eight dialogs. |
| D-27 | **Banner actions stay buttons**: `Button size="sm"` (22px) inside the 26px row, `primary` where today's action is primary; the offline banners keep their centered text and `Reconnect` button. | Key actions such as `Use here instead` and `Review` must stay prominent; VS Code's underlined link actions are not adopted. |
| D-28 | **`App.tsx`'s legacy freeze and the legacy event bridge stay in this release.** Every overlay also holds its own freeze, and a test proves it (R4-CLEANUP); removing the legacy hold is a follow-up after the restyle ships. | Removing it changes the behavior that keeps native web pages from drawing over dialogs (the 32b bug) inside a release that only changes the look; the extra hold is harmless. |
| D-29 | **Custom entry icons with a semantic twin follow the pack.** The 30 curated Tabler names that the Tabler pack maps from a semantic name (5.11) render through the active pack; the other 35 (brands and the rest) stay Tabler. Stored names never change. | With Lucide as the default, custom icons drawn in Tabler next to Lucide icons would make the pack switch look incomplete in the tree, the most visible icon surface. |

### 1.3 Non-goals (this release)

- Every clone part: custom title bar, window controls overlay, menu button, search pill, activity bar, status bar, floating cards and gaps, Compact density, an editor card, an AI side bar store with persisted width, a side bar without its footer, the Account menu, new shortcuts (Ctrl/Cmd+P, Ctrl/Cmd+Alt+B, F10 or Alt for the menu), the Linux XWayland switch, rounded web views, the remote-page drag-region stylesheet.
- Behavior fixes the clone made for its own layout: the RDP resize debounce (`0305304`, `a97cda2`), the content-size fallbacks. The restyle changes session sizes by a few pixels only (the tab bar goes from 36 to 33px, banners from about 32 to 26px).
- Keyboard models for the tree and the tabs (arrow keys, roving focus). The tree and tabs stay mouse-first as today; their buttons stay reachable with Tab.
- A pill tab style, high-contrast themes, a right-to-left layout.
- Bumping icon packages other than adding Hugeicons (Lucide stays 1.48.0, Tabler 3.38.0, Phosphor 2.1.10, Fluent 2.0.321, Material Symbols Light 1.2.94 [V `node_modules`]).
- Custom entry icons without a semantic twin following the pack: the 35 brand and other curated icons stay Tabler in every pack, and every stored name stays a Tabler name in vault data (`src/components/entries/iconRegistry.ts`, 5.11).
- Terminal fonts, xterm padding and the ANSI palette (`terminalTheme.ts`).
- Toasts and popup menus following `ui_scale` (unchanged today).
- Any change of visible text, including the em dashes and arrows in today's strings.
- Any change of how a dialog closes (D-26) and hover-only tab close buttons (D-3; an open owner question).
- A "Third-party licenses" view in the About dialog: shipping the license file inside the app meets the license terms (5.9), and a new control would break D-1.
- Removing `App.tsx`'s legacy freeze and the legacy event bridge (D-28): a follow-up after the release.
- The terminal fit fix of `006661f` (skip fits while a terminal is hidden, so the PTY keeps its width). It is a behavior fix, not style; whether today's app has the bug is unverified [A]. It is tracked as its own change outside this release.

### 1.4 Baseline: the branch today

| Area | Fact | Source |
|---|---|---|
| Layout | Today's layout, identical in structure to the pure original app (`advenimus/unlimited-mcp-free` at `270ae43`) except the Appearance tab: the Platform Theme block is gone and Modern is the first color scheme card. | `git diff 270ae43...41d9657 -- src/components` [V] |
| Tokens | `src/styles/{tokens,schemes,density,base}.css`, `components/{cards,tabs,sash}.css`, `metrics.ts`, gated by `src/styles/__tests__/tokens-cascade.test.ts`. Modern is the default scheme. | [V read] |
| Primitives | 30-odd primitives in `src/components/ui/` with a dev-only gallery. No app code uses them yet, except `src/components/sync/useEscapeLayer.ts`, a re-export. | [V grep] |
| Freeze | `src/lib/native-freeze/` registry. `App.tsx` holds a `legacy` freeze for its 24 overlay flags and a `sidebar` freeze for the floating side bar; `SyncDialogFrame`, `ConflictReviewPanel`, `ConfirmDialog` and `DragContext` hold their own. | `App.tsx:386-406` [V] |
| Icons | Six packs, Codicons default and statically imported (`pack-cache.ts`), 123 semantic names, Codicons and Material Symbols from a codegen (`scripts/icons/`), license file `public/licenses/third-party-icons.txt`. | [V read] |
| Appearance | `src/lib/appearance/`: pre-paint `boot-inline.js` (sets class, `data-scheme`, `data-density`, `data-os`, `--c-zoom`), `useAppearance`, migration table version 2 in the renderer and the main process. | [V read] |
| Settings | `color_scheme` (default `modern`), `theme`, `icon_pack` (default `codicons`), `ui_density`, `title_bar_style`, `appearance_version: 2`. Settings > Appearance has no icon pack picker. | `electron/ipc/settings.ts:63-128`, `AppearanceTab.tsx` [V] |
| Popup menus | `electron/ipc/menu.ts`: 210px panels, 30px rows, `Inter`, 25 hard-coded Tabler paths, labels and ids interpolated into HTML unescaped. | [V read] |
| Harness | `scripts/verify/lib/selectors.mjs` pairs every class selector with a `data-cv-*` hook through `pickSelector`; dialog detection reads `[role=dialog][aria-label]`. | [V read] |
| Tests | `npx vitest run`: 250 files, 2919 tests, 3 failures, all in `src/App.test.tsx` (`window.electron.on` is undefined in `useBackupStates`). Both `tsc` runs are clean. `node scripts/redesign/lint-count.mjs` prints 0. | run 2026-09-28 [V] |
| Build | There is no `build:electron` script; the full build is `npm run build`. | `package.json` [V] |

### 1.5 What the clone added, and what happens to it

| Clone part (earlier spec) | On this branch? | Restyle |
|---|---|---|
| Title bar, command center, window controls, native mode (W2-TITLEBAR, W2-MAIN) | No | Dropped. Settings keys `title_bar_style` and tokens `--c-titlebar-*`, `--c-cc-*`, `--c-traffic-reserve`, `--c-wco-*`, `--c-zoom` removed (9.1). |
| Activity bar (W2-ACTIVITYBAR) | No | Dropped with its tokens `--c-activity*` and icon names `account`, `explorer`. |
| Status bar (W2-STATUSBAR) | No | Dropped. Sync indicators stay in the side bar footer, trial days in the side bar, FreeRDP progress in the StartupStatus strip. |
| Workbench cards, sashes with grips, Compact density (W2-WORKBENCH) | Tokens and CSS only | Dropped: `density.css`, `cards.css`, the grip, card and gap tokens, `metrics.ts`. |
| Editor card, web view corner radius, RDP resize debounce (W2-TABS) | No | Dropped. The connected tab CSS is rewritten for today's bar (3.4). |
| AI side bar store and part title (W2-AI) | No | Dropped. The AI panel keeps `App.tsx` state; its header restyles in place (3.7). |
| Side bar restructure, footer removal, `openHomeTab` move (W2-SIDEBAR) | No | Dropped. The side bar restyles in place (3.6). |
| Popup menu restyle and hardening (W2-MENUS) | No | **Salvaged** (7.1, 9.2). |
| Shared state dot, Material trim, Callout dismiss, banner divider (wave 2 fixes) | No | **Salvaged** (9.2). |
| Lessons from wave-2 fixes: the tab strip's hidden scrollbar (`8f53108`), the vault switcher's focus room (`4780b8c`), the drop overlay above xterm's scrollbar (`6528862`) | No | Folded into 2.6, 3.4 and 3.6. |

---

## 2. Design tokens

Wave 1 built the token layer; this section is its contract after the restyle's cleanup (R1-FOUNDATION). Everything not listed here that `src/styles/` defines today is removed (9.1). Numbers come from the installed VS Code 1.139.0 (`/Applications/Visual Studio Code.app`, commit `2242ebbb`) unless a line says otherwise.

### 2.1 File layout and the cascade

Precedence comes from specificity, never from file order (the platform CSS that wave 1 deleted never applied, because it was imported before `:root` with equal specificity [V, carried]):

| Layer | Selector | Specificity | File |
|---|---|---|---|
| Mode-independent base | `:root` | (0,1,0) | `src/styles/tokens.css` |
| Mode base (Modern primitives and the formulas the universal schemes derive from) | `:root.dark`, `:root.light` | (0,2,0) | `src/styles/tokens.css` |
| OS font stacks | `:root[data-os="macos"]` etc. | (0,2,0) | `src/styles/tokens.css` (defines only `--c-font-*`) |
| Scheme, per mode | `:root[data-scheme="ocean"].dark`, `.light`, … | (0,3,0) | `src/styles/schemes.css` |
| Modern exact values | `:root[data-scheme="modern"].dark, :root:not([data-scheme]).dark` (and `.light`) | (0,3,0) | `src/styles/schemes.css` |

`src/index.css` after R1-FOUNDATION:

```css
@import "tailwindcss";
@import "./styles/tokens.css";
@import "./styles/schemes.css";
@import "./styles/base.css";
@import "./styles/components/tabs.css";
@import "./styles/components/sash.css";
@plugin "@tailwindcss/typography";
@custom-variant dark (&:where(.dark, .dark *));
@theme { /* 2.9 */ }
```

`density.css`, `components/cards.css` and the `compact` custom variant are deleted.

**Guard test** (`src/styles/__tests__/tokens-cascade.test.ts`, kept and trimmed): compile `src/index.css` with the repo's `@tailwindcss/postcss`, walk the PostCSS AST and assert:

1. No selector contains `data-platform` or `data-density`.
2. Every rule that sets a `--c-*` color token for a named scheme matches `^:root\[data-scheme="(modern|ocean|ember|forest|amethyst|rose|midnight)"\]\.(dark|light)$` (plus the two `:root:not([data-scheme])` Modern selectors).
3. For each of the 7 schemes × 2 modes, the resolver (specificity-ordered merge, `var()` substitution, exact floating-point `color-mix(in srgb, …)` evaluation) resolves every token of the contract (2.2) to a color.
4. The contrast gates of 2.10 hold.
5. None of the removed tokens (9.1) is defined anywhere.

### 2.2 Token contract and Modern values

Every token below resolves in every scheme and mode. "Base formula" is what the six universal schemes get from `:root.dark` / `:root.light`; "Modern" is the exact value in the Modern block. VS Code sources are 1.139 theme keys resolved from `extensions/theme-defaults/themes/2026-{dark,light}.json` [V].

#### 2.2.1 Primitive surfaces, text and borders

| Token | Modern dark | Modern light | VS Code source | Notes |
|---|---|---|---|---|
| `--c-canvas` | `#121314` | `#FFFFFF` | `editor.background` | Legacy name, kept for existing `bg-canvas`. |
| `--c-panel` | `#191A1B` | `#FAFAFD` | `sideBar.background` | Legacy name. |
| `--c-raised` | `#2B2C2D` | `#E6E6E9` | `list.hoverBackground` composited on the side bar | Opaque hover for legacy `bg-raised`. |
| `--c-well` | `#121314` | `#F2F2F2` | dark `editor.background`; light `modernActivityBarItem.hoverBackground` | Recessed areas: segmented tracks, preview wells. |
| `--c-ink` | `#EDEDED` | `#202020` | `list.activeSelectionForeground` / `foreground` | Emphasis: titles, selected rows. |
| `--c-ink-secondary` | `#BFBFBF` | `#202020` | 2026 `foreground` | Default body and control text. |
| `--c-ink-muted` | `#9D9D9D` | `#606060` | [ADAPT] dark: Dark Modern `descriptionForeground`; light: 2026 `descriptionForeground` | Descriptions, labels. |
| `--c-ink-faint` | `#8C8C8C` | `#6B6B6B` | 2026 dark `descriptionForeground`; [ADAPT] light `#6B6B6B` (VS Code's `#999999` fails AA) | Metadata, placeholders. At least 4.5:1. |
| `--c-ink-disabled` | `#555555` | `#BBBBBB` | `disabledForeground` | Disabled controls and decoration only. |
| `--c-stroke` | `#2A2B2C` | `#E4E5E6` | `surface.border` | Surface borders. |
| `--c-stroke-dim` | `#333536` | `#F0F1F2` | `input.border` / `titleBar.border` | |

#### 2.2.2 Accent ramp (`--c-accent-50` … `--c-accent-950`)

Tailwind exposes these as `conduit-*`. 300 = link hover text, 400 = link and active text, 500 = accent fill, ring and border; the primary button and its hover take two adjacent steps between 600 and 800, per scheme (2.3; Modern 700 and 800). In light mode, 300 and 400 hold text-safe shades in every scheme.

**(restyle, D-25)** Modern takes Conduit's sky ramp, the one Ocean uses [V `schemes.css` Ocean blocks], instead of VS Code's blue (`#3994BC` / `#0069CC` before this review). The ramp lives in the mode bases (`:root.dark`, `:root.light` in `tokens.css`), which only Modern reads, since every universal scheme sets its own ramp.

| Step | Modern dark | Modern light | Source |
|---|---|---|---|
| 50 | `#F0F9FF` | `#F0F9FF` | Tailwind sky, as Ocean |
| 100 | `#E0F2FE` | `#E0F2FE` | |
| 200 | `#BAE6FD` | `#BAE6FD` | |
| 300 | `#7DD3FC` | `#075985` | light: the text-safe 800, as Ocean light |
| 400 | `#38BDF8` | `#0369A1` | light: the text-safe 700, as Ocean light |
| 500 | `#0EA5E9` | `#0EA5E9` | the accent line, rings in dark mode, accent fills |
| 600 | `#0284C7` | `#0284C7` | |
| 700 | `#0369A1` | `#0369A1` | primary buttons, badges; the light focus ring |
| 800 | `#075985` | `#075985` | primary button hover |
| 900 | `#0C4A6E` | `#0C4A6E` | |
| 950 | `#082F49` | `#082F49` | |

Contrast on Modern's grays [V computed with an sRGB script during the restyle review; the tokens test of 2.1 re-checks it]: `accent-text` 7.53:1 on the dark overlay and 5.70:1 on the light shell; white on the primary button 5.93:1; `focus` on `selected` over `well` 4.60:1 (dark) and 3.80:1 (light); `info` on `info-bg` 6.29:1 and 4.93:1; `ink-secondary` on `menu-selection-bg` 7.00:1 and 14.18:1.

#### 2.2.3 Layer and component tokens

| Token | Base formula (dark) | Base formula (light) | Modern dark | Modern light | VS Code source |
|---|---|---|---|---|---|
| `--c-shell` | `var(--c-panel)` | `var(--c-canvas)` | `#191A1B` | `#FAFAFD` | `titleBar.activeBackground`; the boot splash and the native window background (7.2) |
| `--c-sidebar` | `var(--c-shell)` | `var(--c-shell)` | `#191A1B` | `#FAFAFD` | `sideBar.background`; the side bar and the AI panel |
| `--c-editor` | `var(--c-canvas)` | `var(--c-panel)` | `#121314` | `#FFFFFF` | `editor.background`; every surface under a tab strip (D-19) |
| `--c-tabstrip` | `color-mix(in srgb, var(--c-panel) 70%, var(--c-raised))` | `color-mix(in srgb, var(--c-canvas) 94%, var(--c-ink))` | `#202122` | `#EAEAEA` | `editorGroupHeader.tabsBackground` (1.139) |
| `--c-overlay` | `color-mix(in srgb, var(--c-panel) 70%, var(--c-raised))` | `var(--c-panel)` | `#202122` | `#FAFAFD` | `editorWidget` / `menu` / `notifications.background` |
| `--c-overlay-border` | `var(--c-stroke)` | `var(--c-stroke)` | `#2A2B2C` | `#E4E5E6` | `menu.border` |
| `--c-card-border` | `var(--c-stroke)` | `var(--c-stroke)` | `#2A2B2C` | `#E4E5E6` | `surface.border`; `Card`, `ChoiceCard`, the vault hub card |
| `--c-divider` | `var(--c-stroke)` | `var(--c-stroke-dim)` | `#2A2B2C` | `#F0F1F2` | `sideBarSectionHeader.border`; side bar edge, footer, banner rows |
| `--c-control-border` | `var(--c-stroke-dim)` | `var(--c-stroke)` | `#333536` | `#D8D8D8` | `dropdown.border` |
| `--c-editor-group-border` | `color-mix(in srgb, var(--c-ink) 9%, transparent)` | `var(--c-stroke)` | `#FFFFFF17` | `#E5E5E5` | `editorGroup.border`; split lines |
| `--c-hover` | `color-mix(in srgb, var(--c-ink) 8%, transparent)` | same | `#FFFFFF14` | `#00000014` | `list.hoverBackground` |
| `--c-selected` | `color-mix(in srgb, var(--c-ink) 13%, transparent)` | `… 14%` | `#FFFFFF22` | `#00000025` | `list.activeSelectionBackground` |
| `--c-selected-inactive` | `color-mix(in srgb, var(--c-ink) 8%, var(--c-sidebar))` | `… 9%` | `#2C2D2E` | `#DADADA99` | `list.inactiveSelectionBackground` |
| `--c-toolbar-hover` | `color-mix(in srgb, var(--c-ink) 20%, transparent)` | `… 12%` | `#5A5D5E50` | `#0000001F` | `toolbar.hoverBackground` |
| `--c-toolbar-active` | `color-mix(in srgb, var(--c-ink) 20%, transparent)` | `… 16%` | `#FFFFFF33` | `#D6D6D8` | `toolbar.activeBackground`; pressed icon buttons (the AI toggle, the pin) |
| `--c-tab-fg` | `var(--c-ink-faint)` | `var(--c-ink-muted)` (Ocean light overrides it, 2.3) | `#8C8C8C` | `#606060` | `tab.inactiveForeground` |
| `--c-tab-fg-active` | `var(--c-ink)` | `var(--c-ink)` | `#EDEDED` | `#202020` | `modernEditorTab.activeForeground` |
| `--c-tab-fg-hover` | `var(--c-ink-secondary)` | `var(--c-ink)` | `#BFBFBF` | `#202020` | `modernEditorTab.hoverForeground` |
| `--c-tab-active-bg` | `var(--c-editor)` | same | `#121314` | `#FFFFFF` | connected tab = `editor.background` |
| `--c-tab-hover-bg` | `color-mix(in srgb, var(--c-ink-secondary) 6%, var(--c-tabstrip))` | same | same formula | same formula | `.modern-ui-connected-editor-tabs … --modern-ui-editor-tab-hover-background` [V] |
| `--c-tab-underline` | `var(--c-accent)` | `var(--c-ink)` | `#0EA5E9` | `#000000` | `panelTitle.activeBorder`; only `Tabs variant="underline"` |
| `--c-input-bg` | `var(--c-well)` | `var(--c-editor)` | `#191A1B` | `#FFFFFF` | `input.background` |
| `--c-input-fg` | `var(--c-ink)` | same | `#BFBFBF` | `#202020` | `input.foreground` |
| `--c-input-border` | `var(--c-control-border)` | same | `#333536` | `#D8D8D866` | `input.border` |
| `--c-input-placeholder` | `var(--c-ink-faint)` | same | `#8C8C8C` | `#6B6B6B` | [ADAPT] VS Code's placeholder colors fail AA |
| `--c-dropdown-bg` | `var(--c-input-bg)` | same | `#191A1B` | `#FFFFFF` | `dropdown.background` |
| `--c-dropdown-border` | `var(--c-control-border)` | same | `#333536` | `#D8D8D8` | `dropdown.border` |
| `--c-checkbox-bg` | `var(--c-input-bg)` | `var(--c-well)` | `#242526` | `#EAEAEA` | `checkbox.background` |
| `--c-checkbox-border` | `var(--c-ink-muted)` | same | `#707070` | `#868686` | `checkbox.border` (at least 3:1) |
| `--c-checkbox-fg` | `var(--c-ink)` | same | `#8C8C8C` | `#606060` | `checkbox.foreground` |
| `--c-btn-primary-bg` | `var(--c-accent-700)` | same | `#0369A1` | `#0369A1` | `button.background` role; Conduit sky 700 (D-25) |
| `--c-btn-primary-hover` | `var(--c-accent-800)` | same | `#075985` | `#075985` | `button.hoverBackground` role; sky 800 |
| `--c-btn-primary-fg` | `#FFFFFF` | same | `#FFFFFF` | `#FFFFFF` | `button.foreground` |
| `--c-btn-secondary-bg` | `transparent` | `var(--c-well)` | `#00000000` | `#EAEAEA` | `button.secondaryBackground` |
| `--c-btn-secondary-fg` | `var(--c-ink-secondary)` | `var(--c-ink)` | `#CCCCCC` | `#202020` | `button.secondaryForeground` |
| `--c-btn-secondary-hover` | `var(--c-hover)` | same | `#FFFFFF10` | `#F2F3F4` | `button.secondaryHoverBackground` |
| `--c-btn-secondary-border` | `var(--c-control-border)` | same | `#333536` | `#EAEAEA` | `button.secondaryBorder` |
| `--c-btn-danger-bg` | `#C72E0F` | same | `#C72E0F` | `#C72E0F` | [ADAPT] `statusBarItem.errorBackground` (light), used in both modes |
| `--c-btn-danger-hover` | `#B42A1A` | same | `#B42A1A` | `#B42A1A` | [ADAPT] darker step |
| `--c-accent` | `var(--c-accent-500)` | same | `#0EA5E9` | `#0EA5E9` | the top accent line, accent fills (D-25) |
| `--c-accent-text` | `var(--c-accent-400)` | same | `#38BDF8` | `#0369A1` | `textLink.foreground` role |
| `--c-accent-text-hover` | `var(--c-accent-300)` | same | `#7DD3FC` | `#075985` | `textLink.activeForeground` role |
| `--c-focus` | `var(--c-accent-500)` | `var(--c-accent-600)` | `#0EA5E9` | `#0369A1` | `focusBorder` role ([ADAPT] opaque; Modern light and five schemes override it, 2.3) |
| `--c-badge-bg` | `var(--c-btn-primary-bg)` | same | `#0369A1` | `#0369A1` | `badge.background` role |
| `--c-badge-fg` | `#FFFFFF` | same | `#FFFFFF` | `#FFFFFF` | `badge.foreground` |
| `--c-menu-selection-bg` | `color-mix(in srgb, var(--c-accent) 15%, transparent)` | `… 10%` | `#0EA5E926` | `#0EA5E91A` | `menu.selectionBackground` role |
| `--c-menu-selection-border` | `var(--c-accent)` | same | `#0EA5E9` | `#0EA5E9` | `menu.selectionBorder` role |
| `--c-menu-danger-hover-bg` | `color-mix(in srgb, var(--c-danger) 10%, transparent)` | same | same formula | same formula | none in VS Code; the active danger item in popup and DOM menus |
| `--c-progress` | `var(--c-accent)` | same | `#0EA5E9` | `#0EA5E9` | `progressBar.background` role |
| `--c-scrollbar-thumb` | `color-mix(in srgb, var(--c-ink-muted) 52%, transparent)` | `… 75%` | `#A8A9AA85` | `#646464C0` | `scrollbarSlider.background` |
| `--c-scrollbar-thumb-hover` | `… 56%` | `… 82%` | `#A8A9AA90` | `#646464D0` | `scrollbarSlider.hoverBackground` |
| `--c-scrollbar-thumb-active` | `… 61%` | `… 88%` | `#A8A9AA9C` | `#646464E0` | `scrollbarSlider.activeBackground` |
| `--c-drop-bg` | `color-mix(in srgb, var(--c-accent) 18%, transparent)` | same | `#0EA5E91A` | `#0EA5E915` | `list.dropBackground` alphas (2026) |
| `--c-code-bg` | `color-mix(in srgb, var(--c-ink) 6%, var(--c-editor))` | same | `#242526` | `#EAEAEA` | `textCodeBlock.background` (2026) |
| `--c-indent-guide` | `color-mix(in srgb, var(--c-ink) 30%, var(--c-sidebar))` | `… 37%` | `#585858` | `#A9A9A9` | `tree.indentGuidesStroke` |
| `--c-scrim` | `rgb(0 0 0 / 0.5)` | same | same | same | [ADAPT] today's `bg-black/50` dialog backdrop |
| `--c-scrim-sidebar` | `rgb(0 0 0 / 0.2)` | same | same | same | today's floating side bar backdrop (`SidebarPanel.tsx:36`) |

#### 2.2.4 Status, connection state, entry-type and favorite colors

Status colors do not change per scheme. They pass 4.5:1 on shell, editor and overlay in both modes, and `danger`, `warning` and `success` also pass 4.5:1 on their own `-bg` tint (2.10).

| Token | Dark | Light | VS Code source |
|---|---|---|---|
| `--c-danger` | `#F48771` | `#AD0707` | `errorForeground` |
| `--c-warning` | `#E5BA7D` | `#895503` | dark `list.warningForeground`; light `problemsWarningIcon.foreground` |
| `--c-success` | `#73C991` | `#4B6A0A` | dark `gitDecoration.addedResourceForeground`; light [ADAPT] darker than `#587C0C` so tone text passes on its tint |
| `--c-info` | Modern `#38BDF8`; base `var(--c-accent-text)` | Modern `#0369A1`; base `var(--c-accent-text)` | `notificationsInfoIcon.foreground` role |
| `--c-danger-bg` / `-border` | Modern `#3A1D1D` / `#BE1100`; base `color-mix(in srgb, var(--c-danger) 10%, var(--c-overlay))` / `color-mix(in srgb, var(--c-danger) 45%, transparent)` | Modern `#FDEDED` / `#AD0707`; base same formulas | `inputValidation.error*` |
| `--c-warning-bg` / `-border` | Modern `#352A05` / `#B89500`; base formulas | Modern `#FDF6E3` / `#B69500` | `inputValidation.warning*` |
| `--c-info-bg` / `-border` | base formulas in every scheme, Modern included (D-25) | base formulas | `inputValidation.info*` role |
| `--c-success-bg` / `-border` | base formulas | base formulas | none |
| `--c-state-connected` | `var(--c-success)` | same | tab dots, sync OK |
| `--c-state-connecting` | `var(--c-warning)` | same | |
| `--c-state-error` | `var(--c-danger)` | same | |
| **`--c-favorite`** (new) | `#FACC15` | `#A16207` | none; today's `text-yellow-400` star in the side bar header and tree (D-17). At least 6.44:1 on any dark side bar or selected row, 3.39:1 on the lowest light pair (a selected row in Modern light) [V computed] |

The base tint is 10%, not 12%: at 12% `danger` on its tint measures 4.48:1 in Ocean dark [V computed, carried].

Entry-type identity colors (unchanged from wave 1): dark keeps Tailwind 400 shades, light uses 700 shades so glyphs reach 3:1 on light side bars.

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

Kept as they are: the team tokens `--c-team-bg`, `--c-team-border`, `--c-team-border-strong` (mixes of `--c-accent-500`) and their Tailwind names `team`, `team-border`, `team-border-strong`.

### 2.3 Universal schemes on the contract

The six universal schemes keep their primitives and wave 1's overrides exactly (`src/styles/schemes.css`), minus the removed tokens (9.1).

| Scheme | Mode | `--c-ink-faint` | `--c-ink-disabled` | `--c-ink-muted` | `--c-accent-300` / `-400` | `--c-btn-primary-bg` / `-hover` |
|---|---|---|---|---|---|---|
| ocean | dark | `#8B98AA` | `#64748b` | unchanged | ramp (`#7dd3fc` / `#38bdf8`) | 700 `#0369a1` / 800 `#075985` |
| ocean | light | `#647185` | `#94a3b8` | `#617188` | 800 `#075985` / 700 `#0369a1` | 700 / 800 |
| ember | dark | `#888078` | `#615850` | unchanged | ramp | 700 `#c2410c` / 800 `#9a3412` |
| ember | light | `#7A7064` | `#9c9286` | unchanged | 800 `#9a3412` / 700 `#c2410c` | 700 / 800 |
| forest | dark | `#7F9089` | `#546860` | `#7B9189` | ramp | 700 `#047857` / 800 `#065f46` |
| forest | light | `#5D7367` | `#8aa496` | unchanged | 800 `#065f46` / 700 `#047857` | 700 / 800 |
| amethyst | dark | `#878296` | `#5e5870` | `#88809C` | ramp | 600 `#7c3aed` / 700 `#6d28d9` |
| amethyst | light | `#6D6885` | `#908aa8` | unchanged | 700 `#6d28d9` / 600 `#7c3aed` | 600 / 700 |
| rose | dark | `#8E8087` | `#685860` | `#957D83` | ramp | 600 `#e11d48` / 700 `#be123c` |
| rose | light | `#81666F` | `#9c828c` | unchanged | 800 `#9f1239` / 700 `#be123c` | 600 / 700 |
| midnight | dark | `#748289` | `#506068` | unchanged | ramp | 700 `#0e7490` / 800 `#155e75` |
| midnight | light | `#5B727D` | `#84a0ac` | unchanged | 800 `#155e75` / 700 `#0e7490` | 700 / 800 |

Focus overrides: Ocean, Ember, Forest and Midnight light set `--c-focus: var(--c-accent-700)`, and so does Modern light (`#0369A1`, D-25); Amethyst dark sets `--c-focus: var(--c-accent-400)`. Ocean light sets `--c-tab-fg: #5C6C82` (4.54:1 on its tab strip) [V computed, carried].

Resolved derived surfaces [V computed, carried]:

| Scheme | Mode | shell / sidebar | editor | tabstrip | overlay | hover on shell | selected on shell |
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

In every scheme the tab strip differs from the editor, so a connected active tab always reads as part of the session, never as part of the strip.

`src/lib/appearance/shell-colors.json` keeps `{scheme: {dark: {shell, fg}, light: {shell, fg}}}` for the boot splash and the window background. `shell` is the resolved `--c-shell`; `fg` becomes the resolved `--c-ink-faint` (it was `--c-titlebar-fg`, which is removed). Only one value changes: Modern light `fg` goes from `#606060` to `#6B6B6B`. The tokens test checks the JSON against the resolved tokens.

### 2.4 Typography

Font stacks (VS Code 1.139 `.monaco-workbench` stacks [V], set on `<html data-os>`, unchanged from wave 1):

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

`Inter` is not used; review screenshots on a machine without Inter installed. Terminals keep `Menlo, Monaco, "Courier New", monospace`.

| Token | Size / line height | Weight | Tailwind | VS Code | Used for |
|---|---|---|---|---|---|
| `--c-text-display` | 26 / 32 | 600 | `text-display` | `fontSize.heading1` | Landing titles (auth, hub, welcome) |
| `--c-text-title` | 18 / 24 | 600 | `text-title`, `text-lg` | `fontSize.heading2` | Page and large section titles |
| `--c-text-heading` | 13 / 18 | 600 | `text-heading` | `fontSize.heading3` | Dialog titles |
| `--c-text-body` | 13 / 18 | 400 | `text-body`, `text-sm` | `fontSize.body1` | Body, tabs, tree rows, inputs, menus |
| `--c-text-label` | 12 / 16 | 400 / 600 | `text-label`, `text-xs` | `fontSize.label1` | Buttons, header titles, section labels |
| `--c-text-meta` | 11 / 16 | 400 | `text-meta` | `fontSize.label2` | Metadata, group labels, counts |
| `--c-text-badge` | 10 / 14 | 400 / 600 | `text-badge` | `fontSize.label3` | Badges |

`body { font-family: var(--c-font-ui); font-size: 13px; line-height: 18px; color: var(--c-ink); }`. The `html` font size stays 16px, so Tailwind spacing stays 4px per unit.

### 2.5 Spacing, radii, sizes

**Spacing.** VS Code's ramp (2, 4, 6, 8, 10, 12, 16, 20, 24, 28, 32, 36, 40px [V]) equals Tailwind's default scale (`0.5` … `10`). Use those classes; no spacing tokens. Rhythm: 4px spacing, 4px control radius, 8px overlay radius, 1px strokes [V usage counts].

**Radii:**

| Token | Value | Tailwind | Use |
|---|---|---|---|
| `--c-radius-xs` | 2px | `rounded-xs` | Rename inputs, checkbox marks |
| `--c-radius-sm` | 4px | `rounded`, `rounded-sm`, `rounded-control` | Buttons, inputs, selects, rows, tab hover fill, icon buttons |
| `--c-radius-md` | 6px | `rounded-md`, `rounded-container` | Cards, callouts, menu items |
| `--c-radius-lg` | 8px | `rounded-lg`, `rounded-overlay` | Menus, dialogs, popovers, toasts, the vault hub card |
| `--c-radius-xl` | 12px | `rounded-xl` | Legacy only |
| `--c-radius-full` | 9999px | `rounded-full` | Count badges, switches |
| `--c-tab-cap-radius` | 5px | (tabs.css) | Connected tab top corners and shoulders (4 + 1 stroke) [V] |

**Control and row sizes** (unchanged):

| Token | Value | Tailwind | Source |
|---|---|---|---|
| `--c-control-h-sm` | 22px | `h-control-sm` | VS Code small button [V] |
| `--c-control-h` | 26px | `h-control` | `.monaco-text-button`, `.monaco-inputbox` [V] |
| `--c-control-h-lg` | 32px | `h-control-lg` | [ADAPT] landing CTAs only |
| `--c-row-h` | 22px | `h-row` | `ITEM_HEIGHT=22` [V] |
| `--c-row-h-2line` | 36px | `h-row-2line` | [ADAPT] rows with a description |
| `--c-icon-sm` / `--c-icon` / `--c-icon-lg` | 12 / 16 / 24px | (props) | VS Code icon sizes [V] |
| `--c-toolbar-btn` | 22px | `size-toolbar` | `.monaco-action-bar .action-label` [V] |

**Layout sizes** (all on `:root`; the density versions are gone):

| Token | Value | Tailwind | Use |
|---|---|---|---|
| `--c-tabstrip-h` | 33px | `h-tabstrip` | Pane tab bars; also the side bar header and the AI header (D-5) |
| `--c-tab-h` | 24px | (tabs.css) | Painted tab body |
| `--c-tab-gutter-top` | 4px | (tabs.css) | Strip space above a tab |
| `--c-tab-min-w` | 78px | (tabs.css) | A tab's floor while tabs shrink to fit: padding 8 + 4, icon 16, dot 12, close 20, three 6px gaps, the label at 0 (D-2) |
| `--c-list-inset` | 4px | (`px-1`) | Row inset in the tree and lists |
| `--c-banner-h` | 26px | `min-h-banner` | Banners (3.8) |
| `--c-part-title-h` | 32px | `h-part-title` | `Tabs` strips (Markdown editor) |
| `--c-section-h` | 28px | `h-section` | The team context bar |

There is no TypeScript mirror of the layout tokens any more: `src/styles/metrics.ts` only fed the clone's chrome math.

### 2.6 Shadows, motion, z-index

| Token | Value | Tailwind | Use |
|---|---|---|---|
| `--c-shadow-sm` | `none` | `shadow-sm` | Flat chrome |
| `--c-shadow-md` | `0 0 6px rgba(0,0,0,.08)` | `shadow-md` | |
| `--c-shadow-overlay` | `0 0 12px rgba(0,0,0,.14)` | `shadow-lg`, `shadow-overlay` | Menus, popovers, toasts, the floating side bar |
| `--c-shadow-modal` | `0 0 20px rgba(0,0,0,.15)` | `shadow-xl`, `shadow-modal` | Dialogs |

| Token | Value | Use |
|---|---|---|
| `--c-motion-open` | 250ms | DOM menus and popovers open; side bar slide-in |
| `--c-motion-close` | 150ms | DOM menus and popovers close; side bar slide-out |
| `--c-motion-fast` | 100ms | Hover colors, sash highlight fade |
| `--c-ease-out` | `cubic-bezier(0.22, 1, 0.36, 1)` | All of the above |
| `--c-sash-delay` | 300ms | Delay before a resize handle lights up on hover |

Under `prefers-reduced-motion: reduce` the three durations are `0ms`.

| Token | Value | Layer |
|---|---|---|
| `--c-z-sticky` | 10 | Sticky elements inside a pane |
| `--c-z-sidebar-scrim` | 30 | Floating side bar backdrop (today `z-30`) |
| `--c-z-sidebar` | 40 | Floating side bar (today `z-40`) |
| `--c-z-dialog` | 50 | Dialogs, layer `base` |
| `--c-z-dialog-sync` | 60 | Dialogs, layer `sync` |
| `--c-z-dialog-stacked` | 70 | Dialogs, layer `stacked` |
| `--c-z-popover` | 80 | Popovers and DOM menus |

The tab drop-zone overlay keeps today's `z-40` inside its pane: xterm's scrollbar has `z-index: 11` in the same stacking context, and the clone's move of the overlay to 10 put the scrollbar above it (fixed by `6528862`) [V diff].

### 2.7 Focus ring

Unchanged from wave 1 (`src/styles/base.css`):

```css
:where(button, [role="button"], [role="tab"], [role="menuitem"], [role="option"], [role="treeitem"],
       [role="switch"], [role="radio"], a, summary, [tabindex],
       input:not([data-bare]), select, textarea):focus-visible {
  outline: 1px solid var(--c-focus);
  outline-offset: -1px;                  /* VS Code default: drawn inside [V] */
}
:where([data-cv-text-button], input[type="checkbox"], input[type="radio"], [data-cv-choice]):focus-visible {
  outline-offset: 2px;                   /* text buttons, checkboxes, choice cards */
}
```

The ring is drawn inside the element because outside rings are clipped by the tab strip (`overflow-y: hidden`), the side bar header and scrolling lists. Composite fields keep `data-bare` on the inner input and draw `focus-within` on the wrapper (the side bar search, the web session URL field). The gallery (4.1) shows every focusable primitive focused inside a `Card` and, except text `Button`s at `md` and `lg`, `Textarea`, `Tabs` and `ChoiceCard`, inside a 33px tab strip.

### 2.8 Other global rules in `base.css`

Unchanged from wave 1: `color-scheme` per mode; macOS font smoothing; `body { user-select: none }` with the input and `.allow-select` exceptions; `::selection` at 35% accent; 8px scrollbars with a transparent track and the thumb tokens (radius 4); `.scrollbar-autohide` fading through `--sb-opacity`; xterm's 4px scrollbar; keyframes `toast-in`, `toast-out`, `sidebar-in`, `sidebar-out`, `indeterminate`, `cv-pop-in`, `cv-pop-out`; the selected-row re-scope:

```css
/* Muted, faint and link text fail AA on a selected row, so the row re-scopes them. Tailwind utilities read
   the --color-* theme variables, which resolve on :root, so both names are redeclared. */
:where([role="option"][aria-selected="true"], [role="treeitem"][aria-selected="true"], [role="row"][aria-selected="true"],
       [role="gridcell"][aria-selected="true"], [data-selected]) {
  --c-ink-muted: var(--c-ink-secondary);   --color-ink-muted: var(--c-ink-secondary);
  --c-ink-faint: var(--c-ink-secondary);   --color-ink-faint: var(--c-ink-secondary);
  --c-accent-text: var(--c-ink);           --color-link: var(--c-ink);
  --c-accent-text-hover: var(--c-ink);     --color-link-hover: var(--c-ink);
}
```

The tree (3.6) sets `data-selected` on its selected rows, so it gets the re-scope without a `treeitem` role (D-20).

### 2.9 Tailwind v4 `@theme` mapping

Wave 1's block, minus the removed entries: `--radius-card`, `--spacing-titlebar`, `--spacing-statusbar`, `--spacing-activitybar` and the `compact` custom variant go. Added: `--color-favorite: var(--c-favorite)`. Kept, among others:

```css
@theme {
  --font-sans: var(--c-font-ui);  --font-mono: var(--c-font-mono);
  --font-weight-medium: 600;  --font-weight-semibold: 600;  --font-weight-bold: 600;
  --text-xs: var(--c-text-label);  --text-sm: var(--c-text-body);  --text-lg: var(--c-text-title);
  /* text-display, text-title, text-heading, text-body, text-label, text-meta, text-badge with line heights */
  --radius: var(--c-radius-sm);  /* and radius-xs … radius-full, radius-control, radius-container, radius-overlay */
  --shadow-sm: var(--c-shadow-sm);  --shadow-md: var(--c-shadow-md);  --shadow-lg: var(--c-shadow-overlay);
  --shadow-xl: var(--c-shadow-modal);  --shadow-overlay: var(--c-shadow-overlay);  --shadow-modal: var(--c-shadow-modal);
  --spacing-control: var(--c-control-h);  --spacing-control-sm: var(--c-control-h-sm);  --spacing-control-lg: var(--c-control-h-lg);
  --spacing-row: var(--c-row-h);  --spacing-row-2line: var(--c-row-h-2line);  --spacing-toolbar: var(--c-toolbar-btn);
  --spacing-tabstrip: var(--c-tabstrip-h);  --spacing-banner: var(--c-banner-h);
  --spacing-part-title: var(--c-part-title-h);  --spacing-section: var(--c-section-h);
  /* legacy colors conduit-50 … 950, canvas, panel, raised, well, ink*, stroke*, team* (unchanged names) */
  /* semantic colors: ink-disabled, shell, sidebar, editor, tabstrip, overlay, overlay-border, card-border, divider,
     control, hover, selected, selected-inactive, toolbar-hover, toolbar-active, accent, link, link-hover, focus,
     badge, code, btn-primary(-hover), btn-danger(-hover), input, input-border, danger(-bg,-border),
     warning(-bg,-border), success(-bg,-border), info(-bg,-border), entry-*, favorite */
}
```

Legacy utilities keep wave 1's re-pointing: bare `rounded` is 4px, `shadow-xl` the modal shadow, `text-sm` 13/18, `text-xs` 12/16, `text-lg` 18/24, `font-medium` 600, `font-mono` the per-OS stack.

### 2.10 Contrast gates

The tokens test enforces these for all 7 schemes × 2 modes, with exact `color-mix()` evaluation and alpha composited on the named surface (carried from wave 1, minus the gates of removed tokens):

1. `ink`, `ink-secondary`, `ink-muted`, `ink-faint`, `accent-text`, `danger`, `warning`, `success`, `info` ≥ 4.5:1 on `shell`, `editor`, `overlay`.
2. Tab text on its own surface ≥ 4.5:1: `tab-fg` on `tabstrip`; `tab-fg-active` on `tab-active-bg`; `tab-fg-hover` on `tab-hover-bg`.
3. Tone text on its own tint ≥ 4.5:1: `danger` on `danger-bg`, `warning` on `warning-bg`, `success` on `success-bg`; `info` on `info-bg` ≥ 3:1.
4. Text in selected rows ≥ 4.5:1: `ink` and `ink-secondary` on `selected` over `sidebar`, and on `selected-inactive` over `overlay` and `sidebar`. Text on inner surfaces: `ink-muted` and `ink-faint` ≥ 4.5:1 on `well` over `shell`, `editor`, `overlay` and `sidebar`; `ink-secondary` ≥ 4.5:1 and `ink-muted` icons ≥ 3:1 on `menu-selection-bg` over `overlay`; `danger` ≥ 4.5:1 on `menu-danger-hover-bg` over `overlay`.
5. White on `btn-primary-bg`, `btn-primary-hover`, `badge-bg`, `btn-danger-bg`, `btn-danger-hover` ≥ 4.5:1.
6. Non-text ≥ 3:1: `focus` (also on `selected` and `selected-inactive` over `overlay` and `sidebar`, and on `selected` over `well`); `checkbox-border` on `shell`, `editor`, `overlay` and `checkbox-bg`; `state-*` and `entry-*` on the surfaces they sit on; **`favorite` on `sidebar` and on `selected` over `sidebar`** (new); `info` on `info-bg`.
7. `ink-disabled` is exempt and never used for enabled text.

Lowest results today [V computed, carried]: `tab-fg` on `tabstrip` 4.53 (Ocean dark), `danger` on `danger-bg` 4.63 (Ocean dark), `ink-faint` on `well` 4.52 (Ocean light), `focus` on `selected` over `well` 3.08 (Rose light), `checkbox-border` on `checkbox-bg` 3.03 (Modern light), `favorite` on `selected` 3.39 (Modern light). Modern's sky accent (D-25) stays above these lows: its lowest accent-derived result is `focus` on `selected` over `well`, 3.80 in light mode (2.2.2).

Known limits: hover fills are not gated; surface borders are decorative; input borders are faint as in VS Code (every input has a visible label).

### 2.11 Reading tokens from JavaScript

`src/lib/appearance/resolveCssColor.ts` (wave 1) resolves any token to `#rrggbb` through a probe element, composites alpha over a surface, and throws for an undeclared token. Callers: `terminalTheme.ts` and `src/utils/contextMenu.ts` (the popup menu colors, 7.1).

---

## 3. The existing layout, restyled

All sizes are CSS px at `ui_scale` 1.0. "Today" means the branch at `41d9657`, whose layout equals the pure original app at `270ae43` (1.4).

### 3.1 The reference set

`<scratchpad>/restyle/before/` holds the layout that must not change. The scratchpad is temporary, so R1-HARNESS first copies the folder to `$HOME/.conduit-verify/restyle-before/` and commits a manifest of its files with their SHA-256 (8.6.1); from then on that folder is the reference.

- 62 dark and 62 light PNGs of the pure original app (`advenimus/unlimited-mcp-free` at `270ae43`), window 1280 × 800 (content 1280 × 768), device pixel ratio 2, real OS window captures (`screencapture -l`), so the native title bar, native web views and popup menu windows are in the images. Look: platform theme "Default (Conduit Classic)", scheme Ocean, Tabler icons. Compare **layout**, not colors or glyphs.
- Shots 44 to 49 (below), the states the first capture could not reach without sign-in (INVENTORY section 10), added by R1-HARNESS: captured the same way on the base branch with scheme Ocean and the Tabler pack, whose side bar, footer, banners and team bar equal `270ae43`'s in structure [V: `git diff 270ae43 41d9657` changes only the scrollbar fade in `Sidebar.tsx` and the freeze calls in `App.tsx`; `VaultContextBar.tsx`, `TeamInvitationBanner.tsx`, `SyncBanner.tsx` and `VaultSwitcherMenu.tsx` are unchanged].
- `INVENTORY.txt`: every visible control per region, with titles and aria-labels, in reading order; `INVENTORY-raw.json`: the DOM dump (54 screens) it was built from.
- Test data: vault "Acme Infrastructure" with folders Production (db-01 SSH, DC-01 RDP, web-01 SSH to `127.0.0.1:1`, so its tab shows the red disconnected dot; favorite) and Staging (Build Mac VNC, Intranet Status web on a local test page; favorite), root items Domain Admin (credential) and Runbook (document); a second empty vault "Scratch". Sessions: Terminal (local shell), Runbook, web-01, and Intranet Status split into a right pane.

| Shot | Screen | Shot | Screen |
|---|---|---|---|
| 00 | Sign-in screen | 21 | Vault switcher menu |
| 01 | Vault hub, no recent vaults | 22 | New Entry type picker |
| 02 | Create vault dialog over the hub | 23 | New SSH entry form |
| 03 | Empty vault welcome (dark: side bar closed; light: pinned) | 24-29 | Edit RDP entry: General, Credentials, Information, Display, Resources, Security |
| 04 | Floating side bar over the welcome (dark) | 30 | New Folder dialog |
| 05 | Two panes, side bar hidden | 31 | Quick Connect dialog |
| 06 | Side bar floating (backdrop, web view frozen) | 32 | Delete confirm (32b light: the web page over the dialog, a bug wave 1 fixed) |
| 07 | Side bar pinned and docked | 33 | Recently deleted panel |
| 08 | Side bar header, 2× crop | 34 | Other copies panel |
| 09 | Side bar footer, 2× crop | 35 | Review changes panel |
| 10 | Both tab bars, side bar docked, 1.5× crop | 36 | Four toasts |
| 10b | Both tab bars with hamburgers, 1.5× crop | 37 | Toasts, 1.5× crop |
| 11 | `+` new-tab popup | 38 | Search "web" with the clear button |
| 12 | `+` popup, 1.5× crop | 39 | Favorites-only filter |
| 13 | Tab context menu | 40 | Home dashboard tab |
| 14 | Tree entry context menu | 41 | Vault hub with a recent vault |
| 15 | Tree folder context menu | 42 | Unlock vault dialog |
| 16, 17 | Entry menu with the Open With and Auto-type submenus | 43 | Document tab (light) |
| 18 | AI panel open | 20-nn | Settings, every tab (`-partN` scrolled) |
| 19 | AI engine dropdown | 44 | Signed in: footer row 2 with the account email and Sign Out (R1-HARNESS) |
| 45 | Sign Out pressed: Confirm and Cancel (R1-HARNESS) | 46 | Cached mode: the offline banner and the footer's `offline` badge (R1-HARNESS) |
| 47 | A team vault open: the tinted header, `VaultContextBar`, the team section of the vault menu (R1-HARNESS) | 48, 49 | The "Try Pro free for 30 days" card; the Pro trial status strip (R1-HARNESS) |

The restyle suite (8.6) reproduces these screens with the same data and names, so each after-shot has a before twin.

### 3.2 Layout invariants

These hold after every package. The restyle suite checks the ones marked (checked).

| # | Invariant | Source today |
|---|---|---|
| L-1 | The native OS frame and title bar; window minimum 1024 × 700. Content bounds are smaller than window bounds (checked). | `electron/main.ts:703-722` [BEFORE 07] |
| L-2 | The main layout starts with a 2px accent line, full width, under the title bar; the floating side bar has its own at its top. The hub and sign-in screens have none. | `App.tsx:1061`, `SidebarPanel.tsx:50` [BEFORE 07, 41] |
| L-3 | Under the accent line, full width: the offline banner (cached auth), then `SyncBanners`. The hub has its own offline banner at the top. | `App.tsx:1062-1075`, `990-1002` |
| L-4 | The main row, left to right: the docked side bar (when docked), the pane area (`SplitContainer`), a 4px AI divider and the AI panel (when open), which pushes the panes left. | `App.tsx:1076-1117` (checked) |
| L-5 | Side bar modes: hidden, floating (fixed overlay from the window top with a dimmed backdrop and frozen web views), docked (pinned and room to spare, pushes the panes). Width default 250, min 200, max 500; resize handle on the right edge. | `sidebarStore.ts:5-8`, `SidebarPanel.tsx` [BEFORE 04, 06, 07] (checked) |
| L-6 | Side bar, top to bottom: header row, team context bar, admin onboarding card, invitation banner, search, tree, trial promotion card, trial status strip, footer row 1, footer row 2. | `Sidebar.tsx:303-590` (checked) |
| L-7 | Header row, left to right: close or hide, pin, vault switcher (name and chevron), then favorites, new entry, new folder at the right. | [BEFORE 08], INVENTORY 2a (checked) |
| L-8 | Footer row 1: item count, then the personal sync, cloud backup and team sync indicators; Home and Settings at the right. Row 2: the local-mode sign-in link, or the account email with the offline badge and Sign Out. | [BEFORE 09], INVENTORY 2h, 2i (checked) |
| L-9 | Each pane has a tab bar: the hamburger at the left while the side bar is not docked open (an invisible spacer while the floating side bar is open), the tabs, then `+` at the right end, then the AI toggle, only in the focused pane. | `PaneTabBar.tsx:332-446`, `App.tsx:1083-1096` [BEFORE 05, 10, 10b] (checked) |
| L-10 | A tab shows its type icon, its title (ellipsis at 120px), its status dot with today's tooltip, and a close button that is always visible. Tabs shrink to fit their bar, the title giving way first; every tab and its close button stay inside the bar in today's layouts (checked, G10). Double-click renames; tabs drag to reorder and to other panes; right-click opens today's menu. | `PaneTabBar.tsx:357-430` [BEFORE 10, 18] |
| L-11 | Pane splits are 4px separators in the layout flow; drop zones overlay a pane while a tab is dragged. | `LayoutRenderer.tsx:44-50`, `DropZoneOverlay.tsx` |
| L-12 | The AI panel: header with the engine picker and the model chip at the left, `+` (new conversation) at the right; the engine dropdown opens under the picker; the body below. Width 400, 300 to 800. | `ChatPanel.tsx:223-284`, `App.tsx:95-99` [BEFORE 18, 19] (checked) |
| L-13 | The StartupStatus strip, while a FreeRDP task shows, is the last row of the window, full width. | `App.tsx:1121` |
| L-14 | Popup menus are separate windows at the pointer (the `+` popup anchored to the right edge of `+`), with today's items, order, headers, separators and submenus. | INVENTORY 4, 5 [BEFORE 11-17] (checked) |
| L-15 | Every dialog and panel keeps its title, content order, controls, labels, placeholders, button order and width. | INVENTORY 7, 8 [BEFORE 20-35, 42] (checked) |
| L-16 | Toasts appear bottom right in the overlay window (400 × 500, 16px inset), up to five stacked. | `overlay-manager.ts:33-35`, `OverlayApp.tsx:79` [BEFORE 36] |
| L-17 | Screens: loading (text exactly `Loading...`), sign-in, onboarding, team auto-connect, vault hub, main. | `App.tsx:952-1057` |
| L-18 | The native application menu is unchanged. | INVENTORY 1 (checked) |
| L-19 | Keyboard shortcuts are unchanged; none is added. | `useKeyboardShortcuts.ts` |
| L-20 | No element of the clone exists: `[data-cv-titlebar]`, `[data-cv-activitybar]`, `[data-cv-statusbar]`, `[data-cv-command-center]`, `[data-cv-card]`, `[data-cv-editor-card]`, `.cv-card`, `.cv-workbench` (checked). | 1.5 |
| L-21 | Every dialog closes exactly as today: Escape, an outside click and a close button work where they work today and nowhere else (unit tests per dialog, 3.12.1). | D-26 |
| L-22 | Banner actions are buttons with today's labels; the primary one stays filled. The offline banners keep their centered text and `Reconnect` button. | `SyncBanner.tsx:33-44`, `App.tsx:1062-1074` (D-27) |
| L-23 | Always-visible information stays always visible: hub row badges, dashboard timestamps and type labels, tab close buttons and status dots. Only what is hover-only today (the hub row chevron) appears on hover. | `VaultHub.tsx:363-373`, `DashboardOverview.tsx:283-291` |

### 3.3 Window frame and accent line

- `BrowserWindow` options are unchanged except `backgroundColor` (7.2).
- The app roots (`App.tsx` main, hub, loading and auto-connect screens) use `bg-editor text-ink` instead of `bg-canvas` (same color in Modern dark).
- The accent line becomes `<div data-cv-accent-line className="h-[2px] shrink-0 bg-accent" />` in `App.tsx` (R2-SHELL) and in the floating side bar (`SidebarPanel.tsx:50`, R2-SIDEBAR). Modern: `#0EA5E9` in both modes (D-25).

### 3.4 Pane tab bars

Today (`PaneTabBar.tsx:332-446`): a 36px `bg-panel` bar with a bottom border, a 44px hamburger column with a right border, tabs with right borders and an accent-tinted active tab in medium weight, 13 or 14px icons, an always-visible 12px close, an 8px dot, and 18px `+` and robot buttons [BEFORE 10, 10b]. Tabs shrink to fit the pane (`min-w-0` with the default shrink, `PaneTabBar.tsx:377`): in a split with the AI panel open, the left pane's three tabs keep their icon, dot and × while their titles shrink to one letter [BEFORE 18].

Restyled: connected tabs inside the same bar (D-2), still shrinking to fit, with every close button visible (D-3).

```
y=0   ┌──────────────────────────────────────────────────────────────────────────────┐  strip: --c-tabstrip
y=4   │ [≡]   ╭─────────────────────╮ ▣ Runbook ● [×]    ▣ web-01 ● [×]      [+] [AI] │
      │       │ ▣ Terminal ●    [×] │                                                 │
y=28  │       │                     │                                                 │
y=33  └───────┘                     └─────────────────────────────────────────────────┘
               active fill (--c-tab-active-bg = --c-editor) from y=4 down to y=33,
               joins the session surface below; 5px top corners, 5px concave shoulders
```

**Parts:**

| Part | Restyled | Keeps |
|---|---|---|
| Strip | `.cv-tabstrip`: 33px (`--c-tabstrip-h`), `--c-tabstrip`, no bottom border, `overflow: hidden`. The session below starts at y=33. | `data-tabbar` |
| Hamburger slot | Rendered under today's rule (not while docked open; transparent spacer while the floating side bar is open), in the strip's first `.cv-tabstrip-slot`. A 44px slot (`w-11`), no border, holding a 22 × 22 box with the pack's `menu` glyph at 16px in `ink-muted`; hover: box `--c-toolbar-hover`, glyph `ink`. While it is a spacer, the box has `opacity-0` and no hover. Hooks: `data-cv-sidebar-toggle`, `aria-expanded` (true while the side bar is open). | Titles `Open sidebar (Ctrl+B)` / `Close sidebar (Ctrl+B)`; click behavior |
| Tabs row | `.cv-tabs`: flex 1, 4px top padding, `overflow-x: auto`, `scrollbar-width: none`. Tabs shrink to fit as today; only when every tab is at its 78px floor does the row overflow. Then a vertical wheel with `deltaX === 0` scrolls it horizontally, and a tab that becomes active calls `scrollIntoView({block: "nearest", inline: "nearest"})`. [ADAPT] VS Code keeps tab widths and draws a 3px overlay scrollbar; Chromium's native one takes 8 to 11px of the strip's height, and any `scrollbar-width` other than `auto` disables `::-webkit-scrollbar` styling (lesson of `8f53108`). | Drag over and drop on the empty strip |
| Tab | `.cv-tab` `data-cv-tab={sessionId}`: 24px tall, `flex: 0 1 auto` with `min-width: var(--c-tab-min-w)` (78px), `padding: 0 4px 0 8px`, gap 6px, 13px regular, no dividers, `cursor: pointer`. Icon, dot and close never shrink; the label is the only part that gives way. Active tab: `data-active`. | Handlers, draggable, context menu; today's shrink-to-fit |
| Icon | 16px. Entry tabs: the entry icon in its entry color (custom icons per 5.11). Other types: `terminal`, `desktop`, `globe`, `fileText`, `playerPlay`, `infoCircle` at 16. The Home dashboard tab: `home` in `--c-accent-text`. | Choice of icon per type |
| Title | `.cv-tab-label`: `flex: 0 1 auto`, `min-width: 0`, `max-width: 120px`, ellipsis. | Text |
| Status dot | A `<span title="…">` (today's tooltip logic) holding `circleFilled` at size 12, which draws the 8px disc (5.4): `--c-state-connected`, `--c-state-connecting` (with `animate-pulse`, none under reduced motion) or `--c-state-error`. | Position after the title; every state (D-4) |
| Close | `IconButton size="sm" tone="inherit"` (20 × 20, `close` at 16px, radius 4, hover fill `--c-toolbar-hover`), class `cv-tab-close`, `label="Close {title}"`. Visible on every tab (D-3): the glyph is `--c-tab-fg` at rest and `--c-tab-fg-active` on the active or hovered tab. | Always visible; click closes; `stopPropagation` |
| Rename input | 20px tall, 13px, `bg-input`, 1px `--c-focus` border, radius 2, `max-width: 120px`, `px-1`, class `cv-tab-rename` (shrinks like the label). | Enter commits, Escape cancels, blur commits |
| Drop marker | `data-drop-target` on the tab: a 2px `--c-accent` bar at its left edge (`::before`), no layout shift. | Same drop logic |
| Dragged tab | `data-dragging`: opacity .5. | |
| `+` | `IconButton md` (22 × 22, `plus` 16), `mx-1`, hook `data-cv-new-tab`, in the strip's last `.cv-tabstrip-slot`, followed by `rightSlot` in the same slot. | `title="New Local Shell"`; the popup (3.13) anchored to its right edge |
| AI toggle | Rendered by `App.tsx` into `rightSlot` as `IconButton md` (`robot` 16), `pressed={showAiPanel}` (pressed look: `--c-toolbar-active` fill, `ink` glyph; today it is highlighted without `aria-pressed`, and 8.6 allows the added attribute), `mr-1`, hook `data-cv-ai-toggle`. | `title="Toggle AI Panel"`; only in the focused pane |

**`src/styles/components/tabs.css`** (R1-FOUNDATION writes it; R2-TABS may tune it):

```css
/* Pane tab bars (spec 3.4) */
@layer components {
  .cv-tabstrip { position: relative; display: flex; align-items: stretch; height: var(--c-tabstrip-h);
                 min-width: 0; overflow: hidden; background: var(--c-tabstrip); }
  .cv-tabstrip-slot { display: flex; flex: none; align-items: center; padding-bottom: 1px; }
  .cv-tabs { display: flex; align-items: flex-start; flex: 1 1 auto; min-width: 0;
             overflow-x: auto; overflow-y: hidden; padding-top: var(--c-tab-gutter-top); scrollbar-width: none; }
  /* Tabs shrink to fit as today; the label gives way first and a tab keeps its icon, dot and close whole. */
  .cv-tab { position: relative; flex: 0 1 auto; min-width: var(--c-tab-min-w); display: flex; align-items: center;
            gap: 6px; box-sizing: border-box; height: var(--c-tab-h); padding: 0 4px 0 8px;
            font: 400 13px/18px var(--c-font-ui); color: var(--c-tab-fg); cursor: pointer; user-select: none; }
  .cv-tab > * { flex: none; }
  .cv-tab > .cv-tab-label, .cv-tab > .cv-tab-rename { flex: 0 1 auto; min-width: 0; max-width: 120px; }
  .cv-tab > :not(.cv-tab-fill) { position: relative; z-index: 1; }
  .cv-tab-fill { position: absolute; inset: 0; border-radius: var(--c-radius-sm); pointer-events: none; }
  .cv-tab:not([data-active]):hover { color: var(--c-tab-fg-hover); }
  .cv-tab:not([data-active]):hover > .cv-tab-fill { background: var(--c-tab-hover-bg); }
  .cv-tab[data-active] { color: var(--c-tab-fg-active); z-index: 1; }
  /* The active fill runs from the tab top to the strip bottom: -(33 - 4 - 24) = -5px. */
  .cv-tab[data-active] > .cv-tab-fill {
    bottom: calc(var(--c-tab-gutter-top) + var(--c-tab-h) - var(--c-tabstrip-h));
    background: var(--c-tab-active-bg);
    border-radius: var(--c-tab-cap-radius) var(--c-tab-cap-radius) 0 0; }
  .cv-tab[data-active] > .cv-tab-fill::before,
  .cv-tab[data-active] > .cv-tab-fill::after { content: ""; position: absolute; bottom: 0;
    width: var(--c-tab-cap-radius); height: var(--c-tab-cap-radius); clip-path: inset(0); pointer-events: none; }
  .cv-tab[data-active] > .cv-tab-fill::before { right: 100%; border-bottom-right-radius: var(--c-tab-cap-radius);
    box-shadow: 2.5px 2.5px 0 2.5px var(--c-tab-active-bg); }
  .cv-tab[data-active] > .cv-tab-fill::after { left: 100%; border-bottom-left-radius: var(--c-tab-cap-radius);
    box-shadow: -2.5px 2.5px 0 2.5px var(--c-tab-active-bg); }
  .cv-tab:first-child[data-active] > .cv-tab-fill::before { content: none; }  /* [V] connected-tab-left-edge */
  .cv-tab-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* Close buttons stay visible on every tab (D-3); IconButton tone="inherit" leaves the color to these rules. */
  .cv-tab .cv-tab-close { color: var(--c-tab-fg); }
  .cv-tab[data-active] .cv-tab-close, .cv-tab:hover .cv-tab-close { color: var(--c-tab-fg-active); }
  .cv-tab[data-drop-target]::before { content: ""; position: absolute; left: -1px; top: 0; bottom: 0; width: 2px;
    background: var(--c-accent); z-index: 2; }
  .cv-tab[data-dragging] { opacity: .5; }
}
```

Geometry check: the strip is 4 + 24 + 5 = 33px; the active fill covers y = 4 to 33, so tab and session read as one surface; the shoulders sit at the strip bottom beside the fill. The hamburger sits in the strip's first `.cv-tabstrip-slot`; `+` and the right slot (the AI toggle) share its last one. The slots' 1px bottom padding centers a 22px button on the tab label line (y = 16). The floor is 8 + 16 + 6 + 0 + 6 + 12 + 6 + 20 + 4 = 78px (padding, icon, gap, label, gap, dot, gap, close, padding); at shot 18's layout (a split plus the AI panel; the left pane is about 312px wide [V measured on BEFORE 18], 282px after its `+` slot) three tabs fit at about 94px each, their titles showing a letter or two, as today.

**States:**

| State | Look |
|---|---|
| Inactive | Strip color, `--c-tab-fg` text, close glyph `--c-tab-fg` |
| Hover (inactive) | 24px fill `--c-tab-hover-bg`, radius 4, `--c-tab-fg-hover` text, close glyph `--c-tab-fg-active` |
| Active | Connected fill `--c-tab-active-bg`, `--c-tab-fg-active` text and close glyph, regular weight (today medium) |
| Pane not focused | Same colors [V: Modern UI keeps the unfocused active tab identical]; the AI toggle shows only in the focused pane, as today |
| Connecting / reconnecting | Amber dot pulsing; tooltip `Reconnecting...` or the status |
| Disconnected | Red dot; tooltip = the error text, e.g. `connect ECONNREFUSED 127.0.0.1:1` [BEFORE 10] |
| Renaming | Input replaces the title (above) |
| Dragging / drop target | Opacity .5 / 2px accent bar |
| Many tabs | Each shrinks toward its 78px floor; past that the row scrolls with the wheel and keeps the active tab in view |

**Tab context menu** (native popup, 3.13): items, order and ids unchanged. Icons are passed as semantic names: Rename `pencil`, Reconnect `refresh`, View Info `infoCircle` (today `home`), Send Ctrl+Alt+Delete `keyboard`, Copy Username `user`, Copy Password `key`, Split Right `splitHorizontal`, Split Down `splitVertical` (today both pass `split`, which the menu window has no icon for), Close Session `close` (danger). The `+` popup keeps its items; icons `plug` (Quick Connect), `home`, `terminal`, `folder`.

### 3.5 Splits, drop zones and panes

- **Split separators** (`LayoutRenderer.tsx:44-50`): the `Separator` stays 4px in the layout flow (`w-1` or `h-1`), class `cv-split-sash` with `data-orientation`. It paints a centered 1px `--c-editor-group-border` line on `--c-editor`; after 300ms of hover, or at once while dragging, the whole 4px turns `--c-accent` (fade 100ms). Cursor `col-resize` / `row-resize` on macOS, `ew-resize` / `ns-resize` elsewhere.
- **Drop zones** (`DropZoneOverlay.tsx`): the overlay keeps `absolute inset-0 z-40` (2.6). The zone keeps today's geometry (`zoneStyles`) and becomes `bg-(--c-drop-bg) outline outline-1 -outline-offset-1 outline-accent rounded`.
- **Pane content** (`Pane.tsx`): every pane's content container gets `data-cv-session-area` (D-21) and keeps `data-content-area` on the focused one.
- **Empty extra pane** (`PaneContent.tsx:164-170`): `bg-editor`, text `text-body text-ink-muted`, same text.
- **Empty vault welcome** (`PaneContent.tsx:185-205`) [BEFORE 03]: `bg-editor`; title `text-title text-ink`; body `text-body text-ink-muted`; `Button variant="primary"` "New Entry" and `Button variant="secondary"` "Quick Connect", same order and texts.
- **Loading states in panes**: the border spinners become `Spinner` (16 or 24) with their texts unchanged.
- Sessions render as today (`display` toggling per session, `PaneContent.tsx:144-156`).

### 3.6 Side bar

**Panel** (`SidebarPanel.tsx`): `bg-sidebar border-r border-divider` in both modes (today `bg-canvas border-stroke`). Floating: `shadow-overlay` as a class (today an inline `boxShadow`), backdrop `bg-(--c-scrim-sidebar)` fading to transparent while closing (today `bg-black/20` to `bg-black/0`), `sidebar-in` / `sidebar-out` animations unchanged. Position, z-index, width, the element order and `data-sidebar-panel` / `data-docked` unchanged. The floating panel's own 2px accent line (`SidebarPanel.tsx:50`) takes `data-cv-accent-line` (3.3).

**Resize handle**: hit areas unchanged (8px wide at `right: 0` docked, 12px at `right: -6px` floating). The visible line becomes 4px of `--c-accent` at the side bar's edge (today 3px at 50% or 70% accent), shown after 300ms of hover (today 600ms) and at once while resizing, fading over 100ms.

**Header row** (`Sidebar.tsx:303-358`) [BEFORE 08], hook `data-cv-sidebar-header`:

| Element | Restyled | Keeps |
|---|---|---|
| Row | `flex h-tabstrip shrink-0 items-center gap-0.5 px-1` (33px, D-5; today `p-3`, 52px). Team vaults keep `border-l-2 border-l-team-border-strong bg-team`. | Order |
| Close / hide | `IconButton md` with the `close` glyph (today a hand-drawn 14px X), `label` and `title` exactly as today (`Hide sidebar` + `Hide sidebar (Ctrl+B)` docked, `Close sidebar` + `Close sidebar (Ctrl+B)` floating). | `SidebarWindowControls.tsx` logic |
| Pin | `IconButton md`, `pin` / `pinFilled` at 16 (today 14), `pressed={isPinned}` (pressed look replaces the accent text); `opacity-60` stays while pinned but too narrow to dock. | `aria-pressed`, `aria-label`, the three titles |
| Vault switcher | The wrapper becomes `relative min-w-0 flex-1`, so a long name truncates before the buttons (fixes the overlap in INVENTORY 11). The button: `-ml-1 flex h-6 max-w-full min-w-0 items-center gap-0.5 rounded px-1 text-body font-semibold text-ink hover:bg-hover` (13px in `ink`, the most prominent text in the header, as today's 13px name; 4px of room for the inset focus ring, lesson of `4780b8c`), name `truncate`, `chevronDown` 16 `text-ink-muted`. At the default 250px, `Acme Infrastructure` shows at least 12 characters before the ellipsis (macOS). Hook `data-cv-vault-switcher`. | `title` (path, network or "Open a vault"), menu toggle |
| Right group | `flex shrink-0 items-center gap-0.5`: favorites `IconButton md` (`star`, or `starFilled` in `text-favorite` when on), new entry (`plus`), new folder (`folderPlus`). A read-only team vault disables the two create buttons (`disabled`, `disabledReason="View-only access"`). | Titles `Show favorites only` / `Show all entries`, `New Entry (Ctrl+E)`, `New Folder (Ctrl+Shift+N)` |

**Vault switcher menu** (`VaultSwitcherMenu.tsx`) [BEFORE 21]: the container keeps its place and size (`absolute top-full left-0 mt-1 w-[280px]`, `data-context-menu`) and takes the DOM menu look: `rounded-lg border border-overlay-border bg-overlay shadow-overlay py-1`. Section headers (`Personal Vaults`, team sections): `h-6 px-3 text-meta font-semibold text-ink-muted`, no uppercase. Rows: `MenuItem` look (24px, `mx-1 px-2`, radius 6, 13px `ink-secondary`, hover and keyboard `--c-menu-selection-bg` with a 1px `--c-menu-selection-border` outline); the current vault's mark is `check` 16 in `ink-secondary` (today accent); leading icons 16 in `ink-muted`. Separators `h-px my-[5px] bg-divider`. Every row stays a `<button>` with today's text (`Lock Current Vault` is clicked by the harness, B43). The recent-vault right-click menu (a popup) is unchanged.

**Team context bar** (`VaultContextBar.tsx`): `flex h-section items-center justify-between px-2` with today's team border and tint; the sync dot becomes `circleFilled` 12 in the state color (tooltip kept); "Team" `text-meta text-ink-muted`; the settings button `IconButton sm` `settings`, `label="Vault settings"`.

**Admin onboarding card** (`Sidebar.tsx:363-392`): `Callout tone="info" size="sm"` with `icon="users"`, title `Create your first team vault`, body text unchanged, `actions` = `Button size="sm" variant="primary"` "Create Team Vault", `onDismiss` (label `Dismiss`). Margin `mx-2 mt-2`.

**Invitation banner** (`TeamInvitationBanner.tsx`): per invite a row `flex items-center gap-2 px-2 py-1.5 bg-warning-bg border-b border-warning-border`, `users` 16 `text-warning`, text `text-label text-ink` (team name `font-semibold`), `IconButton sm` `check` (`label="Accept"`) and `close` (`label="Decline"`).

**Search** (`Sidebar.tsx:397-432`) [BEFORE 38]: container `px-2 pb-2` (hook `data-cv-sidebar-search`); the field becomes the `SearchInput` look: 26px, radius 4, `border-input-border bg-input`, `focus-within` ring, leading `search` 16 `text-ink-muted`, inner `<input data-bare>` 13px with `placeholder:text-(--c-input-placeholder)`, clear `IconButton sm` `close` `label="Clear search"` while text is typed. Escape clears, as today.

**Tree container**: `px-1` (the 4px list inset), `scrollbar-autohide` and its fade unchanged.

**Tree rows** (`EntryTree.tsx:895-1011`) [BEFORE 07, 38, 39] follow the `TreeRow` recipe (4.14) without its ARIA role (D-20):

| Part | Restyled (today) |
|---|---|
| Row | `flex h-row items-center gap-1.5 rounded pr-2 text-body whitespace-nowrap cursor-pointer`, `padding-left: calc(4px + depth * 8px)` (today 28px rows, `depth * 16 + 8`) |
| Twistie | The existing `<button>` becomes a 16 × 16 box (`size-4`) with `chevronRight` / `chevronDown` at 16 (today 12) in `ink-muted`; leaves keep a 16px spacer (`size-4`) so icons line up |
| Icon | Entry icon 16 in its entry color (unchanged) |
| Label | `text-ink-secondary`; inline markers after it: conflict dot, `lock` 12 `text-ink-faint` (locked), `lock` 12 `text-warning` (view-only folder), `starFilled` 12 `text-favorite` (today 10px icons) |
| Hover | `bg-hover` |
| Selected | `bg-selected text-ink` plus `data-selected` (today `bg-conduit-600/20 text-conduit-400`) |
| Drop target | `bg-(--c-drop-bg) outline outline-1 -outline-offset-1 outline-accent` (today a ring) |
| Locked | `opacity-60` (unchanged) |
| Rename input | 20px, 13px, `bg-input`, 1px `--c-focus` border, radius 2, `px-1`, `flex-1` |
| Multi-drag badge | Inline style background `var(--c-btn-primary-bg)` instead of `#6366f1`, radius 4, 12px |
| Indent guides | For each ancestor level k, a 1px `--c-indent-guide` line at `left: calc(12px + k * 8px)` over the row height, `opacity: 0`, fading to 1 over 100ms while the tree container is hovered or has focus within [V VS Code `renderIndentGuides: onHover`] |
| Flat-mode group label | `h-row px-2 pt-2 text-meta font-semibold text-ink-muted truncate`, no uppercase and no letter spacing; `title` kept |
| Empty states | Team vault: `users` 32 `text-ink-faint`, title `text-body text-ink-muted`, hint `text-label text-ink-faint`; others `text-body text-ink-faint`, centered; texts unchanged |
| Root drop zone | `h-6 mx-1 mt-1 rounded`; while dragging over: `bg-(--c-drop-bg) border border-dashed border-accent` |

**Trial promotion** (`Sidebar.tsx:467-490`): `Callout tone="info" size="sm"` with `icon="sparkles"`, title `Try Pro free for 30 days`, action `Button size="sm" variant="primary"` with today's label, `onDismiss`. Margin `mx-2 mb-2`.

**Trial status strip** (`Sidebar.tsx:491-512`): `mx-2 mb-2 flex h-7 items-center gap-2 rounded-md border px-2 text-label font-semibold`, tones: urgent `bg-danger-bg border-danger-border text-danger`, moderate `bg-warning-bg border-warning-border text-warning`, otherwise `bg-info-bg border-info-border text-ink`; `clock` 16 in the tone color; text unchanged.

**Footer** (`Sidebar.tsx:513-590`) [BEFORE 09, 39], hook `data-cv-sidebar-footer`, `border-t border-divider`:

| Element | Restyled | Keeps |
|---|---|---|
| Row 1 | `flex h-8 items-center justify-between gap-1 px-2` (today 40px) | Order |
| Count | `text-meta text-ink-faint tabular-nums` | Text (`9 items`, `2 favorites`) |
| Personal sync | `IconButton`-sized (22px) button, icon 16 (today 14) in the tone color: ok `text-success`, busy `text-accent` (spinning), warn `text-warning`, error `text-danger`, off `text-ink-faint`; hover `--c-toolbar-hover` | `title`, `aria-label="Sync: {label}"`, click opens Settings > Sync |
| `N to review` | `h-5 rounded px-1.5 text-badge font-semibold text-warning bg-warning-bg hover:underline`; hook `data-cv-review-button` | Text, `title="Review changes from your other devices"` (B13) |
| Cloud backup, team sync | 22px boxes, icons 16: green → `text-success`, blue → `text-info`, amber → `text-warning`, red → `text-danger`, faint → `text-ink-faint`; pulses unchanged | Titles |
| Home, Settings | `IconButton md` `home` (`label="Home"`), `settings` (`label="Settings"`, `title="Settings (Ctrl+,)"`) | Actions |
| Row 2, signed in | `flex h-8 items-center justify-between gap-2 px-2 border-t border-divider`; email `text-label text-ink-muted truncate hover:text-ink hover:underline`; offline `Badge tone="warning"` `offline`; `IconButton md` `logout` `tone="danger"` `label="Sign Out"`; confirming: `Button size="sm" variant="danger"` "Confirm" and `Button size="sm" variant="ghost"` "Cancel" | Texts, `title="Account Settings"`, the two-step sign-out |
| Row 2, local mode | `px-2 py-1.5 border-t border-divider`, `Button variant="link" size="sm"` with `icon="login"` | Text `Sign in to start a free Pro trial` |

### 3.7 AI panel

- **Divider** (`App.tsx:1100-1104`): stays a 4px element in the flow, class `cv-sash cv-sash-ai`, hook `data-cv-ai-divider`: it paints `linear-gradient(to right, var(--c-editor) 0 1.5px, var(--c-divider) 1.5px 2.5px, var(--c-sidebar) 2.5px)`, a 1px line between the panes and the panel (today a 4px `bg-stroke` bar). Hover after 300ms or dragging: 4px `--c-accent`. Resize logic, limits and `display` toggling unchanged.
- **Panel** (`App.tsx:1105-1114`): hook `data-cv-ai-panel`; width, `contain: strict` and `display` unchanged.
- **ChatPanel root** (`ChatPanel.tsx:223`): `bg-sidebar` (today `bg-canvas`).
- **Header** (`ChatPanel.tsx:225-284`) [BEFORE 18]:

| Element | Restyled | Keeps |
|---|---|---|
| Row | `flex h-tabstrip shrink-0 items-center justify-between gap-1 px-2` (33px, D-5), hook `data-cv-ai-header`, no bottom border (the terminal below is `--c-editor`, which separates it) | Order |
| Engine picker | `flex h-6 items-center gap-1.5 rounded px-1.5 text-label font-semibold text-ink-secondary hover:bg-hover hover:text-ink` (today a bordered well), `EngineLogo` 16, engine name, `chevronDown` 16 `text-ink-muted` | `title="Switch engine for this session"`, behavior |
| Engine dropdown | Container keeps its place (`absolute top-full left-0 mt-1`, `min-w-[200px] max-h-72 overflow-y-auto`) with the DOM menu look (3.6 vault menu); rows `MenuItem` look with `EngineLogo` 16 and the name; the active engine keeps its `●` after the name, as visible text in `text-link` (`--c-accent-text`) [BEFORE 19] | Items, order, in-memory switch, the `●` (the inventory reads `Claude Code ●`) |
| Model chip | `Button size="sm" variant="secondary"` look, `max-w-[160px] truncate` | `title`, click refetches models |
| New conversation | `IconButton md` `plus` `label="New conversation"` | Action |

- The body below the header (messages, the model picker of 3.16, terminal mode) is R3-AI's.

### 3.8 Banners

- **Sync banners** (`SyncBanner.tsx`, used by `SyncBanners`, `PromptBanner`, `SideFilesPausedBanner`): rendered through the `Banner` primitive (4.13): `min-height: 26px`, 12px text on a 16px line, icon 16 in a `pl-2.5 pr-1.5` slot, the divider drawn inside the row (`box-shadow: inset 0 -1px 0 var(--c-divider)`, so the row stays 26px, lesson of `ca9659c`). Actions stay buttons (D-27): `Button size="sm"` (22px) with `ml-2`, `variant="primary"` where the action is primary (today a filled `bg-conduit-600` button, `SyncBanner.tsx:39-41`) and `secondary` otherwise, so `Use here instead` and `Review` stay prominent. Tones: `info` and `lock` on `bg-selected` (icons `text-info`, `text-ink-muted`), `warn` on `bg-warning-bg` (icon `text-warning`). Text may wrap. `role="status"`, the text in `span.flex-1` plus `data-cv-banner-text`, and every action's exact label are kept (B14, B15, B34).
- **Offline banners** (`App.tsx:990-1002` hub and `1062-1074` main): `Banner tone="warn" icon="wifiOff" status={false} align="center"` (today they have no `role="status"`, and the harness reads only sync banners by role): today's text and its `Reconnect` button (`Button size="sm" variant="secondary"`) stay centered as a group, as today (`justify-center`, `App.tsx:1064`).
- Order and positions unchanged (L-3).

### 3.9 StartupStatus strip

`StartupStatus.tsx:84-130`: `flex h-6 shrink-0 items-center gap-2 border-t border-divider bg-shell px-2 text-label` (24px, today about 30px); icons 16: building `hammer` in `text-info` with `animate-pulse`, done `check` `text-success`, error `alertTriangle` `text-danger`; label `text-ink-muted`; message `text-ink-secondary`, `text-success` or `text-danger`; detail `text-ink-faint truncate`; progress track `h-1 w-48 rounded-full bg-selected` with an `animate-indeterminate` fill `bg-(--c-progress)`; dismiss `IconButton sm` `close` `label="Dismiss"`. Hook `data-cv-startup-status`. Events, texts and auto-dismiss unchanged.

### 3.10 Surfaces under the tab strip

These sit directly under an active tab, so they use `--c-editor` (D-19):

| Component | Restyled | Keeps |
|---|---|---|
| `sessions/web/WebBrowserToolbar.tsx` | `h-9 bg-editor border-b border-divider px-2 gap-1`; Back, Forward, Refresh, Home, New Tab, Autofill as `IconButton md` (disabled `opacity-40`); the URL field as a 26px composite field (`rounded border border-input-border bg-input px-2`, `focus-within` ring, lock icon 16 `text-ink-muted`, inner input `data-bare` 13px) | Titles, order, the `Pick` developer button |
| `sessions/web/WebSubTabBar.tsx` | `h-8 bg-editor border-b border-divider px-1 gap-0.5`; sub-tabs `h-6 px-2 rounded text-label text-ink-muted hover:bg-hover`, active `bg-selected text-ink` | Behavior |
| `sessions/web/WebAutofillBar.tsx` | `h-8 bg-editor border-b border-divider`; the blue variant becomes `bg-info-bg border-info-border`; buttons `Button size="sm"` | Texts |
| `sessions/DocumentView.tsx` headers | `bg-editor border-b border-divider`; `Edit` / `Save` `Button size="sm"` (primary), secondary actions `ghost`; the markdown toolbar row `bg-editor border-b border-divider` with `IconButton sm` buttons | Texts, word count |
| `sessions/CommandView.tsx` header | `bg-editor border-b border-divider`; Stop `Button size="sm" variant="danger"`, Run `Button size="sm" variant="secondary"` | Texts |
| Terminal, RDP, VNC, web view containers | `bg-canvas` → `bg-editor` (R3-SESSIONS) | Everything else |

### 3.11 Screens outside the main layout

- **Loading and team auto-connect** (`App.tsx:952-983`): `bg-editor`; the border spinner becomes `Spinner` 24 with the text as visible text; texts exactly `Loading...` (the harness treats a page whose whole text is `Loading...` as loading, B27) and `Connecting to team vault...`.
- **Sign-in** (`AuthScreen.tsx`) [BEFORE 00] and **onboarding** (`OnboardingWizard.tsx`): primitives; `Button size="lg"` for the main actions, `text-display` titles, `Callout` for the trial note; layout and texts unchanged (`Continue without signing in` is read by the harness).
- **Vault hub** (`VaultHub.tsx`) [BEFORE 01, 41]: the card `rounded-lg border border-card-border bg-sidebar`; left column: app icon, `Conduit` in `text-display`, subtitle `text-body text-ink-muted`, `Button size="lg" variant="primary" icon="plus"` "New Vault" and `Button size="lg" variant="secondary" icon="folderOpen"` "Open Vault File"; the column divider `border-divider`; right column: the `Recent Vaults` header (its own text, no longer drawn in capitals) as `text-meta font-semibold text-ink-muted` with the lock icon at 12, `Clear All` as `Button variant="link" size="sm"`, rows as clickable `ListRow` with a description (36px: name, then folder in `text-meta`) and a 28px `rounded-md bg-well` icon tile as `leading`. What is always visible today stays always visible (L-23): `PendingBadge` and the fingerprint icon go in the row's `meta` slot; only the chevron, hover-only today (`VaultHub.tsx:262-264`, `371-374`), goes in `trailing`. Each row stays `button[title="{path}"]` (B26, B44).
- **Home dashboard** (`dashboard/`) [BEFORE 40]: `Card`, `ListRow`, `Button`, `SectionHeader`; the counts line `text-body text-ink-muted`; `Quick Connect` primary button with its `Kbd` hint. Entry rows are clickable `ListRow`s (double-click kept) with the relative time or the type label in `meta`, always visible as today (`DashboardOverview.tsx:283-291`); the type label drops its CSS uppercase (8.4).

### 3.12 Dialogs, Settings and the Appearance tab

- **Every dialog** moves onto `Dialog` (4.8) where it stands, keeping its width (`width` prop, D-18), title, content order, controls, footer order and close behavior (D-26, 3.12.1). Where a dialog has a close button today, it becomes `IconButton md` `close` `label="Close"`; dialogs without one pass `hideClose`. Scrim `--c-scrim`, no blur, no animation. Every dialog holds a freeze, so native web pages never draw over it (the 32b bug stays fixed; the restyle suite checks it).
- **ConfirmDialog** [BEFORE 32]: message in `text-ink-muted`; `Button variant="secondary"` Cancel then `Button variant="danger"` or `"primary"` confirm, texts unchanged; no close button and no Escape, as today, except the stacked confirm of Recently deleted (3.12.1).
- **Settings** [BEFORE 20-nn]: `Dialog` with today's width; the nav column keeps `w-52` and gains `data-cv-settings-nav`, as a `NavList` (22px rows, radius 4, icons 16, the Sessions group with its chevron, selected `bg-selected text-ink`); the content pane scrolls; footer Cancel (secondary) then Save (primary). Tabs use `SettingsRow`, `FormField`, `Select`, `Checkbox`, `Switch`, `SegmentedControl`, `Slider`, keeping every label, option and harness hook (B1-B4, B7, B22-B24, B36-B41).
- **Appearance tab** (final, 6.4): Icon pack (first, in the slot of the retired Platform Theme block), Color Scheme, then Brightness and UI Scale side by side, as today.
- **Entry dialogs** [BEFORE 22-30]: `EntryDialogSidebar` as `NavList`; group labels (drawn in capitals today) as `text-meta font-semibold text-ink-muted` without uppercase; the type chips keep their entry colors on neutral tiles; fields on `FormField`; footer Back, Cancel, Create or Save.
- **Quick Connect** [BEFORE 31]: `SegmentedControl` for SSH, RDP, VNC, Web; fields on `FormField`; footer Cancel, Connect.
- **Sync panels** [BEFORE 33-35]: `Dialog` with `harnessLabel` where the harness reads them (B9), hooks B5, B6, B11, B18-B21, B38; busy texts stay visible (B35).
- **Vault dialogs** [BEFORE 02, 42]: `UnlockDialog` and the create dialog keep their placeholders, `Please wait...` and `data-cv-error` (B8, B30, B35).

#### 3.12.1 Close behavior, dialog by dialog

Today every dialog decides for itself whether Escape, a click on the scrim or a close button closes it [V: each file read on `41d9657`]. Each keeps exactly that (D-26, L-21). "Busy" is the dialog's own `canClose` guard (`step !== "importing"` or `"exporting"`). Each R3 package passes the props below and tests them: Escape, a scrim click and the close button's presence, per dialog.

| Package | Dialog (file) | Escape today | Scrim click today | Close button today | `Dialog` props |
|---|---|---|---|---|---|
| R3-SETTINGS | Settings (`SettingsDialog.tsx`) | cancels (reverts the live preview) | no | yes | `onClose={handleCancel}` |
| R3-ENTRIES | New or edit entry, type step and form (`EntryDialog.tsx`) | no | no | yes | `closeOnEscape={false}` (unsaved input stays) |
| R3-ENTRIES | Loading entry (`EntryDialog.tsx`) | no | no | no | `hideClose`, `closeOnEscape={false}` |
| R3-ENTRIES | New or edit folder (`FolderDialog.tsx`) | no | no | yes | `closeOnEscape={false}` |
| R3-VAULT | Unlock Vault and Create Vault (`UnlockDialog.tsx`) | cancels | no | no (a Cancel button) | `hideClose`, `onClose={onCancel}` |
| R3-VAULT | Enable Quick Unlock (`BiometricSetupPrompt.tsx`) | dismisses like Not Now (`UnlockDialog`'s key handler) | no | no | `hideClose`, `onClose={onDismiss}` |
| R3-VAULT | Change Password, Rename Vault, Welcome Back (`ChangePasswordDialog`, `RenameVaultDialog`, `CloudRestoreDialog`) | no | no | no | `hideClose`, `closeOnEscape={false}` |
| R3-VAULT | Save Your Recovery Passphrase (`RecoveryPassphraseDialog.tsx`) | no | no | no | `hideClose`, `closeOnEscape={false}`, no `onClose`: it cannot be dismissed before the passphrase is saved |
| R3-VAULT | Team Vault In Use (`ProVaultLockDialog.tsx`) | no | no | no | `hideClose`, `closeOnEscape={false}` |
| R3-VAULT | Backup Manager (`BackupManagerDialog.tsx`, `z-[60]` today) | closes | no | yes | `layer="sync"` |
| R3-VAULT | Export, Import Vault (`ExportDialog`, `VaultImportDialog`) | closes unless busy | closes unless busy | yes unless busy | `closeOnEscape={canClose}`, `closeOnScrim={canClose}`, `hideClose={!canClose}` |
| R3-TEAM | Vault Settings, Audit Log, Password History (`VaultSettingsDialog`, `AuditLogViewer`, `PasswordHistoryDialog`) | no | no | yes | `closeOnEscape={false}` |
| R3-TEAM | Create Team Vault, Team Vault unlock, Set Up Team Access, Device Authorization Request (`CreateTeamVaultDialog`, `TeamVaultUnlock`, `DeviceSetupDialog`, `DeviceAuthApprovalDialog`) | no | no | no | `hideClose`, `closeOnEscape={false}` |
| R3-TEAM | Credential form (`CredentialForm.tsx`) | closes | no | yes | defaults |
| R3-TEAM | Credentials (`CredentialManager.tsx`) | closes unless its form, unlock or delete confirm is open | no | yes | `closeOnEscape={!showForm && !showUnlock && !deletingId}` |
| R3-TEAM | Select Credential (`CredentialPicker.tsx`, `z-[60]`) | closes | closes | yes | `closeOnScrim`, `layer="sync"` |
| R3-SYNC | Review changes (`ConflictReviewPanel.tsx`) | closes | no | yes, `aria-label="Close"` (B12) | `layer="sync"`, `harnessLabel="Review changes"` |
| R3-SYNC | The 13 dialogs on `SyncDialogFrame` | runs `onEscape` in the 10 that pass one; swallowed in `EpochPromptDialog`, `SessionConflictDialog`, `WaitingForDriveDialog` | no | no | `hideClose`, `onClose={onEscape}`, `closeOnEscape={Boolean(onEscape)}`, `layer="sync"`, `harnessLabel` |
| R3-SYNC | The delete confirm inside Recently deleted (`RecentlyDeletedPanel.tsx` + `ConfirmDialog`) | cancels the confirm (the panel's `onEscape`) | no | no | `ConfirmDialog layer="stacked" closeOnEscape` |
| R3-AI | Register MCP Tools (`McpSetupDialog.tsx`, `z-[60]`) | closes | closes | yes | `closeOnScrim`, `layer="sync"` |
| R3-MISC | Confirm (`ConfirmDialog.tsx`: entry and folder delete, document delete) | no | no | no | `hideClose`, `closeOnEscape={false}` |
| R3-MISC | About, What's New, Feedback (`AboutDialog`, `WhatsNewDialog`, `FeedbackDialog`) | closes | closes | yes | `closeOnScrim` |
| R3-MISC | Import (`ImportDialog.tsx`) | closes unless busy | closes unless busy | yes unless busy | `closeOnEscape={canClose}`, `closeOnScrim={canClose}`, `hideClose={!canClose}` |
| R3-MISC | Quick Connect, Password Generator, SSH Key Generator (`QuickConnect`, `PasswordGeneratorDialog`, `SshKeyGeneratorDialog`) | closes | no | yes | defaults |

Notes: Escape handlers that listen on the scrim today only fire while focus is inside the dialog; the primitive's layer stack traps focus in the dialog, so the result is the same. What's New keeps its arrow keys. The dead `TeamVaultMembersDialog`, `VaultSelector` and `FolderPermissionEditor` (10.5) are skipped.

### 3.13 Popup menus

The native child-window menus (`electron/ipc/menu.ts`) take the W2-MENUS restyle (7.1): panels sized to their longest label (220 to 320px), 24px rows with 6px radius and 8px gaps, 11px separators, headers `11px/600` in `ink-muted` without uppercase (INVENTORY shows `LOCAL SHELL`; after the restyle `Local Shell`), 8px panel radius, the overlay colors, a 12px transparent shadow margin, keyboard navigation, and icons from the active pack [BEFORE 11-17]. Items, order, submenus and anchoring are unchanged. Call sites keep passing today's keys, which `src/utils/contextMenu.ts` maps to semantic names (5.7), except the tab menu, which passes semantic names (3.4).

### 3.14 Toasts

Window, position and stacking unchanged (D-15). `OverlayToast.tsx` and `OverlayUpdateNotification.tsx` render `ToastCard` (4.15): `rounded-lg border border-overlay-border bg-overlay p-2 shadow-overlay`, no colored left bar; a 16px icon in the tone color (success `circleCheck` `text-success`, info `infoCircle` `text-info`, warning `alertTriangle` `text-warning`, error `circleX` `text-danger`); title `text-body font-semibold text-ink`; message `text-body text-ink-secondary`; progress `h-1 rounded-full bg-selected` with a `bg-(--c-progress)` fill and `text-meta` labels; actions `Button size="sm"` (primary or secondary); close `IconButton sm` `close` `label="Dismiss"`. `data-toast` stays (click-through, `OverlayApp.tsx`). Animations `toast-in` / `toast-out` unchanged [BEFORE 36, 37].

### 3.15 Credential picker window

`src/components/picker/`: the 380 × 500 window, its drag header and its flows unchanged; lists on `ListRow`, fields on `TextInput` and `PasswordInput`, inline SVGs replaced by semantic icons, colors from tokens. The window follows the active icon pack through the `storage` event (5.6), which the `packs` scenario checks (8.6).

### 3.16 In-app pickers

Three pickers keep their place, size and layout and take only the overlay look; none is rebuilt on `Popover` or `Menu` (a grid turned into 24px menu rows, or a card that starts to float, would change the layout).

| Picker | Today | Restyled | Keeps |
|---|---|---|---|
| `IconPicker` (`entries/IconPicker.tsx`, opened from the folder and entry forms) | a `fixed` 300px panel with a title, a search field, a `Use Default` button, uppercase category labels and 6-column grids of 36px cells (`IconPicker.tsx:54`, `:99`) | `rounded-lg border border-overlay-border bg-overlay shadow-overlay`; the search on `SearchInput`; category labels `text-meta font-semibold text-ink-muted` without uppercase (8.4); cells `hover:bg-hover`, the selected cell `bg-selected` with a 1px `--c-accent` outline (today an accent tint and ring); icons with a semantic twin drawn through the active pack (5.11) | Its position logic, width, header, search, `Use Default`, categories, 6-column grids and cell size |
| `ColorPicker` (`entries/ColorPicker.tsx`) | a `fixed` 220px panel with a title, a `Use Default` button and an 8-column grid of 24px swatches (`ColorPicker.tsx:42`, `:64`) | the same overlay look; the selected swatch keeps its 2px ring, in `--c-accent` with its offset in `--c-overlay` | Position logic, width, header, `Use Default`, 8-column grid, swatch colors and size |
| `ModelPicker` (`ai/ModelPicker.tsx`) | an in-flow `mx-4 mb-4` card in the chat body with a header (`Select a model`, a close button) and two-line rows (`ModelPicker.tsx:65`, `:75`) | the card in `bg-overlay border-overlay-border rounded-lg`; the close button `IconButton sm` `close`; rows as `ListRow` with a description; the current model `bg-selected` | In the flow of the chat body, its margins, header, texts and row order |

The two entry pickers open inside the entry and folder dialogs, whose freeze covers them; if one ever opens outside a dialog it holds its own through `useFreeze`, not through `Popover`.

---

## 4. Components

The primitives in `src/components/ui/` landed in wave 1 and are only used by the gallery today [V grep]. The restyle puts them to work in place (D-1). This section is their contract, with the restyle's changes marked **(restyle)**.

### 4.1 Conventions

- One small file per primitive, a barrel `src/components/ui/index.ts` and a local `cx()`. No new runtime dependency.
- Primitives take `className` (appended last) and forward `ref` and `data-*` props. They never set `outline: none`.
- Utilities come from the `@theme` block (2.9); tokens without a theme name use Tailwind v4's shorthand, for example `bg-(--c-btn-secondary-bg)`.
- Harness-bound markup the primitives keep (Appendix B): dialog panels carry `data-dialog-content` and an `h2` title; labeled fields render `<label><span>{label}</span>…control…</label>`; checkboxes and radios are `<label>` elements wrapping the input and the exact text; inline errors are `<p data-cv-error>`; a dialog with a form wraps header, body and footer in one `<form>`; DOM menu items are `<button type="button" role="menuitem">`; clickable `ListRow`s are `<button>`s; actions revealed on hover hide with `opacity: 0` only; busy text stays visible text.
- **Using a primitive in place (restyle).** When a package swaps a hand-written element for a primitive, the element keeps its position, its text, its `title`, its `aria-*` attributes and its `data-*` hooks. `IconButton` builds `aria-label` and `title` from `label`; where today's `title` differs from the accessible name (a shortcut hint), pass today's `title` explicitly, which wins over the default.
- **The gallery** (`gallery.html` + `src/gallery.tsx`, dev server only) renders every primitive in every state, with scheme, mode and icon pack switches (**restyle:** the density switch and the workbench preview are removed). It shows each focusable primitive focused inside a `Card` and inside a 33px tab strip built from `tabs.css`, except text `Button`s at `md` and `lg`, `Textarea`, `Tabs` and `ChoiceCard`, which never sit in a strip.

### 4.2 Button

`<Button variant size icon iconEnd loading loadingLabel fullWidth type="button" …>`.

| Part | Recipe | Source |
|---|---|---|
| Base | `inline-flex items-center justify-center gap-1 whitespace-nowrap rounded border select-none transition-colors duration-100 disabled:opacity-40 disabled:pointer-events-none` + `data-cv-text-button` (2px outside focus ring) | [V] VS Code text buttons |
| `sm` | `h-control-sm px-1.5 text-meta` (22px, 11px) | [V] small button |
| `md` (default) | `h-control px-2 text-label` (26px, 12px) | [V] `.monaco-text-button` |
| `lg` | `h-control-lg px-3 text-body` (32px) | [ADAPT] landing CTAs only |
| `primary` | `bg-btn-primary hover:bg-btn-primary-hover text-white border-transparent` | [V] |
| `secondary` | `bg-(--c-btn-secondary-bg) text-(--c-btn-secondary-fg) border-(--c-btn-secondary-border) hover:bg-(--c-btn-secondary-hover)` | [V] |
| `ghost` | `bg-transparent border-transparent text-ink-secondary hover:bg-hover hover:text-ink` | |
| `danger` | `bg-btn-danger hover:bg-btn-danger-hover text-white border-transparent` | |
| `link` | `h-auto px-0 border-0 bg-transparent text-link hover:text-link-hover hover:underline` | [V] |
| Icon | 16px (`sm`: 12px), 4px gap | [V] |
| Loading | a spinning `loader` at the icon size replaces the icon; the label stays visible (`loadingLabel` or the children); `aria-busy`; disabled | busy texts the harness reads (B35) |

Footer order: secondary first, primary last, as today.

### 4.3 IconButton

`<IconButton icon label size pressed tone disabledReason …>`. `label` is required and becomes `aria-label` and the default `title`.

| Size | Box | Icon | Radius | Use |
|---|---|---|---|---|
| `sm` | 20 × 20 | 16 | 4 | Tab close, clear buttons, dismiss buttons, small toolbars |
| `md` (default) | 22 × 22 | 16 | 4 | Header and footer buttons, `+`, the AI toggle, toolbars |
| `lg` | 28 × 28 | 20 | 4 | Landing pages only |

Colors: `text-ink-muted hover:text-ink hover:bg-toolbar-hover active:bg-toolbar-active`. `pressed` sets `aria-pressed="true"` and the pressed look `bg-toolbar-active text-ink`. **(restyle)** The `pressedLook` prop is removed: it existed for the clone's title bar buttons, which swapped glyphs instead. `tone="danger"` sets `hover:text-danger`. **(restyle)** `tone="inherit"` sets no text color at all, so the glyph takes its color from CSS around it (the tab close, 3.4); the hover fill stays. Disabled: `opacity-40` and `disabledReason` as the `title`. Focus: the inset ring.

### 4.4 Text fields

| Primitive | Recipe |
|---|---|
| `TextInput` | `h-control w-full rounded border border-input-border bg-input px-1.5 text-body text-(--c-input-fg) placeholder:text-(--c-input-placeholder)`; `invalid` adds `border-danger` and `aria-invalid`; 16px leading and trailing slots |
| `Textarea` | same colors, `min-h-[78px] px-1.5 py-1 text-body resize-y` |
| `PasswordInput` | `TextInput` + trailing `IconButton sm` (`eye` / `eyeOff`, `Show password` / `Hide password`) |
| `SearchInput` | wrapper `flex items-center gap-1.5 h-control px-1.5 rounded border border-input-border bg-input focus-within:outline focus-within:outline-1 focus-within:outline-(--c-focus) focus-within:-outline-offset-1`; inner `<input data-bare>`; leading `search` 16; trailing clear `IconButton sm` |
| `FormField` | `<div>` root holding `<label><span class="block text-label font-semibold text-ink-secondary mb-1">{label}</span>{control}</label>`, then the description (`text-meta text-ink-muted`) and the error (`<p data-cv-error class="text-meta text-danger">`); the control gets `aria-describedby` and `aria-invalid` |

Every field sets an explicit font size (24 fields today inherit 16px [V, carried]).

### 4.5 Select

A native `<select>`: `appearance-none h-control w-full rounded border border-(--c-dropdown-border) bg-(--c-dropdown-bg) pl-1.5 pr-6 text-body text-ink` plus a `chevronDown` 16 at `right: 4px`. The popup list follows `color-scheme`. Every `aria-label` is kept (`select[aria-label="Lock the vault when idle"]`, B28).

### 4.6 Checkbox, Radio, Switch, Slider

| Primitive | Recipe |
|---|---|
| `Checkbox` | `<label class="inline-flex items-start gap-2 text-body text-ink-secondary">` + an 18 × 18 `appearance-none` input, radius 3, `border-(--c-checkbox-border) bg-(--c-checkbox-bg)`, checked `bg-btn-primary border-btn-primary` with a white `check`; 2px outside focus ring |
| `Radio` / `RadioGroup` | `<label>` wrapping a 16px round input and the exact option text; checked shows an 8px `--c-btn-primary-bg` dot; `role="radiogroup"` with arrow keys |
| `Switch` | `<button role="switch" aria-checked>`: track 28 × 16 `rounded-full`; off `bg-(--c-checkbox-bg)` with a 1px `--c-checkbox-border`; on `bg-btn-primary`; thumb 12 × 12 |
| `Slider` | native range, `w-full accent-(--c-accent) h-4`; min, mid and max labels `text-meta text-ink-muted` |

### 4.7 Tabs, SegmentedControl, NavList

| Primitive | Recipe | Used for |
|---|---|---|
| `Tabs variant="panel"` | strip `flex items-center gap-1 h-part-title px-1`; tab `h-6 px-2.5 rounded text-body text-(--c-tab-fg) hover:bg-hover hover:text-(--c-tab-fg-hover)`; selected `bg-selected-inactive text-(--c-tab-fg-active)`; `role="tablist"` / `tab` with arrow keys | The Markdown editor's Write and Preview |
| `Tabs variant="underline"` | strip `h-part-title border-b border-divider`; selected `border-b-2 border-(--c-tab-underline)` | gallery only |
| `SegmentedControl` | container `inline-flex gap-0.5 p-0.5 rounded-md bg-well`; item `h-control-sm px-2 rounded text-label text-ink-muted hover:text-ink`; selected `bg-selected text-ink`; `role="radiogroup"` | Brightness, Quick Connect types, SSH auth method |
| `NavList` | rows `flex items-center gap-2 h-row px-2 rounded text-body text-ink-secondary hover:bg-hover`; selected `bg-selected text-ink` + `data-selected`; group row with a chevron 16; group label `h-row px-2 text-meta font-semibold text-ink-muted` | Settings nav (keeps `w-52`), entry dialog nav, vault settings nav |

The pane tab bars are not `Tabs`: they keep their own markup with `tabs.css` (3.4).

### 4.8 Dialog, ConfirmDialog and the layer stack

`<Dialog open onClose? title icon? tone? size="sm|md|lg|xl" width? layer="base|sync|stacked" harnessLabel? closeOnEscape? closeOnScrim? initialFocusRef? footer? hideClose? onSubmit? portal?>`

**(restyle, D-26)** `closeOnEscape` (default `true`) decides whether Escape calls `onClose`; with `false` the dialog's layer still swallows Escape, so nothing underneath closes (`layers.ts`: "A layer without an Escape action still swallows the key" [V]). `onClose` may be left out only together with `hideClose` and `closeOnEscape={false}` (and no `closeOnScrim`): a dialog that cannot be dismissed, such as the recovery passphrase. The type makes the other combinations a compile error. Each dialog's values come from 3.12.1.

| Part | Recipe |
|---|---|
| Portal and scrim | portal to `document.body` (unless `portal={false}`); `fixed inset-0 flex items-center justify-center p-4 bg-(--c-scrim)`; z-index from `layer` (50, 60, 70); `data-cv-layer` |
| Panel | `data-dialog-content role="dialog" aria-modal="true" aria-labelledby={titleId}` + `relative flex w-full max-h-[85vh] flex-col overflow-hidden rounded-lg border border-overlay-border bg-overlay text-ink shadow-modal` |
| Width | `size`: `sm` 400, `md` 520, `lg` 720, `xl` 880. **(restyle)** `width` (px) overrides the step with an inline `max-width`, so a dialog keeps today's width (D-18): a dialog with `max-w-md` passes `width={448}`, `max-w-lg` 512, `max-w-xl` 576, `max-w-2xl` 672, `max-w-3xl` 768, `max-w-4xl` 896, an arbitrary `max-w-[Npx]` or a fixed `w-[Npx]` (the vault and team dialogs) passes N; a dialog whose width changes by step (the entry dialog: `max-w-md`, then `max-w-3xl` for the form) passes the step's value |
| Form | with `onSubmit`, one `<form data-cv-dialog-form>` wraps header, body and footer (B31) |
| `harnessLabel` | also sets `aria-label`; only sync-style dialogs pass it (B9) |
| Header | `flex items-center gap-2 px-4 pt-4 pb-3`; optional tone tile `size-7 rounded-md`; `<h2 class="flex-1 text-heading text-ink">` (13px/600); close `IconButton md` `close` `label="Close"`, left out with `hideClose` |
| Body | `min-h-0 flex-1 overflow-y-auto px-4 py-2 text-body text-ink-secondary`; message boxes show their message in `text-ink-muted` |
| Footer | the last child: `flex flex-wrap justify-end gap-2 px-4 pt-2 pb-4` + `data-cv-dialog-footer` |
| Motion | none |
| Behavior | `useFreeze(open, "dialog")`; Escape to the top layer only, where it calls `onClose` when `closeOnEscape`; Tab trapped; initial focus; focus returns to the opener; scrim click closes only with `closeOnScrim` |

`DialogHeader`, `DialogBody` and `DialogFooter` serve custom layouts (Settings, the entry dialog); a custom layout without a `DialogHeader` still gets a hidden `h2`.

**ConfirmDialog** (`src/components/common/ConfirmDialog.tsx`, rebuilt on `Dialog` by R3-MISC): props compatible with today's plus `cancelLabel`, `layer` and `closeOnEscape` (default `false`, as today); always `hideClose`. Without `layer` it renders in place (`portal={false}`), so `RecentlyDeletedPanel`'s `z-[70]` wrapper keeps working until R3-SYNC passes `layer="stacked"` and `closeOnEscape` (the panel's Escape cancels that confirm today, 3.12.1).

**Layer stack** (`src/components/ui/layers.ts`): one capturing `keydown` listener; Escape goes to the top layer only; Tab cycles inside the topmost trapping layer and the popovers above it. `src/components/sync/useEscapeLayer.ts` stays a re-export until R4-CLEANUP.

### 4.9 Freeze registry (native web views)

`src/lib/native-freeze/` (wave 1): `acquireFreeze`, `isFrozen`, `subscribe`, `useIsFrozen`, `useFreeze(active, reason, label?)`, `notifyLayoutChanged`, `freezeHolders()` (and `window.__conduitFreeze` in development). `useNativeViewVisibility` reads `isFrozen()`.

Who holds a freeze: every `Dialog`; `SyncDialogFrame`, `ConflictReviewPanel` and `ConfirmDialog` directly; `App.tsx` for its 24 overlay flags (`legacy`) and for the floating side bar or a spilled vault menu (`sidebar`); tab drags (`DragContext`); popovers with `freeze="auto"` whose rect intersects a `[data-cv-session-area]` (**restyle**, D-21), and `freeze={true}` ones, until they unmount. Native popup menus hold none (D-13). The legacy event bridge and the `App.tsx` flag list stay in this release (D-28): R4-CLEANUP adds the overlay-freeze test, which proves every overlay also holds its own freeze, and removing the legacy hold is a follow-up after the release.

### 4.10 Menus and popovers

- **Native popup menus**: 7.1. `showContextMenu(x, y, items, opts)` keeps its signature.
- **`Popover`**: `<Popover anchorRef open onClose placement freeze>`, positioned by `usePopoverPosition` (8px edge, 4px gap); panel `rounded-lg border border-overlay-border bg-overlay shadow-overlay p-1 z-(--c-z-popover)`; `cv-pop-in` 250ms and `cv-pop-out` 150ms; Escape and outside `mousedown` close it.
- **`Menu`** inside a `Popover`, or inside an existing positioned container (the vault switcher and the AI engine dropdown keep theirs, 3.6, 3.7): items `<button role="menuitem">` 24px, `mx-1 px-2`, radius 6, 13px `ink-secondary`, icon 16 `ink-muted`; active item `bg-(--c-menu-selection-bg)` with a 1px `--c-menu-selection-border` outline; danger items `text-danger` on `--c-menu-danger-hover-bg`; separators `h-px my-[5px] bg-divider`; headers `h-6 px-3 text-meta font-semibold text-ink-muted`; Up, Down, Home, End, typeahead.

Users: `VaultSwitcherMenu` and the `ChatPanel` engine dropdown, both inside their existing containers. `ModelPicker`, `ColorPicker` and `IconPicker` are not rebuilt on `Popover` or `Menu`: they keep their layout and take the overlay look (3.16).

### 4.11 Tooltips

Native `title` only: a native tooltip cannot be covered by a native web view. Every title stays exactly as today (8.4).

### 4.12 Badge, Kbd, Spinner

| Primitive | Recipe |
|---|---|
| `Badge` | `inline-flex items-center h-4 px-1 rounded text-badge font-semibold`; tones neutral `bg-selected text-ink-secondary`, accent `bg-badge text-white`, warning, danger, success on their tints |
| `CountBadge` | `min-w-[18px] min-h-[18px] px-[5px] rounded-full text-badge`, accent |
| `Kbd` | `inline-flex items-center h-4 px-1 rounded border border-control text-meta font-mono text-ink-muted` |
| `Spinner` | the `loader` icon spinning at 12, 16 or 24; optional visible `text`; never `role="status"` |

### 4.13 Containers

| Primitive | Recipe |
|---|---|
| `Card` | `rounded-md border border-card-border bg-well p-3` |
| `ChoiceCard` + `ChoiceGroup` | group `role="radiogroup"`, grid; card `role="radio" aria-checked data-cv-choice`, `flex flex-col gap-1.5 rounded-md border border-card-border p-2 text-left hover:border-(--c-control-border)`; checked `border-accent bg-selected-inactive` + `data-selected`; 2px outside focus ring |
| `Callout` | `flex gap-2 rounded-md border p-2.5 text-label`; tones `info`, `warning`, `danger`, `success` on their tints; title `font-semibold text-ink`; body `text-ink-secondary`; actions row of `Button sm`; `size="sm"` uses `p-2`. **(restyle, salvage `ee3bc39`)** `onDismiss` adds an in-flow `IconButton sm` `close` at the top right labeled `dismissLabel` (default `Dismiss`) |
| `Banner` | the 26px banner (3.8), `role="status"`, text in `span.flex-1` + `data-cv-banner-text`. **(restyle)** Actions are `Button size="sm"` (22px): `{label, onClick, disabled?, primary?}`, `variant="primary"` when `primary`, else `secondary` (D-27; wave 1 drew underlined links). The divider is `box-shadow: inset 0 -1px 0 var(--c-divider)` (salvage `ca9659c`); `status={false}` omits `role="status"` for the offline banners; `align="center"` centers the icon, text and actions as one group, the text span not growing (the offline banners, as today; the harness reads `span.flex-1` only inside `role="status"` banners, B15) |
| `EmptyState` | `flex flex-col items-center gap-2 py-8 text-center`; icon 32 `text-ink-faint`; title `text-body text-ink-secondary`; description `text-label text-ink-muted` |
| `SectionHeader` | `<h3 class="text-label font-semibold text-ink-secondary">` (stays an `h3`, B37) |
| `SettingsRow` | `grid gap-1 py-3 border-b border-divider last:border-0`; title `text-body font-semibold text-ink`; description `text-label text-ink-muted`; the Backup toggles keep their `<label>` and a direct-child `Switch` (B22, B39) |

### 4.14 ListRow and TreeRow

`ListRow`: `flex items-center gap-1.5 h-row px-2 rounded text-body text-ink-secondary`; a `<button>` when clickable; states hover `bg-hover`, selected `bg-selected text-ink`, unfocused selection `bg-selected-inactive`; `description` makes it 36px with a `text-meta text-ink-muted` line. `leading`: an icon source draws in a 16px box; **(restyle)** an element (the hub's 28px icon tile, an entry icon) sizes itself in a `shrink-0` slot. **(restyle)** `meta`: always visible, after the label and inside the clickable button, `shrink-0 text-meta text-ink-faint` (badges, timestamps, type labels; L-23). `trailing`: small `IconButton`s or a decorative chevron, revealed on hover or focus-within by opacity (B45), outside the clickable button.

`TreeRow`: 22px, `padding-left: calc(4px + depth * 8px)`, a 16px twistie slot on every row, 6px gaps. The entry tree applies this recipe to its own rows (3.6) without `role="treeitem"` (D-20).

### 4.15 Toasts

`ToastCard` (wave 1) is the toast body of 3.14. The toast API (`common/Toast.tsx`) and the overlay protocol are unchanged.

### 4.16 Legacy class map

Each package applies this map to the files it owns, using a primitive wherever one exists. `scripts/redesign/legacy-classes.mjs` reports these patterns inside class strings only.

| Legacy | New |
|---|---|
| `bg-canvas` on a session, pane, screen or app root | `bg-editor` |
| `bg-canvas` or `bg-panel` on the side bar or the AI panel | `bg-sidebar` |
| `bg-panel` on a pane tab bar | `.cv-tabstrip` (`--c-tabstrip`) |
| `bg-panel` on dialogs, menus and popovers | the primitive (`bg-overlay`) |
| `bg-panel` on bars under a tab strip | `bg-editor` (D-19) |
| `hover:bg-raised`, `hover:bg-well`, `hover:bg-stroke` | `hover:bg-hover` (rows, ghost buttons) or `hover:bg-toolbar-hover` (icon buttons) |
| `bg-conduit-600/20 text-conduit-400`, `bg-conduit-500/10` (selection) | `bg-selected text-ink` + `data-selected` |
| `bg-conduit-500/5 border-conduit-500/20` (info cards) | `Callout tone="info"` |
| `bg-conduit-600 hover:bg-conduit-700/500 text-white` | `Button variant="primary"` |
| `text-conduit-400 hover:text-conduit-300` (links) | `text-link hover:text-link-hover` or `Button variant="link"` |
| `text-red-*`, `bg-red-500/10 border-red-500/20` | `text-danger`, `Callout tone="danger"` |
| `text-amber-*`, `bg-amber-500/10` | `text-warning`, `bg-warning-bg` |
| `text-yellow-400` on favorite stars | `text-favorite` (D-17) |
| `text-yellow-*` elsewhere | `text-warning` |
| `text-green-*`, `bg-green-500` | `text-success`; state dots `--c-state-*` |
| `text-blue-400` (team sync) | `text-info` |
| `text-[10px]`, `text-[11px]` | `text-badge`, `text-meta` |
| `rounded-xl`, `shadow-xl`, `backdrop-blur-sm` on overlays | the `Dialog` primitive |
| `text-2xl font-bold` headings | `text-display` or `text-title` |
| `uppercase` with `tracking-wide*` on section labels | `text-meta font-semibold text-ink-muted`, no uppercase |
| `text-base` | `text-heading` for dialog titles, `text-body` elsewhere |
| `text-xl` | `text-title` |
| `bg-well` or `bg-raised` on code | `bg-code` |
| Tailwind palette entry colors | `text-entry-*` |
| `w-8 h-8 border-2 … animate-spin` spinners | `Spinner` |

Classes the harness still reads (Appendix B allowlist) stay until their hook exists. The dead files (10.5) are skipped.

---

## 5. Icon system

### 5.1 Registry API

Everything lives in `src/lib/icons/` (wave 1). Call sites keep importing named components (`CloseIcon`, `SettingsIcon`, …) or render `<Icon name>`; packs switch underneath them.

| File | Contents after R1-FOUNDATION |
|---|---|
| `types.ts` | `SEMANTIC_ICON_NAMES`: **116 names** (today's 111 plus `menu`, `splitHorizontal`, `splitVertical`, `ellipsis`, `circleFilled`; D-23 retires `panelLeft`, `panelLeftOff`, `panelRight`, `panelRightOff`, `collapseAll`, `account`, `explorer`). `IconProps { size?, className?, style?, compact?, title?, stroke? }`: `compact` now only matters for glyphs with a 12px variant (the state dot), `stroke` is honored by Lucide, Tabler and Hugeicons. `IconPackId = "lucide" \| "phosphor" \| "hugeicons" \| "material" \| "fluent" \| "tabler"`. `ICON_PACKS` in picker order (5.8). `DEFAULT_ICON_PACK = "lucide"`. The deprecated `IconTheme`, `THEME_ICON_DEFAULTS`, `PACK_BY_ICON_THEME` and `isIconTheme` are deleted (no callers outside `src/lib/icons` [V grep]). |
| `pack-cache.ts` | Lucide is imported statically (`LUCIDE_MAPPING`, the initial mapping); `LAZY_ICON_PACKS` = phosphor, hugeicons, material, fluent, tabler, each a dynamic `import()` and therefore its own chunk. |
| `store.ts` | zustand `useIconPackStore {pack, mapping, status, requested, error, loaded}`, `setIconPack(id)`, the request counter that drops stale loads, the `conduit:theme-change` (`detail.iconPack`) and `storage` (`conduit-icon-pack`) listeners; **(restyle)** the applied pack's id on `<html data-cv-icon-pack>` (5.6). The deprecated `setTheme` and `useIconThemeStore` go. |
| `loader.ts` | `loadIconPack(id)`, `preloadAllIconPacks()`, `getPackMapping(id)`, `bootIconPack()` (reads `conduit-icon-pack`; Lucide applies at once, any other pack loads while Lucide shows). The deprecated `loadIconPack(theme)` overload goes. |
| `create-themed-icon.ts`, `Icon.tsx`, `a11y.ts` | Unchanged: named memo components, `<Icon name pack? …>` (with `pack` for previews), decorative by default, `role="img"` with `title`. |
| `serialize.ts` | `iconToSvg(name, size)` for popup menus, cached per `pack:name:size`, cleared on pack change. |
| `glyph.ts` | Generated-glyph renderer, with the `trim` option of the Material salvage (5.4). |
| `licenses.ts` | `ICON_PACK_LICENSES` for the six shipped packs (5.9). |
| `index.ts` | The named exports for all 116 names (`PanelLeftIcon`, `PanelLeftOffIcon`, `PanelRightIcon`, `PanelRightOffIcon`, `CollapseAllIcon`, `AccountIcon`, `ExplorerIcon` go), the registry API, `ICON_PACKS`, `ICON_PACK_LICENSES`. |
| `packs/lucide.ts` + `lucide-wrap.ts` | Lucide, `strokeWidth` 1.5 (1px at 16px, matching Tabler and Hugeicons). |
| `packs/hugeicons.ts` + `hugeicons-wrap.ts` | **New** (5.2). |
| `packs/phosphor.ts`, `packs/fluent.ts`, `packs/tabler.ts` | Today's mappings minus the retired names, `circleFilled` from the shared dot. |
| `packs/material.tsx` + `generated/material.ts` | Material Symbols from the codegen, trimmed (5.4). |
| `packs/state-dot.ts` | **New** (salvage, 5.4). |
| `packs/codicons.tsx`, `generated/codicons.ts` | **Deleted.** |

### 5.2 Packs and delivery

| Id | Label (picker) | Package, version | Delivery | License | Look |
|---|---|---|---|---|---|
| `lucide` | Lucide | `lucide-react` 1.48.0 (exact) | named imports, **entry chunk** (default) | ISC (portions MIT, Feather) | 1.5 stroke, rounded line icons |
| `phosphor` | Phosphor | `@phosphor-icons/react` 2.1.10 | named imports, lazy chunk | MIT | `regular` weight, `fill` for filled names |
| `hugeicons` | Hugeicons | `@hugeicons/core-free-icons` 4.3.5 (exact) | one subpath import per glyph, lazy chunk | MIT | "Stroke Rounded" free set, 1.5 stroke on a 24px grid |
| `material` | Material Symbols | `@iconify-json/material-symbols-light` 1.2.94 | codegen, lazy chunk | Apache-2.0 | outline rounded; filled rounded for filled names |
| `fluent` | Fluent | `@fluentui/react-icons` 2.0.321 | named imports, lazy chunk | MIT | `*Regular` / `*Filled` |
| `tabler` | Tabler (Classic) | `@tabler/icons-react` 3.38.0 (range `^3.36.1`) | named imports, lazy chunk | MIT | today's icons, 1.5 stroke |

All six are devDependencies (D-11). Acceptance: `npm ls --omit=dev --parseable` lists none of them. `@iconify-json/codicon` is removed from `package.json` and `package-lock.json`.

**The Hugeicons adapter** (`packs/hugeicons-wrap.ts`):

```ts
import { createElement, memo } from "react";
import { iconA11yAttributes } from "../a11y";
import { DEFAULT_ICON_SIZE, type IconComponent, type IconProps } from "../types";

/** One glyph of @hugeicons/core-free-icons: [tag, attributes] pairs on a 24px grid (IconSvgObject). */
export type HugeiconsGlyph = ReadonlyArray<readonly [string, Readonly<Record<string, string | number>>]>;

export const HUGEICONS_STROKE_WIDTH = 1.5;
const TAGS: ReadonlySet<string> = new Set(["path", "circle", "ellipse", "line", "polyline", "polygon", "rect", "g"]);

export function wrapHugeicon(glyph: HugeiconsGlyph, name: string, options: { filled?: boolean } = {}): IconComponent {
  const Wrapped = memo(function WrappedHugeicon(props: IconProps) {
    const size = props.size ?? DEFAULT_ICON_SIZE;
    const strokeWidth = props.stroke ?? HUGEICONS_STROKE_WIDTH;
    const children = glyph.map(([tag, { key, ...attrs }], index) => {
      if (!TAGS.has(tag)) throw new Error(`Hugeicons ${name}: unexpected <${tag}>`);
      return createElement(tag, {
        ...attrs,
        ...("strokeWidth" in attrs ? { strokeWidth } : {}),
        ...(options.filled ? { fill: "currentColor" } : {}),
        key: String(key ?? index),
      });
    });
    return createElement(
      "svg",
      { viewBox: "0 0 24 24", width: size, height: size, fill: "none", className: props.className, style: props.style,
        ...iconA11yAttributes(props.title) },
      children,
    );
  });
  Wrapped.displayName = `Hugeicons(${name})`;
  return Wrapped;
}
```

`packs/hugeicons.ts` imports each glyph from its own subpath (the package's `exports` map has a `./*` wildcard to `./dist/esm/*.js` with types in `./dist/types/*.d.ts` [V]):

```ts
import Cancel01Icon from "@hugeicons/core-free-icons/Cancel01Icon";
// … one import per glyph of Appendix A.2 …
export const mapping: IconMapping = {
  close: wrapHugeicon(Cancel01Icon, "Cancel01Icon"),
  // …
  starFilled: wrapHugeicon(StarIcon, "StarIcon", { filled: true }),
  pinFilled: wrapHugeicon(PinIcon, "PinIcon", { filled: true }),
  playerStopFilled: wrapHugeicon(StopIcon, "StopIcon", { filled: true }),
  circleFilled: createStateDotIcon("Hugeicons"),
};
```

The data already carries `stroke="currentColor"`, round caps and joins and `strokeWidth: "1.5"` [V `Cancel01Icon.js`], so every glyph draws in the text color like the other packs. The free set has no filled style; the three filled names render the outline glyph with `fill="currentColor"` (each is one closed shape, plus a line for the pin's needle [V data]).

### 5.3 Codegen (Material Symbols only) and the licenses file

`scripts/icons/generate-icon-packs.mjs` (`npm run icons:generate`, `--check` in tests) keeps its strict body parser and emits only `src/lib/icons/generated/material.ts` and `public/licenses/third-party-icons.txt`.

- `scripts/icons/mapping.mjs` rows become `row(name, material, materialFill)`: the `codicon` and `codiconCompact` columns, the seven retired names and the `circleFilled` row (the shared dot draws it) are removed. 115 rows.
- The generator no longer reads `@iconify-json/codicon`, emits `generated/codicons.ts` or vendors `scripts/icons/licenses/codicon.txt` (deleted).
- `LICENSE_SOURCES` lists the six shipped packs in picker order (5.9). `licenseText()` reads a package's own `LICENSE`, then `LICENSE.md`, then `LICENSE.txt`, and falls back to a vendored text: `@hugeicons/core-free-icons` ships `LICENSE.md` (MIT, "Copyright (c) 2025 Hugeicons") [V tarball]; Fluent and Material keep their vendored texts. The declared license is still checked against `package.json` (`MIT` for Hugeicons [V]).

### 5.4 The shared state dot and the Material trim (salvage)

- **State dot** (cherry-pick `588e2ad`, adapted): `packs/state-dot.ts` defines one 8px disc (`M8 4a4 4 0 1 1 0 8a4 4 0 0 1 0-8` in a 16px box, and a 12px compact variant with the same 8px disc) and `createStateDotIcon(label)`. Every pack's `circleFilled` is that icon, so tab dots and sync dots never change size with the pack. The commit's test compared every pack with Codicons; the port compares every pack with the disc's own geometry (`x: [4, 12], y: [4, 12]` at 16px; `[2, 10]` at 12px or compact) using the salvaged `__tests__/svg-extent.ts`.
- **Material trim** (cherry-pick `47a782a`, code hunks only): `MATERIAL_TRIM = 1.35` viewBox units cut from each side, because Material Symbols keep a 2px padding on their 24px grid and drew about a third smaller than the other packs. 1.35 is the widest trim that clips no mapped glyph (`wifiOff` reaches x 1.41 and 22.61); with the retired names gone the set only shrinks, so it still clips nothing. The test compares the state dot with Lucide's instead of Codicons'.

### 5.5 Size policy

Icons render at 12, 16, 20, 24, 32 or 48px. The restyle rounds today's 10 and 11 to 12, 13 and 14 to 16, 18 to 16 (or 20 in `lg` controls). `R4-CLEANUP` adds `src/components/__tests__/icon-sizes.test.ts`, which fails on any other literal `size={n}` under `src/components/`, except custom entry icons (`iconRegistry.ts`) and `EngineLogo`. State dots are the `circleFilled` glyph at 12 or 16, never a smaller icon.

### 5.6 Loading in every window

`src/main.tsx`, `src/overlay.tsx` and `src/picker.tsx` call `bootIconPack()` before the first render (wave 1). The overlay and picker windows follow pack changes through the `storage` event (`store.ts` `handleStorage` [V]). Lucide being static means no window ever shows a missing icon. **(restyle)** Whenever a pack applies, the store writes its id to `<html data-cv-icon-pack>` in that window, so the `packs` scenario (8.6) can prove that every window, toasts and the credential picker included, follows each of the six packs.

### 5.7 Popup menu icons

`PopupMenuItem.icon` takes a semantic name or one of today's menu keys, which `src/utils/contextMenu.ts` maps (salvaged `LEGACY_MENU_ICON_KEYS`): `play` → `playerPlay`, `edit` and `rename` → `pencil`, `copy-host` → `copy`, `reconnect` → `refresh`, `connect` → `plug`, `folder-plus` → `folderPlus`, `external-link` → `externalLink`, `dots` → `ellipsis`, `chevron-right` → `chevronRight`, `star-off` → `star`, `split` → `splitHorizontal`; other keys are semantic names already. The helper sends each icon as `iconSvg: iconToSvg(name, 16)` from the active pack; the main process sanitizes it (7.1). R4-CLEANUP converts the remaining call sites to semantic names and deletes the map.

### 5.8 Settings pack picker

Settings > Appearance, first section (in the slot of the retired Platform Theme block), `data-cv-appearance="icon-pack"`:

- Section label `Icon pack`: a `<label>` in the tab's section label style, like its three siblings (6.4).
- `ChoiceGroup` (3 columns, `gap-2`) of six `ChoiceCard`s (`value` = pack id, `data-cv-choice={id}`) in this order: **Lucide**, Phosphor, Hugeicons, Material Symbols, Fluent, Tabler (Classic).
- Each card: a preview well (`flex h-8 items-center gap-2 rounded bg-well px-2`) with `folder`, `terminal`, `desktop`, `globe`, `key`, `search`, `settings`, `cloud` at 16px in `text-ink-secondary`, rendered from that card's pack with `<Icon name pack={id} />`; the label (`text-label font-semibold text-ink`), with a neutral `Badge` "Default" on Lucide; the description (`text-meta text-ink-muted`) from `ICON_PACKS`:

| Pack | Description |
|---|---|
| Lucide | `Clean line icons · ISC` |
| Phosphor | `Soft, rounded icons · MIT` |
| Hugeicons | `Rounded line icons · MIT` |
| Material Symbols | `Google Material icons · Apache 2.0` |
| Fluent | `Windows 11 icons · MIT` |
| Tabler (Classic) | `The classic Conduit icons · MIT` |

- The tab calls `preloadAllIconPacks()` on mount, so the previews render from their own packs (an `<Icon pack>` falls back to the active pack until its pack loads).
- A click selects the card, sets `icon_pack` in the dialog state and dispatches `conduit:theme-change` with `{iconPack}`, which previews the pack live in every window. Save persists it; Cancel reverts it (`SettingsDialog`'s snapshot already includes `iconPack` [V `SettingsDialog.tsx:40`]).

### 5.9 Licenses and notices

Only packs that ship are listed. `ICON_PACK_LICENSES` and the generated `public/licenses/third-party-icons.txt` (copied to `dist/` by Vite) carry, in picker order:

| Pack | Notice |
|---|---|
| Lucide | Lucide © Lucide Icons and Contributors, licensed under ISC. Portions © Cole Bemis (Feather), licensed under MIT. |
| Phosphor | Phosphor Icons © Phosphor Icons, licensed under MIT. |
| Hugeicons | Hugeicons Free © Hugeicons, licensed under MIT. |
| Material Symbols | Material Symbols © Google, licensed under Apache 2.0. Converted from SVG to React path data. |
| Fluent | Fluent UI System Icons © Microsoft Corporation, licensed under MIT. |
| Tabler (Classic) | Tabler Icons © Paweł Kuna, licensed under MIT. |

The file holds each pack's full license text. No Codicons notice and no CC BY text remain. Shipping the file meets the license terms: Vite copies `public/` to `dist/`, and `electron-builder.yml` packs `dist/**/*` into the app [V]. **(restyle)** No About view is added: a "Third-party licenses" control would be a new control (D-1).

### 5.10 Hugeicons verification record

Checked 2026-09-28 [V]:

| Check | Result |
|---|---|
| `npm view @hugeicons/core-free-icons` | version 4.3.5, license MIT, 80,424,685 bytes unpacked, 24,293 files, repository `github.com/hugeicons/hugeicons`, modified 2026-09-21 |
| Tarball | `npm pack` into `<scratchpad>/restyle/hugeicons/`: integrity `sha512-Sv+NjHRPnQk+yZsGCMcGznCHdTfJR9PMMOEKcJYAQU4gy90dmlc9PwdtvYOImBZIjiheMsTLL5eMn2DmHxUiUg==` |
| License file | `LICENSE.md`: the MIT text, "Copyright (c) 2025 Hugeicons". The README describes the free package as 6,000+ "Stroke Rounded" icons; the Pro terms (`PRO-LICENSE.md` in `@hugeicons/react`) cover only `@hugeicons-pro/*` packages |
| Contents | 6,069 icon modules in `dist/esm`, each `export default [[tag, attrs], …]`; `sideEffects: false`; `exports` has `./*` → `./dist/esm/*.js` (types `./dist/types/*.d.ts`) |
| Coverage | all 115 glyphs of Appendix A.2 exist; none is marked `@deprecated` (the older `LayoutTwoColumnIcon` and `LayoutTwoRowIcon` are, so A.2 uses `Layout2ColumnIcon` and `Layout2RowIcon`); 110 exact, 2 substitutes (`globeWww` → `InternetIcon`, `devices` → `ComputerPhoneSyncIcon`), 3 filled from outlines, `circleFilled` from the shared dot |
| Menu sanitizer | the glyphs use only `path` (305), `circle` (10) and `ellipse` (1) with `d`, `stroke`, `stroke-linecap`, `stroke-linejoin`, `stroke-width`, `cx`, `cy`, `r`, `rx`, `ry`, `transform`, `fill-rule`, `clip-rule`, all on the allowlist of 7.1; the one `transform` (`matrix(1 0 0 -1 16 8.00024)` in `Tag01Icon`) passes its value check |
| Bundle | the research bundle of 108 Hugeicons glyphs measured 88 KB raw, 23.5 KB gzip, as a lazy chunk [V `<scratchpad>/iconlab/bundle.json`] |
| Not used | `@hugeicons/react@1.1.10` (MIT; adds a `color` attribute the sanitizer drops, D-10); `hugeicons-react@0.4.0` (CC0, an older wrapper over core 3.x); `@iconify-json/hugeicons@1.2.35` (MIT, 6,065 icons; its stroke bodies would need the codegen parser widened, and the official package is the source of truth) |

The research copy is unpacked at `<scratchpad>/restyle/hugeicons/core/package/` (temporary). Once R1-FOUNDATION installs the package, the registry tests (every name maps) and `scripts/__tests__/menu-svg-packs.test.ts` (every glyph passes the sanitizer) repeat the coverage and allowlist checks on every run, so no research script needs to outlive the session.


### 5.11 Custom entry icons (restyle, D-29)

Custom entry and folder icons are stored as Tabler export names and resolved by `resolveIcon()` in `src/components/entries/iconRegistry.ts`, which imports `@tabler/icons-react` directly (65 curated names) [V]. With Lucide as the default, they would draw in Tabler style next to Lucide glyphs. R3-ENTRIES adds `CUSTOM_ICON_TWINS` to `iconRegistry.ts`: the 30 curated names that the Tabler pack itself maps from a semantic name [V computed from `packs/tabler.ts` and `iconRegistry.ts`], which `getEntryIcon()` and the `IconPicker` grid render through the active pack (the named themed components, for example `ServerIcon`):

| Stored name | Semantic | Stored name | Semantic | Stored name | Semantic |
|---|---|---|---|---|---|
| `IconTerminal2` | `terminal` | `IconTerminal` | `terminalAlt` | `IconDeviceDesktop` | `desktop` |
| `IconServer` | `server` | `IconServer2` | `serverAlt` | `IconWorld` | `globe` |
| `IconWorldWww` | `globeWww` | `IconCloud` | `cloud` | `IconDatabase` | `database` |
| `IconNetwork` | `network` | `IconKey` | `key` | `IconLock` | `lock` |
| `IconShieldLock` | `shieldLock` | `IconFingerprint` | `fingerprint` | `IconCode` | `code` |
| `IconBug` | `bug` | `IconTool` | `tool` | `IconDeviceFloppy` | `floppy` |
| `IconFolder` | `folder` | `IconFolderOpen` | `folderOpen` | `IconFileText` | `fileText` |
| `IconHome` | `home` | `IconUser` | `user` | `IconUsers` | `users` |
| `IconStar` | `star` | `IconTag` | `tag` | `IconBolt` | `bolt` |
| `IconRocket` | `rocket` | `IconCrown` | `crown` | `IconPlayerPlay` | `playerPlay` |

The other 35 (the nine `IconBrand*` icons, `IconApi`, `IconRouter`, `IconWifi`, `IconCertificate`, `IconBraces`, `IconGitBranch`, `IconCpu`, `IconDeviceNintendo`, `IconArchive`, `IconFiles`, `IconBuilding`, `IconBriefcase`, `IconSitemap`, `IconHeart`, `IconBookmark`, `IconFlag`, `IconDiamond`, `IconFlame`, `IconMedal`, `IconTrophy`, `IconChartBar`, `IconChartPie`, `IconTrendingUp`, `IconCloudComputing`, `IconPuzzle`, `IconPackage`) keep their Tabler glyph in every pack. Stored names never change, so older builds and other devices read the same vault data. A test asserts that every twin equals the Tabler pack's own mapping (`packs/tabler.ts` maps the semantic name to the same export) and that every twin is a curated name.

---

## 6. Settings and migration

### 6.1 Keys

| Key | Type | Default | Values | Read by |
|---|---|---|---|---|
| `color_scheme` | string | `modern` | `modern`, `ocean`, `ember`, `forest`, `amethyst`, `rose`, `midnight` | renderer; main (`backgroundColor`, 7.2) |
| `theme` | string | `system` | `dark`, `light`, `system` | renderer; main (`set-native-theme`, `backgroundColor`) |
| `icon_pack` | string | **`lucide`** (was `codicons`) | `lucide`, `phosphor`, `hugeicons`, `material`, `fluent`, `tabler` | renderer |
| `appearance_version` | number | `2` | | migration |
| `ui_scale` | number | `1.0` | 0.75 to 1.5 | unchanged |
| ~~`platform_theme`~~, ~~`ui_density`~~, ~~`title_bar_style`~~ | retired | | | deleted by the migration (6.3) |

`localStorage` mirrors for the first paint: `conduit-theme`, `conduit-color-scheme`, `conduit-icon-pack`, `conduit-appearance-version`. Retired and removed at boot: `conduit-platform-theme`, `conduit-density`.

Code: `AppSettings` and `defaultSettings` in `electron/ipc/settings.ts:63-128`; `Settings` in `SettingsHelpers.tsx:6-26`; the dialog's initial state and snapshot in `SettingsDialog.tsx:36-60`; the `conduit:theme-change` detail becomes `{theme, colorScheme, iconPack}`.

### 6.2 Appearance runtime

`src/lib/appearance/` (wave 1), after R1-FOUNDATION:

| File | Role |
|---|---|
| `boot-inline.js` | Pre-paint script, inlined into `index.html`, `overlay.html`, `picker.html` and `gallery.html` by the `conduitAppearanceBoot()` Vite plugin. Migrates `localStorage` (6.3), then sets the `dark` or `light` class, `data-scheme`, `data-os`, and `--c-boot-bg` / `--c-boot-fg` from `shell-colors.json`. **Removed:** `data-density`, `--c-zoom`, the `zoomFactor()` probe. |
| `useAppearance.ts` | Applies `conduit:theme-change`, follows `prefers-color-scheme` for `system`, writes `localStorage`, sends `set-native-theme`, dispatches `conduit:resolved-theme-change` and `conduit:appearance-applied` `{scheme, mode, iconPack}` (no density). Reconciles with `settings_get` on mount. `src/hooks/useTheme.ts` stays a re-export until R4-CLEANUP. |
| `dom.ts` | `applyAppearanceAttributes(root, {mode, scheme})`; `isDensity` and the `Density` type go. |
| `migrate.ts` + `migration-table.json` | The renderer migration (6.3). |
| `shell-colors.json` | `{shell, fg}` per scheme and mode (2.3). |
| `resolveCssColor.ts` | 2.11. |

`src/lib/schemes.ts` keeps `COLOR_SCHEMES` (Modern first) with preview colors.

### 6.3 Migration

The same rules run in the main process on every settings read (`electron/services/appearance-migration.ts`, called from `readSettings()`) and in the renderer before first paint (`boot-inline.js`, `migrate.ts`). Every rule reads the **raw** stored values (in the main process: the parsed file before defaults are spread over it).

1. **Retired keys** `platform_theme`, `ui_density` and `title_bar_style` are always deleted (renderer: `conduit-platform-theme`, `conduit-density`).
2. If `raw.appearance_version >= 2`: validate. The scheme goes through `retiredSchemes` first, because a released build that a user downgraded to keeps `appearance_version` and can store a retired scheme (it saves `{...defaultSettings, ...raw}` [V `270ae43` `electron/ipc/settings.ts:165,206`]); then an unknown scheme becomes `modern`. An unknown pack, including the retired `codicons`, becomes `lucide`.
3. Otherwise (a file from a released build): `platform = raw.platform_theme ?? "default"`, `scheme = raw.color_scheme ?? "ocean"`; `icon_pack = valid(raw.icon_pack) ? raw.icon_pack : PACK_BY_PLATFORM[platform] ?? "lucide"`; `color_scheme = RETIRED[scheme] ?? (platform === "default" && scheme === "ocean" ? "modern" : scheme)`, then validated.
4. In both branches an unknown `theme` becomes `system`.
5. Set `appearance_version` to `max(2, the stored integer)`: a higher version written by a later build is kept, never written back as 2 (`keptVersion()` [V]). When anything changed and `settings.json` exists, the main process writes it back once.

`migration-table.json` (and its main-process twin):

```json
{
  "version": 2,
  "schemes": ["modern", "ocean", "ember", "forest", "amethyst", "rose", "midnight"],
  "iconPacks": ["lucide", "phosphor", "hugeicons", "material", "fluent", "tabler"],
  "themes": ["dark", "light", "system"],
  "defaults": { "color_scheme": "modern", "icon_pack": "lucide", "theme": "system" },
  "legacy": { "platform_theme": "default", "color_scheme": "ocean" },
  "packByPlatform": { "macos": "phosphor", "windows": "fluent", "ubuntu": "tabler" },
  "retiredKeys": ["platform_theme", "ui_density", "title_bar_style"],
  "retiredSchemes": {
    "macos-blue": "modern", "macos-graphite": "modern", "win-blue": "modern",
    "win-sun-valley": "modern", "ubuntu-yaru": "ember", "ubuntu-gnome": "modern"
  }
}
```

| Stored before (platform, scheme, pack) | After scheme | After pack | Why |
|---|---|---|---|
| `default` or none, `ocean` or none | `modern` | `lucide` | untouched default gets the new look (OD-4, OD-7) |
| `default`, a universal scheme other than Ocean | kept | `lucide` | everyone else defaults to Lucide |
| `macos`, `macos-blue` or `macos-graphite` | `modern` | `phosphor` | the pack macOS-theme users saw |
| `windows`, `win-blue` or `win-sun-valley` | `modern` | `fluent` | the pack Windows-theme users saw |
| `ubuntu`, `ubuntu-yaru` | `ember` | `tabler` | nearest universal scheme; Tabler (Classic) is what the Ubuntu theme used |
| `ubuntu`, `ubuntu-gnome` | `modern` | `tabler` | |
| `macos` / `windows` / `ubuntu`, a universal scheme | kept | per platform | "other choices keep their scheme" |
| version 2 (a wave-1 development profile), `icon_pack: "codicons"` | kept | `lucide` | Codicons retired (D-14) |
| version 2 with `ui_density` or `title_bar_style` | kept | kept | keys deleted |
| version 2 with `ubuntu-yaru` (a released build wrote it after a downgrade) | `ember` | kept | retired schemes map in both branches (rule 2) |
| any version with `theme: "bogus"` | per the rows above | per the rows above | `theme` becomes `system` (rule 4) |
| version 3 (written by a later build) | validated | validated | `appearance_version` stays 3 (rule 5) |

- **Idempotence**: `migrate(migrate(x))` equals `migrate(x)` (`fast-check`, both sides, with generators that include retired schemes in version-2 files, invalid themes and versions above 2).
- **Integration**: `electron/services/__tests__/appearance-migration.test.ts` writes legacy and version-2 files to a temporary data dir, calls `readSettings()` twice, and asserts the values, the deleted keys, one write-back and no second write.
- **Parity**: `scripts/__tests__/appearance-migration-parity.test.ts` runs `boot-inline.js` in jsdom, `migrate.ts` and the main-process migration on the same inputs and asserts equal results; `scripts/__tests__/icon-packs.test.ts` asserts `migration-table.json`'s `iconPacks` equals the ids of `ICON_PACKS` (read with `fs`).
- **Downgrade**: an older released build ignores `icon_pack`, shows its default look for `modern`, and treats the missing `platform_theme` as default.

### 6.4 Appearance tab (final)

R1-FOUNDATION adds the Icon pack section to today's tab; R3-SETTINGS restyles the rest. The four section labels stay `<label>` elements (as today's three), taking the section label look (`text-label font-semibold text-ink-secondary`), so the inventory keeps their tag (8.6). Top to bottom, as today with the Platform Theme slot reused [BEFORE 20-02]:

| Section (`data-cv-appearance=`) | Control | Details |
|---|---|---|
| `icon-pack`: "Icon pack" | `ChoiceGroup`, 3 columns, 6 cards | 5.8 |
| `scheme`: "Color Scheme" | `ChoiceGroup`, 3 columns (as today), 7 `ChoiceCard`s, Modern first | Preview: a `shell` strip with an `editor` block and an `accent` bar from `COLOR_SCHEMES[i].preview[mode]`; the label below. Replaces `SchemeCard` |
| `mode`: "Brightness" | `SegmentedControl`: Dark, Light, System | label and options unchanged; beside UI Scale as today |
| `scale`: "UI Scale" | the slider, the percentage and Reset | behavior and zoom sync unchanged |

Every control previews live through `conduit:theme-change`; Save persists; Cancel reverts scheme, mode, pack and zoom (`SettingsDialog.tsx`).

---

## 7. Main process

The native frame, zoom handling (`setZoomFactor` at `ready-to-show`, `set-zoom-factor`), the application menu, the tray, the toast overlay window and the picker window stay as they are (D-8, D-15). Two things change.

### 7.1 Popup menu window (W2-MENUS salvage)

`electron/ipc/menu.ts` and the new `electron/ipc/menu-svg.ts` come from `8ca0d23`, `98abd31` and `70fd889` (9.2). What they do:

| Property | Today (`menu.ts` at `41d9657`) | Restyled | Source |
|---|---|---|---|
| Width | 210 fixed | per panel, 220 to 320: the longest label's estimated width plus the row chrome; longer labels ellipsize | [ADAPT] the window is sized before its page renders; a fixed 220 cut `Sign in to start a free Pro trial` (`70fd889`) |
| Row | 30 (`padding: 5px 12px`, 13/20) | 24: `height: 24px; margin: 0 4px; padding: 0 8px; border-radius: 6px; gap: 8px; font: 13px/24px` | [V] VS Code menu item 24, radius 6 |
| Separator | 9 (`margin: 4px 8px`) | 11: a 1px line, `margin: 5px 0` | [V] |
| Header | 24, 10px/600 uppercase | 24, 11px/600, no uppercase, `inkMuted` | [ADAPT] Modern UI drops uppercase |
| Panel | radius 8, `padding: 4px 0`, 1px border, `0 4px 24px` shadow | radius 8, `padding: 4px 0`, 1px `overlayBorder`, `0 0 12px rgba(0,0,0,.14)`, inside a 12px transparent window margin | [V] `--vscode-shadow-lg` |
| Font | `Inter, system-ui` | `-apple-system, BlinkMacSystemFont, "Segoe WPC", "Segoe UI", system-ui, Ubuntu, sans-serif` | OD-8 |
| Colors | `panel`, `raised`, `ink`, `inkFaint`, `strokeDim` from `getComputedStyle` | `{overlay, overlayBorder, inkSecondary, inkMuted, selectionBg, selectionBorder, danger, dangerHover, divider}` resolved to `#rrggbb` by `resolveCssColor` (alpha over `--c-overlay`); the main process validates each with `/^#[0-9a-f]{6}$/i` and falls back to built-in Modern values. **(restyle)** The cherry-picked fallback `MODERN_MENU_COLORS` carries VS Code's blue (`selectionBg` `#243239` / `#E1ECF8`, `selectionBorder` `#3994BC` / `#0069CC` [V `98abd31`]); it takes Modern's sky accent (D-25): `selectionBg` `#1D3540` dark and `#E2F2FB` light (15% and 10% of `#0EA5E9` over the overlay [V computed]), `selectionBorder` `#0EA5E9` | 2.2.3 |
| Selection | bg `raised` | `selectionBg` + 1px inset `selectionBorder` | [V] 2026 menu selection |
| Danger | `#f87171` and a 12 to 15% tint | `danger` text on `dangerHover` | |
| Icons | 25 inline Tabler paths | `iconSvg` per item from the active pack (5.7) after `sanitizeSvg()` | OD-4 |
| Keyboard | Escape only | Up, Down, Home, End (skipping separators and headers), Enter, Space, Right (open a submenu), Left (close it), Escape | |

- **Geometry**: the visible panel is flipped and clamped against the display work area at the click point (or anchored right, for `+`), then the window is created 12px larger on every side for the shadow; submenus open beside their row, flipping to the left when there is no room.
- **Margin clicks dismiss**: a `mousedown` outside `.m` and `.sm` reports a dismiss, so a click in the transparent margin closes the menu.
- **Injection fix**: labels are HTML-escaped; ids must match `^[A-Za-z0-9_:.-]{1,64}$` (others are dropped with a warning); the page reports a flattened item index, which the main process maps back to the id.
- **`sanitizeSvg(svg)`** rebuilds icon markup from the elements `svg`, `g`, `path`, `circle`, `ellipse`, `line`, `polyline`, `polygon`, `rect` and the attributes `xmlns`, `viewBox`, `width`, `height`, `d`, `fill`, `fill-rule`, `clip-rule`, `stroke`, `stroke-width`, `stroke-linecap`, `stroke-linejoin`, `cx`, `cy`, `r`, `rx`, `ry`, `x`, `y`, `x1`, `y1`, `x2`, `y2`, `points`, `transform`, `opacity`, `fill-opacity`, `stroke-opacity`; values must match `^[A-Za-z0-9\s.,#%()+-]*$`; it rejects scripts, event handlers, links, styles, text, comments and markup over 8 KB, and drops other attributes. Every glyph of every pack passes it unchanged except for `aria-hidden` and `focusable` (`scripts/__tests__/menu-svg-packs.test.ts`).

The menu is still a separate child window, so it draws above native web views without freezing them. Positions come from `getContentBounds()` as today.

### 7.2 Window background color

`electron/main.ts:709` sets `backgroundColor: '#0f172a'` for every scheme and mode. After R1-FOUNDATION:

- `electron/services/appearance-palette.ts` exports `SHELL_PALETTE` (the `shell` values of `shell-colors.json`, duplicated because Electron code never imports from `src/`: `electron/tsconfig.json` has `rootDir: "."`) and `windowBackground(settings, prefersDark)`, which picks the scheme (falling back to Modern) and the mode (`theme`, or `prefersDark` for `system`).
- `createWindow()` uses `windowBackground(readSettings(), nativeTheme.shouldUseDarkColors)`.
- The `settings_save` handler and `nativeTheme.on("updated")` call `mainWindow.setBackgroundColor(...)` with the new value.
- `scripts/__tests__/appearance-palette-parity.test.ts` reads `src/lib/appearance/shell-colors.json` with `fs` and compares it with `SHELL_PALETTE`.

### 7.3 What stays unchanged

`BrowserWindow` options other than `backgroundColor`; `ready-to-show`; the application menu (INVENTORY 1); `overlay-manager.ts` (400 × 500, 16px inset); the picker window (380 × 500); web session views (square, no drag-region stylesheet); `webview2-session.ts`; `electron-builder.yml`; `preload.cts`.

---

## 8. Tests, harness and layout checks

### 8.1 Unit and component tests

The runner is vitest (`vitest.config.ts`, jsdom, `src/test/setup.ts`); main-process tests use `// @vitest-environment node`; tests that import from both `src/` and `electron/` live in `scripts/__tests__/`.

| Package | Test files | What they check |
|---|---|---|
| R1-FOUNDATION | `src/lib/icons/__tests__/{registry,store,serialize}.test.tsx`, `src/lib/icons/__tests__/svg-extent.ts`, `scripts/__tests__/icon-packs.test.ts`, `src/styles/__tests__/*`, `src/lib/appearance/__tests__/*`, `electron/services/__tests__/appearance-migration.test.ts`, `scripts/__tests__/appearance-migration-parity.test.ts`, `scripts/__tests__/appearance-palette-parity.test.ts`, `src/components/ui/__tests__/*` | Every pack maps all 116 names and renders one `<svg>` each; Hugeicons renders only allowlisted tags with `fill="none"` and `stroke="currentColor"`, filled names get `fill="currentColor"`; `circleFilled` draws the same 8px disc in all six packs (16, 20, 12, compact); Material glyphs trimmed by 1.35 and unclipped; Lucide is active before any load and no lazy load is needed for it; stale pack loads are dropped; `iconToSvg` resets on pack change; the codegen `--check` is clean and its license file lists exactly the six packs; the migration table's pack ids equal `ICON_PACKS`; the cascade assertions and contrast gates of 2.1 and 2.10 (with `favorite`); no removed token is defined; every row of the 6.3 table, raw-value reads, retired keys deleted, one write-back, idempotence, renderer and main parity; the palette parity; primitives' roles and markup, `IconButton` without `pressedLook` and with `tone="inherit"` (no text color class), `Callout onDismiss`, `Banner status={false}`, `align="center"` and its 26px row with `Button sm` actions (primary where asked), `Dialog width`, `closeOnEscape={false}` (Escape swallowed, `onClose` not called), `hideClose`, the type error for a missing `onClose` without both; `ListRow` `meta` visible without hover and a self-sized `leading` element; `<html data-cv-icon-pack>` follows the applied pack; the new 6.3 rows (a retired scheme in a version-2 file, an invalid theme, version 3) |
| R1-HARNESS | `scripts/__tests__/restyle-inventory.test.ts`, `scripts/__tests__/verify-harness.test.ts`, `scripts/__tests__/verify-selectors.test.ts`, `scripts/__tests__/check-owns.test.ts` | The inventory comparator: identical lists pass; a removed, added, reordered or relabeled control fails; an added `aria-label`, `title` or `pressed` on a control that had none passes; CSS-uppercase text compares case-insensitively; menu headers ignore case and icons; a `label`'s text leaves out nested controls; `N seconds ago`, the sync state and the vault directory normalize on both sides; the `settings-appearance` delta passes both with and without the Icon pack section and fails on anything else; deltas apply only to their screen. A missing or changed reference file fails. A rule without its hooks reports `pending`, which `--strict` turns into a failure. The runner skips opt-in suites in `all` and starts Supabase only for a selected scenario that needs it. The review-version pair finds the line in both halves (B47). The plan's `wave` and `depends_on` match section 10 |
| R1-MENUS | `electron/ipc/__tests__/menu.test.ts`, `electron/ipc/__tests__/menu-svg.test.ts`, `src/utils/__tests__/contextMenu.test.ts`, `scripts/__tests__/menu-svg-packs.test.ts` | Label escaping; id allowlist; index-to-id mapping; the visible rect flipped and clamped, the window grown by 12 on each side; margin clicks resolve to `null`; panel width from the longest label within 220 to 320; the SVG allowlist rejects `script`, `on*`, `href`, `style`, `foreignObject` and more than 8 KB; old keys map; colors are hex; every icon of every pack passes `sanitizeSvg` unchanged |
| R2-TABS | `src/components/layout/__tests__/PaneTabBar.test.tsx`, `src/components/layout/__tests__/panes.test.tsx` | `data-active` on the active tab only; every tab renders its close button with no hiding class and `label="Close {title}"`; tabs carry `cv-tab` and the label `cv-tab-label` (the shrink rules of 3.4; the real widths are checked live by G10); a dot for every status with today's tooltips; the hamburger rule (absent while docked open, transparent spacer while floating open) with its hook and `aria-expanded`; `+` then `rightSlot` in the last `.cv-tabstrip-slot`; the drop marker adds no width; wheel scrolls horizontally; the activated tab scrolls into view; rename keys; the tab menu's semantic icons; split separators 4px in flow with `cv-split-sash`; `data-cv-session-area` on every pane; the drop overlay stays `z-40` |
| R2-SIDEBAR | `src/components/layout/__tests__/SidebarPanel.test.tsx`, `src/components/layout/__tests__/Sidebar.test.tsx`, `src/components/entries/__tests__/EntryTree.test.tsx` | Docked and floating markup (today's assertions updated to the new classes); header order and every title and `aria-label` as INVENTORY 2a; a 60-character vault name truncates and leaves all six header buttons clickable; footer order and texts; the signed-in row 2 (the email with `title="Account Settings"`, Sign Out, then Confirm and Cancel), the `offline` badge, a team vault's tinted header with `VaultContextBar`, the trial card and strip, each in today's order with today's texts and titles; the review button's title and hook; the callouts' dismiss; the floating panel's `data-cv-accent-line`; tree rows 22px with the depth indent, `data-selected`, the leaf spacer, markers at 12px, the rename input, the flat group label without uppercase |
| R2-AI | `src/components/ai/__tests__/ChatPanel.header.test.tsx` | Header order, titles and `data-cv-ai-header`; the engine dropdown items; the active engine's `●` kept as text |
| R2-SHELL | `src/App.test.tsx` (fixed with a local `vi.stubGlobal`), `src/components/sync/__tests__/SyncBanners.test.tsx` (updated), `src/components/common/__tests__/StartupStatus.test.tsx` | The whole suite green; banners keep `role="status"`, `span.flex-1`, `data-cv-banner-text` and exact action labels, and their actions are buttons, the primary one filled; the offline banner has no `role="status"` and keeps `Reconnect`; the accent line uses `bg-accent`; the AI toggle is an `IconButton` with `aria-pressed`; StartupStatus texts, tones and dismiss |
| R3-* | the tests already in each directory stay green, updated where markup changes; new tests where 3.12.1, 3.16 or 5.11 ask for them | Wherever a component moves onto a primitive, its test asserts the Appendix B hooks and the exact texts; every dialog's Escape, scrim click and close button per 3.12.1; hub and dashboard `meta` visible without hover; the pickers keep their grids and card; the custom icon twins equal the Tabler pack's mapping |
| R4-HARNESS | `scripts/__tests__/verify-selectors.test.ts` (legacy halves gone), `scripts/__tests__/restyle-inventory.test.ts` | Hooks only; the restyle suite's allowed deltas trimmed to what the final UI needs |
| R4-CLEANUP | `src/components/__tests__/icon-sizes.test.ts`, `src/components/__tests__/overlay-freeze.test.tsx`, `scripts/__tests__/legacy-classes.test.ts` | Icon sizes (5.5); each of the 24 overlays that `App.tsx` lists today, rendered alone, holds a freeze by itself (the legacy hold stays, D-28); the dead-file skip on temporary fixture files |

### 8.2 Harness hook contract

The harness reads the UI through DOM queries (`scripts/verify/lib/ui.mjs`). Wave 1 turned every class-based selector into a pair (hook, legacy selector) resolved per scope by `pickSelector` (`scripts/verify/lib/selectors.mjs`): the hook wins wherever the scope has one. The restyle keeps that rollout:

1. Wave 1 (done): the pairs.
2. Waves 2 and 3: the package that owns a file adds its hooks (Appendix B, "Hook added by").
3. Wave 4 (R4-HARNESS): the legacy halves are deleted.

### 8.3 Dialog detection

Unchanged from wave 1: `openDialogs()` and `dialogDetails()` list `[role=dialog][aria-label]`; the `Dialog` primitive names ordinary dialogs with `aria-labelledby` and sets `aria-label` only through `harnessLabel`, which only the sync-style dialogs pass; `waitForUnlockOutcome()` reports `unlocked` once `sync_get_state().vault` names the vault.

### 8.4 Text rules

1. No existing title, `aria-label`, placeholder or visible text changes (D-1). Removing CSS `uppercase` changes what `innerText` returns for these labels only: flat-mode tree group labels, the vault menu's section headers, popup menu headers, the hub's "Recent Vaults" and team headers, the entry dialog's group labels, the `IconPicker` category labels, the Home dashboard's type labels. The harness reads none of them [V: grep of `scripts/verify` for uppercase phrases finds none].
2. Icon-only buttons that had no accessible name get `aria-label` (and a native `title`) with no visible text (D-20).
3. No button's visible text may newly equal `Review`, `Use here instead`, `Lock Current Vault`, `New Vault`, `Not Now` or `Open Vault File`: the harness clicks those with `selector: 'button'` and takes the first match in document order.
4. No new `role="dialog"` or `role="status"`. `role="status"` stays on the sync banners only; the offline banners keep none.
5. The loading screen's whole text stays exactly `Loading...` (B27).
6. In the review panel, each version's value, its `In use now` badge and its `Use this` button stay inside one `[data-cv-review-version]` line (B47): the sync and MCP flows match a value to its button through that line.

### 8.5 Harness runs and owner gates

`npm run verify` (all 41 scenarios, about 12 minutes, needs the local Supabase stack: `supabase start`, `docs/LOCAL_SUPABASE.md`) runs in the four integrator steps. The restyle suite is lighter and runs in every package that changes what it checks; wave-3 packages that change markup the live flows read also run the matching suites, so a broken flow shows up in the package that broke it, not after twelve merges.

| When | Command | Notes |
|---|---|---|
| R1-HARNESS | `node scripts/verify/run.mjs restyle` (the local Supabase stack running, for `sidebar-signed-in`); `--only screens` with it stopped; `sync mcp` | proves the suite on the unchanged layout: inventories match, G1, G2, G4 and G9 pass, the other rules report `pending`; the review flows run on the new pair |
| End of wave 1 (R1-MENUS) | `npm run verify`, then `node scripts/verify/run.mjs restyle`, then `--only packs` | the migration and settings changes touch every suite's settings file; **owner gate 1** |
| Each wave-2 package | `node scripts/verify/run.mjs restyle --only <scenario>` (10.2) | inventories, the geometry rules its hooks allow (8.6), composites |
| End of wave 2 (R2-SHELL) | `npm run verify`, then `node scripts/verify/run.mjs restyle --strict` | banners, the side bar footer (B13), the hamburger (B16) and the vault switcher (B17) are harness-bound; from here on no rule may be pending; **owner gate 2** |
| Each wave-3 package | `node scripts/verify/run.mjs restyle --strict --only <scenario>`, plus the targeted suites: R3-SETTINGS and R3-VAULT `backup lifecycle password`; R3-SYNC `sync mcp copies lifecycle`; R3-MISC `lifecycle` | the Settings flows (`lib/settings-flows.mjs`), vault dialogs, the review panel (B11, B47), Other copies (B20), Recently deleted and its stacked confirm (B18, B19) |
| End of wave 3 (R3-FOUNDATION closing) | `npm run verify`, then `node scripts/verify/run.mjs restyle --strict` | dialogs and settings are harness-bound (B1-B47) |
| End of wave 4 (R4-CLEANUP) | `npm run verify`, then `node scripts/verify/run.mjs restyle --strict` | legacy selectors gone; **owner gate 3** |

A failure found by an integrator goes back to the file's owner in that wave, or to the standing foundation package for shared files.

**Owner gates** (10, rule 8). The owner sees the work before most of it is built, not only at the end:

1. **Gate 1, closing R1-MENUS.** The `packs` sheets of 8.6 (dark and light): the side bar, both tab bars, the tree entry context menu, a toast, the credential picker window and Settings > Appearance with Lucide as the default, in each of the six packs, in the real app. Two questions go with it: (a) Modern's accent: Conduit's sky ramp as planned (D-25), or VS Code's blue; (b) tab close buttons: always visible as today (D-3), or VS Code's hover-only close. A different answer is written into the spec (10, rule 4) before wave 2 starts.
2. **Gate 2, closing R2-SHELL.** The before and after composites of shots 04 to 10b, 18, 19, 21 and 44 to 49: the whole restyled chrome, signed-in states included. Every R3 package depends on R2-SHELL, so wave 3 waits for this approval.
3. **Gate 3, closing R4-CLEANUP.** The dark and light composites of every reference shot.

### 8.6 The restyle suite

`scripts/verify/suites/restyle.mjs` (R1-HARNESS) is an opt-in suite (`optIn: true`, skipped by `all`). Its scenarios declare `needsSupabase` one by one: only `sidebar-signed-in` needs the local Supabase stack, and the runner starts the stack only when a selected scenario needs it. The suite launches one isolated device per scenario, 1280 × 800, with the reference data of 3.1 (vault "Acme Infrastructure" and its entries, the "Scratch" vault, a local test page for the web entry, `web-01` pointed at `127.0.0.1:1`), reaches each reference screen, and for each screen in dark and light runs the steps below.

**8.6.1 The reference folder.** The 124 PNGs of 3.1 (37 MB [V `du -sh`]) exist only in the scratchpad, which is temporary. R1-HARNESS's first step copies `<scratchpad>/restyle/before/` (the PNGs, `INVENTORY.txt`, `INVENTORY-raw.json`) to `$HOME/.conduit-verify/restyle-before/`, which every worktree on the machine reaches, adds shots 44 to 49 there, and commits `scripts/verify/fixtures/restyle/before-manifest.json`: `{ "files": { "<name>": "<sha256>" } }` for every file of the folder. `--before <dir>` defaults to `CONDUIT_RESTYLE_BEFORE`, else that folder. A file the manifest lists that is missing, or whose hash differs, fails the suite: a composite never silently disappears.

1. **Screenshot.** On macOS a real window capture (`screencapture -x -o -l <windowId>`, like the reference set), elsewhere `page.screenshot()`; crops use element rectangles (`[data-cv-sidebar-header]`, `[data-cv-sidebar-footer]`, the `[data-tabbar]` rows, the popup window) where the hooks exist, and today's regions otherwise. Written to `.verify/runs/<id>/restyle/after/<mode>-<nn>-<name>.png`, the reference names of 3.1.
2. **Composite.** `sharp` writes `.verify/runs/<id>/restyle/compare/<mode>-<nn>-<name>.png`: before on the left, after on the right, scaled to the same height, labeled.
3. **Inventory.** `scripts/verify/lib/inventory.mjs` records every visible control of the screen's region in document order as `{tag, text, title, aria, pressed, type, placeholder}` (the format of `INVENTORY-raw.json`; the extraction reproduces it on the unchanged layout). A `label`'s `text` is its own text without the text of form controls, buttons or options nested in it, because `FormField` and `Checkbox` nest their control inside the label (4.4, 4.6) while today's labels stand beside it. Popup menus are recorded as `{kind: item | header | separator | submenu, label, children}`, read from the menu window; the application menu from `Menu.getApplicationMenu()`. `compareInventory()` compares the result with `scripts/verify/fixtures/restyle/before-inventory.json` (the normalized `INVENTORY-raw.json` plus shots 44 to 49). Both sides are normalized first:
   - full vault paths become `<vault-path>`; the run's vault directory, wherever it appears in a title or text (the hub rows read `Acme Infrastructure /tmp/cv-4f4fcc/vaults` [V]), becomes `<vault-dir>`; ports become `<port>`;
   - `/\b\d+ (second|minute|hour|day)s? ago\b/` becomes `<ago>`, and the sync states `Up to date` and `N change(s) not yet synced` become `<sync-state>`: the footer's sync button reads `Up to date. Last synced 4 seconds ago` in one capture and `1 change not yet synced. Last synced 1 second ago` in another [V `INVENTORY-raw.json`];
   - menus are structured.

   The rules:
   - same controls, same order, same `tag`, `text`, `title`, `aria`, `pressed`, `type`, `placeholder`;
   - allowed: an `aria`, a `title` or a `pressed` added where the reference has none (D-20; the AI toggle gains `aria-pressed`, 3.4); text compared case-insensitively when the reference text is CSS uppercase; icons ignored in menus;
   - allowed per screen, as data in `scripts/verify/fixtures/restyle/allowed-deltas.json`, each entry with its reason. At the start there is one entry, `settings-appearance` [V against `INVENTORY-raw.json` and the branch's `AppearanceTab.tsx`]:
     - **removed**: `{tag: label, text: "Platform Theme"}` and its four buttons `Default Conduit Classic`, `macOS Tahoe Liquid Glass`, `— ☐ ✕ Windows 11 Fluent Design`, `Ubuntu GNOME / Libadwaita` (OD-7);
     - **inserted where they stood**, present if and only if the tab renders `[data-cv-appearance="icon-pack"]`: `{tag: label, text: "Icon pack"}`, then six buttons whose texts start with `Lucide`, `Phosphor`, `Hugeicons`, `Material Symbols`, `Fluent` and `Tabler (Classic)`, in that order (OD-4). Before R1-FOUNDATION merges, the tab has no such section and the entry passes without it; afterwards it must be there;
     - **inserted before `Ocean`**: `{tag: button, text: "Modern"}` (OD-7).
     Nothing else differs on that screen: the three remaining section labels stay `<label>` elements (6.4).
4. **Geometry rules.** Each rule needs hooks that a later package adds. On a screen where a rule's hooks are missing, the rule reports `pending` in `inventory-diff.txt` instead of failing; `--strict` turns every pending rule into a failure. R2-SHELL's integration and every later run use `--strict`. Height rules check only the elements that already carry their hook.

| Rule | Checks | Needs | Hook added by |
|---|---|---|---|
| G1 | Content bounds are smaller than window bounds (native frame, L-1) | none | today |
| G2 | None of the clone selectors of L-20 exists; the list lives only in `scripts/verify/lib/clone-selectors.mjs` | none | today |
| G3 | The `[data-cv-accent-line]` outside `[data-sidebar-panel]` is 2px tall, full width, the first row of the main layout, colored `--c-accent`; inside a floating `[data-sidebar-panel]`, its own line is 2px tall at the panel's top | `data-cv-accent-line` (each part on its own) | R2-SHELL (`App.tsx`), R2-SIDEBAR (floating panel) |
| G4 | The docked side bar starts at x = 0 with its stored width (250 by default); the floating one is fixed at x = 0 from y = 0 | `data-sidebar-panel`, `data-docked` | today |
| G5 | Every `[data-tabbar]` that contains `[data-cv-new-tab]` is 33px tall at the top of its pane; `[data-cv-sidebar-toggle]`, when present, sits in its first `.cv-tabstrip-slot` at its left edge; `[data-cv-new-tab]` and, in the focused pane only, `[data-cv-ai-toggle]` sit in its last `.cv-tabstrip-slot` at its right edge | `data-cv-new-tab`; `data-cv-ai-toggle` for the toggle part | R2-TABS; R2-SHELL |
| G6 | (a) Each of `[data-cv-sidebar-header]`, the top-row tab bars (G5's tab bars whose top is the main row's top) and `[data-cv-ai-header]` that exists is 33px tall. (b) Once all three exist, with the side bar docked, they share one bottom edge (D-5) | the three hooks, each for its own part of (a); all three for (b) | R2-SIDEBAR, R2-TABS, R2-AI |
| G7 | The side bar's children appear in the order of L-6, with `[data-cv-sidebar-footer]` at its bottom | `data-cv-sidebar-header`, `data-cv-sidebar-footer` | R2-SIDEBAR |
| G8 | While the AI panel is open, `[data-cv-ai-divider]` (4px) and `[data-cv-ai-panel]` (400px by default) are the last two element children of the row that holds the pane area (L-4) | both hooks | R2-SHELL |
| G9 | While any dialog is open over a web session, `window.__conduitFreeze()` lists a holder and the web view is hidden (the 32b bug stays fixed) | `window.__conduitFreeze` | wave 1 |
| G10 | On every screen with tabs, each `[data-cv-tab]` lies inside its `[data-tabbar]` and each tab's `.cv-tab-close` lies inside its tab (shot 18 is the narrow case: three tabs in a pane of about 312px). In the `tabs` scenario, twelve tabs opened in the left pane of shot 18's layout are each at least 78px wide, the row scrolls, and the tab activated last lies inside the strip | `data-cv-tab` | R2-TABS |

Rules each package can meet before `--strict`:

| Package | Rules |
|---|---|
| R1-HARNESS, R1-MENUS | inventories, G1, G2, G4, G9 |
| R2-TABS | + G5 (the AI toggle part pending), G6 (a) for its tab bars, G10 |
| R2-SIDEBAR | + G3 for the floating panel's line, G6 (a) for the header, G7 |
| R2-AI | + G6 (a) for `[data-cv-ai-header]` |
| R2-SHELL onward | every rule, `--strict` |

5. **Scenarios.**

| Scenario (`--only`) | Reference shots | Inventory screens |
|---|---|---|
| `screens` | 00, 01, 02, 03, 41, 42 | `auth-screen`, `vault-hub-empty`, `vault-hub-with-recent`, `vault-hub-with-recent-2`, `unlock-dialog`, `main-empty-vault-welcome`, `sidebar-empty-vault-just-created` |
| `sidebar` | 04, 06, 07, 08, 09, 21, 38, 39 | `main-sidebar-local-mode`, `vault-switcher-menu-open`, `sidebar-search-active`, `sidebar-favorites-only` |
| `sidebar-signed-in` (`needsSupabase: true`) | 44 to 49 | `sidebar-signed-in`, `sidebar-sign-out-confirm`, `sidebar-cached-offline`, `sidebar-team-vault`, `sidebar-trial-card`, `sidebar-trial-strip`: a Free user who can start a trial and the same user in a Pro trial (`createTestUser`, `setTier` in `lib/supabase.mjs` [V exports]), a team with one team vault (`createTeam`, `createTeamVault`, `openTeamVaultInUi` in `lib/team.mjs` and `lib/team-flows.mjs` [V exports]), and cached mode by cutting the network the way the resilience suite does (`lib/net-proxy.mjs`) [A: that this reaches cached auth; if not, R1-HARNESS finds the way the app enters it] |
| `tabs` | 05, 06, 07, 10, 10b, 40, 43 | `main-tabbars-split-ai-open`, `web-session-toolbar`, `home-dashboard-full-window`, `document-view-runbook`; plus the twelve-tab check of G10 |
| `ai` | 18, 19 | `ai-panel`, `ai-panel-engine-menu-open` |
| `menus` | 11 to 17 | `plus-popup`, `ctx-tab`, `ctx-tab-ssh-entry`, `ctx-tree-entry-ssh`, `ctx-tree-entry-web`, `ctx-tree-entry-credential`, `ctx-tree-folder`, `ctx-submenus`, `native-app-menu` |
| `settings` | 20-01 to 20-14 | the 14 `settings-*` screens |
| `dialogs` | 22 to 35 | `new-entry-dialog`, `new-entry-ssh-form`, the six `edit-entry-rdp-*`, `new-folder-dialog`, `quick-connect-dialog`, `confirm-delete-dialog`, the three `sync-panel-*` |
| `toasts` | 36, 37 | none (screenshots; the four toasts come from View > Trigger Test Toast, or from the toast API) |
| `packs` | none (sheets for owner gate 1) | none; for each of the six packs in dark and light it picks the pack in Settings > Appearance (live preview, then Save), captures the Appearance tab with its six cards, the side bar, both tab bars, the tree entry context menu window, a test toast and the credential picker window (opened the way its global shortcut opens it [A]), and asserts that `<html data-cv-icon-pack>` equals the pack id in the main, overlay and picker windows and that the menu's Edit icon markup differs from pack to pack; it writes one six-column sheet per mode under `.verify/runs/<id>/restyle/packs/`, then restarts the device and checks that the saved pack still applies |

Output also includes `inventory.json` and `inventory-diff.txt` per scenario. Pixels are not diffed: styling changes sizes by design; the inventory and geometry rules decide pass or fail, and the owner reviews the composites at the gates.

### 8.7 What only Windows or Linux can check

1. Fonts: Segoe UI (Windows) or the system UI font (Linux) at 13px; Consolas or Ubuntu Mono for code.
2. Scrollbars: 8px styled thumbs; the tab strips show no scrollbar and scroll with the wheel.
3. Popup menus: the 12px transparent margin draws a shadow (a compositor is needed on Linux), a click in it closes the menu, and menus open at the pointer when maximized and snapped at 100, 125 and 150% OS scaling.
4. Hugeicons, Fluent and Material glyphs render crisply at 16px in the side bar, tabs and menus.
5. The window background follows scheme and mode while resizing (no navy flash).

---

## 9. Removals, salvage and risks

### 9.1 Base-branch code to remove or simplify

All in R1-FOUNDATION unless marked. Nothing of the clone's shell exists on this branch to remove [V: `src/components/shell/`, `src/lib/window-chrome.ts`, `electron/ipc/window-chrome.ts`, `electron/services/window-chrome/`, `src/stores/auxBarStore.ts`, `src/lib/layout/` are absent; `electron/` sets no `titleBarStyle`, `titleBarOverlay`, `trafficLightPosition` or `zoomMode`].

| Area | Path | Action |
|---|---|---|
| Codicons | `src/lib/icons/packs/codicons.tsx`, `src/lib/icons/generated/codicons.ts`, `scripts/icons/licenses/codicon.txt` | delete |
| Codicons | `scripts/icons/mapping.mjs`, `scripts/icons/generate-icon-packs.mjs` | drop the `codicon` columns, package, output file and license source (5.3) |
| Codicons | `package.json`, `package-lock.json` | remove `@iconify-json/codicon`; add `@hugeicons/core-free-icons` `4.3.5` (exact) to devDependencies |
| Codicons | `public/licenses/third-party-icons.txt` | regenerate: six packs, no Codicons, no CC BY text |
| Codicons | `src/lib/icons/types.ts`, `pack-cache.ts`, `store.ts`, `loader.ts`, `licenses.ts`, `index.ts`, the icon tests, `src/components/ui/gallery/IconsSection.tsx`, `galleryState.ts`, `src/components/ui/__tests__/{choices,gallery}.test.tsx` | Codicons out, Lucide default, Hugeicons in; the "Codicons compact glyphs" gallery demo becomes a state dot demo |
| Retired icon names | `types.ts`, `index.ts`, every pack, `mapping.mjs`, `src/components/ui/__tests__/Button.test.tsx`, `src/components/ui/gallery/ButtonsSection.tsx`, `IconsSection.tsx` | remove `panelLeft`, `panelLeftOff`, `panelRight`, `panelRightOff`, `collapseAll`, `account`, `explorer` and their named exports |
| Deprecated icon shims | `IconTheme`, `THEME_ICON_DEFAULTS`, `PACK_BY_ICON_THEME`, `isIconTheme`, `setTheme`, `useIconThemeStore`, `loadIconPack(theme)` | delete (no callers [V grep]) |
| Density | `src/styles/density.css`, `src/styles/metrics.ts`, `src/styles/__tests__/metrics.test.ts` | delete |
| Density | `src/index.css` (`@import "./styles/density.css"`, `@custom-variant compact`, `--radius-card`, `--spacing-activitybar`, `--spacing-titlebar`, `--spacing-statusbar`), `src/lib/appearance/{boot-inline.js,dom.ts,migrate.ts,useAppearance.ts,migration-table.json}`, `electron/ipc/settings.ts`, `electron/services/appearance-migration.ts`, `SettingsDialog.tsx`, `SettingsHelpers.tsx`, `OverlayApp.tsx`, the gallery's density switch and `NavigationSection.tsx` demo, and their tests | remove `ui_density`, `data-density`, `conduit-density`, `Density`, `isDensity` |
| Cards and sashes | `src/styles/components/cards.css` | delete |
| Cards and sashes | `src/styles/components/sash.css` | rewrite: split sashes, the AI divider and the side bar handle line of 3.5 to 3.7; the grip, the compact rules and the card sashes go |
| Tabs | `src/styles/components/tabs.css` | rewrite to 3.4 (`data-active`, no editor actions, no card assumptions) |
| Clone tokens | `src/styles/tokens.css`, `src/styles/schemes.css`, `src/styles/__tests__/{tokenContract,tokens-cascade,cssTokens}.ts` | remove `--c-activity-active-bg`, `--c-activity-hover-bg`, `--c-activity-fg`, `--c-activity-fg-hover`, `--c-activity-fg-active`, `--c-titlebar-fg`, `--c-statusbar-fg`, `--c-statusbar-hover`, `--c-statusbar-hover-fg`, `--c-statusbar-active`, `--c-cc-bg`, `--c-cc-fg`, `--c-cc-border`, `--c-cc-hover-bg`, `--c-cc-hover-border`, `--c-sash-grip`, `--c-titlebar-h`, `--c-traffic-reserve`, `--c-wco-reserve-start`, `--c-wco-reserve-end`, `--c-cc-h`, `--c-cc-w`, `--c-cc-max-w`, `--c-statusbar-h`, `--c-activity-item`, `--c-activity-pill`, `--c-zoom`, and the density tokens `--c-gap`, `--c-outer`, `--c-card-radius`, `--c-card-border-w`, `--c-activitybar-lane`, `--c-activitybar-w`, `--c-activity-gap`, `--c-statusbar-gutter`; move `--c-tabstrip-h`, `--c-tab-h`, `--c-tab-gutter-top`, `--c-list-inset` to `:root`; add `--c-tab-min-w` and `--c-favorite`; Modern's accent ramp and accent-derived values to the sky ramp (2.2.2, D-25) |
| Title bar style | `electron/ipc/settings.ts`, `electron/services/appearance-migration.ts`, `SettingsDialog.tsx`, `SettingsHelpers.tsx`, the migration table and tests | remove `title_bar_style` (deleted from stored files by the migration) |
| Counter-zoom | `src/lib/appearance/boot-inline.js` and its test | stop setting `--c-zoom` and probing `window.electron.zoomFactor` |
| Glyph-swap buttons | `src/components/ui/IconButton.tsx` and its test | remove `pressedLook` |
| Editor card probe | `src/components/ui/Popover.tsx` | `[data-cv-editor-card]` becomes `[data-cv-session-area]` (D-21) |
| Gallery | `src/components/ui/gallery/WorkbenchPreview.tsx`; `GalleryApp.tsx` (`--c-gap` and `--c-outer` padding, the workbench section) | delete; plain padding |
| Shell colors | `src/lib/appearance/shell-colors.json` | `fg` becomes `--c-ink-faint` (Modern light `#6B6B6B`) |
| Plan | `scripts/redesign/work-packages.json` | replaced by this plan in the commit that lands this spec (section 10) |
| Clone and VS Code wording in code | `src/styles/base.css:48`, `src/styles/tokens.css:100`, `src/styles/schemes.css:4`, `src/styles/components/tabs.css:1`, `src/components/ui/Badge.tsx:36`, `src/components/ui/Banner.tsx:28`, `src/components/ui/Popover.tsx:26`, `src/components/ui/gallery/FieldsSection.tsx:11,68`, `src/lib/appearance/useAppearance.ts:3`, `src/lib/terminalTheme.ts:33`, the tests in `src/components/ui/__tests__/` that name a title bar, an editor card or a workbench | comments, demo texts and test names describe today's layout: no title bar, activity bar, status bar, command center, workbench, editor card, `BannerStack` or VS Code name (R1-FOUNDATION; the grep of its acceptance proves it) |
| Clone wording in the harness | `scripts/verify/README.md:508-527` ("Text on permanent chrome": the title bar, activity bar, status bar, command center, `chromeText` test), `scripts/__tests__/verify-selectors.test.ts:209-226` (the `SHELL_CLOSED` and `SHELL_OPEN` fixtures in the clone's layout) | rewritten for today's layout; the forbidden clone selectors live only in `scripts/verify/lib/clone-selectors.mjs` (R1-HARNESS; its grep proves it) |

Kept although wave 1 added it for the clone: `--c-tab-*` tokens (the pane tab bars use them), `--c-indent-guide` (tree guides), `--c-part-title-h` and `--c-section-h` (Tabs, the team context bar), `--c-shell` (the splash and the window background), `--c-scrim-sidebar`, the z-index tokens, `conduit:appearance-applied` (without density), `resolveCssColor`.

### 9.2 Salvage from the abandoned wave 2

| Commit (branch) | What | Port |
|---|---|---|
| `8ca0d23` (`redesign/w2-menus`) | `electron/ipc/menu-svg.ts` allowlist sanitizer and its test | cherry-pick as is (R1-MENUS) |
| `98abd31` (`redesign/w2-menus`) | Popup menu restyle and hardening: `electron/ipc/menu.ts`, `src/utils/contextMenu.ts` and their tests | cherry-pick; change comments naming `W4-CLEANUP` to `R4-CLEANUP` and the fallback `MODERN_MENU_COLORS` to the sky accent (7.1) (R1-MENUS) |
| `70fd889` (`advenimus/visual-redesign`) | Panel width from the longest label, 220 to 320 | cherry-pick the `electron/` hunks only; drop its `docs/VISUAL_REDESIGN.md` hunk (R1-MENUS) |
| `7f179be` (`redesign/w2-foundation-2`) | Every pack icon through the sanitizer | re-create as `scripts/__tests__/menu-svg-packs.test.ts` (the original lived in `scripts/icons/__tests__/`, which R1-FOUNDATION owns), iterating the six packs and 116 names, resetting with `setIconPack(DEFAULT_ICON_PACK)` instead of `"codicons"` (R1-MENUS) |
| `588e2ad` (`redesign/w2-foundation-1`) | Shared 8px state dot: `packs/state-dot.ts`, the five packs' `circleFilled`, `__tests__/svg-extent.ts`, registry tests | cherry-pick, then compare with the disc's geometry instead of Codicons (5.4) and give Hugeicons the dot (R1-FOUNDATION) |
| `47a782a` (`advenimus/visual-redesign`) | Material glyph trim (`glyph.ts` `trim`, `MATERIAL_TRIM = 1.35`) | cherry-pick the `src/` hunks after `588e2ad`; the test's reference dot becomes Lucide's (R1-FOUNDATION) |
| `ee3bc39` (`redesign/w2-foundation-2`) | `Callout onDismiss` and `dismissLabel` | cherry-pick (R1-FOUNDATION); the side bar callouts use it (R2-SIDEBAR) |
| `ca9659c` (`advenimus/visual-redesign`) | Banner divider drawn inside the row so it stays 26px | apply the `src/components/ui/Banner.tsx` and `display.test.tsx` hunks only (R1-FOUNDATION) |

All six code cherry-picks apply cleanly, in the order `588e2ad`, `47a782a`, `8ca0d23`, `98abd31`, `7f179be`, `70fd889`, to `41d9657` with the spec hunks excluded, and so do `ee3bc39` and the two `ca9659c` hunks [V: `git apply --cached --check` against a throwaway index].

Lessons folded in without a cherry-pick: the tab strip's hidden scrollbar (`8f53108`, 3.4), the vault switcher's focus room (`4780b8c`, 3.6), the drop overlay above xterm's scrollbar (`6528862`: keep `z-40`, 2.6).

Considered and not salvaged: `006661f` (skip terminal fits while the terminal is hidden). It is a behavior fix, not style. Today's panes already hide inactive sessions with `display: none` (`PaneContent.tsx:144-156`) and the AI panel hides the same way (`App.tsx:1105-1114`), so the bug it fixes may exist on this branch; 1.3 records it as out of scope, to be checked and fixed as its own change after the release. Everything else on the clone branches is shell work and stays there.

### 9.3 Risks and guardrails

| # | Risk | Likelihood / impact | Guardrail | Owner |
|---|---|---|---|---|
| R1 | The restyle drifts into layout or behavior changes again | medium / high | D-1, D-26 to D-28; the restyle suite's inventory and geometry rules (8.6) in every wave-2 and wave-3 package; owner gates 1 and 2 before wave 3 starts, gate 3 at the end (8.5) | all, the owner |
| R2 | Harness breakage from markup changes | medium / high | hooks before class changes (Appendix B), `pickSelector` pairs, the text rules (8.4), `npm run verify` at each integrator step | R1-HARNESS, integrators |
| R3 | A DOM surface renders under a live native web view | medium / high | every `Dialog` and `Popover` holds a freeze; `data-cv-session-area` probe (D-21); G9 | R1-FOUNDATION, R2-TABS |
| R4 | Connected tabs look detached where a surface under the strip is not `--c-editor` | medium / low | D-19 and 3.10; composites of 05 to 07 and 43 | R2-TABS, R3-SESSIONS |
| R5 | Icon flash or races on pack switches | low / low | Lucide is static; the request counter; the picker preloads all packs | R1-FOUNDATION |
| R6 | Package size: Hugeicons is 80 MB unpacked | low / medium | devDependency (D-11); subpath imports; `npm ls --omit=dev` check | R1-FOUNDATION |
| R7 | Licensing | low / medium | only MIT, ISC and Apache-2.0 packs ship; full texts in the generated file, shipped inside the app (5.9) | R1-FOUNDATION |
| R8 | Popup menu injection (latent today) | low / high | escaping, id allowlist, index selection, SVG allowlist (7.1) | R1-MENUS |
| R9 | Contrast regressions | medium / medium | the gates of 2.10 fail CI | R1-FOUNDATION |
| R10 | Parallel packages collide | medium / high | disjoint ownership per wave, checked by `check-owns.mjs`; standing foundation packages for shared files | all |
| R11 | Users miss their platform theme or the old icons | medium / low | the 6.3 table keeps their pack; Tabler (Classic) is one click away; a What's New line | R1-FOUNDATION, R4-DOCS |
| R12 | Density shock: 14 to 13px text, 36 to 26px controls, 28 to 22px rows | high / medium | `ui_scale` kept; What's New explains it; owner review of the composites | R4-DOCS, owner |
| R13 | Review bias from a locally installed Inter | high / low | review on a machine without Inter | owner |
| R14 | Stale contributor doc: `.claude/commands/notification.md` describes an old toast container | certain / low | not edited by any package (Claude Code configuration); flagged for the owner | owner |
| R15 | A dialog starts or stops closing on Escape or an outside click, or gains a close button (the recovery passphrase dismissed before it is saved) | medium / high | the 3.12.1 table, `closeOnEscape`, `hideClose`, a test per dialog | R3 packages |
| R16 | The default look still reads as VS Code | medium / high | Conduit's sky accent (D-25); the owner confirms the look at gates 1 and 2 | R1-FOUNDATION, the owner |
| R17 | The reference screenshots are lost with the scratchpad | medium / high | R1-HARNESS copies them to `$HOME/.conduit-verify/restyle-before/` first and commits their hashes; a missing file fails the suite (8.6.1) | R1-HARNESS |
| R18 | A pack works in the main window but not in the toast or picker window | low / medium | `<html data-cv-icon-pack>` in every window and the `packs` scenario (8.6) | R1-FOUNDATION, R1-HARNESS |

---

## 10. Work packages

There are 24 packages in 4 waves. The same list is in machine-readable form at `<scratchpad>/restyle/work-packages.json`. **This spec lands in one commit together with `scripts/redesign/work-packages.json`, a byte copy of that file.** `scripts/redesign/check-owns.mjs` reads the JSON and `scripts/__tests__/check-owns.test.ts` compares it with the Owns lines below, so committing both at once keeps the branch green and no package waits for a plan step. If the scratchpad copy is gone, rebuild the JSON from this section: every field (id, title, wave, `depends_on`, owns, deliverables, acceptance) is here, and the baseline checks of rule 6 end every acceptance list.

**Rules for every package:**

1. **Ownership.** Edit only the paths in Owns. Within a wave no two packages own the same file (`check-owns.mjs` checks both rules). Shared files belong to one package per wave: R1-FOUNDATION in wave 1, the standing packages R2-FOUNDATION and R3-FOUNDATION in waves 2 and 3, R4-CLEANUP in wave 4. A package that needs a change in a path it does not own asks that path's owner, who lands it as its own small commit with tests. A merged package may land follow-up commits inside its Owns until its wave closes.
2. **Order.** A package starts when every package in its `depends_on` has closed: merged, with every acceptance line met, including integration checks and owner gates. Standing packages open with their wave and close after their wave's integration: R2-FOUNDATION once R2-SHELL's checks and owner gate 2 pass, R3-FOUNDATION with its own closing step.
3. **Branches.** Each package branches from the tip of `advenimus/visual-restyle` and merges back into it. Every package leaves the app shippable (the layout never changes), so no integration branch is needed. No package commits to `main`, rewrites history or uses a bare `git stash`.
4. **Contracts.** Cross-package contracts are the ones in this spec: file paths, props, hooks, tokens, classes, events and IPC. A package builds against the contract, not against another package's internals. A contract change is written into this spec before it lands, in a standalone commit on `advenimus/visual-restyle` made by the wave's integrator (R1-MENUS, R2-SHELL, R3-FOUNDATION) or the owner, outside any package, so no package's diff holds the spec; R4-DOCS owns the spec in wave 4. A spec commit that changes this section updates `scripts/redesign/work-packages.json` in the same commit.
5. **Layout identity.** Every wave-2 and wave-3 package runs the restyle suite for its screens (8.6) and fixes every inventory or geometry failure before it merges. A failure is never fixed by editing the reference inventory. An intended difference goes into `scripts/verify/fixtures/restyle/allowed-deltas.json` through that file's owner in the wave (R1-HARNESS, R2-FOUNDATION, R3-FOUNDATION, R4-HARNESS), signed off by the wave's integrator, with the reason in the entry and the same delta recorded in 8.6 by a spec commit.
6. **Baseline checks.** Every acceptance list ends with: `npx vitest run` (the 3 known `src/App.test.tsx` failures are allowed until R2-SHELL; after it, no failures), both `tsc` runs, an ESLint error count no higher than at the fork point (`node scripts/redesign/lint-count.mjs`, 0 at `41d9657`), `npm run build`, and `node scripts/redesign/check-owns.mjs <ID> --base advenimus/visual-restyle`. A vitest run scoped to a directory passes `--passWithNoTests`, because several component directories have no tests yet (vitest exits 1 on "No test files found"). Commands are written for zsh: globs are quoted or passed to `git grep` as pathspecs.
7. **Live suites.** The full `npm run verify` runs in the integrator steps only: R1-MENUS, R2-SHELL, R3-FOUNDATION's closing step and R4-CLEANUP. Wave-3 packages that change markup the harness reads run the targeted live suites named in their acceptance (8.5).
8. **Owner gates.** Three owner gates close R1-MENUS, R2-SHELL and R4-CLEANUP (8.5). A gate is an acceptance line: the owner approves the named images, and the approval, or the change the owner asks for, is recorded in that package's pull request. Everything that depends on the package waits for the gate.

### 10.1 Wave 1: foundation

Wave 1 turns the base branch into the restyle foundation. R1-FOUNDATION and R1-HARNESS start from the spec commit and run in parallel; R1-MENUS runs last, integrates the wave and holds owner gate 1 (8.5).

| Id | Title | Depends on |
|---|---|---|
| R1-FOUNDATION | Restyle foundation: icon packs, tokens, appearance runtime and primitives | none |
| R1-HARNESS | Layout reference, the restyle suite and runner options | none |
| R1-MENUS | Popup menu restyle and hardening (W2-MENUS salvage), the wave-1 integration and owner gate 1 | R1-FOUNDATION, R1-HARNESS |

#### R1-FOUNDATION: Restyle foundation: icon packs, tokens, appearance runtime and primitives

**Owns:** `src/lib/icons/**`, `scripts/icons/**`, `scripts/__tests__/icon-packs.test.ts`, `public/licenses/**`, `package.json`, `package-lock.json`, `src/index.css`, `src/styles/**`, `src/lib/appearance/**`, `src/lib/schemes.ts`, `src/lib/terminalTheme.ts`, `src/components/ui/**`, `gallery.html`, `src/gallery.tsx`, `src/components/overlay/OverlayApp.tsx`, `src/components/settings/SettingsDialog.tsx`, `src/components/settings/SettingsHelpers.tsx`, `src/components/settings/tabs/AppearanceTab.tsx`, `electron/main.ts`, `electron/ipc/settings.ts`, `electron/services/appearance-migration.ts`, `electron/services/appearance-palette.ts`, `electron/services/__tests__/appearance-migration.test.ts`, `scripts/__tests__/appearance-migration-parity.test.ts`, `scripts/__tests__/appearance-palette-parity.test.ts`

**Deliverables:**

- Icons (5.1, 5.2, 5.6, Appendix A): Codicons removed (pack, generated data, codegen columns, vendored license, `@iconify-json/codicon`); Lucide static and `DEFAULT_ICON_PACK`; `packs/hugeicons-wrap.ts` and `packs/hugeicons.ts` with `@hugeicons/core-free-icons` `4.3.5` (exact devDependency, one subpath import per glyph); the seven retired names and their named exports removed (116 names); `ICON_PACKS` in picker order with the 5.8 descriptions; the deprecated theme shims deleted; the icon store mirrors the applied pack to `<html data-cv-icon-pack>` in every window
- Salvage (9.2): cherry-pick `588e2ad` (shared state dot) and then `47a782a` (Material trim), with their tests compared against the disc geometry and Lucide instead of Codicons and Hugeicons given the dot; cherry-pick `ee3bc39` (`Callout onDismiss`); apply the `src/components/ui/Banner.tsx` and `display.test.tsx` hunks of `ca9659c`
- Codegen and licenses (5.3, 5.9): `mapping.mjs` for Material only (115 rows); the generator reads `LICENSE`, `LICENSE.md` or `LICENSE.txt`; `public/licenses/third-party-icons.txt` regenerated for the six packs (it ships as `dist/licenses/third-party-icons.txt`); `licenses.ts` with the 5.9 notices; no About view
- Tokens (2.1 to 2.10, 9.1): the clone tokens removed; Modern on Conduit's sky accent ramp (2.2.2, D-25) with the accent-derived Modern values of 2.2.3 and 2.2.4; `--c-tabstrip-h`, `--c-tab-h`, `--c-tab-gutter-top`, `--c-tab-min-w`, `--c-list-inset` on `:root`; `--c-favorite` and its gate; `density.css`, `components/cards.css`, `metrics.ts` and `metrics.test.ts` deleted; `index.css` and the `@theme` block updated; `components/tabs.css` rewritten to 3.4 (tabs shrink to fit down to the 78px floor; close buttons always visible) and `components/sash.css` to 3.5 to 3.7; the token tests updated
- Appearance runtime and migration (6.1 to 6.3): no density and no `--c-zoom` in `boot-inline.js`, `dom.ts`, `migrate.ts`, `useAppearance.ts`; the 6.3 rules and table in both processes (retired schemes mapped in version-2 files too, `theme` validated in both branches, `appearance_version` kept at `max(2, stored)`), retired keys deleted, `lucide` as the default; `shell-colors.json` `fg` from `--c-ink-faint`; `electron/ipc/settings.ts`, `SettingsHelpers.tsx`, `SettingsDialog.tsx` and `OverlayApp.tsx` without `ui_density` and `title_bar_style`
- Window background (7.2): `electron/services/appearance-palette.ts`, `createWindow()` using `windowBackground()`, updates after `settings_save` and on `nativeTheme` `updated`, the palette parity test
- Primitives (4.1, 4.3, 4.8, 4.9, 4.13, 4.14): `IconButton` without `pressedLook` and with `tone="inherit"`; `Dialog` `width`, `closeOnEscape` and the optional `onClose` of a dialog that cannot be closed; `Banner` `status`, `align` and `Button size="sm"` actions with `primary`; `ListRow` `meta` (always visible) and self-sized `leading` elements; `Popover freeze="auto"` probing `[data-cv-session-area]`; the gallery without the density switch and the workbench preview, with all six packs in its switch and its focus strip on the new `tabs.css`
- Settings > Appearance (5.8, 6.4): the Icon pack section in the Platform Theme slot, labeled by a `<label>` like its siblings, six `ChoiceCard`s with previews from `<Icon pack>` after `preloadAllIconPacks()`, live preview through `conduit:theme-change`, Save and Cancel
- Clone and VS Code wording (9.1): comments, gallery demo texts and test names in the owned files describe today's layout, with no title bar, activity bar, status bar, command center, workbench, editor card or VS Code name; `src/lib/terminalTheme.ts` included

**Acceptance:**

- `npx vitest run src/lib/icons src/styles src/lib/appearance src/components/ui scripts/__tests__/icon-packs.test.ts scripts/__tests__/appearance-migration-parity.test.ts scripts/__tests__/appearance-palette-parity.test.ts electron/services/__tests__/appearance-migration.test.ts` passes (8.1, row R1-FOUNDATION)
- `node scripts/icons/generate-icon-packs.mjs --check` exits 0
- `git grep -il codicon -- . ':(exclude)docs/**' ':(exclude)**/*.md' ':(exclude)scripts/redesign/work-packages.json' ':(exclude)**/__tests__/**'` prints nothing (tests may still name `codicons`, to prove a stored value becomes `lucide`)
- `npm ls --omit=dev --parseable | grep -E "lucide|tabler|phosphor|fluentui|iconify|hugeicons"` prints nothing, and `npm ls @hugeicons/core-free-icons` shows `4.3.5`
- `git grep -nE "data-density|--c-zoom|pressedLook|data-cv-editor-card|density\.css|cards\.css|styles/metrics" -- src electron scripts ':(exclude)**/__tests__/**' ':(exclude)scripts/verify/**' ':(exclude)scripts/redesign/work-packages.json'` prints nothing (tests and the harness's forbidden-selector list may name these strings), and `git grep -lE "ui_density|title_bar_style|conduit-density" -- src electron ':(exclude)**/__tests__/**'` lists only `electron/services/appearance-migration.ts`, `src/lib/appearance/migration-table.json`, `src/lib/appearance/migrate.ts` and `src/lib/appearance/boot-inline.js` (the retired-key handling of 6.3)
- `git grep -nE "[Tt]itle ?bar|[Aa]ctivity ?bar|[Ss]tatusbar|[Cc]ommand center|command-center|[Ee]ditor card|editor-card|[Ww]orkbench|BannerStack|monaco-|VS ?Code|vscode" -- src ':(exclude)**/__tests__/**'` prints nothing
- `git grep -niE "3994bc|3a94bc|0069cc|0d6fcf|297aa0|2b7da3|48a0c7|53a5ca|005bb5|0063c1|307e9f|1e3a47|e6f2fa|ebf4f8|d7eaf2|b0d4e4|1c4a5e|143442|0b1e26|ebf3fb|d6e7f7|a8ccee|004485|003466|00203d" -- src ':(exclude)**/__tests__/**'` prints nothing: Modern's old VS Code accent values are gone from `tokens.css`, `schemes.css` and the scheme preview in `src/lib/schemes.ts` (D-25)
- After `npm run build`, `dist/licenses/third-party-icons.txt` names the six packs and no Codicons. `npx vite build --manifest --emptyOutDir --outDir "$TMPDIR/conduit-manifest"` writes `.vite/manifest.json`, in which `src/lib/icons/packs/phosphor.ts`, `hugeicons.ts`, `fluent.ts`, `tabler.ts` and `material.tsx` each have `isDynamicEntry: true` and `src/lib/icons/packs/lucide.ts` has no entry; `git grep -n 'import("./packs/lucide")' -- src` finds nothing (Lucide is a static import of the main, overlay and picker entries)
- Manual, `npm run dev:electron` on a fresh profile: Modern dark with Lucide icons and the sky accent line; Settings > Appearance shows the Icon pack section first with six cards and previews; picking Hugeicons switches the side bar, the tabs, the dialogs, a test toast and the credential picker window live; Save survives a restart; Cancel reverts. A profile whose `settings.json` holds `{"platform_theme":"macos","color_scheme":"macos-blue"}` starts in Modern with Phosphor; one holding `{"appearance_version":2,"icon_pack":"codicons","ui_density":"compact","title_bar_style":"native"}` starts with Lucide and loses both retired keys
- `npm run dev`, then `/gallery.html?pack=<id>` for each of the six packs: every icon and the state dot render, no console errors
- `npx vitest run` passes, except the 3 known `src/App.test.tsx` failures until R2-SHELL fixes them
- `npx tsc --noEmit` and `npx tsc -p electron/tsconfig.json --noEmit` report no errors
- `node scripts/redesign/lint-count.mjs` prints no more ESLint errors than at the fork point (0 at `41d9657`)
- `npm run build` passes
- `node scripts/redesign/check-owns.mjs R1-FOUNDATION --base advenimus/visual-restyle` exits 0

#### R1-HARNESS: Layout reference, the restyle suite and runner options

**Owns:** `scripts/verify/**`, `scripts/__tests__/verify-harness.test.ts`, `scripts/__tests__/verify-selectors.test.ts`, `scripts/__tests__/restyle-inventory.test.ts`, `scripts/__tests__/check-owns.test.ts`

**Deliverables:**

- First, the reference set made lasting (8.6.1): `<scratchpad>/restyle/before/` copied to `$HOME/.conduit-verify/restyle-before/`; `scripts/verify/fixtures/restyle/before-manifest.json` listing every file of that folder with its SHA-256; `--before` defaults to `CONDUIT_RESTYLE_BEFORE`, else that folder; a listed file that is missing or changed fails the suite
- Shots and inventories 44 to 49 (3.1: the signed-in footer, its sign-out confirm, cached mode, a team vault, the trial card, the trial strip) recorded on the base branch with scheme Ocean and the Tabler pack, added to the folder, the manifest and the inventory fixture
- `scripts/verify/fixtures/restyle/before-inventory.json`: `INVENTORY-raw.json` plus the screens of shots 44 to 49, normalized (8.6 step 3); `scripts/verify/fixtures/restyle/allowed-deltas.json` with the `settings-appearance` entry written out as data (8.6 step 3)
- `scripts/verify/lib/inventory.mjs`: `captureInventory(device, screen)`, `captureMenu(device)`, `captureAppMenu(device)`, `normalizeInventory()`, `compareInventory(before, after, deltas)`, with the extraction, normalization and comparison rules of 8.6 step 3; the extraction reproduces `INVENTORY-raw.json` on the unchanged layout
- `scripts/verify/suites/restyle.mjs` (`optIn: true`, `needsSupabase` per scenario): the ten scenarios of 8.6 with screenshots, `sharp` composites, inventories, `inventory-diff.txt`, the geometry rules G1 to G10 with their hook lists, `pending` results and `--strict`, and the `packs` sheets; the reference data of 3.1 created through the harness, with `web-01` pointed at `127.0.0.1:1` and a local test page for the web entry; the forbidden clone selectors kept only in `scripts/verify/lib/clone-selectors.mjs`
- `scripts/verify/run.mjs`: `all` skips `optIn` suites; the Supabase phase starts only when a selected scenario needs it; `--strict` reaches the suites; `--help` lists the opt-in suites and `--strict`
- The review-version hook, harness half (B47): `reviewVersion: pair('[data-cv-review-version]', '.items-start.gap-3')` in `selectors.mjs`; `clickVersionInPage` (`lib/sync-flows.mjs`) and `pickVersionNotInUseInPage` (`suites/mcp.mjs`) find the version line with `cv.pickClosest(button, panel, cv.S.reviewVersion)` instead of `button.parentElement`; the MCP suite looks for its panel as `[role=dialog][aria-label="Review changes"]`; `verify-selectors.test.ts` covers both halves
- `scripts/verify/README.md`: the restyle suite, the lasting reference folder and its manifest, allowed deltas, pending rules and `--strict`, the owner gates; its "Text on permanent chrome" section rewritten for today's layout (the side bar header and footer, the pane tab bars) without the title bar, activity bar, status bar, command center and `chromeText` test; the `SHELL_CLOSED` and `SHELL_OPEN` fixtures of `verify-selectors.test.ts` rewritten from the clone's layout to today's layout with hooks
- `scripts/__tests__/check-owns.test.ts` also compares each package's `wave`, title and `depends_on` with the JSON, reading them from the `| Id | Title | Depends on |` table under each `### 10.N Wave N` heading (rows of other tables that start with a package id, such as the test table of 8.1, are not read)

**Acceptance:**

- `npx vitest run scripts/__tests__` passes (8.1, row R1-HARNESS), including the tests that a missing or changed reference file fails the suite
- `node scripts/verify/run.mjs restyle` passes on the layout as it stands (the local Supabase stack running, for `sidebar-signed-in`): every inventory matches, G1, G2, G4 and G9 pass and the other rules report `pending`; a composite is written for every reference shot of 8.6
- `node scripts/verify/run.mjs restyle --only screens` passes with the local Supabase stack stopped
- `node scripts/verify/run.mjs sync mcp` passes (the review flows on `reviewVersion`)
- `node scripts/verify/run.mjs --help` lists `restyle` as opt-in and `--strict`, and `node scripts/verify/run.mjs smoke` still runs only `smoke`
- `git grep -nE "[Tt]itle ?bar|[Aa]ctivity ?bar|[Ss]tatusbar|[Cc]ommand center|command-center|[Ee]ditor card|editor-card|[Ww]orkbench|BannerStack|monaco-|VS ?Code|vscode" -- scripts ':(exclude)scripts/verify/lib/clone-selectors.mjs' ':(exclude)scripts/redesign/work-packages.json'` prints nothing
- `npx vitest run` passes, except the 3 known `src/App.test.tsx` failures until R2-SHELL fixes them
- `npx tsc --noEmit` and `npx tsc -p electron/tsconfig.json --noEmit` report no errors
- `node scripts/redesign/lint-count.mjs` prints no more ESLint errors than at the fork point (0 at `41d9657`)
- `npm run build` passes
- `node scripts/redesign/check-owns.mjs R1-HARNESS --base advenimus/visual-restyle` exits 0

#### R1-MENUS: Popup menu restyle and hardening (W2-MENUS salvage), the wave-1 integration and owner gate 1

**Owns:** `electron/ipc/menu.ts`, `electron/ipc/menu-svg.ts`, `electron/ipc/__tests__/menu.test.ts`, `electron/ipc/__tests__/menu-svg.test.ts`, `src/utils/contextMenu.ts`, `src/utils/__tests__/contextMenu.test.ts`, `scripts/__tests__/menu-svg-packs.test.ts`

**Deliverables:**

- Cherry-pick `8ca0d23`, `98abd31` and the `electron/` hunks of `70fd889` (7.1, 9.2); comments that name `W4-CLEANUP` name `R4-CLEANUP`; the fallback `MODERN_MENU_COLORS` moved from VS Code's blue to Modern's sky accent (7.1, D-25)
- `scripts/__tests__/menu-svg-packs.test.ts`, re-created from `7f179be`: the six packs and 116 names through `iconToSvg` and `sanitizeSvg`, reset with `setIconPack(DEFAULT_ICON_PACK)`
- Call sites unchanged: today's menu keys keep working through `LEGACY_MENU_ICON_KEYS` (5.7)
- Wave-1 integration and owner gate 1: after this package merges, the checks below run on the wave-1 tip and failures go back to the owning wave-1 package; the package closes when the owner has approved the pack sheets (8.5)

**Acceptance:**

- `npx vitest run electron/ipc/__tests__/menu.test.ts electron/ipc/__tests__/menu-svg.test.ts src/utils/__tests__/contextMenu.test.ts scripts/__tests__/menu-svg-packs.test.ts` passes (8.1, row R1-MENUS)
- `git grep -niE "3994bc|0069cc|243239|e1ecf8" -- electron ':(exclude)**/__tests__/**'` prints nothing (the menu fallbacks use the sky accent, 7.1)
- `node scripts/verify/run.mjs restyle --only menus` passes: items, order, submenus and the application menu equal the reference, and the composites of shots 11 to 17 show the menus where they were
- Manual (macOS): the tab, tree entry and tree folder menus, the Open With and Auto-type submenus and the `+` popup draw with Lucide icons, 24px rows and an 8px-radius panel with a shadow; Up, Down, Enter and Escape work; a click in the shadow margin closes the menu; switching the pack to Hugeicons changes the menu icons on the next open
- Wave-1 integration on the wave-1 tip: `npm run verify` passes all 41 scenarios, and `node scripts/verify/run.mjs restyle` passes (rules without their hooks report `pending`)
- Owner gate 1: `node scripts/verify/run.mjs restyle --only packs` writes the six-pack sheets (dark and light) under `.verify/runs/<id>/restyle/packs/`; the owner approves them and answers the two gate questions of 8.5 (Modern's accent, hover-only tab close); the answers are recorded in this package's pull request
- `npx vitest run` passes, except the 3 known `src/App.test.tsx` failures until R2-SHELL fixes them
- `npx tsc --noEmit` and `npx tsc -p electron/tsconfig.json --noEmit` report no errors
- `node scripts/redesign/lint-count.mjs` prints no more ESLint errors than at the fork point (0 at `41d9657`)
- `npm run build` passes
- `node scripts/redesign/check-owns.mjs R1-MENUS --base advenimus/visual-restyle` exits 0

### 10.2 Wave 2: the chrome, restyled in place

Wave 2 restyles the always-visible chrome. R2-FOUNDATION opens with the wave and owns the shared files; R2-TABS, R2-SIDEBAR and R2-AI run in parallel; R2-SHELL runs last, integrates the wave and holds owner gate 2. Every wave-2 package leaves the app shippable, so they merge straight into `advenimus/visual-restyle`.

| Id | Title | Depends on |
|---|---|---|
| R2-FOUNDATION | Shared foundations during wave 2 (standing package) | R1-MENUS |
| R2-TABS | Pane tab bars, splits, drop zones and the surfaces under the strip | R1-MENUS |
| R2-SIDEBAR | Side bar restyled in place | R1-MENUS |
| R2-AI | AI panel header | R1-MENUS |
| R2-SHELL | Accent line, AI divider and toggle, banners, StartupStatus, the wave-2 integration and owner gate 2 | R2-TABS, R2-SIDEBAR, R2-AI |

#### R2-FOUNDATION: Shared foundations during wave 2 (standing package)

**Owns:** `src/components/ui/**`, `gallery.html`, `src/gallery.tsx`, `src/index.css`, `src/styles/tokens.css`, `src/styles/schemes.css`, `src/styles/base.css`, `src/styles/__tests__/**`, `src/lib/**`, `src/stores/**`, `src/hooks/**`, `src/utils/**`, `src/types/**`, `src/main.tsx`, `src/overlay.tsx`, `src/picker.tsx`, `index.html`, `overlay.html`, `picker.html`, `vite.config.ts`, `vitest.config.ts`, `electron/**`, `scripts/**`, `public/**`, `package.json`, `package-lock.json`, `electron-builder.yml`

**Deliverables:**

- Opens when wave 2 starts and closes when R2-SHELL's wave-2 integration checks and owner gate 2 have passed. It is the only wave-2 package that edits the shared foundations: primitives, the gallery, tokens and base styles, icons, the appearance runtime, the freeze registry, stores, hooks, utilities (the popup menu helper), the main process, the harness, the scripts and the manifests
- Takes change requests from the other wave-2 packages one at a time and lands each as its own small commit with tests, against the contracts in this spec. A request that changes a contract is first written into the spec by a standalone spec commit (10, rule 4); a change to `allowed-deltas.json` lands here, signed off by the integrator (rule 5)
- Keeps the gallery, the token gates, the inventory comparator and the harness selector tests green after every change

**Acceptance:**

- `npx vitest run src/components/ui src/styles src/lib scripts/__tests__` passes after each change
- `node scripts/verify/run.mjs restyle` passes after each change to `scripts/verify`
- `npx vitest run` passes, except the 3 known `src/App.test.tsx` failures until R2-SHELL fixes them
- `npx tsc --noEmit` and `npx tsc -p electron/tsconfig.json --noEmit` report no errors
- `node scripts/redesign/lint-count.mjs` prints no more ESLint errors than at the fork point (0 at `41d9657`)
- `npm run build` passes
- `node scripts/redesign/check-owns.mjs R2-FOUNDATION --base advenimus/visual-restyle` exits 0

#### R2-TABS: Pane tab bars, splits, drop zones and the surfaces under the strip

**Owns:** `src/components/layout/PaneTabBar.tsx`, `src/components/layout/Pane.tsx`, `src/components/layout/PaneContent.tsx`, `src/components/layout/LayoutRenderer.tsx`, `src/components/layout/DropZoneOverlay.tsx`, `src/components/layout/__tests__/PaneTabBar.test.tsx`, `src/components/layout/__tests__/panes.test.tsx`, `src/styles/components/tabs.css`, `src/styles/components/sash.css`, `src/components/sessions/web/WebBrowserToolbar.tsx`, `src/components/sessions/web/WebSubTabBar.tsx`, `src/components/sessions/web/WebAutofillBar.tsx`, `src/components/sessions/DocumentView.tsx`, `src/components/sessions/CommandView.tsx`

**Deliverables:**

- `PaneTabBar` per 3.4: the strip; the hamburger slot (the `menu` glyph, `data-cv-sidebar-toggle`, `aria-expanded`, today's titles and rule); connected tabs with `data-cv-tab` and `data-active` that shrink to fit as today, the label giving way first, down to the 78px floor; 16px icons; state dots from the shared dot; the `IconButton sm tone="inherit"` close, visible on every tab (D-3); the rename input; the drop marker without layout shift; `+` as `IconButton md` with `data-cv-new-tab`, followed by the right slot, in the strip's last `.cv-tabstrip-slot`; the wheel mapping and scroll-into-view for a strip whose tabs are all at the floor; the tab menu's semantic icons
- Splits, drop zones and panes per 3.5: `cv-split-sash` separators, the drop zone look at `z-40`, `data-cv-session-area` on every pane, the empty pane and the empty-vault welcome on primitives, spinners on `Spinner`
- Surfaces under the strip per 3.10: the web browser toolbar, the sub-tab bar, the autofill bar, the document headers and the command header on `--c-editor` with primitives
- `tabs.css` and `sash.css` tuned only where the implementation needs it; every change is written back into 3.4 or 3.5 by a standalone spec commit (10, rule 4)

**Acceptance:**

- `npx vitest run src/components/layout/__tests__/PaneTabBar.test.tsx src/components/layout/__tests__/panes.test.tsx` passes (8.1, row R2-TABS)
- `node scripts/redesign/legacy-classes.mjs src/components/layout/PaneTabBar.tsx src/components/layout/Pane.tsx src/components/layout/PaneContent.tsx src/components/layout/LayoutRenderer.tsx src/components/layout/DropZoneOverlay.tsx src/components/sessions/web src/components/sessions/DocumentView.tsx src/components/sessions/CommandView.tsx` reports 0 findings outside the Appendix B allowlist (dead files of 10.5 excluded)
- `node scripts/verify/run.mjs restyle --only tabs --only ai` passes: the inventories of both scenarios; G1, G2, G4, G5 (its AI toggle part `pending` until R2-SHELL), G6 (a) for the tab bars, G9 and G10; the composites of shots 05, 06, 07, 10, 10b, 18, 40 and 43 show every tab bar control where it was
- Manual (macOS, dark and light): drag a tab to reorder and to the other pane, drop zones, rename, the tab menu, hover and close an inactive tab, twelve tabs in a narrow pane (they shrink to the floor, then the wheel scrolls and the active tab stays in view), a web session whose toolbar continues the active tab, split separator hover and drag
- `npx vitest run` passes, except the 3 known `src/App.test.tsx` failures until R2-SHELL fixes them
- `npx tsc --noEmit` and `npx tsc -p electron/tsconfig.json --noEmit` report no errors
- `node scripts/redesign/lint-count.mjs` prints no more ESLint errors than at the fork point (0 at `41d9657`)
- `npm run build` passes
- `node scripts/redesign/check-owns.mjs R2-TABS --base advenimus/visual-restyle` exits 0

#### R2-SIDEBAR: Side bar restyled in place

**Owns:** `src/components/layout/Sidebar.tsx`, `src/components/layout/SidebarPanel.tsx`, `src/components/layout/SidebarWindowControls.tsx`, `src/components/layout/VaultContextBar.tsx`, `src/components/layout/TeamInvitationBanner.tsx`, `src/components/layout/__tests__/SidebarPanel.test.tsx`, `src/components/layout/__tests__/Sidebar.test.tsx`, `src/components/entries/EntryTree.tsx`, `src/components/entries/__tests__/EntryTree.test.tsx`, `src/components/vault/VaultSwitcherMenu.tsx`, `src/components/sync/PersonalSyncIndicator.tsx`, `src/components/sync/ConflictDot.tsx`, `src/components/vault/CloudSyncIndicator.tsx`, `src/components/vault/TeamSyncIndicator.tsx`

**Deliverables:**

- The panel, resize handle, header row, vault switcher (a 13px `text-ink` name), vault switcher menu, team context bar, onboarding card, invitation banner, search, tree rows with indent guides, trial cards and footer per 3.6, every control in place with today's titles and labels; the floating side bar's accent line with `data-cv-accent-line` (3.3)
- Hooks `data-cv-sidebar-header`, `data-cv-sidebar-search`, `data-cv-sidebar-footer`, `data-cv-vault-switcher` (B17) and `data-cv-review-button` (B13); `data-sidebar-panel` and `data-docked` kept
- The long-name overlap of INVENTORY section 11 fixed by the flex rules of 3.6
- Unit tests for the states of shots 44 to 49: the signed-in footer row 2 (the email with `title="Account Settings"`, Sign Out, then Confirm and Cancel), the `offline` badge, a team vault's tinted header with `VaultContextBar`, the trial card and the trial strip, each asserting today's order, texts and titles

**Acceptance:**

- `npx vitest run src/components/layout/__tests__/SidebarPanel.test.tsx src/components/layout/__tests__/Sidebar.test.tsx src/components/entries/__tests__/EntryTree.test.tsx` passes (8.1, row R2-SIDEBAR)
- `node scripts/redesign/legacy-classes.mjs src/components/layout/Sidebar.tsx src/components/layout/SidebarPanel.tsx src/components/layout/SidebarWindowControls.tsx src/components/layout/VaultContextBar.tsx src/components/layout/TeamInvitationBanner.tsx src/components/entries/EntryTree.tsx src/components/vault/VaultSwitcherMenu.tsx src/components/sync/PersonalSyncIndicator.tsx src/components/sync/ConflictDot.tsx src/components/vault/CloudSyncIndicator.tsx src/components/vault/TeamSyncIndicator.tsx` reports 0 findings outside the Appendix B allowlist (dead files of 10.5 excluded)
- `node scripts/verify/run.mjs restyle --only sidebar --only sidebar-signed-in` passes (the local Supabase stack running): the inventories of both scenarios; G1, G2, G3 for the floating side bar's line, G4, G6 (a) for the header and G7; the composites of shots 04, 06, 07, 08, 09, 21, 38, 39 and 44 to 49 show every control where it was
- Manual: hide, float, pin and unpin; docking by window width; resizing (the 4px accent line after 300ms); at 250px, `Acme Infrastructure` shows at least 12 characters before the ellipsis (macOS) and every header button stays clickable; the favorites filter; clearing the search; tree selection, drag into a folder and rename; the footer sync button opening Settings > Sync
- `npx vitest run` passes, except the 3 known `src/App.test.tsx` failures until R2-SHELL fixes them
- `npx tsc --noEmit` and `npx tsc -p electron/tsconfig.json --noEmit` report no errors
- `node scripts/redesign/lint-count.mjs` prints no more ESLint errors than at the fork point (0 at `41d9657`)
- `npm run build` passes
- `node scripts/redesign/check-owns.mjs R2-SIDEBAR --base advenimus/visual-restyle` exits 0

#### R2-AI: AI panel header

**Owns:** `src/components/ai/ChatPanel.tsx`, `src/components/ai/__tests__/ChatPanel.header.test.tsx`

**Deliverables:**

- The `ChatPanel` root on `bg-sidebar` and the header per 3.7 with `data-cv-ai-header`: the 33px row, the engine picker, the engine dropdown with the active engine's `●` kept, the model chip and the new conversation button, in today's order with today's titles and behavior
- The body below the header stays as it is until R3-AI

**Acceptance:**

- `npx vitest run src/components/ai/__tests__/ChatPanel.header.test.tsx` passes (8.1, row R2-AI)
- No legacy finding above the body: `m=$(grep -n "{/\* Messages \*/}" src/components/ai/ChatPanel.tsx | cut -d: -f1); node scripts/redesign/legacy-classes.mjs --json src/components/ai/ChatPanel.tsx | node -e "const r=JSON.parse(require('fs').readFileSync(0,'utf8'));console.log(r.findings.filter((f)=>f.line<$m).length)"` prints 0 (the root and the header; the body's findings belong to R3-AI)
- `node scripts/verify/run.mjs restyle --only ai` passes: the inventories `ai-panel` and `ai-panel-engine-menu-open` (the `●` included); G6 (a): `[data-cv-ai-header]` is 33px tall; G6 (b) and G8 report `pending` until R2-SHELL; the composites of shots 18 and 19 show the header controls where they were
- `npx vitest run` passes, except the 3 known `src/App.test.tsx` failures until R2-SHELL fixes them
- `npx tsc --noEmit` and `npx tsc -p electron/tsconfig.json --noEmit` report no errors
- `node scripts/redesign/lint-count.mjs` prints no more ESLint errors than at the fork point (0 at `41d9657`)
- `npm run build` passes
- `node scripts/redesign/check-owns.mjs R2-AI --base advenimus/visual-restyle` exits 0

#### R2-SHELL: Accent line, AI divider and toggle, banners, StartupStatus, the wave-2 integration and owner gate 2

**Owns:** `src/App.tsx`, `src/App.test.tsx`, `src/components/sync/SyncBanner.tsx`, `src/components/sync/SyncBanners.tsx`, `src/components/sync/__tests__/SyncBanners.test.tsx`, `src/components/common/StartupStatus.tsx`, `src/components/common/__tests__/StartupStatus.test.tsx`

**Deliverables:**

- `App.tsx`: roots on `bg-editor`, the accent line with `data-cv-accent-line` (3.3), both offline banners on `Banner status={false} align="center"` with their `Reconnect` button (3.8), the loading and auto-connect screens on `Spinner` (3.11), the AI toggle as `IconButton` with `pressed` and `data-cv-ai-toggle` (3.4), the AI divider and panel classes and hooks (3.7)
- `SyncBanner` on the `Banner` primitive (3.8): its actions stay buttons (`Button size="sm"`, `primary` where the action is primary); `SyncBanners`, `PromptBanner` and `SideFilesPausedBanner` inherit it unchanged
- `StartupStatus` per 3.9
- `src/App.test.tsx` fixed without touching `src/test/setup.ts`: `window.electron` stubbed inside the test with `vi.stubGlobal` (undone in `afterEach`), and the three assertions rewritten to what `App` renders under that stub (the loading screen whose whole text is `Loading...`, then the screen the stubbed startup calls lead to, by its exact texts)
- Wave-2 integration and owner gate 2: after this package merges, the checks below run on the wave-2 tip and failures go back to the owning wave-2 package or R2-FOUNDATION; the package closes when the owner has approved the composites (8.5)

**Acceptance:**

- `node scripts/redesign/legacy-classes.mjs src/App.tsx src/components/sync/SyncBanner.tsx src/components/sync/SyncBanners.tsx src/components/common/StartupStatus.tsx` reports 0 findings outside the Appendix B allowlist (dead files of 10.5 excluded)
- Manual: the offline banner (cached auth) centered with its `Reconnect` button, a sync banner (for example the review banner that the `sync` suite raises) with `Review` as a primary button, `StartupStatus` during a FreeRDP build (or its component test), the AI divider hover and drag, the accent line in all seven schemes
- Wave-2 integration on the wave-2 tip: `node scripts/verify/run.mjs restyle --strict` passes every scenario (no rule pending), and `npm run verify` passes all 41 scenarios
- Owner gate 2: the owner approves the dark and light composites of shots 04 to 10b, 18, 19, 21 and 44 to 49 under `.verify/runs/<id>/restyle/compare/`; the approval is recorded in this package's pull request
- `npx vitest run` passes with no failures
- `npx tsc --noEmit` and `npx tsc -p electron/tsconfig.json --noEmit` report no errors
- `node scripts/redesign/lint-count.mjs` prints no more ESLint errors than at the fork point (0 at `41d9657`)
- `npm run build` passes
- `node scripts/redesign/check-owns.mjs R2-SHELL --base advenimus/visual-restyle` exits 0

### 10.3 Wave 3: every other surface, by directory

Wave 3 restyles dialogs, screens, session views, the picker and toasts, one directory per package, and starts after owner gate 2 has closed R2-SHELL. R3-FOUNDATION opens with the wave, owns everything outside the wave-3 directories, lands the primitive fixes the other packages ask for, and closes last with the wave-3 integration. R3-SYNC runs after R3-MISC (the stacked confirm, 4.8). Every dialog keeps its close behavior (3.12.1).

| Id | Title | Depends on |
|---|---|---|
| R3-FOUNDATION | Shared foundations during wave 3 and the wave-3 integration (standing package) | R2-SHELL |
| R3-SETTINGS | Settings dialog, its tabs and the final Appearance tab | R2-SHELL |
| R3-ENTRIES | Entry and folder dialogs, entry tabs, pickers and custom icons | R2-SHELL |
| R3-VAULT | Vault hub and vault lifecycle dialogs | R2-SHELL |
| R3-TEAM | Team vault, device and credential dialogs | R2-SHELL |
| R3-SYNC | Sync dialogs and panels | R2-SHELL, R3-MISC |
| R3-DASHBOARD | Home, entry and folder dashboards | R2-SHELL |
| R3-AI | AI panel body and AI dialogs | R2-SHELL |
| R3-AUTH-ONBOARDING | Sign-in and onboarding screens | R2-SHELL |
| R3-MISC | Confirm, about, what's new, tools, import, upgrade, feedback and connections | R2-SHELL |
| R3-SESSIONS | Session views and markdown | R2-SHELL |
| R3-PICKER | Credential picker window | R2-SHELL |
| R3-OVERLAY | Toasts and the update notification | R2-SHELL |

#### R3-FOUNDATION: Shared foundations during wave 3 and the wave-3 integration (standing package)

**Owns:** `src/App.tsx`, `src/App.test.tsx`, `src/main.tsx`, `src/overlay.tsx`, `src/picker.tsx`, `src/gallery.tsx`, `src/index.css`, `src/styles/**`, `src/lib/**`, `src/stores/**`, `src/hooks/**`, `src/utils/**`, `src/types/**`, `src/test/**`, `src/components/ui/**`, `src/components/layout/**`, `index.html`, `overlay.html`, `picker.html`, `gallery.html`, `vite.config.ts`, `vitest.config.ts`, `electron/**`, `scripts/**`, `public/**`, `package.json`, `package-lock.json`, `electron-builder.yml`

**Deliverables:**

- Opens when wave 3 starts and closes when its closing step passes. It owns every file that no wave-3 directory package owns: primitives, styles, icons, the appearance runtime, the freeze registry, stores, hooks, shared libraries, the layout components, `App.tsx`, the main process, the harness, the scripts and the manifests
- Takes change requests from the wave-3 packages one at a time and lands each as its own small commit with tests, against the contracts in this spec; a change to `allowed-deltas.json` lands here, signed off by the integrator (10, rule 5)
- Closing step (wave-3 integration), after every other wave-3 package has merged: runs the checks below on the wave-3 tip, sends each failure to the owning package, and closes only when all pass

**Acceptance:**

- `node scripts/verify/run.mjs restyle --strict` passes after each change to `scripts/verify`, `src/components/layout` or `src/components/ui`
- Closing, on the wave-3 tip: `npm run verify` passes all 41 scenarios, and `node scripts/verify/run.mjs restyle --strict` passes every scenario
- `npx vitest run` passes with no failures
- `npx tsc --noEmit` and `npx tsc -p electron/tsconfig.json --noEmit` report no errors
- `node scripts/redesign/lint-count.mjs` prints no more ESLint errors than at the fork point (0 at `41d9657`)
- `npm run build` passes
- `node scripts/redesign/check-owns.mjs R3-FOUNDATION --base advenimus/visual-restyle` exits 0

#### R3-SETTINGS: Settings dialog, its tabs and the final Appearance tab

**Owns:** `src/components/settings/**`

**Deliverables:**

- `SettingsDialog` on `Dialog` with today's width and close behavior (3.12.1: Escape and the close button cancel); the nav as `NavList`, keeping `w-52` and adding `data-cv-settings-nav`; footer Cancel then Save; hooks B1 to B4, B7, B22 to B24, B36, B37 and B39 to B41 (3.12, Appendix B)
- Every tab on `SettingsRow`, `FormField`, `Select`, `Checkbox`, `Switch`, `SegmentedControl` and `Slider`; section labels keep their element (`<label>` or `<h3>`) and take the section label look; the 4.16 map applied; every label, option, placeholder and busy text unchanged, the AI tab's engine `●` included
- The Appearance tab's final form (6.4): its four section labels stay `<label>` elements, the scheme cards on `ChoiceCard`, Brightness on `SegmentedControl`, UI Scale on `Slider`; the Icon pack section from R1-FOUNDATION kept

**Acceptance:**

- `npx vitest run --passWithNoTests src/components/settings` passes, including the close-behavior test of 3.12.1
- `node scripts/redesign/legacy-classes.mjs src/components/settings` reports 0 findings outside the Appendix B allowlist (dead files of 10.5 excluded)
- `node scripts/verify/run.mjs restyle --strict --only settings` passes (the 14 `settings-*` inventories, with only the `settings-appearance` delta); the composites of every `20-*` shot show the controls where they were
- `node scripts/verify/run.mjs backup lifecycle password` passes (targeted live suites, 8.5; the Settings flows of `lib/settings-flows.mjs`)
- Manual: every tab in dark and light; Appearance previews live, and Cancel reverts scheme, mode, pack and zoom
- `npx vitest run` passes with no failures
- `npx tsc --noEmit` and `npx tsc -p electron/tsconfig.json --noEmit` report no errors
- `node scripts/redesign/lint-count.mjs` prints no more ESLint errors than at the fork point (0 at `41d9657`)
- `npm run build` passes
- `node scripts/redesign/check-owns.mjs R3-SETTINGS --base advenimus/visual-restyle` exits 0

#### R3-ENTRIES: Entry and folder dialogs, entry tabs, pickers and custom icons

**Owns:** `src/components/entries/**`

**Deliverables:**

- `EntryDialog` and `EntryDialogSidebar` on `Dialog` (with `onSubmit` where there is a form, today's width per step, and the close behavior of 3.12.1: no Escape, the close button kept) and `NavList`; group labels without uppercase; the type chips on neutral tiles in their entry colors; every entry tab on `FormField`, `Select` and `Checkbox`; `FolderDialog` on `Dialog` (3.12)
- `ColorPicker` and `IconPicker` restyled in place (3.16): position logic, size, header, search, Default button and grids kept, the overlay look taken; `Field`, `DefaultableSelect` and `DefaultableCheckbox` rebuilt on primitives
- Custom entry icons (5.11): the 30 curated names with a semantic twin render through the active pack in the tree, the tabs, the dashboards and the `IconPicker` grid; stored names unchanged; the other 35 stay Tabler; `EntryTree.tsx` gets only 4.16 leftovers

**Acceptance:**

- `npx vitest run --passWithNoTests src/components/entries` passes, including the twin table test (5.11) and the close-behavior tests of 3.12.1
- `node scripts/redesign/legacy-classes.mjs src/components/entries` reports 0 findings outside the Appendix B allowlist (dead files of 10.5 excluded)
- `node scripts/verify/run.mjs restyle --strict --only dialogs` passes for `new-entry-dialog`, `new-entry-ssh-form`, the six `edit-entry-rdp-*` screens and `new-folder-dialog`; the composites of shots 22 to 30 show the controls where they were
- Manual: with Hugeicons active, an entry whose custom icon is `IconServer` shows the Hugeicons server glyph and one whose icon is `IconBrandDocker` shows the Tabler glyph
- `npx vitest run` passes with no failures
- `npx tsc --noEmit` and `npx tsc -p electron/tsconfig.json --noEmit` report no errors
- `node scripts/redesign/lint-count.mjs` prints no more ESLint errors than at the fork point (0 at `41d9657`)
- `npm run build` passes
- `node scripts/redesign/check-owns.mjs R3-ENTRIES --base advenimus/visual-restyle` exits 0

#### R3-VAULT: Vault hub and vault lifecycle dialogs

**Owns:** `src/components/vault/VaultHub.tsx`, `src/components/vault/UnlockDialog.tsx`, `src/components/vault/ChangePasswordDialog.tsx`, `src/components/vault/RenameVaultDialog.tsx`, `src/components/vault/CloudRestoreDialog.tsx`, `src/components/vault/BackupManagerDialog.tsx`, `src/components/vault/BackupHistoryPanel.tsx`, `src/components/vault/BiometricSetupPrompt.tsx`, `src/components/vault/RecoveryPassphraseDialog.tsx`, `src/components/vault/ProVaultLockDialog.tsx`, `src/components/vault/ExportDialog.tsx`, `src/components/vault/VaultImportDialog.tsx`, `src/components/vault/VaultSwitcherMenu.tsx`, `src/components/vault/CloudSyncIndicator.tsx`, `src/components/vault/__tests__/ChangePasswordDialog.test.tsx`, `src/components/vault/__tests__/UnlockDialog.strict.test.tsx`, `src/components/vault/__tests__/VaultHub.test.tsx`

**Deliverables:**

- The vault hub per 3.11: recent rows as clickable `ListRow`s with the 28px icon tile as `leading`, `PendingBadge` and the fingerprint in `meta` (always visible) and only the chevron in `trailing`; rows stay `button[title="{path}"]` (B26, B44)
- Every vault lifecycle dialog on `Dialog` with the close behavior of 3.12.1, and `onSubmit` for forms: `UnlockDialog` keeps its placeholders, `Please wait...` and `data-cv-error` (B8, B30, B35); `BackupManagerDialog` gets `data-cv-backup-manager` and keeps `Master password`, Restore, Confirm and Close (B25, B42); `RecoveryPassphraseDialog` cannot be dismissed (no close button, no Escape)
- `VaultSwitcherMenu` and `CloudSyncIndicator`: only 4.16 leftovers (R2-SIDEBAR restyled them); the dead files of 10.5 are skipped

**Acceptance:**

- `npx vitest run --passWithNoTests src/components/vault` passes, including the hub rows' `meta` visible without hover and the close-behavior tests of 3.12.1
- `node scripts/redesign/legacy-classes.mjs src/components/vault/VaultHub.tsx src/components/vault/UnlockDialog.tsx src/components/vault/ChangePasswordDialog.tsx src/components/vault/RenameVaultDialog.tsx src/components/vault/CloudRestoreDialog.tsx src/components/vault/BackupManagerDialog.tsx src/components/vault/BackupHistoryPanel.tsx src/components/vault/BiometricSetupPrompt.tsx src/components/vault/RecoveryPassphraseDialog.tsx src/components/vault/ProVaultLockDialog.tsx src/components/vault/ExportDialog.tsx src/components/vault/VaultImportDialog.tsx src/components/vault/VaultSwitcherMenu.tsx src/components/vault/CloudSyncIndicator.tsx` reports 0 findings outside the Appendix B allowlist (dead files of 10.5 excluded)
- `node scripts/verify/run.mjs restyle --strict --only screens` passes for `vault-hub-empty`, `vault-hub-with-recent` and `unlock-dialog`; the composites of shots 01, 02, 41 and 42 show the controls where they were
- `node scripts/verify/run.mjs backup lifecycle password` passes (targeted live suites, 8.5; unlock, password and backup dialogs)
- `npx vitest run` passes with no failures
- `npx tsc --noEmit` and `npx tsc -p electron/tsconfig.json --noEmit` report no errors
- `node scripts/redesign/lint-count.mjs` prints no more ESLint errors than at the fork point (0 at `41d9657`)
- `npm run build` passes
- `node scripts/redesign/check-owns.mjs R3-VAULT --base advenimus/visual-restyle` exits 0

#### R3-TEAM: Team vault, device and credential dialogs

**Owns:** `src/components/vault/VaultSettingsDialog.tsx`, `src/components/vault/CreateTeamVaultDialog.tsx`, `src/components/vault/TeamVaultUnlock.tsx`, `src/components/vault/DeviceSetupDialog.tsx`, `src/components/vault/DeviceAuthApprovalDialog.tsx`, `src/components/vault/AuditLogViewer.tsx`, `src/components/vault/CredentialManager.tsx`, `src/components/vault/CredentialForm.tsx`, `src/components/vault/CredentialPicker.tsx`, `src/components/vault/PasswordHistoryDialog.tsx`, `src/components/vault/TeamSyncIndicator.tsx`, `src/components/vault/__tests__/TeamDialogs.test.tsx`

**Deliverables:**

- `VaultSettingsDialog` (on `Dialog` with a `NavList`), `CreateTeamVaultDialog`, `TeamVaultUnlock`, `DeviceSetupDialog`, `DeviceAuthApprovalDialog`, `AuditLogViewer`, `CredentialManager`, `CredentialForm`, `CredentialPicker` and `PasswordHistoryDialog` on primitives with the close behavior of 3.12.1, keeping every text, field and order; `TeamSyncIndicator` gets only 4.16 leftovers
- `src/components/vault/__tests__/TeamDialogs.test.tsx` renders each owned dialog with minimal props and asserts its title, fields, footer order and close behavior (3.12.1)

**Acceptance:**

- `npx vitest run --passWithNoTests src/components/vault` passes
- `node scripts/redesign/legacy-classes.mjs src/components/vault/VaultSettingsDialog.tsx src/components/vault/CreateTeamVaultDialog.tsx src/components/vault/TeamVaultUnlock.tsx src/components/vault/DeviceSetupDialog.tsx src/components/vault/DeviceAuthApprovalDialog.tsx src/components/vault/AuditLogViewer.tsx src/components/vault/CredentialManager.tsx src/components/vault/CredentialForm.tsx src/components/vault/CredentialPicker.tsx src/components/vault/PasswordHistoryDialog.tsx src/components/vault/TeamSyncIndicator.tsx` reports 0 findings outside the Appendix B allowlist (dead files of 10.5 excluded)
- `npx vitest run` passes with no failures
- `npx tsc --noEmit` and `npx tsc -p electron/tsconfig.json --noEmit` report no errors
- `node scripts/redesign/lint-count.mjs` prints no more ESLint errors than at the fork point (0 at `41d9657`)
- `npm run build` passes
- `node scripts/redesign/check-owns.mjs R3-TEAM --base advenimus/visual-restyle` exits 0

#### R3-SYNC: Sync dialogs and panels

**Owns:** `src/components/sync/**`

**Deliverables:**

- `SyncDialogFrame` rebuilt on `Dialog` (`harnessLabel` = title, layer `sync`, `hideClose`, Escape runs `onEscape` only where a dialog passes one, 3.12.1); `DialogButton` and `smallButton` on `Button` with `loadingLabel` where a busy text shows (`Opening...`, `Checking...`, B35); `InlineError` on `Callout`; `PasswordInput` on the primitive
- `ConflictReviewPanel` (`harnessLabel` `Review changes`, its close button labeled `Close`, B12) with the B11 hooks and `data-cv-review-version` on each version line, which holds the value, the `In use now` badge and `Use this` (B47); `RecentlyDeletedPanel` passes `layer="stacked"` and `closeOnEscape` to `ConfirmDialog` and drops its `z-[70]` wrapper (B18, B19); `OtherCopiesPanel` B20; `MassChangeNotice` B21; `SyncDevicesList` B5; `SyncNoticeList` B6 and B38; `IdleLockSetting` keeps its `aria-label` (B28); `Loading...`, `Looking for copies...` and `Comparing...` stay visible text (B35)
- Files restyled in wave 2 (`SyncBanner`, `SyncBanners`, `PersonalSyncIndicator`, `ConflictDot`) get only 4.16 leftovers; `useEscapeLayer.ts` stays a re-export

**Acceptance:**

- `npx vitest run --passWithNoTests src/components/sync` passes, including the close-behavior tests of 3.12.1
- `node scripts/redesign/legacy-classes.mjs src/components/sync` reports 0 findings outside the Appendix B allowlist (dead files of 10.5 excluded)
- `node scripts/verify/run.mjs restyle --strict --only dialogs` passes for the three `sync-panel-*` screens; the composites of shots 33 to 35 show the controls where they were
- `node scripts/verify/run.mjs sync mcp copies lifecycle` passes (targeted live suites, 8.5; review, other copies and Recently deleted)
- `npx vitest run` passes with no failures
- `npx tsc --noEmit` and `npx tsc -p electron/tsconfig.json --noEmit` report no errors
- `node scripts/redesign/lint-count.mjs` prints no more ESLint errors than at the fork point (0 at `41d9657`)
- `npm run build` passes
- `node scripts/redesign/check-owns.mjs R3-SYNC --base advenimus/visual-restyle` exits 0

#### R3-DASHBOARD: Home, entry and folder dashboards

**Owns:** `src/components/dashboard/**`

**Deliverables:**

- `DashboardOverview`, `EntryDashboard` and `FolderDashboard` on `bg-editor` with `Card`, `ListRow`, `Button`, `IconButton`, `Kbd` and `SectionHeader`; entry rows as clickable `ListRow`s with the time or the type label in `meta` (always visible; the type label without CSS uppercase, 8.4); the local icon button of `EntryDashboard` replaced; texts and order unchanged

**Acceptance:**

- `npx vitest run --passWithNoTests src/components/dashboard` passes
- `node scripts/redesign/legacy-classes.mjs src/components/dashboard` reports 0 findings outside the Appendix B allowlist (dead files of 10.5 excluded)
- `node scripts/verify/run.mjs restyle --strict --only tabs` passes for `home-dashboard-full-window`; the composite of shot 40 shows the dashboard blocks where they were
- `npx vitest run` passes with no failures
- `npx tsc --noEmit` and `npx tsc -p electron/tsconfig.json --noEmit` report no errors
- `node scripts/redesign/lint-count.mjs` prints no more ESLint errors than at the fork point (0 at `41d9657`)
- `npm run build` passes
- `node scripts/redesign/check-owns.mjs R3-DASHBOARD --base advenimus/visual-restyle` exits 0

#### R3-AI: AI panel body and AI dialogs

**Owns:** `src/components/ai/**`

**Deliverables:**

- The `ChatPanel` body, `EnginePicker`, `McpSetupDialog` (3.12.1: Escape, an outside click and its close button close it; `layer="sync"`) and the message blocks on primitives; `ModelPicker` restyled in place as an in-flow card (3.16); the header of R2-AI kept; `EngineLogo` unchanged

**Acceptance:**

- `npx vitest run --passWithNoTests src/components/ai` passes
- `node scripts/redesign/legacy-classes.mjs src/components/ai` reports 0 findings outside the Appendix B allowlist (dead files of 10.5 excluded)
- `node scripts/verify/run.mjs restyle --strict --only ai` passes; the composites of shots 18 and 19 show the panel as before
- `npx vitest run` passes with no failures
- `npx tsc --noEmit` and `npx tsc -p electron/tsconfig.json --noEmit` report no errors
- `node scripts/redesign/lint-count.mjs` prints no more ESLint errors than at the fork point (0 at `41d9657`)
- `npm run build` passes
- `node scripts/redesign/check-owns.mjs R3-AI --base advenimus/visual-restyle` exits 0

#### R3-AUTH-ONBOARDING: Sign-in and onboarding screens

**Owns:** `src/components/auth/**`, `src/components/onboarding/**`

**Deliverables:**

- `AuthScreen` and `OnboardingWizard` on primitives (3.11): `Button size="lg"` for the main actions, `text-display` titles, `Callout` for the trial note; texts, including `Continue without signing in`, and layout unchanged

**Acceptance:**

- `node scripts/redesign/legacy-classes.mjs src/components/auth src/components/onboarding` reports 0 findings outside the Appendix B allowlist (dead files of 10.5 excluded)
- `node scripts/verify/run.mjs restyle --strict --only screens` passes for `auth-screen`; the composite of shot 00 shows the controls where they were
- `npx vitest run` passes with no failures
- `npx tsc --noEmit` and `npx tsc -p electron/tsconfig.json --noEmit` report no errors
- `node scripts/redesign/lint-count.mjs` prints no more ESLint errors than at the fork point (0 at `41d9657`)
- `npm run build` passes
- `node scripts/redesign/check-owns.mjs R3-AUTH-ONBOARDING --base advenimus/visual-restyle` exits 0

#### R3-MISC: Confirm, about, what's new, tools, import, upgrade, feedback and connections

**Owns:** `src/components/tools/**`, `src/components/import/**`, `src/components/about/**`, `src/components/whats-new/**`, `src/components/upgrade/**`, `src/components/feedback/**`, `src/components/connections/**`, `src/components/common/**`

**Deliverables:**

- `ConfirmDialog` on `Dialog` with a compatible API plus `cancelLabel`, `layer` and `closeOnEscape` (off by default, as today; no close button); without a `layer` it renders in place (`portal={false}`) until R3-SYNC passes `layer="stacked"` (4.8)
- `AboutDialog` (no licenses view, 5.9), `WhatsNewDialog`, `QuickConnect` (`SegmentedControl` for the types), `PasswordGeneratorDialog`, `SshKeyGeneratorDialog`, `ImportDialog` and `FeedbackDialog` on `Dialog` with today's widths and close behavior (3.12.1); `UpgradeBanner` on `Callout`
- `StartupStatus` (restyled in wave 2) gets only 4.16 leftovers; the dead files of 10.5 are skipped

**Acceptance:**

- `npx vitest run --passWithNoTests src/components/common src/components/connections src/components/tools src/components/import src/components/about src/components/whats-new src/components/upgrade src/components/feedback` passes, including the close-behavior tests of 3.12.1
- `node scripts/redesign/legacy-classes.mjs src/components/tools src/components/import src/components/about src/components/whats-new src/components/upgrade src/components/feedback src/components/connections src/components/common` reports 0 findings outside the Appendix B allowlist (dead files of 10.5 excluded)
- `node scripts/verify/run.mjs restyle --strict --only dialogs` passes for `quick-connect-dialog` and `confirm-delete-dialog`, including G9 with a web session focused; the composites of shots 31 and 32 show the controls where they were
- `node scripts/verify/run.mjs lifecycle` passes (targeted live suites, 8.5; the stacked confirm of Recently deleted)
- `npx vitest run` passes with no failures
- `npx tsc --noEmit` and `npx tsc -p electron/tsconfig.json --noEmit` report no errors
- `node scripts/redesign/lint-count.mjs` prints no more ESLint errors than at the fork point (0 at `41d9657`)
- `npm run build` passes
- `node scripts/redesign/check-owns.mjs R3-MISC --base advenimus/visual-restyle` exits 0

#### R3-SESSIONS: Session views and markdown

**Owns:** `src/components/sessions/**`, `src/components/markdown/**`

**Deliverables:**

- RDP, VNC, terminal and web view containers, `ConnectionError` and every error, loading and empty state on `bg-editor` with primitives; `MarkdownEditor` on `Tabs variant="panel"`; code blocks on `bg-code`; the bars restyled in wave 2 get only 4.16 leftovers; terminal fonts and the ANSI palette unchanged

**Acceptance:**

- `npx vitest run --passWithNoTests src/components/sessions src/components/markdown` passes
- `node scripts/redesign/legacy-classes.mjs src/components/sessions src/components/markdown` reports 0 findings outside the Appendix B allowlist (dead files of 10.5 excluded)
- `node scripts/verify/run.mjs restyle --strict --only tabs` passes for `web-session-toolbar` and `document-view-runbook`; the composites of shots 07 and 43 show the views as before
- `npx vitest run` passes with no failures
- `npx tsc --noEmit` and `npx tsc -p electron/tsconfig.json --noEmit` report no errors
- `node scripts/redesign/lint-count.mjs` prints no more ESLint errors than at the fork point (0 at `41d9657`)
- `npm run build` passes
- `node scripts/redesign/check-owns.mjs R3-SESSIONS --base advenimus/visual-restyle` exits 0

#### R3-PICKER: Credential picker window

**Owns:** `src/components/picker/**`

**Deliverables:**

- `CredentialPickerApp` and its lists on primitives (3.15); inline SVGs replaced by semantic icons; the drag header, window size and flows unchanged

**Acceptance:**

- `node scripts/redesign/legacy-classes.mjs src/components/picker` reports 0 findings outside the Appendix B allowlist (dead files of 10.5 excluded)
- `node scripts/verify/run.mjs restyle --only packs` passes its picker-window checks (the window follows each of the six packs, dark and light)
- Manual: Cmd/Ctrl+Shift+Space opens the picker in dark and light with the active icon pack, at today's size, with a working drag header
- `npx vitest run` passes with no failures
- `npx tsc --noEmit` and `npx tsc -p electron/tsconfig.json --noEmit` report no errors
- `node scripts/redesign/lint-count.mjs` prints no more ESLint errors than at the fork point (0 at `41d9657`)
- `npm run build` passes
- `node scripts/redesign/check-owns.mjs R3-PICKER --base advenimus/visual-restyle` exits 0

#### R3-OVERLAY: Toasts and the update notification

**Owns:** `src/components/overlay/**`

**Deliverables:**

- `OverlayToast` and `OverlayUpdateNotification` on `ToastCard` (3.14); `OverlayApp`'s container geometry unchanged; `data-toast` kept

**Acceptance:**

- `node scripts/redesign/legacy-classes.mjs src/components/overlay` reports 0 findings outside the Appendix B allowlist (dead files of 10.5 excluded)
- `node scripts/verify/run.mjs restyle --strict --only toasts` passes; the composites of shots 36 and 37 show four toasts at today's position and stacking
- `node scripts/verify/run.mjs restyle --only packs` passes its toast checks (the toast window follows each of the six packs, dark and light)
- `npx vitest run` passes with no failures
- `npx tsc --noEmit` and `npx tsc -p electron/tsconfig.json --noEmit` report no errors
- `node scripts/redesign/lint-count.mjs` prints no more ESLint errors than at the fork point (0 at `41d9657`)
- `npm run build` passes
- `node scripts/redesign/check-owns.mjs R3-OVERLAY --base advenimus/visual-restyle` exits 0

### 10.4 Wave 4: harness, docs and cleanup

Wave 4 starts when R3-FOUNDATION has closed wave 3. R4-HARNESS and R4-DOCS run in parallel; R4-CLEANUP runs last, performs the final integration and holds owner gate 3.

| Id | Title | Depends on |
|---|---|---|
| R4-HARNESS | Final harness selectors and restyle suite | R3-FOUNDATION, R3-SETTINGS, R3-ENTRIES, R3-VAULT, R3-TEAM, R3-SYNC, R3-DASHBOARD, R3-AI, R3-AUTH-ONBOARDING, R3-MISC, R3-SESSIONS, R3-PICKER, R3-OVERLAY |
| R4-DOCS | FEATURES.md, What's New and spec status | R3-FOUNDATION, R3-SETTINGS, R3-ENTRIES, R3-VAULT, R3-TEAM, R3-SYNC, R3-DASHBOARD, R3-AI, R3-AUTH-ONBOARDING, R3-MISC, R3-SESSIONS, R3-PICKER, R3-OVERLAY |
| R4-CLEANUP | Dead files, shims, the final integration and owner gate 3 | R4-HARNESS, R4-DOCS |

#### R4-HARNESS: Final harness selectors and restyle suite

**Owns:** `scripts/verify/**`, `scripts/__tests__/verify-harness.test.ts`, `scripts/__tests__/verify-selectors.test.ts`, `scripts/__tests__/restyle-inventory.test.ts`

**Deliverables:**

- The legacy halves of every selector pair removed (Appendix B, "Final" column); `pickSelector` kept only where a hook is probed through a sibling
- The restyle suite's `allowed-deltas.json` reduced to what the final UI needs; the README updated

**Acceptance:**

- `npx vitest run scripts/__tests__` passes (8.1, row R4-HARNESS)
- `node scripts/verify/run.mjs restyle --strict` passes every scenario
- `npx vitest run` passes with no failures
- `npx tsc --noEmit` and `npx tsc -p electron/tsconfig.json --noEmit` report no errors
- `node scripts/redesign/lint-count.mjs` prints no more ESLint errors than at the fork point (0 at `41d9657`)
- `npm run build` passes
- `node scripts/redesign/check-owns.mjs R4-HARNESS --base advenimus/visual-restyle` exits 0

#### R4-DOCS: FEATURES.md, What's New and spec status

**Owns:** `docs/FEATURES.md`, `release-notes/manifest.json`, `docs/VISUAL_REDESIGN.md`

**Deliverables:**

- `docs/FEATURES.md`: the Appearance section (Modern default with the sky accent, the six icon packs with Lucide as default and Hugeicons new, custom entry icons following the pack where a twin exists (5.11), platform themes retired), and the look lines of the Sidebar, Tab Bar, Dialogs, Context Menus and Notifications sections; no layout feature is described as changed
- `release-notes/manifest.json`: the Appendix C highlights in the pending release entry (created with the release version and date if missing)
- This spec: status line set to shipped, and any contract change the integrators recorded folded into its sections

**Acceptance:**

- `node -e "JSON.parse(require('fs').readFileSync('release-notes/manifest.json','utf8'))"` exits 0
- `grep -n "Codicons" docs/FEATURES.md release-notes/manifest.json` prints nothing, and `grep -n "Platform themes" docs/FEATURES.md` mentions them only as retired
- `npx vitest run` passes with no failures
- `npx tsc --noEmit` and `npx tsc -p electron/tsconfig.json --noEmit` report no errors
- `node scripts/redesign/lint-count.mjs` prints no more ESLint errors than at the fork point (0 at `41d9657`)
- `npm run build` passes
- `node scripts/redesign/check-owns.mjs R4-DOCS --base advenimus/visual-restyle` exits 0

#### R4-CLEANUP: Dead files, shims, the final integration and owner gate 3

**Owns:** `src/**`, `scripts/redesign/**`, `scripts/__tests__/legacy-classes.test.ts`

**Deliverables:**

- The nine dead files of 10.5 deleted; `DEAD_FILES` in `scripts/redesign/legacy-classes.mjs` emptied (or removed with its skip), and `scripts/__tests__/legacy-classes.test.ts` checks the dead-file skip on temporary fixture files instead of repo files, without the length assertion
- Shims removed: the `src/hooks/useTheme.ts` re-export (`App.tsx` imports `useAppearance`), `src/components/sync/useEscapeLayer.ts`, `LEGACY_MENU_ICON_KEYS` after every call site passes semantic names; `ConfirmDialog` portals by default
- `src/components/__tests__/overlay-freeze.test.tsx`: each of the 24 overlays that `App.tsx` lists renders alone and holds a freeze by itself. `App.tsx`'s `legacy` freeze and the legacy event bridge stay in this release (4.9, D-28)
- `src/components/__tests__/icon-sizes.test.ts` (5.5); the legacy-class allowlist trimmed to entries still needed
- Final integration and owner gate 3: the checks below on the release tip

**Acceptance:**

- `node scripts/redesign/legacy-classes.mjs src` reports 0 findings outside the Appendix B allowlist (dead files of 10.5 excluded)
- `npx vitest run src/components/__tests__/icon-sizes.test.ts src/components/__tests__/overlay-freeze.test.tsx scripts/__tests__/legacy-classes.test.ts` passes
- Final integration: `npm run verify` passes all scenarios; `node scripts/verify/run.mjs restyle --strict` passes every scenario; the 8.7 checks are listed in the PR test plan
- Owner gate 3: the owner approves the dark and light composites of every reference shot; the approval is recorded in this package's pull request
- `npx vitest run` passes with no failures
- `npx tsc --noEmit` and `npx tsc -p electron/tsconfig.json --noEmit` report no errors
- `node scripts/redesign/lint-count.mjs` prints no more ESLint errors than at the fork point (0 at `41d9657`)
- `npm run build` passes
- `node scripts/redesign/check-owns.mjs R4-CLEANUP --base advenimus/visual-restyle` exits 0

### 10.5 Dead files

These nine files have no importers [V: grep of `src` and `electron` for each module, 2026-09-28]. Packages skip them, the legacy report excludes them (`DEAD_FILES` in `scripts/redesign/legacy-classes.mjs`), and R4-CLEANUP deletes them. `scripts/__tests__/legacy-classes.test.ts` reads two of them from the repo and asserts nine entries (`legacy-classes.test.ts:180-185` [V]), so R4-CLEANUP owns that test and moves it to temporary fixture files in the same change.

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
| `src/App.tsx`, `src/App.test.tsx` | none | R2-SHELL | R3-FOUNDATION | R4-CLEANUP |
| `src/test/setup.ts` | none | none (R2-SHELL stubs `window.electron` inside `App.test.tsx`) | R3-FOUNDATION | R4-CLEANUP |
| `src/components/ui/**` | R1-FOUNDATION | R2-FOUNDATION | R3-FOUNDATION | R4-CLEANUP |
| `src/lib/icons/**`, `src/lib/appearance/**`, `src/lib/terminalTheme.ts`, `src/index.css` | R1-FOUNDATION | R2-FOUNDATION | R3-FOUNDATION | R4-CLEANUP |
| `src/components/entries/iconRegistry.ts`, `entryIcons.ts`, `IconPicker.tsx`, `ColorPicker.tsx` | none | none | R3-ENTRIES | R4-CLEANUP |
| `src/styles/components/tabs.css`, `sash.css` | R1-FOUNDATION | R2-TABS | R3-FOUNDATION | R4-CLEANUP |
| the rest of `src/styles/**` | R1-FOUNDATION | R2-FOUNDATION | R3-FOUNDATION | R4-CLEANUP |
| `src/components/layout/PaneTabBar.tsx`, `Pane.tsx`, `PaneContent.tsx`, `LayoutRenderer.tsx`, `DropZoneOverlay.tsx` | none | R2-TABS | R3-FOUNDATION | R4-CLEANUP |
| `src/components/layout/Sidebar.tsx`, `SidebarPanel.tsx`, `SidebarWindowControls.tsx`, `VaultContextBar.tsx`, `TeamInvitationBanner.tsx` | none | R2-SIDEBAR | R3-FOUNDATION | R4-CLEANUP |
| `src/components/entries/EntryTree.tsx` | none | R2-SIDEBAR | R3-ENTRIES | R4-CLEANUP |
| `src/components/vault/VaultSwitcherMenu.tsx`, `CloudSyncIndicator.tsx` | none | R2-SIDEBAR | R3-VAULT | R4-CLEANUP |
| `src/components/vault/TeamSyncIndicator.tsx` | none | R2-SIDEBAR | R3-TEAM | R4-CLEANUP |
| `src/components/sync/PersonalSyncIndicator.tsx`, `ConflictDot.tsx` | none | R2-SIDEBAR | R3-SYNC | R4-CLEANUP |
| `src/components/sync/SyncBanner.tsx`, `SyncBanners.tsx` | none | R2-SHELL | R3-SYNC | R4-CLEANUP |
| `src/components/common/StartupStatus.tsx` | none | R2-SHELL | R3-MISC | R4-CLEANUP |
| `src/components/ai/ChatPanel.tsx` | none | R2-AI (header) | R3-AI (body) | R4-CLEANUP |
| `src/components/sessions/web/*`, `DocumentView.tsx`, `CommandView.tsx` | none | R2-TABS | R3-SESSIONS | R4-CLEANUP |
| `src/components/settings/SettingsDialog.tsx`, `SettingsHelpers.tsx`, `tabs/AppearanceTab.tsx` | R1-FOUNDATION | none | R3-SETTINGS | R4-CLEANUP |
| `src/components/overlay/OverlayApp.tsx` | R1-FOUNDATION | none | R3-OVERLAY | R4-CLEANUP |
| `src/utils/contextMenu.ts` | R1-MENUS | R2-FOUNDATION | R3-FOUNDATION | R4-CLEANUP |
| `electron/ipc/menu.ts`, `menu-svg.ts` | R1-MENUS | R2-FOUNDATION | R3-FOUNDATION | none |
| `electron/main.ts`, `electron/ipc/settings.ts`, `electron/services/appearance-*.ts` | R1-FOUNDATION | R2-FOUNDATION | R3-FOUNDATION | none |
| `scripts/verify/**` (with `fixtures/restyle/allowed-deltas.json`) | R1-HARNESS | R2-FOUNDATION | R3-FOUNDATION | R4-HARNESS |
| `scripts/__tests__/check-owns.test.ts` | R1-HARNESS | R2-FOUNDATION | R3-FOUNDATION | none |
| `scripts/__tests__/legacy-classes.test.ts` | none | R2-FOUNDATION | R3-FOUNDATION | R4-CLEANUP |
| `scripts/redesign/**` | none (`work-packages.json` lands with this spec) | R2-FOUNDATION | R3-FOUNDATION | R4-CLEANUP |
| `package.json`, `package-lock.json` | R1-FOUNDATION | R2-FOUNDATION | R3-FOUNDATION | none |
| `docs/VISUAL_REDESIGN.md` | standalone spec commits (rule 4) | standalone spec commits | standalone spec commits | R4-DOCS |

---

## Appendix A. Icon mappings

The 116 semantic names (5.1) in each of the six packs. "exact" is a glyph with the same meaning; "substitute" the closest stand-in; "fill" the outline glyph rendered with `fill="currentColor"` (or the pack's filled glyph); "shared dot" the 8px state dot of 5.4, identical in every pack. Picker order (5.8) is Lucide, Phosphor, Hugeicons, Material Symbols, Fluent, Tabler (Classic); the tables are grouped by source.

### A.1 Lucide (default, bundled)

Source `lucide-react@1.48.0` (ISC) [V: every export below is imported by `src/lib/icons/packs/lucide.ts` on `41d9657`, which type-checks]. Rendered with `strokeWidth={1.5}` through `wrapLucide`. "fill" renders the outline glyph with `fill="currentColor"`. "shared dot" is the 8px state dot of 5.4.

| # | Semantic | `lucide-react` export | Status |
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
| 66 | `starFilled` | `Star` | fill |
| 67 | `pin` | `Pin` | exact |
| 68 | `pinFilled` | `Pin` | fill |
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
| 89 | `playerStopFilled` | `Square` | fill |
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
| 113 | `splitHorizontal` | `Columns2` | exact |
| 114 | `splitVertical` | `Rows2` | exact |
| 115 | `ellipsis` | `Ellipsis` | exact |
| 116 | `circleFilled` | shared dot | shared dot (was `Circle` filled) |

### A.2 Hugeicons (new)

Source `@hugeicons/core-free-icons@4.3.5` (MIT, free "Stroke Rounded" set, 24px grid). Each glyph is imported from its own subpath (`@hugeicons/core-free-icons/<Export>`) and rendered by `wrapHugeicon` (5.2). [V: all 115 exports exist in the 4.3.5 tarball, none is marked `@deprecated`, and every element and attribute they use (`path`, `circle`, `ellipse`; `d`, `stroke`, `stroke-linecap`, `stroke-linejoin`, `stroke-width`, `cx`, `cy`, `r`, `rx`, `ry`, `transform`, `fill-rule`, `clip-rule`) is on the popup menu sanitizer allowlist (7.1).]

| # | Semantic | `@hugeicons/core-free-icons` export | Status |
|---|---|---|---|
| 1 | `close` | `Cancel01Icon` | exact |
| 2 | `plus` | `Add01Icon` | exact |
| 3 | `check` | `Tick02Icon` | exact |
| 4 | `search` | `Search01Icon` | exact |
| 5 | `trash` | `Delete02Icon` | exact |
| 6 | `pencil` | `PencilEdit02Icon` | exact |
| 7 | `copy` | `Copy01Icon` | exact |
| 8 | `refresh` | `Refresh01Icon` | exact |
| 9 | `send` | `SentIcon` | exact |
| 10 | `download` | `Download04Icon` | exact |
| 11 | `upload` | `Upload04Icon` | exact |
| 12 | `externalLink` | `LinkSquare02Icon` | exact |
| 13 | `login` | `Login03Icon` | exact |
| 14 | `logout` | `Logout03Icon` | exact |
| 15 | `restore` | `RotateLeft01Icon` | exact |
| 16 | `settings` | `Settings02Icon` | exact |
| 17 | `eye` | `ViewIcon` | exact |
| 18 | `eyeOff` | `ViewOffSlashIcon` | exact |
| 19 | `home` | `Home01Icon` | exact |
| 20 | `arrowLeft` | `ArrowLeft02Icon` | exact |
| 21 | `arrowRight` | `ArrowRight02Icon` | exact |
| 22 | `arrowUp` | `ArrowUp02Icon` | exact |
| 23 | `arrowsExchange` | `ArrowDataTransferHorizontalIcon` | exact |
| 24 | `chevronDown` | `ArrowDown01Icon` | exact |
| 25 | `chevronLeft` | `ArrowLeft01Icon` | exact |
| 26 | `chevronRight` | `ArrowRight01Icon` | exact |
| 27 | `alertCircle` | `AlertCircleIcon` | exact |
| 28 | `alertTriangle` | `Alert02Icon` | exact |
| 29 | `infoCircle` | `InformationCircleIcon` | exact |
| 30 | `circleCheck` | `CheckmarkCircle02Icon` | exact |
| 31 | `circleX` | `CancelCircleIcon` | exact |
| 32 | `ban` | `UnavailableIcon` | exact |
| 33 | `loader` | `Loading03Icon` | exact |
| 34 | `wifiOff` | `WifiOff01Icon` | exact |
| 35 | `lock` | `SquareLock02Icon` | exact |
| 36 | `lockOpen` | `SquareUnlock02Icon` | exact |
| 37 | `key` | `Key01Icon` | exact |
| 38 | `shield` | `Shield01Icon` | exact |
| 39 | `shieldCheck` | `SecurityCheckIcon` | exact |
| 40 | `shieldLock` | `SecurityLockIcon` | exact |
| 41 | `fingerprint` | `FingerPrintIcon` | exact |
| 42 | `file` | `File01Icon` | exact |
| 43 | `fileCode` | `FileScriptIcon` | exact |
| 44 | `fileImport` | `FileImportIcon` | exact |
| 45 | `filePlus` | `FileAddIcon` | exact |
| 46 | `fileText` | `FileTextIcon` | exact |
| 47 | `fileX` | `FileRemoveIcon` | exact |
| 48 | `folder` | `Folder01Icon` | exact |
| 49 | `folderOpen` | `FolderOpenIcon` | exact |
| 50 | `folderPlus` | `FolderAddIcon` | exact |
| 51 | `user` | `UserIcon` | exact |
| 52 | `users` | `UserMultipleIcon` | exact |
| 53 | `crown` | `CrownIcon` | exact |
| 54 | `terminal` | `CommandLineIcon` | exact |
| 55 | `terminalAlt` | `TerminalIcon` | exact |
| 56 | `desktop` | `ComputerIcon` | exact |
| 57 | `globe` | `GlobalIcon` | exact |
| 58 | `globeWww` | `InternetIcon` | substitute |
| 59 | `server` | `ServerStack01Icon` | exact |
| 60 | `serverAlt` | `ServerStack02Icon` | exact |
| 61 | `devices` | `ComputerPhoneSyncIcon` | substitute |
| 62 | `network` | `NetworkIcon` | exact |
| 63 | `plug` | `Plug01Icon` | exact |
| 64 | `plugDisconnected` | `UnplugIcon` | exact |
| 65 | `star` | `StarIcon` | exact |
| 66 | `starFilled` | `StarIcon` | fill |
| 67 | `pin` | `PinIcon` | exact |
| 68 | `pinFilled` | `PinIcon` | fill |
| 69 | `database` | `Database01Icon` | exact |
| 70 | `history` | `HistoryIcon` | exact |
| 71 | `calendar` | `Calendar03Icon` | exact |
| 72 | `clock` | `Clock01Icon` | exact |
| 73 | `tag` | `Tag01Icon` | exact |
| 74 | `notes` | `Note01Icon` | exact |
| 75 | `mail` | `Mail01Icon` | exact |
| 76 | `message` | `Message01Icon` | exact |
| 77 | `messageChatbot` | `AiChat02Icon` | exact |
| 78 | `cloud` | `CloudIcon` | exact |
| 79 | `cloudOff` | `CloudOffIcon` | exact |
| 80 | `cloudDownload` | `CloudDownloadIcon` | exact |
| 81 | `robot` | `RoboticIcon` | exact |
| 82 | `sparkles` | `SparklesIcon` | exact |
| 83 | `tool` | `Wrench01Icon` | exact |
| 84 | `stack` | `Layers01Icon` | exact |
| 85 | `bolt` | `FlashIcon` | exact |
| 86 | `rocket` | `Rocket01Icon` | exact |
| 87 | `playerPlay` | `PlayIcon` | exact |
| 88 | `playerStop` | `StopIcon` | exact |
| 89 | `playerStopFilled` | `StopIcon` | fill |
| 90 | `playerSkipForward` | `NextIcon` | exact |
| 91 | `keyboard` | `KeyboardIcon` | exact |
| 92 | `qrcode` | `QrCodeIcon` | exact |
| 93 | `target` | `Target02Icon` | exact |
| 94 | `palette` | `PaintBoardIcon` | exact |
| 95 | `icons` | `ShapesIcon` | exact |
| 96 | `photo` | `Image01Icon` | exact |
| 97 | `deviceMobile` | `SmartPhone01Icon` | exact |
| 98 | `hammer` | `HammerIcon` | exact |
| 99 | `bug` | `Bug01Icon` | exact |
| 100 | `floppy` | `FloppyDiskIcon` | exact |
| 101 | `bold` | `TextBoldIcon` | exact |
| 102 | `italic` | `TextItalicIcon` | exact |
| 103 | `strikethrough` | `TextStrikethroughIcon` | exact |
| 104 | `heading1` | `Heading01Icon` | exact |
| 105 | `heading2` | `Heading02Icon` | exact |
| 106 | `link` | `Link01Icon` | exact |
| 107 | `code` | `SourceCodeIcon` | exact |
| 108 | `list` | `LeftToRightListBulletIcon` | exact |
| 109 | `listNumbers` | `LeftToRightListNumberIcon` | exact |
| 110 | `table` | `Table01Icon` | exact |
| 111 | `quote` | `QuoteDownIcon` | exact |
| 112 | `menu` | `Menu01Icon` | exact |
| 113 | `splitHorizontal` | `Layout2ColumnIcon` | exact |
| 114 | `splitVertical` | `Layout2RowIcon` | exact |
| 115 | `ellipsis` | `MoreHorizontalIcon` | exact |
| 116 | `circleFilled` | shared dot | shared dot |

### A.3 Material Symbols (Light)

Source `@iconify-json/material-symbols-light@1.2.94` (Apache-2.0), through the codegen (5.3). Outline rounded glyphs; "fill" rows use the filled rounded glyph. The adapter trims 1.35 viewBox units per side (5.4, salvage of `47a782a`).

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
| 113 | `splitHorizontal` | `splitscreen-right-outline-rounded` | exact |
| 114 | `splitVertical` | `splitscreen-bottom-outline-rounded` | exact |
| 115 | `ellipsis` | `more-horiz-outline-rounded` | exact |
| 116 | `circleFilled` | shared dot (no codegen row) | shared dot |

### A.4 Phosphor, Fluent and Tabler (Classic)

Today's mappings from `packs/phosphor.ts`, `packs/fluent.ts` and `packs/tabler.ts` on `41d9657` [V read], minus the seven retired names, with `circleFilled` moved to the shared dot. Phosphor entries marked "(fill)" use `weight="fill"`.

| # | Semantic | Phosphor (`@phosphor-icons/react`) | Fluent (`@fluentui/react-icons`) | Tabler (`@tabler/icons-react`) |
|---|---|---|---|---|
| 1 | `close` | `X` | `DismissRegular` | `IconX` |
| 2 | `plus` | `Plus` | `AddRegular` | `IconPlus` |
| 3 | `check` | `Check` | `CheckmarkRegular` | `IconCheck` |
| 4 | `search` | `MagnifyingGlass` | `SearchRegular` | `IconSearch` |
| 5 | `trash` | `Trash` | `DeleteRegular` | `IconTrash` |
| 6 | `pencil` | `PencilSimple` | `EditRegular` | `IconPencil` |
| 7 | `copy` | `Copy` | `CopyRegular` | `IconCopy` |
| 8 | `refresh` | `ArrowsClockwise` | `ArrowSyncRegular` | `IconRefresh` |
| 9 | `send` | `PaperPlaneRight` | `SendRegular` | `IconSend` |
| 10 | `download` | `DownloadSimple` | `ArrowDownloadRegular` | `IconDownload` |
| 11 | `upload` | `UploadSimple` | `ArrowUploadRegular` | `IconUpload` |
| 12 | `externalLink` | `ArrowSquareOut` | `OpenRegular` | `IconExternalLink` |
| 13 | `login` | `SignIn` | `PersonArrowRightRegular` | `IconLogin` |
| 14 | `logout` | `SignOut` | `PersonArrowLeftRegular` | `IconLogout` |
| 15 | `restore` | `ClockCounterClockwise` | `HistoryRegular` | `IconRestore` |
| 16 | `settings` | `Gear` | `SettingsRegular` | `IconSettings` |
| 17 | `eye` | `Eye` | `EyeRegular` | `IconEye` |
| 18 | `eyeOff` | `EyeSlash` | `EyeOffRegular` | `IconEyeOff` |
| 19 | `home` | `House` | `HomeRegular` | `IconHome` |
| 20 | `arrowLeft` | `ArrowLeft` | `ArrowLeftRegular` | `IconArrowLeft` |
| 21 | `arrowRight` | `ArrowRight` | `ArrowRightRegular` | `IconArrowRight` |
| 22 | `arrowUp` | `ArrowUp` | `ArrowUpRegular` | `IconArrowUp` |
| 23 | `arrowsExchange` | `ArrowsLeftRight` | `ArrowSwapRegular` | `IconArrowsExchange` |
| 24 | `chevronDown` | `CaretDown` | `ChevronDownRegular` | `IconChevronDown` |
| 25 | `chevronLeft` | `CaretLeft` | `ChevronLeftRegular` | `IconChevronLeft` |
| 26 | `chevronRight` | `CaretRight` | `ChevronRightRegular` | `IconChevronRight` |
| 27 | `alertCircle` | `WarningCircle` | `ErrorCircleRegular` | `IconAlertCircle` |
| 28 | `alertTriangle` | `Warning` | `WarningRegular` | `IconAlertTriangle` |
| 29 | `infoCircle` | `Info` | `InfoRegular` | `IconInfoCircle` |
| 30 | `circleCheck` | `CheckCircle` | `CheckmarkCircleRegular` | `IconCircleCheck` |
| 31 | `circleX` | `XCircle` | `DismissCircleRegular` | `IconCircleX` |
| 32 | `ban` | `Prohibit` | `ProhibitedRegular` | `IconBan` |
| 33 | `loader` | `SpinnerGap` | `SpinnerIosRegular` | `IconLoader2` |
| 34 | `wifiOff` | `WifiSlash` | `WifiOffRegular` | `IconWifiOff` |
| 35 | `lock` | `Lock` | `LockClosedRegular` | `IconLock` |
| 36 | `lockOpen` | `LockOpen` | `LockOpenRegular` | `IconLockOpen` |
| 37 | `key` | `Key` | `KeyRegular` | `IconKey` |
| 38 | `shield` | `Shield` | `ShieldRegular` | `IconShield` |
| 39 | `shieldCheck` | `ShieldCheck` | `ShieldCheckmarkRegular` | `IconShieldCheck` |
| 40 | `shieldLock` | `ShieldWarning` | `ShieldLockRegular` | `IconShieldLock` |
| 41 | `fingerprint` | `Fingerprint` | `FingerprintRegular` | `IconFingerprint` |
| 42 | `file` | `File` | `DocumentRegular` | `IconFile` |
| 43 | `fileCode` | `FileCode` | `DocumentCode16Regular` | `IconFileCode` |
| 44 | `fileImport` | `FileArrowDown` | `DocumentArrowDownRegular` | `IconFileImport` |
| 45 | `filePlus` | `FilePlus` | `DocumentAddRegular` | `IconFilePlus` |
| 46 | `fileText` | `FileText` | `DocumentTextRegular` | `IconFileText` |
| 47 | `fileX` | `FileX` | `DocumentDismissRegular` | `IconFileX` |
| 48 | `folder` | `Folder` | `FolderRegular` | `IconFolder` |
| 49 | `folderOpen` | `FolderOpen` | `FolderOpenRegular` | `IconFolderOpen` |
| 50 | `folderPlus` | `FolderPlus` | `FolderAddRegular` | `IconFolderPlus` |
| 51 | `user` | `User` | `PersonRegular` | `IconUser` |
| 52 | `users` | `Users` | `PeopleRegular` | `IconUsers` |
| 53 | `crown` | `Crown` | `CrownIcon` | `IconCrown` |
| 54 | `terminal` | `TerminalWindow` | `WindowConsoleRegular` | `IconTerminal2` |
| 55 | `terminalAlt` | `Terminal` | `WindowConsoleRegular` | `IconTerminal` |
| 56 | `desktop` | `Desktop` | `DesktopRegular` | `IconDeviceDesktop` |
| 57 | `globe` | `Globe` | `GlobeRegular` | `IconWorld` |
| 58 | `globeWww` | `GlobeSimple` | `GlobeRegular` | `IconWorldWww` |
| 59 | `server` | `HardDrive` | `ServerRegular` | `IconServer` |
| 60 | `serverAlt` | `HardDrives` | `ServerRegular` | `IconServer2` |
| 61 | `devices` | `DeviceMobile` | `PhoneDesktopRegular` | `IconDevices` |
| 62 | `network` | `TreeStructure` | `BranchRegular` | `IconNetwork` |
| 63 | `plug` | `Plug` | `PlugConnectedRegular` | `IconPlug` |
| 64 | `plugDisconnected` | `PlugsConnected` | `PlugDisconnectedRegular` | `IconPlugConnectedX` |
| 65 | `star` | `Star` | `StarRegular` | `IconStar` |
| 66 | `starFilled` | `Star` (fill) | `StarFilled` | `IconStarFilled` |
| 67 | `pin` | `PushPin` | `PinRegular` | `IconPin` |
| 68 | `pinFilled` | `PushPin` (fill) | `PinFilled` | `IconPinFilled` |
| 69 | `database` | `Database` | `DatabaseRegular` | `IconDatabase` |
| 70 | `history` | `ClockClockwise` | `HistoryRegular` | `IconHistory` |
| 71 | `calendar` | `Calendar` | `CalendarRegular` | `IconCalendar` |
| 72 | `clock` | `Clock` | `ClockRegular` | `IconClock` |
| 73 | `tag` | `Tag` | `TagRegular` | `IconTag` |
| 74 | `notes` | `Notepad` | `NoteRegular` | `IconNotes` |
| 75 | `mail` | `Envelope` | `MailRegular` | `IconMail` |
| 76 | `message` | `ChatCircle` | `ChatRegular` | `IconMessage` |
| 77 | `messageChatbot` | `ChatCircleDots` | `ChatMultipleRegular` | `IconMessageChatbot` |
| 78 | `cloud` | `Cloud` | `CloudRegular` | `IconCloud` |
| 79 | `cloudOff` | `CloudSlash` | `CloudOffRegular` | `IconCloudOff` |
| 80 | `cloudDownload` | `CloudArrowDown` | `CloudArrowDownRegular` | `IconCloudDownload` |
| 81 | `robot` | `Robot` | `BotRegular` | `IconRobot` |
| 82 | `sparkles` | `Sparkle` | `SparkleRegular` | `IconSparkles` |
| 83 | `tool` | `Wrench` | `WrenchRegular` | `IconTool` |
| 84 | `stack` | `Stack` | `StackRegular` | `IconStack2` |
| 85 | `bolt` | `Lightning` | `FlashRegular` | `IconBolt` |
| 86 | `rocket` | `Rocket` | `RocketRegular` | `IconRocket` |
| 87 | `playerPlay` | `Play` | `PlayRegular` | `IconPlayerPlay` |
| 88 | `playerStop` | `Stop` | `StopRegular` | `IconPlayerStop` |
| 89 | `playerStopFilled` | `Stop` (fill) | `StopFilled` | `IconPlayerStopFilled` |
| 90 | `playerSkipForward` | `SkipForward` | `NextRegular` | `IconPlayerSkipForward` |
| 91 | `keyboard` | `Keyboard` | `KeyboardRegular` | `IconKeyboard` |
| 92 | `qrcode` | `QrCode` | `QrCodeRegular` | `IconQrcode` |
| 93 | `target` | `Crosshair` | `TargetRegular` | `IconTarget` |
| 94 | `palette` | `Palette` | `ColorRegular` | `IconPalette` |
| 95 | `icons` | `GridFour` | `GridRegular` | `IconIcons` |
| 96 | `photo` | `Image` | `ImageRegular` | `IconPhoto` |
| 97 | `deviceMobile` | `DeviceMobile` | `PhoneRegular` | `IconDeviceMobile` |
| 98 | `hammer` | `Hammer` | `WrenchScrewdriverRegular` | `IconHammer` |
| 99 | `bug` | `Bug` | `BugRegular` | `IconBug` |
| 100 | `floppy` | `FloppyDisk` | `SaveRegular` | `IconDeviceFloppy` |
| 101 | `bold` | `TextB` | `TextBoldRegular` | `IconBold` |
| 102 | `italic` | `TextItalic` | `TextItalicRegular` | `IconItalic` |
| 103 | `strikethrough` | `TextStrikethrough` | `TextStrikethroughRegular` | `IconStrikethrough` |
| 104 | `heading1` | `TextHOne` | `TextHeader1Regular` | `IconH1` |
| 105 | `heading2` | `TextHTwo` | `TextHeader2Regular` | `IconH2` |
| 106 | `link` | `Link` | `LinkRegular` | `IconLink` |
| 107 | `code` | `Code` | `CodeRegular` | `IconCode` |
| 108 | `list` | `ListBullets` | `TextBulletListRegular` | `IconList` |
| 109 | `listNumbers` | `ListNumbers` | `TextNumberListLtrRegular` | `IconListNumbers` |
| 110 | `table` | `Table` | `TableRegular` | `IconTable` |
| 111 | `quote` | `Quotes` | `TextQuoteRegular` | `IconQuote` |
| 112 | `menu` | `List` | `NavigationRegular` | `IconMenu2` |
| 113 | `splitHorizontal` | `SquareSplitHorizontal` | `SplitVerticalRegular` | `IconLayoutColumns` |
| 114 | `splitVertical` | `SquareSplitVertical` | `SplitHorizontalRegular` | `IconLayoutRows` |
| 115 | `ellipsis` | `DotsThree` | `MoreHorizontalRegular` | `IconDots` |
| 116 | `circleFilled` | shared dot | shared dot | shared dot |

---

## Appendix B. Harness hook contract

"Union (wave 1)" lists the two alternatives `pickSelector` chooses between (the hook if any element in the scope carries it, else the legacy selector); they are never joined into one comma list. "Final" is what R4-HARNESS keeps. "Hook added by" is the package that owns the markup when the hook lands. `ROOT` is `[data-cv-settings]`. Harness paths are under `scripts/verify/`.

| # | Harness use | Today | Markup today | Hook added by | Union (wave 1) | Final (wave 4) |
|---|---|---|---|---|---|---|
| B1 | Settings root (`lib/settings-flows.mjs`) | finds `[data-dialog-content]` whose `h2` is `Settings` and marks it | `SettingsDialog.tsx` | `data-cv-settings` on the panel (R3-SETTINGS) | the mark function returns early when `[data-cv-settings]` exists | `[data-cv-settings]` |
| B2 | Settings nav | `ROOT .w-52 button` | `SettingsNav.tsx` | `data-cv-settings-nav` (R3-SETTINGS; `w-52` stays until wave 4) | `ROOT .w-52 button`, `ROOT [data-cv-settings-nav] button` | `ROOT [data-cv-settings-nav] button` |
| B3 | Save and Cancel | `ROOT > div:last-child button` | `SettingsDialog.tsx` | `data-cv-dialog-footer` (the `Dialog` primitive, used by R3-SETTINGS) | `ROOT > div:last-child button`, `ROOT [data-cv-dialog-footer] button` | `ROOT [data-cv-dialog-footer] button` |
| B4 | Sync tab status | `.bg-well.border`, `p.font-medium`, `p.text-xs` | `SyncTab.tsx` | `data-cv-sync-status`, `data-cv-sync-status-label`, `data-cv-sync-status-detail` (R3-SETTINGS) | hook, else legacy | hooks |
| B5 | Devices | `.divide-y > div`, `p.text-sm`, `p.text-xs` | `SyncDevicesList.tsx` | `data-cv-device-row`, `data-cv-device-name`, `data-cv-device-line` (R3-SYNC) | hook, else legacy | hooks |
| B6 | Sync notices | `.bg-amber-500\/10` | `SyncNoticeList.tsx` | `data-cv-sync-notice` (R3-SYNC) | hook, else legacy | hook |
| B7 | Paused note | `p.text-amber-400` | `SyncTab.tsx` | `data-cv-sync-paused` (R3-SETTINGS) | hook, else legacy | hook |
| B8 | Inline errors | `[data-dialog-content] .text-red-400`, `p.text-red-400` | `UnlockDialog`, `ChangePasswordDialog`, `InlineError` | `data-cv-error` (primitives; applied by R3-VAULT and R3-SYNC) | hook, else legacy | `[data-dialog-content] [data-cv-error]` |
| B9 | Sync dialogs | `[role=dialog]` | `SyncDialogFrame`, `ConflictReviewPanel` | `Dialog harnessLabel` (R3-SYNC) | `[role=dialog][aria-label]` (8.3) | same |
| B10 | Scoped sync clicks | `[role=dialog] button` | sync dialogs | none | `[role=dialog][aria-label] button` | same |
| B11 | Review rows | `button.closest('.rounded-md')`, `span`, `.font-mono` | `ConflictFieldRow.tsx`, `ConflictItemView.tsx` | `data-cv-review-field`, `data-cv-review-field-label`, `data-cv-review-value` (R3-SYNC) | hook, else legacy | hooks |
| B12 | Close review | `button[aria-label="Close"]` | `ConflictReviewPanel.tsx` | the `Dialog` close keeps `aria-label="Close"` | unchanged | unchanged |
| B13 | Open review | `button[title="Review changes from your other devices"]` | `PersonalSyncIndicator.tsx` (side bar footer) | `title` kept + `data-cv-review-button` (R2-SIDEBAR) | hook, else legacy | hook |
| B14 | Review banner | page text `/need(s)? review/`, then the button `Review` | `SyncBanner` | none; text and `Review` kept (R2-SHELL) | unchanged | unchanged |
| B15 | Banners | `[role=status]`, `span.flex-1`, `button` | `SyncBanner.tsx` | `role="status"` and `span.flex-1` kept, `data-cv-banner-text` added (R2-SHELL through `Banner`) | hook, else `span.flex-1` | `[data-cv-banner-text]` |
| B16 | Open the side bar | `button[title="Open sidebar (Ctrl+B)"]`, then wait for `button[title="Close sidebar (Ctrl+B)"]` | the pane tab bar hamburger, `SidebarWindowControls.tsx` | `data-cv-sidebar-toggle` + `aria-expanded` on the hamburger, titles kept (R2-TABS); `data-sidebar-panel` exists | `[data-cv-sidebar-toggle][aria-expanded="false"]` else the old title; wait for `[data-sidebar-panel]` else the old close title | hooks |
| B17 | Vault menu | `clickText(vaultName, {selector: 'button[title]'})` | `Sidebar.tsx` vault switcher | `data-cv-vault-switcher` (R2-SIDEBAR) | hook, else `button[title]` | `[data-cv-vault-switcher]` |
| B18 | Recently deleted rows | `.max-h-80 label`, `p.text-sm`, `p.text-xs` | `RecentlyDeletedPanel.tsx` | `data-cv-deleted-list`, `data-cv-row-title`, `data-cv-row-detail` (R3-SYNC) | hook, else legacy | hooks |
| B19 | Stacked confirm | `.z-\[70\] [data-dialog-content] button` | `RecentlyDeletedPanel.tsx` + `ConfirmDialog` | `data-cv-layer="stacked"` (primitive; applied by R3-SYNC) | hook, else legacy | hook |
| B20 | Other copies | `.border-b` rows, `p.text-sm` (+ `title`), `p.text-xs`, `.flex.items-start` | `OtherCopiesPanel.tsx` | `data-cv-copy-row`, `data-cv-row-title`, `data-cv-row-detail` (R3-SYNC) | hook, else legacy | hooks |
| B21 | Mass change | `label span.text-ink` | `MassChangeNotice.tsx` | `data-cv-row-title` (R3-SYNC) | hook, else legacy | hook |
| B22 | Backup toggles | label → `.closest('.justify-between')` → `:scope > button` | `BackupTab.tsx` | `data-cv-toggle-row` (R3-SETTINGS) | hook, else legacy | hook |
| B23 | Backup files | `.border-b` rows, `span.block`, `span.text-\[10px\]` | `BackupTab.tsx` | `data-cv-backup-row`, `data-cv-backup-name`, `data-cv-backup-meta` (R3-SETTINGS) | hook, else legacy | hooks |
| B24 | Cloud backup | `label` → `.closest('.space-y-3')` | `BackupTab.tsx` | `data-cv-cloud-backup-section` (R3-SETTINGS) | hook, else legacy | hook |
| B25 | Backup Manager | `[data-dialog-content]` with `h2` `Backup Manager` | `BackupManagerDialog` | `data-cv-backup-manager` (R3-VAULT) | the mark function returns early when the hook exists | hook |
| B26 | Recent vaults | `button[title$=".conduit"]`, `button[title="{path}"]` | `VaultHub` rows | `title` = path kept (R3-VAULT) | unchanged | unchanged |
| B27 | Screen detection | body text `Loading...`, hub text, auth text | `App.tsx`, `VaultHub`, `AuthScreen` | texts kept (R2-SHELL, R3-VAULT, R3-AUTH-ONBOARDING) | unchanged | unchanged |
| B28 | Idle lock | `select[aria-label="Lock the vault when idle"]` | `IdleLockSetting.tsx` | `Select` keeps the `aria-label` (R3-SYNC) | unchanged | unchanged |
| B29 | Labeled fields, checkboxes | `label` + first `span` + inner control; `label` + checkbox | fields and checkbox rows | `FormField` and `Checkbox` structure (primitives) | unchanged | unchanged |
| B30 | Password and name inputs | `input[placeholder=…]`: `Enter master password`, `Confirm master password`, `Enter new vault name`, `Enter current password`, `Enter new password`, `Confirm new password`, `Master password` | vault dialogs | placeholders kept (R3-VAULT, R3-SETTINGS) | unchanged | unchanged |
| B31 | Form submit | `[data-dialog-content] form button[type=submit]` | form dialogs | `Dialog onSubmit` wraps header, body and footer (R3 packages) | unchanged | unchanged |
| B32 | App menu | `Menu.getApplicationMenu()` labels | `main.ts` | unchanged | unchanged | unchanged |
| B33 | Toasts | the overlay window page; `overlay:action-clicked` | `overlay-manager.ts` | unchanged | unchanged | unchanged |
| B34 | Unscoped exact labels | `button` with text `Review`, `Use here instead`, `Lock Current Vault`, `New Vault`, `Not Now`, `Open Vault File` | dialogs, banners, the hub, the vault menu | the text rules (8.4) | unchanged | unchanged |
| B35 | Busy texts | `Opening...`, `Please wait...`, `Checking...`, `Loading...`, `Looking for copies...`, `Comparing...` | sync and vault dialogs | visible text through `Button loadingLabel` and `Spinner text` (R3-SYNC, R3-VAULT) | unchanged | unchanged |
| B36 | Sync plan line | the first `<p>` starting `Your plan:` | `SyncTab.tsx` | `data-cv-sync-plan` (R3-SETTINGS) | hook, else legacy | hook |
| B37 | Sync tab ready | an `h3` `Multi-device sync` | `SyncTab.tsx` | `SectionHeader` keeps the `h3` (R3-SETTINGS) | unchanged | unchanged |
| B38 | Sync notice text | the notice's first `p` | `SyncNoticeList.tsx` | `data-cv-sync-notice-text` (R3-SYNC) | hook, else `p` | hook |
| B39 | Backup toggle markup | `<label>` `Local Backup` / `Cloud Backup` with the toggle as a direct child | `BackupTab.tsx` | the label stays, the `Switch` stays a direct child, `data-cv-toggle` (R3-SETTINGS) | hook, else `:scope > button` | hook |
| B40 | Backup files list | the `Backup Files (N)` label's parent | `BackupTab.tsx` | `data-cv-backup-files` (R3-SETTINGS) | hook, else the parent | hook |
| B41 | Cloud backup badge | the first `span` of the label's parent | `BackupTab.tsx` | `data-cv-cloud-backup-badge` (R3-SETTINGS) | hook, else that `span` | hook |
| B42 | Backup Manager controls | `Restore`, `Confirm`, `Close`, `input[placeholder="Master password"]` | `BackupManagerDialog` | kept (R3-VAULT) | unchanged | unchanged |
| B43 | Vault menu items | `button` with the text `Lock Current Vault` | `VaultSwitcherMenu.tsx` | rows stay `<button>` (R2-SIDEBAR, R3-VAULT) | unchanged | unchanged |
| B44 | Recent vault rows | `button[title="{path}"]` | `VaultHub` | clickable `ListRow` is a `<button>` with the path as `title` (R3-VAULT) | unchanged | unchanged |
| B45 | Visibility filter | clicks skip `visibility: hidden` and boxless elements | every clickable | hover-revealed parts (a `ListRow`'s `trailing`) hide with `opacity: 0` only; the tab close is always visible (D-3) | unchanged | unchanged |
| B46 | Radios | `label` with the exact option text containing a radio | sync dialogs | `Radio` renders `label > input[type=radio]` + text (R3-SYNC) | unchanged | unchanged |
| B47 | Review version line (`lib/sync-flows.mjs` `clickVersionInPage`, `suites/mcp.mjs` `pickVersionNotInUseInPage`) | `button.parentElement` of `Use this`, whose text must hold the value, or not hold `In use now` [V `sync-flows.mjs:139`, `mcp.mjs:227-231`] | `ConflictFieldRow.tsx:85-106` | `data-cv-review-version` on each version line (R3-SYNC); the harness half, `reviewVersion: pair('[data-cv-review-version]', '.items-start.gap-3')` read with `pickClosest` from the button, lands first (R1-HARNESS); the MCP suite scopes its panel to `[role=dialog][aria-label="Review changes"]` | hook, else the legacy line | hook |

Attributes other code relies on, kept: `data-dialog-content`, `data-tabbar`, `data-sidebar-panel`, `data-docked`, `data-content-area`, `data-context-menu`, `data-popover`, `data-toast`, `data-bare`, `data-session-keyboard`.

New restyle hooks (none uses `role=dialog` or `role=status`): `data-cv-accent-line`; `data-cv-tab`, `data-active`, `data-cv-new-tab`, `data-cv-ai-toggle`, `data-cv-sidebar-toggle`; `data-cv-session-area`; `data-cv-sidebar-header`, `data-cv-sidebar-search`, `data-cv-sidebar-footer`, `data-cv-vault-switcher`, `data-cv-review-button`; `data-cv-ai-header`, `data-cv-ai-divider`, `data-cv-ai-panel`; `data-cv-review-version` (B47); `data-cv-icon-pack` on `<html>` (5.6); `data-cv-startup-status`; `data-cv-banner-text`; the primitives' `data-cv-dialog-footer`, `data-cv-dialog-form`, `data-cv-layer`, `data-cv-error`, `data-cv-text-button`, `data-cv-choice`; `data-cv-appearance`; the B-table hooks. Hooks of the clone that must not appear: `data-cv-window`, `data-cv-titlebar`, `data-cv-command-center`, `data-cv-layout`, `data-cv-app-menu`, `data-cv-caption`, `data-cv-activitybar`, `data-cv-activity`, `data-cv-card`, `data-cv-editor-card`, `data-cv-statusbar`, `data-cv-status`.

---

## Appendix C. What's New entry

R4-DOCS adds these highlights to the pending release's entry in `release-notes/manifest.json`, the file the app fetches from `main` (`useReleaseNotes.ts`). User-facing text names no other product.

```json
{
  "title": "A Fresh Look",
  "summary": "Conduit gets a cleaner, more compact look and a choice of icon packs. Everything is still where you left it.",
  "highlights": [
    { "text": "**Refreshed tabs and controls**: the active tab joins its session, and buttons, fields, lists, menus and dialogs share one compact style.", "category": "improvement" },
    { "text": "**Modern color scheme**: a new neutral gray default in dark and light. Ocean, Ember, Forest, Amethyst, Rose and Midnight are still available.", "category": "feature" },
    { "text": "**Pick your icons**: choose Lucide (the new default), Phosphor, Hugeicons, Material Symbols, Fluent or the classic Tabler icons in Settings > Appearance.", "category": "feature" },
    { "text": "**Easier to read and use from the keyboard**: stronger text contrast in every color scheme and a visible focus ring on every control.", "category": "improvement" },
    { "text": "**Platform themes retired**: the macOS, Windows and Ubuntu themes give way to the new look. Your icon style carries over as an icon pack.", "category": "improvement" }
  ],
  "hasMedia": false
}
```

---

## History

- 2026-09-27: the redesign spec (a VS Code layout clone) was written and reviewed three times.
- 2026-09-28: its wave 1 landed on this branch (`41d9657`): tokens, schemes, primitives, the icon registry with Codicons as default, the freeze registry, harness hooks, the migration. Two reviews raised 19 issues, all fixed; their results are part of sections 2, 4 and 6 (among them: the checked `ChoiceCard`'s outside focus ring, the muted text re-scope on selected rows and checked cards, AA on wells and menus, `--c-focus` overrides in five schemes, `resolveCssColor` throwing for undeclared tokens, a newer `appearance_version` never written back as 2, Tab trapped in a modal through open popovers, popover freezes held until unmount, a hidden title for custom-layout dialogs).
- 2026-09-28: wave 2 of the clone was built on `redesign/w2-*` and `advenimus/visual-redesign`. The owner rejected it the same day; the quote is at the top of this document.
- 2026-09-28: this spec replaced it with the restyle. Salvaged: 9.2.
- 2026-09-28: an owner-intent review (16 issues) and a plan review (16 issues) of this spec; every issue was verified against the code and fixed (Review log).

---

## Review log

Restyle review, 2026-09-28. Each finding was checked against the code on `41d9657` before it changed the spec. "Adapted" means fixed differently from the reviewer's suggestion, for the reason given.

**Owner intent**

| # | Finding | Resolution |
|---|---|---|
| O1 | One `Dialog` primitive would change how dialogs close (Escape everywhere, a close button everywhere, no outside click) | Fixed: D-26, `closeOnEscape` and the optional `onClose` (4.8), the per-dialog table 3.12.1 with each R3 package's props and tests. Correction while verifying: `BiometricSetupPrompt` does close on Escape today (through `UnlockDialog`'s key handler) |
| O2 | Fixed-width tabs would scroll out of view in narrow panes | Fixed: tabs shrink to fit down to a 78px floor (D-2, 3.4, `--c-tab-min-w`), G10. Adapted: the twelve-tab check runs live in the `tabs` scenario, because jsdom has no layout |
| O3 | The owner would see nothing before the last package | Fixed: owner gates 1 to 3 (8.5, rule 8), recorded as acceptance lines of R1-MENUS, R2-SHELL and R4-CLEANUP; every R3 package waits for gate 2 |
| O4 | Inactive tabs would hide their close buttons | Fixed: close buttons always visible (D-3); VS Code's hover-only close is a gate-1 question, not adopted |
| O5 | The signed-in footer, cached mode, team vault and trial states were never checked | Fixed: shots and inventories 44 to 49, the `sidebar-signed-in` scenario (Supabase), R2-SIDEBAR unit tests |
| O6 | `ListRow` would hide always-visible hub badges and dashboard labels behind hover | Fixed: `meta` slot and self-sized `leading` (4.14), hub and dashboard rows (3.11), L-23 |
| O7 | Icon, color and model pickers would change shape or float | Fixed: restyled in place (3.16), removed from the `Menu` users (4.10) |
| O8 | Nothing proved all six packs work in every window | Fixed: `<html data-cv-icon-pack>` (5.6), the `packs` scenario with sheets and a restart check, R3-OVERLAY and R3-PICKER acceptance |
| O9 | Banner actions would become plain links | Fixed: `Button sm` actions, primary kept, offline banners centered (D-27, 3.8, 4.13) |
| O10 | The engine `●` and the AI toggle's `aria-pressed` would fail the inventory | Fixed: `●` kept as text (3.7); an added `pressed` is allowed like an added `aria` (8.6) |
| O11 | The vault switcher would shrink to 12px secondary text | Fixed: 13px `text-ink`, with a 12-character check at 250px (3.6) |
| O12 | The About licenses view is a new control | Fixed: dropped; the shipped license file meets the terms (5.9, 1.3) |
| O13 | Clone and VS Code wording stays in code, tests and the harness README | Fixed: 9.1 rows, one clone-selector module, greps in R1-FOUNDATION and R1-HARNESS acceptance |
| O14 | VS Code's exact accent on VS Code's grays reads as VS Code | Fixed: Modern takes Conduit's sky ramp with every gate re-computed (D-25, 2.2.2); the owner confirms at gate 1 |
| O15 | Custom entry icons stay Tabler next to Lucide | Fixed: 30 twins follow the pack, 35 stay Tabler, stored names unchanged (D-29, 5.11, R3-ENTRIES) |
| O16 | Removing the legacy freeze changes behavior in a look-only release | Fixed: the legacy hold stays; the overlay-freeze test is kept; removal is a follow-up (D-28, 4.9, 1.3) |

**Plan**

| # | Finding | Resolution |
|---|---|---|
| P1 | Geometry rules needed hooks that later packages add | Fixed: hook lists per rule, `pending` and `--strict`, a per-package rule table (8.6); G3, G6 and G8 scoped as suggested; the `+` and the AI toggle share the last `.cv-tabstrip-slot` |
| P2 | R4-CLEANUP could not pass `legacy-classes.test.ts` after deleting the dead files | Fixed: R4-CLEANUP owns the test and moves it to temporary fixtures (10.5) |
| P3 | R1-FOUNDATION's grep matched its own required tests | Fixed: tests and the harness's forbidden list excluded |
| P4 | Two live flows used `button.parentElement` in the review panel | Fixed: B47 `data-cv-review-version`, the harness half in R1-HARNESS, 8.4 rule 6 |
| P5 | The comparator would fail on the AI toggle and on timing text | Fixed: `pressed` allowed when added; `<ago>`, `<sync-state>` and `<vault-dir>` normalization (8.6) |
| P6 | The only allowed delta matched no real state of the Appearance tab | Fixed: the delta written as data, with the Icon pack section present if and only if its hook is; section labels stay `<label>` (6.4). Found while verifying: a `label`'s inventory text now leaves out nested controls, because `FormField` nests its control |
| P7 | No package owned the spec or the deltas file where the rules sent edits | Fixed: standalone spec commits outside packages; deltas through the file's owner with the integrator's sign-off (rules 4, 5); the spec lands with the JSON, R1-PLAN dropped (24 packages) |
| P8 | The reference PNGs lived only in the temporary scratchpad | Fixed: a lasting copy and a hash manifest; a missing file fails (8.6.1) |
| P9 | The `App.test.tsx` fix was underspecified | Fixed: a local `vi.stubGlobal` and rewritten assertions; `src/test/setup.ts` left alone and dropped from R2-SHELL's Owns |
| P10 | Harness-bound wave-3 packages ran no live suite | Fixed: targeted suites for R3-SETTINGS, R3-VAULT, R3-SYNC and R3-MISC (8.5) |
| P11 | R2-FOUNDATION closed before the checks that report to it; R4-DOCS could land after the final check | Fixed: rule 2; R4-CLEANUP depends on R4-DOCS |
| P12 | The migration text contradicted itself and missed cases | Fixed: 6.3 rules 2, 4 and 5, three new table rows, wider property tests |
| P13 | Nothing checked the plan's `wave` and `depends_on` | Fixed: R1-HARNESS extends `check-owns.test.ts` |
| P14 | The chunk-name check did not prove Lucide is static | Fixed: a build manifest check (R1-FOUNDATION acceptance) |
| P15 | Some acceptance commands could not run as written | Fixed: `--passWithNoTests` (rule 6); an exact R2-AI command, tried in zsh |
| P16 | The floating side bar's accent line and the `006661f` check had no owner | Fixed: R2-SIDEBAR owns the line; `006661f` is out of scope as its own change (1.3) |
