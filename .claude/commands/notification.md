Use the unified toast notification system for all user-facing notifications in Conduit.

## Rules

- **NEVER** create inline notification UI, custom alert components, or `window.alert()` calls
- **ALWAYS** call the `toast` API from `src/components/common/Toast.tsx`
- Never render a toast card yourself: toasts draw in the overlay window, not in the main window's DOM

## How it works

Toasts do not render in the window that raises them. They draw in a separate transparent overlay window, so they stay visible above native RDP, VNC and web session views.

1. `App.tsx` mounts `NotificationStack`, which renders `ToastController` (from `Toast.tsx`) and `UpdateNotificationBridge` (from `UpdateNotification.tsx`). Both are state-only and render nothing.
2. `ToastController` keeps the toast list (timers, the 5-toast cap, exit animations) and serializes it. Action callbacks stay in the main renderer in a map keyed `"<toastId>:<actionIndex>"`; only ids and labels cross IPC.
3. `NotificationStack` merges the toasts with the update state and sends `overlay:push-state`.
4. `OverlayManager` (`electron/services/overlay/overlay-manager.ts`) creates the overlay window on the first toast: frameless, transparent, not focusable, always on top, 400 × 500 DIP, 16px in from the bottom-right corner of the main window's content. It follows the main window's moves and resizes, and hides while the main window is minimized or unfocused.
5. The overlay page (`overlay.html`, `src/overlay.tsx`, `src/components/overlay/OverlayApp.tsx`) stacks the update notification and the toasts at the bottom (`p-4 gap-2`). `OverlayToast` and `OverlayUpdateNotification` both render the `ToastCard` primitive.
6. The overlay is click-through until the pointer is over an element with `data-toast`. Button clicks go back as `overlay:action-clicked` and `overlay:dismiss-toast` (and `overlay:update-action` for the update card); `ToastController` runs the callback and dismisses the toast.
7. The overlay follows the main window's scheme and dark or light mode through `localStorage` (the `storage` event), and its icons follow the active icon pack.

The credential picker window (`CredentialPickerApp.tsx`) mounts `ToastContainer`, an alias of `ToastController`, but nothing in that window sends its state to an overlay, so toasts raised in the picker window are not shown today.

## API Reference

```typescript
import { toast } from "./components/common/Toast";
// Types: ToastType, ToastAction, ToastOptions, ToastProgress are exported

// Basic: the second param is an optional message string
toast.success("Password copied");
toast.error("Connection failed", "Check your credentials");
toast.warning("Session disconnected");
toast.info("Processing complete");

// With action buttons: the second param is a ToastOptions object
toast.error("Entry limit reached", {
  message: "Upgrade your plan to add more connections",
  actions: [
    { label: "Upgrade", variant: "primary", onClick: () => openPricing() },
    { label: "Dismiss", variant: "default", onClick: () => {} },
  ],
});

// Persistent (no auto-dismiss, user must close or call dismiss)
const id = toast.info("Uploading...", { persistent: true });

// Programmatic dismiss
toast.dismiss(id);

// Update an existing toast in place (does NOT reset the auto-dismiss timer)
toast.update(id, {
  title: "Almost done...",
  message: "Processing final batch",
  progress: { percent: 90, leftLabel: "Step 3/3", rightLabel: "900 KB / 1 MB" },
});

// Custom duration (default is 5000ms)
toast.success("Saved", { duration: 3000 });

// Dismiss on action click (default: true)
toast.info("New version available", {
  actions: [{ label: "Details", variant: "primary", onClick: showChangelog }],
  dismissOnAction: false, // keep the toast visible after clicking
});

// With a progress bar
const progressId = toast.info("Downloading files", {
  persistent: true,
  progress: { percent: 0, leftLabel: "File 1/3: Downloading", rightLabel: "0 B / 12.5 MB" },
});

// Update progress
toast.update(progressId, {
  progress: { percent: 45, leftLabel: "File 1/3: Downloading", rightLabel: "5.6 MB / 12.5 MB", speed: "2.1 MB/s" },
});

// Complete: dismiss the progress toast, show success
toast.dismiss(progressId);
toast.success("Files downloaded", "3 files copied to clipboard");
```

Every call returns the toast id (an empty string if no `ToastController` is mounted).

## ToastOptions

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `message` | `string` | none | Text under the title |
| `actions` | `ToastAction[]` | none | Buttons under the message |
| `persistent` | `boolean` | `false` | Disable auto-dismiss |
| `duration` | `number` | `5000` | Auto-dismiss delay in ms |
| `dismissOnAction` | `boolean` | `true` | Dismiss when an action is clicked |
| `progress` | `ToastProgress` | none | Progress bar with labels (see below) |

## ToastProgress

| Field | Type | Description |
|-------|------|-------------|
| `percent` | `number` | 0-100, the fill width (clamped) |
| `leftLabel` | `string` | Left label (e.g. "File 1/3: Downloading") |
| `rightLabel` | `string` | Right label (e.g. "5.6 MB / 12.5 MB") |
| `speed` | `string` | Appended after `rightLabel` (e.g. "2.1 MB/s") |

Labels show only when `leftLabel` or `rightLabel` is set; they use `tabular-nums`.

## ToastAction

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `label` | `string` | none | Button text |
| `onClick` | `() => void` | none | Runs in the main renderer |
| `variant` | `"primary" \| "default"` | `"default"` | `primary` renders a primary `Button`, `default` a secondary one |

`ToastCard` also accepts an `icon` per action, but the `toast` API does not pass one; only the update notification uses it (Restart Now, the website buttons).

## toast.update()

`toast.update(id, partial)` updates a toast in place. It takes `title`, `message`, `progress` and `actions`, does **not** reset auto-dismiss timers (persistent toasts stay persistent), and does nothing if the id is unknown.

## Visual design (`src/components/ui/ToastCard.tsx`)

- Card: `rounded-lg border border-overlay-border bg-overlay p-2 shadow-overlay`, full width of the overlay column (at most 450px), no colored side bar
- Icon: 16px in the type's color: success `circleCheck` `text-success`, error `circleX` `text-danger`, warning `alertTriangle` `text-warning`, info `infoCircle` `text-info`, drawn from the active icon pack
- Text: title `text-body font-semibold text-ink`, message `text-body text-ink-secondary`
- Progress: `h-1 rounded-full bg-selected` track with a `bg-(--c-progress)` fill (`transition-[width] duration-150 ease-linear`), labels `text-meta text-ink-muted`
- Actions: `Button size="sm"` in a wrapping row (`flex flex-wrap gap-1`)
- Close: `IconButton size="sm"` with the `close` glyph, labeled "Dismiss"
- Max 5 visible; the oldest non-persistent toast is dismissed on overflow
- Animations: `animate-toast-in` and `animate-toast-out`, 200ms (`src/styles/base.css`)

## Shared utilities

- `formatFileSize(bytes)` from `src/lib/format.ts` formats bytes as "1.2 MB", "456 KB", etc.

## Key files

- `src/components/common/Toast.tsx`: the `toast` API, types and `ToastController`
- `src/App.tsx`: `NotificationStack`, which mounts the controllers and sends `overlay:push-state`
- `src/components/common/UpdateNotification.tsx`: the update notification's state bridge
- `electron/services/overlay/overlay-manager.ts`: the overlay window, its position and the IPC relay
- `src/components/overlay/OverlayApp.tsx`, `OverlayToast.tsx`, `OverlayUpdateNotification.tsx`: the overlay page
- `src/components/ui/ToastCard.tsx`: the toast's look
- `src/types/toast.ts`: the serialized toast and overlay state types
- `src/styles/base.css`: the `toast-in` and `toast-out` keyframes
